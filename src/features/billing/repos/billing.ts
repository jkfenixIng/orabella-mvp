/**
 * Billing data port, its supabase-js adapter and the engine selector.
 *
 * Methods return the `{ data, error }` / `{ count, error }` results the service
 * already read from PostgREST, so its error mapping, idempotency relookups and
 * paged-read contracts (READ_INCOMPLETE) stay in `../service.ts` and behave the
 * same on both engines. Totals, taxes, fees, stock plans, payload construction,
 * authorization and domain errors stay in the service; the five monetary writes
 * stay PostgreSQL functions. One operation uses ONE repository.
 *
 * Embeds are part of the contract: list rows carry `users: { full_name } | null`
 * (`users!invoices_user_id_fkey`), detail items carry `employees: { full_name,
 * employee_code, commission_percent, pay_type, payout_mode }` with INNER
 * semantics (`employees!inner`). The direct adapter rebuilds both with explicit
 * joins.
 *
 * Intentional total orders (both engines): detail items (created_at, id),
 * detail payments (created_at, id). Invoice lists keep consecutive_number DESC
 * (unique); the employee path adds id DESC as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import type { PagedResponse } from "@/src/shared/lib/paged";

export type BillingDbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };
export type BillingResult<T> = { data: T | null; error: BillingDbError | null };
export type BillingCount = { count: number | null; error: BillingDbError | null };
export type BillingPage<T> = Promise<PagedResponse<T>>;

/** Server-side filters of the invoice list (date bounds already resolved). */
export interface InvoiceQueryFilters {
  status?: string;
  from?: string;
  to?: string;
  user_id?: string;
  closed_by?: string;
  consecutive_number?: number;
}

export interface CreateInvoiceArgs {
  userId: string;
  cashShiftId: string | null;
  idempotencyKey: string;
  invoice: unknown;
  items: unknown;
  taxes: unknown;
  payments: unknown;
  outReason: string;
  outItems: unknown;
}
export interface AnnulInvoiceArgs { invoiceId: string; userId: string; closedAt: string; motivo: string; expectedStatus: string; items: unknown }
export interface EditInvoiceArgs { invoiceId: string; userId: string; expectedVersion: number; expectedStatus: string; edit: unknown }
export interface SplitPaymentArgs { invoiceId: string; shiftId: string; userId: string; closedAt: string; markPaid: boolean; portions: unknown }

export interface BillingRepo {
  listInvoices<T>(filters: InvoiceQueryFilters, window: { offset: number; limit: number }): Promise<BillingResult<T[]>>;
  /** One page of the invoices whose id is in `ids` (employee filter path), consecutive DESC, id DESC. */
  invoicesByIdsPage<T>(filters: InvoiceQueryFilters, ids: string[], from: number, to: number): BillingPage<T>;
  countInvoices(filters: InvoiceQueryFilters, ids?: string[]): Promise<BillingCount>;
  invoiceIdsForEmployeePage(employeeId: string, from: number, to: number): BillingPage<{ invoice_id: string }>;
  listItemEmployeesPage(invoiceIds: string[], from: number, to: number): BillingPage<{ invoice_id: string; employee_id: string }>;
  getInvoice<T>(id: string): Promise<BillingResult<T>>;
  listInvoiceItemsWithEmployee<T>(invoiceId: string): Promise<BillingResult<T[]>>;
  listInvoiceTaxes<T>(invoiceId: string): Promise<BillingResult<T[]>>;
  listInvoicePayments<T>(invoiceId: string): Promise<BillingResult<T[]>>;
  employeeRulesPage<T>(employeeIds: string[], from: number, to: number): BillingPage<T>;
  employeesByIds(ids: string[]): Promise<BillingResult<Array<{ id: string; user_id: string | null; full_name: string }>>>;
  userNames(ids: string[]): Promise<BillingResult<Array<{ id: string; full_name: string }>>>;
  findInvoiceByIdempotencyKey<T>(key: string): Promise<BillingResult<T>>;
  findInvoicePaymentsByIdempotency<T>(invoiceId: string, key: string): Promise<BillingResult<T[]>>;
  closedPayrollPeriodsPage(from: number, to: number): BillingPage<{ id: string }>;
  payrollItemDetailsPage(periodIds: string[], from: number, to: number): BillingPage<{ detail_json: unknown }>;
  createInvoiceAtomic<T>(args: CreateInvoiceArgs): Promise<BillingResult<T>>;
  annulInvoiceAtomic<T>(args: AnnulInvoiceArgs): Promise<BillingResult<T>>;
  editItemsAtomic<T>(args: EditInvoiceArgs): Promise<BillingResult<T>>;
  editEmittedAtomic<T>(args: EditInvoiceArgs): Promise<BillingResult<T>>;
  splitPaymentAtomic<T>(args: SplitPaymentArgs): Promise<BillingResult<T>>;
}

