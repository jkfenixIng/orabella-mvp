/**
 * Characterization of the inventory service on the supabase-js path: exact
 * PostgREST requests and the mapping of each outcome. Written against the
 * service before the repository extraction (6d0d38d). Intentional changes of
 * phase 3b-2 are marked INTENTIONAL: the `id` tie-breaker on product lists and
 * the quoted, literal search filter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InventoryError,
  deductStock,
  getKardex,
  getProduct,
  listProducts,
  lowStockAlerts,
  registerMovement,
  searchProducts,
  upsertProduct,
} from "@/src/features/inventory/service";

type Response = { data?: unknown; error: unknown };
const PRODUCT_SELECT =
  "id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, commission_value, is_active";
const MOVEMENT_SELECT = "id, product_id, type, qty, reason, user_id, created_at";
const P = "33333333-3333-4333-8333-333333333333";

const postgrest = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>,
  answers: [] as Array<{ data?: unknown; error: unknown }>,
}));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> };
      postgrest.calls.push(call);
      const answer = () => postgrest.answers.shift() ?? { data: null, error: null };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "in", "or", "order", "limit", "range", "insert", "upsert"]) {
        query[method] = (...args: unknown[]) => {
          call.chain.push([method, args]);
          return query;
        };
      }
      for (const terminal of ["single", "maybeSingle"]) {
        query[terminal] = () => {
          call.chain.push([terminal, []]);
          return Promise.resolve(answer());
        };
      }
      query.then = (ok?: (v: unknown) => unknown, ko?: (r: unknown) => unknown) => Promise.resolve(answer()).then(ok, ko);
      return query;
    },
    rpc(fn: string, args: unknown) {
      postgrest.calls.push({ table: `rpc:${fn}`, chain: [["args", [args]]] });
      return Promise.resolve(postgrest.answers.shift() ?? { data: null, error: null });
    },
  }),
}));

const ROW = {
  id: P, sku: "SH-1", name: "Shampoo", description: null, stock_qty: 4, min_stock: 2,
  cost_price: 10, sale_price: 20.5, commission_value: null, is_active: true,
};

function answer(...responses: Response[]) {
  postgrest.answers = responses;
}

async function rejection(promise: Promise<unknown>): Promise<InventoryError> {
  const error = await promise.then(() => { throw new Error("expected an InventoryError"); }, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(InventoryError);
  return error as InventoryError;
}

/** The commission-column probe answered first, once per module instance. */
let probed = false;
function withProbe(...responses: Response[]) {
  answer(...(probed ? [] : [{ data: [], error: null }]), ...responses);
  const skip = probed ? 0 : 1;
  probed = true;
  return skip;
}

beforeEach(() => {
  postgrest.calls = [];
  postgrest.answers = [];
});

