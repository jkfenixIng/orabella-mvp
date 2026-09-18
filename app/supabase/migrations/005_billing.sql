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