export const INVOICE_SELECT =
  "id, consecutive_number, client_name, client_document, subtotal, discount, tax, surcharge, total, status, user_id, cash_shift_id, closed_by, closed_at, cancel_reason, created_at, edit_version";
export const ITEM_SELECT =
  "id, invoice_id, item_type, product_id, service_id, custom_name, employee_id, qty, unit_price, discount, subtotal, no_commission, commission_value, commission_mode, commission_percent_override, employees!inner(full_name, employee_code, commission_percent, pay_type, payout_mode)";
export const TAX_SELECT = "id, invoice_id, tax_code, tax_name, percent, amount";
export const PAYMENT_SELECT = "id, invoice_id, method_id, method_code, amount, fee_percent, fee_amount, cash_shift_id, created_at";

const page = <T>(query: PromiseLike<unknown>) => query as unknown as BillingPage<T>;
const result = <T>(query: PromiseLike<unknown>) => query as unknown as Promise<BillingResult<T>>;

/** The filters the service always applied, in the same order. */
interface FilterBuilder {
  eq(column: string, value: unknown): FilterBuilder;
  gte(column: string, value: unknown): FilterBuilder;
  lte(column: string, value: unknown): FilterBuilder;
}
function applyFilters<Q>(query: Q, filters: InvoiceQueryFilters): Q {
  let next = query as unknown as FilterBuilder;
  if (filters.status) next = next.eq("status", filters.status);
  if (filters.from) next = next.gte("created_at", filters.from);
  if (filters.to) next = next.lte("created_at", filters.to);
  if (filters.user_id) next = next.eq("user_id", filters.user_id);
  if (filters.closed_by) next = next.eq("closed_by", filters.closed_by);
  if (filters.consecutive_number !== undefined) next = next.eq("consecutive_number", filters.consecutive_number);
  return next as unknown as Q;
}

