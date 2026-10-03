-- 071_rpc_single_sede.sql — las funciones atómicas se re-emiten SIN el
-- parámetro `p_sede_id`.
--
-- MOTIVO DEL ARCHIVO
--
-- El dueño decidió que el proyecto es de una sola sede. La unidad anterior
-- retiró la ESTRUCTURA multi sede y dejó la columna `sede_id` a propósito:
-- borrarla es el último paso, cuando nadie la lea ni la escriba. Esta unidad es
-- el paso intermedio: las doce funciones atómicas que el servidor llama por
-- PostgREST dejaban de recibir la sede del actor porque la sede del actor ya no
-- es un dato de la llamada —es LA sede de la instalación— y ese parámetro era
-- una segunda frontera de sede dentro de una base que ya tiene una sola.
--
-- QUÉ CAMBIA, Y NADA MÁS
--
--   * Cada función pierde el parámetro `p_sede_id` de su firma.
--   * Cada predicado `… AND <alias>.sede_id = p_sede_id` desaparece: no hay una
--     segunda sede con la que una fila pudiera no coincidir.
--   * Cada guarda de forma `p_sede_id IS NULL` desaparece con el parámetro.
--   * Donde el cuerpo ESCRIBÍA la sede en una columna que la exige, el valor
--     sale de la fila que la función ya bloqueó (la caja, el turno, la factura):
--     `cash_open_shift_atomic` toma la de la caja que acaba de bloquear,
--     `invoice_create_atomic` la del turno que acaba de bloquear y
--     `cash_invoice_payment_atomic` la del turno que bloqueó con `FOR SHARE`.
--     No se inventa una resolución global de sede dentro de SQL: la fila que la
--     operación ya tiene bloqueada es la que la define, y con una sola sede el
--     valor es el mismo que escribía el llamador.
--
-- Lo que NO cambia: los tipos de retorno, las precondiciones de estado, los
-- locks y su orden, las redes de conteo, los SQLSTATE, el `search_path` fijo, el
-- ACL (sólo `service_role` puede ejecutarlas) y la prosa de los `COMMENT`.
--
-- POR QUÉ ESTE ARCHIVO CORRE ANTES DEL BORRADO DE LA COLUMNA
--
-- Mientras la columna existe, quitarle el parámetro a las funciones obliga a
-- que CADA punto de llamada quede honesto de una sola vez: la firma que la base
-- declara es exactamente la que el servidor manda, así que un llamador que se
-- quede con el parámetro viejo —o que invente uno nuevo— falla de inmediato y
-- de forma ruidosa en lugar de seguir funcionando contra una sobrecarga que ya
-- no debería existir. Con el parámetro fuera, la única forma de escribir `sede`
-- en una columna que la exige es tomarla de la fila bloqueada, que es el mismo
-- valor que hoy escribe el llamador; cuando una unidad posterior borre la
-- columna, esas escrituras desaparecen con ella y ninguna función queda
-- dependendo de un parámetro que ya no existe.
--
-- El orden importa por una segunda razón, más dura: DROP COLUMN es el ÚNICO
-- paso irreversible de esta serie (no hay vuelta atrás sin restaurar). Dejarlo
-- para el final significa que todo lo reversible —firmas, ACL, comentarios—
-- queda comprobado y desplegado antes de que exista el punto sin retorno.
--
-- QUÉ NO TOCA ESTE ARCHIVO
--
--   * Ninguna columna: `sede_id` sigue existiendo en todas las tablas, con su
--     tipo, su `NOT NULL` y sus claves foráneas. La que la borra es otra unidad.
--   * Ninguna política, ningún `ENABLE/DISABLE ROW LEVEL SECURITY`, ningún
--     `GRANT` de tabla: la frontera de aislamiento sigue donde estaba, y la
--     relaja la misma unidad que borra la columna.
--   * Ninguna fila: no inserta, no actualiza, no borra datos de negocio.
--   * `public.next_invoice_number(p_sede_id uuid)` (005), que se deja tal cual:
--     su parámetro no dice de quién es la sede, dice DE QUÉ CONTADOR se reserva
--     el número. `invoice_sequences` tiene `sede_id` como clave primaria y su
--     fila es la que la función bloquea e incrementa, así que el parámetro ES la
--     fila. Habría que inventar una regla global para elegirla dentro de SQL
--     cuando la tabla de sedes todavía puede tener más de una fila, y eso no es
--     decidible acá. Quien la llama (`invoice_create_atomic`) ya sabe la sede:
--     es la del turno que bloqueó.
--   * `public.write_audit_log(p_sede_id uuid, …)` (008), que se deja tal cual:
--     es un helper `SECURITY DEFINER` para triggers futuros, la app audita
--     desde TypeScript (`src/shared/lib/audit.ts`) y ninguna función de este
--     proyecto lo llama. Cambiar la firma de una función que nadie llama sólo
--     agregaría una superficie que revisar.
--   * `public.payroll_apply_atomic` (047, y sus versiones de 061/062/064/067):
--     NUNCA llevaba `p_sede_id`. Toma la sede del PERÍODO que bloquea y de ahí
--     la escribe en los ítems y en la deuda arrastrada; con una sola sede esa
--     lectura ya es la sede de la instalación.
--   * `public.upsert_employee_atomic` (054/065): la sede no es un parámetro de
--     la firma, viaja dentro del cuerpo `p_employee` que arma la administración
--     de personas, y ahí sigue siendo un dato del empleado.
--
-- ACOPLAMIENTO DE DESPLIEGUE
--
-- Este archivo va JUNTO con el código que deja de mandar la sede. Entre el
-- `DROP FUNCTION` de la sección 1 y el despliegue del código nuevo, un servidor
-- viejo recibe `function … does not exist` en vez de un rechazo de negocio: es
-- un fallo ruidoso y reintentable, no un fallo silencioso, que es la razón por la
-- que se puede aplicar en el mismo despliegue. Al revés (código nuevo contra
-- base vieja) pasa lo mismo.
--
-- IDEMPOTENTE Y RE-EJECUTABLE
--
-- `DROP FUNCTION IF EXISTS` sobre firmas viejas (que después de la primera
-- corrida no existen) y `CREATE OR REPLACE FUNCTION` sobre las nuevas dejan el
-- mismo esquema en cada corrida; `ALTER FUNCTION`, `REVOKE`, `GRANT` y
-- `COMMENT` son idempotentes. El runner de Supabase aplica el archivo en una
-- transacción: o entra todo, o no entra nada.
--
-- CÓMO VERIFICA EL DUEÑO (SOLO LECTURA; nada de acá cambia datos)
--
--   * Las doce funciones existen con la firma nueva y ninguna conserva la vieja:
--
--       -- SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--       --   FROM pg_proc p
--       --  JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public'
--       --    AND p.proname IN ('deduct_stock_atomic', 'payroll_delete_period_atomic',
--       --      'payroll_correct_period_atomic', 'cash_open_shift_atomic',
--       --      'cash_close_shift_atomic', 'cash_recount_shift_atomic',
--       --      'invoice_annul_atomic', 'invoice_split_payment_atomic',
--       --      'invoice_edit_items_atomic', 'invoice_edit_emitted_atomic',
--       --      'invoice_create_atomic', 'cash_invoice_payment_atomic')
--       --  ORDER BY 1, 2;
--
--   * Ninguna función atómica declara un parámetro de sede:
--
--       -- SELECT p.proname
--       --   FROM pg_proc p
--       --   JOIN pg_namespace n ON n.oid = p.pronamespace
--       --  WHERE n.nspname = 'public'
--       --    AND p.proname LIKE '%_atomic'
--       --    AND pg_get_function_identity_arguments(p.oid) LIKE '%sede%';
--
--     (sin filas)
--
--   * La columna sigue existiendo, con su tipo y sus claves:
--
--       -- SELECT table_name, column_name, data_type, is_nullable
--       --   FROM information_schema.columns
--       --  WHERE table_schema = 'public' AND column_name = 'sede_id'
--       --  ORDER BY table_name;
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. Las firmas viejas, por DROPEO
-- ===================================================================== ---
--
-- PostgreSQL identifica una función por su firma: un `CREATE OR REPLACE` con
-- una lista de parámetros distinta NO reemplaza nada, crea una SOBRECARGA y deja
-- viva la vieja —con su `p_sede_id` y sus permisos— al lado de la nueva. Por eso
-- el `DROP` va primero, uno por función, con el `IF EXISTS` que lo hace
-- re-ejecutable. Es el mismo criterio que 056 y 057 aplicaron cuando cambiaron
-- su firma.
--
-- El orden pone primero las que llaman a otras: `invoice_create_atomic` llama a
-- `deduct_stock_atomic`. PL/pgSQL no registra dependencias entre funciones por
-- el cuerpo, así que el orden es sólo una cortesía para que el día que las
-- registre el `DROP` no encuentre referencias.

DROP FUNCTION IF EXISTS public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS public.deduct_stock_atomic(uuid, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb);
DROP FUNCTION IF EXISTS public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb);
DROP FUNCTION IF EXISTS public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb);
DROP FUNCTION IF EXISTS public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb);
DROP FUNCTION IF EXISTS public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb);
DROP FUNCTION IF EXISTS public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb);
DROP FUNCTION IF EXISTS public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[]);
DROP FUNCTION IF EXISTS public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb);

-- ===================================================================== ---
-- 2. LAS DOCE funciones, de a una: la función, su `search_path` fijo, sus
--    permisos y su documentación. El mismo orden de statements que 046–060
--    (la función primero, porque es el objeto que nombran el ACL y el
--    comentario), y los mismos comentarios de por qué.
-- ===================================================================== --

