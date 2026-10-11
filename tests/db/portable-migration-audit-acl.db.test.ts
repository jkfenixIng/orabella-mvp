import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, REPO_ROOT, applyFile, closeDb, freshDb, one, warmTemplate, type Db } from "./harness";

const AUDIT_PATH = join(REPO_ROOT, "supabase", "bootstrap", "portable-migration-audit.sql");
const APP_ROLE_PATH = join(REPO_ROOT, "supabase", "bootstrap", "app-role.sql");
let db: Db;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

describe("portable migration audit ACL", () => {
  beforeEach(async () => {
    db = await freshDb();
    await applyFile(db, AUDIT_PATH);
    await applyFile(db, APP_ROLE_PATH);
  }, DB_HOOK_TIMEOUT);

  it("allows ledger insertion only through migration_operator", async () => {
    expect(
      await one(
        db,
        `SELECT
           pg_has_role('orabella_app', 'migration_operator', 'MEMBER') AS app_member,
           pg_has_role('service_role', 'migration_operator', 'MEMBER') AS service_member,
           has_table_privilege('orabella_app', 'public.portable_migration_audit', 'INSERT') AS app_insert,
           has_table_privilege('service_role', 'public.portable_migration_audit', 'INSERT') AS service_insert,
           has_table_privilege('service_role', 'public.portable_migration_audit', 'SELECT') AS service_select,
           has_table_privilege('migration_operator', 'public.portable_migration_audit', 'INSERT') AS operator_insert`,
      ),
    ).toEqual({
      app_member: false,
      service_member: false,
      app_insert: false,
      service_insert: false,
      service_select: true,
      operator_insert: true,
    });
  });
});
