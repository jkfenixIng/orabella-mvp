-- 022_closed_by.sql — Quién cerró la factura (cobro final o anulación).
--
-- El listado muestra "Cerró" y filtra por responsable. El código ya leía
-- invoices.closed_by pero la columna nunca se creó (fallaba la lista con
-- 42703). NULL = aún abierta (Emitida) o cerrada antes de este campo.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS closed_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.invoices.closed_by IS
'Usuario que cerró la factura: quien completó el pago (Pagada) o quien la anulo (Anulada). NULL si sigue Emitida.';
