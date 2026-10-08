-- 007_payroll.sql — T7 nómina y vales + cierre transversal del MVP (PAY-01…07, TRA-02…03).
--
-- Tablas: payroll_periods (periodos por sede, borrador/cerrado, cerrado
-- inmutable), payroll_items (base_fixed + commissions + bonuses −
-- deductions_vales − other_discounts = net_pay, con detail_json por
-- factura/ítem), payroll_payments (porciones por método que suman el neto),
-- voucher_settings (topes día/semana por sede), voucher_requests
-- (pendiente/aprobada/rechazada/descontada, aprobación con código dinámico
-- sobre topes, descuento automático al liquidar).
--
-- Dónde vive cada regla (SQL vs servicio):
--   - SQL: estados con CHECK, fin >= inicio, montos >= 0 / > 0, neto =
--     base + comisiones + bonos − vales − otros (tolerancia de centavo,
--     igual que invoices en 005 y cash_shifts en 006), un solo borrador por
--     sede y rango (índice único parcial), un ítem por empleado y periodo,
--     suma de porciones <= neto (trigger), FKs en cascada e índices.
--   - Servicio (src/features/payroll/service.ts): cálculo desde
--     invoice_items del rango por employee_id (fijo según pay_type +
--     comisiones por commission_percent, solo facturas no anuladas),
--     detail_json reproducible por factura/ítem, vales pendientes/aprobados
--     que se descuentan y pasan a descontada al calcular, pago dividido que
--     suma el neto exacto, periodo cerrado inmutable (assertDraftPeriod),
--     topes día/semana con aprobación obligatoria y approval_code de
--     6 dígitos sobre topes, métodos de pago activos (T3).
--
-- RLS: deny-by-default (ENABLE ROW LEVEL SECURITY) con políticas por sede.
-- TODO(seguridad-T7): hoy las sesiones del MVP son tokens opacos propios
-- (tabla sessions, cookie orabella_session), NO JWT de Supabase Auth, así
-- que no hay claim de sede en auth.jwt() que filtrar. Por eso las
-- políticas T7 son permisivas (USING true) y la segregación real por sede
-- la aplica la capa servidor (service_role + requireSedeRole +
-- resolveSede en src/features/payroll/service.ts, que reutiliza
-- src/features/admin/service.ts). Al migrar a JWT de Supabase con claim
-- de sede, endurecer cada política a
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid) y revocar este TODO.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------- payroll_periods ---
-- PAY-01: periodos de nómina por sede con fechas y estado
-- borrador/cerrado; cerrado = inmutable (lo refuerza el servicio con
-- assertDraftPeriod: toda escritura posterior se rechaza).
CREATE TABLE public.payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  CHECK (end_date >= start_date),
  status text NOT NULL DEFAULT 'borrador'
    CHECK (status IN ('borrador', 'cerrado')),
  created_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Cerrado exige fecha de cierre (BORRADOR la deja nula).
  CHECK (status <> 'cerrado' OR closed_at IS NOT NULL)
);

COMMENT ON COLUMN public.payroll_periods.status IS
  'PAY-01: borrador (editable, calculable, pagable) / cerrado (inmutable: bloquea cálculo, pagos, vales y reapertura).';
COMMENT ON COLUMN public.payroll_periods.closed_at IS
  'Fecha de cierre del periodo. Solo informada cuando status = cerrado.';

-- PAY-01: un solo borrador por sede y rango (mismo criterio que el DDL
-- crítico del PRD §9.3). Barrera final ante carreras; el servicio rechaza
-- antes con mensaje de negocio (PERIOD_DRAFT_EXISTS).
CREATE UNIQUE INDEX uq_payroll_draft_per_range
  ON public.payroll_periods (sede_id, start_date, end_date)
  WHERE status = 'borrador';

CREATE INDEX idx_payroll_periods_sede_status
  ON public.payroll_periods (sede_id, status, start_date);

