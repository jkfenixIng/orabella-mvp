/**
 * Direct PostgreSQL adapter of the payroll port (`./payroll.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * Equivalences with the supabase-js adapter:
 * - Results keep PostgREST's `{ data, error }` shape; errors carry only the
 *   normalized SQLSTATE/message/details (never Drizzle's SQL or params).
 * - Same filters and total orders; pages are `offset/limit` windows.
 * - numeric as number, civil dates as `yyyy-mm-dd`, jsonb parsed, timestamptz
 *   in PostgREST text (`T` and `-05:00`).
 * - `single()` with no row is PGRST116, like PostgREST.
 * - Monetary units of work stay in PostgreSQL: `SELECT public.payroll_*(...)`
 *   with uuid / jsonb / uuid[] casts; no engine mixing inside an operation.
 * - Requires migrations 001-004: voucher method/shift/creator columns and the
 *   003 cash triggers always exist, so there is no column probe here.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { toDbError } from "@/src/shared/db/errors";
import { callRpc, type RpcArg } from "@/src/shared/db/rpc";
import {
  commissionPayouts,
  commissionRules,
  invoiceItems,
  invoices,
  payrollDiscountCarries,
  payrollExtras,
  payrollItems,
  payrollPayments,
  payrollPeriodCorrectionItems,
  payrollPeriodCorrections,
  payrollPeriods,
  systemSettings,
  users,
  voucherRequests,
} from "@/src/shared/db/schema";
import { withPostgrestTimestamps } from "@/src/shared/db/timestamps";
import type { PayrollCount, PayrollPage, PayrollPeriodQuery, PayrollRepo, PayrollResult } from "./payroll";

type Row = Record<string, unknown>;
const NO_ROWS = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "0 rows" };

const PERIOD = {
  id: payrollPeriods.id,
  start_date: payrollPeriods.startDate,
  end_date: payrollPeriods.endDate,
  frequency: payrollPeriods.frequency,
  status: payrollPeriods.status,
  created_by: payrollPeriods.createdBy,
  closed_at: payrollPeriods.closedAt,
  created_at: payrollPeriods.createdAt,
};
const ITEM = {
  id: payrollItems.id,
  period_id: payrollItems.periodId,
  employee_id: payrollItems.employeeId,
  base_fixed: payrollItems.baseFixed,
  commissions: payrollItems.commissions,
  bonuses: payrollItems.bonuses,
  deductions_vales: payrollItems.deductionsVales,
  other_discounts: payrollItems.otherDiscounts,
  net_pay: payrollItems.netPay,
  detail_json: payrollItems.detailJson,
  voucher_total: payrollItems.voucherTotal,
  adjustment_reason: payrollItems.adjustmentReason,
  created_at: payrollItems.createdAt,
};
const PAYMENT = {
  id: payrollPayments.id,
  payroll_item_id: payrollPayments.payrollItemId,
  method_id: payrollPayments.methodId,
  method_code: payrollPayments.methodCode,
  amount: payrollPayments.amount,
  paid_at: payrollPayments.paidAt,
  paid_by: payrollPayments.paidBy,
  reference: payrollPayments.reference,
};
const EXTRA = {
  id: payrollExtras.id,
  employee_id: payrollExtras.employeeId,
  amount: payrollExtras.amount,
  method_id: payrollExtras.methodId,
  method_code: payrollExtras.methodCode,
  reference: payrollExtras.reference,
  reason: payrollExtras.reason,
  kind: payrollExtras.kind,
  days_from: payrollExtras.daysFrom,
  days_to: payrollExtras.daysTo,
  paid_by: payrollExtras.paidBy,
  paid_at: payrollExtras.paidAt,
  created_at: payrollExtras.createdAt,
};
const CORRECTION = {
  id: payrollPeriodCorrections.id,
  period_id: payrollPeriodCorrections.periodId,
  previous_net_total: payrollPeriodCorrections.previousNetTotal,
  previous_paid_total: payrollPeriodCorrections.previousPaidTotal,
  corrected_net_total: payrollPeriodCorrections.correctedNetTotal,
  previous_item_count: payrollPeriodCorrections.previousItemCount,
  corrected_item_count: payrollPeriodCorrections.correctedItemCount,
  reason: payrollPeriodCorrections.reason,
  corrected_by: payrollPeriodCorrections.correctedBy,
  corrected_at: payrollPeriodCorrections.correctedAt,
};
const CI = payrollPeriodCorrectionItems;
const CORRECTION_ITEM = {
  id: CI.id,
  correction_id: CI.correctionId,
  employee_id: CI.employeeId,
  previous_base_fixed: CI.previousBaseFixed,
  previous_commissions: CI.previousCommissions,
  previous_bonuses: CI.previousBonuses,
  previous_deductions_vales: CI.previousDeductionsVales,
  previous_other_discounts: CI.previousOtherDiscounts,
  previous_net_pay: CI.previousNetPay,
  previous_paid: CI.previousPaid,
  corrected_base_fixed: CI.correctedBaseFixed,
  corrected_commissions: CI.correctedCommissions,
  corrected_bonuses: CI.correctedBonuses,
  corrected_deductions_vales: CI.correctedDeductionsVales,
  corrected_other_discounts: CI.correctedOtherDiscounts,
  corrected_net_pay: CI.correctedNetPay,
};
const VOUCHER = {
  id: voucherRequests.id,
  employee_id: voucherRequests.employeeId,
  amount: voucherRequests.amount,
  request_date: voucherRequests.requestDate,
  status: voucherRequests.status,
  approved_by: voucherRequests.approvedBy,
  approval_code: voucherRequests.approvalCode,
  observation: voucherRequests.observation,
  method_code: voucherRequests.methodCode,
  cash_shift_id: voucherRequests.cashShiftId,
  created_by: voucherRequests.createdBy,
};
const CARRY = {
  id: payrollDiscountCarries.id,
  employee_id: payrollDiscountCarries.employeeId,
  amount: payrollDiscountCarries.amount,
  origin_period_id: payrollDiscountCarries.originPeriodId,
};

const TIMESTAMPS = ["created_at", "closed_at", "paid_at", "corrected_at"] as const;

/** PostgREST JSON for one row: timestamps in its text form, the rest as read. */
function normalize<T>(row: Row): T {
  const present = TIMESTAMPS.filter((field) => field in row);
  return withPostgrestTimestamps(row, present) as T;
}

