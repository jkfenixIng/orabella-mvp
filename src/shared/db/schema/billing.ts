import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Read/write column map for invoice repositories; migrations are the DDL authority. */
export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), consecutiveNumber: integer("consecutive_number").notNull(), clientName: text("client_name"), clientDocument: text("client_document"),
  subtotal: money("subtotal").notNull(), discount: money("discount").notNull(), tax: money("tax").notNull(), total: money("total").notNull(), surcharge: money("surcharge").notNull(), status: text("status").notNull(),
  userId: uuid("user_id"), cashShiftId: uuid("cash_shift_id"), cancelReason: text("cancel_reason"), closedBy: uuid("closed_by"), closedAt: timestamptz("closed_at"), editVersion: integer("edit_version").notNull(), idempotencyKey: text("idempotency_key"), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const invoiceItems = pgTable("invoice_items", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), invoiceId: uuid("invoice_id").notNull(), itemType: text("item_type").notNull(), productId: uuid("product_id"), serviceId: uuid("service_id"), customName: text("custom_name"), employeeId: uuid("employee_id").notNull(),
  qty: integer("qty").notNull(), unitPrice: money("unit_price").notNull(), discount: money("discount").notNull(), subtotal: money("subtotal").notNull(), noCommission: boolean("no_commission").notNull(), commissionValue: money("commission_value"), commissionMode: text("commission_mode"), commissionPercentOverride: numeric("commission_percent_override", { precision: 5, scale: 2, mode: "number" }), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const invoiceTaxes = pgTable("invoice_taxes", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), invoiceId: uuid("invoice_id").notNull(), taxCode: text("tax_code").notNull(), taxName: text("tax_name").notNull(), percent: numeric("percent", { precision: 5, scale: 2, mode: "number" }).notNull(), amount: money("amount").notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
export const invoicePayments = pgTable("invoice_payments", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), invoiceId: uuid("invoice_id").notNull(), methodId: uuid("method_id"), methodCode: text("method_code").notNull(), amount: money("amount").notNull(), feePercent: numeric("fee_percent", { precision: 5, scale: 2, mode: "number" }).notNull(), feeAmount: money("fee_amount").notNull(), cashShiftId: uuid("cash_shift_id"), idempotencyKey: text("idempotency_key"), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
