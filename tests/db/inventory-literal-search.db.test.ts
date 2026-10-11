/**
 * 004_inventory_literal_search.sql on the real schema: idempotent, transactional,
 * same ACL contract as the other RPCs, and the function's own guarantees.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, MIGRATIONS_DIR, closeDb, freshDb, pgError, warmTemplate, type Db } from "./harness";

const PATH = join(MIGRATIONS_DIR, "004_inventory_literal_search.sql");
const SIGNATURE = "public.search_products_literal(text, integer, integer)";

let db: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
}, DB_HOOK_TIMEOUT);
afterEach(() => closeDb(db));

const search = async (query: string | null, limit: number | null, offset: number | null = 0) =>
  (await db.query<{ name: string }>(`SELECT name FROM public.search_products_literal($1::text, $2::integer, $3::integer)`, [query, limit, offset])).rows.map((row) => row.name);

describe("004_inventory_literal_search.sql", () => {
  it("re-applies cleanly and keeps the PUBLIC-revoked, service_role-only ACL", async () => {
    await db.exec(readFileSync(PATH, "utf8"));
    const { rows } = await db.query<{ acl: string; definer: boolean; owner: string }>(
      `SELECT p.proacl::text AS acl, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [SIGNATURE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].definer).toBe(false);
    expect(rows[0].acl).toMatch(/service_role=X\//);
    expect(rows[0].acl).not.toMatch(/(?:^|[{,])=X\//); // no PUBLIC entry
    for (const role of ["anon", "authenticated", "service_role"]) {
      const allowed = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, SIGNATURE])).rows[0].ok;
      expect(allowed, role).toBe(role === "service_role");
    }
  });

  it("stays service_role-only under Supabase-style default privileges for functions", async () => {
    // Supabase keeps pg_default_acl rows of type `f` in schema public that
    // GRANT EXECUTE explicitly to anon and authenticated (squash README §8.1).
    // REVOKE ... FROM PUBLIC does not remove those explicit grants; the
    // historical RPC migrations (046/071/077) revoked both roles by name.
    await db.exec(`
      DROP FUNCTION public.search_products_literal(text, integer, integer);
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;`);
    await db.exec(readFileSync(PATH, "utf8"));
    for (const role of ["anon", "authenticated", "service_role"]) {
      const allowed = (await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, SIGNATURE])).rows[0].ok;
      expect(allowed, role).toBe(role === "service_role");
    }
  });

  it("anon cannot execute it", async () => {
    await db.exec("SET ROLE anon");
    expect((await pgError(search("a", 1))).code).toBe("42501");
    await db.exec("RESET ROLE");
  });

  it("treats every metacharacter literally, case-insensitively, in name or sku", async () => {
    await db.query(`INSERT INTO public.products (sku, name) VALUES
      ('A%B', 'uno'), ('AXB', 'dos'), ('k_1', 'tres'), ('kx1', 'cuatro'),
      ('S1', 'back\\slash'), ('S2', 'back/slash'), ('S3', 'Star*'), ('S4', 'stars')`);
    expect(await search("a%b", 50)).toEqual(["uno"]);
    expect(await search("K_1", 50)).toEqual(["tres"]);
    expect(await search("\\", 50)).toEqual(["back\\slash"]);
    expect(await search("STAR*", 50)).toEqual(["Star*"]);
    expect(await search("%", 50)).toEqual(["uno"]);
    expect(await search("_", 50)).toEqual(["tres"]);
  });

  it("clamps limit and offset and treats NULLs safely", async () => {
    await db.query(`INSERT INTO public.products (sku, name) SELECT 'L' || n, 'n' || lpad(n::text, 3, '0') FROM generate_series(1, 600) n`);
    expect(await search("n", 0)).toHaveLength(1);
    expect(await search("n", -5)).toHaveLength(1);
    expect(await search("n", 10_000)).toHaveLength(500);
    expect(await search("n", null)).toHaveLength(50);
    expect(await search("n", 2, -10)).toEqual(["n001", "n002"]);
    expect(await search("n", 2, null)).toEqual(["n001", "n002"]);
    expect(await search("n", 2, 2)).toEqual(["n003", "n004"]);
    expect(await search(null, 3)).toEqual(["n001", "n002", "n003"]);
  });
});
