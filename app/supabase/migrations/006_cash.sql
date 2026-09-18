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
