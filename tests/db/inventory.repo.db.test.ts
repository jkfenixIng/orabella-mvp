/**
 * Inventory repository: equivalence supabase-js (PostgREST double) ↔ Drizzle
 * over the same real schema, plus the service-level outcomes that depend on
 * the database (stock triggers, 23505, INSUFFICIENT_STOCK, the RPC).
 */
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleInventoryRepo } from "@/src/features/inventory/repos/inventory.drizzle";
import { supabaseInventoryRepo, type InventoryRepo } from "@/src/features/inventory/repos/inventory";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { parseOrIlike, postgrestDouble } from "./postgrest-double";

const USER = "00000000-0000-4000-8000-0000000000a1";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const KEY = "1e5b7c4a-8d29-4f36-a0b1-c7d3e9f2a5b8";

let left: Db;
let right: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  [left, right] = await Promise.all([freshDb(), freshDb()]);
  await Promise.all([seed(left), seed(right)]);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(left);
  await closeDb(right);
});

/** Names chosen to exercise every character the search must take literally. */
const NAMES = [
  "Plain", "Tie", "Tie", "Tie", "50% off", "a_b", "a,b", "Shampoo (500 ml)", 'Say "hi"', "back\\slash", "it's", "star*", "Acme",
  // Wildcard decoys: each would match if `%`, `_`, `*` or `\` leaked as syntax.
  "50 percent off", "axb", "stars", "starx", "back/slash", "Say hi",
  // Text that looks like SQL / PostgREST syntax is still just data.
  "x'); DROP TABLE public.products; --", "name.ilike.*,sku.eq.1", "1 OR 1=1",
];

async function seed(pg: Db) {
  await pg.query(`INSERT INTO public.users (id, id_type, id_number, password_hash, full_name) VALUES ($1, 'CC', '1', 'x', 'Ana')`, [USER]);
  await pg.query(`INSERT INTO public.products (id, sku, name, stock_qty, min_stock, cost_price, sale_price, commission_value)
    VALUES ($1, 'SKU-1', 'Shampoo', 5, 2, 1000.5, 2000.25, 150.75), ($2, 'SKU-2', 'Tinte', 0, 0, NULL, NULL, NULL)`, [P1, P2]);
  for (const [index, name] of NAMES.entries()) {
    const id = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
    await pg.query(`INSERT INTO public.products (id, sku, name, stock_qty, min_stock) VALUES ($1, $2, $3, $4, 1)`, [id, `X-${index}`, name, index % 3]);
  }
}

function repos(): [InventoryRepo, InventoryRepo] {
  return [supabaseInventoryRepo(postgrestDouble(left)), drizzleInventoryRepo(drizzle({ client: right, schema }) as unknown as Database)];
}

async function outcome(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    if (!(error instanceof DbQueryError)) throw error;
    return { code: error.error.code, message: error.error.message };
  }
}

