/**
 * The product search through the SERVICE on both engines, over the real schema
 * (001-004). 2100 rows would match any `*`-as-wildcard reading of `a*` and sort
 * before the only literal match; with limit 1 the literal row must still be the
 * answer, from ONE call to `search_products_literal` (no over-fetch, no filter
 * after the limit).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";

const engine = vi.hoisted(() => ({ pg: null as unknown as Db, rpcCalls: [] as string[] }));
vi.mock("@/src/shared/lib/supabase/server", async () => {
  const { postgrestDouble } = await import("./postgrest-double");
  return {
    createAdminClient: () => {
      if (process.env.DB_ENGINE === "postgres") throw new Error("Supabase used on postgres search");
      const client = postgrestDouble(engine.pg);
      return {
        ...client,
        rpc: (fn: string, args?: Record<string, unknown>) => {
          engine.rpcCalls.push(fn);
          return client.rpc(fn, args);
        },
      };
    },
  };
});
vi.mock("@/src/shared/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/src/shared/db/schema");
  return { getDb: () => drizzle({ client: engine.pg, schema }) };
});

const FALSE_POSITIVES = 2100;
const LITERAL = "00000000-0000-4000-8000-000000009999";

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  engine.pg = await freshDb();
  engine.rpcCalls = [];
  // `a0000`…`a2099` match `a%`/`a_` (a wildcard reading of `*`), never `a*`.
  await engine.pg.query(
    `INSERT INTO public.products (sku, name)
     SELECT 'F-' || n, 'a' || lpad(n::text, 4, '0') FROM generate_series(0, $1 - 1) AS n`,
    [FALSE_POSITIVES],
  );
  // Sorts AFTER every false positive (`b` > `a`).
  await engine.pg.query(`INSERT INTO public.products (id, sku, name) VALUES ($1, 'LITERAL', 'b a* literal')`, [LITERAL]);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

describe.each(["supabase", "postgres"] as const)("literal search through the service on %s", (name) => {
  beforeEach(() => {
    vi.stubEnv("DB_ENGINE", name === "postgres" ? "postgres" : "");
    vi.stubEnv("DATABASE_URL", name === "postgres" ? "postgres://unused.invalid/db" : "");
  });

  it(`finds the literal match behind ${FALSE_POSITIVES} wildcard false positives with limit 1, in one call`, async () => {
    const { searchProducts } = await import("@/src/features/inventory/service");
    const statements: string[] = [];
    const query = engine.pg.query.bind(engine.pg);
    const spy = vi.spyOn(engine.pg, "query").mockImplementation(((...args: Parameters<Db["query"]>) => {
      statements.push(String(args[0]));
      return query(...args);
    }) as Db["query"]);
    try {
      const rows = await searchProducts("a*", 1);
      expect(rows.map((row) => row.id)).toEqual([LITERAL]);
    } finally {
      spy.mockRestore();
    }
    expect(statements.filter((text) => text.includes("search_products_literal"))).toHaveLength(1);
    expect(statements.some((text) => /ILIKE|\bilike\b/.test(text))).toBe(false);
    if (name === "supabase") expect(engine.rpcCalls).toEqual(["search_products_literal"]);
  });
});
