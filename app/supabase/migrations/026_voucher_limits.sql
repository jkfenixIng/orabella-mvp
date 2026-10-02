-- 026_voucher_limits.sql — topes de vales opcionales + tope propio por día (V2).
--
-- Modelo:
--   - max_per_day / max_per_week pasan a NULL-ables: NULL = "sin tope"
--     (ilimitado). Antes eran NOT NULL DEFAULT 0 y un 0 se interpretaba como
--     sin tope en el servicio, pero no se podía expresar "sin topes" al
--     configurar. El servicio sigue tratando 0 o NULL como sin tope.
--   - per_day_limits jsonb {"3": 50000}: tope propio por día ISO
--     (1=lunes…7=domingo). Cuando existe la clave del día, REEMPLAZA al tope
--     diario general ese día (decisión de producto); el semanal no cambia.
--     Vacío {} = sin topes por día.
--   - La validación fina de claves/valores vive en el servicio (Zod): un
--     CHECK de Postgres no admite subconsultas sobre jsonb_each.
-- Re-ejecutable: DROP CONSTRAINT IF EXISTS + ADD COLUMN IF NOT EXISTS.

-- ------------------------------------------------- columnas ---
ALTER TABLE public.voucher_settings ALTER COLUMN max_per_day DROP NOT NULL;
ALTER TABLE public.voucher_settings ALTER COLUMN max_per_week DROP NOT NULL;

ALTER TABLE public.voucher_settings
  ADD COLUMN IF NOT EXISTS per_day_limits jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------- CHECK ---
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_voucher_settings_per_day_limits'
  ) THEN
    ALTER TABLE public.voucher_settings
      ADD CONSTRAINT chk_voucher_settings_per_day_limits
      CHECK (jsonb_typeof(per_day_limits) = 'object');
  END IF;
END
$$;

COMMENT ON COLUMN public.voucher_settings.max_per_day IS
'V2: tope diario general. NULL o 0 = sin tope. El tope propio del día (per_day_limits) lo reemplaza ese día.';

COMMENT ON COLUMN public.voucher_settings.per_day_limits IS
'V2: tope propio por día ISO {"3": 50000}. Reemplaza al tope diario general ese día; {} = sin topes por día.';
