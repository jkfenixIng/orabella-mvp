import { boolean, date, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tables read by the alerts and admin catalog repositories, written by hand
 * to match 001 (+ `arqueo_mode` from 003). The SQL migrations are the source
 * of truth and no DDL is generated from here. Each table declares only the
 * columns a repository reads or writes; defaults, CHECKs and triggers stay in
 * the database, so an INSERT that omits a column gets the database default.
 *
 * numeric columns use `number` mode (PostgREST sends JSON numbers);
 * timestamps use `string` mode and are normalized by `../timestamps`.
 */

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
  reviewNote: text("review_note"),
  reviewedBy: uuid("reviewed_by"),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  sedeId: uuid("sede_id"),
  fullName: text("full_name").notNull(),
  idNumber: text("id_number").notNull(),
});

export const employees = pgTable("employees", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  userId: uuid("user_id"),
  fullName: text("full_name").notNull(),
  employeeCode: text("employee_code"),
  document: text("document").notNull(),
  phone: text("phone"),
  position: text("position"),
  payoutMode: text("payout_mode").notNull(),
  email: text("email"),
  birthDate: date("birth_date", { mode: "string" }),
  payType: text("pay_type").notNull(),
  payFrequency: text("pay_frequency"),
  salaryFixed: numeric("salary_fixed", { precision: 12, scale: 2, mode: "number" }),
  commissionPercent: numeric("commission_percent", { precision: 5, scale: 2, mode: "number" }),
  isActive: boolean("is_active").default(true).notNull(),
});

export const taxConfigs = pgTable("tax_configs", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  percent: numeric("percent", { precision: 5, scale: 2, mode: "number" }).notNull(),
  isActive: boolean("is_active").default(false).notNull(),
});

export const paymentMethods = pgTable("payment_methods", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  arqueable: boolean("arqueable").default(true).notNull(),
  arqueoMode: text("arqueo_mode").notNull(),
  feePercent: numeric("fee_percent", { precision: 5, scale: 2, mode: "number" }).default(0).notNull(),
});
