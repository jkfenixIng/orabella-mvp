import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const code = (path: string) => source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("payroll repository architecture", () => {
  it("routes every payroll query through the engine-selected repository", () => {
    const service = code("src/features/payroll/service.ts");
    expect(service).not.toMatch(/\.from\(|\.rpc\(|supabase\/server|shared\/db\/client|drizzle-orm/);
    expect(service).toContain('await import("./repos/payroll")');
    expect(code("src/features/payroll/repos/payroll.ts")).toContain('getDbConfig().engine === "postgres"');
  });

  it("runs the three payroll units of work as typed SQL calls", () => {
    const drizzle = code("src/features/payroll/repos/payroll.drizzle.ts");
    for (const fn of ["payroll_apply_atomic", "payroll_delete_period_atomic", "payroll_correct_period_atomic"]) {
      expect(drizzle).toContain(`rpc(db, "${fn}"`);
    }
    expect(drizzle).toContain('cast: "uuid[]"');
    expect(drizzle).toContain('cast: "jsonb"');
    expect(drizzle).not.toMatch(/sql\.raw|\$\{.*\}::/);
  });

  it("uses the total order paid_at DESC, id ASC for extraordinary payments in both adapters", () => {
    expect(code("src/features/payroll/repos/payroll.ts")).toContain('.order("paid_at", { ascending: false }).order("id")');
    expect(code("src/features/payroll/repos/payroll.drizzle.ts")).toContain("desc(payrollExtras.paidAt), asc(payrollExtras.id)");
  });
});
