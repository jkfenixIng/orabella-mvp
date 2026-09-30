-- 038_invoice_edit_serialization.sql — CO-1: dos ediciones simultáneas de la
-- MISMA factura dejan de aplicar dos veces su ajuste de stock.
--
-- MOTIVO DEL ARCHIVO
--
-- `editInvoiceItems` y `editEmittedInvoiceItems` (src/features/billing/service.ts)
-- leen los ítems de la factura, calculan el delta NETO por producto y lo aplican
-- por la frontera de inventario (`registerMovement`). Entre la lectura y la
-- escritura no había ninguna serialización: dos ediciones concurrentes de la
-- misma factura calculaban el MISMO delta y las dos lo aplicaban, así que el
-- stock se descontaba (o se devolvía) DOS veces. No hay transacción que abarque
-- las dos peticiones (PostgREST no ofrece multi-statement por request), así que
-- el candado tiene que vivir en una fila: la factura.
--
-- MECANISMO
--
--   * `invoices.edit_version` es el TOKEN del compare-and-swap. Cada edición
--     escribe `edit_version = <la leída> + 1` con la versión leída como
--     precondición (`.eq("edit_version", leída)`): si otra edición ya la movió,
--     el UPDATE afecta 0 filas, el servicio lo detecta (PGRST116, `.single()`
--     sin filas) y rechaza con el código de negocio `EDIT_CONFLICT` (409) ANTES
--     de la primera escritura — ni ítems, ni stock, ni auditoría. Es el mismo
--     patrón que la anulación de factura (`invoices.status` → `ANNUL_CONFLICT`)
--     y el cierre de caja (`cash_shifts.status` → `SHIFT_ALREADY_CLOSED`).
--   * El token cambia en CADA edición exitosa, y eso es lo que lo vuelve un
--     candado: un valor que no cambia no distingue "nadie editó" de "editó otro".
--
-- QUÉ NO HACE ESTE ARCHIVO
--
--   * No borra ni reescribe filas: `ADD COLUMN` con DEFAULT (PostgreSQL 11+
--     guarda el valor por defecto en el catálogo, así que no reescribe la
--     tabla) más un CHECK. No hay UPDATE de datos, ni DELETE, ni TRUNCATE.
--   * No toca el dinero: `edit_version` no entra en ninguna regla de negocio;
--     es un contador de serialización.
--   * No crea índice: el candado filtra por `id` (PRIMARY KEY), que ya está
--     indexado. Un índice sobre una columna que sólo se escribe con la PK no
--     aporta nada.
--
-- IDEMPOTENTE Y RE-EJECUTABLE: `ADD COLUMN IF NOT EXISTS` deja el esquema
-- idéntico en cada corrida; el CHECK va con `DROP CONSTRAINT IF EXISTS` +
-- `ADD CONSTRAINT` (el patrón que 037 usa para las políticas) para que un re-run
-- no choque con "constraint already exists". Ninguna sentencia borra filas. El
-- runner de Supabase aplica el archivo en una transacción: o entra todo, o no
-- entra nada.
--
-- NO ejecutado por el agente: requiere base de datos.

-- 1. El TOKEN. Entero NOT NULL en 0: las filas existentes quedan en 0, que es la
--    versión lógica correcta (nadie editó todavía con el candado puesto) y no
--    exige backfill.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS edit_version integer NOT NULL DEFAULT 0;

-- 2. La guarda de forma: el token es un contador que sólo sube (el servicio
--    escribe leída + 1). Un valor negativo sería un token imposible y volvería
--    el compare-and-swap incomprensible al leerlo.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_edit_version_nonnegative;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_edit_version_nonnegative CHECK (edit_version >= 0);

-- 3. La documentación en el esquema, como el resto de columnas de factura: quien
--    lea la tabla tiene que poder saber para qué existe este contador.
COMMENT ON COLUMN public.invoices.edit_version IS
'CO-1: token del compare-and-swap de las ediciones de la factura. Cada edición exitosa lo escribe como (valor leído + 1) con el valor leído como precondición; si otra edición ya lo movió, el UPDATE afecta 0 filas y el servicio rechaza con EDIT_CONFLICT (409) antes de tocar stock. No participa en ninguna regla de dinero.';
