-- test-bootstrap.sql - combinado para Supabase Dashboard SQL Editor (proyecto test)
-- Orden: 001 a 010 + seeds/acceptance.sql. Pegar todo en una sola query y Run.

-- ================= 001_foundation.sql =================
-- 001_foundation.sql — T1 fundación (sin tablas de dominio; esas van en T2→T7).
--
-- Provee: extensión pgcrypto (gen_random_uuid) y trigger compartido
-- set_updated_at() para mantener updated_at en todas las tablas de negocio.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Uso en migraciones T2→T7 (ejemplo, no ejecutar aquí):
-- CREATE TRIGGER trg_users_updated_at
--   BEFORE UPDATE ON public.users
--   FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ================= 002_auth.sql =================
-- 002_auth.sql — T2 auth (AUTH-01…07).
--
-- Tablas: users, roles, user_roles, sessions, password_resets.
-- Decisión de credenciales (ver src/features/auth/README.md): la fuente de
-- verdad del login por documento es users.password_hash (scrypt, servidor).
-- Supabase Auth se aprovisiona en espejo solo cuando hay email real.
--
-- RLS: deny-by-default en las 5 tablas (sin políticas permisivas; solo
-- service_role en servidor). T3 (admin) agregará las políticas por sede/rol.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users ---
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK futura a public.sedes (la crea T3). Nullable en T2 a propósito:
  -- el MVP opera una sola sede y aún no existe el catálogo.
  sede_id uuid NULL,
  email text UNIQUE,
  phone text,
  id_type text NOT NULL CHECK (id_type IN ('CC', 'CE', 'PPT', 'PEP', 'otro')),
  id_number text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.users.sede_id IS
  'FK futura a sedes (T3 admin). Nullable en T2; T3 la vuelve NOT NULL con RLS por sede.';
COMMENT ON COLUMN public.users.email IS
  'Correo real del usuario. T2 lo exige en adminCreateUser (sin emails sintéticos); nullable en BD para usuarios legacy solo-documento.';
COMMENT ON COLUMN public.users.password_hash IS
  'Hash scrypt de la clave. Fuente de verdad del login por documento en el MVP (ver README del módulo auth).';
COMMENT ON COLUMN public.users.must_change_password IS
  'AUTH-01: true al crear (clave inicial = documento); bloquea todo hasta el cambio.';

CREATE INDEX idx_users_id_number ON public.users (id_number);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- roles ---
CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL CHECK (code IN ('admin', 'empleado', 'caja')),
  description text
);

INSERT INTO public.roles (code, description) VALUES
  ('admin', 'Administración total de su sede (AUTH-07).'),
  ('empleado', 'Operación asignada de su sede (AUTH-07).'),
  ('caja', 'Facturación y caja de su sede (AUTH-07).');

-- ----------------------------------------------------------- user_roles ---
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- ------------------------------------------------------------- sessions ---
CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  -- AUTH-03: timeout por inactividad (30 min, ver servicio auth).
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_id ON public.sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON public.sessions (token_hash);

-- ------------------------------------------------------- password_resets --
CREATE TABLE public.password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_password_resets_token_hash ON public.password_resets (token_hash);

-- ------------------------------------------------------------------ RLS ---
-- Deny-by-default: sin políticas, ningún rol (salvo service_role, que hace
-- bypass) puede leer/escribir. T3 agrega políticas por sede/rol.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;

-- ================= 003_admin.sql =================
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
  full_name text NOT NULL DEFAULT '',
  employee_code text NULL,
  document text NOT NULL,
  phone text,
  position text,
  payout_mode text NOT NULL DEFAULT 'nomina' CHECK (payout_mode IN ('nomina', 'inmediato')),
  email text NULL,
  birth_date date NULL,
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

-- ------------------------------------------------------- comisiones (016) ---
CREATE TABLE public.commission_rules (
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

CREATE UNIQUE INDEX uq_commission_rule
  ON public.commission_rules (sede_id, item_type, item_id, employee_id);
CREATE INDEX idx_commission_rules_lookup
  ON public.commission_rules (sede_id, item_type, item_id)
  WHERE is_active;

CREATE TABLE public.commission_payouts (
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

CREATE INDEX idx_commission_payouts_invoice_employee
  ON public.commission_payouts (invoice_id, employee_id);

CREATE INDEX idx_commission_payouts_sede_shift
  ON public.commission_payouts (sede_id, cash_shift_id);
CREATE INDEX idx_commission_payouts_employee
  ON public.commission_payouts (employee_id);

ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_commission_rules_sede_isolation ON public.commission_rules
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pol_commission_payouts_sede_isolation ON public.commission_payouts
  FOR ALL USING (true) WITH CHECK (true);

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

-- ================= 004_inventory.sql =================
-- 004_inventory.sql — T4 inventario (INV-01…05).
--
-- Tablas: products (SKU único por sede), inventory_movements (kardex
-- IN/OUT/ADJUST con motivo y responsable).
--
-- Stock SOLO vía movimientos (INV-03):
--   1. La app nunca escribe products.stock_qty directo (el servicio
--      upsertProduct no incluye stock_qty en ningún payload).
--   2. El trigger trg_inventory_apply_stock (AFTER INSERT) recalcula el
--      stock: IN suma, OUT resta, ADJUST fija el nivel absoluto.
--   3. El trigger trg_inventory_no_negative (BEFORE INSERT) bloquea con
--      lock a nivel de fila (SELECT … FOR UPDATE sobre products) y rechaza
--      el OUT que dejaría stock negativo (excepción INSUFFICIENT_STOCK).
--      El servicio además pre-verifica el stock para devolver un error de
--      negocio claro; ante carreras concurrentes el trigger es la
--      autoridad y el servicio traduce la excepción al mismo código.
--   4. Constraint de apoyo: CHECK (stock_qty >= 0) en products — última
--      barrera documentada si algún path futuro intentara bajarlo directo.
--
-- ADJUST fija el nivel absoluto de stock (= qty del movimiento, > 0 por
-- CHECK de PRD §9.1). Para llevar un producto a cero se usa OUT del
-- remanente (queda auditado en el kardex).
--
-- RLS: deny-by-default (ENABLE ROW LEVEL SECURITY) con políticas por sede.
-- TODO(seguridad-T7): hoy las sesiones del MVP son tokens opacos propios
-- (tabla sessions, cookie orabella_session), NO JWT de Supabase Auth, así
-- que no hay claim de sede en auth.jwt() que filtrar. Por eso las
-- políticas T4 son permisivas (USING true) y la segregación real por sede
-- la aplica la capa servidor (service_role + requireSedeRole +
-- resolveSede en src/features/inventory/service.ts, que reutiliza
-- src/features/admin/service.ts). Al migrar a JWT de Supabase con claim
-- de sede, endurecer cada política a
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid) y revocar este TODO.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------- products ---
-- INV-01: CRUD de productos (SKU único por sede, precios/costos >= 0,
-- stock mínimo para alertas). stock_qty solo lo tocan los triggers T4.
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  sku text NOT NULL,
  name text NOT NULL,
  description text,
  stock_qty integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  min_stock integer NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  cost_price numeric(12, 2) NULL CHECK (cost_price IS NULL OR cost_price >= 0),
  sale_price numeric(12, 2) NULL CHECK (sale_price IS NULL OR sale_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, sku)
);

