-- 003_payment_method_arqueo.sql
--
-- Payment methods get a free, immutable code and an explicit arqueo mode.
-- Every arqueable method opens each shift with its own frozen opening base,
-- and immediate commission payouts / approved vouchers cannot leave that
-- method's derived shift balance below 50% of its opening base.
--
-- Expected balance (derived, never stored):
--   opening_base
--   + payments of the shift without invoice + invoice_payments of the shift
--   - commission_payouts of the shift - approved vouchers of the shift
--
-- Shifts opened before this migration have no balance rows. They are not
-- reconstructed: an outflow by a currently arqueable method on such a shift is
-- rejected with CASH_METHOD_BALANCE_REQUIRED until the shift is closed and a
-- new one is opened. Payroll payments and payroll extras are not touched.
--
-- Idempotent: every object is guarded or replaced. Transactional: all or none.
BEGIN;

-- 1. Explicit arqueo mode. `arqueo_mode` is the source of truth and
--    `arqueable` stays as a derived compatibility column:
--      * a BEFORE trigger keeps them in sync, so writers that only know the
--        boolean (seeds, an app instance still running the previous build
--        during the deploy) keep working;
--      * a CHECK is the final barrier when triggers are bypassed
--        (session_replication_role = replica, restores).
--    A writer that sends `arqueo_mode` always wins over the boolean.
ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS arqueo_mode text;

-- Backfill keeps the current `arqueable` exactly.
UPDATE public.payment_methods
   SET arqueo_mode = CASE
         WHEN arqueable IS NOT TRUE THEN 'none'
         WHEN code = 'efectivo' THEN 'denominations'
         ELSE 'declared_total'
       END
 WHERE arqueo_mode IS NULL;

-- No column DEFAULT: an INSERT without a mode gets it from the sync trigger
-- (section 3), derived from `arqueable` exactly like the backfill above.
ALTER TABLE public.payment_methods
  ALTER COLUMN arqueo_mode SET NOT NULL;

-- 2. Free code: only the closed six-code CHECK goes away. UNIQUE(code) stays.
ALTER TABLE public.payment_methods
  DROP CONSTRAINT IF EXISTS payment_methods_code_check,
  DROP CONSTRAINT IF EXISTS payment_methods_code_format_check,
  DROP CONSTRAINT IF EXISTS payment_methods_arqueo_mode_check,
  DROP CONSTRAINT IF EXISTS payment_methods_arqueo_coherent_check;

ALTER TABLE public.payment_methods
  ADD CONSTRAINT payment_methods_code_format_check
    CHECK (length(code) BETWEEN 2 AND 40 AND code ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'),
  ADD CONSTRAINT payment_methods_arqueo_mode_check
    CHECK (arqueo_mode IN ('none', 'denominations', 'declared_total')),
  ADD CONSTRAINT payment_methods_arqueo_coherent_check
    CHECK (arqueable = (arqueo_mode <> 'none'));

-- One physical drawer and one denomination catalog: at most one method is
-- counted by denominations (cash_shifts.counted_cash describes that drawer).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_methods_single_denominations
  ON public.payment_methods ((true))
  WHERE arqueo_mode = 'denominations';

-- 3. The code is a historical snapshot in payments, invoice_payments,
--    commission_payouts, voucher_requests, payroll rows and counts: immutable.
--    The same trigger keeps `arqueable` and `arqueo_mode` in sync.
CREATE OR REPLACE FUNCTION public.payment_method_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CODE_IMMUTABLE';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.arqueo_mode IS NULL THEN
      -- Legacy writer: same derivation as the backfill.
      NEW.arqueo_mode := CASE
        WHEN NEW.arqueable IS NOT TRUE THEN 'none'
        WHEN NEW.code = 'efectivo' THEN 'denominations'
        ELSE 'declared_total'
      END;
    END IF;
  ELSIF NEW.arqueo_mode IS NOT DISTINCT FROM OLD.arqueo_mode
        AND NEW.arqueable IS DISTINCT FROM OLD.arqueable THEN
    -- Legacy writer toggled only the boolean.
    NEW.arqueo_mode := CASE
      WHEN NEW.arqueable IS NOT TRUE THEN 'none'
      WHEN OLD.arqueo_mode <> 'none' THEN OLD.arqueo_mode
      WHEN NEW.code = 'efectivo' THEN 'denominations'
      ELSE 'declared_total'
    END;
  END IF;

  NEW.arqueable := NEW.arqueo_mode IS DISTINCT FROM 'none';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_methods_code_immutable ON public.payment_methods;
CREATE TRIGGER trg_payment_methods_code_immutable
  BEFORE INSERT OR UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.payment_method_code_immutable();

-- 4. Frozen opening base per (shift, arqueable method). No expected-balance
--    ledger: it is derived from the existing money tables.
CREATE TABLE IF NOT EXISTS public.cash_shift_method_balances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cash_shift_id uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  method_code text NOT NULL,
  opening_base numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT cash_shift_method_balances_pkey PRIMARY KEY (id),
  CONSTRAINT cash_shift_method_balances_opening_base_check CHECK (opening_base >= 0),
  CONSTRAINT cash_shift_method_balances_shift_method_key UNIQUE (cash_shift_id, payment_method_id),
  CONSTRAINT cash_shift_method_balances_shift_code_key UNIQUE (cash_shift_id, method_code),
  CONSTRAINT cash_shift_method_balances_cash_shift_id_fkey
    FOREIGN KEY (cash_shift_id) REFERENCES public.cash_shifts(id) ON DELETE CASCADE,
  CONSTRAINT cash_shift_method_balances_payment_method_id_fkey
    FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT
);

