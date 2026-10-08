-- 047_payroll_apply_atomic.sql — CL-8: el cálculo de la nómina deja de poder
-- dejar los ítems descontando un vale que sigue VIGENTE.
--
-- MOTIVO DEL ARCHIVO
--
-- `calculatePayroll` (src/features/payroll/service.ts) persistía el resultado
-- del cálculo con DOS escrituras SEGUIDAS y SIN transacción: primero el upsert
-- de `payroll_items` (`service.ts:1051`) y después el `UPDATE` de
-- `voucher_requests` a `descontada` (`service.ts:1072-1075`). Son dos requests
-- distintos contra PostgREST, que no ofrece multi-statement por request (la
-- misma nota que ya está escrita en 005, 039, 040, 041, 042, 043, 044, 045 y
-- 046). Un fallo ENTRE las dos —una escritura que falla, la conexión que se
-- corta— dejaba el ítem YA escrito descontando el vale del neto mientras el
-- vale seguía `pendiente`/`aprobada`, y con él:
--
--   * el empleado cobra CORTO y en silencio: el descuento ya está en la
--     liquidación que se va a pagar;
--   * el vale sigue VIGENTE, así que el cálculo siguiente lo vuelve a
--     descontar —dos escrituras de ítem confirmadas que incluyen el mismo
--     vale— y el empleado queda debiendo dos veces algo que se le descontó una;
--   * y la condición es INVISIBLE en la pantalla, porque el neto y el estado
--     del vale no se miran juntos en ningún lado.
--
-- De las escrituras múltiples sin transacción del módulo, ésta es la ventana
-- MÁS CARA: las otras dejan datos inconsistentes, ésta deja plata mal cobrada.
--
-- MECANISMO
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)`: es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040, `deduct_stock_atomic` 046). Una función es UNA sentencia, y una
-- sentencia corre ENTERA dentro de una sola transacción del servidor: o se
-- escriben los ítems Y se marcan los vales, o no se escribe nada. Eso es lo que
-- vuelve el cálculo atómico, y NO una compensación posterior: compensar es
-- escribir OTRA vez y volver a exponerse al mismo fallo a mitad de camino —
-- y con dinero, una compensación que falla deja el descuento aplicado—.
--
-- LA DIVISIÓN DE RESPONSABILIDADES (lo que este archivo NO hace)
--
-- El servicio COMPUTA y la función SÓLO ESCRIBE. Cada monto —el fijo
-- prorrateado, las comisiones, los bonos, el descuento de vales y el neto ya
-- resuelto— viaja en `p_items` como DATO y se escribe VERBATIM:
-- `INSERT ... SELECT (item ->> 'net_pay')::numeric`. La función no suma, no
-- resta, no recalcula y no decide elegibilidad de vales: las reglas de
-- `VoucherDiscountScope`, los topes de 026 y la fórmula de `net_pay` se quedan
-- donde están (TypeScript). El `::numeric` es una CONVERSIÓN de representación
-- (jsonb → la columna), no una operación aritmética. Lo único que valida la
-- aritmética de la fila es el CHECK de `payroll_items` que ya existía desde
-- 007 (`neto = bruto − vales − otros`, tolerancia de centavo): una barrera
-- PREEXISTENTE que COMPRUEBA un número ajeno, no una fórmula que lo produzca.
--
-- LA PRECONDICIÓN DE ESTADO Y SU RED DE CONTEO (la carrera del vale)
--
-- El `UPDATE` viejo llevaba la precondición `status IN ('pendiente','aprobada')`
-- y NO miraba cuántas filas había marcado: si otro cálculo descontaba el vale
-- entre la lectura y la escritura —o si dos cálculos del mismo período corrían
-- a la vez—, la sentencia afectaba CERO filas y seguía de largo en SILENCIO,
-- dejando los ítems escritos sobre un descuento que ya no era suyo. Acá la
-- misma precondición se conserva y se le agrega la red: `GET DIAGNOSTICS
-- ROW_COUNT` y, si no se marcaron EXACTAMENTE los vales que se recibieron, se
-- aborta la transacción COMPLETA (los ítems incluidos). La carrera deja de ser
-- silenciosa: es un rechazo.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA en las dos escrituras.
-- Los vales se bloquean con `ORDER BY v.id` (misma disciplina que 046, que
-- ordena por producto) y los ítems se insertan `ORDER BY e.id`. Dos cálculos
-- concurrentes del mismo período con la misma planta —o con vales solapados en
-- distinto orden— se bloquean en el MISMO orden, así que el segundo espera al
-- primero y no hay ciclo. El candado de los vales es el `PERFORM ... FOR UPDATE`
-- explícito; el de los ítems es el del índice único `(period_id, employee_id)`
-- que la tabla ya tiene.
--
-- POR QUÉ NO UN `upsert` CON LOS DOS CAMBIOS EN UN SOLO JSON (la alternativa
-- evaluada): obligaría a meter el estado del vale dentro del arreglo de ítems,
-- a inventar una segunda pasada en SQL para separarlos y a decidir la
-- elegibilidad en la función —justo lo que NO debe pasar—. Dos sentencias
-- dentro de la misma función ya son UNA transacción: la atomicidad no necesita
-- un statement único, necesita una transacción única.
--
-- QUIÉN PUEDE LLAMARLA (decisión de permiso, explícita)
--
--   * NO necesita ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declara
--     SECURITY INVOKER, igual que 039 y 046.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría la escritura de la NÓMINA a cualquier JWT
--     (anon/authenticated) vía PostgREST: cualquiera podría marcar vales como
--     descontados y escribir ítems de nómina con los montos que quisiera. Se
--     cierra en el paso 3: se revoca de PUBLIC, anon y authenticated, y se
--     otorga sólo a service_role. Es la misma decisión que 018 tomó para
--     `write_audit_log`, que 039 para `replace_user_roles` y que 046 para
--     `deduct_stock_atomic`.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay UPDATE ni DELETE ni TRUNCATE sobre
--     `payroll_items`, `voucher_requests` ni ninguna otra tabla FUERA de la
--     función, y el único UPDATE que la función hace es el flip de estado que
--     el servicio ya hacía (y que sigue exigiendo `pendiente`/`aprobada`).
--   * No agrega ni quita columnas, índices ni constraints: el INSERT usa las
--     columnas de 007 y el `ON CONFLICT (period_id, employee_id)` usa el índice
--     único que la tabla YA tiene; el flip usa la PK de `voucher_requests`.
--     No hay índice nuevo que justificar ni coste de escritura nuevo que
--     declarar.
--   * No toca los caminos de dinero de otros módulos: ni `invoices`, ni
--     `invoice_payments`, ni `payments`, ni `next_invoice_number`.
--   * No toca `updated_at` a mano: sigue siendo `set_updated_at()` (007), el
--     único escritor de esa columna, para que el upsert de acá deje la fila
--     exactamente como la dejaba el upsert del cliente.
--   * No backfillea ni repara cálculos que ya quedaron a medias por el bug
--     anterior: ver la nota operativa final.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `CREATE OR REPLACE FUNCTION` con la misma firma
-- y el mismo tipo de retorno deja la función idéntica en cada corrida;
-- REVOKE/GRANT son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- ORDEN DE LOS STATEMENTS (importa y es deliberado):
--   1. La función. Va PRIMERO porque es el objeto que los permisos y el
--      comentario de abajo nombran.
--   2. El `search_path` fijo de la función (house style desde 018): la función
--      resuelve `payroll_items`, `voucher_requests`, `payroll_periods` y
--      `employees`, y con una ruta mutable un esquema anterior podría
--      secuestrar esos nombres.
--   3. Los permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. El comentario de la función, para el que la lea desde `\df`.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 047, el siguiente libre
-- (032 no existe y no existirá; 033–046 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. La tabla NO tiene serie ni
-- consecutivo: `payroll_items.id` es `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()` (007), así que el cálculo no quema ningún número —una
-- sentencia abortada no deja fila y no deja hueco—. ACÁ NO SE QUEMA NINGÚN
-- NÚMERO, ni en el camino normal ni en el rechazo.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * La auditoría (`writeAudit`) queda FUERA de la transacción: es un INSERT
--     posterior y separado. No es un punto de fallo de plata (`writeAudit` no
--     lanza: registra y sigue), así que un fallo suyo no puede dejar el
--     descuento a medias; a lo sumo falta la fila de auditoría.
--   * `correctPayrollPeriod` (PA-2b) tiene la MISMA clase de ventana y NO se
--     toca acá: inserta la cabecera de `payroll_period_corrections` y después
--     los ítems de la corrección en dos requests. No mueve plata (la corrección
--     no paga ni descuenta: muestra la diferencia), y queda reportada como
--     hallazgo aparte con ese alcance.
--   * La lectura de `vouchersToDiscount` y su escritura siguen separadas por
--     el cálculo entero: entre la lectura y la transacción, otro cálculo puede
--     marcar el vale. Eso NO se cierra con una transacción más larga (haría
--     durar los locks todo el cálculo): se cierra con la PRECONDICIÓN y la red
--     de conteo, que convierten esa carrera en un rechazo visible en vez de un
--     descuento pisado en silencio.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 047 va ANTES que este código. Sin la función,
-- `calculatePayroll` no puede persistir NADA —el RPC no existe y el cálculo
-- falla entero ANTES de escribir, que es la dirección segura: un cálculo que no
-- se puede guardar no se guarda a medias—, y con la función y sin el código el
-- cálculo sigue siendo el de las dos escrituras sueltas (no hay regresión, sólo
-- no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Los ÍTEMS y los VALES del cálculo, indivisibles
-- ===================================================================== ---

-- Firma `(uuid, jsonb, uuid[])`: el período que se está liquidando, los ítems
-- ya calculados por el servicio y los ids de los vales que ESTE cálculo
-- descuenta por primera vez. El tipo de retorno es el número de ítems escritos:
-- el llamador contrasta ESE número contra lo que pidió, en vez de confiar en
-- que el RPC no dejó nada afuera.
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
  --     queda para su trigger.
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_items
    (period_id, employee_id, base_fixed, commissions, bonuses,
     deductions_vales, other_discounts, net_pay, detail_json)
  SELECT
    p_period_id,
    e.id,
    (item ->> 'base_fixed')::numeric,
    (item ->> 'commissions')::numeric,
    (item ->> 'bonuses')::numeric,
    (item ->> 'deductions_vales')::numeric,
    (item ->> 'other_discounts')::numeric,
    (item ->> 'net_pay')::numeric,
    coalesce(item -> 'detail_json', '[]'::jsonb)
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
        detail_json = EXCLUDED.detail_json;

  -- 1.5 La segunda red: si se escribieron menos ítems de los pedidos —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, el flip incluido.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_ITEM_MISMATCH';
  END IF;

  RETURN v_escritos;
END;
$$;

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `payroll_items`, `voucher_requests`, `payroll_periods` y
-- `employees`; con search_path mutable un esquema anterior en la ruta podría
-- secuestrar esos nombres. House style desde 018 (y el mismo paso que dan 039
-- y 046).
ALTER FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría escribir la nómina y marcar vales por PostgREST.
-- El único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[]) IS
'CL-8: persistencia ATÓMICA de un cálculo de nómina. Escribe los ítems de payroll_items y marca los vales en descontada en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks ordenados de forma determinista para que dos cálculos concurrentes del mismo período no se bloqueen en ciclo. NO calcula nada: cada monto llega ya resuelto por el servicio y se escribe verbatim; la aritmética de la nómina vive en TypeScript. El flip conserva la precondición de estado (sólo desde pendiente/aprobada) y su red de conteo aborta si no marcó exactamente los vales recibidos; el upsert de ítems usa ON CONFLICT (period_id, employee_id) como el upsert del cliente y aborta si escribió menos filas de las pedidas. Devuelve cuántos ítems escribió y falla con PAYROLL_INVALID (entrada mal formada o vale repetido), PAYROLL_VOUCHER_CONFLICT (la carrera del vale) o PAYROLL_ITEM_MISMATCH (la red del conteo de ítems); en los tres casos la transacción se revierte COMPLETA: no queda ni un ítem ni un vale marcado. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- un cálculo que ya quedó a medias por el bug anterior —ítems escritos con el
-- vale descontado y el vale todavía pendiente/aprobada— NO se repara solo y no
-- hay forma de detectarlo desde la base sin revisar la liquidación contra el
-- estado del vale: los números de las dos tablas son cada uno válido. Se
-- reconcilia decidiendo, por período, si el descuento del vale corresponde
-- (entonces el vale se marca descontada a mano) o si no corresponde (entonces
-- se recalcula el período) — decidido por quien opera la base, con la
-- liquidación delante y con la auditoría del cálculo como registro.
