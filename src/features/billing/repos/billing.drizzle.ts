/**
 * Direct PostgreSQL adapter of the billing port (`./billing.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * - `users!invoices_user_id_fkey(full_name)` is a LEFT JOIN that yields the
 *   same `users: { full_name } | null`; `employees!inner(...)` is an INNER JOIN
 *   that yields the same nested `employees` object.
 * - numeric as number, timestamptz in PostgREST text, results as `{ data, error }`
 *   with only the normalized SQLSTATE/message/details.
 * - The five monetary writes run as `SELECT public.invoice_*(...)` with the
 *   exact argument order and casts of their 001/003 signatures.
 */
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { toDbError } from "@/src/shared/db/errors";
import { callRpc } from "@/src/shared/db/rpc";
import { commissionRules, employees, invoiceItems, invoicePayments, invoiceTaxes, invoices, payrollItems, payrollPeriods, users } from "@/src/shared/db/schema";
import { withPostgrestTimestamps } from "@/src/shared/db/timestamps";
import type { AnnulInvoiceArgs, BillingCount, BillingPage, BillingRepo, BillingResult, CreateInvoiceArgs, EditInvoiceArgs, InvoiceQueryFilters, SplitPaymentArgs } from "./billing";

const INVOICE = { id: invoices.id, consecutive_number: invoices.consecutiveNumber, client_name: invoices.clientName, client_document: invoices.clientDocument, subtotal: invoices.subtotal, discount: invoices.discount, tax: invoices.tax, surcharge: invoices.surcharge, total: invoices.total, status: invoices.status, user_id: invoices.userId, cash_shift_id: invoices.cashShiftId, closed_by: invoices.closedBy, closed_at: invoices.closedAt, cancel_reason: invoices.cancelReason, created_at: invoices.createdAt, edit_version: invoices.editVersion };
const TAX = { id: invoiceTaxes.id, invoice_id: invoiceTaxes.invoiceId, tax_code: invoiceTaxes.taxCode, tax_name: invoiceTaxes.taxName, percent: invoiceTaxes.percent, amount: invoiceTaxes.amount };
const PAYMENT = { id: invoicePayments.id, invoice_id: invoicePayments.invoiceId, method_id: invoicePayments.methodId, method_code: invoicePayments.methodCode, amount: invoicePayments.amount, fee_percent: invoicePayments.feePercent, fee_amount: invoicePayments.feeAmount, cash_shift_id: invoicePayments.cashShiftId, created_at: invoicePayments.createdAt };
const ITEM = { id: invoiceItems.id, invoice_id: invoiceItems.invoiceId, item_type: invoiceItems.itemType, product_id: invoiceItems.productId, service_id: invoiceItems.serviceId, custom_name: invoiceItems.customName, employee_id: invoiceItems.employeeId, qty: invoiceItems.qty, unit_price: invoiceItems.unitPrice, discount: invoiceItems.discount, subtotal: invoiceItems.subtotal, no_commission: invoiceItems.noCommission, commission_value: invoiceItems.commissionValue, commission_mode: invoiceItems.commissionMode, commission_percent_override: invoiceItems.commissionPercentOverride };

function normalize<T extends Record<string, unknown>>(value: T): T {
  return withPostgrestTimestamps(value, (["created_at", "closed_at"] as const).filter((field) => field in value));
}
async function query<T>(run: () => Promise<T>): Promise<BillingResult<T>> { try { return { data: await run(), error: null }; } catch (error) { return { data: null, error: toDbError(error) }; } }
const many = <T>(run: () => Promise<Record<string, unknown>[]>) =>
  query(async () => (await run()).map(normalize) as T[]);
