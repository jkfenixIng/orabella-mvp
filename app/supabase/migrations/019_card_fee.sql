-- 019_card_fee.sql — Recargo por método de pago (tarjeta 5%), visible y auditable.
--
-- Modelo: el recargo se calcula sobre el NETO de cada porción
-- (fee = neto × fee_percent / 100) y se suma al total; el cliente paga el
-- BRUTO (neto + recargo). Las porciones guardan el bruto, así pagado/saldo,
-- cierre de caja y reportes cuadran sin lógica especial.
-- Tarjeta nace con 5%; el resto en 0 (configurable por método a futuro).

-- ------------------------------------------------- columnas ---
ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS fee_percent numeric(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS surcharge numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS fee_percent numeric(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS fee_amount numeric(12, 2) NOT NULL DEFAULT 0;

-- ------------------------------------------------- valores ---
-- Solo donde sigue en 0: nunca pisa un fee configurado a mano.
UPDATE public.payment_methods
SET fee_percent = 5
WHERE code = 'tarjeta' AND fee_percent = 0;

-- ------------------------------------------------- CHECK total ---
-- El total ahora incluye el recargo: total = subtotal − discount + tax + surcharge.
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_total_surcharge_check
  CHECK (abs(total - (subtotal - discount + tax + surcharge)) < 0.01);

COMMENT ON COLUMN public.payment_methods.fee_percent IS
'Recargo % que se suma al total cuando se cobra con este método (tarjeta: 5). 0 = sin recargo.';

COMMENT ON COLUMN public.invoices.surcharge IS
'Suma de recargos por método de las porciones (snapshot al emitir). Auditable por reportes.';

COMMENT ON COLUMN public.invoice_payments.fee_percent IS
'Snapshot del fee_percent del método al momento del cobro.';

COMMENT ON COLUMN public.invoice_payments.fee_amount IS
'Recargo cobrado en esta porción (bruto − neto). Suma con invoices.surcharge.';
