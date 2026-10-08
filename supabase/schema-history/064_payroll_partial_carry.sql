-- 064_payroll_partial_carry.sql — NV-02: la deuda se consume SOLO por lo que el
-- tope aplicó de verdad, y el resto se re-registra PENDIENTE en la MISMA
-- transacción.
--
-- MOTIVO DEL ARCHIVO (por qué el sobrante de la DEUDA no puede escribirse desde
-- TypeScript)
--
-- La 061 y la 062 dejaron la deuda del sobrante de vales en
-- `payroll_discount_carries` y la aplican al período siguiente DENTRO de
-- `other_discounts` (el servicio suma la deuda al descuento y pasa los ids de
-- las deudas consumidas en `p_carry_ids`; el RPC las marca aplicadas). Hasta
-- acá la deuda consumida era SIEMPRE el monto completo de la fila. Pero el tope
-- (`capPayrollDiscounts`) puede recortar el descuento: cuando vales + deuda
-- supera el bruto, la deuda NO entra completa a `other_discounts` y, sin
-- embargo, la fila se marcaba aplicada ENTERA. Ese sobrante se perdía: el
-- empleado dejaba de deberlo y el negocio lo perdonaba en silencio, el mismo
-- daño que la 061 vino a cerrar para los vales.
--
-- La regla del dueño es UNA: lo que no se puede descontar sigue siendo deuda.
-- El cálculo (TypeScript) ya sabe CUÁNTO de la deuda entrante absorbió el tope
-- —lo deriva del `otherDiscounts` que el propio tope devolvió, menos el
-- descuento manual que el admin escribió—. Lo que NO puede hacer desde
-- TypeScript es ESCRIBIR el sobrante:
--
--   * El descuento (el ítem con la deuda ya restada dentro de `other_discounts`)
--     se escribe en el RPC `payroll_apply_atomic`, que es UNA sentencia y por lo
--     tanto UNA transacción del servidor. La re-registración del sobrante tiene
--     que entrar o no entrar con ese descuento. Si fuera un segundo `INSERT` de
--     TypeScript —o una segunda sentencia—, un fallo ENTRE las dos dejaría el
--     descuento YA persistido mientras la deuda restante no existe en ningún
--     lado: el sobrante desaparece. Es exactamente el defecto que la 061 y la
--     062 cerraron para los otros dos hechos y que este archivo cierra para el
--     sobrante de la deuda.
--   * Si el `INSERT` del sobrante fuera el que corre primero y el descuento
--     fallara después, quedaría una deuda re-registrada que el período no
--     aplicó: el empleado debería plata que el descuento no reconoció. Las dos
--     mitades tienen que vivir en la misma transacción, y la única forma de
--     conseguirlo con PostgREST (sin multi-statement por request) es dentro de
--     UNA función SQL.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
-- Reemplaza `payroll_apply_atomic` conservando el cuerpo de la 062 (los locks
-- ordenados, el flip de los vales, las dos redes de conteo, el upsert con
-- `voucher_total`, el registro del sobrante del vale en 1.6 y el marcado de las
-- deudas consumidas en 1.7). Agrega TRES cosas, todas mínimas:
--
--   1. Una columna `origin_kind` en `payroll_discount_carries` ('voucher_excess'
--      o 'carry_remainder') para que convivan DOS deudas distintas del mismo
--      empleado y el mismo período de origen sin que la guarda anti-duplicado
--      de una silencie a la otra. La clave del `NOT EXISTS` de 1.6 pasa a
--      incluir `origin_kind`; sin eso, el sobrante de la deuda (1.8) bloquearía
--      el registro del sobrante del vale (1.6) y al revés.
--   2. La validación de forma de `debt_remainder` en la guarda 1.1 (clave
--      ausente = 0; un valor mal formado se rechaza, igual que `voucher_excess`).
--   3. Un paso nuevo (1.8) que registra el sobrante de la deuda como una fila
--      PENDIENTE NUEVA, con ESTE período como origen y `origin_kind =
--      'carry_remainder'`, sólo si el ítem trae `debt_remainder > 0` y no existe
--      ya una deuda de ese empleado con ese origen y ese tipo (recalcular no
--      duplica).
--
-- FIRMA: la MISMA de la 062 (cuatro parámetros, con el `DEFAULT '{}'` del
-- cuarto) —NO se agrega ningún parámetro nuevo—: el sobrante de la deuda viaja
-- dentro de cada ítem de `p_items` como `debt_remainder`, igual que
-- `voucher_excess`. Así la llamada de tres argumentos sigue válida y el servicio
-- no tiene que cambiar la forma de llamar.
--
-- POR QUÉ EL SOBRANTE SE RE-REGISTRA CON ESTE PERÍODO COMO ORIGEN
--
-- El origen de una deuda decide en QUÉ período se aplica: el cálculo sólo
-- aplica deudas cuyo período de origen TERMINA antes del que se está
-- liquidando. Con `origin_period_id = p_period_id` (el período que no pudo
-- absorber) el sobrante queda automáticamente fuera de ESTE período —no se
-- vuelve a aplicar a sí mismo— y entra en cualquier período POSTERIOR, que es
-- exactamente la regla ("se aplica en un período siguiente, nunca en el
-- actual"). La alternativa —heredar el origen de la deuda consumida— haría que
-- el recálculo del MISMO período volviera a leer el sobrante como pendiente y
-- aplicable, y lo aplicaría una y otra vez: la deuda crecería en cada recálculo.
--
-- POR QUÉ `origin_kind` Y NO OTRA CLAVE
--
-- `id`, `sede_id`, `employee_id`, `amount`, `origin_period_id` y
-- `applied_period_id` no distinguen dos deudas del mismo empleado y período: las
-- dos nacen pendientes con `applied_period_id` NULL. Diferenciarlas por `amount`
-- funcionaría sólo si los montos nunca coinciden —y pueden coincidir—, así que
-- el `NOT EXISTS` de más de una fila saltaría una deuda real. La columna
-- `origin_kind` es explícita, estable y deja la guarda anti-duplicado exacta
-- para cada tipo. Las filas históricas toman el default `'voucher_excess'`, que
-- es lo que eran.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`, el CHECK con `DROP
-- CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (patrón de 038/041), `CREATE OR
-- REPLACE FUNCTION` con la MISMA firma, el `ALTER FUNCTION` del search_path y
-- REVOKE/GRANT dejan el esquema idéntico en cada corrida. El runner de Supabase
-- aplica el archivo en una transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 064 es el siguiente libre (la serie llega a
-- `063_nomina_frecuencias.sql`); este archivo NO renumera ni toca ningún archivo
-- anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. El TIPO de deuda: sobrante de vale o sobrante de deuda re-registrada
-- ===================================================================== ---

-- Una deuda de `payroll_discount_carries` puede nacer de dos hechos distintos
-- del mismo período y el mismo empleado:
--   * 'voucher_excess': el sobrante de un vale que el período no pudo descontar
--     (061/062).
--   * 'carry_remainder': la parte de una deuda ENTRANTE que el tope de este
--     período no alcanzó a absorber (este archivo).
-- Sin este discriminador las dos filas son indistinguibles y la guarda
-- anti-duplicado de una bloquearía a la otra.
ALTER TABLE public.payroll_discount_carries
  ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'voucher_excess';

ALTER TABLE public.payroll_discount_carries
  DROP CONSTRAINT IF EXISTS chk_payroll_discount_carries_origin_kind;

ALTER TABLE public.payroll_discount_carries
  ADD CONSTRAINT chk_payroll_discount_carries_origin_kind
  CHECK (origin_kind IN ('voucher_excess', 'carry_remainder'));

COMMENT ON COLUMN public.payroll_discount_carries.origin_kind IS
  'NV-02: tipo de deuda. ''voucher_excess'' = sobrante de un vale que el período de origen no pudo descontar (061/062); ''carry_remainder'' = parte de una deuda entrante que el tope del período de origen no alcanzó a absorber (064). Discrimina la guarda anti-duplicado (origen + empleado + tipo): un período puede producir las dos deudas para el mismo empleado y ninguna puede silenciar a la otra.';

-- ===================================================================== ---
-- 2. La ESCRITURA atómica: ítems, vales, deuda saliente, deuda consumida y
--    sobrante de la deuda re-registrado
-- ===================================================================== ---

-- Firma `(uuid, jsonb, uuid[], uuid[])`: la MISMA de la 062. El período que se
-- está liquidando, los ítems ya calculados por el servicio, los ids de los vales
-- que ESTE cálculo descuenta por primera vez y los ids de las deudas que ESTE
-- cálculo absorbe en `other_discounts`. El tipo de retorno sigue siendo el
-- número de ítems escritos. El sobrante de la deuda NO es un parámetro nuevo:
-- viaja dentro de cada ítem como `debt_remainder`.
--
-- CAMBIOS RESPECTO DE 062 (sólo los mínimos; el resto del cuerpo es VERBATIM):
--   * La guarda de forma (1.1) valida además `debt_remainder` cuando viene (la
--     clave ausente es válida y vale 0).
--   * El paso 1.6 escribe `origin_kind = 'voucher_excess'` y su `NOT EXISTS`
--     acota por ese tipo: la guarda anti-duplicado deja de confundir el
--     sobrante del vale con el sobrante de la deuda.
--   * Un paso nuevo (1.8) re-registra el sobrante de la deuda como una fila
--     PENDIENTE con este período como origen y el tipo `'carry_remainder'`.
CREATE OR REPLACE FUNCTION public.payroll_apply_atomic(
  p_period_id uuid,
  p_items jsonb,
  p_voucher_ids uuid[],
  p_carry_ids uuid[] DEFAULT '{}'
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
     OR p_carry_ids IS NULL
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
       OR (item -> 'debt_remainder' IS NOT NULL
           AND coalesce(item ->> 'debt_remainder', '')
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

  -- 1.6 La DEUDA del sobrante del vale. Por cada ítem cuyo `voucher_excess` sea
  --     positivo se registra UNA fila en `payroll_discount_carries`: el sobrante
  --     que el período no pudo descontar, con la sede del PERÍODO (el mismo
  --     `JOIN` de 1.4: un empleado de otra sede no puede dejar una deuda en
  --     ésta) y el período como ORIGEN. `applied_period_id` nace NULL
  --     (PENDIENTE): acá no se aplica nada, sólo se registra de dónde salió el
  --     exceso.
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) hace que RECALCULAR el
  --     mismo período NO duplique la deuda: el upsert de 1.4 reemplaza el ítem y
  --     este paso reencuentra la fila existente en vez de insertar una segunda.
  --     El tipo entra en la clave (NV-02): el sobrante de la deuda de 1.8 tiene
  --     el MISMO origen y el MISMO empleado y no puede bloquear esta fila (ni al
  --     revés). La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (sede_id, employee_id, amount, origin_period_id, origin_kind)
  SELECT
    p.sede_id,
    e.id,
    (item ->> 'voucher_excess')::numeric,
    p_period_id,
    'voucher_excess'
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
        AND c.origin_kind = 'voucher_excess'
    )
  ORDER BY e.id;

  -- 1.7 La DEUDA ENTRANTE que este cálculo absorbe en `other_discounts` queda
  --     CONSUMIDA: `applied_period_id` se llena con el período que la aplicó.
  --     El descuento ya viajó en el ítem (1.4) y el registro del sobrante
  --     saliente (1.6) es otra fila: acá sólo se cierra la deuda que el
  --     servicio leyó como pendiente y sumó al descuento.
  --
  --     El `IS NULL` es la regla de una sola aplicación: una deuda ya consumida
  --     no se vuelve a marcar (replay no-op) y no vuelve a entrar al conjunto
  --     pendiente. NO se cuenta ni se aborta si se marcaron menos filas: a
  --     diferencia del flip de vales —donde marcar de menos es una carrera que
  --     hay que rechazar—, acá marcar de menos es exactamente el replay que
  --     debe ser silencioso. Los locks van en orden determinista, igual que los
  --     vales, para que dos cálculos con deudas solapadas no se bloqueen en
  --     ciclo.
  PERFORM 1
    FROM public.payroll_discount_carries c
   WHERE c.id = ANY (p_carry_ids)
   ORDER BY c.id
     FOR UPDATE OF c;

  UPDATE public.payroll_discount_carries c
     SET applied_period_id = p_period_id
   WHERE c.id = ANY (p_carry_ids)
     AND c.applied_period_id IS NULL;

  -- 1.8 El SOBRANTE DE LA DEUDA (NV-02). Cuando el tope no alcanzó a absorber
  --     toda la deuda entrante, el ítem trae en `debt_remainder` la parte que no
  --     entró a `other_discounts`. Esa parte NO se perdona: se registra como una
  --     fila PENDIENTE NUEVA con ESTE período como ORIGEN —así ningún cálculo de
  --     este período la vuelve a aplicar (el origen no es anterior a sí mismo) y
  --     sí la aplica cualquier período POSTERIOR— y con el tipo
  --     `'carry_remainder'`, que la distingue del sobrante del vale (1.6).
  --
  --     El `NOT EXISTS` sobre (origen, empleado, tipo) es la misma guarda de
  --     1.6: RECALCULAR el mismo período reencuentra la fila y no inserta una
  --     segunda. El descuento (1.4) y esta re-registración viven en la misma
  --     sentencia y por lo tanto en la MISMA transacción: si cualquiera de los
  --     dos falla, se revierten los dos y la deuda no se pierde ni se duplica.
  --     La clave ausente no inserta (coalesce a 0).
  INSERT INTO public.payroll_discount_carries
    (sede_id, employee_id, amount, origin_period_id, origin_kind)
  SELECT
    p.sede_id,
    e.id,
    (item ->> 'debt_remainder')::numeric,
    p_period_id,
    'carry_remainder'
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.payroll_periods p
    ON p.id = p_period_id
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
   AND e.sede_id = p.sede_id
  WHERE coalesce((item ->> 'debt_remainder')::numeric, 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.payroll_discount_carries c
      WHERE c.origin_period_id = p_period_id
        AND c.employee_id = e.id
        AND c.origin_kind = 'carry_remainder'
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
ALTER FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) SET search_path = public;

-- ------------------------------------------------ 3.2 Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría escribir la nómina, marcar vales y consumir
-- deudas por PostgREST. El único llamador legítimo es el cliente service_role
-- del servidor. `CREATE OR REPLACE` conserva el ACL, pero el bloque se repite:
-- es barato, idempotente y deja el archivo válido también sobre una base donde
-- la función no existiera.
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) TO service_role;

