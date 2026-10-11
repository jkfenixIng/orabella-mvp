import { boolean, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const percent = (name: string) => numeric(name, { precision: 5, scale: 2, mode: "number" });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Read/write column map; payout caps and cash-minimum triggers stay in PostgreSQL. */
export const commissionRules = pgTable("commission_rules", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), itemType: text("item_type").notNull(), itemId: uuid("item_id").notNull(), employeeId: uuid("employee_id").notNull(),
  percent: percent("percent"), amount: money("amount"), isActive: boolean("is_active").default(true).notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const commissionPayouts = pgTable("commission_payouts", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), employeeId: uuid("employee_id").notNull(), invoiceId: uuid("invoice_id").notNull(), cashShiftId: uuid("cash_shift_id").notNull(), methodCode: text("method_code").notNull(),
  baseSubtotal: money("base_subtotal").notNull(), percentApplied: percent("percent_applied"), fixedApplied: money("fixed_applied"), amount: money("amount").notNull(), paidBy: uuid("paid_by"), paidAt: timestamptz("paid_at").defaultNow().notNull(), earnedImmediate: money("earned_immediate"), idempotencyKey: text("idempotency_key"),
});