COMMENT ON COLUMN public.products.sku IS
  'INV-01: SKU único por sede (UNIQUE sede_id + sku). El servicio lo normaliza (trim + mayúsculas) antes de guardar.';
COMMENT ON COLUMN public.products.stock_qty IS
  'INV-03: stock derivado EXCLUSIVAMENTE de inventory_movements vía triggers T4. La app nunca lo escribe directo.';

CREATE INDEX idx_products_sede_id ON public.products (sede_id);
CREATE INDEX idx_products_sede_name ON public.products (sede_id, name);
CREATE INDEX idx_products_sede_sku ON public.products (sede_id, sku);

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------- inventory_movements ---
-- INV-02: movimientos IN/OUT/ADJUST con motivo, cantidad y responsable.
CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  product_id uuid NOT NULL REFERENCES public.products (id),
  type text NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUST')),
  qty integer NOT NULL CHECK (qty > 0),
  reason text NOT NULL,
  user_id uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.inventory_movements.type IS
  'INV-02/INV-03: IN suma stock, OUT resta (nunca deja negativo), ADJUST fija el nivel absoluto.';
COMMENT ON COLUMN public.inventory_movements.user_id IS
  'INV-02: responsable del movimiento. Nullable (movimientos del sistema, p. ej. reversión de factura anulada en T5).';

CREATE INDEX idx_movements_product_created ON public.inventory_movements (product_id, created_at);
CREATE INDEX idx_movements_sede_id ON public.inventory_movements (sede_id);

-- --------------------------------- trigger: bloqueo de stock negativo (OUT) ---
-- INV-04: el stock nunca queda negativo. BEFORE INSERT con lock de fila
-- sobre el producto para serializar OUT concurrentes del mismo producto.
CREATE OR REPLACE FUNCTION public.inventory_no_negative_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_stock integer;
BEGIN
  IF NEW.type = 'OUT' THEN
    SELECT stock_qty INTO v_stock
    FROM public.products
    WHERE id = NEW.product_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;
    IF v_stock < NEW.qty THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_no_negative
  BEFORE INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_no_negative_stock();

-- ----------------------------------------- trigger: stock solo vía movimientos ---
-- INV-03: aplica el movimiento al stock del producto (único escritor).
CREATE OR REPLACE FUNCTION public.inventory_apply_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'IN' THEN
    UPDATE public.products
    SET stock_qty = stock_qty + NEW.qty
    WHERE id = NEW.product_id;
  ELSIF NEW.type = 'OUT' THEN
    UPDATE public.products
    SET stock_qty = stock_qty - NEW.qty
    WHERE id = NEW.product_id;
  ELSIF NEW.type = 'ADJUST' THEN
    UPDATE public.products
    SET stock_qty = NEW.qty
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_apply_stock
  AFTER INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inventory_apply_stock();

-- ------------------------------------------------------------------- RLS ---
-- Deny-by-default en las 2 tablas. Ver el TODO del encabezado: políticas
-- permisivas temporales (USING true) porque aún no hay JWT con claim de
-- sede; la segregación por sede la aplica hoy la capa servidor.
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_products_sede_isolation ON public.products
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: historial insert-only para no-admin (sin UPDATE/DELETE desde
-- la app; solo el servicio de servidor inserta).
CREATE POLICY pol_movements_sede_isolation ON public.inventory_movements
  FOR ALL USING (true) WITH CHECK (true);

