/**
 * supabase/bootstrap/app-role.sql on the clean-PostgreSQL install path:
 * platform-roles.sql → 001 → 002 → (catalog) → app-role.sql.
 *
 * Proves that `orabella_app` reads all 36 tables of `public`, writes them, runs
 * the RPCs through its membership in service_role, bypasses RLS, and that the
 * file is idempotent.
 */
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, REPO_ROOT, applyFile, closeDb, freshDb, one, rpc, warmTemplate, type Db } from "./harness";

const APP_ROLE_PATH = join(REPO_ROOT, "supabase", "bootstrap", "app-role.sql");

let db: Db;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const publicTables = async (): Promise<string[]> =>
  (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map(
    (row) => row.tablename,
  );

/** Runs `fn` as orabella_app inside a transaction that is always rolled back. */
async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN; SET LOCAL ROLE orabella_app;");
  try {
    return await fn();
  } finally {
    await db.exec("ROLLBACK;");
  }
}

const roleState = () =>
  one<Record<string, unknown>>(
    db,
    `SELECT r.rolcanlogin, r.rolbypassrls, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
            r.rolpassword IS NULL AS no_password,
            pg_has_role('orabella_app', 'service_role', 'MEMBER') AS in_service_role,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
            (SELECT count(*)::int FROM information_schema.role_table_grants g
               WHERE g.grantee = 'orabella_app') AS table_grants
       FROM pg_authid r WHERE r.rolname = 'orabella_app'`,
  );

describe("app-role.sql on a clean PostgreSQL", () => {
  beforeEach(async () => {
    db = await freshDb();
    await applyFile(db, APP_ROLE_PATH);
  }, DB_HOOK_TIMEOUT);

  it("creates a LOGIN BYPASSRLS role without password, member of service_role only", async () => {
    expect(await roleState()).toEqual({
      rolcanlogin: true,
      rolbypassrls: true,
      rolinherit: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      no_password: true,
      in_service_role: true,
      memberships: 1,
      table_grants: 36 * 4,
    });
  });

  it("reads every one of the 36 public tables as orabella_app", async () => {
    const tables = await publicTables();
    expect(tables).toHaveLength(36);
    const readable = await asApp(async () => {
      const ok: string[] = [];
      for (const table of tables) {
        await db.query(`SELECT * FROM public.${table} LIMIT 1`);
        ok.push(table);
      }
      return ok;
    });
    expect(readable).toEqual(tables);
  });

  it("has exactly SELECT, INSERT, UPDATE, DELETE on each table (no TRUNCATE, no DDL)", async () => {
    const { rows } = await db.query<{ table_name: string; privileges: string }>(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants WHERE grantee = 'orabella_app'
        GROUP BY table_name ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(await publicTables());
    expect(new Set(rows.map((row) => row.privileges))).toEqual(new Set(["DELETE,INSERT,SELECT,UPDATE"]));
    await asApp(async () => {
      await expect(db.query(`TRUNCATE public.services`)).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("writes through RLS: the policies are TO authenticated, the role bypasses them", async () => {
    const rows = await asApp(async () => {
      await db.query(`INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('Corte', 1, 1, 1)`);
      return (await db.query<{ name: string }>(`SELECT name FROM public.services`)).rows;
    });
    expect(rows).toEqual([{ name: "Corte" }]);
  });

  it("executes the RPCs inherited from service_role", async () => {
    const result = await asApp(async () => {
      const user = await one<{ id: string }>(
        db,
        `INSERT INTO public.users (id_type, id_number, password_hash, full_name)
         VALUES ('CC', 'APP-1', 'scrypt$x', 'App') RETURNING id`,
      );
      return rpc<string[]>(db, "replace_user_roles", [user.id, ["caja"]], ["uuid", "text[]"]);
    });
    expect(result).toEqual(["caja"]);
  });

  it("is idempotent: a second run leaves the same role, membership and grants", async () => {
    const before = await roleState();
    await applyFile(db, APP_ROLE_PATH);
    expect(await roleState()).toEqual(before);
  });
});

describe("app-role.sql Supabase guard", () => {
  /** Observable footprint of the script: the role and any grant to it. */
  const footprint = () =>
    one<{ role: number; grants: number }>(
      db,
      `SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname = 'orabella_app') AS role,
              (SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee = 'orabella_app') AS grants`,
    );

  beforeEach(async () => {
    db = await freshDb();
  }, DB_HOOK_TIMEOUT);

  it("the clean install has none of the platform roles (the guard lets it through)", async () => {
    const { rows } = await db.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')`,
    );
    expect(rows).toEqual([]);
    await applyFile(db, APP_ROLE_PATH);
    expect(await footprint()).toEqual({ role: 1, grants: 36 * 4 });
  });

  it.each(["supabase_admin", "supabase_auth_admin", "supabase_storage_admin"])(
    "aborts without creating anything when the Supabase role %s exists",
    async (platformRole) => {
      await db.exec(`CREATE ROLE ${platformRole} NOLOGIN`);
      await expect(applyFile(db, APP_ROLE_PATH)).rejects.toMatchObject({
        code: "P0001",
        message: `app-role.sql must not run on Supabase (role "${platformRole}" exists)`,
      });
      expect(await footprint()).toEqual({ role: 0, grants: 0 });
    },
  );

  it("an existing orabella_app is left untouched when the guard fires", async () => {
    await applyFile(db, APP_ROLE_PATH);
    await db.exec(`ALTER ROLE orabella_app NOBYPASSRLS; CREATE ROLE supabase_admin NOLOGIN;`);
    await expect(applyFile(db, APP_ROLE_PATH)).rejects.toMatchObject({ code: "P0001" });
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'orabella_app'`,
    );
    expect(rows).toEqual([{ rolbypassrls: false }]);
  });

  it("the auth schema alone is not a Supabase signal", async () => {
    await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid);`);
    await applyFile(db, APP_ROLE_PATH);
    expect(await footprint()).toEqual({ role: 1, grants: 36 * 4 });
  });
});
