import { describe, expect, it } from "vitest";
import { invoiceItemSchema, paymentPortionSchema } from "@/src/features/billing/schemas";
import { serviceSchema } from "@/src/features/admin/schemas";
import { productSchema } from "@/src/features/inventory/schemas";
import { employeeAdjustmentSchema, payrollPortionSchema } from "@/src/features/payroll/schemas";
import { commissionRuleSchema } from "@/src/features/commissions/schemas";
import { copInputDigits, parseCop } from "@/src/shared/money/cop";

const uuid = "00000000-0000-4000-8000-000000000001";

describe("COP whole-peso input policy", () => {
  it("rounds decimal money inputs and rejects decimal syntax that is not a literal", () => {
    expect(invoiceItemSchema.parse({ item_type: "custom", custom_name: "X", employee_id: uuid, qty: 1, unit_price: "10.5" }).unit_price).toBe(11);
    expect(paymentPortionSchema.parse({ method_code: "cash", amount: "10.49" }).amount).toBe(10);
    expect(paymentPortionSchema.safeParse({ method_code: "cash", amount: "0.4" }).success).toBe(false);
    expect(paymentPortionSchema.safeParse({ method_code: "cash", amount: "1e3" }).success).toBe(false);
    expect(paymentPortionSchema.safeParse({ method_code: "cash", amount: "0x10" }).success).toBe(false);
    expect(parseCop("Infinity")).toBeNull();
  });

  it("keeps percentage fields decimal while rounding all money schemas", () => {
    expect(serviceSchema.parse({ name: "Corte", price: "10.5", duracion_min: 1, duracion_max: 2 }).price).toBe(11);
    expect(productSchema.parse({ sku: "A", name: "A", cost_price: "10.5", sale_price: "10.49", commission_value: "0.4" })).toMatchObject({ cost_price: 11, sale_price: 10, commission_value: 0 });
    expect(employeeAdjustmentSchema.parse({ employee_id: uuid, bonuses: "10.5", other_discounts: "10.49" })).toMatchObject({ bonuses: 11, other_discounts: 10 });
    expect(payrollPortionSchema.parse({ method_code: "cash", amount: "10.5" }).amount).toBe(11);
    expect(commissionRuleSchema.parse({ item_type: "producto", item_id: uuid, employee_id: uuid, percent: "7.5", amount: "10.5" })).toMatchObject({ percent: 7.5, amount: 11 });
  });

  it("hydrates legacy cents as a rounded peso instead of stripping the decimal point", () => {
    expect(copInputDigits("12345.5")).toBe("12346");
    expect(copInputDigits(12345.49)).toBe("12345");
  });
});
