-- 008_hardening.sql — T8 endurecimiento (cierra los TODOs seguridad-T7 de T2–T7).
--
-- 1. Tabla audit_logs (TRA-01 §5.8): solo acciones críticas, escritura vía
--    servidor (service_role, que hace bypass natural de RLS). Lectura por sede.
-- 2. REVOCA las 20 políticas permisivas temporales `USING true` de T2–T7 y las
--    reemplaza por políticas RLS por sede con el claim JWT
--    `app_metadata.sede_id` (deny-by-default NFR-02 §6: sin sede no hay filas).
-- 3. Función public.current_sede_id() que centraliza la lectura del claim.
--
-- Cómo Supabase inyecta el claim (Auth Hook "Custom Access Token"):
--   Dashboard > Authentication > Hooks > "Customize Access Token" > Enabled,
--   apuntando a esta función (crear UNA vez por proyecto):
--
--   CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
--   RETURNS jsonb
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = public
--   AS $$
--   DECLARE
--     v_sede uuid;
--   BEGIN
--     SELECT sede_id INTO v_sede
--     FROM public.users
--     WHERE id = NULLIF(event ->> 'user_id', '')::uuid;
--     IF v_sede IS NOT NULL THEN
--       event := jsonb_set(
--         event,
--         '{claims,app_metadata,sede_id}',
--         to_jsonb(v_sede::text)
--       );
--     END IF;
--     RETURN event;
--   END;
--   $$;
--   GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb)
--     TO supabase_auth_admin;
--
--   Al login, el JWT lleva `app_metadata.sede_id = "<uuid-sede>"` y cada
--   política compara `sede_id::text` con
--   `(auth.jwt() -> 'app_metadata' ->> 'sede_id')`, centralizado en
--   public.current_sede_id(). service_role hace bypass de RLS en el servidor.
--
-- Excepciones funcionales documentadas (§9.4):
--   - public.roles: catálogo global de 3 filas (admin/empleado/caja). Solo
--     SELECT para autenticados; sin sede que filtrar (no tiene sede_id).
--   - Tablas sin sede_id propia se filtran por la sede del padre:
--     invoice_items/invoice_taxes/invoice_payments vía invoices;
--     payroll_items vía payroll_periods; payroll_payments vía
--     payroll_items -> payroll_periods; user_roles/sessions/password_resets
--     vía users. La pertenencia fina por rol (admin vs empleado/caja) y la
--     titularidad (sesiones propias) las sigue aplicando la capa servidor
--     (requireSedeRole + service_role), igual que en T2–T7.
--   - public.inventory_movements y public.audit_logs: historial append-only
--     para clientes JWT (SELECT + INSERT por sede; sin UPDATE/DELETE).
--
-- Orden de aplicación: 001 → 008 en un proyecto Supabase NUEVO (ver README).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------- sede desde el JWT (claim) ---
-- Equivale a comparar `sede_id::text = (auth.jwt() -> 'app_metadata' ->> 'sede_id')`.
-- NULL (sin JWT, sin claim o claim malformado) => ninguna política casa =>
-- deny-by-default (NFR-02). STABLE + SECURITY DEFINER para usarla en RLS.
CREATE OR REPLACE FUNCTION public.current_sede_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN (auth.jwt() -> 'app_metadata' ->> 'sede_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (auth.jwt() -> 'app_metadata' ->> 'sede_id')::uuid
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.current_sede_id() IS
  'T8: sede del JWT (claim app_metadata.sede_id inyectado por el Auth Hook custom_access_token_hook). NULL = sin acceso (deny-by-default).';

-- ---------------------------------------------------------------- audit_logs ---
-- TRA-01: quién, qué, cuándo, entidad. Solo acciones críticas (las escribe el
-- servidor vía writeAudit con service_role; nunca el cliente).
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable a propósito: el login fallido con documento inexistente no tiene
  -- sede que registrar; esas filas solo las lee service_role (RLS no casa NULL).
  sede_id uuid NULL REFERENCES public.sedes (id),
  user_id uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_logs IS
  'TRA-01: auditoría de acciones críticas (login fallido/bloqueo, anulación de factura, cierre con base incompleta, cálculo/cierre de nómina, vales sobre tope, cambio de clave). Escritura solo servidor (service_role).';
COMMENT ON COLUMN public.audit_logs.sede_id IS
  'Sede del evento. NULL solo cuando no se conoce (p. ej. login con documento inexistente).';
COMMENT ON COLUMN public.audit_logs.metadata IS
  'Detalle libre (motivo, consecutivos, montos, intentos). Jamás claves ni tokens.';

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON public.audit_logs (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_sede_created
  ON public.audit_logs (sede_id, created_at);

-- Helper opcional para futuros triggers de auditoría en BD (el MVP audita
-- desde el servicio con writeAudit; este helper queda para reglas SQL que lo
-- necesiten sin duplicar el INSERT).
CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_sede_id uuid,
  p_user_id uuid,
  p_action text,
  p_entity text,
  p_entity_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.audit_logs (sede_id, user_id, action, entity, entity_id, metadata)
  VALUES (p_sede_id, p_user_id, p_action, p_entity, p_entity_id, coalesce(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.write_audit_log(uuid, uuid, text, text, text, jsonb) IS
  'T8 helper opcional: inserta en audit_logs (p. ej. desde triggers futuros). El MVP lo usa solo como referencia; la app audita vía src/shared/lib/audit.ts.';

-- Ejemplo de trigger futuro con el helper (NO crear en T8, solo referencia):
-- CREATE TRIGGER trg_invoices_audit_annul
--   AFTER UPDATE OF status ON public.invoices
--   FOR EACH ROW WHEN (NEW.status = 'Anulada')
--   EXECUTE FUNCTION ... (llamar a write_audit_log con NEW.sede_id, ...);

-- --------------------------------------- revoca políticas permisivas T2–T7 ---
-- Cada DROP cierra el TODO(seguridad-T7) de su migración de origen.
DROP POLICY IF EXISTS pol_sedes_sede_isolation ON public.sedes;
DROP POLICY IF EXISTS pol_employees_sede_isolation ON public.employees;
DROP POLICY IF EXISTS pol_services_sede_isolation ON public.services;
DROP POLICY IF EXISTS pol_tax_configs_sede_isolation ON public.tax_configs;
DROP POLICY IF EXISTS pol_payment_methods_sede_isolation ON public.payment_methods;
DROP POLICY IF EXISTS pol_products_sede_isolation ON public.products;
DROP POLICY IF EXISTS pol_movements_sede_isolation ON public.inventory_movements;
DROP POLICY IF EXISTS pol_invoice_sequences_sede_isolation ON public.invoice_sequences;
DROP POLICY IF EXISTS pol_invoices_sede_isolation ON public.invoices;
DROP POLICY IF EXISTS pol_invoice_items_sede_isolation ON public.invoice_items;
DROP POLICY IF EXISTS pol_invoice_taxes_sede_isolation ON public.invoice_taxes;
DROP POLICY IF EXISTS pol_invoice_payments_sede_isolation ON public.invoice_payments;
DROP POLICY IF EXISTS pol_cash_registers_sede_isolation ON public.cash_registers;
DROP POLICY IF EXISTS pol_cash_shifts_sede_isolation ON public.cash_shifts;
DROP POLICY IF EXISTS pol_payments_sede_isolation ON public.payments;
DROP POLICY IF EXISTS pol_payroll_periods_sede_isolation ON public.payroll_periods;
DROP POLICY IF EXISTS pol_payroll_items_sede_isolation ON public.payroll_items;
DROP POLICY IF EXISTS pol_payroll_payments_sede_isolation ON public.payroll_payments;
DROP POLICY IF EXISTS pol_voucher_settings_sede_isolation ON public.voucher_settings;
DROP POLICY IF EXISTS pol_voucher_requests_sede_isolation ON public.voucher_requests;

-- ------------------------------------------- políticas por sede (claim JWT) ---
-- service_role (servidor) hace bypass natural de RLS; estas políticas rigen
-- para clientes JWT (futura app / accesos directos con anon/authenticated).
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- sedes: cada usuario ve su propia sede (la fila ES la sede).
CREATE POLICY pol_sedes_sede_isolation ON public.sedes
  FOR ALL TO authenticated
  USING (id = public.current_sede_id())
  WITH CHECK (id = public.current_sede_id());

-- Tablas con sede_id propia: aislamiento directo por claim.
CREATE POLICY pol_employees_sede_isolation ON public.employees
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_services_sede_isolation ON public.services
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_tax_configs_sede_isolation ON public.tax_configs
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_payment_methods_sede_isolation ON public.payment_methods
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_products_sede_isolation ON public.products
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- inventory_movements: kardex append-only (§9.4: insert-only para no-admin).
CREATE POLICY pol_movements_sede_select ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (sede_id = public.current_sede_id());

CREATE POLICY pol_movements_sede_insert ON public.inventory_movements
  FOR INSERT TO authenticated
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_invoice_sequences_sede_isolation ON public.invoice_sequences
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_invoices_sede_isolation ON public.invoices
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- Hijas de factura: sede del padre (invoices). Sin sede_id propia.
CREATE POLICY pol_invoice_items_sede_isolation ON public.invoice_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_items.invoice_id
      AND i.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_invoice_taxes_sede_isolation ON public.invoice_taxes
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_taxes.invoice_id
      AND i.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_taxes.invoice_id
      AND i.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_invoice_payments_sede_isolation ON public.invoice_payments
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_payments.invoice_id
      AND i.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_payments.invoice_id
      AND i.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_cash_registers_sede_isolation ON public.cash_registers
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_cash_shifts_sede_isolation ON public.cash_shifts
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_payments_sede_isolation ON public.payments
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_payroll_periods_sede_isolation ON public.payroll_periods
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- payroll_items: sede del periodo (sin sede_id propia).
CREATE POLICY pol_payroll_items_sede_isolation ON public.payroll_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.payroll_periods p
    WHERE p.id = payroll_items.period_id
      AND p.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.payroll_periods p
    WHERE p.id = payroll_items.period_id
      AND p.sede_id = public.current_sede_id()
  ));

-- payroll_payments: sede del periodo vía el ítem (sin sede_id propia).
CREATE POLICY pol_payroll_payments_sede_isolation ON public.payroll_payments
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.payroll_items pi
    JOIN public.payroll_periods p ON p.id = pi.period_id
    WHERE pi.id = payroll_payments.payroll_item_id
      AND p.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.payroll_items pi
    JOIN public.payroll_periods p ON p.id = pi.period_id
    WHERE pi.id = payroll_payments.payroll_item_id
      AND p.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_voucher_settings_sede_isolation ON public.voucher_settings
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

CREATE POLICY pol_voucher_requests_sede_isolation ON public.voucher_requests
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- users: solo filas de su sede (la escritura fina por rol la aplica el servidor).
CREATE POLICY pol_users_sede_isolation ON public.users
  FOR ALL TO authenticated
  USING (sede_id = public.current_sede_id())
  WITH CHECK (sede_id = public.current_sede_id());

-- user_roles / sessions / password_resets: sede del usuario dueño.
CREATE POLICY pol_user_roles_sede_isolation ON public.user_roles
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = user_roles.user_id
      AND u.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = user_roles.user_id
      AND u.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_sessions_sede_isolation ON public.sessions
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = sessions.user_id
      AND u.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = sessions.user_id
      AND u.sede_id = public.current_sede_id()
  ));

CREATE POLICY pol_password_resets_sede_isolation ON public.password_resets
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = password_resets.user_id
      AND u.sede_id = public.current_sede_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = password_resets.user_id
      AND u.sede_id = public.current_sede_id()
  ));

-- audit_logs: lectura por sede + INSERT por sede (append-only; sin UPDATE/DELETE
-- para JWT; el servidor escribe con service_role que hace bypass).
CREATE POLICY pol_audit_logs_sede_select ON public.audit_logs
  FOR SELECT TO authenticated
  USING (sede_id = public.current_sede_id());

CREATE POLICY pol_audit_logs_sede_insert ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (sede_id = public.current_sede_id());

-- roles: EXCEPCIÓN funcional documentada — catálogo global de 3 filas sin
-- sede_id; lectura para autenticados, sin escritura directa (solo service_role).
CREATE POLICY pol_roles_readonly ON public.roles
  FOR SELECT TO authenticated
  USING (true);
