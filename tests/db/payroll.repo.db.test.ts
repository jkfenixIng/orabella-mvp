/**
 * Payroll repository: equivalence supabase-js (PostgREST double) ↔ Drizzle
 * over the same real schema (001-004). Each case runs the same port call on
 * two identical databases and compares the `{ data, error }` result: numeric
 * as number, civil dates, jsonb, PostgREST timestamps, total orders across
 * offset pages, the three payroll units of work with their outputs and
 * errors, 003 voucher cash effects, idempotency indexes, and that a database
 * failure never carries driver params.
 */
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzlePayrollRepo } from "@/src/features/payroll/repos/payroll.drizzle";
import { supabasePayrollRepo, type PayrollRepo } from "@/src/features/payroll/repos/payroll";
import type { Database } from "@/src/shared/db/client";
import * as schema from "@/src/shared/db/schema";
import { bogotaDay, rangeBounds } from "@/src/shared/lib/dates";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, warmTemplate, type Db } from "./harness";
import { countLines, payrollItem, registerId } from "./fixtures";
import { postgrestDouble } from "./postgrest-double";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1);
const EMP = id(2);
const EMP2 = id(3);
const DRAFT = id(10);
const CLOSED = id(11);
const ORIGIN = id(12);
const ITEM = id(20);
const ITEM2 = id(21);
const INVOICE = id(30);
const KEY = "4f3b1c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";

let left: Db;
let right: Db;
/** The shift each database opened (generated ids differ per instance). */
let shifts: [string, string];

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  [left, right] = await Promise.all([freshDb(), freshDb()]);
  shifts = (await Promise.all([seed(left), seed(right)])) as [string, string];
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(left);
  await closeDb(right);
});

