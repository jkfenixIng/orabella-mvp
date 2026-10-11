/**
 * 002_portable_platform.sql and supabase/bootstrap/platform-roles.sql.
 *
 * Proves the schema installs on a plain PostgreSQL (no `auth`, no `extensions`)
 * and that 002 changes nothing observable in Supabase: same current_sede_id()
 * results as the auth.jwt()-based body of 001, same attributes, same ACL.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PATH,
  CATALOG_PATH,
  DB_HOOK_TIMEOUT,
  PORTABLE_PATH,
  SCHEMA_PATH,
  applyFile,
  closeDb,
  count,
  emptyDb,
  one,
  pgError,
  type Db,
} from "./harness";

/** auth.jwt() exactly as Supabase Auth defines it (supabase/auth, 20220531120530_add_auth_jwt_function). */
const SUPABASE_AUTH_JWT = `
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;`;

const SEDE = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";

/** [request.jwt.claims, request.jwt.claim] pairs; null leaves the setting empty. */
const CLAIM_CASES: Array<[string | null, string | null]> = [
  [null, null],
  ["", ""],
  ["{}", null],
  [JSON.stringify({ app_metadata: { sede_id: SEDE } }), null],
  [JSON.stringify({ app_metadata: { sede_id: SEDE.toUpperCase() } }), null],
  [JSON.stringify({ app_metadata: { sede_id: "not-a-uuid" } }), null],
  [JSON.stringify({ app_metadata: {} }), null],
  [JSON.stringify({ sede_id: SEDE }), null],
  [JSON.stringify({ app_metadata: { sede_id: 42 } }), null],
  // The legacy single-claim setting wins over request.jwt.claims, as in auth.jwt().
  [JSON.stringify({ app_metadata: {} }), JSON.stringify({ app_metadata: { sede_id: SEDE } })],
  ["not json", null],
];

const ACL_SQL = `
  SELECT p.proname, p.prosecdef, p.provolatile, p.prolang::regproc::text AS lang,
         p.proconfig, p.proacl::text AS acl, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND NOT EXISTS (
     SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
   ORDER BY p.oid`;

let db: Db | undefined;
afterEach(async () => {
  await closeDb(db);
  db = undefined;
});

async function setClaims(target: Db, claims: string | null, claim: string | null): Promise<void> {
  await target.query(`SELECT set_config('request.jwt.claims', $1, false), set_config('request.jwt.claim', $2, false)`, [
    claims ?? "",
    claim ?? "",
  ]);
}

async function sedeFor(target: Db, claims: string | null, claim: string | null = null): Promise<string | null> {
  await setClaims(target, claims, claim);
  try {
    return (await one<{ v: string | null }>(target, `SELECT public.current_sede_id()::text AS v`)).v;
  } catch (error) {
    return `ERROR: ${(error as Error).message}`;
  }
}

async function schemaExists(target: Db, name: string): Promise<boolean> {
  return (await count(target, `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [name])) === 1;
}

describe("clean PostgreSQL install: bootstrap → 001 → 002 → catalog", () => {
  it("applies without the `auth` and `extensions` schemas", async () => {
    db = await emptyDb();
    expect(await schemaExists(db, "auth")).toBe(false);
    for (const path of [BOOTSTRAP_PATH, SCHEMA_PATH, PORTABLE_PATH, CATALOG_PATH]) await applyFile(db, path);

    expect(await schemaExists(db, "auth")).toBe(false);
    expect(await schemaExists(db, "extensions")).toBe(false);
    expect(await count(db, `SELECT 1 FROM pg_tables WHERE schemaname = 'public'`)).toBe(36);
    expect(await count(db, `SELECT 1 FROM pg_policies WHERE schemaname = 'public'`)).toBe(10);
    expect(await count(db, `SELECT 1 FROM public.roles`)).toBeGreaterThan(0);
    // btree_gist is the only extension the schema needs; the EXCLUDE exists.
    expect(await count(db, `SELECT 1 FROM pg_constraint WHERE conname = 'ex_payroll_periods_no_overlap'`)).toBe(1);
    expect(await count(db, `SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'`)).toBe(0);
  }, DB_HOOK_TIMEOUT);

  it("without the bootstrap, 001 aborts on the first missing role", async () => {
    db = await emptyDb();
    const error = await pgError(db.exec(`BEGIN;\n${readFileSync(SCHEMA_PATH, "utf8")}\nCOMMIT;`));
    expect(error.message).toBe('role "authenticated" does not exist');
  }, DB_HOOK_TIMEOUT);

  it("001 alone creates current_sede_id() without `auth` but cannot run it; 002 fixes the call", async () => {
    db = await emptyDb();
    await applyFile(db, BOOTSTRAP_PATH);
    await applyFile(db, SCHEMA_PATH);
    // 001 sets check_function_bodies = false, so the SQL body is not validated at creation.
    expect(await sedeFor(db, null)).toBe('ERROR: schema "auth" does not exist');
    await applyFile(db, PORTABLE_PATH);
    expect(await sedeFor(db, null)).toBeNull();
  }, DB_HOOK_TIMEOUT);

  it("the bootstrap is idempotent and leaves pre-existing roles alone", async () => {
    db = await emptyDb();
    await db.exec(`CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
    await applyFile(db, BOOTSTRAP_PATH);
    await applyFile(db, BOOTSTRAP_PATH);
    const roles = await db.query<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY 1`,
    );
    expect(roles.rows).toEqual([
      { rolname: "anon", rolcanlogin: false, rolbypassrls: false },
      { rolname: "authenticated", rolcanlogin: false, rolbypassrls: false },
      { rolname: "service_role", rolcanlogin: false, rolbypassrls: true },
    ]);
  }, DB_HOOK_TIMEOUT);
});

