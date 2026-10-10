/**
 * Direct PostgreSQL adapter of the cash port (`./cash.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * - Same filters, the same total orders and the same `range` windows as the
 *   supabase-js adapter; numeric as number, timestamptz in PostgREST text.
 * - Results keep `{ data, error }` with only the normalized SQLSTATE/message/
 *   details; `single()` with no row is PGRST116.
 * - The four monetary writes run as `SELECT public.cash_*(...)` with the exact
 *   argument order and casts of their 001/003 signatures (uuid, numeric,
 *   timestamptz, boolean, jsonb). The 003 wrappers, triggers and locks stay the
 *   authority; `cash_shift_method_expected_balance` returns numeric text and is
 *   normalized to a number like the JSON PostgREST sends.
 * - Requires 001-004: voucher method/shift columns always exist (no probe).
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { toDbError } from "@/src/shared/db/errors";
import { callRpc } from "@/src/shared/db/rpc";
import {
  cashDenominations,
  cashRegisters,
  cashShiftCounts,
  cashShiftMethodBalances,
  cashShiftRecounts,
  cashShifts,
  commissionPayouts,
  invoicePayments,
  invoices,
  payments,
  users,
  voucherRequests,
} from "@/src/shared/db/schema";
import { withPostgrestTimestamps } from "@/src/shared/db/timestamps";
import type { CashCount, CashPage, CashRepo, CashResult, CloseShiftArgs, DenominationWrite, DrawerPaymentWrite, InvoicePaymentArgs, MirrorLookup, OpenShiftArgs, RecountShiftArgs } from "./cash";

const NO_ROWS = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "0 rows" };
const SHIFT = {
  id: cashShifts.id, cash_register_id: cashShifts.cashRegisterId, opened_by: cashShifts.openedBy, closed_by: cashShifts.closedBy,
  opened_at: cashShifts.openedAt, closed_at: cashShifts.closedAt, opening_base: cashShifts.openingBase, expected_cash: cashShifts.expectedCash,
  counted_cash: cashShifts.countedCash, base_left: cashShifts.baseLeft, cash_withdrawn: cashShifts.cashWithdrawn,
  base_difference: cashShifts.baseDifference, status: cashShifts.status, observation: cashShifts.observation,
};
const REGISTER = { id: cashRegisters.id, name: cashRegisters.name, base_configurada: cashRegisters.baseConfigurada, is_active: cashRegisters.isActive };
const DENOMINATION = { id: cashDenominations.id, kind: cashDenominations.kind, value: cashDenominations.value, is_active: cashDenominations.isActive };
const PAYMENT = { id: payments.id, cash_shift_id: payments.cashShiftId, invoice_id: payments.invoiceId, method_id: payments.methodId, method_code: payments.methodCode, amount: payments.amount, user_id: payments.userId, created_at: payments.createdAt };
const RECOUNT = {
  id: cashShiftRecounts.id, shift_id: cashShiftRecounts.shiftId, previous_counted_cash: cashShiftRecounts.previousCountedCash,
  previous_base_left: cashShiftRecounts.previousBaseLeft, previous_cash_withdrawn: cashShiftRecounts.previousCashWithdrawn,
  previous_base_difference: cashShiftRecounts.previousBaseDifference, counted_cash: cashShiftRecounts.countedCash,
  base_left: cashShiftRecounts.baseLeft, cash_withdrawn: cashShiftRecounts.cashWithdrawn, base_difference: cashShiftRecounts.baseDifference,
  reason: cashShiftRecounts.reason, recounted_by: cashShiftRecounts.recountedBy, recounted_at: cashShiftRecounts.recountedAt,
};

function normalize<T extends Record<string, unknown>>(value: T): T {
  return withPostgrestTimestamps(value, (["opened_at", "closed_at", "created_at", "recounted_at"] as const).filter((field) => field in value));
}
async function query<T>(run: () => Promise<T>): Promise<CashResult<T>> {
  try { return { data: await run(), error: null }; } catch (error) { return { data: null, error: toDbError(error) }; }
}
const many = <T>(run: () => Promise<Record<string, unknown>[]>) =>
  query(async () => (await run()).map(normalize) as T[]);
const maybe = <T>(run: () => Promise<Record<string, unknown>[]>) =>
  query(async () => { const [value] = await run(); return value ? normalize(value) as T : null; }) as Promise<CashResult<T>>;
async function single<T>(run: () => Promise<Record<string, unknown>[]>): Promise<CashResult<T>> {
  const outcome = await many<T>(run);
  if (outcome.error) return { data: null, error: outcome.error };
  return outcome.data?.length === 1 ? { data: outcome.data[0], error: null } : { data: null, error: NO_ROWS };
}
const window = (from: number, to: number) => ({ offset: from, limit: to - from + 1 });
function page<T>(run: (offset: number, limit: number) => Promise<Record<string, unknown>[]>, from: number, to: number): CashPage<T> {
  const { offset, limit } = window(from, to);
  return many<T>(() => run(offset, limit)) as unknown as CashPage<T>;
}
function rpc<T>(db: Database, fn: string, args: Parameters<typeof callRpc>[2]) { return query(() => callRpc<T>(db, fn, args)); }

export function drizzleCashRepo(db: Database): CashRepo {
  return {
    listActiveDenominations: () => many(() => db.select(DENOMINATION).from(cashDenominations).where(eq(cashDenominations.isActive, true)).orderBy(desc(cashDenominations.value))),
    upsertDenomination: (write: DenominationWrite) =>
      single(() => db.insert(cashDenominations).values({ ...(write.id ? { id: write.id } : {}), kind: write.kind, value: write.value, ...(write.is_active !== undefined ? { isActive: write.is_active } : {}) }).onConflictDoUpdate({ target: cashDenominations.id, set: { kind: write.kind, value: write.value, ...(write.is_active !== undefined ? { isActive: write.is_active } : {}) } }).returning(DENOMINATION)),
    deleteDenomination: (id) => query(async () => { await db.delete(cashDenominations).where(eq(cashDenominations.id, id)); return null; }),
    listRegisters: () => many(() => db.select(REGISTER).from(cashRegisters).orderBy(asc(cashRegisters.createdAt), asc(cashRegisters.id))),
    getRegister: (id) => maybe(() => db.select(REGISTER).from(cashRegisters).where(eq(cashRegisters.id, id)).limit(1)),
    firstActiveRegister: () => maybe(() => db.select(REGISTER).from(cashRegisters).where(eq(cashRegisters.isActive, true)).orderBy(asc(cashRegisters.createdAt), asc(cashRegisters.id)).limit(1)),
    ensureDefaultRegister: (write) => single(() => db.insert(cashRegisters).values({ name: write.name, baseConfigurada: write.base_configurada }).returning(REGISTER)),
    updateRegisterBase: (id, base) => single(() => db.update(cashRegisters).set({ baseConfigurada: base }).where(eq(cashRegisters.id, id)).returning(REGISTER)),
    getOpenShift: () => maybe(() => db.select(SHIFT).from(cashShifts).where(eq(cashShifts.status, "abierto")).orderBy(desc(cashShifts.openedAt), desc(cashShifts.id)).limit(1)),
    getShift: (id) => maybe(() => db.select(SHIFT).from(cashShifts).where(eq(cashShifts.id, id)).limit(1)),
    openShiftIdsForRegister: (registerId) => many(() => db.select({ id: cashShifts.id }).from(cashShifts).where(and(eq(cashShifts.cashRegisterId, registerId), eq(cashShifts.status, "abierto"))).limit(1)),
    lastClosedShiftForRegister: (registerId) => maybe(() => db.select({ id: cashShifts.id, base_left: cashShifts.baseLeft }).from(cashShifts).where(and(eq(cashShifts.cashRegisterId, registerId), eq(cashShifts.status, "cerrado"))).orderBy(desc(cashShifts.closedAt), desc(cashShifts.openedAt), desc(cashShifts.id)).limit(1)),
    listShiftCounts: (shiftId, phase) => many(() => db.select({ method_code: cashShiftCounts.methodCode, amount: cashShiftCounts.amount }).from(cashShiftCounts).where(and(eq(cashShiftCounts.shiftId, shiftId), eq(cashShiftCounts.phase, phase))).orderBy(asc(cashShiftCounts.id))),
    findRecountId: (shiftId) => maybe(() => db.select({ id: cashShiftRecounts.id }).from(cashShiftRecounts).where(eq(cashShiftRecounts.shiftId, shiftId)).limit(1)),
    userFullName: (id) => maybe(() => db.select({ full_name: users.fullName }).from(users).where(eq(users.id, id)).limit(1)),
    userNames: (ids) => many(() => db.select({ id: users.id, full_name: users.fullName }).from(users).where(inArray(users.id, ids))),
    findPaymentByIdempotency: (shiftId, key) => maybe(() => db.select(PAYMENT).from(payments).where(and(eq(payments.cashShiftId, shiftId), eq(payments.idempotencyKey, key))).limit(1)),
    insertPaymentWithoutInvoice: (write: DrawerPaymentWrite) => single(() => db.insert(payments).values({ cashShiftId: write.cash_shift_id, invoiceId: null, methodId: write.method_id, methodCode: write.method_code, amount: write.amount, userId: write.user_id, idempotencyKey: write.idempotency_key }).returning(PAYMENT)),
    findInvoicePaymentByIdempotency: (invoiceId, key) => many(() => db.select({ id: invoicePayments.id, invoice_id: invoicePayments.invoiceId, method_id: invoicePayments.methodId, method_code: invoicePayments.methodCode, amount: invoicePayments.amount, fee_percent: invoicePayments.feePercent, fee_amount: invoicePayments.feeAmount, cash_shift_id: invoicePayments.cashShiftId, created_at: invoicePayments.createdAt, idempotency_key: invoicePayments.idempotencyKey }).from(invoicePayments).where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.idempotencyKey, key)))),
    findInvoicePaymentMirror: ({ invoiceId, shiftId, methodCode, amount }: MirrorLookup) => maybe(() => db.select(PAYMENT).from(payments).where(and(eq(payments.invoiceId, invoiceId), eq(payments.cashShiftId, shiftId), eq(payments.methodCode, methodCode), eq(payments.amount, amount))).orderBy(asc(payments.id)).limit(1)),
    methodBalance: (shiftId, methodCode) => maybe(() => db.select({ opening_base: cashShiftMethodBalances.openingBase }).from(cashShiftMethodBalances).where(and(eq(cashShiftMethodBalances.cashShiftId, shiftId), eq(cashShiftMethodBalances.methodCode, methodCode))).limit(1)),
    listShiftMethodBalances: (shiftId) => many(() => db.select({ method_code: cashShiftMethodBalances.methodCode, opening_base: cashShiftMethodBalances.openingBase }).from(cashShiftMethodBalances).where(eq(cashShiftMethodBalances.cashShiftId, shiftId)).orderBy(asc(cashShiftMethodBalances.methodCode))),
    expectedMethodBalance: async (shiftId, methodCode) => { const outcome = await rpc<number | string>(db, "cash_shift_method_expected_balance", [{ value: shiftId, cast: "uuid" }, { value: methodCode, cast: "text" }]); return outcome.data === null ? outcome as CashResult<number> : { data: Number(outcome.data), error: null }; },
    voucherOutColumns: async () => true,
    shiftCountsPage: (ids, from, to) => page((offset, limit) => db.select({ shift_id: cashShiftCounts.shiftId, phase: cashShiftCounts.phase, method_code: cashShiftCounts.methodCode, amount: cashShiftCounts.amount }).from(cashShiftCounts).where(inArray(cashShiftCounts.shiftId, ids)).orderBy(asc(cashShiftCounts.id)).offset(offset).limit(limit), from, to),
    payoutsByShiftsPage: (ids, from, to) => page((offset, limit) => db.select({ cash_shift_id: commissionPayouts.cashShiftId, method_code: commissionPayouts.methodCode, amount: commissionPayouts.amount }).from(commissionPayouts).where(inArray(commissionPayouts.cashShiftId, ids)).orderBy(asc(commissionPayouts.id)).offset(offset).limit(limit), from, to),
    vouchersByShiftsPage: (ids, from, to) => page((offset, limit) => db.select({ cash_shift_id: voucherRequests.cashShiftId, approved_by: voucherRequests.approvedBy, status: voucherRequests.status, method_code: voucherRequests.methodCode, amount: voucherRequests.amount }).from(voucherRequests).where(inArray(voucherRequests.cashShiftId, ids)).orderBy(asc(voucherRequests.id)).offset(offset).limit(limit), from, to),
    invoicePaymentsByShiftsPage: (ids, from, to) => page((offset, limit) => db.select({ invoice_id: invoicePayments.invoiceId, cash_shift_id: invoicePayments.cashShiftId, method_code: invoicePayments.methodCode, amount: invoicePayments.amount }).from(invoicePayments).where(inArray(invoicePayments.cashShiftId, ids)).orderBy(asc(invoicePayments.id)).offset(offset).limit(limit), from, to),
    invoicesByShiftsPage: (ids, from, to) => page((offset, limit) => db.select({ id: invoices.id, cash_shift_id: invoices.cashShiftId }).from(invoices).where(inArray(invoices.cashShiftId, ids)).orderBy(asc(invoices.id)).offset(offset).limit(limit), from, to),
    historicInvoicePaymentsPage: (ids, from, to) => page((offset, limit) => db.select({ invoice_id: invoicePayments.invoiceId, method_code: invoicePayments.methodCode, amount: invoicePayments.amount }).from(invoicePayments).where(and(inArray(invoicePayments.invoiceId, ids), isNull(invoicePayments.cashShiftId))).orderBy(asc(invoicePayments.id)).offset(offset).limit(limit), from, to),
    recountsPage: (ids, from, to) => page((offset, limit) => db.select(RECOUNT).from(cashShiftRecounts).where(inArray(cashShiftRecounts.shiftId, ids)).orderBy(asc(cashShiftRecounts.id)).offset(offset).limit(limit), from, to),
    drawerPaymentsPage: (shiftId, from, to) => page((offset, limit) => db.select({ amount: payments.amount, method_code: payments.methodCode }).from(payments).where(and(eq(payments.cashShiftId, shiftId), isNull(payments.invoiceId))).orderBy(asc(payments.id)).offset(offset).limit(limit), from, to),
    shiftPayoutsPage: (shiftId, from, to) => page((offset, limit) => db.select({ method_code: commissionPayouts.methodCode, amount: commissionPayouts.amount }).from(commissionPayouts).where(eq(commissionPayouts.cashShiftId, shiftId)).orderBy(asc(commissionPayouts.id)).offset(offset).limit(limit), from, to),
    drawerPaymentsByShiftsPage: (ids, from, to) => page((offset, limit) => db.select({ cash_shift_id: payments.cashShiftId, amount: payments.amount, method_code: payments.methodCode }).from(payments).where(and(inArray(payments.cashShiftId, ids), isNull(payments.invoiceId))).orderBy(asc(payments.id)).offset(offset).limit(limit), from, to),
    openShiftAtomic: ({ registerId, openedBy, openingBase, counts }: OpenShiftArgs) => rpc(db, "cash_open_shift_atomic", [{ value: registerId, cast: "uuid" }, { value: openedBy, cast: "uuid" }, { value: openingBase, cast: "numeric" }, { value: counts, cast: "jsonb" }]),
    closeShiftAtomic: ({ shiftId, closedBy, closedAt, close, counts, collectionCounts }: CloseShiftArgs) => rpc(db, "cash_close_shift_atomic", [{ value: shiftId, cast: "uuid" }, { value: closedBy, cast: "uuid" }, { value: closedAt, cast: "timestamptz" }, { value: close, cast: "jsonb" }, { value: counts, cast: "jsonb" }, { value: collectionCounts, cast: "jsonb" }]),
    recountShiftAtomic: ({ shiftId, recountedBy, recount, counts }: RecountShiftArgs) => rpc(db, "cash_recount_shift_atomic", [{ value: shiftId, cast: "uuid" }, { value: recountedBy, cast: "uuid" }, { value: recount, cast: "jsonb" }, { value: counts, cast: "jsonb" }]),
    invoicePaymentAtomic: ({ shiftId, invoiceId, userId, closedAt, setShift, markPaid, collection }: InvoicePaymentArgs) => rpc(db, "cash_invoice_payment_atomic", [{ value: shiftId, cast: "uuid" }, { value: invoiceId, cast: "uuid" }, { value: userId, cast: "uuid" }, { value: closedAt, cast: "timestamptz" }, { value: setShift, cast: "boolean" }, { value: markPaid, cast: "boolean" }, { value: collection, cast: "jsonb" }]),
    dayShifts: (from, to) => many(() => db.select(SHIFT).from(cashShifts).where(and(gte(cashShifts.openedAt, from), lte(cashShifts.openedAt, to))).orderBy(asc(cashShifts.openedAt), asc(cashShifts.id)).limit(50)),
    historyCount: async (from, to): Promise<CashCount> => { try { const [value] = await db.select({ total: count() }).from(cashShifts).where(and(gte(cashShifts.openedAt, from), lte(cashShifts.openedAt, to))); return { count: Number(value?.total ?? 0), error: null }; } catch (error) { return { count: null, error: toDbError(error) }; } },
    historyPage: (from, to, offset, limit) => many(() => db.select(SHIFT).from(cashShifts).where(and(gte(cashShifts.openedAt, from), lte(cashShifts.openedAt, to))).orderBy(desc(cashShifts.openedAt), desc(cashShifts.id)).offset(offset).limit(limit)),
  };
}
