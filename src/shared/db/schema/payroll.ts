import { date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const civilDate = (name: string) => date(name, { mode: "string" });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Read/write column map; payroll RPCs, caps and voucher triggers remain authoritative. */
export const payrollPeriods = pgTable("payroll_periods", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), startDate: civilDate("start_date").notNull(), endDate: civilDate("end_date").notNull(), status: text("status").notNull(),
  createdBy: uuid("created_by"), closedAt: timestamptz("closed_at"), frequency: text("frequency"), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const payrollItems = pgTable("payroll_items", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), periodId: uuid("period_id").notNull(), employeeId: uuid("employee_id").notNull(), baseFixed: money("base_fixed").notNull(), commissions: money("commissions").notNull(),
  bonuses: money("bonuses").notNull(), deductionsVales: money("deductions_vales").notNull(), otherDiscounts: money("other_discounts").notNull(), netPay: money("net_pay").notNull(), detailJson: jsonb("detail_json").$type<unknown[]>().notNull(),
  voucherTotal: money("voucher_total").notNull(), adjustmentReason: text("adjustment_reason"), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const payrollPayments = pgTable("payroll_payments", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), payrollItemId: uuid("payroll_item_id").notNull(), methodId: uuid("method_id"), methodCode: text("method_code").notNull(), amount: money("amount").notNull(),
  paidAt: timestamptz("paid_at").defaultNow().notNull(), paidBy: uuid("paid_by"), reference: text("reference"), createdAt: timestamptz("created_at").defaultNow().notNull(), idempotencyKey: text("idempotency_key"),
});
export const payrollExtras = pgTable("payroll_extras", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), employeeId: uuid("employee_id").notNull(), amount: money("amount").notNull(), methodId: uuid("method_id"), methodCode: text("method_code").notNull(), reference: text("reference"),
  reason: text("reason").notNull(), kind: text("kind").notNull(), daysFrom: civilDate("days_from"), daysTo: civilDate("days_to"), paidBy: uuid("paid_by"), paidAt: timestamptz("paid_at").defaultNow().notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(), idempotencyKey: text("idempotency_key"),
});
export const voucherRequests = pgTable("voucher_requests", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), employeeId: uuid("employee_id").notNull(), amount: money("amount").notNull(), requestDate: civilDate("request_date").notNull(), status: text("status").notNull(),
  approvedBy: uuid("approved_by"), approvalCode: text("approval_code"), observation: text("observation"), methodCode: text("method_code"), cashShiftId: uuid("cash_shift_id"), createdBy: uuid("created_by"), idempotencyKey: text("idempotency_key"), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const payrollDiscountCarries = pgTable("payroll_discount_carries", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), employeeId: uuid("employee_id").notNull(), amount: money("amount").notNull(), originPeriodId: uuid("origin_period_id").notNull(), appliedPeriodId: uuid("applied_period_id"), originKind: text("origin_kind").notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
export const payrollPeriodCorrections = pgTable("payroll_period_corrections", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), periodId: uuid("period_id").notNull(), previousNetTotal: money("previous_net_total").notNull(), previousPaidTotal: money("previous_paid_total").notNull(), previousItemCount: integer("previous_item_count").notNull(),
  correctedNetTotal: money("corrected_net_total").notNull(), correctedItemCount: integer("corrected_item_count").notNull(), reason: text("reason").notNull(), correctedBy: uuid("corrected_by").notNull(), correctedAt: timestamptz("corrected_at").defaultNow().notNull(),
});
export const payrollPeriodCorrectionItems = pgTable("payroll_period_correction_items", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), correctionId: uuid("correction_id").notNull(), employeeId: uuid("employee_id").notNull(), previousBaseFixed: money("previous_base_fixed").notNull(), previousCommissions: money("previous_commissions").notNull(),
  previousBonuses: money("previous_bonuses").notNull(), previousDeductionsVales: money("previous_deductions_vales").notNull(), previousOtherDiscounts: money("previous_other_discounts").notNull(), previousNetPay: money("previous_net_pay").notNull(), previousPaid: money("previous_paid").notNull(),
  correctedBaseFixed: money("corrected_base_fixed").notNull(), correctedCommissions: money("corrected_commissions").notNull(), correctedBonuses: money("corrected_bonuses").notNull(), correctedDeductionsVales: money("corrected_deductions_vales").notNull(), correctedOtherDiscounts: money("corrected_other_discounts").notNull(), correctedNetPay: money("corrected_net_pay").notNull(),
});
export const systemSettings = pgTable("system_settings", {
  key: text("key").notNull().primaryKey(), value: jsonb("value").$type<unknown>().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
