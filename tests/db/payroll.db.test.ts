import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertPeriod, insertUser, insertVoucher, payrollItem } from "./fixtures";

let db: Db;
let employee: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  employee = await insertEmployee(db);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const apply = (period: string, items: unknown[], vouchers: string[], carries: string[] = []) =>
  rpc<number>(
    db,
    "payroll_apply_atomic",
    [period, JSON.stringify(items), vouchers, carries],
    ["uuid", "jsonb", "uuid[]", "uuid[]"],
  );
const remove = (period: string, toApproved: string[], toPending: string[]) =>
  rpc<number>(db, "payroll_delete_period_atomic", [period, toApproved, toPending], ["uuid", "uuid[]", "uuid[]"]);
const voucherStatus = async (id: string): Promise<string> =>
  (await one<{ status: string }>(db, `SELECT status FROM public.voucher_requests WHERE id = $1`, [id])).status;

describe("payroll_apply_atomic", () => {
  it("applies items, flips vouchers and records the debt; recalculating does not duplicate the debt", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const voucher = await insertVoucher(db, employee, "aprobada");
    const item = payrollItem(period, employee, { voucherExcess: 20000, debtRemainder: 5000 });

    expect(await apply(period, [item], [voucher])).toBe(1);
    expect(await voucherStatus(voucher)).toBe("descontada");
    expect(await count(db, `SELECT 1 FROM public.payroll_discount_carries WHERE origin_period_id = $1`, [period])).toBe(2);

    // Recalculation (vouchersToDiscount is empty: the voucher is already
    // 'descontada'), now with a bonus: the upsert replaces the row, and the debt
    // rows are not duplicated (nor do their amounts change).
    const recalculated = { ...item, bonuses: 30000, net_pay: 480000, voucher_excess: 99999, debt_remainder: 99999 };
    expect(await apply(period, [recalculated], [])).toBe(1);
    const row = await one<{ n: number; net_pay: string; bonuses: string }>(
      db,
      `SELECT count(*) OVER ()::int AS n, net_pay::text, bonuses::text FROM public.payroll_items WHERE period_id = $1`,
      [period],
    );
    expect(row).toEqual({ n: 1, net_pay: "480000.00", bonuses: "30000.00" });
    const carries = await db.query<{ origin_kind: string; amount: string }>(
      `SELECT origin_kind, amount::text FROM public.payroll_discount_carries WHERE origin_period_id = $1 ORDER BY origin_kind`,
      [period],
    );
    expect(carries.rows).toEqual([
      { origin_kind: "carry_remainder", amount: "5000.00" },
      { origin_kind: "voucher_excess", amount: "20000.00" },
    ]);
  });

  it("an identical replay that resends the same voucher is rejected and rolls back (no silent double discount)", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const voucher = await insertVoucher(db, employee, "aprobada");
    const item = payrollItem(period, employee, { voucherExcess: 20000 });
    await apply(period, [item], [voucher]);
    const snapshot = () =>
      db.query(
        `SELECT 'item' AS kind, net_pay::text AS v FROM public.payroll_items WHERE period_id = $1
         UNION ALL SELECT 'carry', origin_kind || ':' || amount::text FROM public.payroll_discount_carries WHERE origin_period_id = $1
         UNION ALL SELECT 'voucher', status FROM public.voucher_requests WHERE id = $2
         ORDER BY 1, 2`,
        [period, voucher],
      );
    const before = (await snapshot()).rows;

    // The replay carries a different net pay: if anything survived the rollback it would show.
    const replay = await pgError(apply(period, [{ ...item, bonuses: 1000, net_pay: 451000 }], [voucher]));
    expect(replay.message).toBe("PAYROLL_VOUCHER_CONFLICT");
    expect((await snapshot()).rows).toEqual(before);
    expect(before).toEqual([
      { kind: "carry", v: "voucher_excess:20000.00" },
      { kind: "item", v: "450000.00" },
      { kind: "voucher", v: "descontada" },
    ]);
  });

  it("marks an incoming debt consumed once; replaying the carry ids is a silent no-op", async () => {
    const origin = await insertPeriod(db, { start: "2026-08-01", end: "2026-08-15" });
    const carry = (
      await one<{ id: string }>(
        db,
        `INSERT INTO public.payroll_discount_carries (employee_id, amount, origin_period_id) VALUES ($1, 10000, $2) RETURNING id`,
        [employee, origin],
      )
    ).id;
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const item = { ...payrollItem(period, employee), other_discounts: 10000, net_pay: 440000 };

    await apply(period, [item], [], [carry]);
    await apply(period, [item], [], [carry]);
    const row = await one<{ applied_period_id: string }>(
      db,
      `SELECT applied_period_id FROM public.payroll_discount_carries WHERE id = $1`,
      [carry],
    );
    expect(row.applied_period_id).toBe(period);
  });

  it("rejects an unknown employee with PAYROLL_ITEM_MISMATCH and a duplicated voucher id with PAYROLL_INVALID", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const voucher = await insertVoucher(db, employee);
    const ghost = payrollItem(period, "00000000-0000-4000-8000-000000000000");
    expect((await pgError(apply(period, [ghost], [voucher]))).message).toBe("PAYROLL_ITEM_MISMATCH");
    expect(await voucherStatus(voucher)).toBe("aprobada");
    expect((await pgError(apply(period, [], [voucher, voucher]))).message).toBe("PAYROLL_INVALID");
  });
});

