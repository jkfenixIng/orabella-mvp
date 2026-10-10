/**
 * PGlite harness for characterization tests of the REAL Orabella schema.
 *
 * PGlite (@electric-sql/pglite, pinned in package.json) is PostgreSQL 18 compiled
 * to WASM and running in-process: no server, no Docker, no credentials, and no
 * network. Nothing here can reach a remote database.
 *
 * Build order = the clean-PostgreSQL install path (see tests/db/README.md):
 *   1. supabase/bootstrap/platform-roles.sql — the API roles, nothing else
 *   2. every supabase/migrations/NNN_*.sql in order (001, 002, ...), VERBATIM
 *   3. seeds/catalog.sql (optional)
 *
 * No `auth` schema and no `extensions` schema: the instance is a plain
 * PostgreSQL, not a Supabase imitation.
 *
 * The built data directory is dumped once per test file and every test starts
 * from a fresh instance loaded from that dump (no schema re-apply per test).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
export const SCHEMA_PATH = join(MIGRATIONS_DIR, "001_orabella_schema.sql");
export const PORTABLE_PATH = join(MIGRATIONS_DIR, "002_portable_platform.sql");
export const BOOTSTRAP_PATH = join(REPO_ROOT, "supabase", "bootstrap", "platform-roles.sql");
export const CATALOG_PATH = join(REPO_ROOT, "supabase", "seeds", "catalog.sql");

/** The migrations in apply order: `NNN_name.sql`, sorted by number. */
export const MIGRATION_PATHS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort()
  .map((name) => join(MIGRATIONS_DIR, name));

/**
 * Contrib modules a plain PostgreSQL server must have available: 001 runs
 * `CREATE EXTENSION IF NOT EXISTS` for btree_gist (the EXCLUDE) and pgcrypto
 * (installed, unused). PGlite needs them registered up front.
 */
const EXTENSIONS = { btree_gist, pgcrypto };

/** Generous budget for hooks that build or load an instance. */
export const DB_HOOK_TIMEOUT = 120_000;

export type Db = PGlite;

/** A new, empty PostgreSQL instance with the contrib modules available. */
export function emptyDb(): Promise<Db> {
  return PGlite.create({ extensions: EXTENSIONS });
}

/** Runs one SQL file verbatim. */
export async function applyFile(db: Db, path: string): Promise<void> {
  await db.exec(readFileSync(path, "utf8"));
}

export interface BuildOptions {
  /** Apply supabase/seeds/catalog.sql after the schema (default true). */
  catalog?: boolean;
}

/** Builds a new instance: bootstrap + every migration verbatim (+ catalog). */
export async function buildSchemaDb(options: BuildOptions = {}): Promise<Db> {
  const db = await emptyDb();
  await applyFile(db, BOOTSTRAP_PATH);
  for (const path of MIGRATION_PATHS) await applyFile(db, path);
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
