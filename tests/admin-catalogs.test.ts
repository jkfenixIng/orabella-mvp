/** Characterization of the plain admin catalog calls on the supabase-js path. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminError, getEmployee, listEmployees, listPaymentMethods, listTaxes, upsertPaymentMethod, upsertTaxConfig } from "@/src/features/admin/service";

const postgrest = vi.hoisted(() => ({ calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>, answers: [] as Array<{ data: unknown; error: unknown }> }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: () => {} }));
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> }; postgrest.calls.push(call);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "upsert", "insert", "update", "eq", "maybeSingle"]) query[method] = (...args: unknown[]) => { call.chain.push([method, args]); return method === "maybeSingle" ? Promise.resolve(postgrest.answers.shift()) : query; };
      query.single = () => { call.chain.push(["single", []]); return Promise.resolve(postgrest.answers.shift()); };
      query.then = (ok?: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise.resolve(postgrest.answers.shift()).then(ok, ko);
      return query;
    },
  }),
}));
const TAX = "id, code, name, percent, is_active";
const PAYMENT = "id, code, name, is_active, arqueable, arqueo_mode, fee_percent";
const EMPLOYEE = "id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, pay_frequency, salary_fixed, commission_percent, is_active";
const TAX_ID = "00000000-0000-4000-8000-000000000001";
const METHOD_ID = "00000000-0000-4000-8000-000000000002";
const tax = { id: TAX_ID, code: "IVA", name: "IVA", percent: 19, is_active: true };
const method = { id: METHOD_ID, code: "nequi", name: "Nequi", is_active: true, arqueable: false, arqueo_mode: "none", fee_percent: 0 };
const employee = { id: "e1", user_id: null, full_name: "Ana", employee_code: null, document: "1", phone: null, position: null, payout_mode: "nomina", email: null, birth_date: null, pay_type: "fijo", pay_frequency: null, salary_fixed: 100, commission_percent: null, is_active: true };
beforeEach(() => { postgrest.calls = []; postgrest.answers = []; });
const answer = (...values: Array<{ data: unknown; error: unknown }>) => { postgrest.answers = values; };

describe("admin catalog supabase-js characterization", () => {
  it("reads tax configs, payment methods and employees in historical order and bounded limit", async () => {
    answer({ data: [tax], error: null }, { data: [method], error: null }, { data: [employee], error: null });
    expect(await listTaxes(9)).toEqual([tax]); expect(await listPaymentMethods()).toEqual([method]); expect(await listEmployees(999)).toEqual([employee]);
    expect(postgrest.calls).toEqual([
      {
        table: "tax_configs",
        chain: [["select", [TAX]], ["order", ["code"]], ["order", ["id"]], ["limit", [9]]],
      },
      {
        table: "payment_methods",
        // `code` is UNIQUE (payment_methods_code_key): already a total order.
        chain: [["select", [PAYMENT]], ["order", ["code"]], ["limit", [50]]],
      },
      {
        table: "employees",
        chain: [["select", [EMPLOYEE]], ["order", ["full_name"]], ["order", ["id"]], ["limit", [500]]],
      },
    ]);
  });

  it("upserts a tax by id and keeps numeric percent", async () => {
    answer({ data: tax, error: null });
    expect(await upsertTaxConfig({ id: TAX_ID, code: "IVA", name: " IVA ", percent: "19", is_active: true })).toEqual(tax);
    expect(postgrest.calls[0]).toEqual({ table: "tax_configs", chain: [["upsert", [{ id: TAX_ID, code: "IVA", name: "IVA", percent: 19, is_active: true }, { onConflict: "id" }]], ["select", [TAX]], ["single", []]] });
  });

  it("reads current state with maybeSingle and ignores an external code on edit", async () => {
    answer({ data: { code: "nequi", is_active: true }, error: null }, { data: method, error: null });
    expect(await upsertPaymentMethod({ id: METHOD_ID, code: "changed", name: " Nequi ", arqueo_mode: "none", fee_percent: "0" })).toEqual(method);
    expect(postgrest.calls).toEqual([
      { table: "payment_methods", chain: [["select", ["code, is_active"]], ["eq", ["id", METHOD_ID]], ["maybeSingle", []]] },
      { table: "payment_methods", chain: [["update", [{ name: "Nequi", arqueo_mode: "none", fee_percent: 0 }]], ["eq", ["id", METHOD_ID]], ["select", [PAYMENT]], ["single", []]] },
    ]);
  });

  it("forces an inactive method to no arqueo, including an already inactive row", async () => {
    answer({ data: { code: "nequi", is_active: true }, error: null }, { data: method, error: null });
    await upsertPaymentMethod({ id: METHOD_ID, name: "Nequi", is_active: false, arqueo_mode: "declared_total" });
    expect(postgrest.calls[1].chain[0]).toEqual(["update", [{ name: "Nequi", is_active: false, arqueo_mode: "none" }]]);
    postgrest.calls = [];
    answer({ data: { code: "nequi", is_active: false }, error: null }, { data: method, error: null });
    await upsertPaymentMethod({ id: METHOD_ID, name: "Nequi", arqueo_mode: "denominations" });
    expect(postgrest.calls[1].chain[0]).toEqual(["update", [{ name: "Nequi", arqueo_mode: "none" }]]);
  });

  it("reads one employee with maybeSingle: null is NOT_FOUND 404, an error is INTERNAL 500", async () => {
    answer({ data: employee, error: null }, { data: null, error: null }, { data: null, error: { code: "57014", message: "x" } });
    expect(await getEmployee("e1")).toEqual(employee);
    expect(postgrest.calls[0]).toEqual({ table: "employees", chain: [["select", [EMPLOYEE]], ["eq", ["id", "e1"]], ["maybeSingle", []]] });
    for (const expected of [["NOT_FOUND", 404], ["INTERNAL", 500]]) {
      const error = await getEmployee("e2").catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AdminError);
      expect([(error as AdminError).code, (error as AdminError).status]).toEqual(expected);
    }
  });

  it("retries a raced generated code and maps a write without row to INTERNAL", async () => {
    const duplicate = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"payment_methods_code_key\"" } };
    answer({ data: [], error: null }, duplicate, { data: [{ ...method, code: "nequi" }], error: null }, { data: method, error: null });
    await upsertPaymentMethod({ name: "Nequi" });
    expect(postgrest.calls[1].chain[0]).toEqual(["insert", [{ code: "nequi", name: "Nequi", arqueo_mode: "none" }]]);
    expect(postgrest.calls[3].chain[0]).toEqual(["insert", [{ code: "nequi-2", name: "Nequi", arqueo_mode: "none" }]]);
    postgrest.calls = [];
    answer({ data: [], error: null }, { data: null, error: null });
    const empty = await upsertPaymentMethod({ name: "N" }).catch((reason: unknown) => reason);
    expect((empty as AdminError).code).toBe("INTERNAL");
  });

  it("creates a payment method with a generated code and ignores external code", async () => {
    answer({ data: [{ ...method, code: "efectivo" }, { ...method, code: "billetera-qr" }], error: null }, { data: method, error: null });
    await upsertPaymentMethod({ code: "efectivo", name: " Billetera QR ", is_active: false, arqueo_mode: "declared_total" });
    expect(postgrest.calls[1]).toEqual({ table: "payment_methods", chain: [["insert", [{ code: "billetera-qr-2", name: "Billetera QR", is_active: false, arqueo_mode: "none" }]], ["select", [PAYMENT]], ["single", []]] });
  });
});
