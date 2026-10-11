import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const auditBootstrap = readFileSync(join(process.cwd(), "supabase", "bootstrap", "portable-migration-audit.sql"), "utf8");
const appRoleBootstrap = readFileSync(join(process.cwd(), "supabase", "bootstrap", "app-role.sql"), "utf8");

describe("portable migration audit bootstrap", () => {
  it("grants operator membership only to an explicit <MIGRATION_LOGIN>, never implicitly", () => {
    expect(auditBootstrap).toMatch(/CREATE ROLE migration_operator NOLOGIN NOINHERIT/);
    expect(auditBootstrap).toMatch(/GRANT migration_operator TO <MIGRATION_LOGIN>/);
    expect(auditBootstrap).not.toMatch(/current_user/);
  });

  it("keeps application identities out of the ledger and the operator role", () => {
    expect(auditBootstrap).toMatch(/REVOKE ALL ON public\.portable_migration_audit FROM service_role/);
    expect(auditBootstrap).toMatch(/GRANT SELECT ON public\.portable_migration_audit TO service_role/);
    expect(auditBootstrap).toMatch(/'orabella_app', 'service_role', 'anon', 'authenticated'/);
    expect(appRoleBootstrap).toMatch(/tablename <> 'portable_migration_audit'/);
  });
});