describe("payroll_delete_period_atomic", () => {
  it("deletes a draft, reverting its vouchers to the requested states", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const approved = await insertVoucher(db, employee, "aprobada");
    const pending = await insertVoucher(db, employee, "pendiente");
    await apply(period, [payrollItem(period, employee)], [approved, pending]);

    expect(await remove(period, [approved], [pending])).toBe(2);
    expect([await voucherStatus(approved), await voucherStatus(pending)]).toEqual(["aprobada", "pendiente"]);
    expect(await count(db, `SELECT 1 FROM public.payroll_periods WHERE id = $1`, [period])).toBe(0);
    expect(await count(db, `SELECT 1 FROM public.payroll_items WHERE period_id = $1`, [period])).toBe(0);
  });

  it("only deletes drafts", async () => {
    const closed = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", status: "cerrado" });
    expect((await pgError(remove(closed, [], []))).message).toBe("PAYROLL_PERIOD_CONFLICT");
  });

  it("refuses with PERIOD_OVERLAP_AMBIGUOUS when a closed period of another cadence overlaps", async () => {
    // The EXCLUDE only separates periods of the SAME frequency, so a closed
    // 'mensual' can overlap a draft 'quincenal'.
    await insertPeriod(db, { start: "2026-09-01", end: "2026-09-30", status: "cerrado", frequency: "mensual" });
    const draft = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", frequency: "quincenal" });
    expect((await pgError(remove(draft, [], []))).message).toBe("PERIOD_OVERLAP_AMBIGUOUS");
    expect(await count(db, `SELECT 1 FROM public.payroll_periods WHERE id = $1`, [draft])).toBe(1);
  });

  it("treats a NULL-frequency draft as its own cadence: a closed 'mensual' overlap is ambiguous", async () => {
    // EXCLUDE compares COALESCE(frequency, ''): NULL and 'mensual' may overlap.
    await insertPeriod(db, { start: "2026-09-01", end: "2026-09-30", status: "cerrado", frequency: "mensual" });
    const draft = await insertPeriod(db, { start: "2026-09-10", end: "2026-09-20", frequency: null });
    expect((await pgError(remove(draft, [], []))).message).toBe("PERIOD_OVERLAP_AMBIGUOUS");
    // The reverse: a closed NULL-frequency period blocks a 'mensual' draft too.
    await insertPeriod(db, { start: "2026-10-01", end: "2026-10-31", status: "cerrado", frequency: null });
    const mensual = await insertPeriod(db, { start: "2026-10-01", end: "2026-10-31", frequency: "mensual" });
    expect((await pgError(remove(mensual, [], []))).message).toBe("PERIOD_OVERLAP_AMBIGUOUS");
  });

  it("aborts with PAYROLL_VOUCHER_CONFLICT when a voucher is no longer discounted", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const voucher = await insertVoucher(db, employee, "aprobada");
    expect((await pgError(remove(period, [voucher], []))).message).toBe("PAYROLL_VOUCHER_CONFLICT");
    expect(await count(db, `SELECT 1 FROM public.payroll_periods WHERE id = $1`, [period])).toBe(1);
  });
});