/** Same ids on both databases, so every result is comparable as is. */
async function seed(db: Db): Promise<string> {
  await db.query(`INSERT INTO public.users (id, id_type, id_number, password_hash, full_name) VALUES ($1, 'CC', 'U1', 'x', 'Ana Admin')`, [USER]);
  await db.query(
    `INSERT INTO public.employees (id, document, pay_type, full_name, salary_fixed) VALUES ($1, 'D1', 'fijo', 'Eva', 1000000), ($2, 'D2', 'porcentaje', 'Leo', NULL)`,
    [EMP, EMP2],
  );
  await db.query(
    `INSERT INTO public.payroll_periods (id, start_date, end_date, status, created_by, closed_at, frequency, created_at) VALUES
      ($1, '2026-09-01', '2026-09-15', 'borrador', $4, NULL, NULL, '2026-09-16 10:00:00.5-05'),
      ($2, '2026-08-16', '2026-08-31', 'cerrado', $4, '2026-09-01 08:00:00-05', NULL, '2026-09-01 07:00:00-05'),
      ($3, '2026-08-01', '2026-08-15', 'cerrado', $4, '2026-08-16 08:00:00-05', 'quincenal', '2026-08-16 07:00:00-05')`,
    [DRAFT, CLOSED, ORIGIN, USER],
  );
  await db.query(
    `INSERT INTO public.payroll_items (id, period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json, voucher_total, adjustment_reason, created_at)
     VALUES ($1, $3, $4, 500000.5, 0, 0, 0, 0, 500000.5, '[{"invoice_id":"x","commission":0.25,"nested":{"a":[1,"b"]}}]', 0, NULL, '2026-09-16 10:00:00-05'),
            ($2, $3, $5, 0, 100, 10, 0, 0, 110, '[]', 0, 'bono', '2026-09-16 10:00:00-05')`,
    [ITEM, ITEM2, DRAFT, EMP, EMP2],
  );
  await db.query(
    `INSERT INTO public.payroll_payments (id, payroll_item_id, method_code, amount, paid_by, paid_at, idempotency_key) VALUES
      ($1, $3, 'efectivo', 100.25, $4, '2026-09-16 11:00:00-05', $5), ($2, $3, 'nequi', 50, $4, '2026-09-16 11:00:00-05', NULL)`,
    [id(40), id(41), ITEM, USER, KEY],
  );
  await db.query(
    `INSERT INTO public.payroll_discount_carries (id, employee_id, amount, origin_period_id, applied_period_id) VALUES
      ($1, $3, 1000.5, $4, NULL), ($2, $3, 200, $4, $5)`,
    [id(50), id(51), EMP, ORIGIN, DRAFT],
  );
  await db.query(
    `INSERT INTO public.invoices (id, consecutive_number, subtotal, discount, tax, total, status, user_id, created_at)
     VALUES ($1, 1, 1000, 0, 0, 1000, 'Pagada', $2, '2026-09-01 00:00:00-05')`,
    [INVOICE, USER],
  );
  await db.query(
    `INSERT INTO public.invoice_items (id, invoice_id, item_type, custom_name, employee_id, qty, unit_price, subtotal, commission_value, commission_percent_override)
     VALUES ($1, $2, 'custom', 'Corte', $3, 2, 500.5, 1001, 12.5, 7.25)`,
    [id(31), INVOICE, EMP],
  );
  await db.query(
    `INSERT INTO public.commission_rules (id, item_type, item_id, employee_id, percent, amount) VALUES ($1, 'servicio', $2, $3, 12.5, NULL)`,
    [id(60), id(61), EMP],
  );
  await db.query(`INSERT INTO public.system_settings (key, value) VALUES ('voucher_max_per_day', '{"amount": 50000}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  const opened = await one<{ result: { id: string } }>(
    db,
    `SELECT public.cash_open_shift_atomic($1::uuid, $2::uuid, 200000::numeric, $3::jsonb) AS result`,
    [await registerId(db), USER, JSON.stringify(countLines(200000))],
  );
  await db.query(
    `INSERT INTO public.voucher_requests (id, employee_id, amount, request_date, status, approved_by, method_code, cash_shift_id, created_by, idempotency_key) VALUES
      ($1, $5, 1000.5, '2026-09-05', 'aprobada', $6, 'efectivo', $7, $6, $8),
      ($2, $5, 2000, '2026-09-05', 'pendiente', NULL, 'efectivo', $7, $6, NULL),
      ($3, $5, 300, '2026-09-10', 'descontada', NULL, NULL, NULL, NULL, NULL),
      ($4, $5, 400, '2026-08-20', 'descontada', $6, NULL, NULL, NULL, NULL)`,
    [id(70), id(71), id(72), id(73), EMP, USER, opened.result.id, KEY],
  );
  // Ties on paid_at that straddle page boundaries; one row on each side of a Bogotá month edge.
  const extras: Array<[number, string, string]> = [
    [82, "2026-10-01 00:00:00-05", EMP],
    [80, "2026-10-01 00:00:00-05", EMP],
    [81, "2026-10-01 00:00:00-05", EMP2],
    [83, "2026-09-30 23:59:59.999-05", EMP],
    [84, "2026-10-01 04:59:59-00", EMP],
  ];
  for (const [n, paidAt, employee] of extras) {
    await db.query(
      `INSERT INTO public.payroll_extras (id, employee_id, amount, method_code, reason, kind, days_from, days_to, paid_by, paid_at, created_at, idempotency_key)
       VALUES ($1, $2, 99.99, 'efectivo', 'motivo', 'emergencia', '2026-09-01', '2026-09-30', $3, $4, '2026-10-01 01:02:03.000001-05', $5)`,
      [id(n), employee, USER, paidAt, n === 80 ? KEY : null],
    );
  }
  return opened.result.id;
}

function repos(): [PayrollRepo, PayrollRepo] {
  return [supabasePayrollRepo(postgrestDouble(left)), drizzlePayrollRepo(drizzle({ client: right, schema }) as unknown as Database)];
}

const INSTANTS = new Set(["created_at", "paid_at", "closed_at", "corrected_at"]);

/**
 * Values each instance generates on its own: new ids, the shift id, write
 * instants of today, the row echoed by a CHECK failure, and PostgREST's
 * `count` metadata. Everything else is compared verbatim.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "count");
  return Object.fromEntries(
    entries.map(([key, child]) => {
      if (typeof child !== "string") return [key, stable(child)];
      if ((key === "id" || key === "cash_shift_id") && !child.startsWith("00000000-")) return [key, "<generated>"];
      if (INSTANTS.has(key) && child.startsWith(bogotaDay())) {
        expect(child).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?-05:00$/);
        return [key, "<instant>"];
      }
      if (key === "details" && child.startsWith("Failing row contains")) return [key, "<row>"];
      return [key, child];
    }),
  );
}

async function same<T>(run: (repo: PayrollRepo, shift: string) => Promise<T>): Promise<T> {
  const [viaPostgrest, viaDrizzle] = repos();
  const expected = stable(await run(viaPostgrest, shifts[0]));
  const actual = await run(viaDrizzle, shifts[1]);
  expect(stable(actual)).toEqual(expected);
  return actual;
}

const data = <T>(result: { data: T | null }) => result.data as T;

describe("payroll repository: reads", () => {
  it("periods: civil dates, PostgREST timestamps, start_date DESC with id tiebreak, offset pages", async () => {
    const all = data(await same((repo) => repo.periodsPage<Record<string, unknown>>(0, 99)));
    expect(all.map((row) => row.id)).toEqual([DRAFT, CLOSED, ORIGIN]);
    expect(all[0]).toMatchObject({ start_date: "2026-09-01", created_at: "2026-09-16T10:00:00.5-05:00", closed_at: null });
    expect(data(await same((repo) => repo.periodsPage(1, 1)))).toEqual([all[1]]);
    await same((repo) => repo.findPeriod(DRAFT));
    await same((repo) => repo.findPeriod(id(999)));
    await same((repo) => repo.periodEndsPage([CLOSED, ORIGIN], 0, 99));
    await same((repo) => repo.overlappingPeriods(DRAFT, "2026-08-20", "2026-09-02"));
  });

  it("items: numeric money as numbers and jsonb detail parsed, both orders and employee filter", async () => {
    const items = data(await same((repo) => repo.periodItemsPage<Record<string, unknown>>(DRAFT, 0, 99)));
    expect(items.map((row) => row.id)).toEqual([ITEM, ITEM2]);
    expect(items[0]).toMatchObject({ base_fixed: 500000.5, detail_json: [{ invoice_id: "x", commission: 0.25, nested: { a: [1, "b"] } }] });
    await same((repo) => repo.periodItemsPage(DRAFT, 1, 1));
    await same((repo) => repo.itemsOfPeriodsPage([DRAFT, CLOSED], undefined, 0, 99));
    await same((repo) => repo.itemsOfPeriodsPage([DRAFT], EMP2, 0, 99));
    await same((repo) => repo.employeeItemDetailPage(DRAFT, EMP, 0, 99));
    await same((repo) => repo.findItem(ITEM));
  });

  it("payments and idempotency lookups", async () => {
    await same((repo) => repo.paymentAmountsPage([ITEM, ITEM2], 0, 99));
    expect(data(await same((repo) => repo.paymentAmounts(ITEM)))).toHaveLength(2);
    const marked = data(await same((repo) => repo.paymentsByKey<Record<string, unknown>>(ITEM, KEY)));
    expect(marked).toEqual([expect.objectContaining({ id: id(40), amount: 100.25, paid_at: "2026-09-16T11:00:00-05:00", idempotency_key: KEY })]);
    await same((repo) => repo.paymentsByKey(ITEM2, KEY));
  });

  it("extras: paid_at DESC, id ASC with ties across pages on both engines", async () => {
    const all = data(await same((repo) => repo.extrasPage<{ id: string }>({}, 0, 99)));
    expect(all.map((row) => row.id)).toEqual([id(80), id(81), id(82), id(83), id(84)]);
    const paged: string[] = [];
    for (let from = 0; from < all.length; from += 2) {
      paged.push(...data(await same((repo) => repo.extrasPage<{ id: string }>({}, from, from + 1))).map((row) => row.id));
    }
    expect(paged).toEqual(all.map((row) => row.id));
    await same((repo) => repo.findExtraByKey(EMP, KEY));
    await same((repo) => repo.findExtraByKey(EMP2, KEY));
  });

  it("extras: the Bogotá month bounds include 00:00 and 23:59:59.999 -05:00 and exclude the neighbour month", async () => {
    const october = rangeBounds("2026-10-01", "2026-10-31");
    const rows = data(await same((repo) => repo.extrasPage<{ id: string; paid_at: string }>({ from: october.from, to: october.to }, 0, 99)));
    // 84 is 2026-09-30 23:59:59-05 written in UTC: it belongs to September.
    expect(rows.map((row) => row.id)).toEqual([id(80), id(81), id(82)]);
    const september = rangeBounds("2026-09-01", "2026-09-30");
    const before = data(await same((repo) => repo.extrasPage<{ id: string; paid_at: string }>({ from: september.from, to: september.to, employeeId: EMP }, 0, 99)));
    expect(before.map((row) => row.id)).toEqual([id(83), id(84)]);
    expect(before[1].paid_at).toBe("2026-09-30T23:59:59-05:00");
  });

  it("calculation inputs: paid invoices by Bogotá instant, lines, rules, payouts, carries, vouchers", async () => {
    const range = rangeBounds("2026-09-01", "2026-09-15");
    expect(data(await same((repo) => repo.paidInvoicesPage(range.from, range.to, 0, 99)))).toEqual([{ id: INVOICE, consecutive_number: 1 }]);
    const lines = data(await same((repo) => repo.invoiceItemsPage<Record<string, unknown>>([INVOICE], 0, 99)));
    expect(lines[0]).toMatchObject({ qty: 2, unit_price: 500.5, subtotal: 1001, commission_value: 12.5, commission_percent_override: 7.25, no_commission: false });
    await same((repo) => repo.activeRulesPage([EMP, EMP2], 0, 99));
    await same((repo) => repo.payoutsPage([INVOICE], 0, 99));
    await same((repo) => repo.pendingCarriesPage(0, 99));
    await same((repo) => repo.appliedCarriesPage(DRAFT, 0, 99));
    await same((repo) => repo.pendingDebtOfPeriodPage(ORIGIN, 0, 99));
    await same((repo) => repo.periodVouchersPage(["pendiente", "aprobada", "descontada"], "2026-09-01", "2026-09-15", 0, 99));
    await same((repo) => repo.employeeVouchersPage(EMP, ["aprobada", "descontada"], "2026-09-01", "2026-09-15", 0, 99));
    await same((repo) => repo.vigenteVouchersPage(EMP, "2026-08-31", "2026-09-06", 0, 99));
    await same((repo) => repo.discountedVouchers("2026-09-01", "2026-09-15"));
    await same((repo) => repo.earliestInvoice());
  });

  it("settings: jsonb envelopes in, the confirmed rows back", async () => {
    await same((repo) => repo.settings(["voucher_max_per_day", "voucher_allowed_days"]));
    const written = await same((repo) =>
      repo.upsertSettings([
        { key: "voucher_max_per_day", value: { amount: 70000.5 } },
        { key: "voucher_per_day_limits", value: { limits: { "3": 50000 } } },
        { key: "voucher_allowed_days", value: { days: [1, 2, 3] } },
      ]),
    );
    expect(written.error).toBeNull();
    await same((repo) => repo.settings(["voucher_max_per_day", "voucher_per_day_limits", "voucher_allowed_days"]));
  });

  it("vouchers: the 001-004 columns, list filters ordered by request_date DESC, id", async () => {
    expect(await repos()[1].voucherColumns()).toEqual({ method: true, createdBy: true });
    expect(await repos()[0].voucherColumns()).toEqual({ method: true, createdBy: true });
    const list = data(await same((repo) => repo.listVouchers({}, 50)));
    expect(list.map((row) => row.id)).toEqual([id(72), id(70), id(71), id(73)]);
    await same((repo) => repo.listVouchers({ status: "aprobada", employee_id: EMP }, 50));
    await same((repo) => repo.listVouchers({ date_from: "2026-09-05", date_to: "2026-09-05" }, 50));
    await same((repo) => repo.listVouchers({ date_from: "2026-09-01", date_to: "2026-09-30" }, 1));
    await same((repo) => repo.listVouchers({ request_date: "2026-08-20" }, 50));
    await same((repo) => repo.findVoucher(id(70)));
    await same((repo) => repo.voucherByKey(EMP, KEY));
    await same((repo) => repo.userNames([USER, id(998)]));
  });

  it("corrections", async () => {
    await same((repo) => repo.findCorrectionId(CLOSED));
    await same((repo) => repo.findCorrection(CLOSED));
  });
});

describe("payroll repository: writes and their errors", () => {
  it("period insert, the 23505 draft and the 23P01 overlap; close returns PostgREST timestamps", async () => {
    const created = await same((repo) =>
      repo.insertPeriod({ start_date: "2026-09-20", end_date: "2026-09-26", frequency: "semanal", status: "borrador", created_by: USER }),
    );
    expect(created.data).toMatchObject({ start_date: "2026-09-20", frequency: "semanal", status: "borrador" });
    const overlap = await same((repo) =>
      repo.insertPeriod({ start_date: "2026-09-21", end_date: "2026-09-27", frequency: "semanal", status: "borrador", created_by: USER }),
    );
    expect(overlap.error?.code).toBe("23P01");
    const closed = await same((repo) => repo.closePeriod(DRAFT, "2026-09-20T12:00:00.123-05:00"));
    expect(closed.data).toMatchObject({ status: "cerrado", closed_at: "2026-09-20T12:00:00.123-05:00" });
    expect((await same((repo) => repo.closePeriod(id(999), "2026-09-20T12:00:00-05:00"))).error?.code).toBe("PGRST116");
  });

  it("payments: multi-row insert, the idempotency 23505 and the cap P0001 abort the whole statement", async () => {
    const portion = (key: string | null, amount: number) => ({ payroll_item_id: ITEM2, method_id: null, method_code: "efectivo", amount, paid_by: USER, reference: null, idempotency_key: key });
    const inserted = await same((repo) => repo.insertPayments([portion(KEY, 50), portion(null, 10.5)]));
    expect(inserted.data).toHaveLength(2);
    expect((await same((repo) => repo.insertPayments([portion(KEY, 1)]))).error?.code).toBe("23505");
    const over = await same((repo) => repo.insertPayments([portion(null, 49), portion(null, 1)]));
    expect(over.error?.code).toBe("P0001");
    expect(data(await same((repo) => repo.paymentAmounts(ITEM2)))).toHaveLength(2);
  });

  it("extras: insert keeps civil days and numeric amount; the same key for the same employee is 23505", async () => {
    const row = { employee_id: EMP2, amount: 1234.5, method_id: null, method_code: "efectivo", reference: null, reason: "renuncia", kind: "renuncia", days_from: "2026-09-01", days_to: "2026-09-03", paid_by: USER, idempotency_key: "5a5a5a5a-1111-4222-8333-444455556666" };
    const created = await same((repo) => repo.insertExtra(row));
    expect(created.data).toMatchObject({ amount: 1234.5, days_from: "2026-09-01", days_to: "2026-09-03" });
    expect((await same((repo) => repo.insertExtra(row))).error?.code).toBe("23505");
    expect((await same((repo) => repo.insertExtra({ ...row, employee_id: EMP }))).error).toBeNull();
  });

  it("vouchers 003: an approved cash voucher moves the shift balance; a breach of the method floor is a P0001", async () => {
    const outflow = (db: Db, shift: string) =>
      one<{ v: string }>(
        db,
        `SELECT coalesce(sum(amount), 0)::text AS v FROM public.voucher_requests
          WHERE cash_shift_id = $1 AND public.voucher_is_cash_out(status, approved_by, method_code, cash_shift_id)`,
        [shift],
      ).then((row) => row.v);
    const before = await outflow(left, shifts[0]);
    const voucher = (shift: string, extra: Record<string, unknown> = {}) => ({
      employee_id: EMP2, amount: 1000, request_date: "2026-09-07", status: "aprobada", approved_by: USER, observation: null,
      method_code: "efectivo", cash_shift_id: shift, created_by: USER, idempotency_key: "6b6b6b6b-1111-4222-8333-444455556666", ...extra,
    });
    const created = await same((repo, shift) => repo.insertVoucher(voucher(shift)));
    expect(created.data).toMatchObject({ amount: 1000, request_date: "2026-09-07", method_code: "efectivo", cash_shift_id: shifts[1], created_by: USER });
    expect(await outflow(left, shifts[0])).toBe("2000.50");
    expect(await outflow(right, shifts[1])).toBe(await outflow(left, shifts[0]));
    expect(before).toBe("1000.50");
    expect((await same((repo, shift) => repo.insertVoucher(voucher(shift)))).error?.code).toBe("23505");
    // A pending voucher does not leave the drawer yet; a direct outflow past the method floor is rejected by 003.
    expect((await same((repo, shift) => repo.insertVoucher(voucher(shift, { status: "pendiente", approved_by: null, amount: 190000, idempotency_key: null })))).error).toBeNull();
    const breach = await same((repo, shift) => repo.insertVoucher(voucher(shift, { amount: 190000, idempotency_key: null })));
    expect(breach.error).toMatchObject({ code: "P0001", message: "CASH_METHOD_MINIMUM_BREACH" });
    expect(await outflow(right, shifts[1])).toBe("2000.50");
  });

  it("vouchers: compare-and-swap review, PGRST116 when the state moved, and 003 immutability", async () => {
    const approved = await same((repo) => repo.reviewVoucher(id(71), "pendiente", { status: "aprobada", approved_by: USER, observation: "ok" }));
    expect(approved.data).toMatchObject({ status: "aprobada", approved_by: USER, observation: "ok" });
    expect((await same((repo) => repo.reviewVoucher(id(71), "pendiente", { status: "rechazada", observation: "x" }))).error?.code).toBe("PGRST116");
    const immutable = await same((repo) => repo.reviewVoucher(id(70), "aprobada", { status: "rechazada", observation: "x" }));
    expect(immutable.error?.message).toBe("VOUCHER_CASH_OUT_IMMUTABLE");
  });
});

describe("payroll repository: units of work", () => {
  it("payroll_apply_atomic: integer count, voucher flip, debt rows and its rejections", async () => {
    const item = { ...payrollItem(DRAFT, EMP, { voucherExcess: 1000 }), deductions_vales: 1000.5, voucher_total: 1000.5, net_pay: 498999.5 };
    const applied = await same((repo) => repo.applyAtomic(DRAFT, [item], [id(70)], [id(50)]));
    expect(applied).toEqual({ data: 1, error: null });
    for (const db of [left, right]) {
      expect((await one<{ status: string }>(db, `SELECT status FROM public.voucher_requests WHERE id = $1`, [id(70)])).status).toBe("descontada");
    }
    expect((await same((repo) => repo.applyAtomic(DRAFT, [item], [id(70)], []))).error?.message).toBe("PAYROLL_VOUCHER_CONFLICT");
    expect((await same((repo) => repo.applyAtomic(DRAFT, [], [id(71), id(71)], []))).error?.message).toBe("PAYROLL_INVALID");
    expect((await same((repo) => repo.applyAtomic(CLOSED, [], [], []))).error).toBeNull();
    expect((await same((repo) => repo.applyAtomic("not-a-uuid", [], [], []))).error?.code).toBe("22P02");
  });

  it("payroll_delete_period_atomic: reverts the given vouchers and deletes the draft; errors keep their message", async () => {
    await same((repo) => repo.applyAtomic(DRAFT, [], [id(71)], []));
    const deleted = await same((repo) => repo.deleteAtomic(DRAFT, [], [id(71), id(72)]));
    expect(deleted).toEqual({ data: 2, error: null });
    expect((await same((repo) => repo.findPeriod(DRAFT))).data).toBeNull();
    expect((await same((repo) => repo.deleteAtomic(CLOSED, [], []))).error?.message).toMatch(/PAYROLL_PERIOD_CONFLICT|PERIOD/);
  });

  it("payroll_correct_period_atomic: jsonb header back, ALREADY 23505 on the second correction", async () => {
    const correction = { period_id: CLOSED, previous_net_total: 0, previous_paid_total: 0, corrected_net_total: 10.5, previous_item_count: 0, corrected_item_count: 1, reason: "ajuste", corrected_by: USER };
    const items = [{ employee_id: EMP, previous_base_fixed: 0, previous_commissions: 0, previous_bonuses: 0, previous_deductions_vales: 0, previous_other_discounts: 0, previous_net_pay: 0, previous_paid: 0, corrected_base_fixed: 10.5, corrected_commissions: 0, corrected_bonuses: 0, corrected_deductions_vales: 0, corrected_other_discounts: 0, corrected_net_pay: 10.5 }];
    const created = await same((repo) => repo.correctAtomic(CLOSED, correction, items));
    expect(created.data).toMatchObject({ period_id: CLOSED, corrected_item_count: 1, reason: "ajuste" });
    const header = data(await same((repo) => repo.findCorrection<{ id: string; corrected_net_total: number }>(CLOSED)));
    expect(header.corrected_net_total).toBe(10.5);
    // The header id is generated per instance: each engine reads its own.
    const lines = await same(async (repo) => {
      const own = data(await repo.findCorrection<{ id: string }>(CLOSED));
      const page = await repo.correctionItemsPage<Record<string, unknown>>(own.id, 0, 99);
      return {
        ...page,
        data: page.data?.map((row) => {
          const { correction_id, ...rest } = row;
          void correction_id;
          return rest;
        }) ?? null,
      };
    });
    expect(lines.data).toEqual([expect.objectContaining({ employee_id: EMP, corrected_net_pay: 10.5 })]);
    expect((await same((repo) => repo.correctAtomic(CLOSED, correction, items))).error?.code).toBe("23505");
    expect((await same((repo) => repo.correctAtomic(DRAFT, { ...correction, period_id: DRAFT }, items))).error?.message).toMatch(/PERIOD_NOT_CLOSED/);
  });

  it("a database failure exposes only SQLSTATE/message/details, never the SQL or its params", async () => {
    // The failing value is PostgreSQL's own echo (PostgREST sends the same);
    // the OTHER bound values must not travel with the error.
    const secret = "secret-token-hash-should-not-leak";
    const [, drizzleRepo] = repos();
    const failure = await drizzleRepo.insertExtra({ employee_id: "not-a-uuid", amount: 1, method_code: "efectivo", reason: secret, kind: "renuncia", paid_by: USER, idempotency_key: secret });
    expect(failure.error?.code).toBe("22P02");
    expect(failure.data).toBeNull();
    expect(Object.keys(failure.error ?? {}).sort()).toEqual(["code", "details", "message"]);
    expect(JSON.stringify(failure.error)).not.toContain(secret);
    expect(JSON.stringify(failure.error)).not.toMatch(/Failed query|params:/);
  });
});
