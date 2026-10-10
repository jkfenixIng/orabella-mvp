import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * `public.services`, written by hand to match `001_orabella_schema.sql`
 * (`CREATE TABLE public.services`). The SQL migrations are the source of truth:
 * this file never generates DDL (no drizzle-kit). The CHECKs, the primary key
 * and `trg_services_updated_at` live in 001 and are not repeated here.
 *
 * `price` is `numeric(12,2)` read in `number` mode, the same type PostgREST
 * returns today. Timestamps use `string` mode so they are never turned into a
 * `Date` (no repository returns them yet).
 */
export const services = pgTable("services", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 12, scale: 2, mode: "number" }).notNull(),
  duracionMin: integer("duracion_min").notNull(),
  duracionMax: integer("duracion_max").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