const maybe = <T>(run: () => Promise<Record<string, unknown>[]>) => query(async () => { const [value] = await run(); return value ? normalize(value) as T : null; }) as Promise<BillingResult<T>>;
const window = (from: number, to: number) => ({ offset: from, limit: to - from + 1 });
function page<T>(run: (offset: number, limit: number) => Promise<Record<string, unknown>[]>, from: number, to: number): BillingPage<T> { const { offset, limit } = window(from, to); return many<T>(() => run(offset, limit)) as unknown as BillingPage<T>; }
function rpc<T>(db: Database, fn: string, args: Parameters<typeof callRpc>[2]) { return query(() => callRpc<T>(db, fn, args)); }
function where(filters: InvoiceQueryFilters) {
  return and(filters.status ? eq(invoices.status, filters.status) : undefined, filters.from ? gte(invoices.createdAt, filters.from) : undefined, filters.to ? lte(invoices.createdAt, filters.to) : undefined, filters.user_id ? eq(invoices.userId, filters.user_id) : undefined, filters.closed_by ? eq(invoices.closedBy, filters.closed_by) : undefined, filters.consecutive_number !== undefined ? eq(invoices.consecutiveNumber, filters.consecutive_number) : undefined);
}
function invoiceWithUser() { return { ...INVOICE, users: { full_name: users.fullName } }; }

