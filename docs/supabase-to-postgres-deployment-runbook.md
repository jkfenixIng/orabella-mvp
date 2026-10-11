# Runbook: Supabase → PostgreSQL (staging and production)

## Scope and safety boundary

This runbook moves the application's database target from Supabase to a plain PostgreSQL instance. It applies the discovered incremental migrations after the already-applied `001` baseline, validates staging first, and changes the deployment to `DB_ENGINE=postgres` only after production approval. At this revision, the discovered set is `002` through `005`; later integrated migrations are not assumed.

- **Read-only / preparation** sections do not change a database or deployment.
- **Write** sections run migrations, provisioning, restore, or deployment changes. Treat every such command as irreversible unless this runbook explicitly says otherwise.
- Run commands from the repository root. Do not put connection strings, passwords, emails, or user UUIDs in the repository or shell history.
- `001_orabella_schema.sql` is an already-applied baseline; do **not** edit or reapply it to an existing environment.
- `006` (database owner) and a possible `007` (caps) are integration dependencies. No migration files or final contracts for them exist in this repository at this revision; this runbook intentionally does not guess their contents.
- This repository does not define a source-to-target data-copy contract. The fresh backup is mandatory recovery evidence, but importing it into a new target must use a separately approved, compatibility-checked transfer procedure; do not treat the backup-verifier input as a production restore command.

## Interfaces and access

| Interface | Access required | Capability | Notes |
| --- | --- | --- | --- |
| Source Supabase database | approved operator connection | read-only backup and verification | Keep source credentials separate from target credentials. |
| Staging PostgreSQL | target owner / migration connection and app secret management | preparation, migration, smoke | Must be isolated from production. |
| Production PostgreSQL | approved operator connection | production migration only after the approval gate | No command in this document authorizes a production change by itself. |
| Application deployment | approved staging/production configuration access | set `DB_ENGINE` and `DATABASE_URL` | `DATABASE_URL` is server-only. |

Use environment placeholders in the current shell only:

```bash
export SOURCE_DB_URL='<supabase-source-connection-url>'
export STAGING_DB_URL='<staging-postgres-migration-connection-url>'
export PROD_DB_URL='<production-postgres-migration-connection-url>'
export STAGING_APP_URL='https://<staging-app-host>'
export PROD_APP_URL='https://<production-app-host>'
export BACKUP_DIR='<approved-backup-directory>'
```

For a plain PostgreSQL target, use a migration connection with the database privileges needed by the migration files. `bootstrap/app-role.sql` additionally requires a superuser because it grants `BYPASSRLS` to `orabella_app`. Never run that bootstrap in Supabase: it aborts when Supabase platform roles are present.

## Migration discovery and order

Discover the actual repository migration set before each staging or production window. This is read-only and must be attached to the release evidence:

```bash
find supabase/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort
```

The files sort lexically by their zero-padded numeric prefix. At this revision the discovered incremental order after `001` is:

```text
002_portable_platform.sql
003_payment_method_arqueo.sql
004_inventory_literal_search.sql
005_cop_whole_peso.sql
```

For an existing database based on `001`, apply every discovered migration after `001` in that exact order. If `006`, `007`, or a later migration has been integrated before the release window, include it in the discovered list only after its reviewed contract, dependencies, and rollback boundary are available. Do not substitute a guessed owner or caps procedure.

For a clean plain PostgreSQL target, the order is:

```text
supabase/bootstrap/platform-roles.sql
→ supabase/migrations/001_orabella_schema.sql
→ every discovered 002–latest migration in lexical order
→ supabase/bootstrap/app-role.sql
→ approved seed procedure
```

Run `supabase/bootstrap/app-role.sql` only after all currently discovered target tables exist, then again after any later migration adds public tables.

`002` replaces `current_sede_id()` without `auth.jwt()`. `003` adds payment-method arqueo guards and does not reconstruct pre-existing open shifts. `004` creates the service-role-only literal product-search RPC. `005` adds whole-peso write guards without rewriting historical cents and exposes `public.cop_legacy_cents_audit` to `service_role`.

## Phase 1 — preparation and backup (read-only except backup artifact creation)

### 1. Confirm local inputs

These checks are safe and do not connect to a database:

```bash
for file in \
  supabase/bootstrap/platform-roles.sql \
  supabase/bootstrap/app-role.sql \
  scripts/verify-backup-restore.ts; do
  test -f "$file" || { echo "missing: $file"; exit 1; }
done
find supabase/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort
npm run typecheck
npm run test:db
```

### 2. Capture a fresh source backup

**WRITE: creates files in `BACKUP_DIR`; source database commands below are read-only.** Use a new, approved directory for this migration window. The verifier requires the four named input files.

