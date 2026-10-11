import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITY_SQL } from "../../scripts/portable-migration-db.mjs";
import { DB_HOOK_TIMEOUT, REPO_ROOT, applyFile, closeDb, freshDb, one, pgError, warmTemplate, type Db } from "./harness";

const AUDIT_PATH = join(REPO_ROOT, "supabase", "bootstrap", "portable-migration-audit.sql");
const APP_ROLE_PATH = join(REPO_ROOT, "supabase", "bootstrap", "app-role.sql");
const MIGRATION_LOGIN = "migration_runner_test";
let db: Db;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

describe("portable migration audit ACL", () => {
  beforeEach(async () => {
    db = await freshDb();
    await applyFile(db, APP_ROLE_PATH);
    await applyFile(db, AUDIT_PATH);
    // The documented explicit grant to <MIGRATION_LOGIN>.
    await db.exec(`CREATE ROLE ${MIGRATION_LOGIN} LOGIN NOINHERIT; GRANT migration_operator TO ${MIGRATION_LOGIN};`);
  }, DB_HOOK_TIMEOUT);

  it("keeps migration_operator NOLOGIN NOINHERIT and out of application roles", async () => {
    expect(
      await one(
        db,
        `SELECT r.rolcanlogin, r.rolinherit,
                pg_has_role('orabella_app', 'migration_operator', 'MEMBER') AS app_member,
                pg_has_role('service_role', 'migration_operator', 'MEMBER') AS service_member,
                pg_has_role('${MIGRATION_LOGIN}', 'migration_operator', 'MEMBER') AS runner_member
           FROM pg_roles r WHERE r.rolname = 'migration_operator'`,
      ),
    ).toEqual({ rolcanlogin: false, rolinherit: false, app_member: false, service_member: false, runner_member: true });
  });

  it("allows ledger insertion only through migration_operator", async () => {
    expect(
      await one(
        db,
        `SELECT
           has_table_privilege('orabella_app', 'public.portable_migration_audit', 'INSERT') AS app_insert,
           has_table_privilege('service_role', 'public.portable_migration_audit', 'INSERT') AS service_insert,
           has_table_privilege('service_role', 'public.portable_migration_audit', 'SELECT') AS service_select,
           has_table_privilege('migration_operator', 'public.portable_migration_audit', 'INSERT') AS operator_insert,
           has_table_privilege('migration_operator', 'public.portable_migration_audit', 'UPDATE') AS operator_update`,
      ),
    ).toEqual({ app_insert: false, service_insert: false, service_select: true, operator_insert: true, operator_update: false });
  });

  it("lets the runner login SET ROLE and insert, while orabella_app cannot insert", async () => {
    await db.exec(`BEGIN; SET LOCAL ROLE ${MIGRATION_LOGIN}; SET ROLE migration_operator;
      INSERT INTO public.portable_migration_audit (filename, sha256) VALUES ('002_portable_platform.sql', '${"a".repeat(64)}');
      ROLLBACK;`);
    await db.exec("BEGIN; SET LOCAL ROLE orabella_app;");
    const denied = await pgError(
      db.exec(`INSERT INTO public.portable_migration_audit (filename, sha256) VALUES ('002_portable_platform.sql', '${"b".repeat(64)}');`),
    );
    await db.exec("ROLLBACK;").catch(() => undefined);
    expect(denied.message).toMatch(/permission denied/);
  });

  it("reports the runner identity probe the apply script requires", async () => {
    await db.exec(`SET ROLE ${MIGRATION_LOGIN};`);
    const identity = JSON.parse((await one<{ jsonb_build_object: string }>(db, IDENTITY_SQL)).jsonb_build_object);
    await db.exec("RESET ROLE;");
    expect(identity).toMatchObject({ current_in_app_role: false, is_migration_operator: true });
    expect(identity.current_roles).toContain("migration_operator");
  });
});
