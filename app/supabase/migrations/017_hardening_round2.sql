-- 017_hardening_round2.sql — Endurecimiento post-revisión pre-pruebas (DB1/DB2).
--
-- Cierra hallazgos de advisors security+performance del 2026-09-22:
-- 1. RLS ausente en cash_denominations y cash_shift_counts (ERROR crítico).
-- 2. Políticas permisivas USING(true) en commission_rules/payouts (de 016).
-- 3. search_path mutable en 5 funciones (WARN).
-- 4. SECURITY DEFINER ejecutable por anon (WARN): se revoca anon, se conserva authenticated.
-- 5. FK sin índice de cobertura (INFO performance, 23 casos): se agregan índices críticos.
-- 6. Elegibilidad de comisión: payout_mode admite 'no_aplica' para empleados sin acuerdo.
--
-- Patrón RLS: igual que 008 (claim JWT app_metadata.sede_id vía current_sede_id(),
-- service_role hace bypass en servidor). Sin JWT/claim => deny-by-default.

-- ------------------------------------------------- 6. payout_mode N/A ---
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_payout_mode') THEN
    ALTER TABLE public.employees DROP CONSTRAINT chk_employees_payout_mode;
  END IF;
  ALTER TABLE public.employees
    ADD CONSTRAINT chk_employees_payout_mode CHECK (payout_mode IN ('nomina', 'inmediato', 'no_aplica'));
END
$$;

COMMENT ON COLUMN public.employees.payout_mode IS
  'Preferencia de cobro: nomina, inmediato desde caja, o no_aplica (sin acuerdo de comisión).';

-- ------------------------------------------------- 1. RLS faltante ---
ALTER TABLE public.cash_denominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_shift_counts ENABLE ROW LEVEL SECURITY;

-- Denominaciones: catálogo por sede, lectura/escritura por sede (escritura fina por rol la aplica el servidor).
DROP POLICY IF EXISTS pol_cash_denominations_sede_isolation ON public.cash_denominations;
CREATE POLICY pol_cash_denominations_sede_isolation ON public.cash_denominations
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- Conteos: sede del turno padre (sin sede_id propia).
DROP POLICY IF EXISTS pol_shift_counts_sede_isolation ON public.cash_shift_counts;
CREATE POLICY pol_shift_counts_sede_isolation ON public.cash_shift_counts
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.cash_shifts s
    WHERE s.id = cash_shift_counts.shift_id
      AND s.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.cash_shifts s
    WHERE s.id = cash_shift_counts.shift_id
      AND s.sede_id = public.current_sede_id()
  ));

-- --------------------------------------- 2. comisiones: cierra USING(true) ---
DROP POLICY IF EXISTS pol_commission_rules_sede_isolation ON public.commission_rules;
DROP POLICY IF EXISTS pol_commission_payouts_sede_isolation ON public.commission_payouts;

CREATE POLICY pol_commission_rules_sede_isolation ON public.commission_rules
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_commission_payouts_sede_isolation ON public.commission_payouts
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- ------------------------------------------------- 3. search_path fijo ---
-- Idempotente: fija search_path en funciones con WARN de mutable.
DO $$
BEGIN
  PERFORM 1 FROM pg_proc WHERE proname = 'check_payroll_payments_cap';
  IF FOUND THEN
    EXECUTE 'ALTER FUNCTION public.check_payroll_payments_cap() SET search_path = public';
  END IF;
EXCEPTION WHEN undefined_function THEN NULL;
END
$$;

-- next_invoice_number tiene firma con args; se cubren variantes habituales.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT oid::regprocedure AS fn FROM pg_proc WHERE proname = 'next_invoice_number' AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.fn);
  END LOOP;
  FOR r IN SELECT oid::regprocedure AS fn FROM pg_proc WHERE proname IN ('inventory_apply_stock','inventory_no_negative_stock','set_updated_at') AND pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.fn);
  END LOOP;
END
$$;

-- --------------------------------------- 4. revoca anon en DEFINER ---
REVOKE EXECUTE ON FUNCTION public.current_sede_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.current_sede_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) TO authenticated;

-- ------------------------------------------------- 5. índices FK ---
CREATE INDEX IF NOT EXISTS idx_commission_rules_employee ON public.commission_rules (employee_id);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_shift ON public.commission_payouts (cash_shift_id);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_paid_by ON public.commission_payouts (paid_by);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON public.invoice_items (product_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_service ON public.invoice_items (service_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_method ON public.invoice_payments (method_id);
CREATE INDEX IF NOT EXISTS idx_invoices_cash_shift ON public.invoices (cash_shift_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON public.invoices (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_method ON public.payments (method_id);
CREATE INDEX IF NOT EXISTS idx_payments_sede ON public.payments (sede_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON public.payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_method ON public.payroll_payments (method_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_paid_by ON public.payroll_payments (paid_by);
CREATE INDEX IF NOT EXISTS idx_payroll_periods_created_by ON public.payroll_periods (created_by);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles (role_id);
CREATE INDEX IF NOT EXISTS idx_users_sede ON public.users (sede_id);
CREATE INDEX IF NOT EXISTS idx_voucher_requests_approved_by ON public.voucher_requests (approved_by);
CREATE INDEX IF NOT EXISTS idx_cash_shifts_opened_by ON public.cash_shifts (opened_by);
CREATE INDEX IF NOT EXISTS idx_cash_shifts_closed_by ON public.cash_shifts (closed_by);
CREATE INDEX IF NOT EXISTS idx_movements_user ON public.inventory_movements (user_id);
CREATE INDEX IF NOT EXISTS idx_resets_user ON public.password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON public.audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_reviewed_by ON public.audit_logs (reviewed_by);
