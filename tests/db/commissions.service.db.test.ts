/**
 * `payCommissionNow` through the SERVICE on both engines, over the real schema.
 * Cash, admin and audit stay external collaborators (mocked here); the money
 * barriers are the real 034 / 003 triggers and the 044 index, and each engine
 * must translate them to the same CommissionError.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, warmTemplate, type Db } from "./harness";
import { createInvoiceCall, insertEmployee, insertProduct, insertUser, openShift, registerId } from "./fixtures";

const engine = vi.hoisted(() => ({
  pg: null as unknown as Db,
  shift: "",
  /** Runs once, right before the payout INSERT reaches PostgreSQL. */
  beforeInsert: null as null | (() => Promise<void>),
  /** Runs inside the friendly cash pre-check (between the reads and the INSERT). */
  duringPrecheck: null as null | (() => Promise<void>),
}));

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
vi.mock("@/src/features/cash/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/cash/service")>();
  return {
    ...actual,
    getOpenShift: async () => ({ id: engine.shift }),
    // The friendly pre-check is skipped on purpose: the trigger must decide.
    assertCashMethodOutflow: async () => {
      await engine.duringPrecheck?.();
    },
  };
});
vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  return {
    ...actual,
    listPaymentMethods: async () => [
      { id: "m1", code: "efectivo", name: "Efectivo", is_active: true, arqueable: true, arqueo_mode: "denominations", fee_percent: 0 },
      { id: "m2", code: "nequi", name: "Nequi", is_active: true, arqueable: true, arqueo_mode: "declared_total", fee_percent: 0 },
    ],
  };
});
vi.mock("@/src/shared/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/shared/lib/audit")>()),
  writeAudit: async () => {},
}));

const KEY = "1e5b7c4a-8d29-4f36-a0b1-c7d3e9f2a5b8";
const OTHER = "c6f2a809-3b14-4e57-92d8-0a4b7c1e6f93";
let user: string;
let employee: string;
let invoice: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  engine.pg = await freshDb();
  engine.beforeInsert = null;
  engine.duringPrecheck = null;
  user = await insertUser(engine.pg);
  employee = await insertEmployee(engine.pg);
  const product = await insertProduct(engine.pg, 5);
  engine.shift = await openShift(engine.pg, await registerId(engine.pg), user);
  // Payout service scenarios isolate the 034 cap / idempotency from 003: nequi
  // has a frozen base large enough for 150.000. The dedicated efectivo case
  // below still proves 003 through the service.
  await engine.pg.query(`UPDATE public.cash_shift_method_balances SET opening_base = 1000000 WHERE cash_shift_id = $1 AND method_code = 'nequi'`, [engine.shift]);
  invoice = (await createInvoiceCall(engine.pg, { user, shift: engine.shift, employee, product: { id: product, qty: 1 }, paid: true })).id as string;
  // Fixed item commission: the immediate earned of the pair is 150.000.
  await engine.pg.query(`UPDATE public.invoice_items SET commission_value = 150000 WHERE invoice_id = $1`, [invoice]);
  const query = engine.pg.query.bind(engine.pg);
  vi.spyOn(engine.pg, "query").mockImplementation((async (...args: Parameters<Db["query"]>) => {
    if (engine.beforeInsert && /INSERT INTO\s+"?(public"?\.)?"?commission_payouts/i.test(String(args[0]))) {
      const hook = engine.beforeInsert;
      engine.beforeInsert = null;
      await hook();
    }
    return query(...args);
  }) as Db["query"]);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

const payouts = async () => (await one<{ n: number }>(engine.pg, `SELECT count(*)::int AS n FROM public.commission_payouts`)).n;
const direct = (amount: number, key: string) =>
  engine.pg.query(
    `INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, earned_immediate, amount, paid_by, idempotency_key)
     VALUES ($1, $2, $3, 'nequi', 10000, 150000, $4, $5, $6)`,
    [employee, invoice, engine.shift, amount, user, key],
  );

