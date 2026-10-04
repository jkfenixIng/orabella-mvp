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
