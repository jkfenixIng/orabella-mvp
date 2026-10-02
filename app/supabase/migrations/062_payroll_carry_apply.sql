-- 062_payroll_carry_apply.sql — NV-01: la deuda del sobrante de vales se
-- marca APLICADA en la MISMA transacción que la descuenta.
--
-- MOTIVO DEL ARCHIVO (por qué el marcado no puede vivir en TypeScript)
--
-- La 061 dejó la deuda arrastrada en `payroll_discount_carries` y el sobrante
-- del vale se descuenta en el período siguiente DENTRO de `other_discounts`.
-- Ese descuento y el marcado de la deuda (`applied_period_id`) son DOS hechos
-- que tienen que entrar o no entrar juntos. Si el marcado fuera una segunda
-- escritura de TypeScript —un `UPDATE` posterior al RPC—, un fallo ENTRE las
-- dos dejaría el descuento YA escrito en `payroll_items` mientras la deuda
-- sigue PENDIENTE: el período siguiente la leería de nuevo y la aplicaría OTRA
-- VEZ. El empleado pagaría dos veces el mismo sobrante. Es exactamente la
-- misma ventana que CL-8 cerró para los vales (047) y que este archivo cierra
-- para las deudas: PostgREST no ofrece multi-statement por request, así que la
-- única forma de que el descuento y el marcado sean indivisibles es que ocurran
-- dentro de UNA función SQL —una sentencia, una transacción del servidor—.
--
-- QUÉ HACE ESTE ARCHIVO (y qué NO)
--
-- Reemplaza `payroll_apply_atomic` conservando TODO el cuerpo de la 061,
-- incluidos el flip de los vales, las dos redes de conteo, el upsert de los
-- ítems con `voucher_total` y el registro del sobrante saliente en
-- `payroll_discount_carries` (paso 1.6). Agrega UN solo paso nuevo (1.7):
-- marca `applied_period_id = p_period_id` en las deudas que este cálculo
-- absorbe en `other_discounts`, y sólo en las que siguen PENDIENTES
-- (`applied_period_id IS NULL`), de modo que un replay —o un recálculo después
-- de que la deuda ya se consumió— es un no-op en vez de un doble descuento.
--
-- FIRMA: la MISMA de la 061 MÁS un parámetro final con los ids de las deudas
-- consumidas:
--
--     public.payroll_apply_atomic(
--       p_period_id uuid,
--       p_items jsonb,
--       p_voucher_ids uuid[],
--       p_carry_ids uuid[] DEFAULT '{}'
--     )
--
-- El `DEFAULT '{}'` deja la llamada de tres argumentos válida (una liquidación
-- sin deudas no necesita el cuarto), y el servicio pasa SIEMPRE el cuarto
-- argumento —así la resolución de Postgres elige esta función y no la de tres
-- parámetros que dejó la 061—.
--
-- POR QUÉ EL MARCADO VA DENTRO DE LA MISMA FUNCIÓN Y NO EN UN PASO APARTE
--
--   * Un `UPDATE` de TypeScript separado reintroduce la ventana: el descuento
--     ya está en `other_discounts` (escrito por este mismo RPC) y el marcado
--     todavía no ocurrió. Un fallo de red, un timeout o un reinicio en ese
--     hueco deja la deuda pendiente y el descuento aplicado.
--   * La deuda aplicada dos veces es plata cobrada dos veces al empleado: es
--     el daño que este archivo existe para evitar. La alternativa de
--     compensar después vuelve a exponerse al mismo fallo a mitad de camino.
--
-- LO QUE ESTE ARCHIVO NO HACE
--
--   * No toca el CHECK de `payroll_items` ni el signo almacenado de los vales:
--     la deuda entrante se aplica dentro de `other_discounts` (061) y la
--     identidad sigue vigente sin modificarla.
--   * No recalcula nada: los montos siguen llegando resueltos desde el
--     servicio y se escriben verbatim. La aritmética de la nómina vive en
--     TypeScript.
--   * No borra ni reescribe datos FUERA de la función: el único UPDATE nuevo
--     es el marcado de `applied_period_id`, y sólo alcanza las deudas
--     pendientes cuyos ids llegaron en `p_carry_ids`.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- deja la función idéntica en cada corrida; el marcado es idempotente por su
-- `applied_period_id IS NULL`; REVOKE/GRANT lo son por naturaleza. El runner de
-- Supabase aplica el archivo en una transacción: o entra todo, o no entra nada.
--
-- COSTO DE NUMERACIÓN: 062 es el siguiente libre (la serie llega a 061); este
-- archivo NO renumera ni toca ningún archivo anterior.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La ESCRITURA atómica: ítems, vales, deuda saliente y deuda consumida
-- ===================================================================== ---

-- Firma `(uuid, jsonb, uuid[], uuid[])`: el período que se está liquidando,
-- los ítems ya calculados por el servicio, los ids de los vales que ESTE
-- cálculo descuenta por primera vez y los ids de las deudas que ESTE cálculo
-- absorbe en `other_discounts`. El tipo de retorno sigue siendo el número de
-- ítems escritos.
--
-- CAMBIOS RESPECTO DE 061 (sólo dos; el resto del cuerpo es VERBATIM):
--   * La guarda de forma (1.1) rechaza también un `p_carry_ids` NULL explícito:
--     la clave ausente la cubre el DEFAULT, pero un NULL declarado es una
--     entrada a medio formar.
--   * Un paso nuevo (1.7) marca `applied_period_id = p_period_id` en las deudas
--     recibidas que sigan pendientes, con los locks en orden determinista. NO
--     cuenta filas ni aborta si marcó menos: una deuda ya consumida por un
--     cálculo anterior es el replay que este `IS NULL` convierte en no-op, no
--     una carrera que haya que rechazar.
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
  --     clave ausente no inserta (coalesce a 0).
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
'CL-8 + NV-01: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items (incluida voucher_total, el total REAL de vales del período, fuera de la igualdad del neto), marca los vales en descontada, registra la deuda del sobrante en payroll_discount_carries y marca CONSUMIDAS (applied_period_id) las deudas que este cálculo absorbe en other_discounts, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista. NO calcula nada: cada monto llega ya resuelto por el servicio y se escribe verbatim; la aritmética de la nómina vive en TypeScript. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente y aborta si escribió menos filas de las pedidas; la deuda saliente se inserta sólo si el ítem trae voucher_excess > 0 y no existe ya una deuda del mismo empleado originada en el mismo período (recalcular no duplica); la deuda entrante se marca sólo si sigue pendiente, así un replay es un no-op y una deuda se aplica exactamente una vez. Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem, ni un vale marcado, ni una deuda aplicada. Sólo service_role puede ejecutarla.';

-- ===================================================================== ---
-- 5. Cómo verifica el dueño (SOLO LECTURA; nada de acá cambia datos)
-- ===================================================================== ---
--
--   * La firma: `payroll_apply_atomic` acepta ahora un cuarto argumento con los
--     ids de las deudas consumidas; la llamada de tres argumentos sigue válida
--     por el DEFAULT.
--   * La deuda aplicada: tras calcular el período siguiente, la fila del
--     sobrante tiene `applied_period_id` = ese período y deja de estar
--     pendiente.
--   * El no-op del replay: recalcular el mismo período NO cambia el
--     `applied_period_id` ya escrito ni duplica el descuento.
--
--   -- SELECT c.id, c.amount, c.origin_period_id, c.applied_period_id
--   --   FROM public.payroll_discount_carries c
--   --  WHERE c.employee_id = '<empleado>';
