-- 025_invoice_closed_at.sql — Fecha/hora de cierre de la factura (F3 lote operación UX).
--
-- El listado muestra "Cerrada" (fecha/hora de cierre; — si Emitida). El cierre
-- ocurre al pagar (splitPayment → Pagada) y al anular (annulInvoice → Anulada);
-- el servicio setea closed_at junto con closed_by. NULL = aún abierta (Emitida).
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS + backfill idempotente + índice IF NOT EXISTS.

-- ------------------------------------------------- columna ---
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL;

-- ------------------------------------------------- backfill ---
-- Pagadas/Anuladas existentes (cerradas antes de este campo): cierre = emisión.
UPDATE public.invoices
  SET closed_at = created_at
  WHERE closed_at IS NULL
    AND status IN ('Pagada', 'Anulada');

-- ------------------------------------------------- índice ---
CREATE INDEX IF NOT EXISTS idx_invoices_closed_at
  ON public.invoices (closed_at);

COMMENT ON COLUMN public.invoices.closed_at IS
'Fecha/hora de cierre de la factura: cuando se completó el pago (Pagada) o se anuló (Anulada). NULL si sigue Emitida.';