export function supabaseBillingRepo(db: SupabaseClient): BillingRepo {
  const listQuery = (filters: InvoiceQueryFilters) =>
    applyFilters(
      db.from("invoices").select(`${INVOICE_SELECT}, users!invoices_user_id_fkey(full_name)`).order("consecutive_number", { ascending: false }),
      filters,
    );
  return {
    listInvoices: (filters, { offset, limit }) => result(listQuery(filters).range(offset, offset + limit - 1)),
    invoicesByIdsPage: (filters, ids, from, to) =>
      page(listQuery(filters).in("id", ids).order("id", { ascending: false }).range(from, to)),
    countInvoices: (filters, ids) => {
      const query = applyFilters(db.from("invoices").select("id", { count: "exact", head: true }), filters);
      return (ids ? query.in("id", ids) : query) as unknown as Promise<BillingCount>;
    },
    invoiceIdsForEmployeePage: (employeeId, from, to) =>
      page(db.from("invoice_items").select("invoice_id").eq("employee_id", employeeId).order("id").range(from, to)),
    listItemEmployeesPage: (invoiceIds, from, to) =>
      page(db.from("invoice_items").select("invoice_id, employee_id").in("invoice_id", invoiceIds).order("created_at").order("id").range(from, to)),
    getInvoice: (id) => result(db.from("invoices").select(INVOICE_SELECT).eq("id", id).maybeSingle()),
    listInvoiceItemsWithEmployee: (invoiceId) =>
      result(db.from("invoice_items").select(ITEM_SELECT).eq("invoice_id", invoiceId).order("created_at").order("id")),
    listInvoiceTaxes: (invoiceId) => result(db.from("invoice_taxes").select(TAX_SELECT).eq("invoice_id", invoiceId).order("tax_code")),
    listInvoicePayments: (invoiceId) =>
      result(db.from("invoice_payments").select(PAYMENT_SELECT).eq("invoice_id", invoiceId).order("created_at").order("id")),
    employeeRulesPage: (employeeIds, from, to) =>
      page(
        db
          .from("commission_rules")
          .select("employee_id, item_type, item_id, percent, amount")
          .eq("is_active", true)
          .in("employee_id", employeeIds)
          .order("id")
          .range(from, to),
      ),
    employeesByIds: (ids) => result(db.from("employees").select("id, user_id, full_name").in("id", ids)),
    userNames: (ids) => result(db.from("users").select("id, full_name").in("id", ids)),
    findInvoiceByIdempotencyKey: (key) => result(db.from("invoices").select(INVOICE_SELECT).eq("idempotency_key", key).maybeSingle()),
    findInvoicePaymentsByIdempotency: (invoiceId, key) =>
      result(db.from("invoice_payments").select(`${PAYMENT_SELECT}, idempotency_key`).eq("invoice_id", invoiceId).eq("idempotency_key", key)),
    closedPayrollPeriodsPage: (from, to) =>
      page(db.from("payroll_periods").select("id").eq("status", "cerrado").order("id").range(from, to)),
    payrollItemDetailsPage: (periodIds, from, to) =>
      page(db.from("payroll_items").select("detail_json").in("period_id", periodIds).order("id").range(from, to)),
    createInvoiceAtomic: (args) =>
      result(
        db.rpc("invoice_create_atomic", {
          p_user_id: args.userId,
          p_cash_shift_id: args.cashShiftId,
          p_idempotency_key: args.idempotencyKey,
          p_invoice: args.invoice,
          p_items: args.items,
          p_taxes: args.taxes,
          p_payments: args.payments,
          p_out_reason: args.outReason,
          p_out_items: args.outItems,
        }),
      ),
    annulInvoiceAtomic: (args) =>
      result(
        db.rpc("invoice_annul_atomic", {
          p_invoice_id: args.invoiceId,
          p_user_id: args.userId,
          p_closed_at: args.closedAt,
          p_motivo: args.motivo,
          p_expected_status: args.expectedStatus,
          p_items: args.items,
        }),
      ),
    editItemsAtomic: (args) =>
      result(
        db.rpc("invoice_edit_items_atomic", {
          p_invoice_id: args.invoiceId,
          p_user_id: args.userId,
          p_expected_version: args.expectedVersion,
          p_expected_status: args.expectedStatus,
          p_edit: args.edit,
        }),
      ),
    editEmittedAtomic: (args) =>
      result(
        db.rpc("invoice_edit_emitted_atomic", {
          p_invoice_id: args.invoiceId,
          p_user_id: args.userId,
          p_expected_version: args.expectedVersion,
          p_expected_status: args.expectedStatus,
          p_edit: args.edit,
        }),
      ),
    splitPaymentAtomic: (args) =>
      result(
        db.rpc("invoice_split_payment_atomic", {
          p_invoice_id: args.invoiceId,
          p_shift_id: args.shiftId,
          p_user_id: args.userId,
          p_closed_at: args.closedAt,
          p_mark_paid: args.markPaid,
          p_portions: args.portions,
        }),
      ),
  };
}

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function billingRepo(): Promise<BillingRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleBillingRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./billing.drizzle"),
    ]);
    return drizzleBillingRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseBillingRepo(createAdminClient());
}
