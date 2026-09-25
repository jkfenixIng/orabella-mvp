-- 028_voucher_payment_method.sql — método de pago y turno de caja del vale.
--
-- El vale ahora lo abre la caja (turno abierto), no el empleado, y el método
-- arqueable por el que sale el dinero se elige AL CREAR el vale (antes se
-- aprobaba sin método). Un vale aprobado descuenta del arqueo por su método
-- en el turno que lo abrió; un vale pendiente NO toca caja hasta aprobarse.
--
-- Columnas:
--   - voucher_requests.method_code: método arqueable (efectivo, nequi,
--     daviplata, …). NULL = vale histórico (previo a esta migración) sin
--     método; esos vales no afectan el arqueo.
--   - voucher_requests.cash_shift_id: turno abierto que abrió el vale. El
--     arqueo atribuye los vales aprobados a su turno (mismo criterio que
--     invoice_payments.cash_shift_id). NULL = vale histórico / sin turno.
--
-- approval_code: se CONSERVA la columna (nullable, sin uso) para no ejecutar
-- una migración destructiva; el flujo ya no genera ni valida códigos de
-- aprobación (la autorización queda en approved_by + observation).
--
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
-- bloque DO para el CHECK.

-- ------------------------------------------------- columnas ---
ALTER TABLE public.voucher_requests
  ADD COLUMN IF NOT EXISTS method_code text NULL;

ALTER TABLE public.voucher_requests
  ADD COLUMN IF NOT EXISTS cash_shift_id uuid NULL REFERENCES public.cash_shifts (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_voucher_requests_cash_shift
  ON public.voucher_requests (cash_shift_id);

-- ------------------------------------------------- CHECK ---
-- Si hay método, no puede ser vacío (el catálogo arqueable lo valida el
-- servicio; Postgres no puede hacer subconsultas en un CHECK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_voucher_requests_method_code'
  ) THEN
    ALTER TABLE public.voucher_requests
      ADD CONSTRAINT chk_voucher_requests_method_code
      CHECK (method_code IS NULL OR length(btrim(method_code)) > 0);
  END IF;
END
$$;

-- ------------------------------------------------- comentarios ---
COMMENT ON COLUMN public.voucher_requests.method_code IS
  'Método arqueable por el que sale el dinero del vale (efectivo, nequi, daviplata, …). Se elige al crear el vale. NULL = vale histórico sin método (no afecta el arqueo).';

COMMENT ON COLUMN public.voucher_requests.cash_shift_id IS
  'Turno de caja (abierto) que abrió el vale. El arqueo atribuye los vales aprobados a su turno por method_code; un vale pendiente no afecta caja. NULL = vale histórico sin turno.';

COMMENT ON COLUMN public.voucher_requests.approval_code IS
  'Código de aprobación histórico (PAY-06). Ya no se genera ni se valida: la autorización del vale queda en approved_by + observation. Se conserva por compatibilidad; NULL en los vales nuevos.';
