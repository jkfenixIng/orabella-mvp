/**
 * Commissions repository: equivalence supabase-js (PostgREST double) ↔ Drizzle
 * over the same real schema, plus the payout triggers that stay the money
 * authority on the direct engine (034 cap, 003 per-method minimum, 044 index).
 */
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleCommissionRepo } from "@/src/features/commissions/repos/commissions.drizzle";
import { supabaseCommissionRepo, type CommissionRepo, type PayoutWrite } from "@/src/features/commissions/repos/commissions";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, type Db, warmTemplate } from "./harness";
import { createInvoiceCall, insertEmployee, insertProduct, insertUser, openShift, registerId } from "./fixtures";
import { postgrestDouble } from "./postgrest-double";

const KEY = "1e5b7c4a-8d29-4f36-a0b1-c7d3e9f2a5b8";
const KEY_B = "c6f2a809-3b14-4e57-92d8-0a4b7c1e6f93";
const KEY_C = "3d7f0a52-9c14-4e68-b2f1-8a5c6e0d7b43";
const MISSING = "00000000-0000-4000-8000-0000000000ff";

interface Ctx { db: Db; repo: CommissionRepo; user: string; employee: string; product: string; shift: string; invoice: string; other: string }
let ctx: [Ctx, Ctx];

/** Same rows, same order, in each instance; generated ids differ per instance. */
async function seed(db: Db, repo: CommissionRepo): Promise<Ctx> {
  const user = await insertUser(db);
  const employee = await insertEmployee(db);
  await db.query(`UPDATE public.employees SET pay_type = 'mixto', commission_percent = 12.5, payout_mode = 'inmediato' WHERE id = $1`, [employee]);
  const product = await insertProduct(db, 10);
  const shift = await openShift(db, await registerId(db), user);
  const invoice = (await createInvoiceCall(db, { user, shift, employee, product: { id: product, qty: 2 }, paid: true })).id as string;
  const other = (await createInvoiceCall(db, { user, shift, employee })).id as string;
  await db.query(`UPDATE public.invoice_items SET commission_value = 150.5, commission_percent_override = 7.25 WHERE invoice_id = $1`, [invoice]);
  return { db, repo, user, employee, product, shift, invoice, other };
}

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  const [left, right] = await Promise.all([freshDb(), freshDb()]);
  ctx = await Promise.all([
    seed(left, supabaseCommissionRepo(postgrestDouble(left))),
    seed(right, drizzleCommissionRepo(drizzle({ client: right, schema }) as unknown as Database)),
  ]) as [Ctx, Ctx];
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await Promise.all(ctx.map((side) => closeDb(side.db)));
});

async function outcome(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    if (!(error instanceof DbQueryError)) throw error;
    return { code: error.error.code, message: error.error.message };
  }
}

/** Replaces each instance's own ids with symbolic names, and blanks the write instant. */
function stable(value: unknown, side: Ctx): unknown {
  const names = new Map(Object.entries(side).filter(([, v]) => typeof v === "string").map(([k, v]) => [v as string, `<${k}>`]));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const row = Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, child]) => [key, walk(child)]));
      if (typeof row.paid_at === "string") {
        expect(row.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}:\d{2}$/);
        row.paid_at = "<instant>";
      }
      return row;
    }
    if (typeof node === "string" && names.has(node)) return names.get(node);
    // The 034 message interpolates this instance's invoice and employee ids.
    if (typeof node === "string" && node.includes("(factura ")) {
      return node.replace(side.invoice, "<invoice>").replace(side.employee, "<employee>");
    }
    if (typeof node === "string" && /^[0-9a-f-]{36}$/.test(node) && !node.startsWith("00000000-") && ![KEY, KEY_B, KEY_C].includes(node)) return "<generated>";
    return node;
  };
  return walk(value);
}

async function same(run: (side: Ctx) => Promise<unknown>) {
  const expected = stable(await outcome(() => run(ctx[0])), ctx[0]);
  const actual = stable(await outcome(() => run(ctx[1])), ctx[1]);
  expect(actual).toEqual(expected);
  return actual as { value?: unknown; code?: string; message?: string };
}

