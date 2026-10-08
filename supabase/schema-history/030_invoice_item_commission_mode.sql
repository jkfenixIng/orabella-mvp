-- 030_invoice_item_commission_mode.sql — Modo de comisión explícito por ítem.
--
-- Hasta ahora `invoice_items` solo distinguía dos cosas: `no_commission`
-- (la línea no comisiona) y `commission_value` (comisión en VALOR fijo por
-- unidad). `no_commission = false` con `commission_value = NULL` era ambiguo:
-- podía ser "porcentaje del empleado" o "comisión sin valor". Esta migración
-- agrega el modo explícito de la línea y el porcentaje explícito para
-- empleados de pago fijo, SIN tocar las columnas vivas `no_commission` ni
-- `commission_value` (se conservan y siguen mandando el cálculo histórico).
--
-- Valores de `commission_mode`:
--   'comision'   → comisión en VALOR fijo por unidad: commission_value × cantidad.
--   'porcentaje' → porcentaje del subtotal: el del empleado, o
--                  commission_percent_override si el empleado es de pago fijo
--                  (no tiene commission_percent). Siempre se paga en nómina.
--   'ninguna'    → la línea no comisiona.
--
-- Relación con las columnas vivas (el servicio las mantiene coherentes):
--   'ninguna'    ⇔ no_commission = true,  commission_value = NULL.
--   'comision'   ⇒ no_commission = false, commission_value informado.
--   'porcentaje' ⇒ no_commission = false, commission_value = NULL.
--
-- Idempotente y re-ejecutable (ADD COLUMN IF NOT EXISTS + bloques DO).

-- ------------------------------------------------- columnas ---
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS commission_mode text NULL;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS commission_percent_override numeric(5, 2) NULL;

-- ------------------------------------------------- CHECKs ---
-- El modo admite NULL (filas previas a esta migración que el backfill no cubra
-- y cualquier inserción que omita el campo): NULL significa "derivar de las
-- columnas vivas", que es exactamente el comportamiento previo. Por eso NO se
-- usa NOT NULL DEFAULT 'ninguna': un default silencioso marcaría como "sin
-- comisión" cualquier alta que olvidara el campo, perdiendo dinero.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_items_commission_mode'
  ) THEN
    ALTER TABLE public.invoice_items
      ADD CONSTRAINT chk_invoice_items_commission_mode
      CHECK (commission_mode IS NULL OR commission_mode IN ('comision', 'porcentaje', 'ninguna'));
  END IF;
END
$$;

-- Porcentaje explícito: 0–100 (igual rango que commission_rules.percent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_items_commission_percent_override'
  ) THEN
    ALTER TABLE public.invoice_items
      ADD CONSTRAINT chk_invoice_items_commission_percent_override
      CHECK (
        commission_percent_override IS NULL
        OR (commission_percent_override >= 0 AND commission_percent_override <= 100)
      );
  END IF;
END
$$;

-- ------------------------------------------------- backfill ---
-- El modo se deriva EXACTAMENTE de la semántica que la resolución ya aplicaba,
-- para que las facturas históricas sigan comportándose igual:
--   no_commission = true          → 'ninguna'    (la línea nunca comisionó).
--   commission_value > 0          → 'comision'   (valor fijo por unidad).
--   servicio sin valor            → 'porcentaje' (porcentaje del empleado; ya
--                                   lo aplicaba la resolución, aunque la UI
--                                   histórica no lo ofreciera).
--   personalizado sin valor (>0)  → 'porcentaje' (caía al porcentaje del
--                                   empleado, nunca a comisión).
--   producto sin valor            → 'comision'   (el producto SIEMPRE comisiona
--                                   por ítem: valor fijo si lo trae; si no,
--                                   regla ítem×empleado o 0; nunca porcentaje).
-- Se usa `commission_value > 0` (y no `IS NOT NULL`) porque la resolución trata
-- el 0 como "sin valor fijo": un commission_value = 0 cae al porcentaje/regla.
UPDATE public.invoice_items
SET commission_mode = CASE
  WHEN no_commission THEN 'ninguna'
  WHEN commission_value > 0 THEN 'comision'
  WHEN item_type = 'producto' THEN 'comision'
  ELSE 'porcentaje'
END
WHERE commission_mode IS NULL;

-- ------------------------------------------------- comentarios ---
COMMENT ON COLUMN public.invoice_items.commission_mode IS
'Modo de comisión de la línea: ''comision'' (valor fijo por unidad, commission_value × cantidad), ''porcentaje'' (porcentaje del subtotal: el del empleado o commission_percent_override si el empleado es de pago fijo) o ''ninguna'' (no comisiona). NULL = derivar de no_commission/commission_value (filas previas a la migración 030). Coherente con no_commission/commission_value: ninguna ⇒ no_commission = true; comision ⇒ commission_value informado.';

COMMENT ON COLUMN public.invoice_items.commission_percent_override IS
'Porcentaje explícito (0–100) de una línea ''porcentaje'' cuando el empleado es de pago fijo y no tiene commission_percent. La resolución usa el porcentaje del empleado si existe; si no, este. Siempre se paga en nómina, nunca de inmediato. NULL = usar el porcentaje del empleado.';
