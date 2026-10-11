import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copInputDigits } from "@/src/shared/money/cop";

/**
 * Regressions from the COP whole-peso review (NO APTO). Each block pins one
 * finding: legacy-cent hydration into digits-only money masks, strict cash
 * base parsing, and the 005 rejection translated to 400 on catalog writes.
 */

const repo = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from() {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "upsert", "eq", "neq", "update", "maybeSingle"]) {
        query[method] = () => query;
      }
      query.single = () => Promise.resolve({ data: null, error: repo.error });
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return query;
    },
  }),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: () => {} }));

/**
 * Repository doubles for the two writes whose catch blocks map database errors:
 * the reads succeed and the protected write rejects with `writeError`, shaped as
 * the adapters raise it (`DbQueryError` carrying the normalized error).
 */
const writes = vi.hoisted(() => ({ writeError: null as unknown }));

vi.mock("@/src/features/admin/repos/users", async () => {
  const { DbQueryError } = await import("@/src/shared/db/errors");
  const fail = () => Promise.reject(new DbQueryError(writes.writeError as { code: string | null; message: string; details: string | null }));
  return {
    adminUsersRepo: async () => ({
      findUserByDocument: async () => null,
      employeeForUser: async () => [],
      employeeCodeConflicts: async () => [],
      upsertEmployeeAtomic: fail,
      upsertEmployee: fail,
    }),
  };
});

vi.mock("@/src/features/commissions/repos/commissions", async () => {
  const { DbQueryError } = await import("@/src/shared/db/errors");
  return {
    commissionsRepo: async () => ({
      itemExists: async () => true,
      employeeExists: async () => true,
      upsertRule: () => Promise.reject(new DbQueryError(writes.writeError as { code: string | null; message: string; details: string | null })),
    }),
  };
});

const COP_DB_ERROR = { code: "P0001", message: "COP_WHOLE_PESO_REQUIRED", details: "employees.salary_fixed" };
const OTHER_DB_ERROR = { code: "23514", message: "check violation", details: null };

const COP_ERROR = { code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" };
const root = process.cwd();

// ---------------------------------------------------------- hydration ---

describe("legacy cents are rehydrated as whole pesos before a money mask", () => {
  it("10.50 → \"11\" and 12345.5 → \"12346\" (never the digits of the decimal text)", () => {
    expect(copInputDigits(10.5)).toBe("11");
    expect(copInputDigits("10.50")).toBe("11");
    expect(copInputDigits(12345.5)).toBe("12346");
    expect(copInputDigits(null)).toBe("");
    // The defect it replaces: String() + a digits-only mask multiplies by 100.
    expect(String(12345.5).replace(/\D/g, "")).toBe("123455");
  });
});

/**
 * Money mask surfaces: a `String(<money>)` that feeds `formatMoneyInput` (or a
 * draft later shown by it) must go through `copInputDigits`. The detector looks
 * for String() of a known money field name; quantities, minutes, days and
 * percentages are not money and stay out of the list.
 */
const MONEY_FIELDS = [
  "price", "sale_price", "cost_price", "unit_price", "commission_value", "salary_fixed",
  "bonuses", "other_discounts", "max_per_day", "max_per_week", "amount", "remaining",
  "remainingPrev", "splitRemaining",
];
const UI_FILES = [
  "app/invoices/invoices-client.tsx",
  "app/payroll/payroll-client.tsx",
  "app/admin/admin-sections/vales-section.tsx",
  "app/admin/admin-sections/employees-section.tsx",
  "app/admin/admin-sections/cash-section.tsx",
  "app/inventory/inventory-client.tsx",
  "app/services/services-client.tsx",
  "app/cash/cash-client.tsx",
  "app/vales/vouchers-client.tsx",
];

function moneyStringCasts(source: string): string[] {
  const field = MONEY_FIELDS.join("|");
  const pattern = new RegExp(String.raw`String\(\s*(?:[\w?.]+\.)?(${field})\b[^)]*\)|String\(\s*Math\.round\(\s*(${field})\b`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2]);
}