-- ================= 005_billing.sql =================
-- 005_billing.sql — T5 factura interna (FAC-01…07, SIN DIAN).
--
-- Tablas: invoice_sequences (consecutivo por sede), invoices,
-- invoice_items (producto/servicio/custom + empleado por línea),
-- invoice_taxes (snapshot inmutable), invoice_payments (porciones por
-- método de pago, registro interno T5).
--
-- Consecutivo sin huecos bajo concurrencia (FAC-05):
--   1. La función next_invoice_number(p_sede_id) crea la fila de la sede
--      si falta, la bloquea (SELECT … FOR UPDATE), incrementa last_number
--      y devuelve el nuevo número. El lock serializa emisores concurrentes:
--      10 emisiones concurrentes producen 10 números únicos y continuos.
--   2. El servicio (src/features/billing/service.ts) reserva el número
--      DESPUÉS de validar todo (ítems, stock pre-verificado, impuestos,
--      porciones) e inserta la factura inmediatamente después. El UNIQUE
--      (sede_id, consecutive_number) impide duplicados aunque dos
--      transacciones compitan; ante fallo posterior a la reserva el
--      servicio intenta limpieza best-effort (ver servicio). Huecos solo
--      ante fallo de BD entre la reserva y el insert (raro y documentado).
--
-- Stock (FAC-06): la factura con productos genera OUT vía
-- inventory_movements (reason FACTURA #N) reutilizando registerMovement;
-- la anulación genera IN de reversión por cada producto. Los triggers T4
-- (no-negativo + apply) siguen siendo la autoridad.
--
-- Impuestos (FAC-03): invoice_taxes es un snapshot (código/nombre/
-- porcentaje/monto). Cambiar tax_configs no altera facturas emitidas.
--
-- cash_shift_id: uuid NULL SIN FK (forward-ref). La tabla cash_shifts se
-- crea en T6 (caja multi-turno); T6 agregará la FK y vinculará pagos por
-- turno. invoice_payments es el registro interno T5 de porciones; los
-- pagos por turno de T6 (tabla payments del PRD §9.1) referenciarán a la
-- factura y la consolidación se definirá en T6.
--
-- RLS: deny-by-default (ENABLE ROW LEVEL SECURITY) con políticas por sede.
-- TODO(seguridad-T7): hoy las sesiones del MVP son tokens opacos propios
-- (tabla sessions, cookie orabella_session), NO JWT de Supabase Auth, así
-- que no hay claim de sede en auth.jwt() que filtrar. Por eso las
-- políticas T5 son permisivas (USING true) y la segregación real por sede
-- la aplica la capa servidor (service_role + requireSedeRole +
-- resolveSede en src/features/billing/service.ts, que reutiliza
-- src/features/admin/service.ts). Al migrar a JWT de Supabase con claim
-- de sede, endurecer cada política a
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid) y revocar este TODO.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------- invoice_sequences ---
-- FAC-05: último número emitido por sede. Una fila por sede; el lock de
-- fila en next_invoice_number() serializa la emisión concurrente.
CREATE TABLE public.invoice_sequences (
  sede_id uuid PRIMARY KEY REFERENCES public.sedes (id),
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

-- -------------------------------------------------------------- invoices ---
-- FAC-01…07: factura interna (sin DIAN). Estados Emitida (inicial) /
-- Pagada (porciones suman el total) / Anulada (terminal, con motivo).
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  consecutive_number integer NOT NULL CHECK (consecutive_number > 0),
  client_name text NOT NULL,
  client_document text NULL,
  subtotal numeric(12, 2) NOT NULL CHECK (subtotal >= 0),
  discount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax numeric(12, 2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total numeric(12, 2) NOT NULL CHECK (total >= 0),
  -- Tolerancia de centavo por redondeo a 2 decimales en el servicio.
  CHECK (abs(total - (subtotal - discount + tax)) < 0.01),
  status text NOT NULL DEFAULT 'Emitida'
    CHECK (status IN ('Emitida', 'Pagada', 'Anulada')),
  user_id uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  -- Forward-ref T6: la tabla cash_shifts aún no existe (llega en T6);
  -- por eso NO hay constraint FK aquí. T6 agregará la FK.
  cash_shift_id uuid NULL,
  cancel_reason text NULL,
  -- Anulada exige motivo (FAC-04); Emitida/Pagada no lo llevan.
  CHECK (
    status <> 'Anulada'
    OR (cancel_reason IS NOT NULL AND btrim(cancel_reason) <> '')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, consecutive_number)
);

COMMENT ON COLUMN public.invoices.consecutive_number IS
  'FAC-05: consecutivo por sede sin huecos ni duplicados. Se reserva con next_invoice_number() (lock por sede) e inserta inmediatamente; UNIQUE (sede_id, consecutive_number) impide duplicados.';
COMMENT ON COLUMN public.invoices.cash_shift_id IS
  'Forward-ref T6: vinculará la factura al turno de caja abierto (tabla cash_shifts, aún no existe). T6 agregará la FK; en T5 siempre NULL.';
COMMENT ON COLUMN public.invoices.user_id IS
  'Responsable de la emisión. Nullable (filas del sistema); la app siempre lo informa.';
COMMENT ON COLUMN public.invoices.cancel_reason IS
  'FAC-04: motivo obligatorio al anular (CHECK cuando status = Anulada). La anulación no borra el registro y conserva el consecutivo.';

CREATE INDEX idx_invoices_sede_status_created
  ON public.invoices (sede_id, status, created_at);
CREATE INDEX idx_invoices_sede_consecutive
  ON public.invoices (sede_id, consecutive_number);

CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------- invoice_items ---
-- FAC-01/FAC-02: una línea = un solo origen (producto O servicio O
-- custom) + empleado responsable (base de comisiones de nómina en T7).
CREATE TABLE public.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('producto', 'servicio', 'custom')),
  product_id uuid NULL REFERENCES public.products (id),
  service_id uuid NULL REFERENCES public.services (id),
  custom_name text NULL,
  employee_id uuid NOT NULL REFERENCES public.employees (id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_price numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  discount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  subtotal numeric(12, 2) NOT NULL CHECK (subtotal >= 0),
  no_commission boolean NOT NULL DEFAULT false,
  -- Solo un origen por línea (FAC-01): producto exige product_id,
  -- servicio exige service_id, custom exige custom_name con valor.
  CHECK (
    (item_type = 'producto' AND product_id IS NOT NULL AND service_id IS NULL
      AND (custom_name IS NULL OR btrim(custom_name) = ''))
    OR (item_type = 'servicio' AND service_id IS NOT NULL AND product_id IS NULL
      AND (custom_name IS NULL OR btrim(custom_name) = ''))
    OR (item_type = 'custom' AND custom_name IS NOT NULL AND btrim(custom_name) <> ''
      AND product_id IS NULL AND service_id IS NULL)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.invoice_items.employee_id IS
  'FAC-02: empleado por línea, base de participación/comisión (T7 liquida desde invoice_items por employee_id). NOT NULL siempre.';

CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items (invoice_id);
-- Índice para nómina T7: comisiones por empleado en un periodo.
CREATE INDEX idx_invoice_items_employee_invoice
  ON public.invoice_items (employee_id, invoice_id);

CREATE TRIGGER trg_invoice_items_updated_at
  BEFORE UPDATE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------- invoice_taxes ---
-- FAC-03: snapshot inmutable de impuestos por factura (código/nombre/
-- porcentaje/monto). Inmune a cambios posteriores del catálogo.
CREATE TABLE public.invoice_taxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  tax_code text NOT NULL,
  tax_name text NOT NULL,
  percent numeric(5, 2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_taxes IS
  'FAC-03: snapshot inmutable. Cambiar tax_configs (porcentaje, nombre, activo) nunca altera facturas ya emitidas.';

CREATE INDEX idx_invoice_taxes_invoice_id ON public.invoice_taxes (invoice_id);

-- ------------------------------------------------------- invoice_payments ---
-- FAC-07: porciones del cobro por método de pago (p. ej. parte efectivo +
-- parte Nequi). method_code es snapshot; method_id traza al catálogo.
-- La suma de porciones de una factura Pagada == total (regla en servicio).
CREATE TABLE public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  method_id uuid NULL REFERENCES public.payment_methods (id) ON DELETE SET NULL,
  method_code text NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_payments IS
  'FAC-07 (T5): porciones del cobro por método. Registro interno T5; los pagos por turno de T6 (tabla payments del PRD) referenciarán a invoices y la consolidación se definirá en T6.';

CREATE INDEX idx_invoice_payments_invoice_id
  ON public.invoice_payments (invoice_id);

-- -------------------------------------------- next_invoice_number(sede_id) ---
-- FAC-05: reserva el siguiente consecutivo de la sede con lock de fila.
-- Serializa emisores concurrentes: cada llamada en su transacción obtiene
-- un número único y continuo. El servicio la llama vía rpc DESPUÉS de
-- validar todo e inserta la factura en el acto (ver encabezado).
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_last integer;
BEGIN
  INSERT INTO public.invoice_sequences (sede_id, last_number)
  VALUES (p_sede_id, 0)
  ON CONFLICT (sede_id) DO NOTHING;

  SELECT last_number INTO v_last
  FROM public.invoice_sequences
  WHERE sede_id = p_sede_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEDE_NOT_FOUND';
  END IF;

  UPDATE public.invoice_sequences
  SET last_number = v_last + 1
  WHERE sede_id = p_sede_id;

  RETURN v_last + 1;
END;
$$;

-- ------------------------------------------------------------------- RLS ---
-- Deny-by-default en las 5 tablas. Ver el TODO del encabezado: políticas
-- permisivas temporales (USING true) porque aún no hay JWT con claim de
-- sede; la segregación por sede la aplica hoy la capa servidor.
ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_taxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_invoice_sequences_sede_isolation ON public.invoice_sequences
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: anular solo admin (capa servidor); sin UPDATE/DELETE
-- directos desde la app salvo el servicio de servidor.
CREATE POLICY pol_invoices_sede_isolation ON public.invoices
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_invoice_items_sede_isolation ON public.invoice_items
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_invoice_taxes_sede_isolation ON public.invoice_taxes
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_invoice_payments_sede_isolation ON public.invoice_payments
  FOR ALL USING (true) WITH CHECK (true);

-- ================= 006_cash.sql =================
-- 006_cash.sql — T6 caja multi-turno (CAJ-01…06 + base encadenada del dueño).
--
-- Tablas: cash_registers (una caja física por sede, "Caja única"),
-- cash_shifts (varios turnos por día, sin solape: un solo turno abierto
-- por caja vía índice único parcial), payments (pagos del PRD §9.1:
-- vinculados al turno abierto y, cuando cobran una factura, a invoices).
--
-- Base encadenada (CAJ-01/CAJ-04, nota del dueño en
-- odd/tasks/orabella-mvp-rebuild.md):
--   opening_base del turno N+1 = base_left del cierre N; el primer turno
--   usa base_configurada (default 200 000). Al cierre se registra
--   base_left, cash_withdrawn (= counted_cash − base_left) y
--   base_difference (= base_left − base_configurada vigente).
--   Casos del negocio: (a) hay 400 000 y la base es 200 000 → quedan
--   200 000 de base y se recogen 200 000; (b) base configurada 300 000
--   pero solo hay 150 000 en efectivo → la base de la próxima apertura
--   es 150 000 con faltante de 150 000. Si base_left < base_configurada
--   queda marcada como base incompleta con observación obligatoria.
--
-- Dónde vive cada regla (SQL vs servicio):
--   - SQL: un turno abierto por caja (índice parcial), conteo y base
--     obligatorios al cerrar (CHECK con status = 'cerrado'),
--     coherencia cash_withdrawn = counted − base_left (tolerancia de
--     centavo, igual que invoices en 005), amount > 0, FKs e índices.
--   - Servicio (src/features/cash/service.ts): herencia de opening_base,
--     rechazo de doble apertura con mensaje de negocio (además del
--     índice, que es la barrera final ante carreras), método de pago
--     activo, observación obligatoria si base_left < base_configurada
--     (necesita la base vigente de cash_registers, NO expresable en un
--     CHECK de cash_shifts), expected_cash = efectivo del turno.
--
-- Consolidación T5 (nota T5: consolidar invoice_payments con payments por
-- turno): payments es la tabla del PRD §9.1 (pago atado al turno); cada
-- pago con invoice_id se refleja TAMBIÉN en invoice_payments (dual-write
-- en el servicio), así el saldo de la factura (paid/remaining) sigue
-- saliendo de invoice_payments y los totales por turno/día salen de
-- payments. Decisión documentada en src/features/cash/README.md.
--
-- invoices.cash_shift_id: la columna forward-ref ya existe en 005 (uuid
-- NULL sin FK); aquí se agrega la FK. El bloque DO la crea si faltara
-- (idempotencia) y agrega la constraint solo si no existe.
--
-- RLS: deny-by-default (ENABLE ROW LEVEL SECURITY) con políticas por sede.
-- TODO(seguridad-T7): hoy las sesiones del MVP son tokens opacos propios
-- (tabla sessions, cookie orabella_session), NO JWT de Supabase Auth, así
-- que no hay claim de sede en auth.jwt() que filtrar. Por eso las
-- políticas T6 son permisivas (USING true) y la segregación real por sede
-- la aplica la capa servidor (service_role + requireSedeRole +
-- resolveSede en src/features/cash/service.ts, que reutiliza
-- src/features/admin/service.ts). Al migrar a JWT de Supabase con claim
-- de sede, endurecer cada política a
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid) y revocar este TODO.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------- cash_registers ---
-- CAJ-01: una caja física por sede ("Caja única"), con base configurable.
CREATE TABLE public.cash_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  name text NOT NULL DEFAULT 'Caja única',
  base_configurada numeric(12, 2) NOT NULL DEFAULT 200000 CHECK (base_configurada >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, name)
);

COMMENT ON COLUMN public.cash_registers.base_configurada IS
  'CAJ-04: base de efectivo que debe quedar al cierre (p. ej. 300 000). El primer turno abre con esta base; los siguientes heredan base_left del cierre anterior.';

CREATE INDEX idx_cash_registers_sede_id ON public.cash_registers (sede_id);

CREATE TRIGGER trg_cash_registers_updated_at
  BEFORE UPDATE ON public.cash_registers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Caja única por cada sede existente (las sedes futuras la crean vía
-- servicio al abrir su primer turno).
INSERT INTO public.cash_registers (sede_id, name, base_configurada)
SELECT s.id, 'Caja única', 200000
FROM public.sedes s
WHERE NOT EXISTS (
  SELECT 1 FROM public.cash_registers r WHERE r.sede_id = s.id
);

-- ------------------------------------------------------------- cash_shifts ---
-- CAJ-01…06: turnos de caja con arqueo. opening_base heredada;
-- expected_cash (efectivo cobrado en el turno) vs counted_cash (conteo
-- físico obligatorio); base_left / cash_withdrawn / base_difference al
-- cierre; observation obligatoria si la base queda incompleta (servicio).
CREATE TABLE public.cash_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_register_id uuid NOT NULL REFERENCES public.cash_registers (id),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  opened_by uuid NOT NULL REFERENCES public.users (id),
  closed_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  opening_base numeric(12, 2) NOT NULL CHECK (opening_base >= 0),
  expected_cash numeric(12, 2) NOT NULL DEFAULT 0 CHECK (expected_cash >= 0),
  counted_cash numeric(12, 2) NULL CHECK (counted_cash IS NULL OR counted_cash >= 0),
  base_left numeric(12, 2) NULL CHECK (base_left IS NULL OR base_left >= 0),
  cash_withdrawn numeric(12, 2) NULL,
  base_difference numeric(12, 2) NULL,
  status text NOT NULL DEFAULT 'abierto'
    CHECK (status IN ('abierto', 'cerrado')),
  observation text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- CAJ-03: no se puede cerrar sin conteo de efectivo ni sin base dejada.
  CHECK (status <> 'cerrado' OR counted_cash IS NOT NULL),
  CHECK (status <> 'cerrado' OR base_left IS NOT NULL),
  CHECK (status <> 'cerrado' OR cash_withdrawn IS NOT NULL),
  CHECK (status <> 'cerrado' OR base_difference IS NOT NULL),
  CHECK (status <> 'cerrado' OR closed_at IS NOT NULL),
  -- cash_withdrawn = counted_cash − base_left (tolerancia de centavo).
  CHECK (
    status <> 'cerrado'
    OR abs(cash_withdrawn - (counted_cash - base_left)) < 0.01
  )
);

