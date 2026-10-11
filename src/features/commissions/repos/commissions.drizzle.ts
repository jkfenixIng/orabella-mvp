/** Direct PostgreSQL adapter of the commissions port. Loaded only by the port's
 * dynamic selector when DB_ENGINE=postgres; injected DB makes PGlite parity
 * tests possible. It deliberately issues individual statements: the INSERT is
 * where PostgreSQL triggers 003 and 034 enforce their lock order and money
 * invariants. */
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { employees, invoiceItems, invoices, commissionPayouts, commissionRules, products, services } from "@/src/shared/db/schema";
import { toPostgrestTimestamp } from "@/src/shared/db/timestamps";
import type { CommissionPayoutRow, CommissionRuleRow } from "../schemas";
import { PAYOUT_LIST_LIMIT, type ActiveRule, type CommissionRepo, type InvoiceLine, type PayoutWrite, type RuleWrite } from "./commissions";

const ruleColumns = {
  id: commissionRules.id, item_type: commissionRules.itemType, item_id: commissionRules.itemId,
  employee_id: commissionRules.employeeId, percent: commissionRules.percent, amount: commissionRules.amount,
  is_active: commissionRules.isActive,
};
const payoutColumns = {
  id: commissionPayouts.id, employee_id: commissionPayouts.employeeId, invoice_id: commissionPayouts.invoiceId,
  cash_shift_id: commissionPayouts.cashShiftId, method_code: commissionPayouts.methodCode,
  base_subtotal: commissionPayouts.baseSubtotal, percent_applied: commissionPayouts.percentApplied,
  fixed_applied: commissionPayouts.fixedApplied, earned_immediate: commissionPayouts.earnedImmediate,
  amount: commissionPayouts.amount, paid_by: commissionPayouts.paidBy, paid_at: commissionPayouts.paidAt,
};
const numberOrNull = (value: unknown) => value == null ? null : Number(value);
function toRule(row: Record<string, unknown>): CommissionRuleRow {
  return { ...row, percent: numberOrNull(row.percent), amount: numberOrNull(row.amount) } as CommissionRuleRow;
}
function toPayout(row: Record<string, unknown>): CommissionPayoutRow {
  return {
    ...row,
    base_subtotal: Number(row.base_subtotal), percent_applied: numberOrNull(row.percent_applied),
    fixed_applied: numberOrNull(row.fixed_applied), earned_immediate: numberOrNull(row.earned_immediate),
    amount: Number(row.amount), paid_at: toPostgrestTimestamp(row.paid_at as string),
  } as CommissionPayoutRow;
}
async function run<T>(query: () => Promise<T>): Promise<T> {
  try { return await query(); } catch (error) { throw new DbQueryError(toDbError(error)); }
}

