-- =============================================================================
-- platform-roles.sql — SOLO para un PostgreSQL que NO es Supabase
-- =============================================================================
--
-- QUÉ HACE
--   Crea los tres roles de API que `001_orabella_schema.sql` nombra en sus
--   `GRANT` y `CREATE POLICY ... TO`, si todavía no existen. Sin ellos `001`
--   aborta con `role "authenticated" does not exist`.
--
--     anon, authenticated, service_role — NOLOGIN, sin privilegios propios.
--
--   `001` solo nombra `authenticated` y `service_role`; `anon` se crea porque
--   todo proyecto Supabase lo tiene y así los dos destinos quedan iguales.
--
-- QUÉ NO HACE, Y POR QUÉ
--   - No crea el esquema `auth` ni `auth.jwt()`. `001` crea `current_sede_id()`
--     sin el esquema (su preámbulo fija `check_function_bodies = false`) y `002`
--     la reemplaza por una versión que no lo usa. Ninguna otra sentencia
--     ejecutable de `001` lo nombra.
--   - No crea el esquema `extensions` ni instala extensiones. `001` no califica
--     nada con `extensions.` y pide las suyas con `CREATE EXTENSION IF NOT
--     EXISTS ... WITH SCHEMA public`:
--       * `btree_gist`: necesaria (la exclusión `ex_payroll_periods_no_overlap`).
--       * `pgcrypto`: se instala, pero el esquema no la usa; el único generador
--         que llama es `gen_random_uuid()`, nativo desde PostgreSQL 13.
--       * `uuid-ossp`: `001` no la pide y no la usa. Supabase la trae, este
--         archivo no.
--     El servidor necesita tener disponibles los contrib `btree_gist` y
--     `pgcrypto` (vienen con cualquier PostgreSQL estándar).
--
-- LÍMITE CONOCIDO (pendiente de la Fase 3)
--   `service_role` se crea SIN BYPASSRLS y sin permisos sobre tablas. `001` solo
--   concede permisos sobre funciones: el acceso a tablas en Supabase viene de los
--   privilegios por defecto de la plataforma. La instalación termina, pero la app
--   no puede operar sobre ella hasta que la Fase 3 defina el rol de la aplicación.
--   Ver supabase/squash/README.md §9.6.
--
-- CÓMO SE APLICA
--   Una vez, ANTES de `001`, como un rol con CREATEROLE:
--
--       psql -v ON_ERROR_STOP=1 -f supabase/bootstrap/platform-roles.sql
--
--   Orden completo en PostgreSQL limpio:
--       bootstrap/platform-roles.sql → 001 → 002 → seeds
--
--   Es idempotente. En Supabase no hace falta (los roles ya existen) y, si se
--   corre por error, no hace nada.
-- =============================================================================

DO $bootstrap$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$bootstrap$;
