/**
 * Cash and billing SERVICES on both engines over the real schema (001-004).
 * With DB_ENGINE=postgres the Supabase client throws, so any direct access left
 * in a service fails the test; the default engine keeps the PostgREST path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertProduct, insertUser, registerId } from "./fixtures";

const engine = vi.hoisted(() => ({ pg: null as unknown as Db }));

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/src/shared/lib/supabase/server", async () => {
  const { postgrestDouble } = await import("./postgrest-double");
  return {
    createAdminClient: () => {
      if (process.env.DB_ENGINE === "postgres") throw new Error("Supabase used on the postgres engine");
      return postgrestDouble(engine.pg);
    },
  };
});
vi.mock("@/src/shared/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/src/shared/db/schema");
  return { getDb: () => drizzle({ client: engine.pg, schema }) };
});
// Catalogs are external collaborators: read the real seeded rows, engine-agnostic.
vi.mock("@/src/features/admin/service", () => ({
  listPaymentMethods: async () =>
    (await engine.pg.query(`SELECT id, code, name, is_active, arqueo_mode, fee_percent::float8 AS fee_percent FROM public.payment_methods`)).rows,
  listServices: async () => [],
  listTaxes: async () => [],
}));
vi.mock("@/src/shared/lib/audit", () => ({ AUDIT_ACTIONS: new Proxy({}, { get: (_, key) => String(key) }), writeAudit: async () => {} }));
vi.mock("@/src/features/alerts/service", () => ({ getShiftReviews: async () => new Map() }));

let user: string;
let employee: string;
let product: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  engine.pg = await freshDb();
  user = await insertUser(engine.pg);
  employee = await insertEmployee(engine.pg);
  product = await insertProduct(engine.pg, 10);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

const counts = (cash = 200000) => [
  { method_code: "efectivo", denomination: 10000, quantity: cash / 10000, amount: cash },
  ...["transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"].map((method_code) => ({ method_code, denomination: null, quantity: 1, amount: 0 })),
];
const actor = () => ({ userId: user, sedeId: "single", roles: ["admin" as const] });

function load() {
  return Promise.all([
    import("@/src/features/cash/service"),
    import("@/src/features/billing/service"),
  ]);
}

describe.each(["supabase", "postgres"] as const)("cash/billing services on %s", (name) => {
  beforeEach(() => {
    vi.stubEnv("DB_ENGINE", name === "postgres" ? "postgres" : "");
    vi.stubEnv("DATABASE_URL", name === "postgres" ? "postgres://unused.invalid/db" : "");
  });

  it("opens 003 balances, pays cash without invoice, creates invoice, closes/recounts, and reads day/history", async () => {
    const [cash, billing] = await load();
    const register = await registerId(engine.pg);
    const opened = await cash.openShift({ cash_register_id: register, counts: counts() }, actor());
    expect(opened.shift.status).toBe("abierto");
    expect((await cash.getShiftMethodBalances(opened.shift.id)).map((row) => row.method_code)).toContain("efectivo");

    const payment = await cash.registerPayment({ cash_shift_id: opened.shift.id, method_code: "efectivo", amount: 10000, idempotency_key: "dfdd28c9-8f5e-4ee7-81fd-38b48dbef69a" }, actor());
    expect(payment.invoice_id).toBeNull();

    const created = await billing.createInvoice({
      client_name: "Cliente",
      discount: 0,
      idempotency_key: "09ab0d0c-6676-4bbf-bcc5-cdfc745be81a",
      items: [{ item_type: "producto", product_id: product, employee_id: employee, qty: 1, unit_price: 10000, discount: 0, no_commission: false }],
      payments: [],
    }, actor());
    const collected = await cash.registerPayment({ cash_shift_id: opened.shift.id, invoice_id: created.invoice.id, method_code: "efectivo", amount: 10000, idempotency_key: "9a415c22-9e45-4d9f-88c2-0536ff43168a" }, actor());
    expect(collected.invoice_status).toBe("Pagada");

    const closed = await cash.closeShift(opened.shift.id, { counted_cash: 220000, counts: counts(220000), confirmed: true }, actor());
    expect(closed.shift.status).toBe("cerrado");
    const recounted = await cash.recountClosedShift(opened.shift.id, { counted_cash: 220000, counts: counts(220000), reason: "Verificación" }, actor());
    expect(recounted.recount.shift_id).toBe(opened.shift.id);
    expect((await cash.getDayView({ fecha: new Date().toISOString().slice(0, 10) })).shifts).toHaveLength(1);
    expect((await cash.getHistory({ desde: "2020-01-01", hasta: "2030-01-01", page: 1 })).total).toBe(1);
  });

  it("preserves billing list/count/detail, payroll lock, idempotency relookup and timestamps/numerics", async () => {
    const [cash, billing] = await load();
    const opened = await cash.openShift({ cash_register_id: await registerId(engine.pg), counts: counts() }, actor());
    const key = "eb9e8d1e-c0aa-4b3f-a5fd-cb1fe66fce60";
    const input = {
      client_name: "Cliente",
      discount: 0,
      idempotency_key: key,
      items: [{ item_type: "producto", product_id: product, employee_id: employee, qty: 1, unit_price: 10000, discount: 0, no_commission: false }],
      payments: [],
    };
    const first = await billing.createInvoice(input, actor());
    expect((await billing.createInvoice(input, actor())).invoice.id).toBe(first.invoice.id);
    expect(await billing.countInvoices()).toBe(1);
    expect((await billing.listInvoices())[0]?.id).toBe(first.invoice.id);
    expect((await billing.getInvoiceDetail(first.invoice.id)).invoice.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof first.invoice.total).toBe("number");

    const period = await one<{ id: string }>(engine.pg, `INSERT INTO public.payroll_periods (start_date, end_date, status, closed_at) VALUES ('2026-01-01', '2026-01-31', 'cerrado', now()) RETURNING id`);
    await engine.pg.query(`INSERT INTO public.payroll_items (period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json) VALUES ($1, $2, 0, 0, 0, 0, 0, 0, $3::jsonb)`, [period.id, employee, JSON.stringify([{ invoice_id: first.invoice.id }])]);
    await expect(billing.editInvoiceItems(first.invoice.id, { motivo: "Ajuste", items: input.items, payments: [] }, actor())).rejects.toMatchObject({ code: "PAYROLL_LOCKED" });
    expect((await billing.listInvoices({ employee_id: employee })).map((row) => row.id)).toEqual([first.invoice.id]);
    expect(await billing.countInvoices({ employee_id: employee })).toBe(1);

    const paid = await billing.splitPayment(first.invoice.id, { idempotency_key: "4f7f6c58-3df4-4e58-8a5a-c9d5a3c1b7e2", portions: [{ method_code: "efectivo", amount: 10000 }] }, actor());
    expect(paid.invoice.status).toBe("Pagada");
    expect(paid.invoice.cash_shift_id).toBe(opened.shift.id);
  });

  it("rejects an outflow on a legacy shift without frozen balances", async () => {
    const [cash] = await load();
    const legacy = await one<{ id: string }>(engine.pg, `INSERT INTO public.cash_shifts (cash_register_id, opened_by, opening_base, status) VALUES ($1, $2, 0, 'abierto') RETURNING id`, [await registerId(engine.pg), user]);
    await expect(cash.assertCashMethodOutflow({ shiftId: legacy.id, method: { code: "efectivo", arqueo_mode: "denominations" }, amount: 1 })).rejects.toMatchObject({ code: "CASH_METHOD_BALANCE_REQUIRED" });
  });
});