-- ------------------------------------------- 3.3 Documentación ---
COMMENT ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) IS
'CL-8 + NV-01 + NV-02: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items (incluida voucher_total, el total REAL de vales del período, fuera de la igualdad del neto), marca los vales en descontada, registra la deuda del sobrante del vale en payroll_discount_carries, marca CONSUMIDAS (applied_period_id) las deudas que este cálculo absorbe en other_discounts y re-registra como PENDIENTE (origin_kind = carry_remainder, con este período como origen) el sobrante de la deuda que el tope no alcanzó a descontar, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista. NO calcula nada: cada monto llega ya resuelto por el servicio y se escribe verbatim; la aritmética de la nómina vive en TypeScript. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente y aborta si escribió menos filas de las pedidas; las dos deudas salientes se insertan sólo si el ítem trae voucher_excess o debt_remainder > 0 y no existe ya una deuda del mismo empleado, mismo período de origen y mismo origin_kind (recalcular no duplica); la deuda entrante se marca sólo si sigue pendiente, así un replay es un no-op y una deuda se aplica exactamente una vez. El sobrante de la deuda se re-registra en ESTA transacción a propósito: si fuera una segunda escritura del servicio, un fallo entre el descuento y la re-registración borraría la deuda restante. Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem, ni un vale marcado, ni una deuda consumida, ni un sobrante re-registrado. Sólo service_role puede ejecutarla.';

