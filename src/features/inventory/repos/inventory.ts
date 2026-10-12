/**
 * Port of the inventory data access, its supabase-js adapter and the selector
 * (same pattern as `src/features/admin/repos/services.ts`).
 *
 * `supabaseInventoryRepo` holds the requests the service sent before the
 * extraction (6d0d38d), including the `commission_value` column probe. Phase
 * 3b-2 intentional changes on BOTH adapters: an `id` tie-breaker on product
 * lists (total order) and the `search_products_literal` typed PostgreSQL RPC.
 *
 * `./inventory.drizzle.ts` is loaded with import() only when DB_ENGINE=postgres.
 * Both adapters throw `DbQueryError` (SQLSTATE and message preserved, so the
 * service keeps matching `23505` and `INSUFFICIENT_STOCK` the same way).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import type { MovementType } from "../schemas";

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  stock_qty: number;
  min_stock: number;
  cost_price: number | null;
  sale_price: number | null;
  /** I1: suggested product commission (absolute); null = no suggestion. */
  commission_value: number | null;
  is_active: boolean;
}

export interface ProductPage {
  rows: ProductRow[];
  total: number;
}

export interface ProductCatalogQuery {
  query: string;
  stockFilter: "all" | "low" | "out";
  limit: number;
  offset: number;
}

export interface MovementRow {
  id: string;
  product_id: string;
  type: MovementType;
  qty: number;
  reason: string;
  user_id: string | null;
  /** Set by the kardex read only (the responsible person's name). */
  actor_name?: string | null;
  created_at: string;
}

/** Validated product write; never carries stock_qty (INV-03). */
export interface ProductWrite {
  id?: string;
  /** Generated on insert; an edit writes back the stored SKU unchanged. */
  sku: string;
  name: string;
  description: string | null;
  min_stock: number;
  cost_price: number | null;
  sale_price: number | null;
  commission_value: number | null;
  is_active?: boolean;
}

export interface MovementWrite {
  product_id: string;
  type: MovementType;
  qty: number;
  reason: string;
  user_id: string;
  idempotency_key: string | null;
}

export interface InventoryRepo {
  /** Ordered by name, id. */
  listProducts(limit: number): Promise<ProductRow[]>;
  findProduct(id: string): Promise<ProductRow | null>;
  /** Every stored SKU shaped `PREFIX-…` (case-insensitive), ordered by sku; picks the next generated SKU. */
  listSkusByPrefix(prefix: string): Promise<string[]>;
  /** Literal, case-insensitive fragment of name or SKU; ordered by name, id. */
  searchProducts(needle: string, limit: number, offset?: number): Promise<ProductRow[]>;
  /** Server-filtered catalog page plus the total of the same filtered relation. */
  catalogPage(query: ProductCatalogQuery): Promise<ProductPage>;
  /** Active products ordered by stock_qty, id. */
  activeByStock(limit: number): Promise<ProductRow[]>;
  upsertProduct(write: ProductWrite): Promise<ProductRow | null>;
  findMovementByKey(productId: string, idempotencyKey: string): Promise<MovementRow | null>;
  insertMovement(write: MovementWrite): Promise<MovementRow | null>;
  productStocks(ids: string[]): Promise<Array<{ id: string; name: string; stock_qty: number }>>;
  /** `deduct_stock_atomic`: how many movements it applied. */
  deductStockAtomic(userId: string, reason: string, items: Array<{ product_id: string; qty: number }>): Promise<unknown>;
  /** Movements of a product by created_at, id ascending. */
  kardex(productId: string, limit: number): Promise<MovementRow[]>;
  userNames(ids: string[]): Promise<Array<{ id: string; full_name: string }>>;
}

/**
 * The product search lives in ONE PostgreSQL function both adapters call:
 * `public.search_products_literal(p_query text, p_limit integer, p_offset
 * integer)` (migration 004). The needle is a typed parameter and the function
 * escapes `\`, `%` and `_` itself with an explicit ESCAPE, so every character
 * — `*`, commas, parentheses, quotes — is literal text and no PostgREST filter
 * string is built from user input. Its rows are the PRODUCT_SELECT columns.
 */
export const SEARCH_PRODUCTS_RPC = "search_products_literal";
/** Migration 010: catalog query, stock filter, page and total in one RPC. */
export const CATALOG_PAGE_RPC = "inventory_catalog_page";

