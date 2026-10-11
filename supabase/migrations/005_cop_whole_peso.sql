-- 005_cop_whole_peso.sql
--
-- COP whole-peso policy, enforced additively in the database.
--
-- Business rule (owner decision): every COP amount is a whole peso. The app
-- rounds decimal input (src/shared/money/cop.ts); this migration is the
-- physical defense for NEW money writes.
--
-- Constraints of this migration:
--   * numeric(12,2) column types are NOT changed and NOTHING is backfilled:
--     historical rows with cents stay exactly as stored.
--   * INSERT validates every guarded column. UPDATE validates a guarded column
--     ONLY when NEW.col IS DISTINCT FROM OLD.col, so a legacy row with cents can
--     still change status, edit_version, method, etc.
--   * Stable error: SQLSTATE P0001, MESSAGE 'COP_WHOLE_PESO_REQUIRED' (the
--     services translate it to a 400 validation error).
--
-- Guarded columns (direct money inputs written by the app or an RPC that only
-- forwards app-computed values):
--   cash_denominations.value            cash_registers.base_configurada
--   employees.salary_fixed               cash_shift_counts.denomination, amount
--   cash_shifts.opening_base, counted_cash, base_left, cash_withdrawn, base_difference
--   cash_shift_recounts.counted_cash, base_left, cash_withdrawn, base_difference
--   commission_rules.amount             commission_payouts.amount
--   invoices.discount                   invoice_items.unit_price, discount, commission_value
--   invoice_payments.amount             payments.amount
--   payroll_items.bonuses, other_discounts
--   payroll_period_correction_items.corrected_bonuses, corrected_other_discounts
--   payroll_payments.amount             payroll_extras.amount
--   payroll_discount_carries.amount     voucher_requests.amount
--   products.cost_price, sale_price, commission_value
--   services.price                      voucher_settings.max_per_day, max_per_week
--   system_settings voucher_max_per_day/voucher_max_per_week {amount} and
--   voucher_per_day_limits {limits} (per changed entry)
--
-- Excluded columns and why:
--   * Snapshots of history: cash_shift_recounts.previous_*,
--     payroll_period_correction_items.previous_*, payroll_period_corrections.previous_*.
--   * SQL- or identity-derived values that may legitimately carry the cents of a
--     legacy row they are derived from:
--       invoices.subtotal, tax, total, surcharge (CHECK identity with a legacy
--         surcharge keeps its cents in total on edit);
--       invoice_items.subtotal; invoice_taxes.amount;
--       invoice_payments.fee_amount (gross - net split);
--       cash_shifts.expected_cash; cash_shift_method_balances.opening_base
--         (sum of validated count lines, frozen by 003);
--       commission_payouts.base_subtotal, fixed_applied, earned_immediate;
--       payroll_items.base_fixed, commissions, deductions_vales, net_pay, voucher_total;
--       payroll_period_correction_items.corrected_base_fixed, corrected_commissions,
--         corrected_deductions_vales, corrected_net_pay;
--       payroll_period_corrections.corrected_net_total.
--     The 003 cash minimum (round(opening * 0.5, 2)) is only compared, never stored.
--   * Percentages are not money: percent, fee_percent, commission_percent,
--     commission_percent_override, percent_applied (numeric(5,2)).
--
-- Read-only audit: public.cop_legacy_cents_audit counts preserved rows with
-- cents per table/column for every numeric(12,2) money column.
--
-- Idempotent: CREATE OR REPLACE / DROP TRIGGER IF EXISTS. Transactional.
BEGIN;

CREATE OR REPLACE FUNCTION public.assert_cop_whole_peso()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_col text;
  v_new numeric;
  v_old numeric;
  v_new_row jsonb := to_jsonb(NEW);
  v_old_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
BEGIN
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    v_new := (v_new_row ->> v_col)::numeric;
    IF TG_OP = 'UPDATE' THEN
      v_old := (v_old_row ->> v_col)::numeric;
      CONTINUE WHEN v_new IS NOT DISTINCT FROM v_old;
    END IF;
    IF v_new IS NOT NULL AND v_new <> trunc(v_new) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'COP_WHOLE_PESO_REQUIRED',
        DETAIL = format('%s.%s', TG_TABLE_NAME, v_col),
        HINT = 'COP amounts must be whole pesos.';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('cash_denominations', ARRAY['value']),
      ('cash_registers', ARRAY['base_configurada']),
      ('cash_shift_counts', ARRAY['denomination', 'amount']),
      ('cash_shift_recounts', ARRAY['counted_cash', 'base_left', 'cash_withdrawn', 'base_difference']),
      ('cash_shifts', ARRAY['opening_base', 'counted_cash', 'base_left', 'cash_withdrawn', 'base_difference']),
      ('commission_rules', ARRAY['amount']),
      ('employees', ARRAY['salary_fixed']),
      ('commission_payouts', ARRAY['amount']),
      ('invoices', ARRAY['discount']),
      ('invoice_items', ARRAY['unit_price', 'discount', 'commission_value']),
      ('invoice_payments', ARRAY['amount']),
      ('payments', ARRAY['amount']),
      ('payroll_items', ARRAY['bonuses', 'other_discounts']),
      ('payroll_period_correction_items', ARRAY['corrected_bonuses', 'corrected_other_discounts']),
      ('payroll_discount_carries', ARRAY['amount']),
      ('payroll_extras', ARRAY['amount']),
      ('payroll_payments', ARRAY['amount']),
      ('products', ARRAY['cost_price', 'sale_price', 'commission_value']),
      ('services', ARRAY['price']),
      ('voucher_requests', ARRAY['amount']),
      ('voucher_settings', ARRAY['max_per_day', 'max_per_week'])
    ) AS guarded(table_name, columns)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_cop_whole_peso ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_cop_whole_peso BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.assert_cop_whole_peso(%s)',
      r.table_name,
      (SELECT string_agg(quote_literal(c), ', ') FROM unnest(r.columns) AS c)
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_cop_whole_peso_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_new numeric;
  v_old numeric;
  v_entry record;
