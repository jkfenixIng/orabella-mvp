/**
 * Payroll data port, its supabase-js adapter and the engine selector.
 *
 * Every method returns the `{ data, error }` result the service already reads
 * from PostgREST, so business decisions (`23505`, `23P01`, `P0001`,
 * `PGRST116`, paged-read failures) stay in the service and behave the same on
 * both engines. The direct adapter only exposes normalized `DbError` fields.
 *
 * DB_ENGINE=postgres requires migrations 001-004: the voucher columns
 * `method_code`, `cash_shift_id`, `created_by` and the 003 cash triggers are
 * always present there, so only the supabase adapter probes for them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import type { PagedResponse } from "@/src/shared/lib/paged";

export type PayrollDbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };
export type PayrollResult<T> = { data: T | null; error: PayrollDbError | null };
export type PayrollPage<T> = Promise<PagedResponse<T>>;
type Row = Record<string, unknown>;

export interface VoucherFilters {
  status?: string;
  employee_id?: string;
  request_date?: string;
  date_from?: string;
  date_to?: string;
}

export interface PayrollRepo {
  earliestInvoice(): Promise<PayrollResult<{ status: string | null; created_at: string | null }>>;
  insertPeriod<T>(row: { start_date: string; end_date: string; frequency: string; status: string; created_by: string }): Promise<PayrollResult<T>>;
  periodsPage<T>(from: number, to: number): PayrollPage<T>;
  findPeriod<T>(id: string): Promise<PayrollResult<T>>;
  closePeriod<T>(id: string, closedAt: string): Promise<PayrollResult<T>>;
  overlappingPeriods(id: string, start: string, end: string): Promise<PayrollResult<Array<{ id: string; status: string; start_date: string; end_date: string; frequency: string | null }>>>;
  periodEndsPage<T>(ids: string[], from: number, to: number): PayrollPage<T>;
  periodItemsPage<T>(periodId: string, from: number, to: number): PayrollPage<T>;
  employeeItemDetailPage<T>(periodId: string, employeeId: string, from: number, to: number): PayrollPage<T>;
  itemsOfPeriodsPage<T>(periodIds: string[], employeeId: string | undefined, from: number, to: number): PayrollPage<T>;
  findItem<T>(id: string): Promise<PayrollResult<T>>;
  paymentAmountsPage<T>(itemIds: string[], from: number, to: number): PayrollPage<T>;
  paymentDetailsPage<T>(itemIds: string[], from: number, to: number): PayrollPage<T>;
  paymentAmounts(itemId: string): Promise<PayrollResult<Array<{ amount: number | string }>>>;
  paymentsByKey<T>(itemId: string, key: string): Promise<PayrollResult<T[]>>;
  insertPayments<T>(rows: Row[]): Promise<PayrollResult<T[]>>;
  extrasPage<T>(filters: { employeeId?: string; from?: string; to?: string }, from: number, to: number): PayrollPage<T>;
  findExtraByKey<T>(employeeId: string, key: string): Promise<PayrollResult<T>>;
  insertExtra<T>(row: Row): Promise<PayrollResult<T>>;
  pendingDebtOfPeriodPage<T>(periodId: string, from: number, to: number): PayrollPage<T>;
  pendingCarriesPage<T>(from: number, to: number): PayrollPage<T>;
  appliedCarriesPage<T>(periodId: string, from: number, to: number): PayrollPage<T>;
  paidInvoicesPage<T>(fromInstant: string, toInstant: string, from: number, to: number): PayrollPage<T>;
  invoiceItemsPage<T>(invoiceIds: string[], from: number, to: number): PayrollPage<T>;
  activeRulesPage<T>(employeeIds: string[], from: number, to: number): PayrollPage<T>;
  payoutsPage<T>(invoiceIds: string[], from: number, to: number): PayrollPage<T>;
  periodVouchersPage<T>(statuses: string[], start: string, end: string, from: number, to: number): PayrollPage<T>;
  employeeVouchersPage<T>(employeeId: string, statuses: string[], start: string, end: string, from: number, to: number): PayrollPage<T>;
  employeeVoucherIdsPage<T>(employeeId: string, statuses: string[], start: string, end: string, from: number, to: number): PayrollPage<T>;
  discountedVouchers(start: string, end: string): Promise<PayrollResult<Array<{ id: string; approved_by: string | null }>>>;
  findCorrectionId(periodId: string): Promise<PayrollResult<{ id: string }>>;
  findCorrection<T>(periodId: string): Promise<PayrollResult<T>>;
  correctionItemsPage<T>(correctionId: string, from: number, to: number): PayrollPage<T>;
  settings(keys: string[]): Promise<PayrollResult<Array<{ key: string; value: unknown }>>>;
  upsertSettings(rows: Array<{ key: string; value: unknown }>): Promise<PayrollResult<Array<{ key: string; value: unknown }>>>;
  voucherColumns(): Promise<{ method: boolean; createdBy: boolean }>;
  voucherByKey(employeeId: string, key: string): Promise<PayrollResult<Row>>;
  insertVoucher(row: Row): Promise<PayrollResult<Row>>;
  listVouchers(filters: VoucherFilters, limit: number): Promise<PayrollResult<Row[]>>;
  findVoucher(id: string): Promise<PayrollResult<Row>>;
  reviewVoucher(id: string, expectedStatus: string, patch: Row): Promise<PayrollResult<Row>>;
  vigenteVouchersPage<T>(employeeId: string, start: string, end: string, from: number, to: number): PayrollPage<T>;
  userNames(ids: string[]): Promise<PayrollResult<Array<{ id: string; full_name: string | null }>>>;
  applyAtomic(periodId: string, items: unknown[], vouchers: string[], carries: string[]): Promise<PayrollResult<unknown>>;
  deleteAtomic(periodId: string, toApproved: string[], toPending: string[]): Promise<PayrollResult<unknown>>;
  correctAtomic(periodId: string, correction: unknown, items: unknown[]): Promise<PayrollResult<unknown>>;
}

export const PERIOD_SELECT = "id, start_date, end_date, frequency, status, created_by, closed_at, created_at";
export const ITEM_SELECT =
  "id, period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay, detail_json, voucher_total, adjustment_reason, created_at";
export const PAYMENT_SELECT = "id, payroll_item_id, method_id, method_code, amount, paid_at, paid_by, reference";
export const EXTRA_SELECT =
  "id, employee_id, amount, method_id, method_code, reference, reason, kind, days_from, days_to, paid_by, paid_at, created_at";
const CORRECTION_SELECT =
  "id, period_id, previous_net_total, previous_paid_total, corrected_net_total, previous_item_count, corrected_item_count, reason, corrected_by, corrected_at";
const CORRECTION_ITEM_SELECT =
  "id, correction_id, employee_id, previous_base_fixed, previous_commissions, previous_bonuses, previous_deductions_vales, previous_other_discounts, previous_net_pay, previous_paid, corrected_base_fixed, corrected_commissions, corrected_bonuses, corrected_deductions_vales, corrected_other_discounts, corrected_net_pay";
const VOUCHER_SELECT_BASE = "id, employee_id, amount, request_date, status, approved_by, approval_code, observation";
const INVOICE_ITEM_SELECT =
  "id, invoice_id, item_type, employee_id, qty, unit_price, subtotal, no_commission, commission_value, commission_percent_override, product_id, service_id";

// 028/029 may be missing in an old Supabase database: each probe is cached on
// its own and only a "column absent" error is cached.
let voucherMethodColumns: boolean | null = null;
let voucherCreatedByColumn: boolean | null = null;

async function probe(db: SupabaseClient, columns: string, pattern: RegExp): Promise<boolean | null> {
  const { error } = await db.from("voucher_requests").select(columns).limit(1);
  if (!error) return true;
  return pattern.test(String((error as { message?: string }).message ?? "")) ? false : null;
}

async function voucherSelect(db: SupabaseClient): Promise<string> {
  if (voucherMethodColumns === null) voucherMethodColumns = await probe(db, "method_code, cash_shift_id", /method_code|cash_shift_id/i);
  if (voucherCreatedByColumn === null) voucherCreatedByColumn = await probe(db, "created_by", /created_by/i);
  return [
    VOUCHER_SELECT_BASE,
    ...(voucherMethodColumns !== false ? ["method_code, cash_shift_id"] : []),
    ...(voucherCreatedByColumn !== false ? ["created_by"] : []),
  ].join(", ");
}

const page = <T>(query: PromiseLike<unknown>) => query as unknown as PayrollPage<T>;
const result = <T>(query: PromiseLike<unknown>) => query as unknown as Promise<PayrollResult<T>>;

export function supabasePayrollRepo(db: SupabaseClient): PayrollRepo {
  return {
    earliestInvoice: () =>
      result(db.from("invoices").select("status, created_at").neq("status", "Anulada").order("created_at", { ascending: true }).limit(1).maybeSingle()),
    insertPeriod: (row) => result(db.from("payroll_periods").insert(row).select(PERIOD_SELECT).single()),
    periodsPage: (from, to) =>
      page(db.from("payroll_periods").select(PERIOD_SELECT).order("start_date", { ascending: false }).order("id").range(from, to)),
    findPeriod: (id) => result(db.from("payroll_periods").select(PERIOD_SELECT).eq("id", id).maybeSingle()),
    closePeriod: (id, closedAt) =>
      result(db.from("payroll_periods").update({ status: "cerrado", closed_at: closedAt }).eq("id", id).select(PERIOD_SELECT).single()),
    overlappingPeriods: (id, start, end) =>
      result(db.from("payroll_periods").select("id, status, start_date, end_date, frequency").neq("id", id).lte("start_date", end).gte("end_date", start)),
    periodEndsPage: (ids, from, to) => page(db.from("payroll_periods").select("id, end_date").in("id", ids).order("id").range(from, to)),
    periodItemsPage: (periodId, from, to) =>
      page(db.from("payroll_items").select(ITEM_SELECT).eq("period_id", periodId).order("created_at").order("id").range(from, to)),
    employeeItemDetailPage: (periodId, employeeId, from, to) =>
      page(db.from("payroll_items").select("detail_json").eq("period_id", periodId).eq("employee_id", employeeId).order("id").range(from, to)),
    itemsOfPeriodsPage: (periodIds, employeeId, from, to) => {
      let query = db.from("payroll_items").select(ITEM_SELECT).in("period_id", periodIds);
      if (employeeId !== undefined) query = query.eq("employee_id", employeeId);
      return page(query.order("id").range(from, to));
    },
    findItem: (id) => result(db.from("payroll_items").select(ITEM_SELECT).eq("id", id).maybeSingle()),
    paymentAmountsPage: (itemIds, from, to) =>
      page(db.from("payroll_payments").select("payroll_item_id, amount").in("payroll_item_id", itemIds).order("id").range(from, to)),
    paymentDetailsPage: (itemIds, from, to) =>
      page(db.from("payroll_payments").select(PAYMENT_SELECT).in("payroll_item_id", itemIds).order("id").range(from, to)),
    paymentAmounts: (itemId) => result(db.from("payroll_payments").select("amount").eq("payroll_item_id", itemId)),
    paymentsByKey: (itemId, key) =>
      result(db.from("payroll_payments").select(`${PAYMENT_SELECT}, idempotency_key`).eq("payroll_item_id", itemId).eq("idempotency_key", key)),
    insertPayments: (rows) => result(db.from("payroll_payments").insert(rows).select(PAYMENT_SELECT)),
    extrasPage: ({ employeeId, from: fromInstant, to: toInstant }, from, to) => {
      let query = db.from("payroll_extras").select(EXTRA_SELECT);
      if (employeeId) query = query.eq("employee_id", employeeId);
      // Explicit -05:00 bounds: the month is Bogotá's calendar, not UTC.
      if (fromInstant) query = query.gte("paid_at", fromInstant);
      if (toInstant) query = query.lte("paid_at", toInstant);
      return page(query.order("paid_at", { ascending: false }).order("id").range(from, to));
    },
    findExtraByKey: (employeeId, key) =>
      result(db.from("payroll_extras").select(EXTRA_SELECT).eq("employee_id", employeeId).eq("idempotency_key", key).limit(1).maybeSingle()),
    insertExtra: (row) => result(db.from("payroll_extras").insert(row).select(EXTRA_SELECT).single()),
    pendingDebtOfPeriodPage: (periodId, from, to) =>
      page(db.from("payroll_discount_carries").select("employee_id, amount").eq("origin_period_id", periodId).is("applied_period_id", null).order("id").range(from, to)),
    pendingCarriesPage: (from, to) =>
      page(db.from("payroll_discount_carries").select("id, employee_id, amount, origin_period_id").is("applied_period_id", null).order("id").range(from, to)),
    appliedCarriesPage: (periodId, from, to) =>
      page(db.from("payroll_discount_carries").select("id, employee_id, amount, origin_period_id").eq("applied_period_id", periodId).order("id").range(from, to)),
    paidInvoicesPage: (fromInstant, toInstant, from, to) =>
      page(db.from("invoices").select("id, consecutive_number").eq("status", "Pagada").gte("created_at", fromInstant).lte("created_at", toInstant).order("id").range(from, to)),
    invoiceItemsPage: (invoiceIds, from, to) =>
      page(db.from("invoice_items").select(INVOICE_ITEM_SELECT).in("invoice_id", invoiceIds).order("id").range(from, to)),
    activeRulesPage: (employeeIds, from, to) =>
      page(db.from("commission_rules").select("employee_id, item_type, item_id, percent, amount").eq("is_active", true).in("employee_id", employeeIds).order("id").range(from, to)),
    payoutsPage: (invoiceIds, from, to) =>
      page(db.from("commission_payouts").select("employee_id, amount").in("invoice_id", invoiceIds).order("id").range(from, to)),
    periodVouchersPage: (statuses, start, end, from, to) =>
      page(db.from("voucher_requests").select("id, employee_id, amount, status").in("status", statuses).gte("request_date", start).lte("request_date", end).order("id").range(from, to)),
    employeeVouchersPage: (employeeId, statuses, start, end, from, to) =>
      page(
        db
          .from("voucher_requests")
          .select("id, request_date, amount, status")
          .eq("employee_id", employeeId)
          .in("status", statuses)
          .gte("request_date", start)
          .lte("request_date", end)
          .order("id")
          .range(from, to),
      ),
    employeeVoucherIdsPage: (employeeId, statuses, start, end, from, to) =>
      page(
        db
          .from("voucher_requests")
          .select("id")
          .eq("employee_id", employeeId)
          .in("status", statuses)
          .gte("request_date", start)
          .lte("request_date", end)
          .order("id")
          .range(from, to),
      ),
    discountedVouchers: (start, end) =>
      result(db.from("voucher_requests").select("id, approved_by").eq("status", "descontada").gte("request_date", start).lte("request_date", end)),
    findCorrectionId: (periodId) => result(db.from("payroll_period_corrections").select("id").eq("period_id", periodId).maybeSingle()),
    findCorrection: (periodId) => result(db.from("payroll_period_corrections").select(CORRECTION_SELECT).eq("period_id", periodId).maybeSingle()),
    correctionItemsPage: (correctionId, from, to) =>
      page(db.from("payroll_period_correction_items").select(CORRECTION_ITEM_SELECT).eq("correction_id", correctionId).order("employee_id").order("id").range(from, to)),
    settings: (keys) => result(db.from("system_settings").select("key, value").in("key", keys)),
    upsertSettings: (rows) => result(db.from("system_settings").upsert(rows, { onConflict: "key" }).select("key, value")),
    async voucherColumns() {
      await voucherSelect(db);
      return { method: voucherMethodColumns !== false, createdBy: voucherCreatedByColumn !== false };
    },
    voucherByKey: async (employeeId, key) =>
      result(db.from("voucher_requests").select(await voucherSelect(db)).eq("employee_id", employeeId).eq("idempotency_key", key).limit(1).maybeSingle()),
    insertVoucher: async (row) => result(db.from("voucher_requests").insert(row).select(await voucherSelect(db)).single()),
    async listVouchers(filters, limit) {
      let query = db.from("voucher_requests").select(await voucherSelect(db)).order("request_date", { ascending: false }).order("id").limit(limit);
      if (filters.status) query = query.eq("status", filters.status);
      if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
      if (filters.request_date) {
        query = query.eq("request_date", filters.request_date);
      } else if (filters.date_from !== undefined && filters.date_from === filters.date_to) {
        query = query.eq("request_date", filters.date_from);
      } else {
        if (filters.date_from !== undefined) query = query.gte("request_date", filters.date_from);
        if (filters.date_to !== undefined) query = query.lte("request_date", filters.date_to);
      }
      return result(query);
    },
    findVoucher: async (id) => result(db.from("voucher_requests").select(await voucherSelect(db)).eq("id", id).maybeSingle()),
    reviewVoucher: async (id, expectedStatus, patch) =>
      result(db.from("voucher_requests").update(patch).eq("id", id).eq("status", expectedStatus).select(await voucherSelect(db)).single()),
    vigenteVouchersPage: (employeeId, start, end, from, to) =>
      page(
        db
          .from("voucher_requests")
          .select("amount, request_date")
          .eq("employee_id", employeeId)
          .in("status", ["pendiente", "aprobada"])
          .gte("request_date", start)
          .lte("request_date", end)
          .order("id")
          .range(from, to),
      ),
    userNames: (ids) => result(db.from("users").select("id, full_name").in("id", ids)),
    applyAtomic: (periodId, items, vouchers, carries) =>
      result(db.rpc("payroll_apply_atomic", { p_period_id: periodId, p_items: items, p_voucher_ids: vouchers, p_carry_ids: carries })),
    deleteAtomic: (periodId, toApproved, toPending) =>
      result(db.rpc("payroll_delete_period_atomic", { p_period_id: periodId, p_to_approved: toApproved, p_to_pending: toPending })),
    correctAtomic: (periodId, correction, items) =>
      result(db.rpc("payroll_correct_period_atomic", { p_period_id: periodId, p_correction: correction, p_items: items })),
  };
}

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function payrollRepo(): Promise<PayrollRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzlePayrollRepo }] = await Promise.all([import("@/src/shared/db/client"), import("./payroll.drizzle")]);
    return drizzlePayrollRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabasePayrollRepo(createAdminClient());
}
