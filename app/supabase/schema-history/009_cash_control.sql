-- 009_cash_control.sql — Control antifraude de caja (CASH-01).
--
-- - payment_methods.arqueable: el admin configura qué métodos se arquean
--   (p. ej. tarjeta por terminal no se puede contar físicamente).
-- - cash_shift_counts: detalle del conteo por denominación (efectivo) o
--   total declarado (digitales), en apertura y cierre. Sin este detalle no
--   hay forma de auditar un faltante.

-- ---------------------------------------------------------------- métodos ---

ALTER TABLE public.payment_methods
  ADD COLUMN arqueable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.payment_methods.arqueable IS
  'CASH: si el método se arquea en apertura/cierre (efectivo por denominación, digitales por total declarado).';

-- ---------------------------------------------------------------- conteos ---

CREATE TABLE public.cash_shift_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.cash_shifts (id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('apertura', 'cierre')),
  method_code text NOT NULL,
  denomination numeric(12, 2) NULL CHECK (denomination IS NULL OR denomination > 0),
  quantity integer NOT NULL CHECK (quantity >= 0),
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Efectivo: denomination obligatoria y amount = denomination * quantity.
  -- Digital: denomination NULL y quantity = 1 con el total declarado.
  CHECK (
    (denomination IS NOT NULL AND quantity >= 0)
    OR (denomination IS NULL AND quantity = 1)
  )
);

CREATE INDEX idx_shift_counts_shift_id ON public.cash_shift_counts (shift_id);

COMMENT ON TABLE public.cash_shift_counts IS
  'CASH: detalle de conteo de apertura/cierre por método y denominación. Evidencia ante faltantes/sobrantes.';
