-- 046_stock_deduction_atomicity.sql — CL-7: el descuento de stock de una venta
-- multi-producto deja de poder quedar a MEDIAS.
--
-- MOTIVO DEL ARCHIVO
--
-- `deductStock` (src/features/inventory/service.ts) descontaba el stock de una
-- emisión con un BUCLE: un `registerMovement` por producto, cada uno un request
-- distinto contra PostgREST. PostgREST no ofrece multi-statement por request (la
-- misma nota que ya está escrita en 005, 039, 040, 041, 042, 043, 044 y 045), y
-- el stock lo aplica el trigger `trg_inventory_apply_stock` (004) al confirmarse
-- CADA movimiento. Entonces un fallo en la mitad del bucle —una escritura que
-- falla, la conexión que se corta, el trigger que rechaza el tercer producto—
-- dejaba los descuentos ANTERIORES ya confirmados: la venta cobrada con el stock
-- descontado a medias y con el kardex mostrando una salida que la venta no
-- explica. No se pierde dinero en el sentido del cobro, pero stock y kardex
-- quedan inconsistentes y la única compensación que existía
-- (`cleanupFailedInvoice`, billing) sólo alcanza a compensar lo que `planned`
-- devolvió —y una deducción que falla no devuelve nada—.
--
-- MECANISMO
--
-- Una FUNCIÓN SQL llamada por `db.rpc(...)`: es la respuesta de la casa a
-- "PostgREST no tiene transacción multi-statement" y ya está en uso
-- (`next_invoice_number` 005, `replace_user_roles` 039, `ensure_user_has_role`
-- 040). Una función es UNA sentencia, y una sentencia corre ENTERA dentro de una
-- sola transacción del servidor: o se insertan TODOS los movimientos, o no se
-- inserta ninguno, y con ellos se revierte todo el stock que movieron sus
-- triggers. Eso es lo que vuelve la deducción atómica, y NO una compensación
-- posterior: compensar es escribir OTRA vez y volver a exponerse al mismo fallo
-- a mitad de camino (una compensación de N movimientos puede fallar en el
-- kardex). La deducción deja de ser un bucle de escrituras y pasa a ser una sola
-- escritura: no hay "mitad del camino" donde fallar.
--
-- POR QUÉ NO UNA COMPENSACIÓN EN EL CLIENTE (la alternativa evaluada)
--
-- Revertir lo escrito con movimientos IN invierte el orden del problema sin
-- resolverlo: la reversión es otro bucle sin transacción, así que la
-- inconsistencia reaparece un nivel más arriba (se compensan dos productos y
-- falla el tercero), y si la propia compensación falla y se traga el error —el
-- defecto exacto de `cleanupFailedInvoice`— queda stock descontado y SIN
-- registro de que faltaba compensarlo. La única forma de que la compensación sea
-- tan sólida como la transacción es... una transacción.
--
-- SERIALIZACIÓN: el orden de los locks es DETERMINISTA y ascendente por producto
-- (`ORDER BY p.id`). El trigger `trg_inventory_no_negative` (004) toma
-- `FOR UPDATE` sobre cada fila de `products` antes de aceptar su OUT; si dos
-- deducciones concurrentes comparten productos y cada una los recorre en un
-- orden distinto, la primera toma el lock A y la segunda el lock B, y las dos se
-- esperan: deadlock. Con las dos recorriendo los productos en el mismo orden
-- (ascendente por id), la segunda espera a la primera y no hay ciclo. El
-- candado NO es un `LOCK TABLE` ni un lock explícito: es el del propio trigger,
-- que ya era el único escritor del stock.
--
-- UN MOVIMIENTO POR PRODUCTO (y por qué eso se VERIFICA y no se supone)
--
-- La agregación por producto ya la hace el plan puro (`planStockDeduction`: dos
-- líneas del mismo producto son UN movimiento con la cantidad sumada). Acá se
-- comprueba (`count(DISTINCT product_id) = count(*)`) porque la corrección de la
-- guarda de stock depende de esa propiedad: cada OUT se evalúa contra el stock
-- de SU producto, y con dos movimientos del mismo producto en la misma sentencia
-- las dos comprobaciones verían el mismo stock previo —el AFTER ROW trigger que
-- aplica el stock no corre entre fila y fila de una misma sentencia—, así que un
-- par que en total deja negativo podría pasar las dos. Se rechaza la entrada
-- repetida en vez de confiar en que el llamador agregó.
--
-- QUIÉN PUEDE LLAMARLA (decisión de permiso, explícita)
--
--   * NO necesita ser DEFINER: el único llamador es el cliente `service_role`
--     del servidor (`createAdminClient()`), que ya bypassa RLS. Se declara
--     SECURITY INVOKER, igual que 039.
--   * SÍ hay que decidir el GRANT. `CREATE FUNCTION` deja EXECUTE a PUBLIC por
--     defecto, y eso expondría la deducción de stock a cualquier JWT
--     (anon/authenticated) vía PostgREST: cualquiera podría vaciar el stock de
--     su sede (o de otra, si no se filtrara la sede) llamando al RPC. Se cierra
--     en el paso 3: se revoca de PUBLIC, anon y authenticated, y se otorga sólo
--     a service_role. Es la misma decisión que 018 tomó para `write_audit_log`
--     y que 039 para `replace_user_roles`.
--
-- LA MARCA DE LA 045 NO ENTRA ACÁ (dos mecanismos, no uno)
--
-- La función escribe `idempotency_key` en NULL, EXPLÍCITAMENTE. La deducción de
-- una emisión no tiene intento de cliente: su puerta es la marca de la FACTURA
-- (041) y su identidad no vive en el movimiento. Los movimientos de facturación
-- por eso quedan FUERA del índice único parcial de la 045
-- (`WHERE idempotency_key IS NOT NULL`) y no compiten con nadie. Consecuencia
-- declarada: después de este archivo, el OUT de la emisión deja de pasar por
-- `registerMovement` —la 045 lo lista entre sus llamadores de facturación— y
-- pasa por esta función; la fila sigue naciendo SIN marca, así que ni el índice
-- de la 045 ni su conclusión (la marca es opcional en la función compartida y
-- los caminos sin marca no entran al índice) cambian. Lo que NO se hace acá es
-- volver obligatoria la marca en `registerMovement`: los llamadores de
-- facturación que siguen usándola (anulación y las dos ediciones) no tienen un
-- intento del cliente que marcar, e insertan N movimientos por operación.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas de datos: sólo crea/reemplaza una función y
--     ajusta permisos. No hay UPDATE, DELETE ni TRUNCATE sobre `products`,
--     `inventory_movements` ni ninguna otra tabla.
--   * No toca la ARITMÉTICA del stock ni los triggers: `deduct_stock_atomic`
--     sólo INSERTA movimientos y son `trg_inventory_no_negative` (bloqueo del
--     OUT que deja negativo, con lock de fila) y `trg_inventory_apply_stock`
--     (único escritor de `products.stock_qty`) los que siguen aplicando y
--     validando el stock. La función no escribe `stock_qty` ni una sola vez.
--   * No agrega columnas, índices ni constraints: el INSERT usa columnas que ya
--     existen (004 y 045) y el índice que importa —`idx_movements_product_created`
--     y los `FOR UPDATE` de la PK de `products`— ya existe. No hay índice nuevo
--     que justificar ni coste de escritura nuevo que declarar.
--   * No toca los caminos de dinero: ni `invoices`, ni `invoice_payments`, ni
--     `payments`, ni `next_invoice_number`.
--   * No backfillea ni repara deducciones parciales ya ocurridas: no hay forma
--     de saber, mirando el kardex, qué emisión quedó a medias (ver la nota
--     operativa final).
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
--      resuelve `products` e `inventory_movements`, y con una ruta mutable un
--      esquema anterior podría secuestrar esos nombres.
--   3. Los permisos: cerrar EXECUTE a service_role ANTES de cualquier otro
--      consumidor. Entre el CREATE y el REVOKE, PUBLIC tiene EXECUTE.
--   4. El comentario de la función, para el que la lea desde `\df`.
--
-- COSTO DE NUMERACIÓN DE ESTE ARCHIVO: usa el número 046, el siguiente libre
-- (032 no existe y no existirá; 033–045 están tomados). No se reutiliza ningún
-- número y no se renombra ningún archivo anterior. La tabla NO tiene serie ni
-- consecutivo: `inventory_movements.id` es `uuid PRIMARY KEY DEFAULT
-- gen_random_uuid()` (004), así que el kardex no quema ningún número —una
-- sentencia abortada no deja fila y no deja hueco—. ACÁ NO SE QUEMA NINGÚN
-- NÚMERO, ni en el camino normal ni en el rechazo.
--
-- VENTANAS DECLARADAS (lo que este archivo NO cierra, y por qué)
--
--   * El trigger del stock corre dentro de la transacción de la función, así que
--     un OUT que deje el stock negativo aborta la deducción COMPLETA: el
--     llamador recibe INSUFFICIENT_STOCK (P0001) y no queda ningún movimiento
--     escrito. El mensaje por producto de la validación previa (el plan puro
--     sobre la lectura del stock) es el del camino normal; el que sale de acá es
--     el genérico de la carrera, porque la función no sabe qué producto falló
--     sin otra lectura.
--   * `deduct_stock_atomic` cierra la ventana del DESCUBRIMIENTO: la deducción
--     es una sola. NO cierra, y no se toca acá, las otras escrituras múltiples
--     sin transacción del mismo tipo que siguen abiertas y ya están reportadas
--     aparte: los bucles de `registerMovement` por delta de producto en las dos
--     ediciones de factura (`editInvoiceItems` y `editEmittedInvoiceItems`) y la
--     compensación por producto de `cleanupFailedInvoice` (que además se traga
--     su propio error). Son la misma CLASE de defecto y otro hallazgo.
--   * Un fallo DESPUÉS de la deducción (por ejemplo al releer el detalle de la
--     factura recién emitida; la auditoría NO es un punto de fallo, `writeAudit`
--     nunca lanza) sigue disparando la compensación del cliente, que ahora
--     revierte una deducción COMPLETA y no una a medias. Que esa reversión sea
--     a su vez atómica es el mismo hallazgo anterior, no se resuelve acá.
--
-- ACOPLAMIENTO DE DESPLIEGUE: la 046 va ANTES que este código. Sin la función,
-- `deductStock` no puede descontar NADA —el RPC no existe y la emisión falla
-- entera antes de escribir—, y con la función y sin el código el descuento sigue
-- siendo el bucle viejo (no hay regresión, sólo no mejora).
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La DEDUCCIÓN entera, indivisible
-- ===================================================================== ---

