-- 061_payroll_voucher_debt.sql — NV-01: la columna de vales guarda la SUMA
-- REAL del período y el sobrante del vale queda como DEUDA del empleado.
--
-- MOTIVO DEL ARCHIVO (el recorte borraba el total real y el exceso se perdía)
--
-- `payroll_items` impone la igualdad (tolerancia de un centavo, 007):
--
--     neto = fijo + comisiones + bonos − deductions_vales − other_discounts
--
-- y `computeNetPay` tiene piso en cero. Para que esa igualdad se sostenga sin
-- neto negativo, `capPayrollDiscounts` (src/features/payroll/schemas.ts)
-- RECORTA el vale al bruto del período, y es ESE recorte el que se persiste en
-- `deductions_vales` y el que la pantalla mostraba en la columna "Vales". Con
-- un vale de 50.000 y un bruto de 20.000 la celda valía 20.000 —que en un
-- empleado `pay_type = 'porcentaje'` sin bonos es exactamente su comisión— y el
-- sobrante de 30.000 NO se recuperaba en ningún lado: el vale quedaba
-- `descontada` completo en la base y el exceso se perdía para el negocio.
--
-- DECISIÓN (fijada por el dueño; este archivo no la rediseña)
--
--   * El total REAL de vales del período se guarda en una columna PROPIA,
--     `voucher_total`, que NO participa de la igualdad de arriba. El CHECK de
--     `payroll_items` NO se toca: es la garantía de consistencia de la tabla y
--     queda explícitamente fuera del alcance de esta unidad.
--   * El SOBRANTE del vale sobre lo ganado queda como DEUDA del empleado de la
--     sede, con el período que lo produjo como ORIGEN, en la tabla nueva
--     `payroll_discount_carries`. La deuda PENDIENTE se aplicará al neto del
--     período siguiente DENTRO de `other_discounts` (unidad de CÁLCULO), de modo
--     que la igualdad del CHECK siga vigente sin modificarla.
--   * `deductions_vales` conserva su significado ("lo que se aplicó", topeado) y
--     su signo almacenado. Lo único que cambia es que el total real deja de
--     perderse, porque ahora vive aparte.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
--   1. Agrega `payroll_items.voucher_total` (numeric(12, 2) NOT NULL DEFAULT 0),
--      documentada como la suma real de los vales del empleado en el rango del
--      período, FUERA de la identidad del neto y con el motivo escrito.
--   2. Crea `payroll_discount_carries`: la deuda arrastrada, por sede y
--      empleado, con su período de ORIGEN y el período en que se APLICÓ (nulo
--      mientras está pendiente). Una deuda se consume UNA vez: al aplicarse se
--      marca con su `applied_period_id` y sale del conjunto pendiente.
--   3. Reemplaza `payroll_apply_atomic` (047) con la MISMA firma y el cuerpo
--      VERBATIM, salvo tres cosas: la guarda de forma de cada ítem valida
--      también `voucher_total` y `voucher_excess` cuando vienen (la clave
--      ausente es válida); escribe `voucher_total` desde el ítem del payload (0
--      cuando la clave falta); y, cuando el ítem trae un `voucher_excess`
--      positivo, registra UNA fila de deuda con el período como origen. Todo lo
--      demás —los locks ordenados, el flip de los vales, las dos redes de
--      conteo, el upsert y el valor devuelto— queda igual.
--
-- El CÁLCULO del total real, de la deuda entrante y del sobrante saliente, y la
-- pantalla que muestra el total real, son de las unidades siguientes (cálculo y
-- UI). Este archivo sólo deja el ALMACENAMIENTO y la escritura atómica listos
-- para ellas. NO recalcula períodos cerrados (`assertDraftPeriod` sigue
-- mandando), NO toca el pago inmediato de comisión ni la regla de facturas
-- pagadas y NO modifica el CHECK de `payroll_items`.
--
-- POR QUÉ LA DEUDA VA EN TABLA PROPIA Y NO EN `other_discounts`
--
-- `other_discounts` debe seguir significando "otros descuentos" y su valor se
-- escribe verbatim desde el payload; meter la deuda ahí sin trazabilidad
-- borraría DE QUÉ PERÍODO salió el sobrante y haría imposible saber si una deuda
-- ya se aplicó. La deuda es una fila con ORIGEN y APLICACIÓN: por eso vive en su
-- tabla y sólo su MONTO entra en `other_discounts` cuando se aplica.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
-- EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE
-- POLICY`, `CREATE OR REPLACE FUNCTION` con la MISMA firma, el `ALTER FUNCTION`
-- del search_path y REVOKE/GRANT dejan el esquema idéntico en cada corrida. El
-- runner de Supabase aplica el archivo en una transacción: o entra todo, o no
-- entra nada.
--
-- COSTO DE NUMERACIÓN: 061 es el siguiente libre (la serie llega a 060); este
-- archivo NO renumera ni toca ningún archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La columna del TOTAL REAL de vales (fuera de la igualdad del neto)
-- ===================================================================== ---

-- El total real de vales del empleado en el rango del período. NO participa de
-- la igualdad `neto = base_fixed + commissions + bonuses − deductions_vales −
-- other_discounts` del CHECK de 007: por eso es una columna PROPIA y por eso el
-- CHECK no se toca. `deductions_vales` sigue siendo "lo que se aplicó"
-- (topeado por el bruto); esta columna es lo que el empleado gastó en vales.
ALTER TABLE public.payroll_items
  ADD COLUMN IF NOT EXISTS voucher_total numeric(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payroll_items.voucher_total IS
  'NV-01: suma REAL de los vales del empleado en el rango del período (total de vales, sin recorte). Vive FUERA de la igualdad del neto: el CHECK de payroll_items sigue siendo neto = base_fixed + commissions + bonuses − deductions_vales − other_discounts, y esta columna no entra en él. deductions_vales conserva su significado (lo que se aplicó, topeado al bruto); el sobrante que esta columna revela se registra como deuda en payroll_discount_carries.';

-- ===================================================================== ---
-- 2. La DEUDA arrastrada del empleado (el sobrante del vale)
-- ===================================================================== ---

-- Una fila = un sobrante de vale que el período de origen no pudo descontar.
-- `origin_period_id` dice DE DÓNDE salió; `applied_period_id` queda NULL
-- mientras está PENDIENTE y se llena cuando la deuda se descuenta en el período
-- donde se aplica. Una deuda se consume UNA vez: apenas tiene
-- `applied_period_id` deja de estar pendiente y no vuelve a entrar.
--
-- FKs con el mismo criterio de las tablas de nómina (007/036/037): la sede y el
-- empleado SIN ON DELETE (un empleado con historia de nómina no se borra) y los
-- períodos también SIN ON DELETE por la misma razón —un período no se borra en
-- esta aplicación, y la deuda es TRAZABILIDAD: borrarla en cascada o devolverla
-- a pendiente al borrar el período donde se aplicó serían las dos pérdidas que
-- este registro existe para evitar—.
CREATE TABLE IF NOT EXISTS public.payroll_discount_carries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  employee_id uuid NOT NULL REFERENCES public.employees (id),
  -- El sobrante: plata real que el empleado debe. Deuda no nula ni negativa.
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  -- El período donde se produjo el exceso (de dónde sale la deuda).
  origin_period_id uuid NOT NULL REFERENCES public.payroll_periods (id),
  -- El período donde la deuda se descontó. NULL = pendiente. Al llenarse, la
  -- deuda queda consumida (sale del conjunto pendiente y no se re-aplica).
  applied_period_id uuid NULL REFERENCES public.payroll_periods (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payroll_discount_carries IS
  'NV-01: deuda arrastrada del empleado por el sobrante de sus vales. Cuando un vale supera lo ganado en el período, el exceso se registra acá con el período de origen y se descuenta en el período siguiente dentro de other_discounts (el neto sigue con piso en cero y la igualdad del CHECK no cambia). Una deuda se consume UNA vez: applied_period_id NULL = pendiente; con valor, ya se aplicó y no vuelve a entrar.';

COMMENT ON COLUMN public.payroll_discount_carries.amount IS
  'NV-01: monto del sobrante del vale que quedó como deuda (> 0). Es lo que el período de origen no pudo descontar; se aplica al neto del período siguiente vía other_discounts.';

COMMENT ON COLUMN public.payroll_discount_carries.origin_period_id IS
  'NV-01: período donde se produjo el exceso (de dónde sale la deuda). Trazabilidad del sobrante: sin esta referencia la deuda no se puede explicar.';

COMMENT ON COLUMN public.payroll_discount_carries.applied_period_id IS
  'NV-01: período donde la deuda se descontó. NULL = PENDIENTE. Con valor, la deuda quedó CONSUMIDA: una deuda se aplica exactamente una vez y no vuelve a entrar al conjunto pendiente.';

-- La lectura real del pendiente: las deudas sin aplicar de un empleado de la
-- sede (la que alimenta el descuento entrante del cálculo).
CREATE INDEX IF NOT EXISTS idx_payroll_discount_carries_pending
  ON public.payroll_discount_carries (sede_id, employee_id)
  WHERE applied_period_id IS NULL;

-- La lectura por período de ORIGEN (de dónde salió cada deuda).
CREATE INDEX IF NOT EXISTS idx_payroll_discount_carries_origin
  ON public.payroll_discount_carries (origin_period_id);

-- ------------------------------------------------ RLS ---
-- Deny-by-default, igual que las tablas de 007/036/037: sin política, ningún
-- rol alcanza la tabla. La política es permisiva hoy por el mismo TODO de 007:
-- las sesiones del MVP son tokens opacos propios (no JWT de Supabase Auth), así
-- que no hay claim de sede que filtrar; la capa servidor (service_role +
-- requireSedeRole) aplica la segregación por sede. Se re-crea con DROP POLICY IF
-- EXISTS para que un re-run deje la definición vigente.
ALTER TABLE public.payroll_discount_carries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_payroll_discount_carries_sede_isolation
  ON public.payroll_discount_carries;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: la deuda del empleado es solo admin en su sede.
CREATE POLICY pol_payroll_discount_carries_sede_isolation
  ON public.payroll_discount_carries
  FOR ALL USING (true) WITH CHECK (true);

-- ===================================================================== ---
-- 3. La ESCRITURA atómica del cálculo: ítems, vales, total real y deuda
-- ===================================================================== ---

-- Firma `(uuid, jsonb, uuid[])` —la MISMA de 047—: el período que se está
-- liquidando, los ítems ya calculados por el servicio y los ids de los vales que
-- ESTE cálculo descuenta por primera vez. El tipo de retorno sigue siendo el
-- número de ítems escritos.
--
-- CAMBIOS RESPECTO DE 047 (sólo tres, el resto del cuerpo es VERBATIM):
--   * La guarda de forma de cada ítem (1.1) valida además `voucher_total` y
--     `voucher_excess` cuando la clave viene: la clave ausente es válida (los
--     dos campos son opcionales y valen 0 por defecto) y un valor mal formado se
--     rechaza con `PAYROLL_INVALID` en vez de llegar al cast.
--   * El INSERT de ítems escribe `voucher_total` desde `item ->> 'voucher_total'`
--     (`coalesce(..., 0)`: la clave ausente vale 0), en el INSERT y en el SET del
--     ON CONFLICT, para que recalcular el mismo período también refresque el
--     total real.
--   * Un paso nuevo (1.6) registra la deuda: por cada ítem con
--     `voucher_excess > 0` inserta UNA fila en `payroll_discount_carries` con la
--     sede del PERÍODO y el período como origen, y sólo si no existe ya una
--     deuda de ese empleado originada en ese período (recalcular no duplica).
-- La deuda entrante (marcar `applied_period_id` al aplicarla dentro de
-- `other_discounts`) es de la unidad de CÁLCULO: acá sólo se registra el origen.
CREATE OR REPLACE FUNCTION public.payroll_apply_atomic(
  p_period_id uuid,
  p_items jsonb,
  p_voucher_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_esperados integer;
  v_marcados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que escribe la nómina no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de un descuento interpretado.
  --     `p_items` puede venir VACÍO (una liquidación sin planta activa pero con
  --     vales que descontar es un caso legal), pero tiene que ser un ARREGLO.
  IF p_period_id IS NULL
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR p_voucher_ids IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada ítem tiene que ser un objeto, con el MISMO período que el
  --     llamador declaró, un `employee_id` con la forma del `CHECK` de 001/007 y
  --     las SEIS columnas de dinero como número no negativo de hasta 9 dígitos
  --     enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar—.
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item ->> 'net_pay'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así
  --     que sin el coalesce una entrada sin `net_pay` pasaría esta guarda y el
  --     `NOT NULL` de la columna sería el que hablara, con un error de la base
  --     en vez de un rechazo del contrato. Es la misma trampa que 046 documenta
  --     para `qty`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  --
  --     Acá NO hace falta el `CASE` que 046 usa: esta guarda sólo compara
  --     TEXTO contra una expresión regular, y la conversión a `numeric` ocurre
  --     después, en el INSERT (otra sentencia).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'period_id', '') <> p_period_id::text
       OR coalesce(item ->> 'base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR (item -> 'voucher_total' IS NOT NULL
           AND coalesce(item ->> 'voucher_total', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'voucher_excess' IS NOT NULL
           AND coalesce(item ->> 'voucher_excess', '')
             !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item -> 'detail_json' IS NOT NULL AND jsonb_typeof(item -> 'detail_json') <> 'array')
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Un vale REPETIDO en el arreglo no es un vale dos veces: el arreglo es un
  --     CONJUNTO de ids, y un repetido no se puede marcar dos veces (el conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado). Un elemento
  --     NULL se rechaza por la misma puerta. Se valida en vez de confiar en que
  --     el llamador no repite.
  IF cardinality(p_voucher_ids) <> (
    SELECT count(DISTINCT id) FROM unnest(p_voucher_ids) AS id
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El FLIP de los vales: la transición única a `descontada` que el
  --     servicio ya hacía con su `UPDATE`, con la MISMA precondición de estado
  --     y con los locks en orden determinista (ver "SERIALIZACIÓN" arriba).
  --
  --     El bloqueo va PRIMERO y aparte: `PERFORM ... FOR UPDATE` es el idioma de
  --     la casa para tomar locks de fila (039, 040) y, con `ORDER BY` delante,
  --     bloquea en ese orden: dos cálculos con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo.
  --
  --     El `UPDATE` de abajo no necesita orden: sus filas ya las bloqueó este
  --     paso, en esta misma transacción, y volver a tocarlas no adquiere ningún
  --     lock nuevo.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.id = ANY (p_voucher_ids)
   ORDER BY v.id
     FOR UPDATE OF v;

  UPDATE public.voucher_requests v
     SET status = 'descontada'
   WHERE v.id = ANY (p_voucher_ids)
     AND v.status IN ('pendiente', 'aprobada');

  -- 1.3 Red de seguridad DENTRO de la transacción: si no se marcaron
  --     EXACTAMENTE los vales que se recibieron, se aborta y se revierte todo
  --     (los ítems incluidos). Un vale que ya no está `pendiente`/`aprobada` —lo
  --     descontó otro cálculo— escribe CERO filas: esta guarda convierte esa
  --     carrera silenciosa en un rechazo con rollback, en vez de dejar los
  --     ítems escritos sobre un descuento ajeno. Es la misma red que 046 y 039
  --     pusieron sobre su escritura.
  GET DIAGNOSTICS v_marcados = ROW_COUNT;

  IF v_marcados <> cardinality(p_voucher_ids) THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.4 La ESCRITURA de los ítems: UNA sentencia, y por eso UNA transacción
  --     con el flip de arriba. Todos los ítems entran con el período declarado
  --     y con los montos EXACTOS que el servicio calculó —acá no se suma, no se
  --     resta y no se recalcula nada—.
  --
  --     El `JOIN` filtra por la sede del PERÍODO y por la existencia del
  --     empleado: un empleado de otra sede o inexistente escribiría menos filas
  --     en SILENCIO, y la guarda de conteo de abajo convierte ese subconjunto
  --     silencioso en un rechazo con rollback. `ORDER BY e.id` es el orden
  --     determinista de los locks de `payroll_items` (ver "SERIALIZACIÓN").
  --
  --     `ON CONFLICT (period_id, employee_id) DO UPDATE` es el upsert del
  --     servicio (`onConflict: "period_id,employee_id"`) traducido: recalcular
  --     el mismo período REEMPLAZA la fila del empleado, no la duplica. Las
  --     columnas que se pisan son exactamente las del payload y `updated_at`
  --     queda para su trigger. `voucher_total` entra por la misma puerta: el
  --     total real de vales también se refresca al recalcular.
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_items
    (period_id, employee_id, base_fixed, commissions, bonuses,
     deductions_vales, other_discounts, net_pay, detail_json, voucher_total)
  SELECT
    p_period_id,
    e.id,
    (item ->> 'base_fixed')::numeric,
    (item ->> 'commissions')::numeric,
    (item ->> 'bonuses')::numeric,
    (item ->> 'deductions_vales')::numeric,
    (item ->> 'other_discounts')::numeric,
    (item ->> 'net_pay')::numeric,
    coalesce(item -> 'detail_json', '[]'::jsonb),
    coalesce((item ->> 'voucher_total')::numeric, 0)
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
   AND e.sede_id = p.sede_id
  ORDER BY e.id
  ON CONFLICT (period_id, employee_id) DO UPDATE
    SET base_fixed = EXCLUDED.base_fixed,
        commissions = EXCLUDED.commissions,
        bonuses = EXCLUDED.bonuses,
        deductions_vales = EXCLUDED.deductions_vales,
        other_discounts = EXCLUDED.other_discounts,
        net_pay = EXCLUDED.net_pay,
        detail_json = EXCLUDED.detail_json,
        voucher_total = EXCLUDED.voucher_total;

  -- 1.5 La segunda red: si se escribieron menos ítems de los pedidos —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, el flip incluido.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_ITEM_MISMATCH';
  END IF;

  -- 1.6 La DEUDA del sobrante. Por cada ítem cuyo `voucher_excess` sea positivo
  --     se registra UNA fila en `payroll_discount_carries`: el sobrante que el
  --     período no pudo descontar, con la sede del PERÍODO (el mismo `JOIN` de
  --     1.4: un empleado de otra sede no puede dejar una deuda en ésta) y el
  --     período como ORIGEN. `applied_period_id` nace NULL (PENDIENTE): acá no
  --     se aplica nada, sólo se registra de dónde salió el exceso.
  --
  --     El `NOT EXISTS` sobre (origen, empleado) hace que RECALCULAR el mismo
  --     período NO duplique la deuda: el upsert de 1.4 reemplaza el ítem y este
  --     paso reencuentra la fila existente en vez de insertar una segunda. La
  --     clave ausente no inserta (coalesce a 0); la deuda entrante —marcar
  --     `applied_period_id` al aplicarla— es de la unidad de cálculo.
  INSERT INTO public.payroll_discount_carries
    (sede_id, employee_id, amount, origin_period_id)
  SELECT
    p.sede_id,
    e.id,
    (item ->> 'voucher_excess')::numeric,
    p_period_id
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
   AND e.sede_id = p.sede_id
  WHERE coalesce((item ->> 'voucher_excess')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
    )
  ORDER BY e.id;

  RETURN v_escritos;
END;
$$;

-- -------------------------------------- 3.1 search_path fijo ---
-- La función resuelve `payroll_items`, `payroll_discount_carries`,
-- `voucher_requests`, `payroll_periods` y `employees`; con search_path mutable
-- un esquema anterior en la ruta podría secuestrar esos nombres. House style
-- desde 018 (y el mismo paso que dan 039 y 046).
ALTER FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) SET search_path = public;

-- ------------------------------------------------ 3.2 Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría escribir la nómina, marcar vales y dejar deudas
-- por PostgREST. El único llamador legítimo es el cliente service_role del
-- servidor. `CREATE OR REPLACE` conserva el ACL, pero el bloque se repite: es
-- barato, idempotente y deja el archivo válido también sobre una base donde la
-- función no existiera.
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) TO service_role;

-- ------------------------------------------- 3.3 Documentación ---
COMMENT ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) IS
'CL-8 + NV-01: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items (incluida voucher_total, el total REAL de vales del período, fuera de la igualdad del neto), marca los vales en descontada y registra la deuda del sobrante en payroll_discount_carries, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista. NO calcula nada: cada monto llega ya resuelto por el servicio y se escribe verbatim; la aritmética de la nómina vive en TypeScript. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente y aborta si escribió menos filas de las pedidas; la deuda se inserta sólo si el ítem trae voucher_excess > 0 y no existe ya una deuda del mismo empleado originada en el mismo período (recalcular no duplica). Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem, ni un vale marcado, ni una deuda. Sólo service_role puede ejecutarla.';

-- ===================================================================== ---
-- 5. Cómo verifica el dueño (SOLO LECTURA; nada de acá cambia datos)
-- ===================================================================== ---
--
--   * La columna: `payroll_items` tiene `voucher_total` y la igualdad del CHECK
--     NO la menciona (la sigue leyendo `\d public.payroll_items`).
--   * El total real: para el caso del encabezado (vale de 50.000, bruto de
--     20.000) `voucher_total` = 50000 y `deductions_vales` = 20000 (lo aplicado).
--   * La deuda: una fila en `payroll_discount_carries` con `amount` = 30000,
--     `origin_period_id` = el período del recorte y `applied_period_id` NULL
--     (pendiente).
--   * Recalcular el MISMO período deja la MISMA fila de deuda (una por empleado
--     y período de origen), no una segunda.
--
--   -- SELECT i.period_id, i.employee_id, i.deductions_vales, i.voucher_total,
--   --        c.amount, c.origin_period_id, c.applied_period_id
--   --   FROM public.payroll_items i
--   --   LEFT JOIN public.payroll_discount_carries c
--   --     ON c.employee_id = i.employee_id
--   --    AND c.origin_period_id = i.period_id
--   --  WHERE i.period_id = '<periodo>';
