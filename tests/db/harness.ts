/**
 * PGlite harness for characterization tests of the REAL Orabella schema.
 *
 * PGlite (@electric-sql/pglite, pinned in package.json) is PostgreSQL 18 compiled
 * to WASM and running in-process: no server, no Docker, no credentials, and no
 * network. Nothing here can reach a remote database.
 *
 * Build order (see tests/db/README.md):
 *   1. platform stub  — roles, `extensions` schema with pgcrypto/uuid-ossp,
 *                       `auth.jwt()` returning '{}'::jsonb (what Supabase provides)
 *   2. 001_orabella_schema.sql — applied VERBATIM, no preprocessing
 *   3. seeds/catalog.sql (optional)
 *
 * The built data directory is dumped once per test file and every test starts
 * from a fresh instance loaded from that dump (no schema re-apply per test).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_PATH = join(REPO_ROOT, "supabase", "migrations", "001_orabella_schema.sql");
export const CATALOG_PATH = join(REPO_ROOT, "supabase", "seeds", "catalog.sql");

/** Contrib modules the schema (and the Supabase platform layout) needs. */
const EXTENSIONS = { btree_gist, pgcrypto, uuid_ossp };

/** Generous budget for hooks that build or load an instance. */
export const DB_HOOK_TIMEOUT = 120_000;

/**
 * Minimal platform layer, mirroring what a Supabase project already has before
 * 001 runs (prod-plataforma.txt): pgcrypto and uuid-ossp live in `extensions`,
 * the API roles exist, and `auth.jwt()` resolves. 001 then creates btree_gist
 * in `public` itself (`CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA public`)
 * and skips pgcrypto because it already exists — the same outcome as production.
 *
 * Roles: 001 only grants to `authenticated` and `service_role` (GRANT/POLICY ...
 * TO). `anon` is kept because every Supabase project has it and the API grants
 * of a future migration would target it; `supabase_admin` is not referenced.
 */
export const PLATFORM_SQL = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
`;

export type Db = PGlite;

export interface BuildOptions {
  /** Apply supabase/seeds/catalog.sql after the schema (default true). */
  catalog?: boolean;
}

/** Builds a new instance: platform stub + 001 verbatim (+ catalog). */
export async function buildSchemaDb(options: BuildOptions = {}): Promise<Db> {
  const db = await PGlite.create({ extensions: EXTENSIONS });
  await db.exec(PLATFORM_SQL);
  await db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  if (options.catalog ?? true) {
    await db.exec(readFileSync(CATALOG_PATH, "utf8"));
  }
  return db;
}

let templatePromise: Promise<Blob> | undefined;

/** Schema + catalog, built once per module instance and kept as a datadir dump. */
function template(): Promise<Blob> {
  templatePromise ??= (async () => {
    const db = await buildSchemaDb({ catalog: true });
    const dump = await db.dumpDataDir("none");
    await db.close();
    return dump;
  })();
  return templatePromise;
}

/** A clean instance (schema + catalog) for one test. Close it when done. */
export async function freshDb(): Promise<Db> {
  return PGlite.create({ loadDataDir: await template(), extensions: EXTENSIONS });
}

/** Closes an instance if `beforeEach` got far enough to create it. */
export async function closeDb(db: Db | undefined): Promise<void> {
  if (db && !db.closed) await db.close();
}

/** Warms the template so the first test does not pay the build cost. */
export async function warmTemplate(): Promise<void> {
  await template();
}

/**
 * Calls `public.<fn>(...)` with typed parameters and returns its single value.
 * `types` are SQL casts (uuid, jsonb, numeric, text[], ...), one per argument.
 */
export async function rpc<T = unknown>(
  db: Db,
  fn: string,
  args: unknown[],
  types: string[],
): Promise<T> {
  if (args.length !== types.length) throw new Error(`rpc ${fn}: ${args.length} args, ${types.length} types`);
  const placeholders = types.map((type, index) => `$${index + 1}::${type}`).join(", ");
  const result = await db.query<{ result: T }>(`SELECT public.${fn}(${placeholders}) AS result`, args);
  return result.rows[0].result;
}

/** First row of a query. */
export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params);
  if (result.rows.length === 0) throw new Error(`no rows: ${sql}`);
  return result.rows[0];
}

/** `count(*)` of a query as a number. */
export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM (${sql}) AS q`, params);
  return row.n;
}

export interface DbError {
  code?: string;
  message: string;
  constraint?: string;
}

/** Awaits a promise that must reject with a PostgreSQL error and returns it. */
export async function pgError(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    const pg = error as DbError;
    return { code: pg.code, message: pg.message, constraint: pg.constraint };
  }
  throw new Error("expected a PostgreSQL error, the call succeeded");
}