async function query<T>(run: () => Promise<T>): Promise<PayrollResult<T>> {
  try {
    return { data: await run(), error: null };
  } catch (error) {
    return { data: null, error: toDbError(error) };
  }
}

const many = <T>(run: () => Promise<Row[]>) =>
  query(async () => (await run()).map((row) => normalize<T>(row))) as Promise<PayrollResult<T[]>>;
const maybe = <T>(run: () => Promise<Row[]>) =>
  query(async () => {
    const [row] = await run();
    return row ? normalize<T>(row) : null;
  }) as Promise<PayrollResult<T>>;
async function single<T>(run: () => Promise<Row[]>): Promise<PayrollResult<T>> {
  const outcome = await many<T>(run);
  if (outcome.error) return { data: null, error: outcome.error };
  return outcome.data?.length === 1 ? { data: outcome.data[0], error: null } : { data: null, error: NO_ROWS };
}
const window = (from: number, to: number) => ({ offset: from, limit: to - from + 1 });

function voucherInsert(row: Row) {
  return {
    employeeId: row.employee_id as string,
    amount: row.amount as number,
    requestDate: row.request_date as string,
    status: row.status as string,
    approvedBy: (row.approved_by as string | null) ?? null,
    observation: (row.observation as string | null) ?? null,
    methodCode: (row.method_code as string | undefined) ?? null,
    cashShiftId: (row.cash_shift_id as string | undefined) ?? null,
    createdBy: (row.created_by as string | undefined) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
  };
}

function voucherPatch(patch: Row) {
  return {
    status: patch.status as string,
    ...("approved_by" in patch ? { approvedBy: patch.approved_by as string | null } : {}),
    ...("observation" in patch ? { observation: patch.observation as string | null } : {}),
  };
}

/** Same predicate as the supabase adapter's `applyPeriodFilters`. */
function periodWhere(filters: PayrollPeriodQuery): SQL | undefined {
  const pattern = filters.term ? `%${filters.term}%` : null;
  return and(
    filters.status ? eq(payrollPeriods.status, filters.status) : undefined,
    filters.frequency === null ? isNull(payrollPeriods.frequency) : filters.frequency ? eq(payrollPeriods.frequency, filters.frequency) : undefined,
    filters.from ? gte(payrollPeriods.startDate, filters.from) : undefined,
    filters.to ? lte(payrollPeriods.startDate, filters.to) : undefined,
    filters.day ? and(lte(payrollPeriods.startDate, filters.day), gte(payrollPeriods.endDate, filters.day)) : undefined,
    pattern ? or(ilike(payrollPeriods.frequency, pattern), ilike(payrollPeriods.status, pattern)) : undefined,
  );
}

