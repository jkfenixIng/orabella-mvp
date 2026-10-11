-- portable-migration-audit.sql — deployment migration evidence ledger
--
-- Apply once, deliberately, to a plain PostgreSQL destination before executing a
-- portable migration plan. This is not an application migration and does not
-- apply any schema migration. The operator records each migration only after its
-- psql command succeeds. The planner and verifier consume an export of this
-- ledger; they never query or modify a database.

CREATE TABLE IF NOT EXISTS public.portable_migration_audit (
  filename text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  applied_by name NOT NULL DEFAULT current_user
);

REVOKE ALL ON public.portable_migration_audit FROM PUBLIC;
REVOKE ALL ON public.portable_migration_audit FROM anon;
REVOKE ALL ON public.portable_migration_audit FROM authenticated;
GRANT SELECT, INSERT ON public.portable_migration_audit TO service_role;