```bash
mkdir -p "$BACKUP_DIR"

# Read-only against the source database.
pg_dump "$SOURCE_DB_URL" \
  --data-only --schema=public --no-owner --no-privileges \
  --file "$BACKUP_DIR/prod-public-data.sql"

psql "$SOURCE_DB_URL" -X -v ON_ERROR_STOP=1 -A -t -c "
  SELECT string_agg(
    format('SELECT %L || ''|'' || count(*)::text FROM public.%I', tablename, tablename),
    ' UNION ALL ' ORDER BY tablename
  )
  FROM pg_tables
  WHERE schemaname = 'public';" \
  | psql "$SOURCE_DB_URL" -X -v ON_ERROR_STOP=1 -A -t \
  > "$BACKUP_DIR/prod-conteos.txt"

psql "$SOURCE_DB_URL" -X -v ON_ERROR_STOP=1 -A -t -c "
  SELECT line FROM (
    SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
    UNION ALL SELECT 'trigger|' || c.relname || '.' || t.tgname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL SELECT 'constraint|' || c.relname || '.' || k.conname || '|' || k.contype::text
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype <> 'n'
    UNION ALL SELECT 'index|' || tablename || '.' || indexname FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL SELECT 'policy|' || tablename || '.' || policyname FROM pg_policies WHERE schemaname = 'public'
  ) inventory ORDER BY line;" > "$BACKUP_DIR/prod-catalogo.txt"

psql "$SOURCE_DB_URL" -X -v ON_ERROR_STOP=1 -A -t -c 'SELECT version();' > "$BACKUP_DIR/prod-version.txt"
(
  cd "$BACKUP_DIR"
  sha256sum prod-public-data.sql prod-conteos.txt prod-catalogo.txt prod-version.txt > SHA256SUMS.txt
)
npm run verify:backup -- "$BACKUP_DIR"
```

`npm run verify:backup` is offline: it reads the backup directory, writes only `verificacion-restauracion-pglite.txt`, builds an in-process PGlite database, applies repository migrations in sorted order, and checks checksums, foreign keys, row counts, and catalog differences. Do not continue until it succeeds.

`prod-conteos.txt` contains exact row counts. If the verifier reports a mismatch, stop and investigate; do not ignore it.

### 3. Read-only preflight SQL

Run the following against source, then later against staging and production. It checks object markers instead of a CLI migration history because manual `psql` application is not recorded by Supabase CLI history.

```sql
SELECT
  to_regprocedure('public.current_sede_id()') IS NOT NULL AS migration_002,
  to_regprocedure('public.search_products_literal(text,integer,integer)') IS NOT NULL AS migration_004,
  to_regclass('public.cash_shift_method_balances') IS NOT NULL AS migration_003,
  to_regclass('public.cop_legacy_cents_audit') IS NOT NULL AS migration_005,
  EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND t.tgname = 'trg_cop_whole_peso'
  ) AS migration_005_trigger;

DO $$
DECLARE audit_row record;
BEGIN
  IF to_regclass('public.cop_legacy_cents_audit') IS NULL THEN
    RAISE NOTICE '005 is not present; cop_legacy_cents_audit is unavailable on this baseline. This is not a preflight failure.';
    RETURN;
  END IF;

  FOR audit_row IN EXECUTE
    'SELECT table_name, column_name, row_count FROM public.cop_legacy_cents_audit ORDER BY table_name, column_name'
  LOOP
    RAISE NOTICE '% | % | %', audit_row.table_name, audit_row.column_name, audit_row.row_count;
  END LOOP;
END;
$$;
```

A source baseline that lacks `005` does not fail this preflight; the audit is required only after `005` is applied on the destination. The audit is a preserved-history report, not a cleanup task: `005` deliberately does not backfill or alter legacy cents. A non-zero result is evidence to retain and assess; do not rewrite it during this migration.

## Phase 2 — staging migration and smoke

### 4. Provision the target database and application role

**WRITE: creates roles and schema objects on staging.** For a clean target, use the full order above. For a target populated through the separately approved transfer procedure, do not apply a migration twice: verify its object markers and apply only the missing incremental migrations in the verified order.

Before provisioning the database owner, stop at this integration dependency:

```text
PENDING 006 — database-specific owner provisioning
Owner: <integration owner>
Inputs: <approved target database ownership / authentication contract>
Action: execute the approved, database-specific provisioning procedure.
Do not substitute an email address, UUID, or role name from this runbook.
```

The existing application-role bootstrap remains separate from that pending owner work:

```bash
# Plain PostgreSQL only; run as a superuser after 002–005.
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/app-role.sql
```

### 5. Apply staged migrations