describe("payroll_correct_period_atomic", () => {
  const correctionItem = (employeeId: string) => ({
    employee_id: employeeId,
    previous_base_fixed: 500000,
    previous_commissions: 0,
    previous_bonuses: 0,
    previous_deductions_vales: 50000,
    previous_other_discounts: 0,
    previous_net_pay: 450000,
    previous_paid: 450000,
    corrected_base_fixed: 500000,
    corrected_commissions: 20000,
    corrected_bonuses: 0,
    corrected_deductions_vales: 50000,
    corrected_other_discounts: 0,
    corrected_net_pay: 470000,
  });
  const correct = async (period: string, items: unknown[], reason = "Comisión omitida") => {
    const user = await insertUser(db);
    return rpc<Record<string, unknown>>(
      db,
      "payroll_correct_period_atomic",
      [
        period,
        JSON.stringify({
          period_id: period,
          reason,
          corrected_by: user,
          previous_net_total: 450000,
          previous_paid_total: 450000,
          corrected_net_total: 470000,
          previous_item_count: 1,
          corrected_item_count: items.length,
        }),
        JSON.stringify(items),
      ],
      ["uuid", "jsonb", "jsonb"],
    );
  };

  it("signs one correction of a closed period with its frozen rows, without touching payroll_items", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    await apply(period, [payrollItem(period, employee)], []);
    await db.query(`UPDATE public.payroll_periods SET status = 'cerrado', closed_at = now() WHERE id = $1`, [period]);

    const header = await correct(period, [correctionItem(employee)]);
    expect(header).toMatchObject({ period_id: period, corrected_net_total: 470000, corrected_item_count: 1, reason: "Comisión omitida" });
    const row = await one<{ previous_net_pay: string; corrected_net_pay: string }>(
      db,
      `SELECT previous_net_pay::text, corrected_net_pay::text FROM public.payroll_period_correction_items WHERE correction_id = $1`,
      [header.id],
    );
    expect(row).toEqual({ previous_net_pay: "450000.00", corrected_net_pay: "470000.00" });
    const signed = await one<{ net_pay: string }>(db, `SELECT net_pay::text FROM public.payroll_items WHERE period_id = $1`, [period]);
    expect(signed.net_pay).toBe("450000.00");

    // One correction per period: the unique index raises 23505 (the service maps it to ALREADY_CORRECTED).
    const second = await pgError(correct(period, [correctionItem(employee)], "Otra"));
    expect(second.code).toBe("23505");
    expect(second.message).toContain("uq_payroll_period_corrections_period");
    expect(await count(db, `SELECT 1 FROM public.payroll_period_corrections WHERE period_id = $1`, [period])).toBe(1);
  });

  it("only corrects a closed period", async () => {
    const draft = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    expect((await pgError(correct(draft, [correctionItem(employee)]))).message).toBe("PERIOD_NOT_CLOSED");
    expect(await count(db, `SELECT 1 FROM public.payroll_period_corrections`)).toBe(0);
  });

  it("rolls the header back when a row names an unknown employee, and rejects a repeated employee", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", status: "cerrado" });
    const ghost = correctionItem("00000000-0000-4000-8000-000000000000");
    expect((await pgError(correct(period, [ghost]))).message).toBe("PAYROLL_CORRECTION_MISMATCH");
    expect(await count(db, `SELECT 1 FROM public.payroll_period_corrections`)).toBe(0);
    const repeated = [correctionItem(employee), correctionItem(employee)];
    expect((await pgError(correct(period, repeated))).message).toBe("PAYROLL_INVALID");
  });
});

describe("ex_payroll_periods_no_overlap (EXCLUDE USING gist)", () => {
  it("rejects overlapping periods of the same frequency, including the NULL frequency", async () => {
    await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", frequency: "quincenal" });
    const same = await pgError(insertPeriod(db, { start: "2026-09-15", end: "2026-09-30", frequency: "quincenal" }));
    expect(same.code).toBe("23P01");
    expect(same.constraint ?? same.message).toContain("ex_payroll_periods_no_overlap");

    await insertPeriod(db, { start: "2026-10-01", end: "2026-10-15" });
    expect((await pgError(insertPeriod(db, { start: "2026-10-10", end: "2026-10-20" }))).code).toBe("23P01");
  });

  it("allows adjacent ranges and overlapping ranges of different frequency", async () => {
    await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", frequency: "quincenal" });
    await insertPeriod(db, { start: "2026-09-16", end: "2026-09-30", frequency: "quincenal" });
    await insertPeriod(db, { start: "2026-09-01", end: "2026-09-30", frequency: "mensual" });
    expect(await count(db, `SELECT 1 FROM public.payroll_periods`)).toBe(3);
  });
});

describe("trg_payroll_payments_cap (check_payroll_payments_cap)", () => {
  it("rejects a payment above the item's net pay", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    await apply(period, [payrollItem(period, employee)], []);
    const item = (await one<{ id: string }>(db, `SELECT id FROM public.payroll_items WHERE period_id = $1`, [period])).id;
    const user = await insertUser(db);
    const pay = (amount: number) =>
      db.query(
        `INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount, paid_by) VALUES ($1, 'efectivo', $2, $3)`,
        [item, amount, user],
      );
    await pay(450000);
    const error = await pgError(pay(1));
    expect(error.code).toBe("P0001");
    expect(error.message).toContain("El pago supera el neto del ítem");
  });
});