describe("architecture: no String(<money>) hydrates a money mask", () => {
  it("the UI money surfaces use copInputDigits", () => {
    const offenders = UI_FILES.flatMap((file) =>
      moneyStringCasts(readFileSync(join(root, file), "utf8")).map((fieldName) => `${file}:${fieldName}`),
    );
    expect(offenders).toEqual([]);
  });

  it("negative fixture: the detector catches each regressed shape", () => {
    const fixture = [
      "price: String(row.price),",
      "unit_price: String(found.sale_price)",
      "item.commission_value == null ? \"\" : String(item.commission_value)",
      "map[day] = String(amount);",
      "const value = String(Math.round(remaining * 100) / 100);",
      "qty: String(row.qty), min: String(row.duracion_min), pct: String(row.commission_percent)",
    ].join("\n");
    expect(moneyStringCasts(fixture)).toEqual(["price", "sale_price", "commission_value", "amount", "remaining"]);
  });
});

// ------------------------------------------------------- cash base ---

describe("updateRegisterBase parses the configured base strictly", () => {
  it("rejects exponent and hexadecimal text before touching the database", async () => {
    const { updateRegisterBase } = await import("@/src/features/cash/service");
    for (const raw of ["1e3", "0x10", "-5", "abc", ""]) {
      await expect(updateRegisterBase("00000000-0000-4000-8000-000000000001", raw, { userId: "u" }))
        .rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    }
  });

  it("the action no longer coerces with Number() (1e3 would become 1000)", () => {
    const action = readFileSync(join(root, "src/features/cash/actions.ts"), "utf8");
    const body = action.slice(action.indexOf("export async function updateRegisterBaseAction"));
    expect(body.slice(0, body.indexOf("\n}\n"))).not.toMatch(/Number\(base\)/);
    expect(body).toMatch(/copSchema\(/);
  });
});

// ------------------------------------------- 005 → 400 on catalogs ---

describe("COP_WHOLE_PESO_REQUIRED becomes a 400 on catalog writes", () => {
  it("upsertService maps the 005 rejection to VALIDATION 400", async () => {
    const { upsertService } = await import("@/src/features/admin/service");
    repo.error = COP_ERROR;
    await expect(upsertService({ name: "Corte", price: 10, duracion_min: 1, duracion_max: 1 }))
      .rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    repo.error = { code: "23514", message: "check" };
    await expect(upsertService({ name: "Corte", price: 10, duracion_min: 1, duracion_max: 1 }))
      .rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it.each([
    ["creation (upsert_employee_atomic)", {}],
    ["edition (upsertEmployee)", { id: "00000000-0000-4000-8000-0000000000e1" }],
  ])("upsertEmployee %s: COP P0001 is VALIDATION 400, any other error stays INTERNAL 500", async (_path, extra) => {
    const { upsertEmployee } = await import("@/src/features/admin/service");
    const employee = { full_name: "Bea", document: "200", pay_type: "fijo", salary_fixed: 1000, ...extra };
    writes.writeError = COP_DB_ERROR;
    await expect(upsertEmployee(employee, "sede")).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    writes.writeError = OTHER_DB_ERROR;
    await expect(upsertEmployee(employee, "sede")).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("upsertCommissionRule: COP P0001 is VALIDATION 400, any other error stays INTERNAL 500", async () => {
    const { upsertCommissionRule } = await import("@/src/features/commissions/service");
    const rule = {
      item_type: "producto",
      item_id: "00000000-0000-4000-8000-0000000000a1",
      employee_id: "00000000-0000-4000-8000-0000000000e1",
      amount: 1000,
    };
    writes.writeError = { ...COP_DB_ERROR, details: "commission_rules.amount" };
    await expect(upsertCommissionRule(rule)).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    writes.writeError = OTHER_DB_ERROR;
    await expect(upsertCommissionRule(rule)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("upsertProduct maps the 005 rejection to VALIDATION 400", async () => {
    const { upsertProduct } = await import("@/src/features/inventory/service");
    repo.error = COP_ERROR;
    await expect(upsertProduct({ sku: "X-1", name: "Shampoo", min_stock: 0, sale_price: 10 }))
      .rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });
});
