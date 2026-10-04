-- 041_invoice_idempotency.sql — MO-1: reenviar la MISMA emisión deja de
-- escribir una SEGUNDA factura.
--
-- MOTIVO DEL ARCHIVO
--
-- `createInvoice` (src/features/billing/service.ts) reservaba un consecutivo con
-- `next_invoice_number()` e insertaba la factura en `invoices`, sin mirar nada
-- del ENVÍO. Un doble clic, o el navegador reenviando el mismo POST después de
-- cortarse la red, recorría el camino entero otra vez: reservaba un NUEVO
-- consecutivo y escribía una SEGUNDA factura, con su propia salida de stock
-- (`deductStock`) y su propia comisión (la línea de `invoice_items` que la
-- nómina deriva). No hay transacción que abarque las dos peticiones —PostgREST
-- no ofrece multi-statement por request, la misma nota que ya está escrita en
-- 005 y en 040—, así que el reconocimiento tiene que vivir en una fila.
--
-- CÓMO SE RECONOCE UNA REPETICIÓN (decisión del dueño, no del agente)
--
-- Por una MARCA que manda el cliente: `invoices.idempotency_key`. NO por el
-- CONTENIDO. Deduplicar por contenido bloquearía una venta legítimamente
-- repetida —dos clientes distintos comprando lo mismo, o el mismo cliente
-- comprando dos veces—; la marca es lo único que distingue "el mismo envío" de
-- "el mismo contenido".
--
-- MECANISMO (dos barreras, en este orden)
--
--   1. La columna. Guarda la marca del intento de emisión: un uuid que genera la
--      PANTALLA al empezar el intento y que se reutiliza en los reintentos del
--      MISMO intento (nunca por tecla ni por render).
--   2. El índice único PARCIAL `(sede_id, idempotency_key)`. Es la barrera FINAL
--      contra la carrera: el servicio mira la marca ANTES de reservar el
--      consecutivo (así el reintento normal no gasta número), pero entre esa
--      lectura y el INSERT hay una ventana. Si otra emisión con la MISMA marca
--      se confirma ahí adentro, este INSERT choca con el índice (código 23505),
--      el servicio vuelve a buscar por la marca y devuelve la factura de la
--      ganadora en lugar de escribir una segunda. Es el mismo patrón de barrera
--      final que `uq_cash_shifts_open_per_register` (006) y
--      `uq_payroll_draft_per_range` (007).
--
--      Parcial (`WHERE idempotency_key IS NOT NULL`) por dos razones: las filas
--      ya emitidas no tienen marca y no deben entrar al índice, y una marca NULL
--      no es una marca: no puede deduplicar nada.
--
--      La clave es `(sede_id, idempotency_key)`, no la marca sola: la marca se
--      resuelve DENTRO del tenant que la usó, así que el lookup nunca puede
--      devolver el detalle de una factura de otra sede. Un uuid ya es único
--      globalmente, así que acotarlo por sede no cuesta nada y agrega el
--      aislamiento.
--
-- COSTO DECLARADO (no se esconde) — Y YA NO EXISTE
--
-- En el camino de la CARRERA, la perdedora reservaba su consecutivo antes de
-- chocar con el índice, y esa reserva quedaba SIN factura: un HUECO en la serie
-- de la sede. Ese fue el canje declarado en su momento —visible y raro, exige dos
-- envíos con la misma marca solapados dentro de esa ventana— antes que una
-- segunda factura, que es dinero cobrado dos veces.
--
-- **CORRECCIÓN (CL-13, migración 052): ese hueco ya NO PUEDE EXISTIR.** La 052
-- movió la reserva del consecutivo ADENTRO de la transacción de emisión, así que
-- la perdedora de la carrera REVIERTE su reserva al abortar y la serie queda
-- continua. Lo que sigue costando la carrera es una sentencia ABORTADA (trabajo
-- invisible, ninguna fila), no un número. El camino NORMAL de la repetición
-- (marca ya emitida) se detecta antes de reservar y nunca dejó hueco.
--
-- El otro hueco posible también quedó cerrado por la misma razón: un fallo
-- posterior a la reserva obligaba a la limpieza best-effort de
-- `cleanupFailedInvoice`; con la 052 la emisión entera es UNA transacción, así
-- que ese camino tampoco deja un número sin factura.
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas: `ADD COLUMN IF NOT EXISTS` con NULL (sin
--     DEFAULT, así que no toca ninguna fila) y un índice. No hay UPDATE de
--     datos, ni DELETE, ni TRUNCATE, ni backfill.
--   * No cambia el dinero ni la frontera de stock: la columna no entra en
--     ninguna regla de negocio; sólo reconoce envíos repetidos.
--   * No toca `invoices.consecutive_number` ni su UNIQUE
--     `(sede_id, consecutive_number)` de 005: la barrera del consecutivo queda
--     como estaba y sigue siendo la que rechaza con `DUPLICATE_NUMBER` cuando el
--     choque NO es de marca.
--   * No agrega índices redundantes: el índice único parcial ya sirve la
--     lectura por marca.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS`,
-- `CREATE UNIQUE INDEX IF NOT EXISTS` y el CHECK con `DROP CONSTRAINT IF EXISTS`
-- + `ADD CONSTRAINT` (el patrón de 038) dejan el esquema idéntico en cada
-- corrida. Ninguna sentencia borra filas. El runner de Supabase aplica el
-- archivo en una transacción: o entra todo, o no entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- ===================================================================== ---
-- 1. La MARCA del intento de emisión
-- ===================================================================== ---

-- NULL a propósito: las filas ya emitidas no tienen marca (la decisión del
-- dueño es hacia adelante) y la marca es opcional a nivel de esquema porque sólo
-- el camino de EMISIÓN la exige. Sin DEFAULT, `ADD COLUMN` no reescribe la
-- tabla y no hay backfill que inventar.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

COMMENT ON COLUMN public.invoices.idempotency_key IS
  'MO-1: marca de idempotencia del intento de emisión (uuid que genera la pantalla y se reutiliza en los reintentos del MISMO intento). Reenviar la misma marca devuelve la factura ya emitida en vez de escribir otra. NULL en las filas anteriores a 041.';

-- ===================================================================== ---
-- 2. La guarda de forma: una marca es un uuid, no cualquier texto
-- ===================================================================== ---

-- El servicio valida el formato ANTES de escribir (idempotencyKeySchema), así
-- que ningún camino del usuario puede llegar a este CHECK: es la última red para
-- un escritor crudo (SQL, un servicio futuro) y prefiere rechazar la fila antes
-- que guardar una marca que el lookup nunca podría reconocer.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_idempotency_key_shape;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_idempotency_key_shape CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ===================================================================== ---
-- 3. La barrera final: a lo sumo UNA factura por marca y sede
-- ===================================================================== ---

-- Parcial: la marca NULL (filas históricas) queda fuera del índice, y una marca
-- vacía tampoco deduplica nada. Es la barrera que convierte la carrera
-- lookup→INSERT en un 23505 que el servicio traduce en "devuelve la existente".
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_sede_idempotency_key
  ON public.invoices (sede_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
