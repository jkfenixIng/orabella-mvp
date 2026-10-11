-- 007_money_cap_policy.sql
--
-- Whole-peso cap policy for new COP writes and legacy rows with cents.
--
-- New writes are guarded by 005 and are whole pesos. Historical numeric(12,2)
-- values remain untouched: their persisted approval/status and non-monetary
-- updates continue to work. Cap decisions project both accumulated and cap
-- amounts with round(...), matching src/shared/money/caps.ts.
--
-- No data is rewritten. Existing triggers keep their bindings because only the
-- function bodies are replaced. The cash minimum uses a whole-peso 50% floor;
-- its expected balance remains the physical ledger sum, so net + fee identities
-- are not changed here.
BEGIN;

CREATE OR REPLACE FUNCTION public.check_commission_payouts_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_invoice_id uuid;
  v_earned numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  SELECT id INTO v_invoice_id FROM public.invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id; END IF;
  v_earned := NEW.earned_immediate;
  IF v_earned IS NULL THEN
    RAISE EXCEPTION 'El pago inmediato no trae el ganado de la comisión (earned_immediate): sin ese valor la base no puede aplicar el tope';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_paid FROM public.commission_payouts
   WHERE invoice_id = NEW.invoice_id AND employee_id = NEW.employee_id;
  IF round(v_paid + coalesce(NEW.amount, 0)) > round(v_earned) THEN
    RAISE EXCEPTION 'El pago supera la comisión ganada del par (factura %, empleado %): ganado %, pagado %, nuevo %', NEW.invoice_id, NEW.employee_id, v_earned, v_paid, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_invoice_payments_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_total numeric(12, 2);
  v_surcharge numeric(12, 2);
  v_paid_net numeric(12, 2);
  v_new_net numeric(12, 2);
BEGIN
  SELECT total, surcharge INTO v_total, v_surcharge FROM public.invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Factura inexistente (%)', NEW.invoice_id; END IF;
  v_new_net := coalesce(NEW.amount, 0) - coalesce(NEW.fee_amount, 0);
  SELECT coalesce(sum(amount - fee_amount), 0) INTO v_paid_net FROM public.invoice_payments WHERE invoice_id = NEW.invoice_id;
  IF round(v_paid_net + v_new_net) > round(v_total - coalesce(v_surcharge, 0)) THEN
    RAISE EXCEPTION 'El cobro supera el neto facturado de la factura (total %, recargo %, cobrado neto %, nuevo neto %)', v_total, coalesce(v_surcharge, 0), v_paid_net, v_new_net;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_payroll_payments_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_net numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  SELECT net_pay INTO v_net FROM public.payroll_items WHERE id = NEW.payroll_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ítem de nómina inexistente (%)', NEW.payroll_item_id; END IF;
  SELECT coalesce(sum(amount), 0) INTO v_paid FROM public.payroll_payments WHERE payroll_item_id = NEW.payroll_item_id;
  IF round(v_paid + NEW.amount) > round(v_net) THEN
    RAISE EXCEPTION 'El pago supera el neto del ítem (neto %, pagado %, nuevo %)', v_net, v_paid, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$;

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
  IF p_shift_id IS NULL OR p_method_code IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM public.cash_shifts s WHERE s.id = p_shift_id FOR SHARE OF s;
  SELECT b.opening_base INTO v_opening FROM public.cash_shift_method_balances b
   WHERE b.cash_shift_id = p_shift_id AND b.method_code = p_method_code FOR UPDATE OF b;
  IF NOT FOUND THEN
    SELECT pm.arqueo_mode INTO v_mode FROM public.payment_methods pm WHERE pm.code = p_method_code;
    IF coalesce(v_mode, 'none') = 'none' THEN RETURN; END IF;
    RAISE EXCEPTION 'CASH_METHOD_BALANCE_REQUIRED' USING DETAIL = 'Cierre y abra de nuevo el turno para usar arqueo por método.';
  END IF;
  v_expected := public.cash_shift_method_expected_balance(p_shift_id, p_method_code) + coalesce(p_old_amount, 0);
  IF round(v_expected) - round(p_amount) < round(round(v_opening) * 0.5) THEN
    RAISE EXCEPTION 'CASH_METHOD_MINIMUM_BREACH'
      USING DETAIL = format('method=%s opening=%s expected=%s amount=%s', p_method_code, v_opening, v_expected, p_amount);
  END IF;
