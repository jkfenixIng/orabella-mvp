/**
 * Cash and billing repositories: equivalence supabase-js (PostgREST double) ↔
 * Drizzle over two copies of the same real schema (001-004), plus the RPC
 * contracts (results, SQLSTATE, 003 wrappers) both engines must keep.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleBillingRepo } from "@/src/features/billing/repos/billing.drizzle";
import { supabaseBillingRepo, type BillingRepo } from "@/src/features/billing/repos/billing";
import { drizzleCashRepo } from "@/src/features/cash/repos/cash.drizzle";
import { supabaseCashRepo, type CashRepo } from "@/src/features/cash/repos/cash";
import type { Database } from "@/src/shared/db/client";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, setCopTriggers, one, warmTemplate, type Db } from "./harness";
import { countLines, createInvoiceCall, registerId } from "./fixtures";
import { postgrestDouble } from "./postgrest-double";

const USER = "00000000-0000-4000-8000-0000000000a1";
const EMPLOYEE = "00000000-0000-4000-8000-0000000000e1";
const OLD_SHIFT = "00000000-0000-4000-8000-0000000000c0";
const FROM = "2020-01-01T00:00:00-05:00";
const TO = "2030-01-01T00:00:00-05:00";

let left: Db;
let right: Db;
let register: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  [left, right] = await Promise.all([freshDb(), freshDb()]);
  await Promise.all([setCopTriggers(left, false), setCopTriggers(right, false)]);
  await Promise.all([seed(left), seed(right)]);
  register = await registerId(left);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(left);
  await closeDb(right);
});

/** Same ids on both instances so rows compare one to one. */
async function seed(db: Db) {
  await db.query(`INSERT INTO public.users (id, id_type, id_number, password_hash, full_name) VALUES ($1, 'CC', '1', 'x', 'Ana Caja')`, [USER]);
  await db.query(`INSERT INTO public.employees (id, document, pay_type, full_name, employee_code, commission_percent) VALUES ($1, 'D1', 'porcentaje', 'Eva', 'E-1', 12.5)`, [EMPLOYEE]);
  const reg = await registerId(db);
  // A pre-003 legacy shift (closed, no frozen balances) and the open shift
  // through the 003 wrapper, which freezes one balance per arqueable method.
  await db.query(
    `INSERT INTO public.cash_shifts (id, cash_register_id, opened_by, opening_base, status, closed_at, closed_by, counted_cash, base_left, cash_withdrawn, base_difference, opened_at)
     VALUES ($1, $2, $3, 150000.5, 'cerrado', '2026-10-09 18:00:00.5-05', $3, 150000.5, 150000.5, 0, 0, '2026-10-09 08:00:00.123456-05')`,
    [OLD_SHIFT, reg, USER],
  );
  await db.query(`SELECT public.cash_open_shift_atomic($1::uuid, $2::uuid, 200000::numeric, $3::jsonb)`, [reg, USER, JSON.stringify(countLines())]);
}

const shiftId = async (db: Db) => (await one<{ id: string }>(db, `SELECT id FROM public.cash_shifts WHERE status = 'abierto'`)).id;
const repos = () => ({
  cash: [supabaseCashRepo(postgrestDouble(left)), drizzleCashRepo(drizzle({ client: right, schema }) as unknown as Database)] as [CashRepo, CashRepo],
  billing: [supabaseBillingRepo(postgrestDouble(left)), drizzleBillingRepo(drizzle({ client: right, schema }) as unknown as Database)] as [BillingRepo, BillingRepo],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Generated ids and write instants differ per instance: blank them, check the format. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const row = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, stable(child)]));
    if (typeof row.details === "string") row.details = "<detail>";
    for (const field of ["created_at", "closed_at", "opened_at", "recounted_at"]) {
      if (typeof row[field] === "string" && !(row[field] as string).startsWith("2026-10-09")) {
        expect(row[field]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}:\d{2}$/);
        row[field] = "<instant>";
      }
    }
    return row;
  }
  if (typeof value === "string" && UUID.test(value) && !value.startsWith("00000000-")) return "<generated>";
  return value;
}

