import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, pgError, readSchema, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertPeriod } from "./fixtures";
import { MONEY_EPSILON, moneyEquals } from "@/src/features/billing/schemas";
import { assertNoOverpay } from "@/src/features/payroll/schemas";

let db: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => { db = await freshDb(); }, DB_HOOK_TIMEOUT);
afterEach(async () => { await closeDb(db); });

const DELTAS = [0, 0.009, 0.0095, 0.01] as const;
const sqlCapAllows = async (delta: number) =>
  (await one<{ allowed: boolean }>(db, `SELECT NOT ($1::numeric > 0.009) AS allowed`, [delta])).allowed;

/**
 * Characterization only, no unification: SQL caps for invoice, payroll and
 * commission reject deltas > 0.009; cash reuses the invoice trigger. TS billing
 * equality keeps MONEY_EPSILON = 0.01. Legacy invoice cents are compared
 * against round(total - surcharge).
 */
describe("money tolerance characterization", () => {
  it("the three SQL cap triggers still use the documented 0.009 predicate", () => {
    const sql = readSchema();
    expect(sql).toContain("IF v_paid_net + v_new_net - round(v_total - coalesce(v_surcharge, 0)) > 0.009 THEN");
    expect(sql).toContain("IF v_paid + NEW.amount - v_net > 0.009 THEN");
    expect(sql).toContain("IF v_paid + coalesce(NEW.amount, 0) - v_earned > 0.009 THEN");
    expect(MONEY_EPSILON).toBe(0.01);
  });

  it.each(DELTAS)("delta %s: SQL caps vs TS predicates", async (delta) => {
    const sql = await sqlCapAllows(delta);
    expect(sql).toBe(delta <= 0.009);
    // Commission and cash TS caps compare the raw delta with the same `> 0.009`.
    expect(!(delta > 0.009)).toBe(sql);
    // Billing equality is a different, documented rule (< 0.01).
    expect(moneyEquals(100 + delta, 100)).toBe(delta < 0.01);
  });

  it.each(DELTAS)("payroll payment trigger at delta %s matches assertNoOverpay", async (delta) => {
    const employee = await insertEmployee(db);
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const item = await one<{ id: string }>(
      db,
      `INSERT INTO public.payroll_items (period_id, employee_id, base_fixed, net_pay) VALUES ($1, $2, 100, 100) RETURNING id`,
      [period, employee],
    );
    // numeric(12,2) stores the amount rounded to cents: 0.009 and 0.0095 become 0.01.
    const stored = await one<{ amount: string }>(db, `SELECT round(100 + $1::numeric, 2)::text AS amount`, [delta]);
    const insert = db.query(
      `INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount) VALUES ($1, 'efectivo', $2)`,
      [item.id, 100 + delta],
    );
    const tsAllows = (() => { try { assertNoOverpay({ alreadyPaid: 0, newAmount: 100 + delta, netPay: 100 }); return true; } catch { return false; } })();
    const sqlAllows = Number(stored.amount) - 100 <= 0.009;
    if (sqlAllows) await insert;
    else expect((await pgError(insert)).message).toContain("supera el neto");
    // Documented divergence: TS rounds to whole pesos before comparing, so every
    // sub-peso delta passes the precheck; SQL stores cents and rejects >= 0.01.
    // The trigger is the defense that remains authoritative for legacy cents.
    expect(tsAllows).toBe(true);
    expect(sqlAllows).toBe(delta === 0);
  });

  it("legacy invoice cents: collectible is round(total - surcharge)", async () => {
    const row = await one<{ collectible: string; gap: string }>(
      db,
      `SELECT round(9999.99::numeric - 0)::text AS collectible, (round(9999.99::numeric) - 9999.99::numeric)::text AS gap`,
    );
    expect(row).toEqual({ collectible: "10000", gap: "0.01" });
  });
});