END;
$$;

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
  IF NEW.amount = OLD.amount AND NEW.method_code IS NOT DISTINCT FROM OLD.method_code
     AND NEW.cash_shift_id IS NOT DISTINCT FROM OLD.cash_shift_id
     AND (TG_TABLE_NAME <> 'payments' OR NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id) THEN RETURN NEW; END IF;
  v_old_counts := TG_TABLE_NAME = 'invoice_payments' OR OLD.invoice_id IS NULL;
  v_new_counts := TG_TABLE_NAME = 'invoice_payments' OR NEW.invoice_id IS NULL;
  PERFORM 1 FROM public.cash_shifts s WHERE s.id IN (OLD.cash_shift_id, NEW.cash_shift_id) ORDER BY s.id FOR SHARE OF s;
  IF EXISTS (
    SELECT 1 FROM (VALUES (OLD.cash_shift_id, OLD.method_code), (NEW.cash_shift_id, NEW.method_code)) AS affected(cash_shift_id, method_code)
    WHERE affected.cash_shift_id IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM public.cash_shift_method_balances b WHERE b.cash_shift_id = affected.cash_shift_id)
      OR (EXISTS (SELECT 1 FROM public.payment_methods pm WHERE pm.code = affected.method_code AND pm.arqueo_mode <> 'none')
          AND NOT EXISTS (SELECT 1 FROM public.cash_shift_method_balances b WHERE b.cash_shift_id = affected.cash_shift_id AND b.method_code = affected.method_code))
    )
  ) THEN RAISE EXCEPTION 'CASH_METHOD_BALANCE_REQUIRED' USING DETAIL = 'Cierre y abra de nuevo el turno para usar arqueo por método.'; END IF;
  FOR v_pair IN
    SELECT b.cash_shift_id, b.method_code, b.opening_base FROM public.cash_shift_method_balances b
    WHERE (v_old_counts AND b.cash_shift_id = OLD.cash_shift_id AND b.method_code = OLD.method_code)
       OR (v_new_counts AND b.cash_shift_id = NEW.cash_shift_id AND b.method_code = NEW.method_code)
    ORDER BY b.cash_shift_id, b.method_code FOR UPDATE OF b
  LOOP
    v_delta := 0;
    IF v_old_counts AND v_pair.cash_shift_id = OLD.cash_shift_id AND v_pair.method_code = OLD.method_code THEN v_delta := v_delta - OLD.amount; END IF;
    IF v_new_counts AND v_pair.cash_shift_id = NEW.cash_shift_id AND v_pair.method_code = NEW.method_code THEN v_delta := v_delta + NEW.amount; END IF;
    IF v_delta < 0
       AND round(public.cash_shift_method_expected_balance(v_pair.cash_shift_id, v_pair.method_code) + v_delta) < round(round(v_pair.opening_base) * 0.5) THEN
      RAISE EXCEPTION 'CASH_METHOD_BALANCE_UPDATE_BREACH' USING DETAIL = format('method=%s shift=%s', v_pair.method_code, v_pair.cash_shift_id);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_commission_payouts_cap() IS
  '007: cap in whole pesos. New writes are whole pesos; preserved legacy cents are compared after round(), with no data rewrite.';
COMMENT ON FUNCTION public.check_invoice_payments_cap() IS
  '007: net invoice-payment cap in whole pesos. Legacy invoice cents are projected with round(), with no data rewrite.';
COMMENT ON FUNCTION public.check_payroll_payments_cap() IS
  '007: payroll-payment cap in whole pesos; retains the parent-row lock for concurrent writers.';
COMMENT ON FUNCTION public.enforce_cash_method_minimum(uuid, text, numeric, numeric) IS
  '007: cash minimum compares rounded whole pesos and a rounded 50% floor; ledger arithmetic and stored historical cents remain unchanged.';
COMMENT ON FUNCTION public.enforce_collection_move_minimum() IS
  '007: collection moves compare rounded whole-peso balances against the rounded 50% floor.';

COMMIT;
