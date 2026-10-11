import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Fase 4 authority boundaries", () => {
  it("routes TS stock writers through the authoritative projections", () => {
    const inventory = source("src/features/inventory/service.ts");
    const billing = source("src/features/billing/service.ts");
    expect(inventory).toContain("applyMovementStock(product.stock_qty, input.type, input.qty)");
    expect(inventory).toContain("planStockDeduction(lines, stockByProduct)");
    expect(billing.match(/planStockDeduction\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(billing).not.toMatch(/registerMovement\(/);
  });

  it("admin role writers use the pure role policy before the SQL unit of work", () => {
    const admin = source("src/features/admin/service.ts");
    const setRoles = admin.slice(admin.indexOf("export async function setUserRoles"), admin.indexOf("// ------------------------------------------ listados"));
    expect(setRoles).toContain("rolesAreNonEmpty(parsed.data.roles)");
    expect(setRoles.match(/violatesSuperadminGuard\(/g)?.length).toBe(2);
    expect(setRoles.indexOf("violatesSuperadminGuard")).toBeLessThan(setRoles.indexOf("repo.replaceUserRoles"));
    expect(admin).toContain("DEFAULT_EMPLOYEE_ROLE);");
    expect(admin).not.toContain("isSedeAssignableRole(");
  });

  it("negative fixture: a stock writer that bypasses the projection is detected", () => {
    const bypass = `await db.insertMovement({ product_id, type: "OUT", qty });`;
    expect(bypass).toMatch(/insertMovement\(/);
    expect(bypass).not.toMatch(/applyMovementStock\(|planStockDeduction\(/);
  });

  it("keeps SQL RPCs and triggers as the physical atomic defenses", () => {
    const payroll = source("src/features/payroll/service.ts");
    const auth = source("src/features/auth/service.ts");
    const sql = source("supabase/migrations/001_orabella_schema.sql");
    expect(payroll).toContain("decidePayrollDeletionOverlap");
    expect(payroll).toContain("db.deleteAtomic(");
    expect(payroll).toContain("payroll_apply_atomic");
    expect(auth).toContain("isResetTokenUsable");
    expect(auth).toContain(".confirmPasswordReset({ tokenHash, passwordHash");
    expect(sql).toContain("CREATE TRIGGER trg_inventory_apply_stock");
    expect(sql).toContain("CREATE FUNCTION public.confirm_password_reset");
    expect(sql).toContain("CREATE FUNCTION public.payroll_delete_period_atomic");
  });
});