/** Runs the same call on each engine (with its own instance's generated ids) and compares. */
/**
 * The fields the services read: `data`/`error` of a result, `count`/`error` of
 * a head count. supabase-js also sends `count: null` on plain reads and
 * `data: null` on head counts; nothing reads those.
 */
function envelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("error" in value)) return value;
  const { data, count, error } = value as { data?: unknown; count?: unknown; error: unknown };
  return typeof count === "number" ? { count, error } : { data, error };
}

/**
 * Rows written by the RPCs and fixtures get random ids, so the two instances
 * order them differently under `ORDER BY id`. `unordered` compares those sets
 * as sets; the order itself is asserted on fixed ids elsewhere.
 */
function bySortKey(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) return value;
  const data = [...((value as { data: unknown[] }).data)].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { ...(value as object), data };
}

async function same<R>(pair: [R, R], run: (repo: R, db: Db) => Promise<unknown>, unordered = false) {
  const shape = (value: unknown) => (unordered ? bySortKey(stable(envelope(value))) : stable(envelope(value)));
  const expected = shape(await run(pair[0], left));
  const actual = shape(await run(pair[1], right));
  expect(actual).toEqual(expected);
  return actual as { data?: unknown; error?: { code?: string | null; message?: string | null } | null; count?: number | null };
}

