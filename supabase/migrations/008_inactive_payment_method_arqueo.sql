-- 008_inactive_payment_method_arqueo.sql
-- Inactive payment methods cannot remain arqueable. The 003 trigger keeps the
-- derived `arqueable` compatibility column synchronized.
BEGIN;

UPDATE public.payment_methods
   SET arqueo_mode = 'none'
 WHERE is_active IS NOT TRUE
   AND arqueo_mode <> 'none';

ALTER TABLE public.payment_methods
  DROP CONSTRAINT IF EXISTS payment_methods_arqueo_coherent_check;

ALTER TABLE public.payment_methods
  ADD CONSTRAINT payment_methods_arqueo_coherent_check
    CHECK (
      arqueable = (arqueo_mode <> 'none')
      AND (is_active OR arqueo_mode = 'none')
    );

CREATE OR REPLACE FUNCTION public.payment_method_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CODE_IMMUTABLE';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.arqueo_mode IS NULL THEN
      NEW.arqueo_mode := CASE
        WHEN NEW.arqueable IS NOT TRUE THEN 'none'
        WHEN NEW.code = 'efectivo' THEN 'denominations'
        ELSE 'declared_total'
      END;
    END IF;
  ELSIF NEW.arqueo_mode IS NOT DISTINCT FROM OLD.arqueo_mode
        AND NEW.arqueable IS DISTINCT FROM OLD.arqueable THEN
    NEW.arqueo_mode := CASE
      WHEN NEW.arqueable IS NOT TRUE THEN 'none'
      WHEN OLD.arqueo_mode <> 'none' THEN OLD.arqueo_mode
      WHEN NEW.code = 'efectivo' THEN 'denominations'
      ELSE 'declared_total'
    END;
  END IF;

  IF NEW.is_active IS NOT TRUE THEN
    NEW.arqueo_mode := 'none';
  END IF;
  NEW.arqueable := NEW.arqueo_mode IS DISTINCT FROM 'none';
  RETURN NEW;
END;
$$;

COMMIT;