-- ---------------------------------------------------------------- 2.1 ----
-- deduct_stock_atomic (046)
--
-- Firma `(uuid, text, jsonb)`: el usuario responsable, el motivo común del
-- kardex (`FACTURA #N — Cliente`) y los pares `{product_id, qty}` ya agregados
-- por producto. Lo único que falta respecto de 046 es la sede del actor: el
-- movimiento toma la del PRODUCTO, que es la única que la función necesita y la
-- que ya tomaba.
CREATE OR REPLACE FUNCTION public.deduct_stock_atomic(
  p_user_id uuid,
  p_reason text,
  p_items jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pedidos integer;
  v_unicos integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que inserta stock no puede aceptar
  --     una entrada a medio formar: el precio de un rechazo claro acá es
  --     infinitamente menor que el de una deducción interpretada.
  IF p_user_id IS NULL
     OR p_reason IS NULL
     OR btrim(p_reason) = ''
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  --     Cada elemento tiene que ser un objeto con un uuid bien formado (la MISMA
  --     forma que valida el CHECK de la 045) y una cantidad de 1 a 9 dígitos.
  --     El `coalesce` es la parte que importa: con la clave ausente,
  --     `item ->> 'qty'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce una entrada sin `qty` pasaría esta guarda. El `CASE`
  --     garantiza además que el cast a integer sólo se evalúe cuando el texto
  --     YA validó la forma (SQL no promete el orden de las condiciones del OR).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer
            ELSE NULL
          END <= 0
  ) THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.2 Cuántos movimientos se piden y cuántos productos distintos hay. Una
  --     deducción sin ítems no es una deducción; una con un producto repetido
  --     tampoco (ver "UN MOVIMIENTO POR PRODUCTO" de 046: la guarda del stock
  --     no vería el efecto de la fila anterior de la misma sentencia).
  SELECT count(*), count(DISTINCT (item ->> 'product_id'))
    INTO v_pedidos, v_unicos
  FROM jsonb_array_elements(p_items) AS item;

  IF v_pedidos = 0 OR v_unicos <> v_pedidos THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.3 La ESCRITURA: UNA sentencia, y por eso UNA transacción. Todos los
  --     movimientos se insertan con el mismo motivo y el mismo responsable, y con
  --     la sede DEL PRODUCTO —la que escribe la fila—: `type` es 'OUT' y sólo
  --     'OUT': esta función es el descuento de una venta, no un movimiento
  --     genérico.
  --
  --     `ORDER BY p.id` es el orden de los locks del trigger de 004 (ver
  --     "SERIALIZACIÓN" de 046).
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la deducción de una
  --     emisión no tiene intento de cliente, su puerta es la marca de la
  --     FACTURA (041) y su fila queda FUERA del índice único parcial de la 045
  --     (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 046).
  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    'OUT',
    (item ->> 'qty')::integer,
    btrim(p_reason),
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.4 Red de seguridad DENTRO de la transacción: si se escribió MENOS de lo
  --     pedido, se aborta y se revierte todo lo que esta sentencia sí escribió
  --     (el stock incluido, porque sus triggers corren en la misma
  --     transacción). El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback.
  --     Es la misma red que 039 puso sobre su INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_pedidos THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  RETURN v_escritos;
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres.
-- House style desde 018 (y el mismo paso que da 039).
ALTER FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría descontar stock por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.deduct_stock_atomic(uuid, text, jsonb) IS
'CL-7: descuento ATÓMICO del stock de una venta multi-producto. Inserta TODOS los movimientos OUT en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks de fila del trigger trg_inventory_no_negative ordenados por producto para que dos deducciones concurrentes no se bloqueen en ciclo. Un fallo de cualquier movimiento (o de la guarda del stock) revierte la deducción COMPLETA: no queda descuento parcial. Devuelve cuántos movimientos aplicó y falla con DEDUCTION_INVALID (entrada mal formada o producto repetido) o PRODUCT_NOT_FOUND (la red de seguridad del conteo). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock; esta función nunca escribe products.stock_qty. El movimiento toma la sede del PRODUCTO, no una sede recibida: la instalación es de una sola sede (071) y el producto es la fila que la define. Escribe idempotency_key NULL a propósito: la deducción de una emisión no tiene intento de cliente y queda fuera del índice parcial de la 045. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.2 ----
-- payroll_delete_period_atomic (048)
--
-- Firma `(uuid, uuid[], uuid[])`: el período en borrador y los dos grupos de
-- vales YA clasificados por el servicio (los que vuelven a `aprobada` y los que
-- vuelven a `pendiente`). El tipo de retorno es el número de vales revertidos:
-- el llamador contrasta ESE número contra lo que pidió, en vez de confiar en que
-- la función no dejó nada afuera.
CREATE OR REPLACE FUNCTION public.payroll_delete_period_atomic(
  p_period_id uuid,
  p_to_approved uuid[],
  p_to_pending uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_start date;
  v_end date;
  v_esperados integer;
  v_revertidos integer;
  v_borrados integer;
BEGIN
  -- 1.1 FORMA de la entrada. La función revierte estados de vales y borra una
  --     nómina: no puede aceptar una entrada a medio formar. Los dos arreglos
  --     pueden venir VACÍOS (un borrador sin vales descontados es un caso
  --     legal), pero tienen que venir.
  IF p_period_id IS NULL
     OR p_to_approved IS NULL
     OR p_to_pending IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada grupo tiene que ser un CONJUNTO (sin ids repetidos) y los dos
  --     grupos tienen que ser DISJUNTOS. Un id repetido dentro de un grupo, o
  --     presente en los dos, no se puede revertir dos veces: la red de conteo
  --     de abajo fallaría igual, pero con el mensaje equivocado. Se valida en
  --     vez de confiar en que el llamador partió bien.
  IF cardinality(p_to_approved) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_approved) AS id
     )
     OR cardinality(p_to_pending) <> (
       SELECT count(DISTINCT id) FROM unnest(p_to_pending) AS id
     )
     OR EXISTS (
       SELECT 1 FROM unnest(p_to_approved) AS id WHERE id = ANY (p_to_pending)
     )
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 1.2 El PERÍODO, bloqueado, y su precondición de estado leída de LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047): a partir de acá, otro
  --     borrado o un cierre del mismo período espera, y si el período cambió
  --     antes, esta lectura ve la versión nueva y rechaza.
  SELECT p.status, p.start_date, p.end_date
    INTO v_status, v_start, v_end
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
  FOR UPDATE;

  IF NOT FOUND OR v_status <> 'borrador' THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  -- 1.3 El guardia de SOLAPAMIENTO, re-evaluado adentro de la transacción con
  --     las fechas de la fila bloqueada. Es la misma regla que el servicio
  --     aplica en `overlapBlocksDeletion`: un período CERRADO que solapa el
  --     rango hace ambiguo qué vales son de este borrador, y revertirlos
  --     destruiría una nómina ya pagada. Solapar con otros BORRADORES no
  --     bloquea: no hay plata pagada y el borrador restante puede recalcularse.
  --     El código es el mismo que el servicio ya devolvía, así que el contrato
  --     de error no cambia.
  IF EXISTS (
    SELECT 1
    FROM public.payroll_periods o
    WHERE o.id <> p_period_id
      AND o.status = 'cerrado'
      AND o.start_date <= v_end
      AND o.end_date >= v_start
  ) THEN
    RAISE EXCEPTION 'PERIOD_OVERLAP_AMBIGUOUS';
  END IF;

  -- 1.4 Los LOCKS de los vales, en orden determinista ascendente por id (ver
  --     "SERIALIZACIÓN" de 048). El bloqueo va PRIMERO y aparte del UPDATE: con
  --     `ORDER BY` delante, dos operaciones con vales solapados se esperan en el
  --     mismo orden en vez de bloquearse en ciclo. El `UPDATE` de abajo no
  --     necesita orden: sus filas ya las bloqueó este paso, en esta misma
  --     transacción.
  PERFORM 1
    FROM public.voucher_requests v
   WHERE v.id = ANY (p_to_approved || p_to_pending)
   ORDER BY v.id
     FOR UPDATE OF v;

  -- 1.5 La REVERSIÓN: UNA sentencia para los DOS grupos —y por eso UNA red de
  --     conteo—. El estado destino lo elige el servicio (`restoreVoucherStatus`)
  --     y viaja ya resuelto en el grupo donde va cada id; acá sólo se escribe.
  --     La precondición `status = 'descontada'` es la MISMA que llevaba cada
  --     `UPDATE` del servicio: un vale que ya no está descontado no se toca, y el
  --     conteo de abajo convierte esa carrera en un rechazo.
  v_esperados := cardinality(p_to_approved) + cardinality(p_to_pending);

  UPDATE public.voucher_requests v
     SET status = CASE
                    WHEN v.id = ANY (p_to_approved) THEN 'aprobada'
                    ELSE 'pendiente'
                  END
   WHERE v.id = ANY (p_to_approved || p_to_pending)
     AND v.status = 'descontada';

  -- 1.6 Red de seguridad DENTRO de la transacción: si se revirtieron MENOS vales
  --     de los recibidos —uno lo revirtió otro borrado, o ya estaba en otro
  --     estado—, se aborta y se revierte todo lo que esta sentencia sí escribió.
  --     Sin esta red, el `UPDATE` afectaba cero filas y la operación seguía de
  --     largo EN SILENCIO, borrando el período con vales que ya no eran suyos.
  GET DIAGNOSTICS v_revertidos = ROW_COUNT;

  IF v_revertidos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_VOUCHER_CONFLICT';
  END IF;

  -- 1.7 El BORRADO del período, con su precondición en el propio `WHERE` (la
  --     red de conteo de 1.2 ya la verificó sobre la fila bloqueada; acá se
  --     repite como un compare-and-swap, porque es lo que hace que dos borrados
  --     concurrentes no se pisen). `payroll_items` y `payroll_payments` caen con
  --     él por las FK `ON DELETE CASCADE` de 007, dentro de esta misma
  --     transacción: no hay borrado manual ni huérfanos.
  DELETE FROM public.payroll_periods p
   WHERE p.id = p_period_id
     AND p.status = 'borrador';

  -- 1.8 La segunda red: exactamente UNA fila borrada. Cero filas es un período
  --     que cambió bajo los pies; el resultado es el mismo: rollback de TODO,
  --     la reversión incluida.
  GET DIAGNOSTICS v_borrados = ROW_COUNT;

  IF v_borrados <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CONFLICT';
  END IF;

  RETURN v_revertidos;
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `payroll_periods` y `voucher_requests`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039, 046 y 047).
ALTER FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría borrar períodos en borrador y revertir vales por
-- PostgREST. El único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.payroll_delete_period_atomic(uuid, uuid[], uuid[]) IS
'CL-9: borrado ATÓMICO de un período en BORRADOR. Revierte los vales que ese borrador descontó y borra el período en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero y los vales en orden ascendente por id para que dos borrados concurrentes no se bloqueen en ciclo. Conserva las precondiciones del servicio: sólo un período en borrador, y el guardia de solapamiento contra un período CERRADO (PERIOD_OVERLAP_AMBIGUOUS) re-evaluado dentro de la transacción. Los ids de los vales y su estado destino llegan YA resueltos por el servicio (restoreVoucherStatus): la función no decide qué se revierte ni a qué estado. Su red de conteo aborta con PAYROLL_VOUCHER_CONFLICT si no revirtió exactamente los vales recibidos y con PAYROLL_PERIOD_CONFLICT si el período ya no es borrador o no borró exactamente una fila; en los dos casos la transacción se revierte COMPLETA. Devuelve cuántos vales revirtió. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.3 ----
-- payroll_correct_period_atomic (048)
--
-- Firma `(uuid, jsonb, jsonb)`: el período corregido, la cabecera ya resuelta
-- (`{period_id, previous_net_total, previous_paid_total, corrected_net_total,
-- previous_item_count, corrected_item_count, reason, corrected_by}`) y las filas
-- por empleado con los montos de las DOS versiones.
CREATE OR REPLACE FUNCTION public.payroll_correct_period_atomic(
  p_period_id uuid,
  p_correction jsonb,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_cabecera public.payroll_period_corrections;
  v_cabeceras integer;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 5.1 FORMA de la entrada. Una función que firma una corrección de nómina no
  --     puede aceptar una entrada a medio formar: el precio de un rechazo claro
  --     acá es infinitamente menor que el de una corrección interpretada.
  --     `p_items` puede venir VACÍO (un período sin planta activa todavía tiene
  --     una versión anterior que congelar), pero tiene que ser un ARREGLO.
  IF p_period_id IS NULL
     OR p_correction IS NULL
     OR jsonb_typeof(p_correction) <> 'object'
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     La cabecera: el motivo no puede quedar vacío (ni en espacios), el actor
  --     tiene que ser un usuario, el período declarado tiene que ser EL MISMO
  --     que se va a corregir, y los totales y los conteos tienen que tener la
  --     forma que la tabla puede guardar (`numeric(12, 2)` y un entero).
  --
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `p_correction ->> 'previous_net_total'` es NULL y `NULL !~ 'regex'` es
  --     NULL —no TRUE—, así que sin el coalesce una entrada sin un monto
  --     pasaría esta guarda y el `NOT NULL` de la columna sería el que hablara,
  --     con un error de la base en vez de un rechazo del contrato. Es la misma
  --     trampa que 046 documenta para `qty` y 047 para `net_pay`.
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  IF btrim(coalesce(p_correction ->> 'reason', '')) = ''
     OR coalesce(p_correction ->> 'period_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (p_correction ->> 'period_id')::uuid <> p_period_id
     OR coalesce(p_correction ->> 'corrected_by', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(p_correction ->> 'previous_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_paid_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'corrected_net_total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_correction ->> 'previous_item_count', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_correction ->> 'corrected_item_count', '') !~ '^[0-9]{1,9}$'
  THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  --     Cada fila tiene que ser un objeto con un `employee_id` con la forma del
  --     `CHECK` de 001/007 y sus TRECE montos como número no negativo de hasta 9
  --     dígitos enteros y 2 decimales —exactamente lo que `numeric(12, 2)` puede
  --     guardar, en las dos versiones (la anterior congelada y la corregida) más
  --     lo pagado—.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'previous_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'previous_paid', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_base_fixed', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_commissions', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_bonuses', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_deductions_vales', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_other_discounts', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'corrected_net_pay', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.2 Un empleado REPETIDO en las filas no es un empleado dos veces: las dos
  --     versiones de un empleado van en UNA fila (el índice único
  --     `uq_payroll_period_correction_items_employee` de 037 lo impide, y ese
  --     23505 se traduciría a ALREADY_CORRECTED, que sería una mentira). Se
  --     rechaza la entrada repetida en vez de confiar en que el llamador no
  --     repite.
  IF jsonb_array_length(p_items) <> (
    SELECT count(DISTINCT item ->> 'employee_id')
    FROM jsonb_array_elements(p_items) AS item
  ) THEN
    RAISE EXCEPTION 'PAYROLL_INVALID';
  END IF;

  -- 5.3 El PERÍODO, bloqueado, y su precondición de estado leída DE LA FILA
  --     (`assertCorrectablePeriod`: sólo un período CERRADO se corrige; un
  --     borrador se recalcula, no se corrige).
  SELECT p.status
    INTO v_status
  FROM public.payroll_periods p
  WHERE p.id = p_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_CONFLICT';
  END IF;
  IF v_status <> 'cerrado' THEN
    RAISE EXCEPTION 'PERIOD_NOT_CLOSED';
  END IF;

  -- 5.4 La CABECERA: UNA sentencia, y por eso UNA transacción con las filas de
  --     5.5. Todos los campos entran VERBATIM desde `p_correction` —los totales
  --     de las dos versiones, los conteos, el motivo y el actor—: acá no se
  --     suma, no se resta y no se recalcula nada.
  --
  --     El índice único por período de 037 es la barrera de "una corrección por
  --     período": una carrera contra él levanta 23505 y aborta la transacción
  --     —el servicio lo traduce a ALREADY_CORRECTED, como ya hacía—, así que la
  --     corrección perdedora no deja NADA escrito.
  INSERT INTO public.payroll_period_corrections
    (period_id, previous_net_total, previous_paid_total, corrected_net_total,
     previous_item_count, corrected_item_count, reason, corrected_by)
  VALUES (
    p_period_id,
    (p_correction ->> 'previous_net_total')::numeric,
    (p_correction ->> 'previous_paid_total')::numeric,
    (p_correction ->> 'corrected_net_total')::numeric,
    (p_correction ->> 'previous_item_count')::integer,
    (p_correction ->> 'corrected_item_count')::integer,
    p_correction ->> 'reason',
    (p_correction ->> 'corrected_by')::uuid
  )
  RETURNING * INTO v_cabecera;

  GET DIAGNOSTICS v_cabeceras = ROW_COUNT;

  IF v_cabeceras <> 1 THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.5 Las FILAS por empleado: la versión anterior congelada, lo pagado y la
  --     versión corregida, TODO verbatim desde `p_items`. Una fila por empleado
  --     de la comparación (`buildPayrollCorrectionView` puede incluir a alguien
  --     que sólo esté en una de las dos versiones, con la otra en cero).
  --
  --     El `JOIN` filtra por la existencia del empleado: uno inexistente
  --     escribiría menos filas en SILENCIO, y la red de 5.6 convierte ese
  --     subconjunto silencioso en un rechazo con rollback. `ORDER BY e.id` es el
  --     orden determinista de los locks de `payroll_period_correction_items`
  --     (ver "SERIALIZACIÓN" de 048).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.payroll_period_correction_items
    (correction_id, employee_id,
     previous_base_fixed, previous_commissions, previous_bonuses,
     previous_deductions_vales, previous_other_discounts, previous_net_pay, previous_paid,
     corrected_base_fixed, corrected_commissions, corrected_bonuses,
     corrected_deductions_vales, corrected_other_discounts, corrected_net_pay)
  SELECT
    v_cabecera.id,
    e.id,
    (item ->> 'previous_base_fixed')::numeric,
    (item ->> 'previous_commissions')::numeric,
    (item ->> 'previous_bonuses')::numeric,
    (item ->> 'previous_deductions_vales')::numeric,
    (item ->> 'previous_other_discounts')::numeric,
    (item ->> 'previous_net_pay')::numeric,
    (item ->> 'previous_paid')::numeric,
    (item ->> 'corrected_base_fixed')::numeric,
    (item ->> 'corrected_commissions')::numeric,
    (item ->> 'corrected_bonuses')::numeric,
    (item ->> 'corrected_deductions_vales')::numeric,
    (item ->> 'corrected_other_discounts')::numeric,
    (item ->> 'corrected_net_pay')::numeric
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.employees e
    ON e.id = (item ->> 'employee_id')::uuid
  ORDER BY e.id;

  -- 5.6 La segunda red: si se escribieron menos filas de las pedidas —el caso
  --     del `JOIN` de arriba—, se aborta y se revierte TODO, la cabecera
  --     incluida. Es lo que separa "la corrección no se pudo firmar" de "la
  --     corrección quedó firmada sin su prueba".
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYROLL_CORRECTION_MISMATCH';
  END IF;

  -- 5.7 La cabecera ESCRITA, tal como quedó en la tabla (con su `id` y su
  --     `corrected_at` del DEFAULT). Devolverla evita una segunda lectura y su
  --     ventana.
  RETURN to_jsonb(v_cabecera);
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `payroll_periods`, `payroll_period_corrections` y
-- `employees`; con search_path mutable un esquema anterior en la ruta podría
-- secuestrar esos nombres. House style desde 018 (y el mismo paso que dan 039,
-- 046 y 047).
ALTER FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría firmar una corrección de nómina por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.payroll_correct_period_atomic(uuid, jsonb, jsonb) IS
'CL-9: corrección ATÓMICA de un período CERRADO (PA-2b, 037). Inserta la cabecera de payroll_period_corrections y sus filas por empleado en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del período bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: la cabecera y las filas llegan ya resueltas por el servicio (computePayrollLines, la prorata del fijo, el arrastre de los ajustes manuales y buildPayrollCorrectionView) y se escriben verbatim; la aritmética de la nómina vive en TypeScript. Conserva las precondiciones del servicio: sólo un período CERRADO (PERIOD_NOT_CLOSED) y el índice único por período de 037 (23505 → ALREADY_CORRECTED) adentro de la transacción. Sus redes de conteo abortan con PAYROLL_CORRECTION_MISMATCH si no escribió exactamente una cabecera y exactamente las filas recibidas; en ese caso la transacción se revierte COMPLETA: no queda una corrección firmada sin su prueba. Devuelve la cabecera escrita. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.4 ----
-- cash_open_shift_atomic (049)
--
-- Firma `(uuid, uuid, numeric, jsonb)`: la caja, quién abre, la base de apertura
-- ya resuelta por el servicio y las líneas del conteo ya validadas por él. El
-- tipo de retorno es el TURNO ESCRITO (jsonb), con las MISMAS columnas que el
-- servicio leía con `SHIFT_SELECT`.
--
-- La sede del turno nuevo sale de la CAJA bloqueada: es la fila que esta
-- operación ya tiene bloqueada, así que no hace falta un parámetro para nombrarla.
CREATE OR REPLACE FUNCTION public.cash_open_shift_atomic(
  p_register_id uuid,
  p_opened_by uuid,
  p_opening_base numeric,
  p_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_sede uuid;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que abre un turno de caja no puede
  --     aceptar una entrada a medio formar: el precio de un rechazo claro acá
  --     es infinitamente menor que el de una apertura interpretada. La base no
  --     puede ser negativa, pero SÍ puede ser cero (una caja que abre sin
  --     fondo es un caso legal).
  IF p_register_id IS NULL
     OR p_opened_by IS NULL
     OR p_opening_base IS NULL
     OR p_opening_base < 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo. El `coalesce` es la parte que importa: con la
  --     clave AUSENTE, `item ->> 'amount'` es NULL y `NULL !~ 'regex'` es NULL
  --     —no TRUE—, así que sin el coalesce una línea sin monto pasaría esta
  --     guarda y sería el `NOT NULL` de la columna el que hablara, con un error
  --     de la base en vez de un rechazo del contrato. Es la misma trampa que 046
  --     documenta para `qty`, 047 para `net_pay` y 048 para sus montos.
  --
  --     La estructura que la tabla ya exige (009) también se comprueba acá, por
  --     FORMA y no por aritmética: una línea de EFECTIVO lleva denominación y
  --     cualquier cantidad; una línea DIGITAL no lleva denominación y declara su
  --     total con cantidad 1. El `CASE` garantiza que cada conversión a
  --     `numeric`/`integer` sólo se evalúe cuando el texto YA validó su forma
  --     (SQL no promete el orden de las condiciones del OR).
  --
  --     El decimal se escribe `[.]` y no `\.` a propósito: sin escape, la
  --     expresión regular significa lo mismo con cualquier
  --     `standard_conforming_strings` y no depende de que la barra sobreviva al
  --     literal.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    CROSS JOIN LATERAL (
      SELECT
        coalesce(item ->> 'method_code', '') AS method_code,
        coalesce(item ->> 'denomination', '') AS denomination_txt,
        coalesce(item ->> 'quantity', '') AS quantity_txt,
        coalesce(item ->> 'amount', '') AS amount_txt
    ) AS txt
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(txt.method_code) = ''
       OR txt.denomination_txt !~ '^([0-9]{1,9}([.][0-9]{1,2})?)?$'
       OR txt.quantity_txt !~ '^[0-9]{1,9}$'
       OR txt.amount_txt !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR CASE
            WHEN txt.quantity_txt ~ '^[0-9]{1,9}$'
              THEN (txt.quantity_txt)::integer <> 1 AND txt.denomination_txt = ''
            ELSE NULL
          END
       OR CASE
            WHEN txt.denomination_txt ~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
              THEN (txt.denomination_txt)::numeric <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 1.2 La CAJA, bloqueada, y su sede: es el punto de serialización de todo el
  --     ciclo de caja. A partir de acá, otra apertura, otro cierre u otro
  --     reconteo de la MISMA caja espera; y si la caja no existe, la transacción
  --     rechaza en vez de abrir un turno de una caja que no está. La sede que
  --     escribe el turno es la de ESA caja —la fila que esta operación acaba de
  --     bloquear—, que es la misma que mandaba el llamador.
  SELECT r.sede_id
    INTO v_sede
  FROM public.cash_registers r
   WHERE r.id = p_register_id
   FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_REGISTER_NOT_FOUND';
  END IF;

  -- 1.3 El guardia de "un turno abierto por caja" (CAJ-01), re-evaluado adentro
  --     con la caja YA bloqueada. Es la misma regla que `assertNoOpenShift`
  --     aplica en el servicio; el índice único parcial de 006
  --     (`uq_cash_shifts_open_per_register`) sigue siendo la barrera final si
  --     dos aperturas llegaran a evaluar esto a la vez, y el `23505` que
  --     levanta lo traduce el servicio al MISMO error de negocio.
  PERFORM 1
    FROM public.cash_shifts s
   WHERE s.cash_register_id = p_register_id
     AND s.status = 'abierto'
   ORDER BY s.id
   FOR UPDATE OF s;

  IF FOUND THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_OPEN';
  END IF;

  -- 1.4 El TURNO: UNA sentencia, y por eso UNA transacción con su arqueo de
  --     abajo. El turno nace `abierto`, con la base que el servicio resolvió
  --     —escrita verbatim— y con `expected_cash` en 0, como nacía antes: el
  --     esperado de un turno recién abierto todavía no tiene cobros.
  INSERT INTO public.cash_shifts
    (cash_register_id, sede_id, opened_by, opening_base, expected_cash, status)
  VALUES
    (p_register_id, v_sede, p_opened_by, p_opening_base, 0, 'abierto')
  RETURNING * INTO v_turno;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 1.5 El ARQUEO DE APERTURA: las líneas por método y denominación, con la
  --     fase que le corresponde, el turno recién creado y cada monto ESCRITO
  --     VERBATIM desde `p_counts` —acá no se multiplica denominación por
  --     cantidad ni se suma nada—. `ORDER BY` deja el orden determinista (ver
  --     "SERIALIZACIÓN" de 049).
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    v_turno.id,
    'apertura',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     líneas de las recibidas, se aborta y se revierte TODO, el turno
  --     incluido. Sin esta red, un arreglo que escribiera un subconjunto
  --     dejaría un turno ABIERTO sin su arqueo: exactamente el estado parcial
  --     que 049 cierra.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, con las MISMAS columnas que el servicio leía: eso es
  --     lo que el llamador usa como resultado, sin otra lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'sede_id', v_turno.sede_id,
    'opened_by', v_turno.opened_by,
    'closed_by', v_turno.closed_by,
    'opened_at', v_turno.opened_at,
    'closed_at', v_turno.closed_at,
    'opening_base', v_turno.opening_base,
    'expected_cash', v_turno.expected_cash,
    'counted_cash', v_turno.counted_cash,
    'base_left', v_turno.base_left,
    'cash_withdrawn', v_turno.cash_withdrawn,
    'base_difference', v_turno.base_difference,
    'status', v_turno.status,
    'observation', v_turno.observation
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `cash_registers`, `cash_shifts` y `cash_shift_counts`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–048).
ALTER FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría abrir un turno de caja por PostgREST con la base
-- y el conteo que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) IS
'CL-10: apertura ATÓMICA de un turno de caja (CAJ-01). Inserta el turno ABIERTO y su conteo de apertura en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la caja bloqueada primero para que el guardia de "un turno abierto por caja" (índice único parcial de 006) no pueda volverse mentira entre la lectura y la escritura. El turno toma la sede de ESA caja, que es la fila bloqueada: la instalación es de una sola sede (071) y la función no recibe una. NO calcula nada: la base del turno llega resuelta por resolveOpeningBase y cada línea del conteo llega validada por checkCounts; la función las escribe verbatim. Un fallo de la escritura del turno o del arqueo —y su red de conteo, que aborta si no escribió exactamente las líneas recibidas— revierte la transacción COMPLETA: no queda un turno abierto sin su arqueo de apertura. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT; falla con SHIFT_INVALID (entrada mal formada), SHIFT_REGISTER_NOT_FOUND (la caja no existe), SHIFT_ALREADY_OPEN (la carrera del turno abierto, 23505), SHIFT_WRITE_MISMATCH o SHIFT_COUNT_MISMATCH. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.5 ----
-- cash_close_shift_atomic (059, que a su vez trae 049 + 058)
--
-- Firma `(uuid, uuid, timestamptz, jsonb, jsonb, jsonb)`: el turno, quién
-- cierra, el instante, el arqueo, el conteo por denominación y el token con
-- los CUATRO conteos de las fuentes que el arqueo suma y resta (CL-19/CL-20).
CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic(
  p_shift_id uuid,
  p_closed_by uuid,
  p_closed_at timestamptz,
  p_close jsonb,
  p_counts jsonb,
  p_collection_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_esperados integer;
  v_actualizados integer;
  v_escritos integer;
  v_payments bigint;
  v_invoice_payments bigint;
  v_commission_payouts bigint;
  v_voucher_requests bigint;
BEGIN
  -- 1.1 FORMA de la entrada. Un cierre es el documento que firma un arqueo: no
  --     puede aceptar una entrada a medio formar.
  IF p_shift_id IS NULL
     OR p_closed_by IS NULL
     OR p_closed_at IS NULL
     OR p_close IS NULL
     OR jsonb_typeof(p_close) <> 'object'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     EL TOKEN: la forma de la PRECONDICIÓN. Sin esta guarda, una clave
  --     ausente dejaría `(null)::integer` en la comparación de 1.3, la
  --     comparación daría NULL —no TRUE— y el cierre pasaría SIN comprobar
  --     nada: un bypass silencioso. Un objeto con los CUATRO conteo como enteros
  --     no negativos es la única forma aceptada; el `coalesce` es el mismo
  --     recurso que 046–049 y 058 usan para que una clave AUSENTE falle en vez
  --     de comparar contra NULL, y la ausencia se rechaza con el error de forma
  --     —jamás se interpreta como "no compares"—, como 057 dejó escrito para su
  --     propia precondición.
  --
  --     Que la guarda exija las CUATRO claves es lo que hace que este archivo no
  --     sea compatible hacia atrás con la app de 058: un llamador que mande dos
  --     recibe SHIFT_INVALID y no cierra. Es deliberado (ver "ACOPLAMIENTO DE
  --     DESPLIEGUE" de 059): aceptar dos sería aceptar firmar sin comprobar las
  --     salidas.
  IF p_collection_counts IS NULL
     OR jsonb_typeof(p_collection_counts) <> 'object'
     OR coalesce(p_collection_counts ->> 'payments', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'invoice_payments', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'commission_payouts', '') !~ '^[0-9]{1,9}$'
     OR coalesce(p_collection_counts ->> 'voucher_requests', '') !~ '^[0-9]{1,9}$'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Los CUATRO montos del turno y su observación. El `coalesce` es lo que
  --     hace que una clave AUSENTE falle en vez de comparar contra NULL (la
  --     misma trampa de 046–048).
  --
  --     `base_difference` (base dejada menos base configurada) y
  --     `expected_cash` PUEDEN ser negativos en una entrada legítima: el
  --     primero es el faltante de la base (caso 300/150 del dueño) y el segundo
  --     lo rechaza una regla de NEGOCIO que NO vive acá —el CHECK
  --     `expected_cash >= 0` de 006—, que el servicio traduce a
  --     CASH_OUT_EXCEEDS_COLLECTED. Por eso la guarda de forma de esos dos
  --     admite el signo: adelantarse a esa regla con un SHIFT_INVALID sería
  --     cambiar el contrato de error del cierre. `cash_withdrawn` también lo
  --     admite: es una DIFERENCIA (contado menos base dejada), no un nivel, y la
  --     tabla no le exige ser no negativo —la guarda espeja la tabla, no
  --     inventa una restricción que ella no tiene—. `counted_cash`, `base_left`
  --     y la base de apertura NO admiten signo porque el CHECK de 006 sí los
  --     exige no negativos (y el esquema del servicio también).
  IF coalesce(p_close ->> 'expected_cash', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_close ->> 'base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR (p_close -> 'observation' IS NOT NULL
         AND jsonb_typeof(p_close -> 'observation') NOT IN ('null', 'string'))
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo: la misma guarda de forma de la apertura (ver
  --     1.1 de 049), porque es el mismo conteo con otra fase.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    CROSS JOIN LATERAL (
      SELECT
        coalesce(item ->> 'method_code', '') AS method_code,
        coalesce(item ->> 'denomination', '') AS denomination_txt,
        coalesce(item ->> 'quantity', '') AS quantity_txt,
        coalesce(item ->> 'amount', '') AS amount_txt
    ) AS txt
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(txt.method_code) = ''
       OR txt.denomination_txt !~ '^([0-9]{1,9}([.][0-9]{1,2})?)?$'
       OR txt.quantity_txt !~ '^[0-9]{1,9}$'
       OR txt.amount_txt !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR CASE
            WHEN txt.quantity_txt ~ '^[0-9]{1,9}$'
              THEN (txt.quantity_txt)::integer <> 1 AND txt.denomination_txt = ''
            ELSE NULL
          END
       OR CASE
            WHEN txt.denomination_txt ~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
              THEN (txt.denomination_txt)::numeric <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 1.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA (no
  --     del dato que mandó el llamador). `FOR UPDATE` es el idioma de la casa
  --     para tomar un lock de fila (039, 040, 047, 048): a partir de acá, otro
  --     cierre del mismo turno espera; un cobro del mismo turno (056) espera o
  --     es rechazado; y si el turno ya se cerró antes, esta lectura ve la versión
  --     nueva y rechaza.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 1.2b LA PRECONDICIÓN DEL CONJUNTO DEL ARQUEO (CL-19 + CL-20). El paso se
  --      numera "1.2b" —y no se renumeran los pasos de 049 ni los de 058— para
  --      que el diff se lea de un vistazo: la precondición entra EXACTAMENTE
  --      entre el lock del turno y la escritura, y nada más se mueve.
  --
  --      Los CUATRO `count(*)` RE-CUENTAN las MISMAS cuatro fuentes que el
  --      servicio usó: las dos que el arqueo SUMA (`payments` del turno sin
  --      factura, y las `invoice_payments` atribuidas al turno) y las dos que
  --      RESTA (`commission_payouts` del turno, y los vales aprobados con método
  --      del turno). NO se suma ningún monto: contar filas no es operar sobre
  --      dinero. Las variables son `bigint` porque es el tipo que `count(*)`
  --      devuelve: no hay ninguna conversión estrecha entre el conteo y lo que se
  --      compara (la guarda de forma de 1.1 ya limitó el token a nueve dígitos).
  --
  --      La segunda fuente es la UNIÓN que describe `fetchInvoicePaymentsByShift`:
  --      las filas con `cash_shift_id = p_shift_id` MÁS las históricas sin turno
  --      (`cash_shift_id IS NULL`) cuya factura pertenece al turno. Las dos ramas
  --      son disjuntas por construcción, así que el `OR` no cuenta una fila dos
  --      veces, y el `EXISTS` por la PK de `invoices` no recorre la tabla de
  --      facturas.
  SELECT count(*) INTO v_payments
    FROM public.payments p
   WHERE p.cash_shift_id = p_shift_id
     AND p.invoice_id IS NULL;

  SELECT count(*) INTO v_invoice_payments
    FROM public.invoice_payments ip
   WHERE ip.cash_shift_id = p_shift_id
      OR (ip.cash_shift_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM public.invoices i
             WHERE i.id = ip.invoice_id
               AND i.cash_shift_id = p_shift_id
          ));

  --      Tercera fuente: los pagos inmediatos de comisión del turno. TODAS las
  --      filas del turno restan del arqueo por su método (el servicio las agrupa
  --      con `paidOutByMethod` sin filtrar por método), así que el predicado es
  --      UNO solo y no lleva ninguna condición de más: es exactamente la lectura
  --      del servicio (`.eq("cash_shift_id", shift.id)`).
  SELECT count(*) INTO v_commission_payouts
    FROM public.commission_payouts cp
   WHERE cp.cash_shift_id = p_shift_id;

  --      Cuarta fuente: los vales del turno que el arqueo RESTA. El predicado es
  --      el de `isVoucherCashOut` (schemas.ts), transcrito UNA vez acá: aprobado
  --      (`approved_by` no nulo) Y con método (`method_code` no nulo). Un vale
  --      pendiente o rechazado no toca caja, y uno sin método es histórico
  --      (anterior a la 028) y tampoco afecta el arqueo; contarlos haría que una
  --      solicitud de vale nueva —que no cambia el número firmado— rechazara un
  --      cierre legítimo.
  SELECT count(*) INTO v_voucher_requests
    FROM public.voucher_requests vr
   WHERE vr.cash_shift_id = p_shift_id
     AND vr.approved_by IS NOT NULL
     AND vr.method_code IS NOT NULL;

  --      El RECHAZO. Si CUALQUIERA de los cuatro conteo difiere del que el
  --      llamador mandó, entre su lectura y este lock se confirmó un movimiento
  --      del turno: el arqueo que viaja en `p_close` ya no corresponde a sus
  --      cuatro entradas y la transacción NO ESCRIBE NADA. El arqueo NO se
  --      recalcula —eso sería sumar y restar dinero en SQL— ni se firma "como
  --      estaba": se rechaza, que es la única salida honesta cuando el llamador
  --      firmó un conjunto que cambió.
  --
  --      El código es el MISMO de 058 (`ARQUEO_STALE`) porque es el MISMO
  --      contrato: el servicio lo traduce a un rechazo accionable y el llamador
  --      reintenta con un arqueo fresco. No hace falta una red de conteo acá:
  --      esto no escribe nada, sólo lee cuatro veces y compara.
  IF v_payments <> (p_collection_counts ->> 'payments')::bigint
     OR v_invoice_payments <> (p_collection_counts ->> 'invoice_payments')::bigint
     OR v_commission_payouts <> (p_collection_counts ->> 'commission_payouts')::bigint
     OR v_voucher_requests <> (p_collection_counts ->> 'voucher_requests')::bigint
  THEN
    RAISE EXCEPTION 'ARQUEO_STALE';
  END IF;

  -- 1.3 El CIERRE del turno: el mismo `UPDATE` que hacía el servicio, con su
  --     compare-and-swap (`status = 'abierto'`) conservado en el propio `WHERE`
  --     —es lo que hace que dos cierres concurrentes no se pisen: el segundo
  --     escribe cero filas—, y cada monto ESCRITO VERBATIM desde `p_close`. Acá
  --     no se suma, no se resta y no se recalcula nada: el recogido, la base
  --     dejada y el sobre llegan resueltos por `resolveClosingBase` y
  --     `computeCashClose` (TypeScript).
  --
  --     La observación entra tal como llegó (el servicio ya la normalizó a NULL
  --     cuando venía vacía). El CHECK de 006
  --     (`expected_cash >= 0`) NO se replica acá a propósito: es la regla de
  --     negocio que el servicio traduce a CASH_OUT_EXCEEDS_COLLECTED, y este
  --     archivo no la reemplaza ni la adelanta.
  UPDATE public.cash_shifts s
     SET expected_cash = (p_close ->> 'expected_cash')::numeric,
         counted_cash = (p_close ->> 'counted_cash')::numeric,
         base_left = (p_close ->> 'base_left')::numeric,
         cash_withdrawn = (p_close ->> 'cash_withdrawn')::numeric,
         base_difference = (p_close ->> 'base_difference')::numeric,
         observation = p_close ->> 'observation',
         status = 'cerrado',
         closed_at = p_closed_at,
         closed_by = p_closed_by
   WHERE s.id = p_shift_id
     AND s.status = 'abierto'
  RETURNING * INTO v_turno;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UN turno
  --     actualizado. Cero filas es un turno que cambió bajo los pies (otro
  --     cierre ganó el CAS): la operación entera aborta —el arqueo incluido— y el
  --     llamador recibe el MISMO error de negocio que ya recibía cuando perdía
  --     el compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'SHIFT_ALREADY_CLOSED';
  END IF;

  -- 1.5 El ARQUEO DE CIERRE: las líneas por denominación, con la fase que le
  --     corresponde y cada monto escrito VERBATIM desde `p_counts`. Es la
  --     evidencia que hace real al cierre: sin ella, el turno firmaría un total
  --     que ningún detalle respalda.
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    p_shift_id,
    'cierre',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 1.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el cierre incluido. Es lo que separa "el
  --     cierre no se pudo firmar" de "el cierre quedó firmado sin su evidencia"
  --     —y este último, con el CAS, ya no se podría volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 1.7 El turno ESCRITO, tal como quedó en la tabla, con las mismas columnas
  --     que el servicio leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_turno.id,
    'cash_register_id', v_turno.cash_register_id,
    'sede_id', v_turno.sede_id,
    'opened_by', v_turno.opened_by,
    'closed_by', v_turno.closed_by,
    'opened_at', v_turno.opened_at,
    'closed_at', v_turno.closed_at,
    'opening_base', v_turno.opening_base,
    'expected_cash', v_turno.expected_cash,
    'counted_cash', v_turno.counted_cash,
    'base_left', v_turno.base_left,
    'cash_withdrawn', v_turno.cash_withdrawn,
    'base_difference', v_turno.base_difference,
    'status', v_turno.status,
    'observation', v_turno.observation
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `cash_shifts`, `cash_shift_counts`, `payments`,
-- `invoice_payments`, `invoices`, `commission_payouts` y `voucher_requests`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049/058).
ALTER FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cerrar el turno de un cajero firmando un arqueo
-- con los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb) IS
'CL-10/CL-19/CL-20: cierre ATÓMICA de un turno de caja (CAJ-03/CAJ-04) con PRECONDICIÓN sobre las CUATRO entradas del arqueo. Pisa el turno a cerrado con su compare-and-swap y escribe su conteo por denominación en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. CL-19 agregó p_collection_counts: los CONTEO de filas de las DOS fuentes que el arqueo SUMA (payments del turno sin factura e invoice_payments atribuidas al turno). CL-20 extiende el MISMO token con los CONTEO de las DOS fuentes que el arqueo RESTA (commission_payouts del turno y voucher_requests del turno aprobados y con método): una comisión pagada o la aprobación de un vale confirmadas entre la lectura del servicio y este lock ya no quedan fuera de un arqueo firmado. La transacción RE-CUENTA las cuatro fuentes bajo el lock y, si alguna difiere, RECHAZA con ARQUEO_STALE sin escribir nada. El token es OBLIGATORIO —las CUATRO claves se exigen por forma; su ausencia es SHIFT_INVALID, nunca "no compares"— y son CONTEO, no sumas: acá no se suma ni se resta un solo monto, porque mover aritmética de dinero a SQL está prohibido en este proyecto. NO calcula nada: los montos llegan resueltos por el servicio (expected_cash del arqueo, resolveClosingBase y computeCashClose) y cada línea del conteo llega validada por checkCounts; la función los escribe verbatim. Conserva el CAS sobre status = abierto (una carrera la rechaza con SHIFT_ALREADY_CLOSED en vez de reescribir un cierre confirmado), la precondición de conteo de efectivo y la restricción expected_cash >= 0 de 006, que el servicio sigue traduciendo a CASH_OUT_EXCEEDS_COLLECTED. Sus redes de conteo abortan con SHIFT_ALREADY_CLOSED si no actualizó exactamente un turno y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un cierre firmado sin su evidencia, y el reintento sigue siendo posible. Devuelve el turno escrito con las mismas columnas de SHIFT_SELECT. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.6 ----
-- cash_recount_shift_atomic (049)
--
-- Firma `(uuid, uuid, jsonb, jsonb)`: el turno, quién recontea, las DOS
-- versiones del cierre (la anterior congelada y la corregida) con su motivo, y
-- el conteo nuevo por denominación.
CREATE OR REPLACE FUNCTION public.cash_recount_shift_atomic(
  p_shift_id uuid,
  p_recounted_by uuid,
  p_recount jsonb,
  p_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_turno public.cash_shifts;
  v_reconteo public.cash_shift_recounts;
  v_esperados integer;
  v_escritos integer;
BEGIN
  -- 9.1 FORMA de la entrada. Un reconteo firma una versión CORREGIDA de un
  --     cierre ya firmado: no puede aceptar una entrada a medio formar.
  IF p_shift_id IS NULL
     OR p_recounted_by IS NULL
     OR p_recount IS NULL
     OR jsonb_typeof(p_recount) <> 'object'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  IF p_counts IS NULL
     OR jsonb_typeof(p_counts) <> 'array'
     OR jsonb_array_length(p_counts) = 0
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las DOS VERSIONES: los cuatro montos del cierre firmado (congelados) y
  --     los cuatro del reconteo, más el motivo. Las claves ausentes se rechazan
  --     por el mismo `coalesce` de las otras dos funciones. Las dos
  --     `*_base_difference` (un faltante de base) y los dos `*_cash_withdrawn`
  --     (una diferencia entre lo contado y la base dejada) admiten el signo: la
  --     tabla no les exige ser no negativos y el reconteo existe justamente para
  --     corregir un cierre, así que no puede rechazar la versión que va a
  --     corregir. `*_counted_cash` y `*_base_left` no lo admiten: el CHECK de
  --     006 los exige no negativos y su copia congelada también lo es.
  IF btrim(coalesce(p_recount ->> 'reason', '')) = ''
     OR coalesce(p_recount ->> 'previous_counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'previous_base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'counted_cash', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_left', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'cash_withdrawn', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_recount ->> 'base_difference', '') !~ '^-?[0-9]{1,9}([.][0-9]{1,2})?$'
  THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     Las LÍNEAS del conteo nuevo: la misma guarda de forma del cierre (ver
  --     5.1 de 049). El conteo del reconteo tiene que ser COMPLETO, como el del
  --     cierre: la transacción no acepta un arreglo vacío, así que el reconteo no
  --     puede quedar firmado sin el detalle que lo respalda.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    CROSS JOIN LATERAL (
      SELECT
        coalesce(item ->> 'method_code', '') AS method_code,
        coalesce(item ->> 'denomination', '') AS denomination_txt,
        coalesce(item ->> 'quantity', '') AS quantity_txt,
        coalesce(item ->> 'amount', '') AS amount_txt
    ) AS txt
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(txt.method_code) = ''
       OR txt.denomination_txt !~ '^([0-9]{1,9}([.][0-9]{1,2})?)?$'
       OR txt.quantity_txt !~ '^[0-9]{1,9}$'
       OR txt.amount_txt !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR CASE
            WHEN txt.quantity_txt ~ '^[0-9]{1,9}$'
              THEN (txt.quantity_txt)::integer <> 1 AND txt.denomination_txt = ''
            ELSE NULL
          END
       OR CASE
            WHEN txt.denomination_txt ~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
              THEN (txt.denomination_txt)::numeric <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  --     El conteo tiene que traer el EFECTIVO: un reconteo sin efectivo no es un
  --     reconteo de la caja (y el total declarado no tendría contra qué
  --     cuadrar). Es la parte estructural de la exigencia de conteo completo; la
  --     igualdad entre el total y su detalle la comprueba el servicio antes de
  --     llamar (ver "VENTANAS DECLARADAS" de 049).
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_counts) AS item
    WHERE item ->> 'method_code' = 'efectivo'
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 9.2 El TURNO, bloqueado, y su precondición de estado leída de LA FILA: sólo
  --     un turno CERRADO se recontá —un turno abierto no tiene cierre que
  --     corregir—.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'cerrado' THEN
    RAISE EXCEPTION 'SHIFT_NOT_CLOSED';
  END IF;

  -- 9.3 El reconteo "uno por turno" (033), re-evaluado adentro con el turno YA
  --     bloqueado. El índice único `uq_cash_shift_recounts_shift` sigue siendo la
  --     barrera final si dos reconteos llegaran a evaluar esto a la vez, y el
  --     `23505` que levanta lo traduce el servicio al MISMO error de negocio
  --     (ALREADY_RECOUNTED). Un reconteo no se encadena: la corrección también
  --     queda firmada.
  PERFORM 1
    FROM public.cash_shift_recounts r
   WHERE r.shift_id = p_shift_id
   ORDER BY r.id
   FOR UPDATE OF r;

  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_RECOUNTED';
  END IF;

  -- 9.4 El RECONTEO: UNA sentencia, y por eso UNA transacción con su detalle de
  --     abajo. Las DOS versiones entran VERBATIM desde `p_recount` —la anterior
  --     congelada y la corregida, con el motivo—, y `recounted_at` queda para su
  --     DEFAULT. Acá no se suma, no se resta y no se recalcula nada: la versión
  --     corregida llega resuelta por `resolveClosingBase` y `computeCashClose`
  --     dentro de `buildRecountRecord` (TypeScript).
  INSERT INTO public.cash_shift_recounts
    (shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn,
     previous_base_difference, counted_cash, base_left, cash_withdrawn,
     base_difference, reason, recounted_by)
  VALUES (
    p_shift_id,
    (p_recount ->> 'previous_counted_cash')::numeric,
    (p_recount ->> 'previous_base_left')::numeric,
    (p_recount ->> 'previous_cash_withdrawn')::numeric,
    (p_recount ->> 'previous_base_difference')::numeric,
    (p_recount ->> 'counted_cash')::numeric,
    (p_recount ->> 'base_left')::numeric,
    (p_recount ->> 'cash_withdrawn')::numeric,
    (p_recount ->> 'base_difference')::numeric,
    p_recount ->> 'reason',
    p_recounted_by
  )
  RETURNING * INTO v_reconteo;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'SHIFT_WRITE_MISMATCH';
  END IF;

  -- 9.5 El DETALLE por denominación, en la MISMA tabla del arqueo (009), en la
  --     fase `reconteo` (033). Es lo que hace que la versión corregida tenga
  --     tanta evidencia como el cierre que corrige: sin estas líneas, el
  --     reconteo firmaría dos versiones que ningún conteo respalda.
  SELECT jsonb_array_length(p_counts) INTO v_esperados;

  INSERT INTO public.cash_shift_counts
    (shift_id, phase, method_code, denomination, quantity, amount)
  SELECT
    p_shift_id,
    'reconteo',
    btrim(item ->> 'method_code'),
    CASE
      WHEN coalesce(item ->> 'denomination', '') = '' THEN NULL
      ELSE (item ->> 'denomination')::numeric
    END,
    (item ->> 'quantity')::integer,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_counts) AS item
  ORDER BY (item ->> 'method_code'), (item ->> 'denomination') NULLS FIRST;

  -- 9.6 La segunda red: si se escribieron menos líneas de las recibidas, se
  --     aborta y se revierte TODO, el reconteo incluido. Es lo que separa "el
  --     reconteo no se pudo firmar" de "el reconteo quedó firmado sin su
  --     detalle" —y este último, con el índice único de 033, ya no se podría
  --     volver a firmar.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'SHIFT_COUNT_MISMATCH';
  END IF;

  -- 9.7 El reconteo ESCRITO, tal como quedó en la tabla (con su `id` y su
  --     `recounted_at` del DEFAULT), con las mismas columnas que el servicio
  --     leía. Devolverlo evita una segunda lectura y su ventana.
  RETURN jsonb_build_object(
    'id', v_reconteo.id,
    'shift_id', v_reconteo.shift_id,
    'previous_counted_cash', v_reconteo.previous_counted_cash,
    'previous_base_left', v_reconteo.previous_base_left,
    'previous_cash_withdrawn', v_reconteo.previous_cash_withdrawn,
    'previous_base_difference', v_reconteo.previous_base_difference,
    'counted_cash', v_reconteo.counted_cash,
    'base_left', v_reconteo.base_left,
    'cash_withdrawn', v_reconteo.cash_withdrawn,
    'base_difference', v_reconteo.base_difference,
    'reason', v_reconteo.reason,
    'recounted_by', v_reconteo.recounted_by,
    'recounted_at', v_reconteo.recounted_at
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `cash_shifts`, `cash_shift_recounts` y
-- `cash_shift_counts`; con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018 (y el mismo paso que dan
-- 039 y 046–048).
ALTER FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría firmar un reconteo que corrige la caja por
-- PostgREST. El único llamador legítimo es el cliente service_role del
-- servidor.
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) IS
'CL-10: reconteo ATÓMICO de un cierre (U3, 033). Inserta la fila de cash_shift_recounts —las DOS versiones, el motivo y quién— y su detalle por denominación en cash_shift_counts (fase reconteo) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila del turno bloqueada primero para que el estado no pueda cambiar entre la lectura y la escritura. NO calcula nada: la versión anterior congelada y la corregida llegan resueltas por buildRecountRecord (resolveClosingBase + computeCashClose + signedAmounts) y se escriben verbatim; la aritmética del arqueo vive en TypeScript. Conserva las precondiciones del servicio: sólo un turno CERRADO (SHIFT_NOT_CLOSED) y el índice único por turno de 033 (23505 → ALREADY_RECOUNTED) adentro de la transacción; el conteo tiene que traer el efectivo y no puede venir vacío. NO toca cash_shifts: el cierre firmado sigue siendo inmutable. Sus redes de conteo abortan con SHIFT_WRITE_MISMATCH si no escribió exactamente un reconteo y con SHIFT_COUNT_MISMATCH si no escribió exactamente las líneas recibidas; en los dos casos la transacción se revierte COMPLETA: no queda un reconteo firmado sin su detalle. Devuelve el reconteo escrito con las mismas columnas de RECOUNT_SELECT. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.7 ----
-- invoice_annul_atomic (050)
--
-- Firma `(uuid, uuid, timestamptz, text, text, jsonb)`: la factura, el usuario
-- responsable, el instante del cierre, el motivo, el estado que el servicio leyó
-- (la mitad del compare-and-swap) y las reversiones de stock ya construidas.
CREATE OR REPLACE FUNCTION public.invoice_annul_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_motivo text,
  p_expected_status text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que anula una factura y devuelve stock
  --     no puede aceptar una entrada a medio formar: el precio de un rechazo
  --     claro acá es infinitamente menor que el de una anulación interpretada.
  --     El motivo no puede venir vacío —el CHECK de 005 lo exige para `Anulada`
  --     y el schema del servicio ya lo garantiza— y la precondición de estado
  --     tiene que venir: es la mitad del compare-and-swap. Qué estados son
  --     anulables es una regla de NEGOCIO del servicio (`canAnnulStatus`), no de
  --     acá: sólo se exige que venga.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_motivo IS NULL
     OR btrim(p_motivo) = ''
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
  THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  --     Cada reversión tiene que ser un objeto con un uuid bien formado (la
  --     MISMA forma que valida el CHECK de la 045 para la marca y que 046 valida
  --     para el producto), una cantidad de 1 a 9 dígitos y un motivo no vacío.
  --     El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item ->> 'qty'` es NULL y `NULL !~ 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce una entrada sin `qty` pasaría esta guarda. El `CASE`
  --     garantiza además que el cast a integer sólo se evalúe cuando el texto YA
  --     validó la forma (SQL no promete el orden de las condiciones del OR).
  --
  --     La cantidad PUEDE repetirse entre líneas —a diferencia de 046, que la
  --     rechaza—: la reversión escribe un movimiento por LÍNEA de factura y el
  --     kardex tiene que conservar esas dos filas (ver "EL STOCK DE LA
  --     REVERSIÓN" de 050). Lo que NO se permite es una línea a medio formar.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR btrim(coalesce(item ->> 'reason', '')) = ''
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 1.2 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047, 048, 049): a partir de
  --     acá, otra anulación —o un cobro, que también bloquea esta fila por el
  --     tope de 031— espera, y el estado no puede cambiar entre la lectura que
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     El estado leído por el servicio es la precondición: si otra anulación
  --     ganó la carrera, esta lectura ya ve `Anulada` y la transacción rechaza
  --     SIN escribir. Es el mismo código (ANNUL_CONFLICT) que el servicio
  --     devolvía cuando perdía el compare-and-swap.
  IF v_factura.status <> p_expected_status THEN
    RAISE EXCEPTION 'ANNUL_CONFLICT';
  END IF;

  -- 1.3 El grupo 1: la FACTURA a `Anulada`, con el compare-and-swap CONSERVADO
  --     en su propio `WHERE` —es lo que hace que dos anulaciones concurrentes no
  --     se pisen, y ahora además una red de conteo— y con el motivo y el cierre
  --     escritos VERBATIM desde la entrada. Acá no se recalcula nada.
  UPDATE public.invoices i
     SET status = 'Anulada',
         cancel_reason = p_motivo,
         closed_by = p_user_id,
         closed_at = p_closed_at
   WHERE i.id = p_invoice_id
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --     actualizada. Cero filas es un estado que cambió bajo los pies (otra
  --     anulación ganó el CAS entre la lectura bloqueada y el UPDATE, o la fila
  --     desapareció): la operación entera aborta —el stock incluido— y el
  --     llamador recibe el MISMO error de negocio que ya recibía cuando perdía
  --     el compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'ANNUL_CONFLICT';
  END IF;

  -- 1.5 El grupo 2: las REVERSIONES de stock, UNA sentencia, y por eso la misma
  --     transacción que la factura: o se escriben TODAS, o no se escribió nada.
  --     `type` es 'IN' y sólo 'IN': esta función es la reversión de una
  --     anulación, no un movimiento genérico. Cada fila lleva el motivo de SU
  --     línea —tal como lo computó `buildReversalReasons`— escrito verbatim: acá
  --     no se concatena texto.
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la anulación no tiene un
  --     intento de cliente, su puerta es el compare-and-swap de la FACTURA y su
  --     fila queda FUERA del índice único parcial de la 045 (ver "LA MARCA DE LA
  --     045 NO ENTRA ACÁ" de 050).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 050).
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    'IN',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(p_items) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.6 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --     movimientos que los pedidos, se aborta y se revierte TODO, la anulación
  --     incluida. El `JOIN` de arriba une por el id del producto, así que un
  --     producto inexistente escribiría menos filas en SILENCIO: esta guarda
  --     convierte ese subconjunto silencioso en un rechazo con rollback, y es
  --     exactamente lo que separa "la anulación no se pudo hacer" de "la factura
  --     quedó anulada sin su reversión". Es la misma red que 039, 046 y 049
  --     pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.7 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --     `INVOICE_SELECT`: eso es lo que el llamador usa como resultado, sin otra
  --     lectura y sin ventana.
  RETURN jsonb_build_object(
    'id', v_factura.id,
    'sede_id', v_factura.sede_id,
    'consecutive_number', v_factura.consecutive_number,
    'client_name', v_factura.client_name,
    'client_document', v_factura.client_document,
    'subtotal', v_factura.subtotal,
    'discount', v_factura.discount,
    'tax', v_factura.tax,
    'surcharge', v_factura.surcharge,
    'total', v_factura.total,
    'status', v_factura.status,
    'user_id', v_factura.user_id,
    'cash_shift_id', v_factura.cash_shift_id,
    'closed_by', v_factura.closed_by,
    'closed_at', v_factura.closed_at,
    'cancel_reason', v_factura.cancel_reason,
    'created_at', v_factura.created_at,
    'edit_version', v_factura.edit_version
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `products` e `inventory_movements`; con
-- search_path mutable un esquema anterior en la ruta podría secuestrar esos
-- nombres. House style desde 018 (y el mismo paso que dan 039 y 046–049).
ALTER FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría anular una factura —devolviendo su stock y
-- salteando el candado de nómina cerrada— por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb) IS
'CL-11: anulación ATÓMICA de una factura (FAC-04/FAC-06). Pisa la factura a Anulada —conservando el compare-and-swap sobre el estado leído— y escribe las reversiones IN de stock en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización del dinero de esa factura, también frente a un cobro) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el motivo, el estado esperado y cada reversión (producto, cantidad y motivo) llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004), que para un IN suma —la guarda de negatividad sólo actúa sobre los OUT, así que un IN no toma ese lock—. Sus redes de conteo abortan con ANNUL_CONFLICT si no actualizó exactamente la factura en el estado leído (una carrera se rechaza y no escribe nada) o con PRODUCT_NOT_FOUND si no escribió exactamente las reversiones pedidas; en los dos casos la transacción se revierte COMPLETA: no queda una factura anulada sin su reversión, y el reintento sigue siendo posible. El arreglo de reversiones puede venir VACÍO (una factura de servicios no mueve stock). Escribe idempotency_key NULL a propósito: la anulación no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe, y cada movimiento toma la del PRODUCTO. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.8 ----
-- invoice_edit_items_atomic (051)
--
-- Firma `(uuid, uuid, integer, text, jsonb)`: la factura, el usuario, la versión
-- y el estado que el servicio leyó (las dos mitades del candado de la 038) y el
-- reemplazo completo.
CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_items jsonb;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
  v_items_escritos integer := 0;
  v_movimientos integer;
BEGIN
  -- 1.1 FORMA de la entrada. Una función que REEMPLAZA los ítems de una factura
  --     y mueve su stock no puede aceptar una entrada a medio formar: el precio
  --     de un rechazo claro acá es infinitamente menor que el de una edición
  --     interpretada. La versión esperada tiene que venir y no puede ser negativa
  --     (el CHECK de la 038), y el estado esperado es la otra mitad del candado.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_edit IS NULL
     OR jsonb_typeof(p_edit) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Cada grupo tiene que venir como ARREGLO (una fila por request no existe
  --     acá) y una clave AUSENTE se trata como arreglo vacío: es el caso legal de
  --     "no hay nada de ese grupo" (una edición que sólo cambia el método de un
  --     cobro no borra ni inserta un solo ítem).
  IF jsonb_typeof(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_update', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'payments', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'movements', '[]'::jsonb)) <> 'array'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los ids a borrar, uno por uno: un uuid bien formado (la MISMA forma que
  --     valida el CHECK de la 045 para la marca y que 046/050 validan para el
  --     producto). El `coalesce` es la parte que importa: con la clave AUSENTE,
  --     `item #>> '{}'` es NULL y `NULL !~* 'regex'` es NULL —no TRUE—, así que
  --     sin el coalesce un elemento sin texto pasaría esta guarda.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Y las líneas de ítem: las MISMAS para las que se actualizan y las que se
  --     insertan, así que se validan en UNA sola pasada sobre los dos arreglos
  --     juntos (`||` de jsonb concatena). Cada línea tiene que ser un objeto con
  --     su origen (`item_type` de los tres del CHECK de 005), su empleado (FAC-02:
  --     obligatorio), una cantidad de 1 a 9 dígitos y mayor que cero, y los
  --     valores que la tabla puede guardar (dinero con dos decimales, `percent`
  --     hasta 100). El `CASE` garantiza que cada cast sólo se evalúe cuando el
  --     texto YA validó su forma (SQL no promete el orden de las condiciones del
  --     OR), y los campos OPCIONALES (`product_id`, `service_id`, `custom_name`,
  --     `commission_value`, `commission_percent_override`) se aceptan ausentes o
  --     nulos pero se validan si vienen con valor.
  v_items := coalesce(p_edit -> 'items_update', '[]'::jsonb)
             || coalesce(p_edit -> 'items_insert', '[]'::jsonb);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(jsonb_typeof(item -> 'no_commission'), '') <> 'boolean'
       OR (coalesce(item ->> 'product_id', '') <> ''
           AND coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'service_id', '') <> ''
           AND coalesce(item ->> 'service_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (item ->> 'commission_value' IS NOT NULL
           AND (item ->> 'commission_value') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item ->> 'commission_percent_override' IS NOT NULL
           AND (item ->> 'commission_percent_override') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Las que se ACTUALIZAN llevan además su id: es la única referencia con la
  --     que la función sabe a QUÉ fila de la factura aplica cada juego de
  --     columnas.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
    WHERE coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los cobros: la edición NO agrega ni quita porciones (sólo cambia el
  --     método), así que cada entrada trae el id de una porción que ya existe,
  --     su código de método (el snapshot que la tabla exige) y, opcionalmente, el
  --     id del catálogo.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Y los movimientos de stock: el producto, el TIPO (esta operación escribe
  --     el ajuste de una edición, que puede subir o bajar el stock: IN u OUT, y
  --     nada más), la cantidad y el motivo, que no puede venir vacío (es el texto
  --     del kardex, y un movimiento sin motivo no es auditable).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'type', '') NOT IN ('IN', 'OUT')
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR btrim(coalesce(item ->> 'reason', '')) = ''
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  -- 1.2 La FACTURA, bloqueada, y su precondición RELEÍDA DE LA FILA (no del dato
  --     que mandó el llamador). `FOR UPDATE` es el idioma de la casa para tomar
  --     un lock de fila (039, 040, 047, 048, 049, 050): a partir de acá otra
  --     edición —y también una anulación o un cobro, que toman el mismo lock—
  --     espera, y ni la versión ni el estado pueden cambiar entre la lectura que
  --     el servicio ya hizo y la escritura de abajo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     El candado de la 038 (CL-1): la versión Y el estado leídos por el
  --     servicio son la precondición. Si otra edición ya movió el token, o una
  --     anulación o un cobro dejaron la fila terminal, esta lectura ya lo ve y la
  --     transacción rechaza SIN escribir. Es el MISMO código (EDIT_CONFLICT) y el
  --     MISMO mensaje de negocio que el servicio devolvía cuando perdía el
  --     compare-and-swap en el cliente.
  IF v_factura.edit_version <> p_expected_version
     OR v_factura.status <> p_expected_status
  THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 1.3 El grupo 1: la FACTURA, con el token de la 038 CONSERVADO en su propio
  --     `WHERE` —es lo que hace que dos ediciones concurrentes no se pisen, ahora
  --     con el lock de arriba Y con la red de conteo de abajo— y sin una sola
  --     columna de dinero: esta función es la edición ADMIN, y su total es
  --     INMUTABLE. No hay `subtotal`, ni `discount`, ni `tax`, ni `surcharge`, ni
  --     `total` en la lista de columnas, y no es un olvido: es la política de esta
  --     edición, escrita como ausencia.
  UPDATE public.invoices i
     SET edit_version = p_expected_version + 1
   WHERE i.id = p_invoice_id
     AND i.edit_version = p_expected_version
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  -- 1.4 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --     actualizada. Cero filas es un estado —o una versión— que cambió bajo los
  --     pies: la edición entera aborta, ítems y stock incluidos, y el llamador
  --     recibe el MISMO error de negocio que ya recibía cuando perdía el
  --     compare-and-swap en el cliente.
  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 1.5 El grupo 2: los ítems que se QUITAN. Se borra por id Y por factura (el id
  --     solo no alcanza: la edición no toca la línea de otra factura), en UNA
  --     sentencia. La cuenta es contra los ids RECIBIDOS: el reemplazo tiene que
  --     quitar exactamente lo que el servicio leyó, y un id que no era de esta
  --     factura —o que ya no está— es un subconjunto silencioso, no un reemplazo.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_items d
   WHERE d.invoice_id = p_invoice_id
     AND d.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.6 El grupo 3: los ítems que CAMBIAN, en UNA sentencia multi-fila: cada
  --     juego de columnas sale del arreglo y se aplica a la fila de su id. Las
  --     columnas son las MISMAS que el servicio escribía —y las mismas que el
  --     INSERT de 1.7, columna por columna—, con el `subtotal` que el servicio
  --     computó, y `custom_name` se escribe VERBATIM (el recorte del texto lo hizo
  --     el servicio: acá no hay una sola función de texto).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_update', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_items d
     SET item_type = item ->> 'item_type',
         product_id = CASE
                        WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
                        ELSE (item ->> 'product_id')::uuid
                      END,
         service_id = CASE
                        WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
                        ELSE (item ->> 'service_id')::uuid
                      END,
         custom_name = item ->> 'custom_name',
         employee_id = (item ->> 'employee_id')::uuid,
         qty = (item ->> 'qty')::integer,
         unit_price = (item ->> 'unit_price')::numeric,
         discount = (item ->> 'discount')::numeric,
         no_commission = (item ->> 'no_commission')::boolean,
         commission_value = CASE
                              WHEN item ->> 'commission_value' IS NULL THEN NULL
                              ELSE (item ->> 'commission_value')::numeric
                            END,
         commission_mode = item ->> 'commission_mode',
         commission_percent_override = CASE
                              WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
                              ELSE (item ->> 'commission_percent_override')::numeric
                            END,
         subtotal = (item ->> 'subtotal')::numeric
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
   WHERE d.id = (item ->> 'id')::uuid
     AND d.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.7 El grupo 4: los ítems que se AGREGAN, también en UNA sentencia: la fila
  --     nace con el `invoice_id` de esta factura y con las MISMAS columnas que el
  --     UPDATE de 1.6. El `id` lo genera la PK de la tabla, como en el camino
  --     viejo (el servicio nunca mandaba un id para una línea nueva).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_insert', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    p_invoice_id,
    item ->> 'item_type',
    CASE
      WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
      ELSE (item ->> 'product_id')::uuid
    END,
    CASE
      WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
      ELSE (item ->> 'service_id')::uuid
    END,
    item ->> 'custom_name',
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    CASE
      WHEN item ->> 'commission_value' IS NULL THEN NULL
      ELSE (item ->> 'commission_value')::numeric
    END,
    item ->> 'commission_mode',
    CASE
      WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
      ELSE (item ->> 'commission_percent_override')::numeric
    END,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 1.8 El grupo 5: los COBROS. La edición no agrega ni quita porciones —el
  --     servicio ya rechaza ese caso (`VALIDATION`)— ni toca un monto: sólo pisa
  --     el método (su código y, si el método sigue activo, su id de catálogo). El
  --     `amount` y el `fee_amount` NO están en la lista: son el dinero cobrado y
  --     no se editan. En UNA sentencia, con la cuenta de siempre.
  SELECT jsonb_array_length(coalesce(p_edit -> 'payments', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_payments pay
     SET method_code = item ->> 'method_code',
         method_id = CASE
                       WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
                       ELSE (item ->> 'method_id')::uuid
                     END
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
   WHERE pay.id = (item ->> 'id')::uuid
     AND pay.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.9 El grupo 6: el AJUSTE DE STOCK, UNA sentencia y por eso la misma
  --     transacción que los ítems: o se escribe el ajuste COMPLETO, o no se
  --     escribió ningún ítem. Cada fila lleva su tipo (IN u OUT), su cantidad y su
  --     motivo, escrito verbatim desde el dato del servicio.
  --
  --     `idempotency_key` se escribe NULL a PROPÓSITO: la edición no tiene un
  --     intento de cliente y su fila queda FUERA del índice único parcial de la
  --     045 (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" de 051).
  --
  --     `ORDER BY p.id` es el orden en el que el trigger de aplicación del stock
  --     (004) toma sus locks de fila (ver "SERIALIZACIÓN" de 051), y el otro
  --     efecto —el orden de las filas del kardex dentro de una edición— está
  --     declarado en la cabecera de 051. El JOIN une por el id del producto: cada
  --     movimiento toma la sede de SU producto.
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  -- 1.10 Red de seguridad DENTRO de la transacción: si se escribieron MENOS
  --      movimientos que los pedidos, se aborta y se revierte TODO, los ítems y
  --      el token incluidos. El `JOIN` de arriba une por el id del producto, así
  --      que un producto inexistente escribiría menos filas en SILENCIO: esta
  --      guarda convierte ese subconjunto silencioso en un rechazo con rollback, y
  --      es lo que separa "la edición no se pudo hacer" de "la factura quedó
  --      editada sin su ajuste de stock". Es la misma red que 039, 046 y 050
  --      pusieron sobre sus INSERT.
  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 1.11 La factura ESCRITA, con las MISMAS columnas que el servicio leía con
  --      `INVOICE_SELECT`, y los conteos que el llamador contrasta: sin una
  --      segunda lectura y sin su ventana.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'sede_id', v_factura.sede_id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_payments`,
-- `products` e `inventory_movements`; con search_path mutable un esquema
-- anterior en la ruta podría secuestrar esos nombres. House style desde 018 (y
-- el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems de una factura emitida
-- —y con ellos las comisiones de la nómina— y mover su stock por PostgREST. El
-- único llamador legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) IS
'CL-12: edición ADMIN de factura ATÓMICA, con el total INMUTABLE. Reemplaza los ítems (borra los que se quitaron, actualiza los que cambian, inserta los nuevos), pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (es el punto de serialización de la edición de la 038 y también el del dinero de esa factura: la anulación y el cobro de la 050 toman el MISMO lock) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: el diff de ítems (con el subtotal de cada línea), el delta de stock, su tipo y el motivo del kardex llegan computados por el servicio y se escriben verbatim; el stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y la aritmética de dinero no aparece en esta función —no tiene una sola sentencia que escriba subtotal, discount, tax, surcharge ni total: la inmutabilidad del total de esta edición es ESTRUCTURAL, no una promesa del llamador—. MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila, y su mensaje de negocio es el mismo que devolvía el compare-and-swap del cliente. Sus redes de conteo abortan con EDIT_CONFLICT (la fila ya no está en la versión o el estado leídos), ITEM_MISMATCH (no borró, actualizó o insertó exactamente los ítems recibidos), PAYMENT_MISMATCH (no pisó exactamente los cobros recibidos) o PRODUCT_NOT_FOUND (no escribió exactamente los movimientos pedidos); en todos los casos la transacción se revierte COMPLETA: no queda una edición a medias con el token avanzado, y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- ---------------------------------------------------------------- 2.9 ----
-- invoice_edit_emitted_atomic (051)
--
-- Firma `(uuid, uuid, integer, text, jsonb)`: la misma que la edición ADMIN más
-- los tres grupos de esta edición (`taxes_remove`, `taxes` y `totals`).
CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_items jsonb;
  v_esperados integer;
  v_escritos integer;
  v_actualizados integer;
  v_items_escritos integer := 0;
  v_movimientos integer;
BEGIN
  -- 5.1 FORMA de la entrada: lo mismo que la admin, más los tres grupos de esta
  --     edición. `totals` tiene que ser un OBJETO (los cinco números juntos: un
  --     total suelto no es un juego de totales) y los tres números de dinero con
  --     la forma que la tabla puede guardar.
  IF p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_expected_status IS NULL
     OR btrim(p_expected_status) = ''
     OR p_edit IS NULL
     OR jsonb_typeof(p_edit) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF jsonb_typeof(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_update', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'payments', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'movements', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'taxes', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_edit -> 'totals', 'null'::jsonb)) <> 'object'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Los cinco números de la factura: subtotal, descuento, impuestos,
  --     recargo y total, todos escritos por el servicio y todos con la forma de
  --     una columna de dinero (dos decimales como máximo). Acá NO se comprueba la
  --     identidad `total = subtotal − discount + tax + surcharge`: esa es la
  --     aritmética de dinero del servicio, y su guarda es el CHECK de la tabla
  --     (005/019), que la comprueba sobre el número ya escrito.
  IF coalesce(p_edit -> 'totals' ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'tax', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'surcharge', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_edit -> 'totals' ->> 'total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) AS rid
    WHERE coalesce(rid #>> '{}', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  --     Las filas del snapshot NUEVO de impuestos: el snapshot inmutable de la
  --     FAC-03, con su código, su nombre, su porcentaje (0 a 100) y su monto ya
  --     calculado. La función no calcula el monto: lo escribe.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'taxes', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'tax_code', '')) = ''
       OR btrim(coalesce(item ->> 'tax_name', '')) = ''
       OR coalesce(item ->> 'percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR CASE
            WHEN coalesce(item ->> 'percent', '') ~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
              THEN (item ->> 'percent')::numeric > 100
            ELSE NULL
          END
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  v_items := coalesce(p_edit -> 'items_update', '[]'::jsonb)
             || coalesce(p_edit -> 'items_insert', '[]'::jsonb);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(jsonb_typeof(item -> 'no_commission'), '') <> 'boolean'
       OR (coalesce(item ->> 'product_id', '') <> ''
           AND coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'service_id', '') <> ''
           AND coalesce(item ->> 'service_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (item ->> 'commission_value' IS NOT NULL
           AND (item ->> 'commission_value') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$')
       OR (item ->> 'commission_percent_override' IS NOT NULL
           AND (item ->> 'commission_percent_override') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
    WHERE coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'type', '') NOT IN ('IN', 'OUT')
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR btrim(coalesce(item ->> 'reason', '')) = ''
  ) THEN
    RAISE EXCEPTION 'EDIT_INVALID';
  END IF;

  -- 5.2 La FACTURA, bloqueada, y su precondición RELEÍDA DE LA FILA: el MISMO
  --     candado de la 038 (versión + estado) que la edición admin, por el MISMO
  --     motivo y con el MISMO código de rechazo.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  IF v_factura.edit_version <> p_expected_version
     OR v_factura.status <> p_expected_status
  THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 5.3 El grupo 1: la FACTURA, con el token Y los totales en UNA sentencia. Los
  --     cinco números llegan computados (`computeInvoiceTotals` + `round2` en
  --     TypeScript) y se escriben VERBATIM: acá no se suma un impuesto, no se
  --     aplica un descuento y no se recalcula el recargo EMITIDO que el servicio
  --     conserva. El `WHERE` conserva el candado de la 038 y su red de conteo.
  UPDATE public.invoices i
     SET edit_version = p_expected_version + 1,
         subtotal = (p_edit -> 'totals' ->> 'subtotal')::numeric,
         discount = (p_edit -> 'totals' ->> 'discount')::numeric,
         tax = (p_edit -> 'totals' ->> 'tax')::numeric,
         surcharge = (p_edit -> 'totals' ->> 'surcharge')::numeric,
         total = (p_edit -> 'totals' ->> 'total')::numeric
   WHERE i.id = p_invoice_id
     AND i.edit_version = p_expected_version
     AND i.status = p_expected_status
  RETURNING * INTO v_factura;

  GET DIAGNOSTICS v_actualizados = ROW_COUNT;

  IF v_actualizados <> 1 THEN
    RAISE EXCEPTION 'EDIT_CONFLICT';
  END IF;

  -- 5.4 El grupo 2: se QUITA el snapshot de impuestos que el servicio LEYÓ, por
  --     id y por factura, en UNA sentencia y con su cuenta. Es la PRIMERA mitad
  --     del reemplazo del snapshot: la segunda (5.5) inserta el nuevo. Si la
  --     segunda falla, esta se revierte con ella —la colección ANTERIOR queda
  --     entera—, que es lo que significa todo-o-nada en un reemplazo.
  SELECT jsonb_array_length(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_taxes t
   WHERE t.invoice_id = p_invoice_id
     AND t.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'taxes_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 5.5 El grupo 3: el snapshot NUEVO, en UNA sentencia, con el monto ya
  --     computado y el porcentaje y el nombre que el servicio tomó de los
  --     impuestos ACTIVOS de la sede (FAC-03: el snapshot es inmutable y no sigue
  --     al catálogo). Se corre SIEMPRE, aunque el arreglo venga vacío: así el
  --     grupo tiene una red de conteo uniforme (0 = 0) y no hay dos caminos.
  SELECT jsonb_array_length(coalesce(p_edit -> 'taxes', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    p_invoice_id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'taxes', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 5.6 El grupo 4: los ítems que se QUITAN (las MISMAS tres sentencias de la
  --     edición admin, con las mismas columnas y las mismas cuentas).
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_remove', '[]'::jsonb))
    INTO v_esperados;

  DELETE FROM public.invoice_items d
   WHERE d.invoice_id = p_invoice_id
     AND d.id IN (
       SELECT (rid #>> '{}')::uuid
       FROM jsonb_array_elements(coalesce(p_edit -> 'items_remove', '[]'::jsonb)) AS rid
     );

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.7 El grupo 5: los ítems que CAMBIAN.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_update', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_items d
     SET item_type = item ->> 'item_type',
         product_id = CASE
                        WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
                        ELSE (item ->> 'product_id')::uuid
                      END,
         service_id = CASE
                        WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
                        ELSE (item ->> 'service_id')::uuid
                      END,
         custom_name = item ->> 'custom_name',
         employee_id = (item ->> 'employee_id')::uuid,
         qty = (item ->> 'qty')::integer,
         unit_price = (item ->> 'unit_price')::numeric,
         discount = (item ->> 'discount')::numeric,
         no_commission = (item ->> 'no_commission')::boolean,
         commission_value = CASE
                              WHEN item ->> 'commission_value' IS NULL THEN NULL
                              ELSE (item ->> 'commission_value')::numeric
                            END,
         commission_mode = item ->> 'commission_mode',
         commission_percent_override = CASE
                              WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
                              ELSE (item ->> 'commission_percent_override')::numeric
                            END,
         subtotal = (item ->> 'subtotal')::numeric
    FROM jsonb_array_elements(coalesce(p_edit -> 'items_update', '[]'::jsonb)) AS item
   WHERE d.id = (item ->> 'id')::uuid
     AND d.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.8 El grupo 6: los ítems que se AGREGAN. Las MISMAS columnas que el UPDATE
  --     de 5.7, columna por columna.
  SELECT jsonb_array_length(coalesce(p_edit -> 'items_insert', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    p_invoice_id,
    item ->> 'item_type',
    CASE
      WHEN coalesce(item ->> 'product_id', '') = '' THEN NULL
      ELSE (item ->> 'product_id')::uuid
    END,
    CASE
      WHEN coalesce(item ->> 'service_id', '') = '' THEN NULL
      ELSE (item ->> 'service_id')::uuid
    END,
    item ->> 'custom_name',
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    CASE
      WHEN item ->> 'commission_value' IS NULL THEN NULL
      ELSE (item ->> 'commission_value')::numeric
    END,
    item ->> 'commission_mode',
    CASE
      WHEN item ->> 'commission_percent_override' IS NULL THEN NULL
      ELSE (item ->> 'commission_percent_override')::numeric
    END,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(coalesce(p_edit -> 'items_insert', '[]'::jsonb)) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  v_items_escritos := v_items_escritos + v_escritos;

  -- 5.9 El grupo 7: los COBROS (el método, nunca el monto).
  SELECT jsonb_array_length(coalesce(p_edit -> 'payments', '[]'::jsonb))
    INTO v_esperados;

  UPDATE public.invoice_payments pay
     SET method_code = item ->> 'method_code',
         method_id = CASE
                       WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
                       ELSE (item ->> 'method_id')::uuid
                     END
    FROM jsonb_array_elements(coalesce(p_edit -> 'payments', '[]'::jsonb)) AS item
   WHERE pay.id = (item ->> 'id')::uuid
     AND pay.invoice_id = p_invoice_id;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 5.10 El grupo 8: el ajuste de STOCK, idéntico al de la edición admin (una
  --      sentencia, `ORDER BY p.id`, la marca en NULL y la red de conteo).
  SELECT jsonb_array_length(coalesce(p_edit -> 'movements', '[]'::jsonb))
    INTO v_esperados;

  INSERT INTO public.inventory_movements
    (sede_id, product_id, type, qty, reason, user_id, idempotency_key)
  SELECT
    p.sede_id,
    p.id,
    item ->> 'type',
    (item ->> 'qty')::integer,
    item ->> 'reason',
    p_user_id,
    NULL
  FROM jsonb_array_elements(coalesce(p_edit -> 'movements', '[]'::jsonb)) AS item
  JOIN public.products p
    ON p.id = (item ->> 'product_id')::uuid
  ORDER BY p.id;

  GET DIAGNOSTICS v_movimientos = ROW_COUNT;

  IF v_movimientos <> v_esperados THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  -- 5.11 La factura ESCRITA (con sus totales nuevos) y los conteos.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'sede_id', v_factura.sede_id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'items', v_items_escritos,
    'movements', v_movimientos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres. House
-- style desde 018 (y el mismo paso que dan 039 y 046–050).
ALTER FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría reescribir los ítems, los TOTALES y los impuestos
-- de una factura emitida —salteando el estado terminal, el candado de nómina y
-- las comisiones— por PostgREST. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) IS
'CL-12: edición LIBRE de una factura emitida, ATÓMICA, con el total RECALCULADO. Reemplaza los ítems, REEMPLAZA el snapshot de impuestos (borra el que el servicio leyó e inserta el que computó), reescribe los cinco números de la factura, pisa el método de cada cobro y escribe el ajuste de stock por delta NETO por producto, todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con la fila de la factura bloqueada primero (el punto de serialización de la edición de la 038 y el del dinero de esa factura, el MISMO lock que toman la anulación y el cobro de la 050) y los movimientos en orden determinista por producto (el orden en que el trigger de 004 toma sus locks). NO calcula nada: los totales y el snapshot llegan computados por computeInvoiceTotals/snapshotInvoiceTaxes, el diff de ítems con su subtotal por computeLineSubtotal, y el delta de stock con su tipo y su motivo, todos en TypeScript y escritos verbatim; acá no hay una sola suma, resta, multiplicación ni redondeo, ni una operación sobre las columnas de dinero (escribir es convertir la representación). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004). MUEVE EL CANDADO DE LA 038 ADENTRO: el token edit_version se escribe con (versión, estado) como precondición en su propio WHERE, sobre la fila bloqueada, así que una edición concurrente ESPERA y se RECHAZA con EDIT_CONFLICT (409) sin escribir una sola fila. El REEMPLAZO del snapshot de impuestos es todo-o-nada: si el INSERT del snapshot nuevo falla, el DELETE del viejo se revierte con la transacción entera y la factura conserva su snapshot ANTERIOR completo (el estado intermedio —sin impuestos— no es ninguna de las dos colecciones). Sus redes de conteo abortan con EDIT_CONFLICT (versión o estado movidos), TAX_MISMATCH (no borró o insertó exactamente el snapshot recibido), ITEM_MISMATCH, PAYMENT_MISMATCH o PRODUCT_NOT_FOUND; en todos los casos la transacción se revierte COMPLETA y el reintento sigue siendo posible. Los arreglos vacíos son legales (0 = 0). Escribe idempotency_key NULL a propósito: la edición no tiene intento de cliente y queda fuera del índice parcial de la 045. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y cuántos ítems y movimientos escribió. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 2.10 ----
-- invoice_create_atomic (060, que a su vez trae 052)
--
-- Firma `(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb)`: quién
-- emite, el turno de caja abierto (la precondición que se recomprueba adentro),
-- la MARCA del intento (041, obligatoria), y los cinco grupos como DATOS: la
-- factura (sus montos, su estado y su cierre), las líneas, el snapshot de
-- impuestos, las porciones y el plan de stock; más la PLANTILLA del motivo del
-- OUT.
--
-- La sede sale del TURNO que la función bloquea en 1.7 —de la misma fila que
-- antes tenía que coincidir con la que mandaba el llamador— y de ahí va a la
-- factura, al consecutivo y a la deducción.
CREATE OR REPLACE FUNCTION public.invoice_create_atomic(
  p_user_id uuid,
  p_cash_shift_id uuid,
  p_idempotency_key text,
  p_invoice jsonb,
  p_items jsonb,
  p_taxes jsonb,
  p_payments jsonb,
  p_out_reason text,
  p_out_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_consecutivo integer;
  v_turno_estado text;
  v_sede uuid;
  v_motivo text;
  v_esperados integer;
  v_escritos integer;
  v_aplicados integer;
  v_factura public.invoices;
BEGIN
  -- 1.1 FORMA de los escalares. Una función que emite una factura —y descuenta
  --     stock— no puede aceptar una entrada a medio formar: el precio de un
  --     rechazo claro acá es infinitamente menor que el de una emisión
  --     interpretada. La marca tiene que tener la MISMA forma que exige el CHECK
  --     de 041 (el `coalesce` es la parte que importa: con la clave AUSENTE el
  --     `!~` compara contra NULL —no TRUE— y sin el coalesce una marca vacía
  --     pasaría esta guarda).
  IF p_user_id IS NULL
     OR p_cash_shift_id IS NULL
     OR p_idempotency_key IS NULL
     OR p_idempotency_key
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_invoice IS NULL
     OR jsonb_typeof(p_invoice) <> 'object'
     OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR p_taxes IS NULL
     OR jsonb_typeof(p_taxes) <> 'array'
     OR p_payments IS NULL
     OR jsonb_typeof(p_payments) <> 'array'
     OR p_out_items IS NULL
     OR jsonb_typeof(p_out_items) <> 'array'
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.2 FORMA de la FACTURA: los cinco montos (los computa
  --     `computeInvoiceTotals`), el estado y la coherencia del cierre. Los montos
  --     viajan como TEXTOS de números y el `::numeric` de abajo es una conversión
  --     de representación: acá sólo se COMPRUEBA la forma (hasta 9 dígitos y 2
  --     decimales, la misma forma que 050 y 051 aceptan), nunca el valor.
  IF coalesce(p_invoice ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'tax', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'surcharge', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'total', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_invoice ->> 'status', '') NOT IN ('Emitida', 'Pagada')
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  --     El CIERRE va con el estado y sólo con él: una factura `Pagada` nace
  --     cerrada (con su responsable y el instante que resolvió el servicio) y una
  --     `Emitida` no lleva cierre. La función no decide ninguna de las dos cosas;
  --     comprueba que el dato sea coherente para que una emisión a medio armar no
  --     entre a la base con un estado que la contradice.
  IF (
       p_invoice ->> 'status' = 'Pagada'
       AND (
         p_invoice ->> 'closed_at' IS NULL
         OR p_invoice ->> 'closed_by' IS NULL
         OR p_invoice ->> 'closed_by'
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
     )
     OR (
       p_invoice ->> 'status' = 'Emitida'
       AND (p_invoice ->> 'closed_at' IS NOT NULL OR p_invoice ->> 'closed_by' IS NOT NULL)
     )
  THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.3 FORMA de cada LÍNEA. `product_id`, `service_id`, `custom_name`,
  --     `commission_value` y `commission_percent_override` pueden venir
  --     AUSENTES o en null (una línea de servicio no lleva producto, una línea
  --     sin comisión no lleva valor), así que su comprobación es "vacío o con
  --     forma". El `CASE` garantiza que el cast a integer sólo se evalúe cuando
  --     el texto YA validó la forma (SQL no promete el orden de las condiciones
  --     del OR), y `no_commission` se comprueba contra los dos textos del
  --     booleano antes de castearlo.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'item_type', '') NOT IN ('producto', 'servicio', 'custom')
       OR coalesce(item ->> 'employee_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (
         coalesce(item ->> 'product_id', '') <> ''
         AND coalesce(item ->> 'product_id', '')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       OR (
         coalesce(item ->> 'service_id', '') <> ''
         AND coalesce(item ->> 'service_id', '')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
       OR coalesce(item ->> 'unit_price', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'discount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'subtotal', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'no_commission', '') NOT IN ('true', 'false')
       OR coalesce(item ->> 'commission_mode', '') NOT IN ('comision', 'porcentaje', 'ninguna')
       OR (
         coalesce(item ->> 'commission_value', '') <> ''
         AND coalesce(item ->> 'commission_value', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       )
       OR (
         coalesce(item ->> 'commission_percent_override', '') <> ''
         AND coalesce(item ->> 'commission_percent_override', '')
               !~ '^([0-9]{1,2}|100)([.][0-9]{1,2})?$'
       )
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.4 FORMA del SNAPSHOT DE IMPUESTOS. El monto lo computa
  --     `snapshotInvoiceTaxes`; acá sólo se comprueba que venga con forma y que
  --     el nombre y el código no estén vacíos (viajan a `invoice_taxes`, que los
  --     exige NOT NULL).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_taxes) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'tax_code', '')) = ''
       OR btrim(coalesce(item ->> 'tax_name', '')) = ''
       OR coalesce(item ->> 'percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.5 FORMA de las PORCIONES. El bruto y el recargo los computa
  --     `computeCardFees`; el `method_id` puede venir AUSENTE o en null (el
  --     catálogo no siempre tiene id: 005 lo permite) pero su método es
  --     obligatorio.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_payments) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR (
         coalesce(item ->> 'method_id', '') <> ''
         AND coalesce(item ->> 'method_id', '')
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  -- 1.6 FORMA del PLAN DE STOCK. La agregación por producto y la guarda de
  --     negocio las hizo `planStockDeduction` (TypeScript); acá sólo se comprueba
  --     la forma —un producto por fila, con cantidad positiva— porque la guarda
  --     completa (producto repetido, existencia) la hace `deduct_stock_atomic`
  --     (046) con su propio SQLSTATE.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_out_items) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR coalesce(item ->> 'product_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(item ->> 'qty', '') !~ '^[0-9]{1,9}$'
       OR CASE
            WHEN coalesce(item ->> 'qty', '') ~ '^[0-9]{1,9}$'
              THEN (item ->> 'qty')::integer <= 0
            ELSE NULL
          END
  ) THEN
    RAISE EXCEPTION 'INVOICE_INVALID';
  END IF;

  --     Y la PLANTILLA del motivo: si hay productos que descontar, tiene que
  --     venir y tiene que traer el token. Se comprueba ACÁ —antes de cualquier
  --     escritura— para que una plantilla mal armada rechace barato.
  IF jsonb_array_length(p_out_items) > 0
     AND (p_out_reason IS NULL OR strpos(p_out_reason, '{consecutivo}') = 0)
  THEN
    RAISE EXCEPTION 'OUT_REASON_INVALID';
  END IF;

  -- 1.7 LA PRECONDICIÓN DEL TURNO, sobre la fila BLOQUEADA. `FOR UPDATE` es el
  --     idioma de la casa para tomar un lock de fila (039, 040, 047, 048, 049):
  --     a partir de acá, un cierre de caja espera, y el turno no puede cerrarse
  --     entre la lectura que el servicio ya hizo y la escritura de la factura. La
  --     sede que se lee AQUÍ es la del turno bloqueado: es la fila que emite y es
  --     la sede de la instalación, así que la factura, el consecutivo y el stock
  --     salen de ella sin que nadie la mande. El estado se relee de la FILA (no
  --     del dato que mandó el llamador).
  SELECT s.status, s.sede_id
    INTO v_turno_estado, v_sede
  FROM public.cash_shifts s
  WHERE s.id = p_cash_shift_id
  FOR UPDATE OF s;

  IF NOT FOUND OR v_turno_estado <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_NOT_OPEN';
  END IF;

  -- 1.8 EL CONSECUTIVO, reservado ADENTRO: es la decisión central de este
  --     archivo. La autoridad es la de siempre (`next_invoice_number`, 005:
  --     bloquea la fila de `invoice_sequences` e incrementa `last_number`), pero
  --     ahora el incremento pertenece a ESTA transacción: si algo falla de acá en
  --     adelante, se revierte con ella y el número NO queda quemado. El costo
  --     está declarado en la cabecera de 052 (el lock se sostiene hasta el commit).
  --     La sede que recibe es la del turno bloqueado.
  v_consecutivo := public.next_invoice_number(v_sede);

  --     Y el motivo del OUT: la plantilla trae el token UNA vez y acá se
  --     sustituye la PRIMERA ocurrencia —`overlay` desde `strpos`, no `replace`
  --     (que sustituiría todas y un nombre de cliente podría contener el
  --     token)— por el número que esta misma transacción acaba de reservar.
  IF jsonb_array_length(p_out_items) > 0 THEN
    v_motivo := overlay(
      p_out_reason
      placing v_consecutivo::text
      from strpos(p_out_reason, '{consecutivo}')
      for length('{consecutivo}')
    );
  END IF;

  -- 1.9 GRUPO 1: la FACTURA, con el consecutivo reservado y la marca del
  --     intento escritos VERBATIM. Nada se recalcula: cada monto llega computado
  --     y se escribe con su conversión de representación. La marca queda EN LA
  --     FILA: su índice único parcial (041) es la barrera final de la
  --     idempotencia, y acá se evalúa dentro de la MISMA transacción.
  INSERT INTO public.invoices
    (sede_id, consecutive_number, idempotency_key, client_name, client_document,
     subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id,
     closed_by, closed_at)
  VALUES
    (v_sede,
     v_consecutivo,
     p_idempotency_key,
     p_invoice ->> 'client_name',
     p_invoice ->> 'client_document',
     (p_invoice ->> 'subtotal')::numeric,
     (p_invoice ->> 'discount')::numeric,
     (p_invoice ->> 'tax')::numeric,
     (p_invoice ->> 'surcharge')::numeric,
     (p_invoice ->> 'total')::numeric,
     p_invoice ->> 'status',
     p_user_id,
     p_cash_shift_id,
     (p_invoice ->> 'closed_by')::uuid,
     (p_invoice ->> 'closed_at')::timestamptz)
  RETURNING * INTO v_factura;

  -- 1.10 Red de seguridad DENTRO de la transacción: exactamente UNA factura
  --      escrita. Cero filas es una emisión que no se aplicó: la transacción
  --      entera aborta —con la reserva del consecutivo— y el llamador recibe un
  --      fallo real en vez de una factura que no está. El 23505 de los dos
  --      índices únicos no llega hasta acá (la sentencia falla antes), y lo
  --      traduce el servicio (ver "EL 23505" de 052).
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'INVOICE_MISMATCH';
  END IF;

  -- 1.11 GRUPO 2: las LÍNEAS, UNA sentencia para todas. Una línea por elemento
  --      de `p_items`, con su subtotal y sus campos de comisión escritos
  --      VERBATIM: el `::integer`, el `::numeric`, el `::boolean` y el `::uuid`
  --      son conversiones de representación (jsonb → la columna), no
  --      operaciones. `nullif(… , '')` convierte la clave ausente en NULL, que es
  --      lo que el servicio mandaba para una línea sin producto/servicio/valor.
  --
  -- 1.12 Red de seguridad: tantas líneas como elementos llegaron. Sin esta red,
  --      un subconjunto silencioso dejaría una factura con su total completo y
  --      sin todas sus líneas (y la nómina pagando comisiones de menos). El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_items) INTO v_esperados;

  INSERT INTO public.invoice_items
    (invoice_id, item_type, product_id, service_id, custom_name, employee_id,
     qty, unit_price, discount, no_commission, commission_value,
     commission_mode, commission_percent_override, subtotal)
  SELECT
    v_factura.id,
    item ->> 'item_type',
    nullif(item ->> 'product_id', '')::uuid,
    nullif(item ->> 'service_id', '')::uuid,
    nullif(item ->> 'custom_name', ''),
    (item ->> 'employee_id')::uuid,
    (item ->> 'qty')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'discount')::numeric,
    (item ->> 'no_commission')::boolean,
    nullif(item ->> 'commission_value', '')::numeric,
    item ->> 'commission_mode',
    nullif(item ->> 'commission_percent_override', '')::numeric,
    (item ->> 'subtotal')::numeric
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'ITEM_MISMATCH';
  END IF;

  -- 1.13 GRUPO 3: el SNAPSHOT DE IMPUESTOS, UNA sentencia (y ninguna fila
  --      cuando no hay impuestos activos: `0 = 0` es legal). El monto y el
  --      porcentaje vienen computados.
  --
  -- 1.14 Red de seguridad: tantos impuestos como llegaron. El conteo va ANTES
  --      del INSERT: un `SELECT ... INTO` posterior pisaría el `ROW_COUNT` que
  --      mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_taxes) INTO v_esperados;

  INSERT INTO public.invoice_taxes
    (invoice_id, tax_code, tax_name, percent, amount)
  SELECT
    v_factura.id,
    item ->> 'tax_code',
    item ->> 'tax_name',
    (item ->> 'percent')::numeric,
    (item ->> 'amount')::numeric
  FROM jsonb_array_elements(p_taxes) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'TAX_MISMATCH';
  END IF;

  -- 1.15 GRUPO 4: las PORCIONES, UNA sentencia (y ninguna fila para una factura
  --      sin cobro: `0 = 0` es legal). El bruto, el porcentaje y el monto del
  --      recargo vienen computados por `computeCardFees`; `cash_shift_id` es el
  --      MISMO en todas y por eso viaja como escalar en la firma: la función
  --      escribe el valor en cada fila, sin decidir nada.
  --
  --      El ORDEN de las porciones se conserva (no hay `ORDER BY`, a
  --      propósito): pertenecen a una transacción que ya tiene el lock de su
  --      turno y de su factura, y nadie puede verlas antes del commit.
  --
  -- 1.16 Red de seguridad: tantas porciones como llegaron. El tope de cobro de
  --      031 (`trg_invoice_payments_cap`) corre dentro de esta sentencia con su
  --      propio P0001, y el servicio lo traduce a OVERPAID como siempre. El
  --      conteo va ANTES del INSERT: un `SELECT ... INTO` posterior pisaría el
  --      `ROW_COUNT` que mide el `GET DIAGNOSTICS` de abajo.
  -- fix-060: esperados ANTES del INSERT
  SELECT jsonb_array_length(p_payments) INTO v_esperados;

  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id)
  SELECT
    v_factura.id,
    nullif(item ->> 'method_id', '')::uuid,
    item ->> 'method_code',
    (item ->> 'amount')::numeric,
    (item ->> 'fee_percent')::numeric,
    (item ->> 'fee_amount')::numeric,
    p_cash_shift_id
  FROM jsonb_array_elements(p_payments) AS item;

  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.17 GRUPO 5: el OUT de STOCK, en la MISMA transacción que las filas. La
  --      escritura la hace `deduct_stock_atomic` (046), que es la autoridad de la
  --      deducción: un movimiento por producto, con su motivo, SIN marca de
  --      intento (la emisión no tiene intento por producto: su puerta es la marca
  --      de la FACTURA), con sus propias guardas y sus propias redes, y con el
  --      orden de locks que fija (`ORDER BY p.id`, el orden del trigger de 004).
  --      El grupo vacío es legal y no se llama: una venta de servicios no toca el
  --      stock (y 046 rechaza el arreglo vacío a propósito, porque una deducción
  --      sin ítems no es una deducción).
  SELECT jsonb_array_length(p_out_items) INTO v_esperados;

  IF v_esperados > 0 THEN
    v_aplicados := public.deduct_stock_atomic(v_sede, p_user_id, v_motivo, p_out_items);

    --     Red de seguridad sobre la RESPUESTA: la función ya revierte si
    --     escribió menos de lo pedido, así que un conteo distinto sólo puede
    --     venir de una respuesta incoherente. Se reporta como fallo real en vez
    --     de dar por aplicado un descuento que la base no hizo.
    IF v_aplicados <> v_esperados THEN
      RAISE EXCEPTION 'MOVEMENT_MISMATCH';
    END IF;
  END IF;

  -- 1.18 La FACTURA ESCRITA, con las MISMAS columnas de `INVOICE_SELECT` (el
  --      servicio no necesita otra lectura para tener la fila, y no hay ventana
  --      entre la escritura y la lectura del resultado). Se listan una por una, a
  --      propósito: `to_jsonb(v_factura)` agregaría `updated_at`, que el servicio
  --      nunca leyó.
  RETURN jsonb_build_object(
    'id', v_factura.id,
    'sede_id', v_factura.sede_id,
    'consecutive_number', v_factura.consecutive_number,
    'client_name', v_factura.client_name,
    'client_document', v_factura.client_document,
    'subtotal', v_factura.subtotal,
    'discount', v_factura.discount,
    'tax', v_factura.tax,
    'surcharge', v_factura.surcharge,
    'total', v_factura.total,
    'status', v_factura.status,
    'user_id', v_factura.user_id,
    'cash_shift_id', v_factura.cash_shift_id,
    'closed_by', v_factura.closed_by,
    'closed_at', v_factura.closed_at,
    'cancel_reason', v_factura.cancel_reason,
    'created_at', v_factura.created_at,
    'edit_version', v_factura.edit_version
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_items`, `invoice_taxes`,
-- `invoice_payments`, `cash_shifts` e `invoice_sequences` (esta última dentro de
-- `next_invoice_number`); con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018 (y el mismo paso que da
-- 039).
ALTER FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría EMITIR facturas por PostgREST —cobrar, descontar
-- stock, quemar consecutivos y cerrar el turno que quisiera—. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb) IS
'CL-13: la EMISIÓN de una factura, ATÓMICA. Reserva el consecutivo (next_invoice_number, 005), escribe la factura, sus líneas, su snapshot de impuestos, sus porciones y el OUT de stock (deduct_stock_atomic, 046) en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con las precondiciones recomprobadas sobre la fila bloqueada (el turno de caja abierto, con FOR UPDATE). El servicio computa TODO —subtotales, impuestos, recargos, totales, estado, plan de stock y el motivo del OUT como plantilla— y la función sólo escribe lo que recibe: no hay una sola expresión aritmética sobre una columna de dinero. Un fallo de cualquier grupo revierte la emisión COMPLETA, incluida la reserva del consecutivo: no queda residuo parcial y no se quema ningún número, así que NO hay compensación (cleanupFailedInvoice se elimina con 052). Rechaza con INVOICE_INVALID (entrada mal formada), OUT_REASON_INVALID (la plantilla del motivo no trae su token), SHIFT_NOT_OPEN (el turno se cerró en la ventana), INVOICE_MISMATCH / ITEM_MISMATCH / TAX_MISMATCH / PAYMENT_MISMATCH / MOVEMENT_MISMATCH (las redes de conteo) y lo que levanten 005/031/041/046 (23505, el tope de cobro, INSUFFICIENT_STOCK, PRODUCT_NOT_FOUND). La sede es la del TURNO que la función bloquea —la instalación es de una sola sede (071)— y de ahí salen la factura, el consecutivo y el stock. Devuelve la factura escrita con las columnas de INVOICE_SELECT. El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock (004) y el consecutivo lo sigue asignando EXCLUSIVAMENTE next_invoice_number (005). Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 2.11 ----
-- invoice_split_payment_atomic (056, que a su vez trae 050)
--
-- Firma `(uuid, uuid, uuid, timestamptz, boolean, jsonb)`: la factura, el TURNO
-- que cobra (el punto de serialización nuevo de 056), el usuario, el instante,
-- la decisión del cierre y las porciones.
CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic(
  p_invoice_id uuid,
  p_shift_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_mark_paid boolean,
  p_portions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_turno public.cash_shifts;
  v_esperados integer;
  v_escritos integer;
  v_marcadas integer;
  v_actualizados integer;
BEGIN
  -- 5.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. El turno también tiene que venir (es el punto de
  --     serialización nuevo), la decisión del cierre tiene que venir (NULL no es
  --     una decisión) y las porciones no pueden venir vacías —un cobro sin
  --     porciones no es un cobro—.
  IF p_invoice_id IS NULL
     OR p_shift_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_mark_paid IS NULL
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  IF p_portions IS NULL
     OR jsonb_typeof(p_portions) <> 'array'
     OR jsonb_array_length(p_portions) = 0
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Cada porción: método con código (el snapshot que la tabla exige), monto
  --     y recargo con la forma que la tabla puede guardar, porcentaje de recargo,
  --     y el turno y la marca como uuid o ausentes. El `coalesce` es la misma
  --     trampa que documentan 046–053. El `CASE` vuelve a garantizar que cada
  --     cast sólo se evalúe cuando el texto ya validó su forma.
  --
  --     `method_id` y `idempotency_key` son OPCIONALES (la columna admite NULL:
  --     005 para el método, 042 para la marca); `cash_shift_id` también lo es a
  --     nivel de columna (023), pero el cobro SIEMPRE pertenece al turno abierto
  --     y el servicio lo informa: acá se exige.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE jsonb_typeof(item) <> 'object'
       OR btrim(coalesce(item ->> 'method_code', '')) = ''
       OR coalesce(item ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
       OR coalesce(item ->> 'cash_shift_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (coalesce(item ->> 'method_id', '') <> ''
           AND coalesce(item ->> 'method_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       OR (coalesce(item ->> 'idempotency_key', '') <> ''
           AND coalesce(item ->> 'idempotency_key', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Y la forma de la MARCA de la 042, que es una premisa y no un detalle: la
  --     marca vive SÓLO en la primera porción, porque una marca única sobre una
  --     operación de varias filas es lo que hace sonoro el índice único parcial
  --     (`uq_invoice_payments_invoice_idempotency_key`). El servicio ya la manda
  --     así; acá se exige, para que un llamador nuevo no pueda romper la premisa
  --     y convertir una operación legítima en un 23505.
  SELECT count(*) INTO v_marcadas
  FROM jsonb_array_elements(p_portions) AS item
  WHERE coalesce(item ->> 'idempotency_key', '') <> '';

  IF v_marcadas > 1 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     Y la premisa NUEVA de 056: TODAS las porciones pertenecen al TURNO que
  --     la operación bloquea. Sin esta guarda, una porción podría referenciar
  --     otro turno —posiblemente uno que se está cerrando— y la fila de dinero
  --     caería en un turno que la transacción NO bloqueó ni revalidó, que es
  --     exactamente el hueco (b). La comparación corre DESPUÉS de la guarda de
  --     forma de arriba, así que cada `cash_shift_id` ya validó su forma de uuid.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_portions) AS item
    WHERE (item ->> 'cash_shift_id')::uuid <> p_shift_id
  ) THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  -- 5.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila y NO compite con otro cobro del mismo turno. El estado se
  --     mira DESPUÉS del lock y sobre LA FILA.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR SHARE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_CLOSED';
  END IF;

  -- 5.3 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA.
  --     Una factura Anulada no admite cobros —el servicio ya lo rechaza antes
  --     (`ANNUL_INVALID`), y acá se vuelve a comprobar porque entre su lectura y
  --     esta escritura cabe una anulación—. El lock, además, es lo que serializa
  --     dos cobros de la misma factura: el tope de 031 toma el MISMO lock al
  --     insertar cada porción, así que el segundo espera y después evalúa su
  --     tope contra lo que el primero dejó.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  IF v_factura.status = 'Anulada' THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 5.4 El grupo 1: las PORCIONES, UNA sentencia multi-fila y cada columna
  --     escrita VERBATIM desde `p_portions` (el `::numeric` y el `::uuid` son
  --     conversiones de representación, no operaciones). La fila de identidad de
  --     la 042 —la única con marca— es la que el servicio decidió: por eso el
  --     INSERT NO lleva `ORDER BY`.
  SELECT jsonb_array_length(p_portions) INTO v_esperados;

  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount,
     cash_shift_id, idempotency_key)
  SELECT
    p_invoice_id,
    CASE
      WHEN coalesce(item ->> 'method_id', '') = '' THEN NULL
      ELSE (item ->> 'method_id')::uuid
    END,
    item ->> 'method_code',
    (item ->> 'amount')::numeric,
    (item ->> 'fee_percent')::numeric,
    (item ->> 'fee_amount')::numeric,
    (item ->> 'cash_shift_id')::uuid,
    CASE
      WHEN coalesce(item ->> 'idempotency_key', '') = '' THEN NULL
      ELSE (item ->> 'idempotency_key')::uuid
    END
  FROM jsonb_array_elements(p_portions) AS item;

  -- 5.5 Red de seguridad DENTRO de la transacción: exactamente las porciones
  --     recibidas. Sin ella, un subconjunto silencioso dejaría el cobro
  --     incompleto con la factura ya cerrada por el grupo de abajo. El tope de
  --     031 y el índice de la 042 abortan ANTES de llegar acá (su error se
  --     propaga tal cual, con su SQLSTATE, para que el servicio lo traduzca como
  --     ya lo traducía).
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_esperados THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 5.6 El grupo 2: el CIERRE de la factura, SÓLO si el servicio lo decidió
  --     (`p_mark_paid`). Acá no se compara el cobrado contra el facturado —eso es
  --     `invoiceNetBalance` + `moneyEquals` en TypeScript— y no se recalcula
  --     ningún monto: la fila cambia de estado, con su responsable
  --     (`p_user_id`, un DATO) y su instante (`p_closed_at`, el que resolvió el
  --     servicio). Este camino YA escribía los dos campos; la 056 no los cambia.
  IF p_mark_paid THEN
    UPDATE public.invoices i
       SET status = 'Pagada',
           closed_by = p_user_id,
           closed_at = p_closed_at
     WHERE i.id = p_invoice_id
    RETURNING * INTO v_factura;

    -- 5.7 La segunda red: exactamente UNA factura cerrada. Cero filas aborta la
    --     operación ENTERA —las porciones incluidas—, que es lo que impide que
    --     quede dinero cobrado con la factura abierta (o cerrada sin sus
    --     porciones). La fila está bloqueada desde 5.3, así que este caso es una
    --     invariante rota, no una carrera: se rechaza ruidosamente.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 5.8 La factura ESCRITA (con el estado que quedó) y cuántas porciones se
  --     escribieron, para el contraste del llamador. Devolverla evita una
  --     segunda lectura y su ventana. La FORMA de la respuesta no cambia.
  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'sede_id', v_factura.sede_id,
      'consecutive_number', v_factura.consecutive_number,
      'client_name', v_factura.client_name,
      'client_document', v_factura.client_document,
      'subtotal', v_factura.subtotal,
      'discount', v_factura.discount,
      'tax', v_factura.tax,
      'surcharge', v_factura.surcharge,
      'total', v_factura.total,
      'status', v_factura.status,
      'user_id', v_factura.user_id,
      'cash_shift_id', v_factura.cash_shift_id,
      'closed_by', v_factura.closed_by,
      'closed_at', v_factura.closed_at,
      'cancel_reason', v_factura.cancel_reason,
      'created_at', v_factura.created_at,
      'edit_version', v_factura.edit_version
    ),
    'portions', v_escritos
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments` y `cash_shifts` (nuevo: el
-- turno se bloquea acá); con search_path mutable un esquema anterior en la ruta
-- podría secuestrar esos nombres. House style desde 018.
ALTER FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura y cerrarla por PostgREST, con
-- los montos que quisiera. El único llamador legítimo es el cliente
-- service_role del servidor.
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb) IS
'CL-11/CL-17: cobro dividido ATÓMICO (FAC-07), con el TURNO bloqueado. Inserta las porciones de invoice_payments —el dinero que entra, con la marca del intento de la 042 sólo en la primera— y, si el servicio decidió que la factura queda Pagada, la cierra con sus datos de cierre (closed_by = p_user_id y closed_at = p_closed_at, los dos DATOS), todo en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir sus porciones en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. Exige además que TODAS las porciones pertenezcan a ese turno (cash_shift_id = p_shift_id), para que el lock cubra exactamente las filas que se van a escribir. NO calcula nada: el reparto por método (neto, porcentaje, recargo, bruto) llega computado por computeCardFees y la decisión Pagada llega como p_mark_paid (invoiceNetBalance + moneyEquals, TypeScript); la función escribe cada columna verbatim y no compara el cobrado contra el facturado ni una vez. Revalida la precondición de estado sobre la fila bloqueada (una factura Anulada se rechaza con ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE. Su red de conteo aborta con PAYMENT_MISMATCH si no escribió exactamente las porciones recibidas o si no cerró exactamente una factura; en los dos casos la transacción se revierte COMPLETA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus porciones, y el reintento sigue siendo posible. La instalación es de una sola sede (071): la función no filtra por sede y no la recibe. Devuelve la factura escrita con las mismas columnas de INVOICE_SELECT y el número de porciones. Sólo service_role puede ejecutarla.';

-- --------------------------------------------------------------- 2.12 ----
-- cash_invoice_payment_atomic (056, que a su vez trae 053)
--
-- Firma `(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb)`: el turno que
-- cobra, la factura, el usuario, el instante del cierre, las dos decisiones
-- (enlazar el turno y cerrar la factura) y el cobro como dato.
--
-- La fila del LIBRO DE CAJÓN toma la sede del TURNO que la función bloquea con
-- `FOR SHARE`: es la fila que ya tenía que coincidir con la del llamador.
CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic(
  p_shift_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
  p_closed_at timestamptz,
  p_set_shift boolean,
  p_mark_paid boolean,
  p_collection jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_factura public.invoices;
  v_turno public.cash_shifts;
  v_pago public.payments;
  v_method_id uuid;
  v_escritos integer;
  v_actualizados integer;
BEGIN
  -- 1.1 FORMA de la entrada. Un cobro es dinero entrando: no puede aceptar una
  --     entrada a medio formar. El tipo `uuid` de los cuatro identificadores los
  --     valida la propia firma, `p_closed_at` tiene que venir —el instante del
  --     cierre es un DATO, y NULL no es un instante— y `p_set_shift`/`p_mark_paid`
  --     no aceptan NULL (NULL no es una decisión).
  IF p_shift_id IS NULL
     OR p_invoice_id IS NULL
     OR p_user_id IS NULL
     OR p_closed_at IS NULL
     OR p_set_shift IS NULL
     OR p_mark_paid IS NULL
     OR p_collection IS NULL
     OR jsonb_typeof(p_collection) <> 'object'
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     El cobro: método con código (el snapshot que la tabla exige), monto y
  --     recargo con la forma que la tabla puede guardar, porcentaje de recargo, y
  --     la marca del intento. El `coalesce` es la misma trampa que documentan
  --     046–053: con la clave AUSENTE, `p_collection ->> 'amount'` es NULL y
  --     `NULL !~ 'regex'` es NULL —no TRUE—, así que sin el coalesce una entrada
  --     sin monto pasaría esta guarda y sería el NOT NULL de la columna el que
  --     hablara, con un error de la base en vez de un rechazo del contrato.
  --
  --     La MARCA NO ES OPCIONAL acá, a diferencia de las porciones de 050 (donde
  --     vive sólo en la primera): este camino escribe UNA sola fila en
  --     `invoice_payments` y esa fila ES la operación, así que un cobro sin marca
  --     sería un cobro sin identidad. La firma del índice único parcial (042)
  --     depende de esa premisa.
  IF btrim(coalesce(p_collection ->> 'method_code', '')) = ''
     OR coalesce(p_collection ->> 'amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'fee_percent', '') !~ '^[0-9]{1,3}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'fee_amount', '') !~ '^[0-9]{1,9}([.][0-9]{1,2})?$'
     OR coalesce(p_collection ->> 'idempotency_key', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR (coalesce(p_collection ->> 'method_id', '') <> ''
         AND coalesce(p_collection ->> 'method_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  THEN
    RAISE EXCEPTION 'PAYMENT_INVALID';
  END IF;

  --     El método, resuelto UNA vez para las dos filas del dinero. El `CASE`
  --     garantiza que el cast a uuid sólo se evalúe cuando el texto YA validó la
  --     forma (SQL no promete el orden de las condiciones del OR).
  v_method_id := CASE
    WHEN coalesce(p_collection ->> 'method_id', '') = '' THEN NULL
    ELSE (p_collection ->> 'method_id')::uuid
  END;

  -- 1.2 EL TURNO, bloqueado y REVALIDADO —el segundo punto de serialización—.
  --     Va PRIMERO, antes de la factura, para respetar el orden global
  --     `cash_shifts > invoices` (ver "SERIALIZACIÓN" de 056). `FOR SHARE` es la
  --     fuerza elegida: compite con el `FOR UPDATE` que el cierre (049) toma sobre
  --     esta MISMA fila —así un cierre que llegó primero hace que esta lectura
  --     espere y después vea `cerrado`, y un cierre que llega después espera a
  --     este cobro— y NO compite con otro cobro del mismo turno (dos cajas
  --     cobrando facturas distintas en el mismo turno no se serializan entre sí).
  --     `FOR KEY SHARE` no serviría: es exactamente el lock que la FK toma hoy y
  --     el que NO excluye al cierre.
  --
  --     El estado se mira DESPUÉS del lock y sobre LA FILA (no sobre el dato que
  --     mandó el llamador): es la precondición que el servicio ya revisó, releída
  --     donde es verdadera. De ESTA fila sale además la sede del libro de cajón.
  SELECT s.*
    INTO v_turno
  FROM public.cash_shifts s
  WHERE s.id = p_shift_id
  FOR SHARE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHIFT_NOT_FOUND';
  END IF;

  IF v_turno.status <> 'abierto' THEN
    RAISE EXCEPTION 'SHIFT_CLOSED';
  END IF;

  -- 1.3 La FACTURA, bloqueada, y su precondición de estado RELEÍDA DE LA FILA
  --     (no del dato que mandó el llamador). `FOR UPDATE` es el idioma de la
  --     casa para tomar un lock de fila (039, 040, 047–053): es el punto de
  --     serialización del dinero de esa factura, y a partir de acá otro cobro
  --     —el tope de 031 toma ESTE MISMO lock— o una anulación (050) esperan.
  SELECT i.*
    INTO v_factura
  FROM public.invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE OF i;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  --     Una factura ANULADA no admite cobros: el servicio ya lo rechaza antes con
  --     este MISMO código, y acá se vuelve a comprobar sobre la fila bloqueada
  --     porque entre su lectura y esta escritura cabe una anulación.
  IF v_factura.status = 'Anulada' THEN
    RAISE EXCEPTION 'ANNUL_INVALID';
  END IF;

  -- 1.4 El grupo 1: la fila ESPEJO (`invoice_payments`), con el turno que COBRA
  --     y con la marca del intento —la identidad de este camino (042)—. Cada
  --     columna se escribe VERBATIM desde `p_collection`: el `::numeric` y el
  --     `::uuid` son conversiones de representación, no operaciones. El `id` NO
  --     se escribe: lo pone el DEFAULT de 005 (`gen_random_uuid()`).
  --
  --     Adentro corren las dos barreras PREEXISTENTES de la base, con su
  --     SQLSTATE intacto: el tope de cobro de 031 (trigger BEFORE INSERT →
  --     P0001) y el índice único parcial de identidad de la 042 (23505).
  INSERT INTO public.invoice_payments
    (invoice_id, method_id, method_code, amount, fee_percent, fee_amount,
     cash_shift_id, idempotency_key)
  VALUES
    (p_invoice_id,
     v_method_id,
     p_collection ->> 'method_code',
     (p_collection ->> 'amount')::numeric,
     (p_collection ->> 'fee_percent')::numeric,
     (p_collection ->> 'fee_amount')::numeric,
     p_shift_id,
     (p_collection ->> 'idempotency_key')::uuid);

  -- 1.5 Red de seguridad DENTRO de la transacción: exactamente UNA fila espejo.
  --     Sin ella, un subconjunto silencioso dejaría el cobro sin su dinero en el
  --     ledger y con la factura ya cerrada por el grupo de abajo.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.6 El grupo 2: el LIBRO DE CAJÓN del turno (`payments`), con el turno que el
  --     servicio resolvió, la SEDE DEL TURNO BLOQUEADO y el usuario que cobró —el
  --     único rastro de quién cobró (PRD §9.1)—. `idempotency_key` se escribe
  --     NULL A PROPÓSITO (043): la identidad de este camino vive en la fila espejo,
  --     y marcar las dos mezclaría en un mismo índice las marcas de dos caminos
  --     distintos. `created_at` no se toca: lo pone el DEFAULT de 006.
  INSERT INTO public.payments
    (sede_id, cash_shift_id, invoice_id, method_id, method_code, amount, user_id,
     idempotency_key)
  VALUES
    (v_turno.sede_id,
     p_shift_id,
     p_invoice_id,
     v_method_id,
     p_collection ->> 'method_code',
     (p_collection ->> 'amount')::numeric,
     p_user_id,
     NULL)
  RETURNING * INTO v_pago;

  -- 1.7 La segunda red: exactamente UNA fila en el libro de cajón. Sin ella, el
  --     dinero podría quedar en el ledger de la factura y fuera del arqueo del
  --     turno (o al revés) con la factura ya cerrada.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;

  -- 1.8 El grupo 3: el ESTADO de la factura, y SÓLO si el servicio lo decidió.
  --
  --     Acá no se compara el cobrado contra el facturado —eso es
  --     `invoiceNetBalance` + `moneyEquals` en TypeScript— y no se recalcula
  --     ningún monto: la fila cambia de turno y de estado con los datos del
  --     llamador.
  --
  --     `cash_shift_id` sólo se pisa si el servicio lo decidió (`p_set_shift`):
  --     una factura se enlaza al turno que la COBRA, y una que ya tenía turno
  --     conserva el suyo. `closed_by`/`closed_at` se escriben SÓLO cuando la
  --     factura se CIERRA (`p_mark_paid`) —Gap 1 de 056—: el responsable es el
  --     usuario que cobra (`p_user_id`) y el instante es el que resolvió el
  --     servicio (`p_closed_at`), los dos DATOS. El `CASE … ELSE i.<columna>` es
  --     una SELECCIÓN entre el dato y la columna que ya estaba (cuando el grupo
  --     corre sólo para enlazar el turno), no un cálculo.
  IF p_set_shift OR p_mark_paid THEN
    UPDATE public.invoices i
       SET cash_shift_id = CASE WHEN p_set_shift THEN p_shift_id ELSE i.cash_shift_id END,
           status = CASE WHEN p_mark_paid THEN 'Pagada' ELSE i.status END,
           closed_by = CASE WHEN p_mark_paid THEN p_user_id ELSE i.closed_by END,
           closed_at = CASE WHEN p_mark_paid THEN p_closed_at ELSE i.closed_at END
     WHERE i.id = p_invoice_id
    RETURNING * INTO v_factura;

    -- 1.9 La tercera red: exactamente UNA factura actualizada. Cero filas con el
    --     grupo corriendo es una invariante rota (la fila está bloqueada desde
    --     1.3): la operación entera aborta —el espejo y el libro de cajón
    --     incluidos—, que es exactamente lo que impide que quede dinero cobrado
    --     con la factura abierta.
    GET DIAGNOSTICS v_actualizados = ROW_COUNT;

    IF v_actualizados <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_MISMATCH';
    END IF;
  END IF;

  -- 1.10 El resultado: la fila del LIBRO DE CAJÓN escrita (las MISMAS columnas de
  --      `PAYMENT_SELECT`, que es lo que el servicio devuelve) y el ESTADO que
  --      quedó la factura. Devolverlas evita una segunda lectura y su ventana. La
  --      FORMA de la respuesta no cambia; lo único que puede venir distinto es el
  --      estado (`Pagada`) acompañado, ahora sí, de sus datos de cierre en la
  --      base.
  RETURN jsonb_build_object(
    'payment', jsonb_build_object(
      'id', v_pago.id,
      'sede_id', v_pago.sede_id,
      'cash_shift_id', v_pago.cash_shift_id,
      'invoice_id', v_pago.invoice_id,
      'method_id', v_pago.method_id,
      'method_code', v_pago.method_code,
      'amount', v_pago.amount,
      'user_id', v_pago.user_id,
      'created_at', v_pago.created_at
    ),
    'invoice', jsonb_build_object(
      'id', v_factura.id,
      'status', v_factura.status
    )
  );
END;
$$;

-- ------------------------------------------- search_path fijo ---
-- La función resuelve `invoices`, `invoice_payments`, `payments` y `cash_shifts`
-- (nuevo: el turno se bloquea acá); con search_path mutable un esquema anterior
-- en la ruta podría secuestrar esos nombres. House style desde 018 (y el mismo
-- paso que dan 039 y 046–053).
ALTER FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) SET search_path = public;

-- ------------------------------------------------ Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría cobrar una factura desde la caja por PostgREST, con
-- los montos que quisiera y cerrando el turno que quisiera. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) TO service_role;

-- --------------------------------------------- Documentación ---
COMMENT ON FUNCTION public.cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb) IS
'CL-17: cobro de factura desde CAJA, ATÓMICO (CAJ-02), con el TURNO bloqueado y con los datos de cierre. Escribe las TRES cosas del cobro —la fila espejo de invoice_payments (el dinero que suma el arqueo, con el turno que COBRA y la marca del intento de 042), la fila del libro de cajón payments (sin marca, 043) y el estado de la factura— en UNA sentencia, y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request. NO calcula nada: el bruto redondeado (roundMoney), el reparto del recargo (splitGrossCardFee), el saldo (invoiceNetBalance), la cota del tope de 031, la decisión Pagada (moneyEquals), el enlace al turno y el instante del cierre (p_closed_at, resuelto por el servicio como en 049 y 050) llegan computados por el servicio, y la función escribe cada columna verbatim, sin sumar, restar, multiplicar ni redondear un solo monto y sin comparar el cobrado contra el facturado ni una vez. BLOQUEA EL TURNO con FOR SHARE antes de bloquear la factura (orden global cash_shifts > invoices): revalida que exista y que esté abierto, así que un closeShift concurrente hace que el cobro espere y después RECHAZE (SHIFT_CLOSED) en vez de escribir su fila de dinero en un turno ya cerrado; FOR SHARE compite con el FOR UPDATE del cierre y no compite con otro cobro del mismo turno. La fila del libro de cajón toma la SEDE de ese turno bloqueado. Revalida también la precondición de la factura sobre su fila bloqueada (Anulada → ANNUL_INVALID) y conserva el tope de 031 y el índice único parcial de identidad de la 042, que corren adentro con su SQLSTATE (P0001 y 23505). Sus tres redes de conteo —una por grupo de escritura— abortan con PAYMENT_MISMATCH si no escribió exactamente lo recibido, y en ese caso la transacción se revierte ENTERA: no queda dinero cobrado con la factura abierta ni una factura cerrada sin sus filas de dinero, y el reintento sigue siendo posible. CIERRA la factura con sus datos: cuando el servicio lo decidió (p_mark_paid), escribe status = Pagada y ADEMÁS closed_by (el usuario que cobra) y closed_at (el instante que resolvió el servicio), que era el hueco de CL-17: una factura Pagada con closed_at NULL contradecía el contrato de 025 y dejaba la columna Cerrada del listado en guion sobre una factura cerrada. La marca del intento es OBLIGATORIA (este camino escribe una sola fila en invoice_payments y esa fila es la operación). Devuelve la fila del libro de cajón escrita (columnas de PAYMENT_SELECT) y el estado que quedó la factura. Sólo service_role puede ejecutarla.';

-- ===================================================================== ---
-- 3. Lo que este archivo deja para la unidad que borra la columna
-- ===================================================================== ---
--
-- Las doce funciones de arriba ya no nombran `sede_id` en su firma, así que la
-- unidad que haga `DROP COLUMN` no tiene que reescribir ninguna de ellas para
-- quitar el parámetro: sólo tiene que quitar las escrituras de la columna en los
-- cuerpos que quedan —la sede del producto en los movimientos de stock, la de la
-- caja en el turno nuevo, la del turno en la factura y en el libro de cajón— y
-- sacar el `sede_id` de la lista de columnas de cada `INSERT`.
--
-- Eso es todo lo que queda pendiente de este lado de la frontera de sede. La
-- frontera de las rutas del negocio sigue en `resolveSede`
-- (`src/shared/lib/sede.ts`), que no es plomería de sede sino el aislamiento real
-- de cada ruta mientras la columna exista: como la app usa `service_role`, que
-- bypasea RLS, `resolveSede` es la barrera que rechaza una fila cargada de otra
-- sede. Se retira junto con la migración que relaje la columna, no antes.