CREATE TRIGGER trg_payroll_periods_updated_at
  BEFORE UPDATE ON public.payroll_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- --------------------------------------------------------- payroll_items ---
-- PAY-02/PAY-03: un ítem por empleado y periodo. base_fixed (fijo según
-- pay_type) + commissions (desde invoice_items del rango por employee_id)
-- + bonuses − deductions_vales − other_discounts = net_pay, con
-- detail_json (líneas por factura/ítem) que justifica cada peso.
CREATE TABLE public.payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES public.payroll_periods (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees (id),
  base_fixed numeric(12, 2) NOT NULL DEFAULT 0 CHECK (base_fixed >= 0),
  commissions numeric(12, 2) NOT NULL DEFAULT 0 CHECK (commissions >= 0),
  bonuses numeric(12, 2) NOT NULL DEFAULT 0 CHECK (bonuses >= 0),
  deductions_vales numeric(12, 2) NOT NULL DEFAULT 0 CHECK (deductions_vales >= 0),
  other_discounts numeric(12, 2) NOT NULL DEFAULT 0 CHECK (other_discounts >= 0),
  net_pay numeric(12, 2) NOT NULL CHECK (net_pay >= 0),
  -- Neto = base + comisiones + bonos − vales − otros (tolerancia de centavo).
  CHECK (
    abs(net_pay - (base_fixed + commissions + bonuses - deductions_vales - other_discounts)) < 0.01
  ),
  detail_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, employee_id)
);

COMMENT ON COLUMN public.payroll_items.detail_json IS
  'PAY-03: líneas por factura/ítem [{invoice_id, consecutive_number, item_id, item_type, qty, unit_price, line_subtotal, commission}] que reproducen commissions sin diferencias.';
COMMENT ON COLUMN public.payroll_items.net_pay IS
  'PAY-02: base_fixed + commissions + bonuses − deductions_vales − other_discounts (tolerancia de centavo).';

CREATE INDEX idx_payroll_items_period_id
  ON public.payroll_items (period_id);
CREATE INDEX idx_payroll_items_employee_id
  ON public.payroll_items (employee_id);

CREATE TRIGGER trg_payroll_items_updated_at
  BEFORE UPDATE ON public.payroll_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------ payroll_payments ---
-- PAY-04: un ítem se paga en varias porciones por método (snapshot en
-- method_code, igual que payments en 006), con paid_at/paid_by/reference.
-- La suma de porciones nunca excede el neto (trigger, además del control
-- exacto en el servicio: la suma debe igualar el neto).
CREATE TABLE public.payroll_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id uuid NOT NULL REFERENCES public.payroll_items (id) ON DELETE CASCADE,
  method_id uuid NULL REFERENCES public.payment_methods (id) ON DELETE SET NULL,
  method_code text NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  paid_at timestamptz NOT NULL DEFAULT now(),
  paid_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  reference text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payroll_payments IS
  'PAY-04: porciones de pago de un ítem de nómina. La suma por ítem no excede net_pay (trigger trg_payroll_payments_cap + validación exacta en el servicio).';

CREATE INDEX idx_payroll_payments_item_id
  ON public.payroll_payments (payroll_item_id);

-- PAY-04: la suma por ítem no excede el neto (0 ítems con pagos que
-- excedan el neto). Barrera en BD; el servicio valida la suma exacta.
CREATE OR REPLACE FUNCTION public.check_payroll_payments_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_net numeric(12, 2);
  v_paid numeric(12, 2);
BEGIN
  SELECT net_pay INTO v_net
  FROM public.payroll_items
  WHERE id = NEW.payroll_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem de nómina inexistente (%)', NEW.payroll_item_id;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.payroll_payments
  WHERE payroll_item_id = NEW.payroll_item_id;

  IF v_paid + NEW.amount - v_net > 0.009 THEN
    RAISE EXCEPTION 'El pago supera el neto del ítem (neto %, pagado %, nuevo %)', v_net, v_paid, NEW.amount;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_payments_cap ON public.payroll_payments;

