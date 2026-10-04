-- 023_payment_shift.sql — A qué turno pertenece cada pago de factura.
--
-- El día/cierre de caja solo sumaba `payments` y dejaba fuera
-- `invoice_payments`: las ventas por factura daban 0. Cada cobro de factura
-- pertenece al turno ABIERTO al momento del cobro (no al turno de emisión:
-- la cajera B cobra en su turno facturas emitidas en el turno de A).
-- Backfill: lo ya cobrado se atribuye al turno de emisión de su factura.

ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS cash_shift_id uuid NULL REFERENCES public.cash_shifts (id) ON DELETE SET NULL;

UPDATE public.invoice_payments AS pay
SET cash_shift_id = inv.cash_shift_id
FROM public.invoices AS inv
WHERE pay.cash_shift_id IS NULL
  AND pay.invoice_id = inv.id
  AND inv.cash_shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_shift
  ON public.invoice_payments (cash_shift_id);

COMMENT ON COLUMN public.invoice_payments.cash_shift_id IS
'Turno abierto al momento del cobro (dueño del dinero en caja). NULL = cobrado sin turno (legacy).';