COMMENT ON COLUMN public.cash_shifts.opening_base IS
  'CAJ-01: base con la que abre el turno = base_left del cierre anterior (o base_configurada si es el primero).';
COMMENT ON COLUMN public.cash_shifts.expected_cash IS
  'CAJ-03: efectivo cobrado según los payments del turno (method_code = efectivo). Lo calcula el servicio al cerrar.';
COMMENT ON COLUMN public.cash_shifts.base_difference IS
  'CAJ-04: base_left − base_configurada vigente (negativo = faltante, positivo = sobrante). Si base_left < base_configurada la observación es obligatoria (regla en servicio).';

-- CAJ-01: un solo turno abierto por caja (sin solape). Barrera final ante
-- carreras concurrentes; el servicio rechaza antes con mensaje de negocio.
CREATE UNIQUE INDEX uq_cash_shifts_open_per_register
  ON public.cash_shifts (cash_register_id)
  WHERE status = 'abierto';

CREATE INDEX idx_cash_shifts_register_opened
  ON public.cash_shifts (cash_register_id, opened_at);
CREATE INDEX idx_cash_shifts_sede_opened
  ON public.cash_shifts (sede_id, opened_at);

CREATE TRIGGER trg_cash_shifts_updated_at
  BEFORE UPDATE ON public.cash_shifts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- payments ---