const rule = (side: Ctx, extra: Record<string, unknown> = {}) => ({
  item_type: "producto" as const, item_id: side.product, employee_id: side.employee, percent: 10.5, amount: null, ...extra,
});
const payout = (side: Ctx, amount: number, key = KEY, extra: Partial<PayoutWrite> = {}): PayoutWrite => ({
  employee_id: side.employee, invoice_id: side.invoice, cash_shift_id: side.shift, method_code: "efectivo",
  base_subtotal: 20000, percent_applied: null, fixed_applied: 150.5, earned_immediate: 301, amount, paid_by: side.user,
  idempotency_key: key, ...extra,
});
const rows = (side: Ctx) => side.db.query<{ id: string; percent: string | null; amount: string | null; is_active: boolean }>(
  `SELECT id, percent::text, amount::text, is_active FROM public.commission_rules ORDER BY created_at, id`,
);

describe("commissions repository: equivalence supabase-js ↔ drizzle", () => {
  it("rules: filters, numeric as number and the created_at, id total order across ties", async () => {
    for (const side of ctx) {
      // Three rules with the SAME created_at: only the id breaks the tie.
      for (const [index, item] of [side.product, side.invoice, side.other].entries()) {
        await side.db.query(
          `INSERT INTO public.commission_rules (id, item_type, item_id, employee_id, percent, amount, is_active, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-09 14:32:18.5-05')`,
          [`00000000-0000-4000-8000-00000000c00${3 - index}`, index === 1 ? "servicio" : "producto", item, side.employee, index === 2 ? null : 12.75, index === 2 ? 1500.5 : null, index !== 1],
        );
      }
    }
    const all = (await same((side) => side.repo.listRules({}))) as { value: Array<{ id: string; percent: unknown; amount: unknown }> };
    expect(all.value.map((row) => row.id)).toEqual(["00000000-0000-4000-8000-00000000c001", "00000000-0000-4000-8000-00000000c002", "00000000-0000-4000-8000-00000000c003"]);
    expect(all.value[2].percent).toBe(12.75);
    expect(all.value[0].amount).toBe(1500.5);
    await same((side) => side.repo.listRules({ employee_id: side.employee }));
    await same((side) => side.repo.listRules({ item_type: "producto" }));
    await same((side) => side.repo.listRules({ item_type: "producto", item_id: side.product }));
    await same((side) => side.repo.listRules({ employee_id: MISSING }));
    const active = (await same((side) => side.repo.activeRules(side.employee))) as { value: unknown[] };
    expect(active.value).toHaveLength(2);
  });

  it("profiles and existence probes", async () => {
    expect((await same((side) => side.repo.employeeRate(side.employee))).value).toEqual({ pay_type: "mixto", commission_percent: 12.5 });
    expect((await same((side) => side.repo.employeePayoutMode(side.employee))).value).toBe("inmediato");
    expect((await same((side) => side.repo.employeePayoutMode(MISSING))).value).toBeNull();
    expect((await same((side) => side.repo.employeeRate(MISSING))).value).toBeNull();
    expect((await same((side) => side.repo.employeeExists(side.employee))).value).toBe(true);
    expect((await same((side) => side.repo.employeeExists(MISSING))).value).toBe(false);
    expect((await same((side) => side.repo.itemExists("products", side.product))).value).toBe(true);
    expect((await same((side) => side.repo.itemExists("services", side.product))).value).toBe(false);
  });

  it("earned inputs: invoice status and the employee's lines with numerics as numbers", async () => {
    expect((await same((side) => side.repo.invoiceStatus(side.invoice))).value).toEqual({ id: "<invoice>", status: "Pagada" });
    expect((await same((side) => side.repo.invoiceStatus(side.other))).value).toEqual({ id: "<other>", status: "Emitida" });
    expect((await same((side) => side.repo.invoiceStatus(MISSING))).value).toBeNull();
    const lines = (await same((side) => side.repo.invoiceLines(side.invoice, side.employee))) as { value: Array<Record<string, unknown>> };
    expect(lines.value).toEqual([{
      item_type: "producto", product_id: "<product>", service_id: null, qty: 2, unit_price: 10000, subtotal: 20000,
      no_commission: false, commission_value: 150.5, commission_percent_override: 7.25,
    }]);
    expect((await same((side) => side.repo.invoiceLines(side.invoice, MISSING))).value).toEqual([]);
  });

  it("rule upsert: measured PostgREST semantics — the 075 key arbitrates, `id` is written, a foreign id is 23505", async () => {
    const created = (await same((side) => side.repo.upsertRule(rule(side)))) as { value: { id: string } };
    expect(created.value).toMatchObject({ id: "<generated>", percent: 10.5, amount: null, is_active: true });
    const firstIds = await Promise.all(ctx.map(async (side) => (await rows(side)).rows[0].id));

    // Same key, no id: updates THAT row (no second row) and keeps is_active when absent.
    await same((side) => side.repo.upsertRule(rule(side, { percent: null, amount: 2500.25 })));
    for (const [index, side] of ctx.entries()) {
      expect((await rows(side)).rows).toEqual([{ id: firstIds[index], percent: null, amount: "2500.25", is_active: true }]);
    }
    await same((side) => side.repo.upsertRule(rule(side, { is_active: false })));

    // Same key WITH a new id: PostgREST merge-duplicates sets every sent key, so
    // the row's id is REWRITTEN (it is not an UPDATE ... WHERE id).
    const moved = (await same((side) => side.repo.upsertRule(rule(side, { id: "00000000-0000-4000-8000-00000000d001" })))) as { value: { id: string } };
    expect(moved.value.id).toBe("00000000-0000-4000-8000-00000000d001");
    for (const side of ctx) expect((await rows(side)).rows.map((row) => row.id)).toEqual(["00000000-0000-4000-8000-00000000d001"]);

    // Another pair carrying an existing id: the PK is outside the arbiter -> 23505.
    const clash = await same((side) => side.repo.upsertRule(rule(side, { item_id: side.invoice, id: "00000000-0000-4000-8000-00000000d001" })));
    expect(clash.code).toBe("23505");
    // CHECK (percent IS NOT NULL OR amount IS NOT NULL) still speaks: 23514.
    expect((await same((side) => side.repo.upsertRule(rule(side, { percent: null })))).code).toBe("23514");
    for (const side of ctx) expect((await rows(side)).rows).toHaveLength(1);
  });

  it("delete: returns the id once, then null", async () => {
    for (const side of ctx) await side.repo.upsertRule(rule(side, { id: "00000000-0000-4000-8000-00000000d002" }));
    expect((await same((side) => side.repo.deleteRule("00000000-0000-4000-8000-00000000d002"))).value).toEqual({ id: "00000000-0000-4000-8000-00000000d002" });
    expect((await same((side) => side.repo.deleteRule("00000000-0000-4000-8000-00000000d002"))).value).toBeNull();
  });

  it("payouts: insert row shape, immediate paid amounts, idempotency lookup and 23505 on the same key", async () => {
    const inserted = (await same((side) => side.repo.insertPayout(payout(side, 100.25)))) as { value: Record<string, unknown> };
    expect(inserted.value).toEqual({
      id: "<generated>", employee_id: "<employee>", invoice_id: "<invoice>", cash_shift_id: "<shift>", method_code: "efectivo",
      base_subtotal: 20000, percent_applied: null, fixed_applied: 150.5, earned_immediate: 301, amount: 100.25, paid_by: "<user>", paid_at: "<instant>",
    });
    await same((side) => side.repo.insertPayout(payout(side, 50, KEY_B)));
    expect((await same((side) => side.repo.paidAmounts(side.invoice, side.employee))).value).toEqual([100.25, 50]);
    expect((await same((side) => side.repo.paidAmounts(side.other, side.employee))).value).toEqual([]);
    expect((await same((side) => side.repo.findPayoutByKey(side.invoice, side.employee, KEY))).value).toMatchObject({ amount: 100.25 });
    expect((await same((side) => side.repo.findPayoutByKey(side.invoice, side.employee, KEY_C))).value).toBeNull();
    expect((await same((side) => side.repo.insertPayout(payout(side, 1, KEY)))).code).toBe("23505");
  });

  it("payout list: filters, limit and the paid_at DESC, id DESC total order across ties", async () => {
    for (const side of ctx) {
      for (const [index, key] of [KEY, KEY_B, KEY_C].entries()) await side.repo.insertPayout(payout(side, 10 + index, key));
      // Same instant for all three: only the id orders them.
      await side.db.query(`UPDATE public.commission_payouts SET paid_at = '2026-10-09 14:32:18.123456-05'`);
      for (const [index, key] of [KEY, KEY_B, KEY_C].entries()) {
        await side.db.query(`UPDATE public.commission_payouts SET id = $1 WHERE idempotency_key = $2`, [
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          key,
        ]);
      }
    }
    const all = (await same((side) => side.repo.listPayouts({}))) as { value: Array<{ id: string; paid_at: string }> };
    expect(all.value.map((row) => row.id)).toEqual(["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"]);
    const raw = await ctx[1].repo.listPayouts({});
    expect(raw[0].paid_at).toMatch(/^2026-10-09T14:32:18\.123456-05:00$/);
    await same((side) => side.repo.listPayouts({ employee_id: side.employee }));
    await same((side) => side.repo.listPayouts({ invoice_id: side.invoice, shift_id: side.shift }));
    expect((await same((side) => side.repo.listPayouts({ shift_id: MISSING }))).value).toEqual([]);
  });
});