describe("product reads (supabase-js)", () => {
  it("probes commission_value once, then lists by name with an id tie-breaker (INTENTIONAL) and the clamped limit", async () => {
    answer({ data: [], error: null }, { data: [ROW], error: null });
    probed = true;
    expect(await listProducts(900)).toEqual([ROW]);
    // The list builder is created before the probe resolves the select list.
    expect(postgrest.calls).toEqual([
      { table: "products", chain: [["select", [PRODUCT_SELECT]], ["order", ["name"]], ["order", ["id"]], ["limit", [500]]] },
      { table: "products", chain: [["select", ["commission_value"]], ["limit", [1]]] },
    ]);
    answer({ data: [ROW], error: null });
    await listProducts();
    expect(postgrest.calls.at(-1)?.chain.at(-1)).toEqual(["limit", [50]]);
  });

  it("getProduct: maybeSingle by id; null is NOT_FOUND 404, an error INTERNAL 500", async () => {
    withProbe({ data: ROW, error: null });
    expect(await getProduct(P)).toEqual(ROW);
    expect(postgrest.calls.at(-1)).toEqual({ table: "products", chain: [["select", [PRODUCT_SELECT]], ["eq", ["id", P]], ["maybeSingle", []]] });
    answer({ data: null, error: null });
    expect(await rejection(getProduct(P))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    answer({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await rejection(getProduct(P))).toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("low stock: active products by stock_qty then id (INTENTIONAL), limit 200, filtered in memory", async () => {
    withProbe({ data: [{ ...ROW, stock_qty: 1 }, { ...ROW, id: "x", stock_qty: 9 }], error: null });
    expect(await lowStockAlerts()).toEqual([{ ...ROW, stock_qty: 1 }]);
    expect(postgrest.calls.at(-1)?.chain).toEqual([
      ["select", [PRODUCT_SELECT]], ["eq", ["is_active", true]], ["order", ["stock_qty"]], ["order", ["id"]], ["limit", [200]],
    ]);
  });

  it("search: blank query lists; otherwise ONE rpc search_products_literal with the trimmed text (INTENTIONAL, migration 004)", async () => {
    withProbe({ data: [ROW], error: null });
    await searchProducts("   ");
    expect(postgrest.calls.at(-1)?.table).toBe("products");
    expect(postgrest.calls.some((call) => call.chain.some(([method]) => method === "or"))).toBe(false);

    postgrest.calls = [];
    answer({ data: [ROW], error: null });
    // The database answer is final: no in-memory filter after the limit.
    expect(await searchProducts(" sham ")).toEqual([ROW]);
    expect(postgrest.calls).toEqual([
      { table: "rpc:search_products_literal", chain: [["args", [{ p_query: "sham", p_limit: 50, p_offset: 0 }]]] },
    ]);
  });
});

describe("literal search (supabase-js)", () => {
  it.each(['a,b)"%_\\', "a*", "x'); DROP TABLE public.products; --", "name.ilike.*,sku.eq.1"])(
    "%j travels as the typed p_query value, never as a filter string",
    async (needle) => {
      answer({ data: [], error: null });
      expect(await searchProducts(needle, 1)).toEqual([]);
      expect(postgrest.calls).toEqual([
        { table: "rpc:search_products_literal", chain: [["args", [{ p_query: needle, p_limit: 1, p_offset: 0 }]]] },
      ]);
    },
  );

  it("one call for any limit, clamped to 500; an RPC error is INTERNAL", async () => {
    answer({ data: [], error: null });
    await searchProducts("a*", 100_000);
    expect(postgrest.calls).toEqual([
      { table: "rpc:search_products_literal", chain: [["args", [{ p_query: "a*", p_limit: 500, p_offset: 0 }]]] },
    ]);
    answer({ data: null, error: { code: "42883", message: "function does not exist" } });
    expect(await rejection(searchProducts("a"))).toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
describe("upsertProduct (supabase-js)", () => {
  const input = { sku: "CLIENT-SKU", name: "Shampoo", min_stock: 2 };
  const insert = (sku: string) => ({ sku, name: "Shampoo", description: null, min_stock: 2, cost_price: null, sale_price: null, commission_value: null });
  const duplicate = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"products_sku_key\"" } };

  it("create ignores the input SKU and generates the next one for the name prefix", async () => {
    withProbe({ data: [{ sku: "SHAMPO-001" }, { sku: "shampo-007" }], error: null }, { data: ROW, error: null });
    expect(await upsertProduct(input)).toEqual(ROW);
    const skuRead = postgrest.calls.find((call) => call.chain[0]?.[0] === "select" && call.chain[0]?.[1]?.[0] === "sku");
    expect(skuRead?.chain).toEqual([["select", ["sku"]]]);
    expect(postgrest.calls.at(-1)?.chain[0]).toEqual(["upsert", [insert("SHAMPO-008"), { onConflict: "id" }]]);
  });

  it("edit keeps the stored SKU even when another one is sent", async () => {
    withProbe({ data: ROW, error: null }, { data: ROW, error: null });
    expect(await upsertProduct({ ...input, id: P })).toEqual(ROW);
    expect(postgrest.calls.at(-1)?.chain[0]).toEqual(["upsert", [{ id: P, ...insert("SH-1") }, { onConflict: "id" }]]);
    answer({ data: null, error: null });
    expect(await rejection(upsertProduct({ ...input, id: P }))).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("a 23505 race recomputes the SKU, up to three attempts; other failures INTERNAL", async () => {
    answer({ data: [], error: null }, duplicate, { data: [{ sku: "SHAMPO-001" }], error: null }, { data: ROW, error: null });
    expect(await upsertProduct(input)).toEqual(ROW);
    expect(postgrest.calls.at(-1)?.chain[0]).toEqual(["upsert", [insert("SHAMPO-002"), { onConflict: "id" }]]);
    answer({ data: [], error: null }, duplicate, { data: [], error: null }, duplicate, { data: [], error: null }, duplicate);
    expect(await rejection(upsertProduct(input))).toMatchObject({ code: "SKU_TAKEN", status: 409 });
    answer({ data: [], error: null }, { data: null, error: { code: "23514", message: "check" } });
    expect(await rejection(upsertProduct(input))).toMatchObject({ code: "INTERNAL", status: 500 });
    answer({ data: null, error: { message: "down" } });
    expect(await rejection(upsertProduct(input))).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(await rejection(upsertProduct({ name: "" }))).toMatchObject({ code: "VALIDATION", status: 400 });
  });
});

describe("movements and kardex (supabase-js)", () => {
  const actor = { userId: "u1" };

  it("inserts the movement, re-reads the product for the stock, and maps INSUFFICIENT_STOCK by message", async () => {
    const movement = { id: "m1", product_id: P, type: "IN", qty: 3, reason: "Compra", user_id: "u1", created_at: "2026-10-10T10:00:00+00:00" };
    answer({ data: ROW, error: null }, { data: movement, error: null }, { data: { ...ROW, stock_qty: 7 }, error: null });
    expect(await registerMovement({ product_id: P, type: "IN", qty: 3, reason: "Compra" }, actor)).toEqual({ movement, stock_qty: 7 });
    expect(postgrest.calls[1]).toEqual({
      table: "inventory_movements",
      chain: [["insert", [{ product_id: P, type: "IN", qty: 3, reason: "Compra", user_id: "u1", idempotency_key: null }]], ["select", [MOVEMENT_SELECT]], ["single", []]],
    });
    answer({ data: ROW, error: null }, { data: null, error: { code: "P0001", message: "INSUFFICIENT_STOCK" } });
    expect(await rejection(registerMovement({ product_id: P, type: "OUT", qty: 1, reason: "x" }, actor))).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
  });

  it("kardex: product first, created_at then id ascending, limit 200, actor names by id", async () => {
    const rows = [
      { id: "m2", product_id: P, type: "IN", qty: 1, reason: "a", user_id: "u1", created_at: "2026-10-10T10:00:00+00:00" },
      { id: "m1", product_id: P, type: "OUT", qty: 1, reason: "b", user_id: null, created_at: "2026-10-10T10:00:00+00:00" },
    ];
    answer({ data: ROW, error: null }, { data: rows, error: null }, { data: [{ id: "u1", full_name: "Ana" }], error: null });
    expect(await getKardex(P)).toEqual([{ ...rows[1], actor_name: null }, { ...rows[0], actor_name: "Ana" }]);
    expect(postgrest.calls.slice(1)).toEqual([
      { table: "inventory_movements", chain: [["select", [MOVEMENT_SELECT]], ["eq", ["product_id", P]], ["order", ["created_at", { ascending: true }]], ["order", ["id", { ascending: true }]], ["limit", [200]]] },
      { table: "users", chain: [["select", ["id, full_name"]], ["in", ["id", ["u1"]]]] },
    ]);
  });

  it("deductStock calls deduct_stock_atomic once; RPC messages map by includes()", async () => {
    answer({ data: [{ id: P, name: "Shampoo", stock_qty: 4 }], error: null }, { data: 1, error: null });
    expect(await deductStock(actor, [{ product_id: P, qty: 2 }], "FACTURA #1")).toEqual([{ product_id: P, qty: 2 }]);
    expect(postgrest.calls.at(-1)).toEqual({ table: "rpc:deduct_stock_atomic", chain: [["args", [{ p_user_id: "u1", p_reason: "FACTURA #1", p_items: [{ product_id: P, qty: 2 }] }]]] });
    answer({ data: [{ id: P, name: "Shampoo", stock_qty: 4 }], error: null }, { data: null, error: { code: "P0001", message: "INSUFFICIENT_STOCK" } });
    expect(await rejection(deductStock(actor, [{ product_id: P, qty: 2 }], "F"))).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
    answer({ data: [{ id: P, name: "Shampoo", stock_qty: 4 }], error: null }, { data: 2, error: null });
    expect(await rejection(deductStock(actor, [{ product_id: P, qty: 2 }], "F"))).toMatchObject({ code: "INTERNAL", status: 500 });
  });
});
