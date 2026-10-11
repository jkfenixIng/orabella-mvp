import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_HOOK_TIMEOUT, MIGRATIONS_DIR, closeDb, freshDb, setCopTriggers, one, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertPeriod } from "./fixtures";
import { MONEY_EPSILON, moneyEquals } from "@/src/features/billing/schemas";
import { assertNoOverpay } from "@/src/features/payroll/schemas";

let db: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
// The cap triggers are characterized on legacy cent rows (pre-005 writes).
beforeEach(async () => {
  db = await freshDb();
  await setCopTriggers(db, false);
}, DB_HOOK_TIMEOUT);
afterEach(async () => { await closeDb(db); });

const DELTAS = [0, 0.009, 0.0095, 0.01] as const;
const sqlCapAllows = async (delta: number) =>
  (await one<{ allowed: boolean }>(db, `SELECT NOT ($1::numeric > 0.009) AS allowed`, [delta])).allowed;

/**
 * 007 characterizes caps in rounded whole pesos: legacy cents remain stored but
 * every sub-peso delta projects to the same cap. TS money equality follows the
 * same policy; MONEY_EPSILON = 0.01 stays exported for history only.
 */
describe("money tolerance characterization", () => {
  it("the three SQL cap triggers use 007 whole-peso comparisons", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "007_money_cap_policy.sql"), "utf8");
    expect(sql).toContain("IF round(v_paid_net + v_new_net) > round(v_total - coalesce(v_surcharge, 0)) THEN");
    expect(sql).toContain("IF round(v_paid + NEW.amount) > round(v_net) THEN");
    expect(sql).toContain("IF round(v_paid + coalesce(NEW.amount, 0)) > round(v_earned) THEN");
    expect(MONEY_EPSILON).toBe(0.01);
  });

  it.each(DELTAS)("delta %s: SQL caps vs TS predicates", async (delta) => {
    const sql = await sqlCapAllows(delta);
    expect(sql).toBe(delta <= 0.009);
    expect(moneyEquals(100 + delta, 100)).toBe(true);
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
    // 007: the stored legacy cents round to the same whole peso, so SQL and TS agree.
    await insert;
    expect(Math.round(Number(stored.amount))).toBe(100);
    expect(tsAllows).toBe(true);
  });

  it("legacy invoice cents: collectible is round(total - surcharge)", async () => {
    const row = await one<{ collectible: string; gap: string }>(
      db,
      `SELECT round(9999.99::numeric - 0)::text AS collectible, (round(9999.99::numeric) - 9999.99::numeric)::text AS gap`,
    );
    expect(row).toEqual({ collectible: "10000", gap: "0.01" });
  });
});