/** Generated ids and the write instant differ per instance: blank them. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const row = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, stable(child)]));
    if (typeof row.created_at === "string") {
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}:\d{2}$/);
      row.created_at = "<instant>";
    }
    if (typeof row.id === "string" && !row.id.startsWith("00000000-")) row.id = "<generated>";
    return row;
  }
  return value;
}

async function same(run: (repo: InventoryRepo) => Promise<unknown>) {
  const [viaPostgrest, viaDrizzle] = repos();
  const expected = stable(await outcome(() => run(viaPostgrest)));
  const actual = stable(await outcome(() => run(viaDrizzle)));
  expect(actual).toEqual(expected);
  return actual;
}

const stocks = async () =>
  Promise.all([left, right].map(async (pg) => (await pg.query<{ id: string; stock_qty: number }>(`SELECT id, stock_qty FROM public.products ORDER BY id`)).rows));

describe("inventory repository: equivalence supabase-js ↔ drizzle", () => {
  it("product reads: numeric as number, total order name, id across pages of ties", async () => {
    const all = (await same((repo) => repo.listProducts(500))) as { value: Array<{ name: string; cost_price: unknown }> };
    expect(all.value.find((row) => row.name === "Shampoo")?.cost_price).toBe(1000.5);
    const page1 = (await same((repo) => repo.listProducts(12))) as { value: Array<{ id: string }> };
    // The three "Tie" rows straddle the page boundary: ids ascending inside the tie.
    const ties = all.value.filter((row) => row.name === "Tie") as unknown as Array<{ id: string }>;
    expect(ties.map((row) => row.id)).toEqual(ties.map((row) => row.id).sort());
    expect(page1.value.map((row) => row.id)).toEqual(all.value.slice(0, 12).map((row) => (row as unknown as { id: string }).id));
    await same((repo) => repo.findProduct(P1));
    await same((repo) => repo.findProduct("00000000-0000-4000-8000-0000000000ff"));
    await same((repo) => repo.activeByStock(200));
    await same((repo) => repo.productStocks([P1, P2]));
    await same((repo) => repo.skuConflicts("SKU-1"));
    await same((repo) => repo.skuConflicts("SKU-1", P1));
  });

  it.each<[string, string[]]>([
    ["%", ["50% off"]],
    ["0% o", ["50% off"]],
    ["_", ["a_b"]],
    ["a_b", ["a_b"]],
    ["*", ["name.ilike.*,sku.eq.1", "star*"]],
    ["star*", ["star*"]],
    ["r*", ["star*"]],
    ["\\", ["back\\slash"]],
    ["k\\s", ["back\\slash"]],
    [",", ["a,b", "name.ilike.*,sku.eq.1"]],
    ["a,b", ["a,b"]],
    ["(500", ["Shampoo (500 ml)"]],
    [")", ["Shampoo (500 ml)", "x'); DROP TABLE public.products; --"]],
    ['"hi"', ['Say "hi"']],
    ["'", ["it's", "x'); DROP TABLE public.products; --"]],
    ["SKU-1", ["Shampoo"]],
    ["sku-1", ["Shampoo"]],
    ["x'); DROP TABLE public.products; --", ["x'); DROP TABLE public.products; --"]],
    ["name.ilike.*,sku.eq.1", ["name.ilike.*,sku.eq.1"]],
    ["1 OR 1=1", ["1 OR 1=1"]],
    ["a,b)", []],
    ["%%", []],
    ["' OR '1'='1", []],
  ])("search %j returns exactly the literal matches %j on both engines", async (needle, expected) => {
    const result = (await same((repo) => repo.searchProducts(needle, 50))) as { value: Array<{ name: string }> };
    expect(result.value.map((row) => row.name).sort()).toEqual([...expected].sort());
    // The injection-shaped needles left the table intact.
    const [a, b] = await stocks();
    expect(a).toHaveLength(2 + NAMES.length);
    expect(b).toEqual(a);
  });

  it("finding: the previous unquoted `.or()` value was syntax, not data", async () => {
    // What the service sent before 3b-2 for the needle `a,b)`: `\` does not
    // escape outside double quotes, so the value ends at the first `,`.
    const before = "name.ilike.%a\\,b)%,sku.ilike.%a\\,b)%";
    expect(() => parseOrIlike(before)).toThrow(/unsupported or\(\) item|malformed/);
    expect(parseOrIlike('name.ilike."%a,b)%"')).toEqual([{ column: "name", value: "%a,b)%" }]);
  });

  it("search results keep ProductRow's numeric types and the total order name, id", async () => {
    const result = (await same((repo) => repo.searchProducts("h", 500))) as { value: Array<{ id: string; name: string; cost_price: unknown }> };
    expect(result.value.find((row) => row.name === "Shampoo")?.cost_price).toBe(1000.5);
    const ordered = [...result.value].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
    expect(result.value.map((row) => row.id)).toEqual(ordered.map((row) => row.id));
  });

  it("the limit is clamped server-side and never exceeded", async () => {
    expect(((await same((repo) => repo.searchProducts("", 0))) as { value: unknown[] }).value).toHaveLength(1);
    expect(((await same((repo) => repo.searchProducts("", 2))) as { value: unknown[] }).value).toHaveLength(2);
    expect(((await same((repo) => repo.searchProducts("", 100_000))) as { value: unknown[] }).value).toHaveLength(2 + NAMES.length);
    expect(((await same((repo) => repo.searchProducts("", 5, -9))) as { value: unknown[] }).value).toHaveLength(5);
  });

  it("search pages with an offset on both engines, including the `Tie` rows across the boundary", async () => {
    const all = (await same((repo) => repo.searchProducts("e", 50))) as { value: Array<{ id: string; name: string }> };
    const pages: Array<{ id: string }> = [];
    for (let offset = 0; offset < all.value.length; offset += 3) {
      pages.push(...((await same((repo) => repo.searchProducts("e", 3, offset))) as { value: Array<{ id: string }> }).value);
    }
    expect(pages.map((row) => row.id)).toEqual(all.value.map((row) => row.id));
    expect(new Set(pages.map((row) => row.id)).size).toBe(all.value.length);
    expect(all.value.filter((row) => row.name === "Tie")).toHaveLength(3);
  });

  it("upsert: insert keeps defaults, update by id never writes stock, 23505 on a taken SKU", async () => {
    const write = { sku: "NEW-1", name: "Nuevo", description: null, min_stock: 1, cost_price: 10.1, sale_price: 20, commission_value: 3.5 };
    await same((repo) => repo.upsertProduct(write));
    await same((repo) => repo.upsertProduct({ ...write, id: P1, sku: "SKU-1", is_active: false }));
    const taken = (await same((repo) => repo.upsertProduct({ ...write, sku: "SKU-2" }))) as { code: string };
    expect(taken.code).toBe("23505");
  });

  it("movements: IN / OUT / ADJUST move the stock through the trigger; INSUFFICIENT_STOCK and the idempotency index", async () => {
    const move = (type: "IN" | "OUT" | "ADJUST", qty: number, key: string | null = null) => (repo: InventoryRepo) =>
      repo.insertMovement({ product_id: P1, type, qty, reason: "prueba", user_id: USER, idempotency_key: key });
    await same(move("IN", 3));
    await same(move("OUT", 2));
    await same(move("ADJUST", 9, KEY));
    const [a, b] = await stocks();
    expect(a).toEqual(b);
    expect(a.find((row) => row.id === P1)?.stock_qty).toBe(9);
    const short = (await same(move("OUT", 10))) as { code: string; message: string };
    expect([short.code, short.message]).toEqual(["P0001", "INSUFFICIENT_STOCK"]);
    expect(((await same(move("IN", 1, KEY))) as { code: string }).code).toBe("23505");
    await same((repo) => repo.findMovementByKey(P1, KEY));
  });

  it("kardex: created_at, id ascending with ties across pages; user names", async () => {
    for (const pg of [left, right]) {
      for (let n = 1; n <= 5; n += 1) {
        await pg.query(
          `INSERT INTO public.inventory_movements (id, product_id, type, qty, reason, user_id, created_at)
           VALUES ($1, $2, 'IN', 1, 'k', $3, '2026-10-09 14:32:18.5-05')`,
          [`00000000-0000-4000-8000-00000000c00${6 - n}`, P2, n % 2 ? USER : null],
        );
      }
    }
    const first = (await same((repo) => repo.kardex(P2, 3))) as { value: Array<{ id: string; created_at: string }> };
    const all = (await same((repo) => repo.kardex(P2, 200))) as { value: Array<{ id: string }> };
    expect(all.value.map((row) => row.id)).toEqual(all.value.map((row) => row.id).sort());
    expect(first.value.map((row) => row.id)).toEqual(all.value.slice(0, 3).map((row) => row.id));
    await same((repo) => repo.userNames([USER]));
  });

  it("deduct_stock_atomic: returns the integer count, all-or-nothing, messages kept", async () => {
    const applied = (await same((repo) => repo.deductStockAtomic(USER, "FACTURA #1", [{ product_id: P1, qty: 2 }]))) as { value: unknown };
    expect(applied.value).toBe(1);
    const short = (await same((repo) =>
      repo.deductStockAtomic(USER, "FACTURA #2", [{ product_id: P1, qty: 1 }, { product_id: P2, qty: 1 }]),
    )) as { message: string };
    expect(short.message).toBe("INSUFFICIENT_STOCK");
    const missing = (await same((repo) =>
      repo.deductStockAtomic(USER, "F", [{ product_id: "00000000-0000-4000-8000-0000000000ff", qty: 1 }]),
    )) as { message: string };
    expect(missing.message).toBe("PRODUCT_NOT_FOUND");
    const [a, b] = await stocks();
    expect(a).toEqual(b);
    expect(a.find((row) => row.id === P1)?.stock_qty).toBe(3);
  });
});