-- CAJ-02: pagos del PRD §9.1 contra el turno abierto (método del catálogo
-- con snapshot en method_code; invoice_id nullable para ajustes
-- documentados o cobros sin factura). Ver consolidación T5 en el encabezado.
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id),
  cash_shift_id uuid NOT NULL REFERENCES public.cash_shifts (id),
  invoice_id uuid NULL REFERENCES public.invoices (id) ON DELETE SET NULL,
  method_id uuid NULL REFERENCES public.payment_methods (id) ON DELETE SET NULL,
  method_code text NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  user_id uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments IS
  'CAJ-02 (T6): pagos por turno (PRD §9.1). Todo pago con invoice_id se refleja también en invoice_payments (dual-write) para que el saldo de la factura siga cuadrando; ver src/features/cash/README.md.';

CREATE INDEX idx_payments_cash_shift_id ON public.payments (cash_shift_id);
CREATE INDEX idx_payments_invoice_id ON public.payments (invoice_id);

-- --------------------------------------- invoices.cash_shift_id → FK (T5→T6) ---
-- La columna forward-ref llegó en 005; aquí se vincula al turno.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoices'
      AND column_name = 'cash_shift_id'
  ) THEN
    ALTER TABLE public.invoices ADD COLUMN cash_shift_id uuid NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'invoices'
      AND constraint_name = 'fk_invoices_cash_shift'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT fk_invoices_cash_shift
      FOREIGN KEY (cash_shift_id)
      REFERENCES public.cash_shifts (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ------------------------------------------------------------------- RLS ---
-- Deny-by-default en las 3 tablas. Ver el TODO del encabezado: políticas
-- permisivas temporales (USING true) porque aún no hay JWT con claim de
-- sede; la segregación por sede la aplica hoy la capa servidor.
ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
CREATE POLICY pol_cash_registers_sede_isolation ON public.cash_registers
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: un turno abierto por caja; cierre exige conteo (capa servidor).
CREATE POLICY pol_cash_shifts_sede_isolation ON public.cash_shifts
  FOR ALL USING (true) WITH CHECK (true);

-- TODO(seguridad-T7): endurecer a sede del JWT cuando exista
-- (sede_id = (auth.jwt() ->> 'sede_id')::uuid).
-- Nota §9.4: atado a turno + factura; suma cuadra (capa servidor).
CREATE POLICY pol_payments_sede_isolation ON public.payments
  FOR ALL USING (true) WITH CHECK (true);

-- ================= 007_payroll.sql =================
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

-- ================= 008_hardening.sql =================
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

-- ================= 009_cash_control.sql =================
-- 009_cash_control.sql — Control antifraude de caja (CASH-01).
--
-- - payment_methods.arqueable: el admin configura qué métodos se arquean
--   (p. ej. tarjeta por terminal no se puede contar físicamente).
-- - cash_shift_counts: detalle del conteo por denominación (efectivo) o
--   total declarado (digitales), en apertura y cierre. Sin este detalle no
--   hay forma de auditar un faltante.

-- ---------------------------------------------------------------- métodos ---

ALTER TABLE public.payment_methods
  ADD COLUMN arqueable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.payment_methods.arqueable IS
  'CASH: si el método se arquea en apertura/cierre (efectivo por denominación, digitales por total declarado).';

-- ---------------------------------------------------------------- conteos ---

CREATE TABLE public.cash_shift_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.cash_shifts (id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('apertura', 'cierre')),
  method_code text NOT NULL,
  denomination numeric(12, 2) NULL CHECK (denomination IS NULL OR denomination > 0),
  quantity integer NOT NULL CHECK (quantity >= 0),
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Efectivo: denomination obligatoria y amount = denomination * quantity.
  -- Digital: denomination NULL y quantity = 1 con el total declarado.
  CHECK (
    (denomination IS NOT NULL AND quantity >= 0)
    OR (denomination IS NULL AND quantity = 1)
  )
);