export function drizzleBillingRepo(db: Database): BillingRepo {
  return {
    listInvoices: (filters, window) =>
      many(() => db.select(invoiceWithUser()).from(invoices).leftJoin(users, eq(invoices.userId, users.id)).where(where(filters)).orderBy(desc(invoices.consecutiveNumber)).offset(window.offset).limit(window.limit)),
    invoicesByIdsPage: (filters, ids, from, to) =>
      page((offset, limit) => db.select(invoiceWithUser()).from(invoices).leftJoin(users, eq(invoices.userId, users.id)).where(and(where(filters), inArray(invoices.id, ids))).orderBy(desc(invoices.consecutiveNumber), desc(invoices.id)).offset(offset).limit(limit), from, to),
    countInvoices: async (filters, ids): Promise<BillingCount> => { try { const [value] = await db.select({ total: count() }).from(invoices).where(and(where(filters), ids ? inArray(invoices.id, ids) : undefined)); return { count: Number(value?.total ?? 0), error: null }; } catch (error) { return { count: null, error: toDbError(error) }; } },
    invoiceIdsForEmployeePage: (employeeId, from, to) => page((offset, limit) => db.select({ invoice_id: invoiceItems.invoiceId }).from(invoiceItems).where(eq(invoiceItems.employeeId, employeeId)).orderBy(asc(invoiceItems.id)).offset(offset).limit(limit), from, to),
    listItemEmployeesPage: (ids, from, to) => page((offset, limit) => db.select({ invoice_id: invoiceItems.invoiceId, employee_id: invoiceItems.employeeId }).from(invoiceItems).where(inArray(invoiceItems.invoiceId, ids)).orderBy(asc(invoiceItems.createdAt), asc(invoiceItems.id)).offset(offset).limit(limit), from, to),
    getInvoice: (id) => maybe(() => db.select(INVOICE).from(invoices).where(eq(invoices.id, id)).limit(1)),
    listInvoiceItemsWithEmployee: (invoiceId) => many(() => db.select({ ...ITEM, employees: { full_name: employees.fullName, employee_code: employees.employeeCode, commission_percent: employees.commissionPercent, pay_type: employees.payType, payout_mode: employees.payoutMode } }).from(invoiceItems).innerJoin(employees, eq(invoiceItems.employeeId, employees.id)).where(eq(invoiceItems.invoiceId, invoiceId)).orderBy(asc(invoiceItems.createdAt), asc(invoiceItems.id))),
    listInvoiceTaxes: (invoiceId) => many(() => db.select(TAX).from(invoiceTaxes).where(eq(invoiceTaxes.invoiceId, invoiceId)).orderBy(asc(invoiceTaxes.taxCode))),
    listInvoicePayments: (invoiceId) => many(() => db.select(PAYMENT).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId)).orderBy(asc(invoicePayments.createdAt), asc(invoicePayments.id))),
    employeeRulesPage: (ids, from, to) => page((offset, limit) => db.select({ employee_id: commissionRules.employeeId, item_type: commissionRules.itemType, item_id: commissionRules.itemId, percent: commissionRules.percent, amount: commissionRules.amount }).from(commissionRules).where(and(eq(commissionRules.isActive, true), inArray(commissionRules.employeeId, ids))).orderBy(asc(commissionRules.id)).offset(offset).limit(limit), from, to),
    employeesByIds: (ids) => many(() => db.select({ id: employees.id, user_id: employees.userId, full_name: employees.fullName }).from(employees).where(inArray(employees.id, ids))),
    userNames: (ids) => many(() => db.select({ id: users.id, full_name: users.fullName }).from(users).where(inArray(users.id, ids))),
    findInvoiceByIdempotencyKey: (key) => maybe(() => db.select(INVOICE).from(invoices).where(eq(invoices.idempotencyKey, key)).limit(1)),
    findInvoicePaymentsByIdempotency: (invoiceId, key) => many(() => db.select({ ...PAYMENT, idempotency_key: invoicePayments.idempotencyKey }).from(invoicePayments).where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.idempotencyKey, key)))),
    closedPayrollPeriodsPage: (from, to) => page((offset, limit) => db.select({ id: payrollPeriods.id }).from(payrollPeriods).where(eq(payrollPeriods.status, "cerrado")).orderBy(asc(payrollPeriods.id)).offset(offset).limit(limit), from, to),
    payrollItemDetailsPage: (ids, from, to) => page((offset, limit) => db.select({ detail_json: payrollItems.detailJson }).from(payrollItems).where(inArray(payrollItems.periodId, ids)).orderBy(asc(payrollItems.id)).offset(offset).limit(limit), from, to),
    createInvoiceAtomic: ({ userId, cashShiftId, idempotencyKey, invoice, items, taxes, payments: paymentRows, outReason, outItems }: CreateInvoiceArgs) => rpc(db, "invoice_create_atomic", [{ value: userId, cast: "uuid" }, { value: cashShiftId, cast: "uuid" }, { value: idempotencyKey, cast: "text" }, { value: invoice, cast: "jsonb" }, { value: items, cast: "jsonb" }, { value: taxes, cast: "jsonb" }, { value: paymentRows, cast: "jsonb" }, { value: outReason, cast: "text" }, { value: outItems, cast: "jsonb" }]),
    annulInvoiceAtomic: ({ invoiceId, userId, closedAt, motivo, expectedStatus, items }: AnnulInvoiceArgs) => rpc(db, "invoice_annul_atomic", [{ value: invoiceId, cast: "uuid" }, { value: userId, cast: "uuid" }, { value: closedAt, cast: "timestamptz" }, { value: motivo, cast: "text" }, { value: expectedStatus, cast: "text" }, { value: items, cast: "jsonb" }]),
    editItemsAtomic: ({ invoiceId, userId, expectedVersion, expectedStatus, edit }: EditInvoiceArgs) => rpc(db, "invoice_edit_items_atomic", [{ value: invoiceId, cast: "uuid" }, { value: userId, cast: "uuid" }, { value: expectedVersion, cast: "integer" }, { value: expectedStatus, cast: "text" }, { value: edit, cast: "jsonb" }]),
    editEmittedAtomic: ({ invoiceId, userId, expectedVersion, expectedStatus, edit }: EditInvoiceArgs) => rpc(db, "invoice_edit_emitted_atomic", [{ value: invoiceId, cast: "uuid" }, { value: userId, cast: "uuid" }, { value: expectedVersion, cast: "integer" }, { value: expectedStatus, cast: "text" }, { value: edit, cast: "jsonb" }]),
    splitPaymentAtomic: ({ invoiceId, shiftId, userId, closedAt, markPaid, portions }: SplitPaymentArgs) => rpc(db, "invoice_split_payment_atomic", [{ value: invoiceId, cast: "uuid" }, { value: shiftId, cast: "uuid" }, { value: userId, cast: "uuid" }, { value: closedAt, cast: "timestamptz" }, { value: markPaid, cast: "boolean" }, { value: portions, cast: "jsonb" }]),
  };
}
