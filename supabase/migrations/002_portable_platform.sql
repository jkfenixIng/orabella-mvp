-- =============================================================================
-- 002_portable_platform.sql — current_sede_id() sin depender de auth.jwt()
-- =============================================================================
--
-- QUÉ HACE
--   Redefine `public.current_sede_id()` para que lea los claims del JWT
--   directamente de `current_setting(...)`, sin llamar a `auth.jwt()`. Es lo
--   único que impedía usar el esquema en un PostgreSQL sin el esquema `auth` de
--   Supabase: `001` crea la función igual (corre con `check_function_bodies =
--   false`), pero la llamada fallaba con `schema "auth" does not exist`.
--
-- POR QUÉ EL RESULTADO ES EL MISMO EN SUPABASE
--   `auth.jwt()` está definida por Supabase Auth (migración
--   `20220531120530_add_auth_jwt_function.up.sql` de supabase/auth) como:
--
--       select coalesce(
--           nullif(current_setting('request.jwt.claim', true), ''),
--           nullif(current_setting('request.jwt.claims', true), '')
--       )::jsonb
--
--   El cuerpo de abajo evalúa ESA MISMA expresión, una sola vez, y aplica el
--   mismo CASE que `001`. Mismos valores de entrada, mismo resultado:
--     - sin claims (o claims vacíos): NULL;
--     - `app_metadata.sede_id` con forma de UUID: ese UUID;
--     - cualquier otra cosa: NULL (deny-by-default);
--     - claims que no son JSON válido: el mismo error de cast que `auth.jwt()`.
--   La equivalencia está probada en `tests/db/portable-platform.db.test.ts`
--   contra esa definición de `auth.jwt()`.
--
-- QUÉ NO CAMBIA
--   Firma, `RETURNS uuid`, `LANGUAGE sql`, `STABLE`, `SECURITY DEFINER` y
--   `SET search_path TO 'public'`, igual que en `001`. `CREATE OR REPLACE`
--   conserva el propietario y la ACL: los `GRANT` a `authenticated` y
--   `service_role` de `001` siguen en pie. Las 5 políticas `TO authenticated`
--   siguen llamando a la misma función. Este archivo no tiene `GRANT`, `REVOKE`
--   ni `POLICY`.
--
-- CÓMO SE APLICA
--   Después de `001`, en la misma base. Es idempotente (correrlo dos veces deja
--   lo mismo) y transaccional (BEGIN/COMMIT propios):
--
--       psql -v ON_ERROR_STOP=1 -f supabase/migrations/002_portable_platform.sql
--
--   En un PostgreSQL que no es Supabase, el orden completo es
--   `supabase/bootstrap/platform-roles.sql` → `001` → `002` → seeds.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.current_sede_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  SELECT CASE
    WHEN (jwt.claims -> 'app_metadata' ->> 'sede_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (jwt.claims -> 'app_metadata' ->> 'sede_id')::uuid
    ELSE NULL
  END
  FROM (
    SELECT coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')
    )::jsonb AS claims
  ) AS jwt;
$_$;

COMMENT ON FUNCTION public.current_sede_id() IS 'T8: sede del JWT (claim app_metadata.sede_id inyectado por el Auth Hook custom_access_token_hook). NULL = sin acceso (deny-by-default). 002: lee request.jwt.claims igual que auth.jwt(), sin depender del esquema auth.';

COMMIT;