CREATE TRIGGER trg_payroll_payments_cap
  BEFORE INSERT ON public.payroll_payments
  FOR EACH ROW EXECUTE FUNCTION public.check_payroll_payments_cap();

-- ------------------------------------------------------ voucher_settings ---
-- PAY-05: topes por sede (máximo por día y por semana). Un registro por
-- sede (sede_id es PK).
CREATE TABLE public.voucher_settings (
  sede_id uuid PRIMARY KEY REFERENCES public.sedes (id) ON DELETE CASCADE,
  max_per_day numeric(12, 2) NOT NULL DEFAULT 0 CHECK (max_per_day >= 0),
  max_per_week numeric(12, 2) NOT NULL DEFAULT 0 CHECK (max_per_week >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.voucher_settings IS
  'PAY-05: topes de vales por sede (día/semana). Todo desembolso se valida contra ambos topes en el servicio.';

CREATE TRIGGER trg_voucher_settings_updated_at
  BEFORE UPDATE ON public.voucher_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------ voucher_requests ---
-- PAY-06/PAY-07: solicitudes pendiente/aprobada/rechazada/descontada.
-- Superar topes exige aprobación del admin con código dinámico básico
-- (approved_by + approval_code no nulos, lo refuerza el servicio porque el
-- tope depende del acumulado vigente, NO expresable en un CHECK) y
-- observación opcional. Al liquidar se descuentan y pasan a descontada
-- (transición única: descontada y rechazada son terminales).
CREATE TABLE public.voucher_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  employee_id uuid NOT NULL REFERENCES public.employees (id),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  request_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'descontada')),
  approved_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  approval_code text NULL,
  observation text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.voucher_requests.approval_code IS
  'PAY-06: código dinámico básico de 6 dígitos generado al aprobar. Obligatorio cuando el vale superó los topes (approved_by + código no nulos); lo valida el servicio.';
COMMENT ON COLUMN public.voucher_requests.status IS
  'PAY-06/PAY-07: pendiente → aprobada/rechazada; aprobada/pendiente → descontada al liquidar. Descontada y rechazada son terminales.';

CREATE INDEX idx_voucher_requests_employee_date
  ON public.voucher_requests (employee_id, request_date);
CREATE INDEX idx_voucher_requests_sede_status
  ON public.voucher_requests (sede_id, status);

CREATE TRIGGER trg_voucher_requests_updated_at
  BEFORE UPDATE ON public.voucher_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------------- RLS ---
-- Deny-by-default en las 5 tablas. Ver el TODO del encabezado: políticas
-- permisivas temporales (USING true) porque aún no hay JWT con claim de
-- sede; la segregación por sede la aplica hoy la capa servidor.
ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_requests ENABLE ROW LEVEL SECURITY;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: liquidar/cerrar/pagar solo admin en su sede (pagos también
-- caja); periodo cerrado inmutable (capa servidor).
CREATE POLICY pol_payroll_periods_sede_isolation ON public.payroll_periods
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: el empleado ve solo sus ítems (capa servidor).
CREATE POLICY pol_payroll_items_sede_isolation ON public.payroll_items
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer cuando exista JWT con claim de sede.
-- Nota §9.4: la suma por ítem no excede net_pay (trigger + servidor).
CREATE POLICY pol_payroll_payments_sede_isolation ON public.payroll_payments
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: CRUD admin en su sede; lectura de catálogos activos.
CREATE POLICY pol_voucher_settings_sede_isolation ON public.voucher_settings
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: crear propias + ver propias; aprobar/rechazar solo admin;
-- sobre tope exige approved_by + código (capa servidor).
CREATE POLICY pol_voucher_requests_sede_isolation ON public.voucher_requests
  FOR ALL USING (true) WITH CHECK (true);