-- Firma `(uuid, uuid, text, jsonb)`: la sede del actor, el usuario responsable,
-- el motivo común del kardex (`FACTURA #N — Cliente`) y los pares
-- `{product_id, qty}` ya agregados por producto. El tipo de retorno es el
-- número de movimientos aplicados: el llamador contrasta ESE número contra lo
-- que pidió, en vez de confiar en que el RPC no dejó nada afuera.
CREATE OR REPLACE FUNCTION public.deduct_stock_atomic(
  p_sede_id uuid,
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
  IF p_sede_id IS NULL
     OR p_user_id IS NULL
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
  --     tampoco (ver "UN MOVIMIENTO POR PRODUCTO" arriba: la guarda del stock
  --     no vería el efecto de la fila anterior de la misma sentencia).
  SELECT count(*), count(DISTINCT (item ->> 'product_id'))
    INTO v_pedidos, v_unicos
  FROM jsonb_array_elements(p_items) AS item;

  IF v_pedidos = 0 OR v_unicos <> v_pedidos THEN
    RAISE EXCEPTION 'DEDUCTION_INVALID';
  END IF;

  -- 1.3 La ESCRITURA: UNA sentencia, y por eso UNA transacción. Todos los
  --     movimientos se insertan con el mismo motivo, el mismo responsable y la
  --     MISMA sede —la del producto, que además tiene que ser la que mandó el
  --     llamador—. `type` es 'OUT' y sólo 'OUT': esta función es el descuento
  --     de una venta, no un movimiento genérico.
  --
  --     `ORDER BY p.id` es el orden de los locks del trigger de 004 (ver
  --     "SERIALIZACIÓN" arriba).
  --
  --     `idempotency_key` se escribe NULL A PROPÓSITO: la deducción de una
  --     emisión no tiene intento de cliente, su puerta es la marca de la
  --     FACTURA (041) y su fila queda FUERA del índice único parcial de la 045
  --     (ver "LA MARCA DE LA 045 NO ENTRA ACÁ" arriba).
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
   AND p.sede_id = p_sede_id
  ORDER BY p.id;

  -- 1.4 Red de seguridad DENTRO de la transacción: si se escribió MENOS de lo
  --     pedido, se aborta y se revierte todo lo que esta sentencia sí escribió
  --     (el stock incluido, porque sus triggers corren en la misma
  --     transacción). El `JOIN` de arriba filtra por sede, así que un producto
  --     inexistente o de otra sede escribiría menos filas en SILENCIO: esta
  --     guarda convierte ese subconjunto silencioso en un rechazo con rollback.
  --     Es la misma red que 039 puso sobre su INSERT.
  GET DIAGNOSTICS v_escritos = ROW_COUNT;

  IF v_escritos <> v_pedidos THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  RETURN v_escritos;
END;
$$;

-- ------------------------------------------- 2. search_path fijo ---
-- La función resuelve `products` e `inventory_movements`; con search_path
-- mutable un esquema anterior en la ruta podría secuestrar esos nombres.
-- House style desde 018 (y el mismo paso que da 039).
ALTER FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) SET search_path = public;