-- Deny-by-default, like the other cash tables: no policy, service_role only.
ALTER TABLE public.cash_shift_method_balances ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cash_shift_method_balances IS
  '003: opening base frozen per shift and arqueable method. The expected balance is derived (payments without invoice + invoice_payments - commission_payouts - approved vouchers), never stored.';

-- 5. Opening. 001's opener is kept verbatim under an internal name and the
--    public signature becomes a wrapper that also writes the balances in the
--    SAME statement (same transaction). Legacy fields are unchanged.
DO $$
BEGIN
  IF to_regprocedure('public.cash_open_shift_atomic_legacy(uuid,uuid,numeric,jsonb)') IS NULL THEN
    ALTER FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb)
      RENAME TO cash_open_shift_atomic_legacy;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) FROM service_role;

CREATE OR REPLACE FUNCTION public.cash_open_shift_atomic(
  p_register_id uuid,
  p_opened_by uuid,
  p_opening_base numeric,
  p_counts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_shift jsonb;
  v_expected integer;
  v_written integer;
BEGIN
  -- Count lines must match the method's mode: denominations need a
  -- denomination, declared totals must not have one.
  IF jsonb_typeof(p_counts) = 'array' AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_counts) AS item
      JOIN public.payment_methods pm ON pm.code = btrim(item ->> 'method_code')
     WHERE (pm.arqueo_mode = 'denominations' AND coalesce(item ->> 'denomination', '') = '')
        OR (pm.arqueo_mode = 'declared_total' AND coalesce(item ->> 'denomination', '') <> '')
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  v_shift := public.cash_open_shift_atomic_legacy(p_register_id, p_opened_by, p_opening_base, p_counts);

  SELECT count(*) INTO v_expected
    FROM public.payment_methods pm
   WHERE pm.is_active AND pm.arqueo_mode <> 'none';

  -- Every active arqueable method must declare its own base.
  IF v_expected <> (
    SELECT count(DISTINCT pm.id)
      FROM jsonb_array_elements(p_counts) AS item
      JOIN public.payment_methods pm ON pm.code = btrim(item ->> 'method_code')
     WHERE pm.is_active AND pm.arqueo_mode <> 'none'
  ) THEN
    RAISE EXCEPTION 'SHIFT_BALANCE_MISMATCH';
  END IF;

  INSERT INTO public.cash_shift_method_balances
    (cash_shift_id, payment_method_id, method_code, opening_base)
  SELECT (v_shift ->> 'id')::uuid, pm.id, pm.code, sum((item ->> 'amount')::numeric)
    FROM public.payment_methods pm
    JOIN jsonb_array_elements(p_counts) AS item ON btrim(item ->> 'method_code') = pm.code
   WHERE pm.is_active AND pm.arqueo_mode <> 'none'
   GROUP BY pm.id, pm.code
   ORDER BY pm.code;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  IF v_written <> v_expected THEN
    RAISE EXCEPTION 'SHIFT_BALANCE_MISMATCH';
  END IF;

  RETURN v_shift;