describe("CashRepo: supabase-js ↔ drizzle", () => {
  it("catalogs, shifts, last close and counts: numeric as number, PostgREST timestamps, total orders", async () => {
    const { cash } = repos();
    const denominations = await same(cash, (repo) => repo.listActiveDenominations());
    expect(typeof (denominations.data as Array<{ value: unknown }>)[0].value).toBe("number");
    await same(cash, (repo) => repo.listRegisters());
    await same(cash, (repo) => repo.getRegister(register));
    await same(cash, (repo) => repo.firstActiveRegister());
    const old = await same(cash, (repo) => repo.getShift(OLD_SHIFT));
    expect(old.data).toMatchObject({ opening_base: 150000.5, opened_at: "2026-10-09T08:00:00.123456-05:00", closed_at: "2026-10-09T18:00:00.5-05:00" });
    await same(cash, (repo) => repo.getOpenShift());
    await same(cash, async (repo, db) => repo.getShift(await shiftId(db)));
    await same(cash, (repo) => repo.getShift(randomUUID()));
    await same(cash, (repo) => repo.lastClosedShiftForRegister(register));
    await same(cash, (repo) => repo.openShiftIdsForRegister(register));
    await same(cash, async (repo, db) => repo.listShiftCounts(await shiftId(db), "apertura"), true);
    await same(cash, (repo) => repo.findRecountId(OLD_SHIFT));
    await same(cash, (repo) => repo.userFullName(USER));
    await same(cash, (repo) => repo.userNames([USER]));
  });

  it("denominations and registers: upsert, update, delete and the default register write", async () => {
    const { cash } = repos();
    await same(cash, (repo) => repo.upsertDenomination({ kind: "billete", value: 123.45 }));
    const dup = await same(cash, (repo) => repo.upsertDenomination({ kind: "moneda", value: 123.45 }));
    expect(dup.error?.code).toBe("23505");
    await same(cash, (repo) => repo.updateRegisterBase(register, 250000.25));
    await same(cash, (repo) => repo.updateRegisterBase(randomUUID(), 1));
    const taken = await same(cash, (repo) => repo.ensureDefaultRegister({ name: "Caja única", base_configurada: 200000 }));
    expect(taken.error?.code).toBe("23505");
    await same(cash, async (repo, db) => {
      const { id } = await one<{ id: string }>(db, `SELECT id FROM public.cash_denominations WHERE value = 123.45`);
      return repo.deleteDenomination(id);
    });
    expect((await left.query(`SELECT 1 FROM public.cash_denominations WHERE value = 123.45`)).rows).toHaveLength(0);
    expect((await right.query(`SELECT 1 FROM public.cash_denominations WHERE value = 123.45`)).rows).toHaveLength(0);
  });

  it("day view keeps exactly 50 rows in opened_at, id order; history pages ties without repeats and counts exactly", async () => {
    for (const db of [left, right]) {
      const reg = await registerId(db);
      for (let n = 0; n < 55; n += 1) {
        const id = `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;
        await db.query(
          `INSERT INTO public.cash_shifts (id, cash_register_id, opened_by, opening_base, status, closed_at, closed_by, counted_cash, base_left, cash_withdrawn, base_difference, opened_at)
           VALUES ($1, $2, $3, 0, 'cerrado', now(), $3, 0, 0, 0, 0, '2026-10-08 10:00:00-05')`,
          [id, reg, USER],
        );
      }
    }
    const { cash } = repos();
    const day = await same(cash, (repo) => repo.dayShifts("2026-10-08T00:00:00-05:00", "2026-10-08T23:59:59.999-05:00"));
    const ids = (day.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toHaveLength(50);
    expect(ids).toEqual([...ids].sort());
    const total = await same(cash, (repo) => repo.historyCount(FROM, TO));
    expect(total.count).toBe(57);
    const seen: string[] = [];
    for (let offset = 0; offset < 57; offset += 10) {
      const page = await same(cash, (repo) => repo.historyPage(FROM, TO, offset, 10));
      seen.push(...(page.data as Array<{ id: string }>).map((row) => row.id));
    }
    expect(new Set(seen).size).toBe(57);
  });

  it("the four arqueo sources and their counts: drawer without invoice, direct+historic invoice payments, payouts, vouchers", async () => {
    for (const db of [left, right]) {
      const shift = await shiftId(db);
      const invoice = (await createInvoiceCall(db, { user: USER, shift, employee: EMPLOYEE })).id as string;
      await db.query(`INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 10.5, $2)`, [shift, USER]);
      await db.query(`INSERT INTO public.payments (cash_shift_id, invoice_id, method_code, amount, user_id) VALUES ($1, $2, 'efectivo', 99, $3)`, [shift, invoice, USER]);
      await db.query(`INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'nequi', 20, $2)`, [invoice, shift]);
      // Historic row without shift: attributed through invoices.cash_shift_id.
      await db.query(`INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 30, NULL)`, [invoice]);
      await db.query(`INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate) VALUES ($1, $2, $3, 'efectivo', 1, 3, 3)`, [EMPLOYEE, invoice, shift]);
      for (const [status, approver, method] of [["aprobada", USER, "efectivo"], ["pendiente", null, "efectivo"], ["aprobada", USER, null]] as const) {
        await db.query(`INSERT INTO public.voucher_requests (employee_id, amount, status, approved_by, method_code, cash_shift_id) VALUES ($1, 4, $2, $3, $4, $5)`, [EMPLOYEE, status, approver, method, shift]);
      }
    }
    const { cash } = repos();
    const page = (name: keyof CashRepo) => same(cash, async (repo, db) => {
      const shift = await shiftId(db);
      const fn = repo[name] as unknown as (arg: unknown, from: number, to: number) => Promise<unknown>;
      return fn(name.endsWith("ShiftsPage") || name === "shiftCountsPage" ? [shift] : shift, 0, 999);
    }, true);
    expect(((await page("drawerPaymentsPage")).data as unknown[])).toHaveLength(1);
    expect(((await page("drawerPaymentsByShiftsPage")).data as unknown[])).toHaveLength(1);
    expect(((await page("invoicePaymentsByShiftsPage")).data as unknown[])).toHaveLength(1);
    expect(((await page("invoicesByShiftsPage")).data as unknown[])).toHaveLength(1);
    expect(((await page("shiftPayoutsPage")).data as unknown[])).toHaveLength(1);
    expect(((await page("payoutsByShiftsPage")).data as unknown[])).toHaveLength(1);
    // The service applies `isVoucherCashOut` (approved and with method) after the read.
    expect(((await page("vouchersByShiftsPage")).data as unknown[])).toHaveLength(3);
    expect(((await page("shiftCountsPage")).data as unknown[])).toHaveLength(6);
    await same(cash, async (repo, db) => {
      const invoices = (await db.query<{ id: string }>(`SELECT id FROM public.invoices`)).rows.map((row) => row.id);
      return repo.historicInvoicePaymentsPage(invoices, 0, 999);
    });
    await same(cash, (repo) => repo.recountsPage([OLD_SHIFT], 0, 999));
    expect(await cash[1].voucherOutColumns()).toBe(true);
  });

  it("idempotency lookups and the drawer payment: lookup, 23505 on replay, relookup returns the winner", async () => {
    const { cash } = repos();
    const key = randomUUID();
    const write = async (repo: CashRepo, db: Db) =>
      repo.insertPaymentWithoutInvoice({ cash_shift_id: await shiftId(db), invoice_id: null, method_id: (await one<{ id: string }>(db, `SELECT id FROM public.payment_methods WHERE code = 'efectivo'`)).id, method_code: "efectivo", amount: 1000, user_id: USER, idempotency_key: key });
    await same(cash, async (repo, db) => repo.findPaymentByIdempotency(await shiftId(db), key));
    await same(cash, write);
    const replay = await same(cash, write);
    expect(replay.error?.code).toBe("23505");
    const winner = await same(cash, async (repo, db) => repo.findPaymentByIdempotency(await shiftId(db), key));
    expect(winner.data).toMatchObject({ amount: 1000, invoice_id: null });
  });

  it("method balances (003): frozen bases, the scalar numeric RPC normalized to number, and the legacy shift without balances", async () => {
    const { cash } = repos();
    const balances = await same(cash, async (repo, db) => repo.listShiftMethodBalances(await shiftId(db)));
    expect((balances.data as unknown[]).length).toBe(6);
    await same(cash, async (repo, db) => repo.methodBalance(await shiftId(db), "efectivo"));
    expect((await same(cash, (repo) => repo.methodBalance(OLD_SHIFT, "efectivo"))).data).toBeNull();
    const expected = await same(cash, async (repo, db) => repo.expectedMethodBalance(await shiftId(db), "efectivo"));
    expect(expected.data).toBe(200000);
  });

  it("cash RPCs: open (003 wrapper + 23505), close (ARQUEO_STALE, token, 23514), recount, invoice payment atomic", async () => {
    const { cash } = repos();
    const reopen = await same(cash, (repo) => repo.openShiftAtomic({ registerId: register, openedBy: USER, openingBase: 200000, counts: countLines() }));
    expect(reopen.error).toMatchObject({ message: "SHIFT_ALREADY_OPEN" });

    const invoicePay = await same(cash, async (repo, db) => {
      const shift = await shiftId(db);
      const invoice = (await createInvoiceCall(db, { user: USER, shift, employee: EMPLOYEE })).id as string;
      return repo.invoicePaymentAtomic({ shiftId: shift, invoiceId: invoice, userId: USER, closedAt: "2026-10-10T12:00:00-05:00", setShift: false, markPaid: true, collection: { method_id: null, method_code: "efectivo", amount: 10000, fee_percent: 0, fee_amount: 0, idempotency_key: randomUUID() } });
    });
    expect(invoicePay.data).toMatchObject({ invoice: { status: "Pagada" } });
    const over = await same(cash, async (repo, db) => {
      const shift = await shiftId(db);
      const invoice = (await one<{ id: string }>(db, `SELECT id FROM public.invoices`)).id;
      return repo.invoicePaymentAtomic({ shiftId: shift, invoiceId: invoice, userId: USER, closedAt: "2026-10-10T12:00:00-05:00", setShift: false, markPaid: false, collection: { method_id: null, method_code: "efectivo", amount: 1, fee_percent: 0, fee_amount: 0, idempotency_key: randomUUID() } });
    });
    expect(over.error?.code).toBe("P0001");

    const close = (counts: Record<string, number>, expectedCash = 0) => same(cash, async (repo, db) =>
      repo.closeShiftAtomic({ shiftId: await shiftId(db), closedBy: USER, closedAt: "2026-10-10T20:00:00-05:00", close: { expected_cash: expectedCash, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, observation: null }, counts: countLines(), collectionCounts: counts }));
    expect((await close({ payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 })).error).toMatchObject({ message: "ARQUEO_STALE" });
    expect((await close({ payments: 0, invoice_payments: 1 })).error).toMatchObject({ message: "SHIFT_INVALID" });
    expect((await close({ payments: 0, invoice_payments: 1, commission_payouts: 0, voucher_requests: 0 }, -1)).error).toMatchObject({ code: "23514" });
    const closed = await close({ payments: 0, invoice_payments: 1, commission_payouts: 0, voucher_requests: 0 }, 10000);
    expect(closed.data).toMatchObject({ status: "cerrado", counted_cash: 200000 });

    const recount = () => same(cash, (repo) => repo.recountShiftAtomic({ shiftId: OLD_SHIFT, recountedBy: USER, recount: { previous_counted_cash: 150000.5, previous_base_left: 150000.5, previous_cash_withdrawn: 0, previous_base_difference: 0, counted_cash: 150000, base_left: 150000, cash_withdrawn: 0, base_difference: 0, reason: "Recuento" }, counts: countLines(150000) }));
    expect((await recount()).data).toMatchObject({ shift_id: OLD_SHIFT, previous_counted_cash: 150000.5 });
    expect((await recount()).error).toMatchObject({ message: "ALREADY_RECOUNTED" });
  });
});

describe("BillingRepo: supabase-js ↔ drizzle", () => {
  async function invoices(db: Db, n: number) {
    const shift = await shiftId(db);
    const ids: string[] = [];
    for (let index = 0; index < n; index += 1) ids.push((await createInvoiceCall(db, { user: USER, shift, employee: EMPLOYEE })).id as string);
    return ids;
  }

  it("list/count/pages: consecutive DESC, users embed as an explicit LEFT JOIN, employee filter path by id", async () => {
    await invoices(left, 12);
    await invoices(right, 12);
    const { billing } = repos();
    const first = await same(billing, (repo) => repo.listInvoices({}, { offset: 0, limit: 10 }));
    const rows = first.data as Array<{ consecutive_number: number; users: unknown; total: unknown }>;
    expect(rows.map((row) => row.consecutive_number)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(rows[0].users).toEqual({ full_name: "Ana Caja" });
    expect(typeof rows[0].total).toBe("number");
    await same(billing, (repo) => repo.listInvoices({ status: "Emitida", from: FROM, to: TO, user_id: USER }, { offset: 10, limit: 10 }));
    await same(billing, (repo) => repo.listInvoices({ consecutive_number: 3 }, { offset: 0, limit: 10 }));
    expect((await same(billing, (repo) => repo.countInvoices({}))).count).toBe(12);
    expect((await same(billing, (repo) => repo.countInvoices({ status: "Pagada" }))).count).toBe(0);
    const ids = await same(billing, (repo) => repo.invoiceIdsForEmployeePage(EMPLOYEE, 0, 999));
    expect((ids.data as unknown[]).length).toBe(12);
    await same(billing, async (repo, db) => {
      const all = (await db.query<{ id: string }>(`SELECT id FROM public.invoices`)).rows.map((row) => row.id);
      return repo.invoicesByIdsPage({}, all, 0, 4);
    });
    await same(billing, async (repo, db) => {
      const all = (await db.query<{ id: string }>(`SELECT id FROM public.invoices`)).rows.map((row) => row.id);
      return repo.countInvoices({ status: "Emitida" }, all.slice(0, 5));
    });
    await same(billing, async (repo, db) => {
      const all = (await db.query<{ id: string }>(`SELECT id FROM public.invoices`)).rows.map((row) => row.id);
      return repo.listItemEmployeesPage(all, 0, 999);
    });
  });

  it("detail: items with the employees!inner shape, taxes, payments, numeric/timestamps, rules and names", async () => {
    for (const db of [left, right]) {
      await db.query(`INSERT INTO public.commission_rules (employee_id, item_type, item_id, percent, amount) VALUES ($1, 'servicio', $2, 7.5, NULL)`, [EMPLOYEE, randomUUID()]);
      await createInvoiceCall(db, { user: USER, shift: await shiftId(db), employee: EMPLOYEE, paid: true });
    }
    const { billing } = repos();
    const detail = (name: "getInvoice" | "listInvoiceItemsWithEmployee" | "listInvoiceTaxes" | "listInvoicePayments") =>
      same(billing, async (repo, db) => repo[name]((await one<{ id: string }>(db, `SELECT id FROM public.invoices`)).id));
    expect((await detail("getInvoice")).data).toMatchObject({ status: "Pagada", total: 10000 });
    const items = (await detail("listInvoiceItemsWithEmployee")).data as Array<Record<string, unknown>>;
    expect(items[0].employees).toEqual({ full_name: "Eva", employee_code: "E-1", commission_percent: 12.5, pay_type: "porcentaje", payout_mode: "nomina" });
    await detail("listInvoiceTaxes");
    const payments = (await detail("listInvoicePayments")).data as Array<Record<string, unknown>>;
    expect(payments[0]).toMatchObject({ amount: 10000, fee_percent: 0 });
    await same(billing, (repo) => repo.getInvoice(randomUUID()));
    await same(billing, (repo) => repo.employeeRulesPage([EMPLOYEE], 0, 999));
    await same(billing, (repo) => repo.employeesByIds([EMPLOYEE]));
    await same(billing, (repo) => repo.userNames([USER]));
  });

  it("idempotency: lookup before, 23505 on the replay inside the RPC, relookup finds the winner", async () => {
    const { billing } = repos();
    const key = randomUUID();
    const create = async (repo: BillingRepo, db: Db) =>
      repo.createInvoiceAtomic({ userId: USER, cashShiftId: await shiftId(db), idempotencyKey: key, invoice: { client_name: "C", client_document: null, subtotal: 5000, discount: 0, tax: 0, surcharge: 0, total: 5000, status: "Emitida", closed_by: null, closed_at: null }, items: [{ item_type: "custom", product_id: null, service_id: null, custom_name: "x", employee_id: EMPLOYEE, qty: 1, unit_price: 5000, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 5000 }], taxes: [], payments: [], outReason: "Venta factura #{consecutivo} - C", outItems: [] });
    expect((await same(billing, (repo) => repo.findInvoiceByIdempotencyKey(key))).data).toBeNull();
    expect((await same(billing, create)).data).toMatchObject({ consecutive_number: 1, total: 5000 });
    const replay = await same(billing, create);
    expect(replay.error).toMatchObject({ code: "23505" });
    expect((await same(billing, (repo) => repo.findInvoiceByIdempotencyKey(key))).data).toMatchObject({ consecutive_number: 1 });
    const payKey = randomUUID();
    const split = async (repo: BillingRepo, db: Db) => {
      const shift = await shiftId(db);
      const invoice = (await one<{ id: string }>(db, `SELECT id FROM public.invoices`)).id;
      return repo.splitPaymentAtomic({ invoiceId: invoice, shiftId: shift, userId: USER, closedAt: "2026-10-10T12:00:00-05:00", markPaid: true, portions: [{ method_id: null, method_code: "efectivo", amount: 5000, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: payKey }] });
    };
    expect((await same(billing, split)).data).toMatchObject({ portions: 1, invoice: { status: "Pagada" } });
    expect((await same(billing, split)).error?.code).toMatch(/^(23505|P0001)$/);
    await same(billing, async (repo, db) => repo.findInvoicePaymentsByIdempotency((await one<{ id: string }>(db, `SELECT id FROM public.invoices`)).id, payKey));
  });

  it("payroll lock sources: closed periods and payroll item detail_json pages", async () => {
    for (const db of [left, right]) {
      await db.query(`INSERT INTO public.payroll_periods (id, start_date, end_date, status, closed_at) VALUES ('00000000-0000-4000-8000-0000000000f1', '2026-01-01', '2026-01-31', 'cerrado', now()), ('00000000-0000-4000-8000-0000000000f2', '2026-02-01', '2026-02-28', 'borrador', NULL)`);
      await db.query(`INSERT INTO public.payroll_items (period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json) VALUES ('00000000-0000-4000-8000-0000000000f1', $1, 0, 0, 0, 0, 0, 0, $2::jsonb)`, [EMPLOYEE, JSON.stringify([{ invoice_id: "x" }])]);
    }
    const { billing } = repos();
    const periods = await same(billing, (repo) => repo.closedPayrollPeriodsPage(0, 99));
    expect(periods.data).toEqual([{ id: "00000000-0000-4000-8000-0000000000f1" }]);
    const items = await same(billing, (repo) => repo.payrollItemDetailsPage(["00000000-0000-4000-8000-0000000000f1"], 0, 99));
    expect(items.data).toEqual([{ detail_json: [{ invoice_id: "x" }] }]);
  });

  it("billing RPCs: annul (CAS ANNUL_CONFLICT, PRODUCT_NOT_FOUND), 003 edit wrappers (EDIT_CONFLICT), split SHIFT_CLOSED", async () => {
    for (const db of [left, right]) await invoices(db, 1);
    const { billing } = repos();
    const invoice = async (db: Db) => one<{ id: string; edit_version: number }>(db, `SELECT id, edit_version FROM public.invoices`);
    const edit = (name: "editItemsAtomic" | "editEmittedAtomic", version: number) => same(billing, async (repo, db) => {
      const row = await invoice(db);
      return repo[name]({ invoiceId: row.id, userId: USER, expectedVersion: version, expectedStatus: "Emitida", edit: { items_remove: [], items_update: [], items_insert: [], payments: [], movements: [] } });
    });
    expect((await edit("editItemsAtomic", 99)).error).toMatchObject({ message: "EDIT_CONFLICT" });
    expect((await edit("editItemsAtomic", 0)).data).toMatchObject({ items: 0, movements: 0 });
    const annul = (expectedStatus: string, items: unknown[] = []) => same(billing, async (repo, db) =>
      repo.annulInvoiceAtomic({ invoiceId: (await invoice(db)).id, userId: USER, closedAt: "2026-10-10T12:00:00-05:00", motivo: "Error", expectedStatus, items }));
    expect((await annul("Pagada")).error).toMatchObject({ message: "ANNUL_CONFLICT" });
    expect((await annul("Emitida", [{ product_id: randomUUID(), qty: 1, reason: "r" }])).error).toMatchObject({ message: "PRODUCT_NOT_FOUND" });
    expect((await annul("Emitida")).data).toMatchObject({ status: "Anulada", cancel_reason: "Error" });
    const closedSplit = await same(billing, async (repo, db) => {
      const row = await invoice(db);
      return repo.splitPaymentAtomic({ invoiceId: row.id, shiftId: OLD_SHIFT, userId: USER, closedAt: "2026-10-10T12:00:00-05:00", markPaid: false, portions: [{ method_id: null, method_code: "efectivo", amount: 1, fee_percent: 0, fee_amount: 0, cash_shift_id: OLD_SHIFT, idempotency_key: null }] });
    });
    expect(closedSplit.error?.message).toContain("SHIFT_CLOSED");
  });
});
