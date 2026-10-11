import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const auditBootstrap = readFileSync(join(process.cwd(), "supabase", "bootstrap", "portable-migration-audit.sql"), "utf8");
const appRoleBootstrap = readFileSync(join(process.cwd(), "supabase", "bootstrap", "app-role.sql"), "utf8");

describe("portable migration audit ACL", () => {
  it("reserves ledger writes for migration_operator", () => {
    expect(auditBootstrap).toMatch(/CREATE ROLE migration_operator NOLOGIN NOINHERIT/);
    expect(auditBootstrap).toMatch(/REVOKE ALL ON public\.portable_migration_audit FROM service_role/);
    expect(auditBootstrap).toMatch(/REVOKE ALL ON public\.portable_migration_audit FROM orabella_app/);
    expect(auditBootstrap).toMatch(/IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'orabella_app'\)/);
    expect(auditBootstrap).toMatch(/GRANT SELECT, INSERT ON public\.portable_migration_audit TO migration_operator/);
    expect(auditBootstrap).toMatch(/GRANT SELECT ON public\.portable_migration_audit TO service_role/);
    expect(auditBootstrap).not.toMatch(/GRANT (?:SELECT, )?INSERT ON public\.portable_migration_audit TO service_role/);
  });

  it("keeps orabella_app out of migration_operator and ledger table grants", () => {
    expect(auditBootstrap).toMatch(/REVOKE migration_operator FROM orabella_app/);
    expect(appRoleBootstrap).toMatch(/tablename <> 'portable_migration_audit'/);
  });
});