END;
$$;

COMMENT ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) IS
  '003: opens the shift (001 logic, verbatim, as cash_open_shift_atomic_legacy) and freezes one opening base per active arqueable method in the same transaction. SHIFT_BALANCE_MISMATCH when an active arqueable method has no count line; SHIFT_INVALID when a line does not match its method arqueo_mode.';

-- 5b. Recount compatibility wrapper. 001's recount procedure hard-coded an
-- `efectivo` line. Keep it verbatim internally and validate the configured
-- denomination method here; a temporary zero declared-total line only satisfies
-- the old structural guard and is deleted before the transaction returns.
DO $$
BEGIN
  IF to_regprocedure('public.cash_recount_shift_atomic_legacy(uuid,uuid,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb)
      RENAME TO cash_recount_shift_atomic_legacy;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic_legacy(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic_legacy(uuid, uuid, jsonb, jsonb) FROM service_role;

CREATE OR REPLACE FUNCTION public.cash_recount_shift_atomic(
  p_shift_id uuid,
  p_recounted_by uuid,
  p_recount jsonb,
  p_counts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_drawer text;
  v_result jsonb;
  v_synthetic boolean;
BEGIN
  SELECT code INTO v_drawer
    FROM public.payment_methods
   WHERE is_active AND arqueo_mode = 'denominations'
   ORDER BY code LIMIT 1;
  IF v_drawer IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_counts) item
     WHERE btrim(item ->> 'method_code') = v_drawer
       AND coalesce(item ->> 'denomination', '') <> ''
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 001's guard wants a line named 'efectivo'. Only when the caller sent none
  -- (the code may no longer exist or count anything) a zero placeholder is
  -- added, and exactly that placeholder is removed in the same transaction:
  -- a real 'efectivo' line sent by the caller is never touched.
  v_synthetic := jsonb_typeof(p_counts) = 'array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_counts) item WHERE item ->> 'method_code' = 'efectivo'
  );

  v_result := public.cash_recount_shift_atomic_legacy(
    p_shift_id,
    p_recounted_by,
    p_recount,
    CASE WHEN v_synthetic
      THEN p_counts || jsonb_build_array(jsonb_build_object(
        'method_code', 'efectivo', 'denomination', NULL, 'quantity', 1, 'amount', 0))
      ELSE p_counts
    END
  );

  IF v_synthetic THEN
    DELETE FROM public.cash_shift_counts
     WHERE shift_id = p_shift_id AND phase = 'reconteo' AND method_code = 'efectivo';
  END IF;
  RETURN v_result;
END;
$$;

-- 6. THE one definition of a voucher that affects cash, used by the balance,
--    the triggers and (through the invariant below) the 001 close token:
--      approved (approved_by set) AND in 'aprobada' or 'descontada'
--      AND with method AND shift.
--    'descontada' counts: payroll_apply_atomic moves approved vouchers there
--    and the cash already left the drawer. 'pendiente' and 'rechazada' never
--    count. The domain has no approved -> rejected/pending transition
--    (rejectVoucher/approveVoucher act only on 'pendiente'; the payroll revert
--    restores 'aprobada' when approved_by is set), so the invariant trigger
--    REJECTS it instead of silently releasing the floor: VOUCHER_CASH_OUT_IMMUTABLE.
CREATE OR REPLACE FUNCTION public.voucher_is_cash_out(
  p_status text,
  p_approved_by uuid,
  p_method_code text,
  p_cash_shift_id uuid
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT p_approved_by IS NOT NULL
     AND p_status IN ('aprobada', 'descontada')
     AND p_method_code IS NOT NULL
     AND p_cash_shift_id IS NOT NULL
$$;

-- The state machine's database backstop. Application transitions already only
-- reject/approve from pendiente; this catches a direct SQL update that would
-- make the legacy close token and the balance formula disagree.
CREATE OR REPLACE FUNCTION public.enforce_voucher_cash_out_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Invariant: an approver implies an approved state. It keeps 001's close
  -- token (approved_by + method) identical to `voucher_is_cash_out`.
  IF NEW.approved_by IS NOT NULL AND NEW.status NOT IN ('aprobada', 'descontada') THEN
    RAISE EXCEPTION 'VOUCHER_CASH_OUT_IMMUTABLE';
  END IF;
  -- A cash-out voucher cannot stop being one (no un-approve, no clearing its
  -- method or shift): the cash already left the drawer.
  IF TG_OP = 'UPDATE'
     AND public.voucher_is_cash_out(OLD.status, OLD.approved_by, OLD.method_code, OLD.cash_shift_id)
     AND NOT public.voucher_is_cash_out(NEW.status, NEW.approved_by, NEW.method_code, NEW.cash_shift_id) THEN
    RAISE EXCEPTION 'VOUCHER_CASH_OUT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_voucher_requests_cash_out_state ON public.voucher_requests;
CREATE TRIGGER trg_voucher_requests_cash_out_state
  BEFORE INSERT OR UPDATE OF status, approved_by, method_code, cash_shift_id ON public.voucher_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_voucher_cash_out_state();

-- 6b. Derived expected balance of one method in one shift. Read-only.
CREATE OR REPLACE FUNCTION public.cash_shift_method_expected_balance(
  p_shift_id uuid,
  p_method_code text
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_opening numeric(12,2);
BEGIN
  SELECT b.opening_base INTO v_opening
    FROM public.cash_shift_method_balances b
   WHERE b.cash_shift_id = p_shift_id AND b.method_code = p_method_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_METHOD_BALANCE_REQUIRED';
  END IF;

  RETURN v_opening
    + coalesce((SELECT sum(p.amount) FROM public.payments p
                 WHERE p.cash_shift_id = p_shift_id AND p.invoice_id IS NULL
                   AND p.method_code = p_method_code), 0)
    + coalesce((SELECT sum(ip.amount) FROM public.invoice_payments ip
                 WHERE ip.cash_shift_id = p_shift_id
                   AND ip.method_code = p_method_code), 0)
    - coalesce((SELECT sum(cp.amount) FROM public.commission_payouts cp
                 WHERE cp.cash_shift_id = p_shift_id
                   AND cp.method_code = p_method_code), 0)
    - coalesce((SELECT sum(vr.amount) FROM public.voucher_requests vr
                 WHERE vr.cash_shift_id = p_shift_id
                   AND vr.method_code = p_method_code
                   AND public.voucher_is_cash_out(vr.status, vr.approved_by, vr.method_code, vr.cash_shift_id)), 0);
END;
$$;

-- 7. The authority: BEFORE triggers on the two outflows the rule covers.
--    Lock order follows the system's: cash_shifts (FOR SHARE, like the
--    collections) -> the balance row (FOR UPDATE, serializes outflows of one
--    method) -> invoices (taken afterwards by trg_commission_payouts_cap).
--    Trigger names sort before `trg_commission_payouts_cap` so they fire first.
CREATE OR REPLACE FUNCTION public.enforce_cash_method_minimum(
  p_shift_id uuid,
  p_method_code text,
  p_amount numeric,
  p_old_amount numeric DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_opening numeric(12,2);
  v_expected numeric(12,2);
  v_mode text;
BEGIN
  IF p_shift_id IS NULL OR p_method_code IS NULL THEN
    RETURN;
  END IF;

  -- Lock order: cash_shifts -> balance row -> invoices (the existing payout cap).
  PERFORM 1 FROM public.cash_shifts s WHERE s.id = p_shift_id FOR SHARE OF s;
  SELECT b.opening_base INTO v_opening
    FROM public.cash_shift_method_balances b
   WHERE b.cash_shift_id = p_shift_id AND b.method_code = p_method_code
   FOR UPDATE OF b;

  -- The shift is governed by the configuration it opened with: a frozen row
  -- always validates (even if the method is 'none' today); a method that is
  -- arqueable today without a frozen row in this shift is rejected; a method
  -- that is not arqueable and was not frozen does not take part.
  IF NOT FOUND THEN
    SELECT pm.arqueo_mode INTO v_mode FROM public.payment_methods pm WHERE pm.code = p_method_code;
    IF coalesce(v_mode, 'none') = 'none' THEN RETURN; END IF;
    RAISE EXCEPTION 'CASH_METHOD_BALANCE_REQUIRED'
      USING DETAIL = 'Cierre y abra de nuevo el turno para usar arqueo por método.';
  END IF;

  v_expected := public.cash_shift_method_expected_balance(p_shift_id, p_method_code)
                + coalesce(p_old_amount, 0);
  IF v_expected - p_amount < round(v_opening * 0.5, 2) THEN
    RAISE EXCEPTION 'CASH_METHOD_MINIMUM_BREACH'
      USING DETAIL = format('method=%s opening=%s expected=%s amount=%s',
                            p_method_code, v_opening, v_expected, p_amount);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_commission_cash_method_minimum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.amount = NEW.amount
     AND OLD.method_code = NEW.method_code
     AND OLD.cash_shift_id = NEW.cash_shift_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.enforce_cash_method_minimum(
    NEW.cash_shift_id, NEW.method_code, NEW.amount,
    CASE WHEN TG_OP = 'UPDATE' AND OLD.cash_shift_id = NEW.cash_shift_id AND OLD.method_code = NEW.method_code
         THEN OLD.amount ELSE NULL END
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_voucher_cash_method_minimum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Same definition as the balance: only a cash-out voucher moves money.
  -- Payroll moving it aprobada <-> descontada keeps the same outflow.
  IF NOT public.voucher_is_cash_out(NEW.status, NEW.approved_by, NEW.method_code, NEW.cash_shift_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND public.voucher_is_cash_out(OLD.status, OLD.approved_by, OLD.method_code, OLD.cash_shift_id)
     AND OLD.amount = NEW.amount
     AND OLD.method_code = NEW.method_code
     AND OLD.cash_shift_id = NEW.cash_shift_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.enforce_cash_method_minimum(
    NEW.cash_shift_id, NEW.method_code, NEW.amount,
    CASE WHEN TG_OP = 'UPDATE'
              AND public.voucher_is_cash_out(OLD.status, OLD.approved_by, OLD.method_code, OLD.cash_shift_id)
              AND OLD.cash_shift_id = NEW.cash_shift_id
              AND OLD.method_code = NEW.method_code
         THEN OLD.amount ELSE NULL END
  );
  RETURN NEW;
END;
$$;

-- 7b. Collections are also inputs of the balance. The invoice edit RPCs of
--     001 legally move an invoice_payments row to another method with the same
--     fee; `payments` has no update path in the code, but a direct UPDATE must
--     not bypass the rule either. A move is allowed only when BOTH affected
--     (shift, method) pairs keep their floor after it. Locks: cash_shifts
--     FOR SHARE, then balance rows FOR UPDATE ordered by (shift, method).
--     An unchanged rewrite (same shift/method/amount) is a no-op, so the edit
--     RPCs keep their current behavior. Stable code:
--     CASH_METHOD_BALANCE_UPDATE_BREACH.
CREATE OR REPLACE FUNCTION public.enforce_collection_move_minimum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_pair record;
  v_old_counts boolean;
  v_new_counts boolean;
  v_delta numeric(12,2);
BEGIN
  IF NEW.amount = OLD.amount
     AND NEW.method_code IS NOT DISTINCT FROM OLD.method_code
     AND NEW.cash_shift_id IS NOT DISTINCT FROM OLD.cash_shift_id
     AND (TG_TABLE_NAME <> 'payments' OR NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id) THEN
    RETURN NEW;
  END IF;

  -- `payments` rows with an invoice are mirrors: the balance counts only the
  -- drawer rows without invoice.
  v_old_counts := TG_TABLE_NAME = 'invoice_payments' OR OLD.invoice_id IS NULL;
  v_new_counts := TG_TABLE_NAME = 'invoice_payments' OR NEW.invoice_id IS NULL;

  -- Lock order (global): cash_shifts -> balances (ordered). Both affected
  -- shifts are locked whether or not they have balance rows.
  PERFORM 1 FROM public.cash_shifts s
   WHERE s.id IN (OLD.cash_shift_id, NEW.cash_shift_id)
   ORDER BY s.id FOR SHARE OF s;

  -- A shift is governed by the configuration it opened with:
  --   * a shift opened before 003 has no frozen balance at all;
  --   * a method that became arqueable after the shift opened has no frozen
  --     balance in that shift.
  -- Either way, a real change that touches such a (shift, method) on the
  -- SOURCE or the TARGET side is rejected: no income edit may alter an
  -- arqueable availability without a frozen base. A method frozen in the
  -- shift and later marked 'none' keeps its row and stays validated below.
  -- Unchanged rewrites returned above.
  IF EXISTS (
    SELECT 1
      FROM (VALUES (OLD.cash_shift_id, OLD.method_code), (NEW.cash_shift_id, NEW.method_code))
           AS affected(cash_shift_id, method_code)
     WHERE affected.cash_shift_id IS NOT NULL
       AND (
         NOT EXISTS (SELECT 1 FROM public.cash_shift_method_balances b
                      WHERE b.cash_shift_id = affected.cash_shift_id)
         OR (
           EXISTS (SELECT 1 FROM public.payment_methods pm
                    WHERE pm.code = affected.method_code AND pm.arqueo_mode <> 'none')
           AND NOT EXISTS (SELECT 1 FROM public.cash_shift_method_balances b
                            WHERE b.cash_shift_id = affected.cash_shift_id
                              AND b.method_code = affected.method_code)
         )
       )
  ) THEN
    RAISE EXCEPTION 'CASH_METHOD_BALANCE_REQUIRED'
      USING DETAIL = 'Cierre y abra de nuevo el turno para usar arqueo por método.';
  END IF;

  FOR v_pair IN
    SELECT b.cash_shift_id, b.method_code, b.opening_base
      FROM public.cash_shift_method_balances b
     WHERE (v_old_counts AND b.cash_shift_id = OLD.cash_shift_id AND b.method_code = OLD.method_code)
        OR (v_new_counts AND b.cash_shift_id = NEW.cash_shift_id AND b.method_code = NEW.method_code)
     ORDER BY b.cash_shift_id, b.method_code
     FOR UPDATE OF b
  LOOP
    v_delta := 0;
    IF v_old_counts AND v_pair.cash_shift_id = OLD.cash_shift_id AND v_pair.method_code = OLD.method_code THEN
      v_delta := v_delta - OLD.amount;
    END IF;
    IF v_new_counts AND v_pair.cash_shift_id = NEW.cash_shift_id AND v_pair.method_code = NEW.method_code THEN
      v_delta := v_delta + NEW.amount;
    END IF;
    -- Only a decrease can breach; an increase or a neutral rewrite is allowed.
    IF v_delta < 0
       AND public.cash_shift_method_expected_balance(v_pair.cash_shift_id, v_pair.method_code) + v_delta
           < round(v_pair.opening_base * 0.5, 2) THEN
      RAISE EXCEPTION 'CASH_METHOD_BALANCE_UPDATE_BREACH'
        USING DETAIL = format('method=%s shift=%s', v_pair.method_code, v_pair.cash_shift_id);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_payments_balance_guard ON public.invoice_payments;
CREATE TRIGGER trg_invoice_payments_balance_guard
  BEFORE UPDATE OF amount, method_code, cash_shift_id ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();

DROP TRIGGER IF EXISTS trg_payments_balance_guard ON public.payments;
CREATE TRIGGER trg_payments_balance_guard
  BEFORE UPDATE OF amount, method_code, cash_shift_id, invoice_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_move_minimum();

-- 7c. GLOBAL LOCK ORDER for cash, invoices, collections, commissions and
--     vouchers (every path takes a prefix of it, never in another order):
--       cash_shifts (FOR SHARE, ordered by id)
--       -> cash_shift_method_balances (FOR UPDATE, ordered by shift, code)
--       -> invoices (FOR UPDATE)
--       -> products (inventory trigger of 001, ordered by id)
--     Commission payout: shift -> balance (003 trigger) -> invoice (001 cap).
--     Voucher: shift -> balance. Collection: shift -> invoice (001).
--     Invoice edit: 001's RPCs lock the invoice FIRST and then update
--     invoice_payments, whose 003 guard would lock shift/balance AFTER the
--     invoice: the reverse of a commission payout (deadlock). So the edit RPCs
--     are versioned below: their public wrapper locks the shifts and balances
--     of every payment whose method changes BEFORE calling 001's body, and the
--     guard then finds those locks already held. No body of 001 is changed.
CREATE OR REPLACE FUNCTION public.lock_invoice_edit_payment_balances(
  p_invoice_id uuid,
  p_edit jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- A malformed payload takes no lock: 001's body rejects it.
  IF p_invoice_id IS NULL
     OR jsonb_typeof(p_edit) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_edit -> 'payments') IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;

  -- Only payments whose method changes can move money between balances.
  -- First the cash_shifts of those payments.
  PERFORM 1 FROM public.cash_shifts s
   WHERE s.id IN (
     SELECT ip.cash_shift_id
       FROM jsonb_array_elements(p_edit -> 'payments') AS item
       JOIN public.invoice_payments ip
         ON ip.id::text = lower(item ->> 'id') AND ip.invoice_id = p_invoice_id
      WHERE item ->> 'method_code' IS DISTINCT FROM ip.method_code)
   ORDER BY s.id FOR SHARE OF s;

  -- Then their cash_shift_method_balances: source and target method.
  PERFORM 1 FROM public.cash_shift_method_balances b
   WHERE (b.cash_shift_id, b.method_code) IN (
     SELECT ip.cash_shift_id, pair.method_code
       FROM jsonb_array_elements(p_edit -> 'payments') AS item
       JOIN public.invoice_payments ip
         ON ip.id::text = lower(item ->> 'id') AND ip.invoice_id = p_invoice_id
       CROSS JOIN LATERAL (VALUES (ip.method_code), (item ->> 'method_code')) AS pair(method_code)
      WHERE item ->> 'method_code' IS DISTINCT FROM ip.method_code)
   ORDER BY b.cash_shift_id, b.method_code FOR UPDATE OF b;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.invoice_edit_items_atomic_legacy(uuid,uuid,integer,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb)
      RENAME TO invoice_edit_items_atomic_legacy;
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.invoice_edit_emitted_atomic_legacy(uuid,uuid,integer,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb)
      RENAME TO invoice_edit_emitted_atomic_legacy;
  END IF;
END;
$$;

-- The legacy bodies keep 001's service_role-only ACL so the public wrappers
-- can invoke them without changing SECURITY DEFINER semantics.
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic_legacy(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_items_atomic_legacy(uuid, uuid, integer, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic_legacy(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_emitted_atomic_legacy(uuid, uuid, integer, text, jsonb) TO service_role;

-- Same signature, same return and attributes as 001 (plpgsql, not SECURITY
-- DEFINER, search_path public): the services call them unchanged.
CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.lock_invoice_edit_payment_balances(p_invoice_id, p_edit);
  RETURN public.invoice_edit_items_atomic_legacy(
    p_invoice_id, p_user_id, p_expected_version, p_expected_status, p_edit);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_edit jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.lock_invoice_edit_payment_balances(p_invoice_id, p_edit);
  RETURN public.invoice_edit_emitted_atomic_legacy(
    p_invoice_id, p_user_id, p_expected_version, p_expected_status, p_edit);
END;
$$;

COMMENT ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) IS
  '003: locks the shifts and method balances of re-methoded payments (global order cash_shifts -> balances -> invoices), then runs 001''s admin edit verbatim (invoice_edit_items_atomic_legacy).';
COMMENT ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) IS
  '003: locks the shifts and method balances of re-methoded payments (global order cash_shifts -> balances -> invoices), then runs 001''s free edit verbatim (invoice_edit_emitted_atomic_legacy).';

DROP TRIGGER IF EXISTS trg_commission_payouts_balance_guard ON public.commission_payouts;
CREATE TRIGGER trg_commission_payouts_balance_guard
  BEFORE INSERT OR UPDATE OF amount, method_code, cash_shift_id ON public.commission_payouts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_commission_cash_method_minimum();

DROP TRIGGER IF EXISTS trg_voucher_requests_balance_guard ON public.voucher_requests;
CREATE TRIGGER trg_voucher_requests_balance_guard
  BEFORE INSERT OR UPDATE OF amount, method_code, cash_shift_id, status, approved_by ON public.voucher_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_voucher_cash_method_minimum();

-- 8. Execution grants follow 001: business RPCs are service_role only.
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cash_shift_method_expected_balance(uuid, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cash_shift_method_expected_balance(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.enforce_cash_method_minimum(uuid, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_commission_cash_method_minimum() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_voucher_cash_method_minimum() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_voucher_cash_out_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_collection_move_minimum() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.voucher_is_cash_out(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_method_code_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_invoice_edit_payment_balances(uuid, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_invoice_edit_payment_balances(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb) TO service_role;

COMMIT;
