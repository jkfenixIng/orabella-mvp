-- 003_admin.sql — T3 admin (ADM-01…08).
--
-- Tablas: sedes, employees, services, tax_configs, payment_methods.
-- Además: users.sede_id pasa a NOT NULL con FK a sedes (nota T2 en
-- odd/tasks/orabella-mvp-rebuild.md). El MVP opera una sola sede, por eso
-- se crea la sede inicial 'Sede principal' y se asigna a los usuarios
-- existentes que aún la tengan NULL antes de imponer el NOT NULL.
--
-- RLS: deny-by-default (ENABLE ROW LEVEL SECURITY en las 5 tablas) con
-- políticas por sede. TODO(seguridad-T7): hoy las sesiones del MVP son
-- tokens opacos propios (tabla sessions, cookie orabella_session), NO
-- JWT de Supabase Auth, así que no hay claim de sede en auth.jwt() que
-- filtrar. Por eso las políticas T3 son permisivas (USING true) y la
-- segregación real por sede la aplica la capa servidor (service_role +
-- requireSedeRole + resolveSede en src/features/admin/service.ts).
-- Al migrar a JWT de Supabase con claim de sede, endurecer cada política
-- a (sede_id = (auth.jwt() ->> 'sede_id')::uuid) y revocar este TODO.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------- sedes ---
-- ADM-01: CRUD de sedes (nombre, dirección, teléfono, activa/inactiva).
CREATE TABLE public.sedes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_sedes_updated_at
  BEFORE UPDATE ON public.sedes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Sede inicial del MVP (una sola sede en operación, D4).
INSERT INTO public.sedes (name)
SELECT 'Sede principal'
WHERE NOT EXISTS (SELECT 1 FROM public.sedes WHERE name = 'Sede principal');

-- --------------------------------- users.sede_id NOT NULL + FK (nota T2) ---
-- Asigna la sede inicial a los usuarios creados en T2 (sede_id NULL).
UPDATE public.users
SET sede_id = (SELECT id FROM public.sedes WHERE name = 'Sede principal' LIMIT 1)
WHERE sede_id IS NULL;

ALTER TABLE public.users
  ALTER COLUMN sede_id SET NOT NULL;

ALTER TABLE public.users
  ADD CONSTRAINT fk_users_sede FOREIGN KEY (sede_id)
  REFERENCES public.sedes (id);

-- ------------------------------------------------------------- employees ---
-- ADM-02/ADM-03/ADM-08: empleados vinculados a usuario (nullable en T3 para
-- permitir personal sin acceso), employee_code opcional y cambiable con
-- unicidad parcial por sede, esquema de sueldo fijo/porcentaje/mixto.
CREATE TABLE public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  user_id uuid NULL UNIQUE REFERENCES public.users (id) ON DELETE SET NULL,
  employee_code text NULL,
  document text NOT NULL,
  phone text,
  position text,
  pay_type text NOT NULL CHECK (pay_type IN ('fijo', 'porcentaje', 'mixto')),
  salary_fixed numeric(12, 2) NULL CHECK (salary_fixed IS NULL OR salary_fixed >= 0),
  commission_percent numeric(5, 2) NULL CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.employees.user_id IS
  'ADM-02: vínculo al usuario de acceso. Nullable en T3 (personal sin login); UNIQUE impide dos empleados con el mismo usuario.';
COMMENT ON COLUMN public.employees.employee_code IS
  'ADM-03: código interno visible, opcional y cambiable. Vacío/nulo se permite repetir; con valor es único por sede (índice parcial uq_employees_sede_code).';

-- ADM-03: unicidad compuesta (sede_id + employee_code) solo con valor.
CREATE UNIQUE INDEX uq_employees_sede_code
  ON public.employees (sede_id, employee_code)
  WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';

CREATE INDEX idx_employees_sede_id ON public.employees (sede_id);
CREATE INDEX idx_employees_user_id ON public.employees (user_id);

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -------------------------------------------------------------- services ---
-- ADM-05: catálogo de servicios facturables con rango de duración
-- (duracion_min/duracion_max en minutos, sin duración única).
CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  name text NOT NULL,
  description text,
  price numeric(12, 2) NOT NULL CHECK (price >= 0),
  duracion_min integer NOT NULL CHECK (duracion_min >= 0),
  duracion_max integer NOT NULL CHECK (duracion_max >= 0),
  CHECK (duracion_min <= duracion_max),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_services_sede_id ON public.services (sede_id);

CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------- tax_configs ---
-- ADM-06: impuestos configurables por sede; inician todos inactivos en 0.
CREATE TABLE public.tax_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  code text NOT NULL CHECK (code IN ('IVA', 'ICA', 'Rete', 'otro')),
  name text NOT NULL,
  percent numeric(5, 2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, code, name)
);

CREATE INDEX idx_tax_configs_sede_id ON public.tax_configs (sede_id);

CREATE TRIGGER trg_tax_configs_updated_at
  BEFORE UPDATE ON public.tax_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------- payment_methods ---
-- ADM-07: catálogo de métodos de pago de Colombia por sede.
CREATE TABLE public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  code text NOT NULL CHECK (code IN ('efectivo', 'transferencia_normal', 'nequi', 'daviplata', 'bre-b', 'tarjeta')),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, code)
);

CREATE INDEX idx_payment_methods_sede_id ON public.payment_methods (sede_id);

CREATE TRIGGER trg_payment_methods_updated_at
  BEFORE UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------------ seeds ---
-- Catálogos iniciales por sede (una sede en el MVP): 6 métodos de pago
-- activos + IVA 19% e ICA inactivos (ADM-06/ADM-07).
DO $$
DECLARE
  v_sede uuid;
BEGIN
  SELECT id INTO v_sede FROM public.sedes WHERE name = 'Sede principal' LIMIT 1;

  INSERT INTO public.payment_methods (sede_id, code, name, is_active) VALUES
    (v_sede, 'efectivo', 'Efectivo', true),
    (v_sede, 'transferencia_normal', 'Transferencia / PSE', true),
    (v_sede, 'nequi', 'Nequi', true),
    (v_sede, 'daviplata', 'Daviplata', true),
    (v_sede, 'bre-b', 'Bre-B', true),
    (v_sede, 'tarjeta', 'Tarjeta', true)
  ON CONFLICT (sede_id, code) DO NOTHING;

  INSERT INTO public.tax_configs (sede_id, code, name, percent, is_active) VALUES
    (v_sede, 'IVA', 'IVA general', 19, false),
    (v_sede, 'ICA', 'ICA', 0, false)
  ON CONFLICT (sede_id, code, name) DO NOTHING;
END
$$;

-- ------------------------------------------------------------------- RLS ---
-- Deny-by-default en las 5 tablas. Ver el TODO del encabezado: políticas
-- permisivas temporales (USING true) porque aún no hay JWT con claim de
-- sede; la segregación por sede la aplica hoy la capa servidor.
ALTER TABLE public.sedes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_sedes_sede_isolation ON public.sedes
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_employees_sede_isolation ON public.employees
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_services_sede_isolation ON public.services
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_tax_configs_sede_isolation ON public.tax_configs
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_payment_methods_sede_isolation ON public.payment_methods
  FOR ALL USING (true) WITH CHECK (true);
