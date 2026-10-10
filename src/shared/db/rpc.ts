/**
 * Calls `public.<fn>(...)` over the direct connection the way PostgREST runs
 * an RPC: one statement, every argument a bound parameter with an explicit
 * cast (same shape as `rpc()` in tests/db/harness.ts). `callRpc` returns the
 * single value of a scalar function; `callRpcRows` the rows of a
 * set-returning one (`SELECT * FROM public.fn(...)`).
 *
 * postgres-js returns an array of rows and PGlite `{ rows }`; both parse int4,
 * boolean, uuid/text, text[] and jsonb to the JS values PostgREST sends.
 * Pure SQL builder module: the database is injected.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./client";

export interface RpcArg {
  value: unknown;
  cast: "uuid" | "text" | "integer" | "jsonb" | "timestamptz" | "text[]";
}

/**
 * Arguments travel as text and PostgreSQL casts them, so both drivers send the
 * same bytes: jsonb as its JSON text, text[] as an array literal with every
 * element quoted (commas, braces and quotes inside an element are data).
 */
function toParam(value: unknown, cast: RpcArg["cast"]): unknown {
  if (value === null || value === undefined) return null;
  if (cast === "jsonb") return typeof value === "string" ? value : JSON.stringify(value);
  if (cast === "text[]") {
    const items = (value as unknown[]).map((item) => `"${String(item).replace(/[\\"]/g, "\\$&")}"`);
    return `{${items.join(",")}}`;
  }
  return value;
}

/** `public.fn(arg::cast, ...)`: the name is validated, every value is a parameter. */
function invocation(fn: string, args: RpcArg[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error("Invalid RPC name.");
  const params: SQL[] = args.map(({ value, cast }) => sql`${toParam(value, cast)}::${sql.raw(cast)}`);
  return sql`${sql.raw(`public.${fn}`)}(${sql.join(params, sql`, `)})`;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

export async function callRpc<T>(db: Database, fn: string, args: RpcArg[]): Promise<T> {
  const result = await db.execute(sql`SELECT ${invocation(fn, args)} AS result`);
  return rowsOf<{ result: T }>(result)[0]?.result as T;
}

export async function callRpcRows<T>(db: Database, fn: string, args: RpcArg[]): Promise<T[]> {
  return rowsOf<T>(await db.execute(sql`SELECT * FROM ${invocation(fn, args)}`));
}
