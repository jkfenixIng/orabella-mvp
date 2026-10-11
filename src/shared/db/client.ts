/**
 * Direct PostgreSQL connection (Drizzle + postgres-js), used only when
 * `DB_ENGINE=postgres`. SERVER ONLY: load it with a dynamic `import()` from a
 * service, the same way `@/src/shared/lib/supabase/server` is loaded, so no
 * client bundle and no unit test without a database ever evaluates it.
 * `tests/db-architecture.test.ts` forbids importing it from `app/` or from a
 * "use client" module.
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDbConfig } from "@/src/shared/config/env";
import * as schema from "./schema";

export type Schema = typeof schema;

/**
 * The database a repository receives. Driver-agnostic on purpose: production
 * passes the postgres-js instance below and the tests pass a PGlite one.
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

type Connection = { url: string; sql: postgres.Sql; db: Database };

/**
 * One connection per process, kept on `globalThis` so it survives Next's HMR in
 * development and is reused across invocations of a warm serverless instance.
 */
const holder = globalThis as typeof globalThis & { __orabellaDb?: Connection };

/**
 * Pool sized for a serverless function behind the Supabase pooler in
 * transaction mode: one connection per instance, released when idle, and no
 * prepared statements (transaction mode cannot keep them across transactions).
 */
const POOL = { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 } as const;

export function getDb(): Database {
  const config = getDbConfig();
  if (config.engine !== "postgres") {
    throw new Error("getDb() requires DB_ENGINE=postgres.");
  }
  const cached = holder.__orabellaDb;
  if (cached && cached.url === config.databaseUrl) return cached.db;
  // The URL changed (dev reload with a new .env): release the old pool instead
  // of leaking its connection. In-flight queries get up to 5 s to finish.
  if (cached) void cached.sql.end({ timeout: 5 });
  const sql = postgres(config.databaseUrl, POOL);
  const db = drizzle({ client: sql, schema });
  holder.__orabellaDb = { url: config.databaseUrl, sql, db };
  return db;
}