BEGIN
  IF NEW.key IN ('voucher_max_per_day', 'voucher_max_per_week') THEN
    v_new := nullif(NEW.value ->> 'amount', '')::numeric;
    IF TG_OP = 'UPDATE' THEN
      v_old := nullif(OLD.value ->> 'amount', '')::numeric;
      IF v_new IS NOT DISTINCT FROM v_old THEN
        RETURN NEW;
      END IF;
    END IF;
    IF v_new IS NOT NULL AND v_new <> trunc(v_new) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COP_WHOLE_PESO_REQUIRED',
        DETAIL = format('system_settings.%s', NEW.key), HINT = 'COP amounts must be whole pesos.';
    END IF;
  ELSIF NEW.key = 'voucher_per_day_limits' AND jsonb_typeof(NEW.value -> 'limits') = 'object' THEN
    FOR v_entry IN SELECT key, value FROM jsonb_each_text(NEW.value -> 'limits') LOOP
      CONTINUE WHEN TG_OP = 'UPDATE'
        AND (OLD.value -> 'limits' ->> v_entry.key) IS NOT DISTINCT FROM v_entry.value;
      v_new := nullif(v_entry.value, '')::numeric;
      IF v_new IS NOT NULL AND v_new <> trunc(v_new) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'COP_WHOLE_PESO_REQUIRED',
          DETAIL = 'system_settings.voucher_per_day_limits', HINT = 'COP amounts must be whole pesos.';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cop_whole_peso_settings ON public.system_settings;
CREATE TRIGGER trg_cop_whole_peso_settings
  BEFORE INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.assert_cop_whole_peso_settings();

-- Read-only audit of preserved legacy cents: one row per numeric(12,2) money
-- column of the public schema (percentages are numeric(5,2) and never listed).
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT string_agg(
           format(
             'SELECT %L::text AS table_name, %L::text AS column_name, count(*)::bigint AS row_count FROM public.%I WHERE %I IS NOT NULL AND %I <> trunc(%I)',
             c.table_name, c.column_name, c.table_name, c.column_name, c.column_name, c.column_name
           ),
           ' UNION ALL ' ORDER BY c.table_name, c.column_name
         )
    INTO v_body
    FROM information_schema.columns AS c
    JOIN information_schema.tables AS t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public'
     AND c.data_type = 'numeric'
     AND c.numeric_precision = 12
     AND c.numeric_scale = 2;
  EXECUTE 'CREATE OR REPLACE VIEW public.cop_legacy_cents_audit WITH (security_invoker = true) AS ' || v_body;
END;
$$;

COMMENT ON VIEW public.cop_legacy_cents_audit IS
  '005: read-only count of preserved legacy rows with cents per numeric(12,2) money column. Historical data is never rewritten.';
COMMENT ON FUNCTION public.assert_cop_whole_peso() IS
  '005: trigger guard. INSERT checks every listed column; UPDATE checks only changed columns. P0001 COP_WHOLE_PESO_REQUIRED.';
COMMENT ON FUNCTION public.assert_cop_whole_peso_settings() IS
  '005: whole-peso guard for the voucher money keys of system_settings, checking only changed amounts.';

REVOKE ALL ON FUNCTION public.assert_cop_whole_peso() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_cop_whole_peso() FROM anon;
REVOKE ALL ON FUNCTION public.assert_cop_whole_peso() FROM authenticated;
GRANT ALL ON FUNCTION public.assert_cop_whole_peso() TO service_role;
REVOKE ALL ON FUNCTION public.assert_cop_whole_peso_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_cop_whole_peso_settings() FROM anon;
REVOKE ALL ON FUNCTION public.assert_cop_whole_peso_settings() FROM authenticated;
GRANT ALL ON FUNCTION public.assert_cop_whole_peso_settings() TO service_role;
REVOKE ALL ON public.cop_legacy_cents_audit FROM PUBLIC;
REVOKE ALL ON public.cop_legacy_cents_audit FROM anon;
REVOKE ALL ON public.cop_legacy_cents_audit FROM authenticated;
GRANT SELECT ON public.cop_legacy_cents_audit TO service_role;

COMMIT;
