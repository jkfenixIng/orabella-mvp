/**
 * Migration 010: the inventory catalog is filtered and paged by PostgreSQL on
 * both engines. Rows and total come from the same filtered relation, so the
 * client never needs the whole catalog to paginate.
 */
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleInventoryRepo } from "@/src/features/inventory/repos/inventory.drizzle";
import { supabaseInventoryRepo, type InventoryRepo, type ProductCatalogQuery } from "@/src/features/inventory/repos/inventory";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { postgrestDouble } from "./postgrest-double";

let pg: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  pg = await freshDb();
  // 12 "Item" rows: n % 3 = 0 → out (0), 1 → low (1 <= 2), 2 → healthy (5).
  await pg.query(
    `INSERT INTO public.products (id, sku, name, stock_qty, min_stock)
     SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ITM-' || n, 'Item ' || lpad(n::text, 2, '0'),
            CASE n % 3 WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 5 END, 2
       FROM generate_series(1, 12) AS n`,
  );
  await pg.query(`INSERT INTO public.products (sku, name, stock_qty, min_stock) VALUES ('ZZ-50%', 'Other 50%', 0, 0), ('ZZ-2', 'Other x', 3, 1)`);
}, DB_HOOK_TIMEOUT);
afterEach(async () => closeDb(pg));

const engines: Array<[string, () => InventoryRepo]> = [
  ["supabase", () => supabaseInventoryRepo(postgrestDouble(pg))],
  ["postgres", () => drizzleInventoryRepo(drizzle({ client: pg, schema }) as unknown as Database)],
];

const page = (repo: InventoryRepo, query: Partial<ProductCatalogQuery>) =>
  repo.catalogPage({ query: "", stockFilter: "all", limit: 5, offset: 0, ...query });

describe.each(engines)("inventory catalog page on %s", (_engine, repoOf) => {
  it("returns one bounded page with the total of the whole filtered relation", async () => {
    const repo = repoOf();
    const first = await page(repo, { query: "item" });
    const last = await page(repo, { query: "item", offset: 10 });
    expect(first.total).toBe(12);
    expect(first.rows.map((row) => row.name)).toEqual(["Item 01", "Item 02", "Item 03", "Item 04", "Item 05"]);
    expect(last).toMatchObject({ total: 12 });
    expect(last.rows.map((row) => row.sku)).toEqual(["ITM-11", "ITM-12"]);
    expect(first.rows[0]).not.toHaveProperty("total_count");
  });

  it("filters low (positive, at or below minimum) and out (zero) stock before paging", async () => {
    const repo = repoOf();
    const low = await page(repo, { query: "item", stockFilter: "low", limit: 2, offset: 2 });
    expect(low.total).toBe(4);
    expect(low.rows.map((row) => row.sku)).toEqual(["ITM-7", "ITM-10"]);
    const out = await page(repo, { stockFilter: "out", limit: 50 });
    expect(out.total).toBe(5);
    expect(out.rows.every((row) => row.stock_qty === 0)).toBe(true);
  });

  it("treats the query literally and reports an empty page with total 0", async () => {
    const repo = repoOf();
    expect((await page(repo, { query: "50%" })).rows.map((row) => row.sku)).toEqual(["ZZ-50%"]);
    expect(await page(repo, { query: "%%" })).toEqual({ rows: [], total: 0 });
    expect(await page(repo, { query: "item", offset: 99 })).toEqual({ rows: [], total: 0 });
  });

  it("rejects an unknown stock filter in the database", async () => {
    const error = await page(repoOf(), { stockFilter: "nope" as "all" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DbQueryError);
    expect((error as DbQueryError).error.message).toContain("INVALID_STOCK_FILTER");
  });
});
