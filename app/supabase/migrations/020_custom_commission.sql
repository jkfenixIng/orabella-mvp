-- 020_custom_commission.sql — Comisión en VALOR para ítems personalizados.
--
-- El código (schemas, servicio, nómina, UI) ya lee/escribe
-- invoice_items.commission_value, pero ninguna migración creaba la columna:
-- el detalle y el cálculo de nómina fallaban con 42703. Esta migración
-- cierra ese hueco. Idempotente y re-ejecutable.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS commission_value numeric(12, 2) NULL;

COMMENT ON COLUMN public.invoice_items.commission_value IS
'Comisión en VALOR fijo ($) solo para ítems personalizados con comisión (no es %). NULL = sin comisión o no aplica (productos usan % del empleado, servicios nunca).';
