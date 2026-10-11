-- portable-migration-audit.sql — deployment-control ledger for plain PostgreSQL
--
-- Apply once, separately from application migrations, as the database owner.
-- It creates no application schema and does not apply a migration.
--
-- REQUIRED OPERATOR GRANT (run as the DB owner after this file):
--   GRANT migration_operator TO <MIGRATION_LOGIN> WITH INHERIT FALSE;
-- Replace <MIGRATION_LOGIN> with the dedicated migration-runner login. Do not
-- grant it to orabella_app, service_role, anon or authenticated. A SQL Editor
-- operator must use a login with this same explicit membership and SET ROLE.

DO $bootstrap$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_operator') THEN
    CREATE ROLE migration_operator NOLOGIN NOINHERIT;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['orabella_app', 'service_role', 'anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('REVOKE migration_operator FROM %I', role_name);
    END IF;
  END LOOP;
END
$bootstrap$;

CREATE TABLE IF NOT EXISTS public.portable_migration_audit (
  filename text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  applied_by name NOT NULL DEFAULT session_user,
  reconciled boolean NOT NULL DEFAULT false,
  reason text
);

ALTER TABLE public.portable_migration_audit
  ADD COLUMN IF NOT EXISTS reconciled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.portable_migration_audit
  ALTER COLUMN applied_by SET DEFAULT session_user;

REVOKE ALL ON public.portable_migration_audit FROM PUBLIC;
REVOKE ALL ON public.portable_migration_audit FROM anon;
REVOKE ALL ON public.portable_migration_audit FROM authenticated;
REVOKE ALL ON public.portable_migration_audit FROM service_role;

DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'orabella_app') THEN
    REVOKE ALL ON public.portable_migration_audit FROM orabella_app;
  END IF;
END
$acl$;

GRANT USAGE ON SCHEMA public TO migration_operator;
GRANT SELECT, INSERT ON public.portable_migration_audit TO migration_operator;
GRANT SELECT ON public.portable_migration_audit TO service_role;
