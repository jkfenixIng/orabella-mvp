-- 024_voucher_days.sql — días permitidos de vales por sede (item 5 SECUENCIADO).
--
-- Modelo: voucher_settings.allowed_days (smallint[] ISO 1=lunes…7=domingo).
-- NULL o ausente = todos los días (comportamiento previo). Pedir un vale en
-- día no permitido NO lo bloquea: queda pendiente y exige revisión del admin
-- (alerta voucher.requested), igual que superar los topes día/semana.
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS + bloque DO para el CHECK.

-- ------------------------------------------------- columna ---
ALTER TABLE public.voucher_settings
  ADD COLUMN IF NOT EXISTS allowed_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}';

-- ------------------------------------------------- CHECK ---
-- Cada día en 1…7 y al menos un día permitido (contención vacía = nada permitido).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_voucher_settings_allowed_days'
  ) THEN
    ALTER TABLE public.voucher_settings
      ADD CONSTRAINT chk_voucher_settings_allowed_days
      CHECK (allowed_days <@ '{1,2,3,4,5,6,7}' AND cardinality(allowed_days) > 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.voucher_settings.allowed_days IS
'Item 5: días ISO (1=lunes…7=domingo) en que se pueden pedir vales. Pedir fuera de estos días exige revisión del admin (no bloquea). Por defecto todos.';