-- ===================================================================== ---
-- 5. Cómo verifica el dueño (SOLO LECTURA; nada de acá cambia datos)
-- ===================================================================== ---
--
--   * La firma NO cambió: `payroll_apply_atomic` sigue siendo la de cuatro
--     argumentos (el cuarto con DEFAULT); la llamada de tres argumentos sigue
--     válida.
--   * El tipo de deuda: `payroll_discount_carries.origin_kind` existe y vale
--     'voucher_excess' en las filas históricas.
--   * La deuda parcial: si el período descontó sólo una parte de la deuda
--     entrante (porque vales + deuda superaba el bruto), la fila original queda
--     con `applied_period_id` = ese período y aparece una fila NUEVA PENDIENTE
--     con `origin_kind = 'carry_remainder'`, `origin_period_id` = ese período y
--     `amount` = lo que el tope no pudo aplicar.
--   * El no-op del replay: recalcular el mismo período NO cambia el
--     `applied_period_id` ya escrito y NO inserta una segunda fila de
--     'carry_remainder'.
--
--   -- SELECT c.id, c.amount, c.origin_period_id, c.applied_period_id, c.origin_kind
--   --   FROM public.payroll_discount_carries c
--   --  WHERE c.employee_id = '<empleado>'
--   --  ORDER BY c.created_at;
