import { describe, expect, it } from "vitest";
import { isResetTokenUsable } from "@/src/features/auth/service";
import { violatesSuperadminGuard, roleIsAssignableForSede, rolesAreNonEmpty } from "@/src/features/admin/role-policy";
import { applyMovementStock, planStockDeduction } from "@/src/features/inventory/schemas";
import { settlePayrollCarries, planIncomingCarries } from "@/src/features/payroll/carries";
import { decidePayrollDeletionOverlap } from "@/src/features/payroll/schemas";

describe("Fase 4 application rules", () => {
  it("decides payroll deletion overlap with the SQL inclusive range/status rule", () => {
    const target = { start_date: "2026-09-01", end_date: "2026-09-15" };
    expect(decidePayrollDeletionOverlap({ target, periods: [] })).toEqual({ allowed: true, code: null });
    expect(decidePayrollDeletionOverlap({ target, periods: [{ ...target, status: "borrador", frequency: "mensual" }] })).toEqual({ allowed: true, code: null });
    expect(decidePayrollDeletionOverlap({ target, periods: [{ start_date: "2026-09-15", end_date: "2026-09-30", status: "cerrado", frequency: null }] })).toEqual({ allowed: false, code: "PERIOD_OVERLAP_AMBIGUOUS" });
    expect(decidePayrollDeletionOverlap({ target, periods: [{ start_date: "2026-08-01", end_date: "2026-08-31", status: "cerrado", frequency: "semanal" }] })).toEqual({ allowed: true, code: null });
  });

  it("treats reset tokens as usable only while active, strictly before expiration", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    expect(isResetTokenUsable({ used: false, expiresAt: new Date(+now + 1), now })).toBe(true);
    expect(isResetTokenUsable({ used: true, expiresAt: new Date(+now + 1), now })).toBe(false);
    expect(isResetTokenUsable({ used: false, expiresAt: now, now })).toBe(false);
    expect(isResetTokenUsable({ used: false, expiresAt: new Date(+now - 1), now })).toBe(false);
  });

  it("projects stock exactly like IN, OUT and ADJUST trigger arithmetic", () => {
    expect(applyMovementStock(4, "IN", 3)).toBe(7);
    expect(applyMovementStock(4, "OUT", 3)).toBe(1);
    expect(applyMovementStock(4, "ADJUST", 3)).toBe(3);
    expect(() => applyMovementStock(0, "OUT", 1)).toThrow("INSUFFICIENT_STOCK");
    expect(planStockDeduction([{ product_id: "a", qty: 2 }, { product_id: "a", qty: 1 }, { product_id: "b", qty: 1 }], new Map([["a", { name: "A", stock_qty: 3 }], ["b", { name: "B", stock_qty: 1 }]]))).toEqual([{ product_id: "a", qty: 3 }, { product_id: "b", qty: 1 }]);
  });

  it("keeps carry debt exact while the RPC remains the writer", () => {
    expect(settlePayrollCarries({ gross: 100, vales: 70, manualOtherDiscounts: 10, incomingDebt: 50 })).toMatchObject({ appliedVales: 70, appliedOtherDiscounts: 30, voucherExcess: 0, debtRemainder: 30 });
    const plan = planIncomingCarries({
      pending: [{ id: "p", employee_id: "e", amount: 20, origin_period_id: "old" }],
      appliedHere: [{ id: "a", employee_id: "e", amount: 5, origin_period_id: "old" }],
      originEndById: new Map([["old", "2026-08-31"]]), periodStart: "2026-09-01", payableEmployeeIds: new Set(["e"]),
    });
    expect(plan.debtByEmployee.get("e")).toBe(25);
    expect(plan.carriesToApply).toEqual(["p"]);
  });

  it("centralizes pure sede role policy without changing SQL role replacement", () => {
    expect(rolesAreNonEmpty(["admin"])).toBe(true);
    expect(roleIsAssignableForSede("admin")).toBe(true);
    expect(roleIsAssignableForSede("superadmin")).toBe(false);
    expect(violatesSuperadminGuard(["superadmin"])).toBe(true);
  });
});
