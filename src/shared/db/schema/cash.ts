import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Read/write column map for cash repositories; 001–004 remain authoritative. */
export const cashDenominations = pgTable("cash_denominations", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), kind: text("kind").notNull(), value: money("value").notNull(),
  isActive: boolean("is_active").default(true).notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
export const cashRegisters = pgTable("cash_registers", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), name: text("name").notNull(), baseConfigurada: money("base_configurada").notNull(),
  isActive: boolean("is_active").default(true).notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const cashShifts = pgTable("cash_shifts", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), cashRegisterId: uuid("cash_register_id").notNull(), openedBy: uuid("opened_by").notNull(), closedBy: uuid("closed_by"),
  openedAt: timestamptz("opened_at").defaultNow().notNull(), closedAt: timestamptz("closed_at"), openingBase: money("opening_base").notNull(), expectedCash: money("expected_cash").notNull(),
  countedCash: money("counted_cash"), baseLeft: money("base_left"), cashWithdrawn: money("cash_withdrawn"), baseDifference: money("base_difference"), status: text("status").notNull(), observation: text("observation"),
  createdAt: timestamptz("created_at").defaultNow().notNull(), updatedAt: timestamptz("updated_at").defaultNow().notNull(),
});
export const cashShiftCounts = pgTable("cash_shift_counts", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), shiftId: uuid("shift_id").notNull(), phase: text("phase").notNull(), methodCode: text("method_code").notNull(),
  denomination: money("denomination"), quantity: integer("quantity").notNull(), amount: money("amount").notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
export const cashShiftRecounts = pgTable("cash_shift_recounts", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), shiftId: uuid("shift_id").notNull(), previousCountedCash: money("previous_counted_cash").notNull(), previousBaseLeft: money("previous_base_left").notNull(),
  previousCashWithdrawn: money("previous_cash_withdrawn").notNull(), previousBaseDifference: money("previous_base_difference").notNull(), countedCash: money("counted_cash").notNull(), baseLeft: money("base_left").notNull(),
  cashWithdrawn: money("cash_withdrawn").notNull(), baseDifference: money("base_difference").notNull(), reason: text("reason").notNull(), recountedBy: uuid("recounted_by").notNull(), recountedAt: timestamptz("recounted_at").defaultNow().notNull(),
});
export const cashShiftMethodBalances = pgTable("cash_shift_method_balances", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), cashShiftId: uuid("cash_shift_id").notNull(), paymentMethodId: uuid("payment_method_id").notNull(), methodCode: text("method_code").notNull(), openingBase: money("opening_base").notNull(), createdAt: timestamptz("created_at").defaultNow().notNull(),
});
export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), cashShiftId: uuid("cash_shift_id").notNull(), invoiceId: uuid("invoice_id"), methodId: uuid("method_id"), methodCode: text("method_code").notNull(), amount: money("amount").notNull(), userId: uuid("user_id"), createdAt: timestamptz("created_at").defaultNow().notNull(), idempotencyKey: text("idempotency_key"),
});