-- ------------------------------------------------ 3. Permisos ---
-- `CREATE FUNCTION` otorga EXECUTE a PUBLIC: sin este bloque, cualquier JWT
-- (anon/authenticated) podría descontar stock por PostgREST. El único llamador
-- legítimo es el cliente service_role del servidor.
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) TO service_role;

-- --------------------------------------------- 4. Documentación ---
COMMENT ON FUNCTION public.deduct_stock_atomic(uuid, uuid, text, jsonb) IS
'CL-7: descuento ATÓMICO del stock de una venta multi-producto. Inserta TODOS los movimientos OUT en UNA sentencia —y por lo tanto en UNA transacción del servidor: PostgREST no ofrece multi-statement por request—, con los locks de fila del trigger trg_inventory_no_negative ordenados por producto para que dos deducciones concurrentes no se bloqueen en ciclo. Un fallo de cualquier movimiento (o de la guarda del stock) revierte la deducción COMPLETA: no queda descuento parcial. Devuelve cuántos movimientos aplicó y falla con DEDUCTION_INVALID (entrada mal formada o producto repetido) o PRODUCT_NOT_FOUND (la red de seguridad del conteo). El stock lo sigue aplicando EXCLUSIVAMENTE trg_inventory_apply_stock; esta función nunca escribe products.stock_qty. Escribe idempotency_key NULL a propósito: la deducción de una emisión no tiene intento de cliente y queda fuera del índice parcial de la 045. Sólo service_role puede ejecutarla.';

-- NOTA OPERATIVA (fuera del alcance de esta migración, no se escribe acá):
-- una emisión que ya quedó con el descuento a medias por el bug anterior NO se
-- repara sola y no hay forma de detectarla desde el kardex (una salida parcial
-- es indistinguible de una salida completa sin otro error a la vista). Se
-- reconcilia con el conteo físico del producto y, si hace falta, con el
-- movimiento ADJUST del camino manual, decidido por quien opera la base.