function rpc(db: Database, fn: string, args: RpcArg[]) {
  return query(() => callRpc<unknown>(db, fn, args));
}

export function drizzlePayrollRepo(db: Database): PayrollRepo {
  /** One `range(from, to)` window as offset/limit, in the order the query fixes. */
  // The port's page methods are generic over the row type the caller reads.
  function page<T>(run: (offset: number, limit: number) => Promise<Row[]>, from: number, to: number): PayrollPage<T> {
    const { offset, limit } = window(from, to);
    return many<T>(() => run(offset, limit));
  }
  return {
    earliestInvoice: () =>
      maybe(() =>
        db
          .select({ status: invoices.status, created_at: invoices.createdAt })
          .from(invoices)
          .where(ne(invoices.status, "Anulada"))
          .orderBy(asc(invoices.createdAt))
          .limit(1),
      ),
    insertPeriod: (row) =>
      single(() =>
        db
          .insert(payrollPeriods)
          .values({ startDate: row.start_date, endDate: row.end_date, frequency: row.frequency, status: row.status, createdBy: row.created_by })
          .returning(PERIOD),
      ),
    periodsPage: (from, to) =>
      page((offset, limit) => db.select(PERIOD).from(payrollPeriods).orderBy(desc(payrollPeriods.startDate), asc(payrollPeriods.id)).offset(offset).limit(limit), from, to),
    listPeriods: (filters, window) =>
      many(() =>
        db.select(PERIOD).from(payrollPeriods).where(periodWhere(filters)).orderBy(desc(payrollPeriods.startDate), asc(payrollPeriods.id)).offset(window.offset).limit(window.limit),
      ),
    countPeriods: async (filters): Promise<PayrollCount> => {
      try {
        const [value] = await db.select({ total: count() }).from(payrollPeriods).where(periodWhere(filters));
        return { data: null, count: Number(value?.total ?? 0), error: null };
      } catch (error) {
        return { data: null, count: null, error: toDbError(error) };
      }
    },
    findPeriod: (id) => maybe(() => db.select(PERIOD).from(payrollPeriods).where(eq(payrollPeriods.id, id)).limit(1)),
    closePeriod: (id, closedAt) =>
      single(() => db.update(payrollPeriods).set({ status: "cerrado", closedAt }).where(eq(payrollPeriods.id, id)).returning(PERIOD)),
    overlappingPeriods: (id, start, end) =>
      many(() =>
        db
          .select({
            id: payrollPeriods.id,
            status: payrollPeriods.status,
            start_date: payrollPeriods.startDate,
            end_date: payrollPeriods.endDate,
            frequency: payrollPeriods.frequency,
          })
          .from(payrollPeriods)
          .where(and(ne(payrollPeriods.id, id), lte(payrollPeriods.startDate, end), gte(payrollPeriods.endDate, start))),
      ),
    periodEndsPage: (ids, from, to) =>
      page((offset, limit) =>
        db.select({ id: payrollPeriods.id, end_date: payrollPeriods.endDate }).from(payrollPeriods).where(inArray(payrollPeriods.id, ids)).orderBy(asc(payrollPeriods.id)).offset(offset).limit(limit), from, to),
    periodItemsPage: (periodId, from, to) =>
      page((offset, limit) =>
        db.select(ITEM).from(payrollItems).where(eq(payrollItems.periodId, periodId)).orderBy(asc(payrollItems.createdAt), asc(payrollItems.id)).offset(offset).limit(limit), from, to),
    employeeItemDetailPage: (periodId, employeeId, from, to) =>
      page((offset, limit) =>
        db
          .select({ detail_json: payrollItems.detailJson })
          .from(payrollItems)
          .where(and(eq(payrollItems.periodId, periodId), eq(payrollItems.employeeId, employeeId)))
          .orderBy(asc(payrollItems.id))
          .offset(offset)
          .limit(limit), from, to),
    itemsOfPeriodsPage: (periodIds, employeeId, from, to) =>
      page((offset, limit) =>
        db
          .select(ITEM)
          .from(payrollItems)
          .where(and(inArray(payrollItems.periodId, periodIds), employeeId !== undefined ? eq(payrollItems.employeeId, employeeId) : undefined))
          .orderBy(asc(payrollItems.id))
          .offset(offset)
          .limit(limit), from, to),
    findItem: (id) => maybe(() => db.select(ITEM).from(payrollItems).where(eq(payrollItems.id, id)).limit(1)),
    paymentAmountsPage: (itemIds, from, to) =>
      page((offset, limit) =>
        db
          .select({ payroll_item_id: payrollPayments.payrollItemId, amount: payrollPayments.amount })
          .from(payrollPayments)
          .where(inArray(payrollPayments.payrollItemId, itemIds))
          .orderBy(asc(payrollPayments.id))
          .offset(offset)
          .limit(limit), from, to),
    paymentDetailsPage: (itemIds, from, to) =>
      page((offset, limit) =>
        db
          .select(PAYMENT)
          .from(payrollPayments)
          .where(inArray(payrollPayments.payrollItemId, itemIds))
          .orderBy(asc(payrollPayments.id))
          .offset(offset)
          .limit(limit), from, to),
    paymentAmounts: (itemId) =>
      many(() => db.select({ amount: payrollPayments.amount }).from(payrollPayments).where(eq(payrollPayments.payrollItemId, itemId))),
    paymentsByKey: (itemId, key) =>
      many(() =>
        db
          .select({ ...PAYMENT, idempotency_key: payrollPayments.idempotencyKey })
          .from(payrollPayments)
          .where(and(eq(payrollPayments.payrollItemId, itemId), eq(payrollPayments.idempotencyKey, key))),
      ),
    insertPayments: (rows) =>
      many(() =>
        db
          .insert(payrollPayments)
          .values(
            rows.map((row) => ({
              payrollItemId: row.payroll_item_id as string,
              methodId: (row.method_id as string | null) ?? null,
              methodCode: row.method_code as string,
              amount: row.amount as number,
              paidBy: (row.paid_by as string | null) ?? null,
              reference: (row.reference as string | null) ?? null,
              idempotencyKey: (row.idempotency_key as string | null) ?? null,
            })),
          )
          .returning(PAYMENT),
      ),
    extrasPage: ({ employeeId, from: fromInstant, to: toInstant }, from, to) =>
      page((offset, limit) =>
        db
          .select(EXTRA)
          .from(payrollExtras)
          .where(
            and(
              employeeId ? eq(payrollExtras.employeeId, employeeId) : undefined,
              fromInstant ? gte(payrollExtras.paidAt, fromInstant) : undefined,
              toInstant ? lte(payrollExtras.paidAt, toInstant) : undefined,
            ),
          )
          .orderBy(desc(payrollExtras.paidAt), asc(payrollExtras.id))
          .offset(offset)
          .limit(limit), from, to),
    findExtraByKey: (employeeId, key) =>
      maybe(() =>
        db.select(EXTRA).from(payrollExtras).where(and(eq(payrollExtras.employeeId, employeeId), eq(payrollExtras.idempotencyKey, key))).limit(1),
      ),
    insertExtra: (row) =>
      single(() =>
        db
          .insert(payrollExtras)
          .values({
            employeeId: row.employee_id as string,
            amount: row.amount as number,
            methodId: (row.method_id as string | null) ?? null,
            methodCode: row.method_code as string,
            reference: (row.reference as string | null) ?? null,
            reason: row.reason as string,
            kind: row.kind as string,
            daysFrom: (row.days_from as string | null) ?? null,
            daysTo: (row.days_to as string | null) ?? null,
            paidBy: (row.paid_by as string | null) ?? null,
            idempotencyKey: (row.idempotency_key as string | null) ?? null,
          })
          .returning(EXTRA),
      ),
    pendingDebtOfPeriodPage: (periodId, from, to) =>
      page((offset, limit) =>
        db
          .select({ employee_id: payrollDiscountCarries.employeeId, amount: payrollDiscountCarries.amount })
          .from(payrollDiscountCarries)
          .where(and(eq(payrollDiscountCarries.originPeriodId, periodId), isNull(payrollDiscountCarries.appliedPeriodId)))
          .orderBy(asc(payrollDiscountCarries.id))
          .offset(offset)
          .limit(limit), from, to),
    pendingCarriesPage: (from, to) =>
      page((offset, limit) =>
        db.select(CARRY).from(payrollDiscountCarries).where(isNull(payrollDiscountCarries.appliedPeriodId)).orderBy(asc(payrollDiscountCarries.id)).offset(offset).limit(limit), from, to),
    appliedCarriesPage: (periodId, from, to) =>
      page((offset, limit) =>
        db.select(CARRY).from(payrollDiscountCarries).where(eq(payrollDiscountCarries.appliedPeriodId, periodId)).orderBy(asc(payrollDiscountCarries.id)).offset(offset).limit(limit), from, to),
    paidInvoicesPage: (fromInstant, toInstant, from, to) =>
      page((offset, limit) =>
        db
          .select({ id: invoices.id, consecutive_number: invoices.consecutiveNumber })
          .from(invoices)
          .where(and(eq(invoices.status, "Pagada"), gte(invoices.createdAt, fromInstant), lte(invoices.createdAt, toInstant)))
          .orderBy(asc(invoices.id))
          .offset(offset)
          .limit(limit), from, to),
    invoiceItemsPage: (invoiceIds, from, to) =>
      page((offset, limit) =>
        db
          .select({
            id: invoiceItems.id,
            invoice_id: invoiceItems.invoiceId,
            item_type: invoiceItems.itemType,
            employee_id: invoiceItems.employeeId,
            qty: invoiceItems.qty,
            unit_price: invoiceItems.unitPrice,
            subtotal: invoiceItems.subtotal,
            no_commission: invoiceItems.noCommission,
            commission_value: invoiceItems.commissionValue,
            commission_percent_override: invoiceItems.commissionPercentOverride,
            product_id: invoiceItems.productId,
            service_id: invoiceItems.serviceId,
          })
          .from(invoiceItems)
          .where(inArray(invoiceItems.invoiceId, invoiceIds))
          .orderBy(asc(invoiceItems.id))
          .offset(offset)
          .limit(limit), from, to),
    activeRulesPage: (employeeIds, from, to) =>
      page((offset, limit) =>
        db
          .select({
            employee_id: commissionRules.employeeId,
            item_type: commissionRules.itemType,
            item_id: commissionRules.itemId,
            percent: commissionRules.percent,
            amount: commissionRules.amount,
          })
          .from(commissionRules)
          .where(and(eq(commissionRules.isActive, true), inArray(commissionRules.employeeId, employeeIds)))
          .orderBy(asc(commissionRules.id))
          .offset(offset)
          .limit(limit), from, to),
    payoutsPage: (invoiceIds, from, to) =>
      page((offset, limit) =>
        db
          .select({ employee_id: commissionPayouts.employeeId, amount: commissionPayouts.amount })
          .from(commissionPayouts)
          .where(inArray(commissionPayouts.invoiceId, invoiceIds))
          .orderBy(asc(commissionPayouts.id))
          .offset(offset)
          .limit(limit), from, to),
    periodVouchersPage: (statuses, start, end, from, to) =>
      page((offset, limit) =>
        db
          .select({ id: voucherRequests.id, employee_id: voucherRequests.employeeId, amount: voucherRequests.amount, status: voucherRequests.status })
          .from(voucherRequests)
          .where(and(inArray(voucherRequests.status, statuses), gte(voucherRequests.requestDate, start), lte(voucherRequests.requestDate, end)))
          .orderBy(asc(voucherRequests.id))
          .offset(offset)
          .limit(limit), from, to),
    employeeVouchersPage: (employeeId, statuses, start, end, from, to) =>
      page((offset, limit) =>
        db
          .select({ id: voucherRequests.id, request_date: voucherRequests.requestDate, amount: voucherRequests.amount, status: voucherRequests.status })
          .from(voucherRequests)
          .where(
            and(
              eq(voucherRequests.employeeId, employeeId),
              inArray(voucherRequests.status, statuses),
              gte(voucherRequests.requestDate, start),
              lte(voucherRequests.requestDate, end),
            ),
          )
          .orderBy(asc(voucherRequests.id))
          .offset(offset)
          .limit(limit), from, to),
    discountedVouchers: (start, end) =>
      many(() =>
        db
          .select({ id: voucherRequests.id, approved_by: voucherRequests.approvedBy })
          .from(voucherRequests)
          .where(and(eq(voucherRequests.status, "descontada"), gte(voucherRequests.requestDate, start), lte(voucherRequests.requestDate, end))),
      ),
    findCorrectionId: (periodId) =>
      maybe(() => db.select({ id: payrollPeriodCorrections.id }).from(payrollPeriodCorrections).where(eq(payrollPeriodCorrections.periodId, periodId)).limit(1)),
    findCorrection: (periodId) =>
      maybe(() => db.select(CORRECTION).from(payrollPeriodCorrections).where(eq(payrollPeriodCorrections.periodId, periodId)).limit(1)),
    correctionItemsPage: (correctionId, from, to) =>
      page((offset, limit) =>
        db.select(CORRECTION_ITEM).from(CI).where(eq(CI.correctionId, correctionId)).orderBy(asc(CI.employeeId), asc(CI.id)).offset(offset).limit(limit), from, to),
    settings: (keys) =>
      many(() => db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings).where(inArray(systemSettings.key, keys))),
    upsertSettings: (rows) =>
      many(() =>
        db
          .insert(systemSettings)
          .values(rows)
          .onConflictDoUpdate({ target: systemSettings.key, set: { value: sql`excluded.value` as SQL<unknown> } })
          .returning({ key: systemSettings.key, value: systemSettings.value }),
      ),
    voucherColumns: async () => ({ method: true, createdBy: true }),
    voucherByKey: (employeeId, key) =>
      maybe(() =>
        db.select(VOUCHER).from(voucherRequests).where(and(eq(voucherRequests.employeeId, employeeId), eq(voucherRequests.idempotencyKey, key))).limit(1),
      ),
    insertVoucher: (row) => single(() => db.insert(voucherRequests).values(voucherInsert(row)).returning(VOUCHER)),
    listVouchers: (filters, limit) => {
      const exact = filters.request_date ?? (filters.date_from !== undefined && filters.date_from === filters.date_to ? filters.date_from : undefined);
      return many(() =>
        db
          .select(VOUCHER)
          .from(voucherRequests)
          .where(
            and(
              filters.status ? eq(voucherRequests.status, filters.status) : undefined,
              filters.employee_id ? eq(voucherRequests.employeeId, filters.employee_id) : undefined,
              exact !== undefined ? eq(voucherRequests.requestDate, exact) : undefined,
              exact === undefined && filters.date_from !== undefined ? gte(voucherRequests.requestDate, filters.date_from) : undefined,
              exact === undefined && filters.date_to !== undefined ? lte(voucherRequests.requestDate, filters.date_to) : undefined,
            ),
          )
          .orderBy(desc(voucherRequests.requestDate), asc(voucherRequests.id))
          .limit(limit),
      );
    },
    findVoucher: (id) => maybe(() => db.select(VOUCHER).from(voucherRequests).where(eq(voucherRequests.id, id)).limit(1)),
    reviewVoucher: (id, expectedStatus, patch) =>
      single(() =>
        db
          .update(voucherRequests)
          .set(voucherPatch(patch))
          .where(and(eq(voucherRequests.id, id), eq(voucherRequests.status, expectedStatus)))
          .returning(VOUCHER),
      ),
    vigenteVouchersPage: (employeeId, start, end, from, to) =>
      page((offset, limit) =>
        db
          .select({ amount: voucherRequests.amount, request_date: voucherRequests.requestDate })
          .from(voucherRequests)
          .where(
            and(
              eq(voucherRequests.employeeId, employeeId),
              inArray(voucherRequests.status, ["pendiente", "aprobada"]),
              gte(voucherRequests.requestDate, start),
              lte(voucherRequests.requestDate, end),
            ),
          )
          .orderBy(asc(voucherRequests.id))
          .offset(offset)
          .limit(limit), from, to),
    userNames: (ids) => many(() => db.select({ id: users.id, full_name: users.fullName }).from(users).where(inArray(users.id, ids))),
    applyAtomic: (periodId, items, vouchers, carries) =>
      rpc(db, "payroll_apply_atomic", [
        { value: periodId, cast: "uuid" },
        { value: items, cast: "jsonb" },
        { value: vouchers, cast: "uuid[]" },
        { value: carries, cast: "uuid[]" },
      ]),
    deleteAtomic: (periodId, toApproved, toPending) =>
      rpc(db, "payroll_delete_period_atomic", [
        { value: periodId, cast: "uuid" },
        { value: toApproved, cast: "uuid[]" },
        { value: toPending, cast: "uuid[]" },
      ]),
    correctAtomic: (periodId, correction, items) =>
      rpc(db, "payroll_correct_period_atomic", [
        { value: periodId, cast: "uuid" },
        { value: correction, cast: "jsonb" },
        { value: items, cast: "jsonb" },
      ]),
  };
}