describe("payout triggers stay the authority on both engines", () => {
  /** Opens a shift whose efectivo base is 200.000 (floor 100.000). */
  const efectivo = (side: Ctx, amount: number, key: string) =>
    side.repo.insertPayout(payout(side, amount, key, { method_code: "efectivo", earned_immediate: 1_000_000 }));

  it("034: Σ + new = earned is accepted; one peso above is P0001 and writes nothing", async () => {
    await same((side) => side.repo.insertPayout(payout(side, 300, KEY)));
    await same((side) => side.repo.insertPayout(payout(side, 1, KEY_B)));
    const over = await same((side) => side.repo.insertPayout(payout(side, 0.01, KEY_C)));
    expect(over.code).toBe("P0001");
    expect(over.message).toContain("El pago supera la comisión ganada");
    // A row without earned_immediate is rejected by the same trigger.
    const missing = await same((side) => side.repo.insertPayout(payout(side, 1, KEY_C, { earned_immediate: null as unknown as number })));
    expect(missing.code).toBe("P0001");
    for (const side of ctx) {
      expect((await one<{ n: number }>(side.db, `SELECT count(*)::int AS n FROM public.commission_payouts`)).n).toBe(2);
    }
  });

  it("003: leaving exactly 50% of the method base is accepted; below it is CASH_METHOD_MINIMUM_BREACH", async () => {
    // The paid invoice collected 20.000 in efectivo: balance 220.000, floor 100.000.
    await same((side) => efectivo(side, 120000, KEY));
    const below = await same((side) => efectivo(side, 1, KEY_B));
    expect([below.code, below.message]).toEqual(["P0001", "CASH_METHOD_MINIMUM_BREACH"]);
  });

  it("003: an arqueable method without a frozen balance is CASH_METHOD_BALANCE_REQUIRED", async () => {
    for (const side of ctx) await side.db.query(`INSERT INTO public.payment_methods (code, name, arqueo_mode) VALUES ('qr-pay', 'QR', 'declared_total')`);
    const missing = await same((side) => side.repo.insertPayout(payout(side, 1, KEY, { method_code: "qr-pay" })));
    expect([missing.code, missing.message]).toEqual(["P0001", "CASH_METHOD_BALANCE_REQUIRED"]);
  });

  it("the 044 index answers 23505 before writing a second row with the same key", async () => {
    await same((side) => side.repo.insertPayout(payout(side, 10, KEY)));
    expect((await same((side) => side.repo.insertPayout(payout(side, 10, KEY)))).code).toBe("23505");
    // The same key on another pair is another operation.
    await same((side) => side.repo.insertPayout(payout(side, 10, KEY, { invoice_id: side.other, earned_immediate: 10 })));
  });
});