/** ILIKE pattern `PREFIX-%` with `\`, `%` and `_` escaped, so the prefix is literal. */
export function skuPrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}-%`;
}

/** PostgREST's default max-rows: SKU pages are read in windows of this size. */
const SKU_PAGE_SIZE = 1000;

type CatalogRow = Record<string, unknown> & { total_count?: unknown };

/** Splits the window total from rows; an empty page has no row carrying it. */
export function toProductPage(data: unknown, toProduct: (row: Record<string, unknown>) => ProductRow): ProductPage {
  const rows = (data ?? []) as CatalogRow[];
  return {
    rows: rows.map(({ total_count: _total, ...row }) => {
      void _total;
      return toProduct(row);
    }),
    total: Number(rows[0]?.total_count ?? 0),
  };
}

// ---------------------------------------------------------------- supabase ---

const PRODUCT_SELECT =
  "id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, commission_value, is_active";
/** Same list without the commission: migration 027 not applied to that database. */
const PRODUCT_SELECT_LEGACY =
  "id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, is_active";
const MOVEMENT_SELECT = "id, product_id, type, qty, reason, user_id, created_at";

// I1: commission_value arrives with migration 027. The first query decides and
// is cached; any other error (network, permissions) is not cached, so the real
// query reports it instead of silently degrading.
let commissionColumn: boolean | null = null;

async function resolveProductSelect(db: SupabaseClient): Promise<string> {
  if (commissionColumn === null) {
    const probe = await db.from("products").select("commission_value").limit(1);
    if (!probe.error) {
      commissionColumn = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/commission_value/i.test(message)) commissionColumn = false;
    }
  }
  return commissionColumn === false ? PRODUCT_SELECT_LEGACY : PRODUCT_SELECT;
}

/** Fills commission_value when the column is not available in that database. */
function normalizeProduct(row: Record<string, unknown>): ProductRow {
  return { ...(row as unknown as ProductRow), commission_value: (row.commission_value as number | null) ?? null };
}

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

const products = (data: unknown) => ((data ?? []) as Array<Record<string, unknown>>).map(normalizeProduct);

export function supabaseInventoryRepo(db: SupabaseClient): InventoryRepo {
  return {
    async listProducts(limit) {
      const { data, error } = await db.from("products").select(await resolveProductSelect(db)).order("name").order("id").limit(limit);
      if (error) fail(error);
      return products(data);
    },
    async findProduct(id) {
      const { data, error } = await db.from("products").select(await resolveProductSelect(db)).eq("id", id).maybeSingle();
      if (error) fail(error);
      return data ? normalizeProduct(data as unknown as Record<string, unknown>) : null;
    },
    async listSkusByPrefix(prefix) {
      const pattern = skuPrefixPattern(prefix);
      const skus: string[] = [];
      // Ranged pages ordered by the unique sku: never truncated by max-rows.
      for (let from = 0; ; from += SKU_PAGE_SIZE) {
        const { data, error } = await db
          .from("products")
          .select("sku")
          .ilike("sku", pattern)
          .order("sku")
          .range(from, from + SKU_PAGE_SIZE - 1);
        if (error) fail(error);
        const page = (data ?? []).map((row) => String((row as { sku: string }).sku));
        skus.push(...page);
        if (page.length < SKU_PAGE_SIZE) return skus;
      }
    },
    async searchProducts(needle, limit, offset = 0) {
      const { data, error } = await db.rpc(SEARCH_PRODUCTS_RPC, { p_query: needle, p_limit: limit, p_offset: offset });
      if (error) fail(error);
      return products(data);
    },
    async catalogPage({ query, stockFilter, limit, offset }) {
      const { data, error } = await db.rpc(CATALOG_PAGE_RPC, {
        p_query: query,
        p_stock_filter: stockFilter,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) fail(error);
      return toProductPage(data, normalizeProduct);
    },
    async activeByStock(limit) {
      const { data, error } = await db.from("products").select(await resolveProductSelect(db)).eq("is_active", true).order("stock_qty").order("id").limit(limit);
      if (error) fail(error);
      return products(data);
    },
    async upsertProduct(write) {
      const select = await resolveProductSelect(db);
      const { commission_value, is_active, ...rest } = write;
      const payload = {
        ...rest,
        // With the column absent (027 not applied) the commission is not sent.
        ...(select === PRODUCT_SELECT ? { commission_value } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
      };
      const { data, error } = await db.from("products").upsert(payload, { onConflict: "id" }).select(select).single();
      if (error) fail(error);
      return data ? normalizeProduct(data as unknown as Record<string, unknown>) : null;
    },
    async findMovementByKey(productId, idempotencyKey) {
      const { data, error } = await db
        .from("inventory_movements")
        .select(MOVEMENT_SELECT)
        .eq("product_id", productId)
        .eq("idempotency_key", idempotencyKey)
        .limit(1)
        .maybeSingle();
      if (error) fail(error);
      return (data as MovementRow | null) ?? null;
    },
    async insertMovement(write) {
      const { data, error } = await db.from("inventory_movements").insert(write).select(MOVEMENT_SELECT).single();
      if (error) fail(error);
      return (data as MovementRow | null) ?? null;
    },
    async productStocks(ids) {
      const { data, error } = await db.from("products").select("id, name, stock_qty").in("id", ids);
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string; name: string; stock_qty: number }>;
    },
    async deductStockAtomic(userId, reason, items) {
      const { data, error } = await db.rpc("deduct_stock_atomic", { p_user_id: userId, p_reason: reason, p_items: items });
      if (error) fail(error);
      return data;
    },
    async kardex(productId, limit) {
      const { data, error } = await db
        .from("inventory_movements")
        .select(MOVEMENT_SELECT)
        .eq("product_id", productId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (error) fail(error);
      return (data ?? []) as MovementRow[];
    },
    async userNames(ids) {
      const { data, error } = await db.from("users").select("id, full_name").in("id", ids);
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string; full_name: string }>;
    },
  };
}

// ---------------------------------------------------------------- selector ---

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function inventoryRepo(): Promise<InventoryRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleInventoryRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./inventory.drizzle"),
    ]);
    return drizzleInventoryRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseInventoryRepo(createAdminClient());
}