**WRITE: changes staging schema, triggers, functions, ACLs, and data backfills.** Do not wrap these files in an outer transaction: each migration manages its own transaction. Review the discovered list first; apply only migrations after the already-applied baseline and never run a migration twice.

```bash
find supabase/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort

# Set this only after comparing the discovered list with destination markers.
# It is the ordered, reviewed 002–latest subset not already applied; 001 is never included.
# Do not copy a static list: include an integrated 006/007 only when its contract is approved.
export MIGRATIONS_TO_APPLY='<reviewed migration filenames, in lexical order>'

for migration in $MIGRATIONS_TO_APPLY; do
  test -f "supabase/migrations/$migration" || { echo "unknown migration: $migration"; exit 1; }
  psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f "supabase/migrations/$migration"
done
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/app-role.sql
```

`003` makes outflows through arqueable methods fail on shifts opened before it until the shift is closed and reopened; it does not reconstruct opening balances. Plan that operational boundary before staging and production.

### 6. Staging verification and smoke

The following SQL is read-only and verifies migration markers, ACLs, and the whole-peso audit:

```sql
SELECT
  r.rolname,
  r.rolcanlogin,
  r.rolbypassrls,
  pg_has_role('orabella_app', 'service_role', 'member') AS inherits_service_role
FROM pg_roles r
WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'orabella_app')
ORDER BY r.rolname;

SELECT
  has_schema_privilege('orabella_app', 'public', 'USAGE') AS app_schema_usage,
  has_table_privilege('orabella_app', 'public.services', 'SELECT,INSERT,UPDATE,DELETE') AS app_services_dml,
  has_table_privilege('orabella_app', 'public.cop_legacy_cents_audit', 'SELECT') AS app_cents_audit_select,
  has_function_privilege('service_role', 'public.search_products_literal(text,integer,integer)', 'EXECUTE') AS service_literal_search_execute,
  has_function_privilege('authenticated', 'public.search_products_literal(text,integer,integer)', 'EXECUTE') AS authenticated_literal_search_execute;

SELECT table_name, column_name, row_count
FROM public.cop_legacy_cents_audit
ORDER BY table_name, column_name;
```

Expected ACL result: `orabella_app` has the listed DML and audit-view read access after its bootstrap; `service_role` can execute `search_products_literal`; `authenticated` cannot. Investigate any different result before a deployment.

Configure the staging deployment secret values without exposing them:

```text
DB_ENGINE=postgres
DATABASE_URL=<staging-orabella_app-connection-url>
```

**WRITE: deployment configuration and release change.** Deploy the staging build using the approved deployment system, then run the safe HTTP smoke:

```bash
curl --fail --silent --show-error "$STAGING_APP_URL/api/v1/health"
```

Expected response is the health route's API envelope with `status: "ok"`. This endpoint does not prove database connectivity, so pair it with the SQL checks above and the existing test suite:

```bash
npm run typecheck
npm run test:db
npm run test:e2e:changed
```

Record the staging release identifier, migration output, audit output, SQL results, test output, and health response with the backup artifact. Do not use `supabase/seeds/smoke.sql` on production; it is explicitly test-only.

## Production approval gate

Proceed only when a human release owner explicitly approves all of the following:

- [ ] A fresh backup was captured and `npm run verify:backup -- "$BACKUP_DIR"` succeeded.
- [ ] The source-to-target transfer procedure, if needed, is separately approved and its target compatibility has been verified.
- [ ] Staging applied the reviewed `002`–latest discovered migration subset in order, and the target role bootstrap completed.
- [ ] Staging SQL confirms migration markers, role attributes, ACLs, and `cop_legacy_cents_audit` results.
- [ ] The staging build with `DB_ENGINE=postgres` passed the health smoke and listed tests.
- [ ] The `003` open-shift boundary is understood and an operational plan exists to close/reopen affected shifts.
- [ ] `006` owner is either included through its approved database-specific integration procedure or explicitly deferred for this deployment scope.
- [ ] Possible `007` caps is either included only after its final integration contract is approved or explicitly deferred for this deployment scope.
- [ ] The release owner has approved the production window and rollback authority.

**Stop here without explicit human approval.**

## Phase 3 — production cutover

### 7. Production backup and final read-only checks

Repeat the fresh backup procedure with `SOURCE_DB_URL` set to the production source and a new approved `BACKUP_DIR`. Run the preflight SQL against the production target before any write. Preserve its output beside the backup.

### 8. Production migration and role bootstrap

**IRREVERSIBLE WRITE BOUNDARY: changes production schema, triggers, functions, ACLs, and backfills.** After the human approval gate and documented review of the discovered migration list, run the same commands as staging with `PROD_DB_URL`:

```bash
find supabase/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort

# Set this only after comparing the discovered list with destination markers.
# It is the ordered, reviewed 002–latest subset not already applied; 001 is never included.
# Do not copy a static list: include an integrated 006/007 only when its contract is approved.
export MIGRATIONS_TO_APPLY='<reviewed migration filenames, in lexical order>'

for migration in $MIGRATIONS_TO_APPLY; do
  test -f "supabase/migrations/$migration" || { echo "unknown migration: $migration"; exit 1; }
  psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f "supabase/migrations/$migration"
done
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/app-role.sql
```

Then run the staging verification SQL against production. Capture output, especially `cop_legacy_cents_audit` and role/ACL results.

### 9. Capture configuration and switch the application engine

Before changing deployment configuration, capture a **redacted configuration manifest** from the approved deployment system. This is preparation: record variable names, whether each is set, the target environment, release identifier, and the configuration version; never record values.

```text
Required for Supabase mode: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
Current engine selector: DB_ENGINE
Direct PostgreSQL setting: DATABASE_URL
```

Store the manifest with the release evidence and confirm the three Supabase variables are recoverable before the cutover. This runbook does not prescribe a provider-specific export command.

**IRREVERSIBLE WRITE BOUNDARY: changes production deployment configuration.** Set only server-side deployment secrets:

```text
DB_ENGINE=postgres
DATABASE_URL=<production-orabella_app-connection-url>
```

Deploy the approved production build. Verify:

```bash
curl --fail --silent --show-error "$PROD_APP_URL/api/v1/health"
```

Repeat the read-only verification SQL against `PROD_DB_URL` and record the evidence. Keep Supabase secrets only while the deployed application still requires them; this runbook does not authorize removing unrelated variables.

### 10. Application-engine rollback to Supabase

This rollback changes deployment configuration; it does **not** revert applied database migrations. Use it only with the release owner's approval and the pre-cutover configuration manifest.

1. Restore the required Supabase environment variables from the approved secret store, without printing their values:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=<restored value>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<restored value>
   SUPABASE_SERVICE_ROLE_KEY=<restored value>
   DB_ENGINE=supabase
   ```

2. Remove `DATABASE_URL` from the deployment environment, or ensure the deployment system ignores it. In Supabase mode the application does not evaluate the direct PostgreSQL client or `DATABASE_URL`; removal avoids leaving an unused target credential active.
3. Redeploy the last approved Supabase-mode build/configuration.
4. Run the exact rollback smoke and validation before declaring rollback complete:

   ```bash
   curl --fail --silent --show-error "$PROD_APP_URL/api/v1/health"
   ```

   Then confirm in the approved deployment system that `DB_ENGINE=supabase`, the three named Supabase variables are set, and `DATABASE_URL` is removed or ignored. Run the normal approved application smoke suite for the restored release. The health endpoint alone does not prove database connectivity.
5. Record the rollback release identifier, redacted configuration manifest, health response, validation outcome, and the fact that database migrations remain applied.

## Rollback and stop conditions

- Migrations already applied are **not automatically reverted**. Do not rerun an older migration, edit an applied migration, or use ad-hoc `DROP` statements as a rollback.
- Restore a database only from the fresh, approved backup and only with the release owner's explicit restore approval. Supabase backup restoration can require resetting custom-role passwords because backup artifacts do not include them; use the target platform's approved restore procedure. Do not use the repository's backup verifier as a restore mechanism: it restores only into local PGlite for validation.
- If migration application fails, stop the release. Capture the error, current object state, and backup reference before deciding on recovery.
- If `003` exposes an open shift without method balances, close and reopen it through the approved operational flow; do not fabricate balance rows.
- If the application deployment must return to its prior connection mode, revert the deployment configuration only after confirming database compatibility. This does not undo database migrations.
- `005` rejects new non-whole-peso writes with `COP_WHOLE_PESO_REQUIRED`; its legacy audit does not authorize changing historic cents.

## Pending integration dependencies

| Dependency | Status | Required input | Action |
| --- | --- | --- | --- |
| `006` database owner | Pending | final database-specific ownership/authentication contract and owner | Integrate and apply only when in deployment scope; otherwise record explicit deferment. This runbook has no hardcoded identity. |
| possible `007` caps | Pending | final integration contract | Integrate and apply only when in deployment scope; otherwise record explicit deferment. Do not infer schema, checks, values, or rollback behavior. |

## Evidence to retain

- backup directory and checksum verification output;
- migration command output in verified order;
- staging and production marker, ACL, and `cop_legacy_cents_audit` SQL output;
- test and health-smoke output;
- human approval record, release identifiers, and any restore authorization.
