import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePaymentMethodCode, paymentMethodSchema } from "@/src/features/admin/schemas";
import { paymentMethodWriteError } from "@/src/features/admin/service";
import { CASH_METHOD_BALANCE_REQUIRED, cashMethodRuleError } from "@/src/features/cash/service";
import { methodAvailability } from "@/src/features/cash/schemas";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("payment methods: free, normalized and immutable code (003)", () => {
  it("normalizes before validating, so 'Billetera QR' becomes a valid stable code", () => {
    expect(normalizePaymentMethodCode("  Billetera QR ")).toBe("billetera-qr");
    expect(paymentMethodSchema.safeParse({ code: "  Billetera QR ", name: "QR" }).success).toBe(true);
    expect(paymentMethodSchema.safeParse({ code: "qr!", name: "QR" }).success).toBe(false);
    expect(paymentMethodSchema.safeParse({ name: "Sin código" }).success).toBe(false);
  });

  it("accepts the three arqueo modes and nothing else", () => {
    for (const mode of ["none", "denominations", "declared_total"]) {
      expect(paymentMethodSchema.safeParse({ code: "qr", name: "QR", arqueo_mode: mode }).success).toBe(true);
    }
    expect(paymentMethodSchema.safeParse({ code: "qr", name: "QR", arqueo_mode: "yes" }).success).toBe(false);
  });

  it("maps the stable database errors to business errors", () => {
    expect(paymentMethodWriteError({ code: "P0001", message: "PAYMENT_METHOD_CODE_IMMUTABLE" }).code)
      .toBe("PAYMENT_METHOD_CODE_IMMUTABLE");
    expect(paymentMethodWriteError({ code: "23505", message: "duplicate key payment_methods_code_key" }).code)
      .toBe("PAYMENT_METHOD_CODE_TAKEN");
    expect(paymentMethodWriteError({ code: "23505", message: "uq_payment_methods_single_denominations" }).message)
      .toContain("denominaciones");
    expect(paymentMethodWriteError({ code: "XX000", message: "boom" }).code).toBe("INTERNAL");
  });

  it("the form asks for a free code on creation, read-only on edit, and the arqueo mode", () => {
    const source = read("app/admin/admin-sections/methods-section.tsx");
    expect(source).not.toMatch(/<option value="efectivo">/);
    expect(source).toContain("readOnly={editingId !== null}");
    expect(source).toContain('value="denominations"');
    expect(source).toContain('value="declared_total"');
    // The code only travels on creation.
    expect(source).toContain("...(editingId ? { id: editingId } : { code: form.code })");
  });
});

describe("internal cash view: available and minimum per method (003)", () => {
  it("computes available above the minimum, never negative", () => {
    expect(methodAvailability({ method_code: "nequi", opening_base: 50000, expected: 70000 }))
      .toEqual({ method_code: "nequi", minimum: 25000, expected: 70000, available: 45000 });
    expect(methodAvailability({ method_code: "nequi", opening_base: 50000, expected: 10000 }).available).toBe(0);
  });

  it("is exposed only through an admin action and rendered only in the cash client", () => {
    const actions = read("src/features/cash/actions.ts");
    const body = actions.slice(actions.indexOf("export async function getShiftMethodBalancesAction"));
    expect(body).toContain("requireAdminSession");
    const client = read("app/cash/cash-client.tsx");
    expect(client).toContain("getShiftMethodBalancesAction");
    expect(client).toMatch(/props\.isAdmin && methodBalances/);
    for (const path of ["app/invoices/invoices-client.tsx", "app/vales/vouchers-client.tsx"]) {
      expect(read(path), path).not.toContain("getShiftMethodBalancesAction");
      expect(read(path), path).not.toMatch(/Disponible sobre el mínimo/);
    }
  });
});

describe("cash method rule: stable SQL errors become friendly messages (003)", () => {
  it("maps the trigger codes without exposing internal formulas", () => {
    const breach = cashMethodRuleError({ message: "CASH_METHOD_MINIMUM_BREACH" });
    expect(breach).toMatchObject({ code: "CASH_METHOD_MINIMUM_BREACH", status: 422 });
    expect(breach?.message).not.toMatch(/50%|opening|base de apertura|expected/i);
    const legacy = cashMethodRuleError({ message: CASH_METHOD_BALANCE_REQUIRED });
    expect(legacy).toMatchObject({ code: "CASH_METHOD_BALANCE_REQUIRED", status: 409 });
    expect(cashMethodRuleError({ message: "anything else" })).toBeNull();
  });

  it("commission and voucher services rely on the per-method rule, never on the cash code", () => {
    for (const path of ["src/features/commissions/service.ts", "src/features/payroll/service.ts"]) {
      const source = read(path);
      expect(source, path).toContain("assertCashMethodOutflow");
      expect(source, path).not.toContain("cashOutUsedInShift");
      expect(source, path).not.toMatch(/method(?:_code|\.code) === "efectivo"/);
    }
  });

  it("payroll payments and payroll extras never call the cash method rule", () => {
    const source = read("src/features/payroll/service.ts");
    const start = (name: string) => source.indexOf(`export async function ${name}(`);
    for (const name of ["payPayrollItem", "payPayrollExtra"]) {
      const from = start(name);
      expect(from, name).toBeGreaterThan(-1);
      const body = source.slice(from, source.indexOf("\nexport async function ", from + 1));
      expect(body, name).not.toContain("assertCashMethodOutflow");
    }
  });
});