describe.each(["supabase", "postgres"] as const)("payCommissionNow on %s", (name) => {
  beforeEach(() => {
    vi.stubEnv("DB_ENGINE", name === "postgres" ? "postgres" : "");
    vi.stubEnv("DATABASE_URL", name === "postgres" ? "postgres://unused.invalid/db" : "");
  });
  const pay = async (amount: number, key = KEY, method_code = "nequi") => {
    const { payCommissionNow } = await import("@/src/features/commissions/service");
    return payCommissionNow({ invoice_id: invoice, employee_id: employee, amount, method_code, idempotency_key: key }, { userId: user });
  };
  const failure = async (run: Promise<unknown>) => run.then(() => { throw new Error("expected a CommissionError"); }, (error: unknown) => error);

  it("pays the exact pending (equality with the 034 cap) and a retry with the same key is a no-op", async () => {
    const first = await pay(150000);
    expect(first).toMatchObject({ amount: 150000, earned_immediate: 150000, method_code: "nequi", cash_shift_id: engine.shift });
    expect(await pay(150000)).toEqual(first);
    expect(await payouts()).toBe(1);
    const { immediatePaidTotal, listCommissionPayouts } = await import("@/src/features/commissions/service");
    expect(await immediatePaidTotal(invoice, employee)).toBe(150000);
    expect((await listCommissionPayouts({ invoice_id: invoice })).map((row) => row.id)).toEqual([first.id]);
  });

  it("23505 lost race: re-reads the winner with the same key and returns it", async () => {
    // Partial amount: the 003/034 BEFORE triggers accept the loser, so the 044
    // unique index is the barrier that speaks (23505).
    engine.beforeInsert = () => direct(50000, KEY).then(() => undefined);
    const result = await pay(50000);
    const winner = await one<{ id: string }>(engine.pg, `SELECT id FROM public.commission_payouts WHERE idempotency_key = $1`, [KEY]);
    expect(result).toMatchObject({ id: winner.id, amount: 50000 });
    expect(await payouts()).toBe(1);
  });

  it("same-key race that also exceeds the cap: the 034 trigger fires before the index (COMMISSION_OVERPAID)", async () => {
    engine.beforeInsert = () => direct(150000, KEY).then(() => undefined);
    expect(await failure(pay(150000))).toMatchObject({ code: "COMMISSION_OVERPAID", status: 422 });
    expect(await payouts()).toBe(1);
  });

  it("034 lost race: P0001 from the cap becomes COMMISSION_OVERPAID and writes nothing", async () => {
    engine.beforeInsert = () => direct(100000, OTHER).then(() => undefined);
    expect(await failure(pay(100000))).toMatchObject({ code: "COMMISSION_OVERPAID", status: 422, message: "El monto supera la comisión pendiente." });
    expect(await payouts()).toBe(1);
  });

  it("003 below 50% of the method base: the trigger answers CASH_METHOD_MINIMUM_BREACH", async () => {
    // efectivo: base 200.000 + 10.000 collected; floor 100.000; 150.000 breaches it.
    expect(await failure(pay(150000, KEY, "efectivo"))).toMatchObject({ code: "CASH_METHOD_MINIMUM_BREACH", status: 422 });
    expect(await payouts()).toBe(0);
    // Exactly the floor goes through.
    expect(await pay(110000, OTHER, "efectivo")).toMatchObject({ amount: 110000 });
  });

  it("re-reads the invoice right before the INSERT: annulled in flight is INVOICE_ANNULLED, nothing written", async () => {
    engine.duringPrecheck = async () => {
      await engine.pg.query(`UPDATE public.invoices SET status = 'Anulada', cancel_reason = 'prueba' WHERE id = $1`, [invoice]);
    };
    expect(await failure(pay(1000))).toMatchObject({ code: "INVOICE_ANNULLED", status: 422 });
    expect(await payouts()).toBe(0);
  });

  it("rule upsert keeps RULE_CONFLICT for a foreign id and NOT_FOUND for unknown items", async () => {
    const { upsertCommissionRule } = await import("@/src/features/commissions/service");
    const product = (await one<{ product_id: string }>(engine.pg, `SELECT product_id FROM public.invoice_items WHERE invoice_id = $1`, [invoice])).product_id;
    const other = await insertProduct(engine.pg);
    const created = await upsertCommissionRule({ item_type: "producto", item_id: product, employee_id: employee, percent: 10 });
    expect(await upsertCommissionRule({ item_type: "producto", item_id: product, employee_id: employee, percent: 20 })).toMatchObject({ id: created.id, percent: 20 });
    expect(await failure(upsertCommissionRule({ id: created.id, item_type: "producto", item_id: other, employee_id: employee, percent: 5 }))).toMatchObject({ code: "RULE_CONFLICT", status: 409 });
    expect(await failure(upsertCommissionRule({ item_type: "servicio", item_id: product, employee_id: employee, percent: 5 }))).toMatchObject({ code: "NOT_FOUND", message: "Ítem no encontrado." });
  });
});
