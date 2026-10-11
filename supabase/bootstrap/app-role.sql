-- =============================================================================
-- app-role.sql — application role, ONLY for a PostgreSQL that is NOT Supabase
-- =============================================================================
--
-- WHAT IT DOES
--   Creates `orabella_app`, the role the app logs in with when DB_ENGINE=postgres
--   (DATABASE_URL), and gives it exactly the access the app has today in
--   Supabase through `service_role`:
--
--     * LOGIN BYPASSRLS. Deliberate: in Supabase the app talks with
--       `service_role`, which bypasses RLS, and the app does not rely on RLS
--       (README, "Postura real (D8)"). The policies of 001 are `TO authenticated`;
--       a role that does not bypass them would see no rows.
--     * Member of `service_role` (INHERIT): inherits the EXECUTE that 001 grants
--       on the RPCs, without repeating the grant list here.
--     * USAGE on schema `public` and SELECT/INSERT/UPDATE/DELETE on every table
--       of `public` that exists when this file runs.
--
-- WHAT IT DOES NOT DO
--   - No password. Set it outside the repo, once, with the server's own tools:
--       psql "<superuser-url>" -c "\password orabella_app"
--     and put the resulting connection string in DATABASE_URL (a secret of the
--     deployment, never committed).
--   - No ALTER DEFAULT PRIVILEGES: a table added by a later migration is
--     granted by running this file again after that migration.
--   - No grants on sequences: 001 has none (every key is gen_random_uuid()).
--
-- HOW TO APPLY
--   As a superuser (only a superuser can grant BYPASSRLS), after the schema:
--
--       bootstrap/platform-roles.sql → 001 → 002 → bootstrap/app-role.sql → seeds
--
--   Idempotent: running it again changes nothing. NEVER apply it in Supabase,
--   where the app keeps using `service_role`.
--
-- SUPABASE GUARD
--   The file aborts BEFORE creating anything if the server is a Supabase
--   instance. Indicator: any of the platform's own roles exists
--   (`supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`).
--   Why roles and not the `auth` schema:
--     * roles are cluster-wide and exist from the first boot of every Supabase
--       instance (hosted, CLI and self-hosted images), even an empty project,
--       and in every database of the cluster;
--     * nobody creates them on a plain PostgreSQL: platform-roles.sql creates
--       only `anon`, `authenticated` and `service_role`, which are therefore
--       NOT a signal;
--     * an `auth` schema is per database, can be missing (other database of the
--       cluster) or exist for unrelated reasons on a plain server.
--   The whole file is one DO block, so the abort leaves nothing behind.
-- =============================================================================

DO $app_role$
DECLARE
  table_name text;
  platform_role text;
BEGIN
  SELECT rolname INTO platform_role
    FROM pg_catalog.pg_roles
   WHERE rolname IN ('supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')
   ORDER BY rolname
   LIMIT 1;
  IF platform_role IS NOT NULL THEN
    RAISE EXCEPTION 'app-role.sql must not run on Supabase (role "%" exists)', platform_role
      USING HINT = 'In Supabase the app connects with service_role; orabella_app is only for a plain PostgreSQL.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'orabella_app') THEN
    CREATE ROLE orabella_app LOGIN BYPASSRLS INHERIT;
  END IF;
  ALTER ROLE orabella_app LOGIN BYPASSRLS INHERIT;

  IF NOT pg_catalog.pg_has_role('orabella_app', 'service_role', 'MEMBER') THEN
    GRANT service_role TO orabella_app;
  END IF;

  GRANT USAGE ON SCHEMA public TO orabella_app;

  FOR table_name IN
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename
  LOOP
    IF table_name IN ('installation_owner', 'installation_owner_operation') THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM orabella_app', table_name);
    ELSE
      EXECUTE pg_catalog.format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO orabella_app',
        table_name
      );
    END IF;
  END LOOP;
END
$app_role$;