export function drizzleCommissionRepo(db: Database): CommissionRepo {
  return {
    listRules: (filters) =>
      run(async () => (await db.select(ruleColumns).from(commissionRules).where(and(
        filters.item_type ? eq(commissionRules.itemType, filters.item_type) : undefined,
        filters.item_id ? eq(commissionRules.itemId, filters.item_id) : undefined,
        filters.employee_id ? eq(commissionRules.employeeId, filters.employee_id) : undefined,
      )).orderBy(asc(commissionRules.createdAt), asc(commissionRules.id))).map(toRule)),
    itemExists: (table, id) => run(async () => {
      const target = table === "products" ? products : services;
      return (await db.select({ id: target.id }).from(target).where(eq(target.id, id)).limit(1)).length === 1;
    }),
    employeeExists: (id) => run(async () => (await db.select({ id: employees.id }).from(employees).where(eq(employees.id, id)).limit(1)).length === 1),
    employeeRate: (id) => run(async () => {
      const [row] = await db.select({ pay_type: employees.payType, commission_percent: employees.commissionPercent }).from(employees).where(eq(employees.id, id)).limit(1);
      return row ? { ...row, commission_percent: numberOrNull(row.commission_percent) } : null;
    }),
    employeePayoutMode: (id) => run(async () => (await db.select({ payout_mode: employees.payoutMode }).from(employees).where(eq(employees.id, id)).limit(1))[0]?.payout_mode ?? null),
    upsertRule: (write: RuleWrite) => run(async () => {
      const { id, item_type, item_id, employee_id, percent, amount, is_active } = write;
      const [row] = await db.insert(commissionRules).values({ ...(id ? { id } : {}), itemType: item_type, itemId: item_id, employeeId: employee_id, percent, amount, ...(is_active !== undefined ? { isActive: is_active } : {}) }).onConflictDoUpdate({
        target: [commissionRules.itemType, commissionRules.itemId, commissionRules.employeeId],
        set: { ...(id ? { id } : {}), percent, amount, ...(is_active !== undefined ? { isActive: is_active } : {}) },
      }).returning(ruleColumns);
      return row ? toRule(row) : null;
    }),
    deleteRule: (id) => run(async () => (await db.delete(commissionRules).where(eq(commissionRules.id, id)).returning({ id: commissionRules.id }))[0] ?? null),
    invoiceStatus: (id) => run(async () => (await db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(eq(invoices.id, id)).limit(1))[0] ?? null),
    invoiceLines: (invoiceId, employeeId) => run(async () => (await db.select({
      item_type: invoiceItems.itemType, product_id: invoiceItems.productId, service_id: invoiceItems.serviceId,
      qty: invoiceItems.qty, unit_price: invoiceItems.unitPrice, subtotal: invoiceItems.subtotal,
      no_commission: invoiceItems.noCommission, commission_value: invoiceItems.commissionValue,
      commission_percent_override: invoiceItems.commissionPercentOverride,
    }).from(invoiceItems).where(and(eq(invoiceItems.invoiceId, invoiceId), eq(invoiceItems.employeeId, employeeId)))).map((row) => ({
      ...row, unit_price: Number(row.unit_price), subtotal: Number(row.subtotal), commission_value: numberOrNull(row.commission_value), commission_percent_override: numberOrNull(row.commission_percent_override),
    } as InvoiceLine))),
    activeRules: (employeeId) => run(async () => (await db.select({ item_type: commissionRules.itemType, item_id: commissionRules.itemId, percent: commissionRules.percent, amount: commissionRules.amount }).from(commissionRules).where(and(eq(commissionRules.employeeId, employeeId), eq(commissionRules.isActive, true)))).map((row) => ({ ...row, percent: numberOrNull(row.percent), amount: numberOrNull(row.amount) } as ActiveRule))),
    paidAmounts: (invoiceId, employeeId) => run(async () => (await db.select({ amount: commissionPayouts.amount }).from(commissionPayouts).where(and(eq(commissionPayouts.invoiceId, invoiceId), eq(commissionPayouts.employeeId, employeeId)))).map((row) => Number(row.amount))),
    findPayoutByKey: (invoiceId, employeeId, idempotencyKey) => run(async () => {
      const [row] = await db.select(payoutColumns).from(commissionPayouts).where(and(eq(commissionPayouts.invoiceId, invoiceId), eq(commissionPayouts.employeeId, employeeId), eq(commissionPayouts.idempotencyKey, idempotencyKey))).limit(1);
      return row ? toPayout(row) : null;
    }),
    insertPayout: (write: PayoutWrite) => run(async () => {
      const [row] = await db.insert(commissionPayouts).values({ employeeId: write.employee_id, invoiceId: write.invoice_id, cashShiftId: write.cash_shift_id, methodCode: write.method_code, baseSubtotal: write.base_subtotal, percentApplied: write.percent_applied, fixedApplied: write.fixed_applied, earnedImmediate: write.earned_immediate, amount: write.amount, paidBy: write.paid_by, idempotencyKey: write.idempotency_key }).returning(payoutColumns);
      return row ? toPayout(row) : null;
    }),
    listPayouts: (filters) => run(async () => (await db.select(payoutColumns).from(commissionPayouts).where(and(
      filters.employee_id ? eq(commissionPayouts.employeeId, filters.employee_id) : undefined,
      filters.invoice_id ? eq(commissionPayouts.invoiceId, filters.invoice_id) : undefined,
      filters.shift_id ? eq(commissionPayouts.cashShiftId, filters.shift_id) : undefined,
    )).orderBy(desc(commissionPayouts.paidAt), desc(commissionPayouts.id)).limit(PAYOUT_LIST_LIMIT)).map(toPayout)),
  };
}
