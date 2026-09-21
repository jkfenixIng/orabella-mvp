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
