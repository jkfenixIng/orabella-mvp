import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().notNull().primaryKey(),
  sku: text("sku").notNull(), name: text("name").notNull(), description: text("description"),
  stockQty: integer("stock_qty").default(0).notNull(), minStock: integer("min_stock").default(0).notNull(),
  costPrice: numeric("cost_price", { precision: 12, scale: 2, mode: "number" }),
  salePrice: numeric("sale_price", { precision: 12, scale: 2, mode: "number" }),
  commissionValue: numeric("commission_value", { precision: 12, scale: 2, mode: "number" }),
  isActive: boolean("is_active").default(true).notNull(),
});

export const inventoryMovements = pgTable("inventory_movements", {
  id: uuid("id").defaultRandom().notNull().primaryKey(), productId: uuid("product_id").notNull(),
  type: text("type").notNull(), qty: integer("qty").notNull(), reason: text("reason").notNull(), userId: uuid("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(), idempotencyKey: text("idempotency_key"),
});
