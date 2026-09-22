-- 016_commissions.sql — comisiones por producto-empleado y pago (nómina o inmediato).
--
-- Regla = acuerdo por (ítem × empleado): porcentaje y/o valor fijo por
-- unidad (al menos uno). Sin regla rige la tasa plana del empleado.
-- Pago inmediato sale de la caja del turno por cualquier método activo y
-- el cierre lo descuenta del esperado; todo pago inmediato queda auditado
-- (cuánto, quién pagó, cuándo, factura y turno) y no se puede pagar dos
-- veces la misma (factura, empleado).

-- Empleado: modo de pago + contacto.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS payout_mode text NOT NULL DEFAULT 'nomina',
  ADD COLUMN IF NOT EXISTS email text NULL,
  ADD COLUMN IF NOT EXISTS birth_date date NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employees_payout_mode'
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT chk_employees_payout_mode CHECK (payout_mode IN ('nomina', 'inmediato'));
  END IF;
END
$$;

COMMENT ON COLUMN public.employees.payout_mode IS
  'Preferencia de cobro de comisiones: en nómina o de inmediato desde caja.';
COMMENT ON COLUMN public.employees.email IS
  'Correo de contacto del empleado (no es login; solo informativo).';
COMMENT ON COLUMN public.employees.birth_date IS
  'Fecha de nacimiento del empleado (informativa).';

-- Línea sin comisión (p. ej. insumo consumido dentro de un servicio, no
-- venta directa): aunque haya regla, esa línea no genera comisión.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS no_commission boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.invoice_items.no_commission IS
  'La línea no genera comisión aunque exista regla (insumo dentro de un servicio).';

-- Reglas de comisión por (sede, ítem, empleado).
CREATE TABLE IF NOT EXISTS public.commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  item_type text NOT NULL CHECK (item_type IN ('producto', 'servicio')),
  item_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees (id) ON DELETE CASCADE,
  percent numeric(5, 2) NULL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
  amount numeric(12, 2) NULL CHECK (amount IS NULL OR amount >= 0),
  CHECK (percent IS NOT NULL OR amount IS NOT NULL),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- item_id es polimórfico (productos o servicios según item_type): sin FK,
-- lo valida la capa servidor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_rule
  ON public.commission_rules (sede_id, item_type, item_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_commission_rules_lookup
  ON public.commission_rules (sede_id, item_type, item_id)
  WHERE is_active;

COMMENT ON TABLE public.commission_rules IS
  'Acuerdo de comisión por (ítem × empleado): % y/o valor fijo por unidad. Sin regla rige la tasa plana del empleado.';

-- Pagos inmediatos de comisión desde caja.
CREATE TABLE IF NOT EXISTS public.commission_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  employee_id uuid NOT NULL REFERENCES public.employees (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  cash_shift_id uuid NOT NULL REFERENCES public.cash_shifts (id) ON DELETE RESTRICT,
  method_code text NOT NULL,
  base_subtotal numeric(12, 2) NOT NULL CHECK (base_subtotal >= 0),
  percent_applied numeric(5, 2) NULL,
  fixed_applied numeric(12, 2) NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  paid_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  paid_at timestamptz NOT NULL DEFAULT now()
);

-- Sin UNIQUE(factura, empleado): se permiten pagos parciales; el tope
-- acumulado (ganado − pagado) lo valida la capa servidor.
CREATE INDEX IF NOT EXISTS idx_commission_payouts_invoice_employee
  ON public.commission_payouts (invoice_id, employee_id);

CREATE INDEX IF NOT EXISTS idx_commission_payouts_sede_shift
  ON public.commission_payouts (sede_id, cash_shift_id);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_employee
  ON public.commission_payouts (employee_id);

COMMENT ON TABLE public.commission_payouts IS
  'Comisiones pagadas de inmediato desde caja. Trazan cuánto, quién pagó, cuándo, con qué método, factura y turno. UNIQUE(factura, empleado) impide el doble pago.';

-- RLS: mismo patrón que caja (denegar por defecto; la segregación por
-- sede la aplica hoy la capa servidor con service_role).
ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_commission_rules_sede_isolation ON public.commission_rules
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pol_commission_payouts_sede_isolation ON public.commission_payouts
  FOR ALL USING (true) WITH CHECK (true);
