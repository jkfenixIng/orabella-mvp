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

const RPC_CASTS = [
  "uuid",
  "text",
  "integer",
  "numeric",
  "boolean",
  "jsonb",
  "timestamptz",
  "text[]",
  "uuid[]",
] as const;

export interface RpcArg {
  value: unknown;
  cast: (typeof RPC_CASTS)[number];
}

/**
 * Arguments travel as bound parameters and PostgreSQL casts them: jsonb as its
 * JSON text (a string is taken as already serialized), arrays as an array
 * literal with every element quoted (commas, braces and quotes are data).
 * Booleans and numbers stay parameters too; nothing is interpolated.
 */
function toParam(value: unknown, cast: RpcArg["cast"]): unknown {
  if (value === null || value === undefined) return null;
  if (cast === "jsonb") return typeof value === "string" ? value : JSON.stringify(value);
  if (cast === "text[]" || cast === "uuid[]") {
    const items = (value as unknown[]).map((item) => `"${String(item).replace(/[\\"]/g, "\\$&")}"`);
    return `{${items.join(",")}}`;
  }
  return value;
}

/** `public.fn(arg::cast, ...)`: the name is validated, every value is a parameter. */
function invocation(fn: string, args: RpcArg[]): SQL {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(fn)) throw new Error("Invalid RPC name.");
  for (const { cast } of args) {
    if (!(RPC_CASTS as readonly string[]).includes(cast)) throw new Error("Invalid RPC cast.");
  }
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
