/**
 * Direct PostgreSQL adapter of the inventory port (`./inventory.ts`). SERVER
 * ONLY, loaded with import() only when DB_ENGINE=postgres; the database is
 * injected so the tests run it against PGlite.
 *
 * Equivalences with the supabase-js adapter:
 * - Same orders (name, id / stock_qty, id / created_at, id): total orders.
 * - The search calls the same `search_products_literal` function as the
 *   PostgREST RPC, with the needle, limit and offset as typed parameters.
 * - No `commission_value` probe: the direct engine runs on the schema of the
 *   migrations in this repo, where 027 is already part of 001.
 * - The stock is moved only by the 004 triggers; their RAISE EXCEPTION reaches
 *   the service as a `DbQueryError` with the SQLSTATE and message unchanged.
 * - `deduct_stock_atomic` runs as `SELECT public.fn(casts...)` (integer back).
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { callRpc, callRpcRows } from "@/src/shared/db/rpc";
import { inventoryMovements, products, users } from "@/src/shared/db/schema";
import { toPostgrestTimestamp } from "@/src/shared/db/timestamps";
import { SEARCH_PRODUCTS_RPC, type InventoryRepo, type MovementRow, type ProductRow } from "./inventory";

const PRODUCT_COLUMNS = {
  id: products.id,
  sku: products.sku,
  name: products.name,
  description: products.description,
  stock_qty: products.stockQty,
  min_stock: products.minStock,
  cost_price: products.costPrice,
  sale_price: products.salePrice,
  commission_value: products.commissionValue,
  is_active: products.isActive,
};

const MOVEMENT_COLUMNS = {
  id: inventoryMovements.id,
  product_id: inventoryMovements.productId,
  type: inventoryMovements.type,
  qty: inventoryMovements.qty,
  reason: inventoryMovements.reason,
  user_id: inventoryMovements.userId,
  created_at: inventoryMovements.createdAt,
};

const numeric = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function toProduct(row: { [K in keyof ProductRow]: unknown }): ProductRow {
  return {
    ...(row as ProductRow),
    cost_price: numeric(row.cost_price),
    sale_price: numeric(row.sale_price),
    commission_value: numeric(row.commission_value),
  };
}

function toMovement(row: { [K in keyof Omit<MovementRow, "actor_name">]: unknown }): MovementRow {
  return { ...(row as MovementRow), created_at: toPostgrestTimestamp(row.created_at as string) };
}

async function run<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new DbQueryError(toDbError(error));
  }
}

export function drizzleInventoryRepo(db: Database): InventoryRepo {
  const productQuery = () => db.select(PRODUCT_COLUMNS).from(products);
  return {
    listProducts: (limit) =>
      run(async () => (await productQuery().orderBy(asc(products.name), asc(products.id)).limit(limit)).map(toProduct)),
    findProduct: (id) =>
      run(async () => {
        // Primary key: at most one row (maybeSingle semantics).
        const [row] = await productQuery().where(eq(products.id, id)).limit(1);
        return row ? toProduct(row) : null;
      }),
    skuConflicts: (sku, exceptId) =>
      run(() =>
        db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.sku, sku), exceptId ? ne(products.id, exceptId) : undefined))
          .limit(1),
      ),
    searchProducts: (needle, limit, offset = 0) =>
      run(async () => {
        const rows = await callRpcRows<{ [K in keyof ProductRow]: unknown }>(db, SEARCH_PRODUCTS_RPC, [
          { value: needle, cast: "text" },
          { value: limit, cast: "integer" },
          { value: offset, cast: "integer" },
        ]);
        return rows.map(toProduct);
      }),
    activeByStock: (limit) =>
      run(async () =>
        (await productQuery().where(eq(products.isActive, true)).orderBy(asc(products.stockQty), asc(products.id)).limit(limit)).map(toProduct),
      ),
    upsertProduct: (write) =>
      run(async () => {
        const values = {
          ...(write.id ? { id: write.id } : {}),
          sku: write.sku,
          name: write.name,
          description: write.description,
          minStock: write.min_stock,
          costPrice: write.cost_price,
          salePrice: write.sale_price,
          commissionValue: write.commission_value,
          ...(write.is_active !== undefined ? { isActive: write.is_active } : {}),
        };
        // Same keys as the PostgREST upsert payload: absent keys keep their value.
        const { id: _id, ...set } = values;
        void _id;
        const [row] = await db
          .insert(products)
          .values(values)
          .onConflictDoUpdate({ target: products.id, set })
          .returning(PRODUCT_COLUMNS);
        return row ? toProduct(row) : null;
      }),
    findMovementByKey: (productId, idempotencyKey) =>
      run(async () => {
        const [row] = await db
          .select(MOVEMENT_COLUMNS)
          .from(inventoryMovements)
          .where(and(eq(inventoryMovements.productId, productId), eq(inventoryMovements.idempotencyKey, idempotencyKey)))
          .limit(1);
        return row ? toMovement(row) : null;
      }),
    insertMovement: (write) =>
      run(async () => {
        const [row] = await db
          .insert(inventoryMovements)
          .values({
            productId: write.product_id,
            type: write.type,
            qty: write.qty,
            reason: write.reason,
            userId: write.user_id,
            idempotencyKey: write.idempotency_key,
          })
          .returning(MOVEMENT_COLUMNS);
        return row ? toMovement(row) : null;
      }),
    productStocks: (ids) =>
      run(() =>
        db.select({ id: products.id, name: products.name, stock_qty: products.stockQty }).from(products).where(inArray(products.id, ids)),
      ),
    deductStockAtomic: (userId, reason, items) =>
      run(() =>
        callRpc<unknown>(db, "deduct_stock_atomic", [
          { value: userId, cast: "uuid" },
          { value: reason, cast: "text" },
          { value: JSON.stringify(items), cast: "jsonb" },
        ]),
      ),
    kardex: (productId, limit) =>
      run(async () => {
        const rows = await db
          .select(MOVEMENT_COLUMNS)
          .from(inventoryMovements)
          .where(eq(inventoryMovements.productId, productId))
          .orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id))
          .limit(limit);
        return rows.map(toMovement);
      }),
    userNames: (ids) =>
      run(() => db.select({ id: users.id, full_name: users.fullName }).from(users).where(inArray(users.id, ids))),
  };
}