describe("current_sede_id() after 002", () => {
  it("returns NULL without claims and the sede_id from request.jwt.claims", async () => {
    db = await emptyDb();
    for (const path of [BOOTSTRAP_PATH, SCHEMA_PATH, PORTABLE_PATH]) await applyFile(db, path);

    expect(await sedeFor(db, null)).toBeNull();
    expect(await sedeFor(db, JSON.stringify({ app_metadata: { sede_id: SEDE } }))).toBe(SEDE);
    expect(await sedeFor(db, JSON.stringify({ app_metadata: { sede_id: "nope" } }))).toBeNull();
    // Transaction-local claims, the way PostgREST sets them per request.
    await setClaims(db, null, null);
    const scoped = await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: "authenticated", app_metadata: { sede_id: SEDE } }),
      ]);
      return (await tx.query<{ v: string }>(`SELECT public.current_sede_id()::text AS v`)).rows[0].v;
    });
    expect(scoped).toBe(SEDE);
    expect(await sedeFor(db, null)).toBeNull();
  }, DB_HOOK_TIMEOUT);

  it("returns exactly what 001's auth.jwt() body returns under Supabase's auth.jwt()", async () => {
    db = await emptyDb();
    await db.exec(SUPABASE_AUTH_JWT);
    await applyFile(db, BOOTSTRAP_PATH);
    await applyFile(db, SCHEMA_PATH);

    const before: Array<string | null> = [];
    for (const [claims, claim] of CLAIM_CASES) before.push(await sedeFor(db, claims, claim));
    await applyFile(db, PORTABLE_PATH);
    const after: Array<string | null> = [];
    for (const [claims, claim] of CLAIM_CASES) after.push(await sedeFor(db, claims, claim));

    expect(after).toEqual(before);
    // Control: the cases are not all NULL, so the comparison can fail.
    expect(before.filter((value) => value === SEDE)).toHaveLength(3);
    expect(before.at(-1)).toMatch(/^ERROR: invalid input syntax for type json/);
  }, DB_HOOK_TIMEOUT);
});

describe("002 in an existing (Supabase-like) database", () => {
  it("is idempotent and keeps every attribute, owner and GRANT of the public functions", async () => {
    db = await emptyDb();
    await db.exec(SUPABASE_AUTH_JWT);
    await applyFile(db, BOOTSTRAP_PATH);
    await applyFile(db, SCHEMA_PATH);
    const before = (await db.query(ACL_SQL)).rows;
    const policiesBefore = (await db.query(`SELECT policyname, roles::text, qual, with_check FROM pg_policies ORDER BY 1`)).rows;

    await applyFile(db, PORTABLE_PATH);
    const definition = (await one<{ d: string }>(db, `SELECT pg_get_functiondef('public.current_sede_id()'::regprocedure) AS d`)).d;
    await applyFile(db, PORTABLE_PATH);

    expect((await one<{ d: string }>(db, `SELECT pg_get_functiondef('public.current_sede_id()'::regprocedure) AS d`)).d).toBe(definition);
    expect(definition).not.toContain("auth.");
    expect((await db.query(ACL_SQL)).rows).toEqual(before);
    expect((await db.query(`SELECT policyname, roles::text, qual, with_check FROM pg_policies ORDER BY 1`)).rows).toEqual(policiesBefore);

    // The 21 service_role grants of 001, read from the catalog.
    const executable = await db.query<{ proname: string; service: boolean; authenticated: boolean; public_: boolean }>(`
      SELECT p.proname,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS public_
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proacl::text LIKE '%service_role=X%'`);
    expect(executable.rows).toHaveLength(21);
    expect(executable.rows.every((row) => row.service)).toBe(true);
    const sede = executable.rows.find((row) => row.proname === "current_sede_id");
    expect(sede).toEqual({ proname: "current_sede_id", service: true, authenticated: true, public_: false });
    // REVOKE ... FROM PUBLIC still holds on the business RPCs.
    expect(executable.rows.filter((row) => row.proname !== "current_sede_id").every((row) => !row.authenticated && !row.public_)).toBe(true);
  }, DB_HOOK_TIMEOUT);
});