CREATE INDEX idx_shift_counts_shift_id ON public.cash_shift_counts (shift_id);

COMMENT ON TABLE public.cash_shift_counts IS
  'CASH: detalle de conteo de apertura/cierre por método y denominación. Evidencia ante faltantes/sobrantes.';

-- ================= 010_cash_denominations.sql =================
-- 010_cash_denominations.sql — Denominaciones configurables por sede (CASH).
--
-- Las denominaciones no van quemadas en código: otro país u otra moneda
-- (o una redenominación) se resuelve desde el admin, sin despliegue.

CREATE TABLE public.cash_denominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id uuid NOT NULL REFERENCES public.sedes (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('billete', 'moneda')),
  value numeric(12, 2) NOT NULL CHECK (value > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, value)
);

CREATE INDEX idx_cash_denominations_sede_id ON public.cash_denominations (sede_id);

COMMENT ON TABLE public.cash_denominations IS
  'CASH: denominaciones de efectivo por sede para el conteo por denominación.';

-- Siembra COP por defecto para las sedes existentes (billetes y monedas
-- vigentes). El admin puede ajustarlas después.
INSERT INTO public.cash_denominations (sede_id, kind, value)
SELECT s.id, v.kind, v.value
FROM public.sedes AS s
CROSS JOIN (VALUES
  ('billete', 100000), ('billete', 50000), ('billete', 20000),
  ('billete', 10000), ('billete', 5000), ('billete', 2000),
  ('moneda', 1000), ('moneda', 500), ('moneda', 200),
  ('moneda', 100), ('moneda', 50)
) AS v(kind, value)
ON CONFLICT (sede_id, value) DO NOTHING;

-- ================= seeds/acceptance.sql =================
-- acceptance.sql — Seeds de aceptación global §11 (T8).
--
-- Criterio §11: "datos de prueba del negocio (10 empleados, servicios con
-- duración min/max, impuestos en 0 con 1 activación de prueba, 6 métodos de
-- pago, 2 turnos/día con casos 400/200 y 300/150, 1 periodo de nómina mixta
-- con pago dividido y 1 vale sobre tope aprobado)".
--
-- Este seed deja la BASE (sede, catálogos, empleados, caja lista); los turnos,
-- facturas, periodos y vales se crean por UI/flujos (ver README). NO incluye
-- datos de clientes reales: todos los nombres son ficticios colombianos y los
-- correos usan el dominio reservado ejemplo.co.
--
-- IDEMPOTENTE: re-ejecutable sin duplicar (ON CONFLICT DO NOTHING / DO UPDATE
-- donde hay unique, WHERE NOT EXISTS donde no lo hay).
-- Orden de aplicación: migraciones 001 → 008 primero, luego este seed.

