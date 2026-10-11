import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Auth tables read/written by the auth repository; 001 remains the source of truth. */
export const authUsers = pgTable("users", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), sedeId: uuid("sede_id"), email: text("email"), phone: text("phone"),
  idType: text("id_type").notNull(), idNumber: text("id_number").notNull(), passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(), isActive: boolean("is_active").default(true).notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(), failedAttempts: integer("failed_attempts").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "string" }),
});
export const roles = pgTable("roles", { id: uuid("id").defaultRandom().notNull().primaryKey(), code: text("code").notNull() });
export const userRoles = pgTable("user_roles", { userId: uuid("user_id").notNull(), roleId: uuid("role_id").notNull() });
export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), userId: uuid("user_id").notNull(), tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), revoked: boolean("revoked").default(false).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
export const passwordResets = pgTable("password_resets", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), userId: uuid("user_id").notNull(), tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(), used: boolean("used").default(false).notNull(),
});
export const authEmployees = pgTable("employees", { id: uuid("id").primaryKey(), userId: uuid("user_id"), document: text("document").notNull() });
