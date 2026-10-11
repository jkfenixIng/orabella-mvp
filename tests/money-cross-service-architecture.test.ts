import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function exportedFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`export (?:async )?function ${name}\\b`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.slice(start + 1).search(/\nexport /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/**
 * Runtime tests in tests/db/{commissions,payroll}.service.db.test.ts make
 * createAdminClient throw on postgres. This guard pins the boundary at the
 * cross-service entry points those money flows call.
 */
describe("money services cross-service boundary", () => {
  it("money services have no direct Supabase client", () => {
    for (const service of ["commissions", "payroll", "cash", "billing"]) {
      expect(code(`src/features/${service}/service.ts`)).not.toMatch(/createAdminClient|supabase\/server|\.from\(|\.rpc\(/);
    }
  });

  it("admin service has no direct Supabase client", () => {
    expect(code("src/features/admin/service.ts")).not.toMatch(/createAdminClient|supabase\/server|\.from\(|\.rpc\(/);
  });

  it("admin collaborators used by money modules go through the catalogs port", () => {
    const admin = code("src/features/admin/service.ts");
    expect(exportedFunction(admin, "listAllEmployees")).toContain("catalogsRepo()");
    expect(exportedFunction(admin, "getEmployee")).toContain("catalogsRepo()");
    expect(admin).toMatch(/async function fetchPaymentMethods[\s\S]*?catalogsRepo\(\)/);
    for (const name of ["listAllEmployees", "getEmployee"]) {
      expect(exportedFunction(admin, name)).not.toMatch(/adminDb\(\)|\.from\(/);
    }
  });

  it("cash collaborators used by money modules go through the cash port", () => {
    const cash = code("src/features/cash/service.ts");
    for (const name of ["getOpenShift", "getOpenShiftWithOpener", "assertCashMethodOutflow"]) {
      expect(exportedFunction(cash, name)).toContain("cashDb()");
    }
  });
});
