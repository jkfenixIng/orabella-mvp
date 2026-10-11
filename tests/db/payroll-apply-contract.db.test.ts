/**
 * Contract of `calculatePayroll` -> `payroll_apply_atomic`, captured at the
 * Supabase RPC boundary on a real PGlite schema. The expected payload is a
 * hand-computed oracle of the pre-extraction arithmetic (f34599c): the carry
 * extraction (`carries.ts`) must send the same `p_items`, `p_voucher_ids` and
 * `p_carry_ids`, and the RPC stays the only writer of carries.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertPeriod, insertUser } from "./fixtures";

const engine = vi.hoisted(() => ({
  pg: null as unknown as Db,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/src/shared/lib/supabase/server", async () => {
  const { postgrestDouble } = await import("./postgrest-double");
  return {
    createAdminClient: () =>
      postgrestDouble(engine.pg, undefined, (fn, args) => {
        engine.rpcCalls.push({ fn, args: structuredClone(args) });
      }),
  };
});

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  vi.stubEnv("DB_ENGINE", "");
  vi.stubEnv("DATABASE_URL", "");
  engine.rpcCalls = [];
  engine.pg = await freshDb();
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

const db = () => engine.pg;
const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

async function voucher(employee: string, amount: number, status: string): Promise<string> {
  return (
    await one<{ id: string }>(
      db(),
      `INSERT INTO public.voucher_requests (employee_id, amount, status, request_date) VALUES ($1, $2, $3, '2026-09-05') RETURNING id`,
      [employee, amount, status],
    )
  ).id;
}

async function carry(employee: string, amount: number, origin: string, applied: string | null = null): Promise<string> {
  return (
    await one<{ id: string }>(
      db(),
      `INSERT INTO public.payroll_discount_carries (employee_id, amount, origin_period_id, applied_period_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [employee, amount, origin, applied],
    )
  ).id;
}

describe("calculatePayroll -> payroll_apply_atomic contract", () => {
  it("sends the complete pre-extraction payload with voucher excess, carry remainder and multiple carries", async () => {
    const user = await insertUser(db());
    const ana = await insertEmployee(db());
    const beto = await insertEmployee(db());
    await db().query(`UPDATE public.employees SET full_name = 'A Ana' WHERE id = $1`, [ana]);
    await db().query(`UPDATE public.employees SET full_name = 'B Beto' WHERE id = $1`, [beto]);

    const earlier = await insertPeriod(db(), { start: "2026-08-01", end: "2026-08-15", status: "cerrado" });
    const period = await insertPeriod(db(), { start: "2026-09-01", end: "2026-09-15" });
    const later = await insertPeriod(db(), { start: "2026-10-01", end: "2026-10-15" });

    // Ana: vouchers above her gross -> voucher_excess; three earlier debts
    // (two pending, one already applied here) -> nothing absorbed, all remains.
    const anaVoucher = await voucher(ana, 600_000, "aprobada");
    const anaCarryA = await carry(ana, 20_000, earlier);
    const anaCarryB = await carry(ana, 30_000, earlier);
    await carry(ana, 7_000, earlier, period);
    await carry(ana, 999, later); // later origin: neither summed nor consumed
    // Beto: manual discount with reason plus a fully absorbed earlier debt.
    const betoVoucher = await voucher(beto, 1_000, "pendiente");
    const betoCarry = await carry(beto, 5_000, earlier);

    const { calculatePayroll } = await import("@/src/features/payroll/service");
    await calculatePayroll(
      period,
      { adjustments: [{ employee_id: beto, other_discounts: 10_000, adjustment_reason: "Préstamo" }] },
      { userId: user },
    );

    const applies = engine.rpcCalls.filter((call) => call.fn === "payroll_apply_atomic");
    expect(applies).toHaveLength(1);
    const { args } = applies[0];
    expect(Object.keys(args).sort()).toEqual(["p_carry_ids", "p_items", "p_period_id", "p_voucher_ids"]);
    expect(args.p_period_id).toBe(period);
    expect(args.p_voucher_ids).toEqual([anaVoucher, betoVoucher].sort(byId));
    expect(args.p_carry_ids).toEqual([anaCarryA, anaCarryB, betoCarry].sort(byId));
    expect(args.p_items).toEqual([
      {
        period_id: period,
        employee_id: ana,
        base_fixed: 500_000,
        commissions: 0,
        bonuses: 0,
        adjustment_reason: null,
        deductions_vales: 500_000,
        other_discounts: 0,
        net_pay: 0,
        detail_json: [],
        voucher_total: 600_000,
        voucher_excess: 100_000,
        debt_remainder: 57_000,
      },
      {
        period_id: period,
        employee_id: beto,
        base_fixed: 500_000,
        commissions: 0,
        bonuses: 0,
        adjustment_reason: "Préstamo",
        deductions_vales: 1_000,
        other_discounts: 15_000,
        net_pay: 484_000,
        detail_json: [],
        voucher_total: 1_000,
        voucher_excess: 0,
        debt_remainder: 0,
      },
    ]);

    // The RPC, not TypeScript, persisted and consumed the debts.
    const carries = await db().query<{ employee_id: string; amount: string; origin_kind: string; applied: boolean }>(
      `SELECT employee_id, amount::text, origin_kind, applied_period_id IS NOT NULL AS applied
         FROM public.payroll_discount_carries WHERE origin_period_id = $1 ORDER BY origin_kind`,
      [period],
    );
    expect(carries.rows).toEqual([
      { employee_id: ana, amount: "57000.00", origin_kind: "carry_remainder", applied: false },
      { employee_id: ana, amount: "100000.00", origin_kind: "voucher_excess", applied: false },
    ]);
    const consumed = await db().query<{ id: string }>(
      `SELECT id FROM public.payroll_discount_carries WHERE applied_period_id = $1 AND origin_period_id = $2 ORDER BY id`,
      [period, earlier],
    );
    expect(consumed.rows.map((row) => row.id)).toEqual(expect.arrayContaining([anaCarryA, anaCarryB, betoCarry]));

    // A replay of the same calculation sends no new consumption and no duplicate debt.
    engine.rpcCalls = [];
    await calculatePayroll(
      period,
      { adjustments: [{ employee_id: beto, other_discounts: 10_000, adjustment_reason: "Préstamo" }] },
      { userId: user },
    );
    const replay = engine.rpcCalls.find((call) => call.fn === "payroll_apply_atomic");
    expect(replay?.args.p_carry_ids).toEqual([]);
    expect(replay?.args.p_voucher_ids).toEqual([]);
    expect(replay?.args.p_items).toEqual(args.p_items);
    expect((await db().query(`SELECT 1 FROM public.payroll_discount_carries WHERE origin_period_id = $1`, [period])).rows).toHaveLength(2);
  });
});
