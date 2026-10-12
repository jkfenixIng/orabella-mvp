-- 009_cash_opening_bounds.sql
--
-- Physical drawer bounds at opening. The cash counted by denominations (C)
-- must satisfy  M <= C <= B, where:
--   B = cash_registers.base_configurada of the register;
--   M = base_left of the register's last close (a recount's base_left wins);
--       0 on the very first opening.
-- A previous M above B can never be satisfied: OPENING_BASE_CONFLICT.
--
-- The service checks the same rule first with the amounts in the message.
-- This wrapper re-checks it under the register lock (taken by the 001 opener)
-- plus a lock on the last closed shift, so a concurrent close, recount or base
-- change cannot slip between the service read and the write.
--
-- Arithmetic: no new money is computed. C is the total of the incoming
-- denomination lines (the same jsonb sum 003 already uses to freeze each
-- method balance); M and B are read verbatim. The comparison is the guard.
--
-- Same signature and 003 behavior. CREATE OR REPLACE preserves prior grants,
-- so the explicit ACL below is required to deny Supabase's anon/authenticated
-- defaults. The wrapper is SECURITY INVOKER, therefore service_role also needs
-- EXECUTE on its internal legacy callee. Transactional and idempotent.
BEGIN;

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
  v_base numeric;
  v_last_closed_shift_id uuid;
  v_minimum numeric;
  v_recount_minimum numeric;
  v_drawer numeric;
BEGIN
  -- 003: count lines must match the method's mode.
  IF jsonb_typeof(p_counts) = 'array' AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_counts) AS item
      JOIN public.payment_methods pm ON pm.code = btrim(item ->> 'method_code')
     WHERE (pm.arqueo_mode = 'denominations' AND coalesce(item ->> 'denomination', '') = '')
        OR (pm.arqueo_mode = 'declared_total' AND coalesce(item ->> 'denomination', '') <> '')
  ) THEN
    RAISE EXCEPTION 'SHIFT_INVALID';
  END IF;

  -- 001 opener: validates the payload, locks the register (FOR UPDATE) and
  -- writes the shift and its counts. Any exception below rolls all of it back.
  v_shift := public.cash_open_shift_atomic_legacy(p_register_id, p_opened_by, p_opening_base, p_counts);

  -- 009: bounds, read with the register already locked by the opener.
  SELECT r.base_configurada INTO v_base
    FROM public.cash_registers r
   WHERE r.id = p_register_id;

  SELECT s.id, s.base_left INTO v_last_closed_shift_id, v_minimum
    FROM public.cash_shifts s
   WHERE s.cash_register_id = p_register_id
     AND s.status = 'cerrado'
   ORDER BY s.closed_at DESC, s.opened_at DESC, s.id DESC
   LIMIT 1
   FOR UPDATE OF s;

  IF v_last_closed_shift_id IS NOT NULL THEN
    SELECT rc.base_left INTO v_recount_minimum
      FROM public.cash_shift_recounts rc
     WHERE rc.shift_id = v_last_closed_shift_id;

    IF FOUND THEN
      v_minimum := v_recount_minimum;
    END IF;
  END IF;

  SELECT coalesce(sum((item ->> 'amount')::numeric), 0) INTO v_drawer
    FROM jsonb_array_elements(p_counts) AS item
    JOIN public.payment_methods pm ON pm.code = btrim(item ->> 'method_code')
   WHERE pm.is_active AND pm.arqueo_mode = 'denominations';

  IF EXISTS (
    SELECT 1 FROM public.payment_methods pm
     WHERE pm.is_active AND pm.arqueo_mode = 'denominations'
  ) THEN
    IF round(coalesce(v_minimum, 0)) > round(v_base) THEN
      RAISE EXCEPTION 'OPENING_BASE_CONFLICT';
    END IF;
    IF round(v_drawer) > round(v_base) THEN
      RAISE EXCEPTION 'OPENING_ABOVE_BASE';
    END IF;
    IF round(v_drawer) < round(coalesce(v_minimum, 0)) THEN
      RAISE EXCEPTION 'OPENING_BELOW_PREVIOUS_CLOSE';
    END IF;
  END IF;

  -- 003: every active arqueable method declares and freezes its own base.
  SELECT count(*) INTO v_expected
    FROM public.payment_methods pm
   WHERE pm.is_active AND pm.arqueo_mode <> 'none';

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
  '009: 003 opening wrapper (001 logic as cash_open_shift_atomic_legacy + one frozen base per active arqueable method) plus physical drawer bounds re-checked under lock: the denomination total must be >= the last close base_left (recount wins; 0 on first opening) and <= cash_registers.base_configurada. OPENING_ABOVE_BASE, OPENING_BELOW_PREVIOUS_CLOSE, OPENING_BASE_CONFLICT, SHIFT_BALANCE_MISMATCH, SHIFT_INVALID. Only service_role can execute it.';

-- Supabase grants EXECUTE to anon/authenticated by default; revoking PUBLIC alone
-- leaves those role-specific grants. The wrapper is SECURITY INVOKER and calls
-- the legacy function, so service_role retains the internal EXECUTE it needs.
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_open_shift_atomic(uuid, uuid, numeric, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cash_open_shift_atomic_legacy(uuid, uuid, numeric, jsonb) TO service_role;

COMMIT;
