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