DO $$
DECLARE
  v_sede uuid;
  v_admin uuid;
BEGIN
  -- ---------------------------------------------------------- sede (una) ---
  INSERT INTO public.sedes (name, address, phone)
  SELECT 'Sede principal', 'Calle 123 #45-67, Bogotá', '6015550134'
  WHERE NOT EXISTS (SELECT 1 FROM public.sedes WHERE name = 'Sede principal');

  SELECT id INTO v_sede FROM public.sedes WHERE name = 'Sede principal' LIMIT 1;

  -- ------------------------------------------------- usuarios (10, ficticios) ---
  -- Clave inicial = documento con cambio forzado (AUTH-01); hashes scrypt
  -- generados con el mismo formato de src/features/auth/service.ts.
  INSERT INTO public.users (sede_id, email, phone, id_type, id_number, password_hash, full_name, must_change_password) VALUES
    (v_sede, 'carolina.rojas@ejemplo.co', '3001110101', 'CC', '10000001', 'scrypt$v1$69acededf17b680588168930de483177$9921a732fc19f29e6638657b595df1bf2e39ffb8c9ffc1fbfea5add51c62ca5f5d1890d976afcf036e137bc6a03c60b46bb39b05f3558174afe0fe0ec36484ef', 'Carolina Rojas', true),
    (v_sede, 'diego.mejia@ejemplo.co', '3001110102', 'CC', '10000002', 'scrypt$v1$006ddd7f24bb4f8f31f0d6f67c683c0f$d466efa1e6bebfa47c17d39902c976a65945968815129250ff7bd68e9685aeaf753eb3c19400efc69dcd6af893475dc6186a4160d77492740a380051a125097d', 'Diego Mejía', true),
    (v_sede, 'paola.cifuentes@ejemplo.co', '3001110103', 'CC', '10000003', 'scrypt$v1$af6196d1e030a7498c6bdbd9bff06143$92e97f572b28d3107e01d8f074a7d557014a2ec92b36b3efa75fd6d65785980259b4e3a5c5f4921e11de636b196ece1456ec1afeae447eeb54d89ce318a2ca99', 'Paola Cifuentes', true),
    (v_sede, 'andres.quintero@ejemplo.co', '3001110104', 'CC', '10000004', 'scrypt$v1$b2a8266d8161152350b363ae0b4cfc95$7deae194e262aba38e03e4dd26d5cb5fb456122067231f14fcbef14e00df36e74057fcdeab6649e2612f4c6bab67aeb2134747af144dae5354d176d22cefc097', 'Andrés Quintero', true),
    (v_sede, 'lucia.herrera@ejemplo.co', '3001110105', 'CC', '10000005', 'scrypt$v1$1f279aa26ec25aaf7a9fa931d8c59a10$34825f1d62ee2de62fdc0a17f1258becec7119eca25d52b557e5b9cb512330bbfc5c8269ed3259eba7aed7b42cbeb01800658c72ac91a9161447a058b13c14a1', 'Lucía Herrera', true),
    (v_sede, 'marco.ospina@ejemplo.co', '3001110106', 'CC', '10000006', 'scrypt$v1$01f3f819f401e92eb102621e717e40f1$cbbf38a883c58da92d2afbb92224931a78fbdd44133a9dd28a6234e86ab829884a5bb048f7cc122f0fd38b84db2dcff3e02759fd9389a4f9071044a848fa60b', 'Marco Ospina', true),
    (v_sede, 'elena.vargas@ejemplo.co', '3001110107', 'CC', '10000007', 'scrypt$v1$72af6d5b10a65bbb560a00df3bcaf1ea$ef5ae6ddab4793a3f2d9a920c7c257577da66256f824a63f880db5dad39b6c42193175011777bf78e15bf6e5da02f474001a582061d87eb014267f72830837c', 'Elena Vargas', true),
    (v_sede, 'jorge.ramirez@ejemplo.co', '3001110108', 'CC', '10000008', 'scrypt$v1$b7fa6943a0155e2134c596b885639927$d4552c41c5c2933a2fe531bfbf68af059eb937a583bcb3c8e32ee720824f6fb9cbe087dd5a297de4df8e618cb2e12b31c64056426310b1a663391b0317a58480', 'Jorge Ramírez', true),
    (v_sede, 'natalia.pardo@ejemplo.co', '3001110109', 'CC', '10000009', 'scrypt$v1$a4961c06ecdd0a609e227527b9c6fa53$0fc8dfe6d9fedeef91626fa9b0a4cbddbfd56a56d50e26255da8968001bf2044131f4d1a4cdfe960d4d67de34fe17fac10c058466da31d4cd008b9f3e3c632d5', 'Natalia Pardo', true),
    (v_sede, 'sonia.morales@ejemplo.co', '3001110113', 'CC', '10000013', 'scrypt$v1$f860084ccb51c9801680c30b43669f88$75b31019e3b60a516639636ce7195d7afffe28bd819031d29ac8ba1a5206b51bbbaae5345d45a141ceaf6c0fed4c5f37389677c48ab851a7c1d491e2b5d612e3', 'Sonia Morales', true)
  ON CONFLICT (id_number) DO NOTHING;

  -- Roles: 1 admin (Carolina), Sonia con doble rol empleado+caja (edge F1),
  -- resto repartido entre empleado y caja.
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number = '10000001' AND r.code = 'admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number IN ('10000002', '10000003', '10000004', '10000005', '10000006') AND r.code = 'empleado'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number IN ('10000007', '10000008', '10000009') AND r.code = 'caja'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id)
  SELECT u.id, r.id FROM public.users u, public.roles r
  WHERE u.id_number = '10000013' AND r.code IN ('empleado', 'caja')
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_admin FROM public.users WHERE id_number = '10000001' LIMIT 1;

  -- --------------------------------------- empleados (10, Sonia mixta '13') ---
  -- Códigos con valor únicos por sede; dos sin código (NULL y vacío) para
  -- ejercitar la unicidad parcial ADM-03.
  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '01', '10000001', '3001110101', 'Administradora', 'fijo', 1500000, NULL FROM public.users u WHERE u.id_number = '10000001'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '02', '10000002', '3001110102', 'Estilista', 'porcentaje', NULL, 30 FROM public.users u WHERE u.id_number = '10000002'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '03', '10000003', '3001110103', 'Manicurista', 'mixto', 800000, 20 FROM public.users u WHERE u.id_number = '10000003'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '04', '10000004', '3001110104', 'Barbero', 'porcentaje', NULL, 35 FROM public.users u WHERE u.id_number = '10000004'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, NULL, '10000005', '3001110105', 'Recepcionista', 'fijo', 1300000, NULL FROM public.users u WHERE u.id_number = '10000005'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '', '10000006', '3001110106', 'Auxiliar', 'fijo', 1200000, NULL FROM public.users u WHERE u.id_number = '10000006'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '07', '10000007', '3001110107', 'Cajera', 'fijo', 1400000, NULL FROM public.users u WHERE u.id_number = '10000007'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '08', '10000008', '3001110108', 'Cajero', 'fijo', 1400000, NULL FROM public.users u WHERE u.id_number = '10000008'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '09', '10000009', '3001110109', 'Colorista', 'mixto', 900000, 25 FROM public.users u WHERE u.id_number = '10000009'
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.employees (sede_id, user_id, full_name, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent)
  SELECT v_sede, u.id, u.full_name, '13', '10000013', '3001110113', 'Estilista senior', 'mixto', 1000000, 30 FROM public.users u WHERE u.id_number = '10000013'
  ON CONFLICT (user_id) DO NOTHING;

  -- ----------------------------------------------- servicios (4, min/max) ---
  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Corte de cabello', 'Corte unisex con acabado', 35000, 30, 45
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Corte de cabello');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Tinte completo', 'Coloración con producto incluido', 120000, 90, 150
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Tinte completo');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Manicura', 'Manicura tradicional', 30000, 30, 60
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Manicura');

  INSERT INTO public.services (sede_id, name, description, price, duracion_min, duracion_max)
  SELECT v_sede, 'Peinado fiesta', 'Peinado para eventos', 50000, 40, 60
  WHERE NOT EXISTS (SELECT 1 FROM public.services WHERE sede_id = v_sede AND name = 'Peinado fiesta');

  -- -------------------------------------- productos (3, stock vía IN) ---
  INSERT INTO public.products (sede_id, sku, name, description, min_stock, cost_price, sale_price)
  VALUES
    (v_sede, 'SH-500', 'Shampoo 500ml', 'Shampoo uso profesional', 5, 18000, 28000),
    (v_sede, 'TN-250', 'Tinte rubio 250ml', 'Tinte permanente', 10, 25000, 42000),
    (v_sede, 'ES-100', 'Esmalte rojo 100ml', 'Esmalte tradicional', 8, 9000, 15000)
  ON CONFLICT (sede_id, sku) DO NOTHING;

  -- Stock inicial SOLO vía movimientos IN (INV-03); el motivo fijo hace el
  -- seed re-ejecutable sin duplicar (el trigger suma al stock).
  -- TN-250 entra con 3 (< mínimo 10) para ejercitar la alerta de mínimo.
  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 20, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'SH-500'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 3, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'TN-250'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  INSERT INTO public.inventory_movements (sede_id, product_id, type, qty, reason, user_id)
  SELECT v_sede, p.id, 'IN', 12, 'SEED aceptación §11: stock inicial', v_admin
  FROM public.products p WHERE p.sede_id = v_sede AND p.sku = 'ES-100'
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    WHERE m.product_id = p.id AND m.reason = 'SEED aceptación §11: stock inicial'
  );

  -- ------------------ impuestos (IVA 19% activado de prueba + ICA inactivo) ---
  INSERT INTO public.tax_configs (sede_id, code, name, percent, is_active)
  VALUES (v_sede, 'IVA', 'IVA general', 19, true)
  ON CONFLICT (sede_id, code, name)
  DO UPDATE SET percent = EXCLUDED.percent, is_active = EXCLUDED.is_active, updated_at = now();

  INSERT INTO public.tax_configs (sede_id, code, name, percent, is_active)
  VALUES (v_sede, 'ICA', 'ICA', 0, false)
  ON CONFLICT (sede_id, code, name)
  DO UPDATE SET percent = EXCLUDED.percent, is_active = EXCLUDED.is_active, updated_at = now();

  -- ------------------------------------------- métodos de pago (6, activos) ---
  INSERT INTO public.payment_methods (sede_id, code, name, is_active)
  VALUES
    (v_sede, 'efectivo', 'Efectivo', true),
    (v_sede, 'transferencia_normal', 'Transferencia / PSE', true),
    (v_sede, 'nequi', 'Nequi', true),
    (v_sede, 'daviplata', 'Daviplata', true),
    (v_sede, 'bre-b', 'Bre-B', true),
    (v_sede, 'tarjeta', 'Tarjeta', true)
  ON CONFLICT (sede_id, code)
  DO UPDATE SET name = EXCLUDED.name, is_active = true;

  -- ----------------------- caja lista (base configurada; turnos por UI) ---
  -- Los 2 turnos/día de §11 (casos 400/200 y 300/150) se crean por UI contra
  -- el turno abierto; el seed NO crea cash_shifts.
  INSERT INTO public.cash_registers (sede_id, name, base_configurada, is_active)
  VALUES (v_sede, 'Caja única', 300000, true)
  ON CONFLICT (sede_id, name)
  DO UPDATE SET base_configurada = EXCLUDED.base_configurada, updated_at = now();
END
$$;
