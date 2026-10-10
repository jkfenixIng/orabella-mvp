/**
 * A supabase-js double that answers through the SAME PGlite instance the
 * Drizzle adapter uses, the way PostgREST does: every result is serialized by
 * PostgreSQL itself (`json_agg` / `to_json`), so timestamps, numerics and
 * jsonb arrive in exactly the JSON PostgREST would send, and a database error
 * arrives as `{ code, message, details }` with the SQLSTATE.
 *
 * It covers only the builder calls the repositories use: select (plain
 * column lists), count exact head, in/eq/gte/lte/match, order, range/limit,
 * insert/update/upsert(onConflict id), single and maybeSingle (PGRST116 when
 * the row count does not fit, like PostgREST).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./harness";

type Result = { data: unknown; count?: number | null; error: unknown };
type Filter = { column: string; op: "=" | ">=" | "<=" | "in"; value: unknown };

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function postgrestDouble(pg: Db): SupabaseClient {
  return {
    from(table: string) {
      let columns = "*";
      let head = false;
      let count = false;
      let write: { kind: "insert" | "update" | "upsert"; values: Record<string, unknown> } | null = null;
      let returning = false;
      const filters: Filter[] = [];
      const orders: string[] = [];
      let limit: number | null = null;
      let offset = 0;

      const where = (params: unknown[]) => {
        if (filters.length === 0) return "";
        return ` WHERE ${filters
          .map((filter) => {
            params.push(filter.value);
            return filter.op === "in"
              ? `${ident(filter.column)}::text = ANY($${params.length}::text[])`
              : `${ident(filter.column)} ${filter.op} $${params.length}`;
          })
          .join(" AND ")}`;
      };

      const statement = (params: unknown[]): string => {
        const projection = columns
          .split(",")
          .map((column) => ident(column.trim()))
          .join(", ");
        if (write) {
          const keys = Object.keys(write.values);
          const values = keys.map((key) => {
            params.push(write!.values[key]);
            return `$${params.length}`;
          });
          const body =
            write.kind === "update"
              ? `UPDATE public.${ident(table)} SET ${keys.map((key, index) => `${ident(key)} = ${values[index]}`).join(", ")}${where(params)}`
              : `INSERT INTO public.${ident(table)} (${keys.map(ident).join(", ")}) VALUES (${values.join(", ")})` +
                (write.kind === "upsert"
                  ? ` ON CONFLICT (id) DO UPDATE SET ${keys.map((key) => `${ident(key)} = excluded.${ident(key)}`).join(", ")}`
                  : "");
          return `WITH w AS (${body} RETURNING ${returning ? projection : "1 AS x"}) SELECT coalesce(json_agg(w), '[]'::json) AS rows FROM w`;
        }
        const base = `SELECT ${projection} FROM public.${ident(table)}${where(params)}`;
        if (head) return `SELECT count(*)::int AS n FROM (${base}) q`;
        const order = orders.length ? ` ORDER BY ${orders.join(", ")}` : "";
        const window = `${limit !== null ? ` LIMIT ${limit}` : ""}${offset ? ` OFFSET ${offset}` : ""}`;
        return `SELECT coalesce(json_agg(q), '[]'::json) AS rows FROM (${base}${order}${window}) q`;
      };

      const execute = async (): Promise<{ rows: unknown[]; n?: number } | { error: unknown }> => {
        const params: unknown[] = [];
        try {
          const result = await pg.query<{ rows?: unknown[]; n?: number }>(statement(params), params);
          const row = result.rows[0];
          return head ? { rows: [], n: row.n } : { rows: (row.rows ?? []) as unknown[] };
        } catch (raw) {
          const error = raw as { code?: string; message: string; detail?: string };
          return { error: { code: error.code ?? null, message: error.message, details: error.detail ?? null } };
        }
      };

      const many = async (): Promise<Result> => {
        const outcome = await execute();
        if ("error" in outcome) return { data: null, count: null, error: outcome.error };
        if (head) return { data: null, count: outcome.n ?? 0, error: null };
        return { data: write && !returning ? null : outcome.rows, count: count ? outcome.rows.length : null, error: null };
      };

      const one = (allowEmpty: boolean) => async (): Promise<Result> => {
        const outcome = await execute();
        if ("error" in outcome) return { data: null, error: outcome.error };
        if (outcome.rows.length === 1) return { data: outcome.rows[0], error: null };
        if (outcome.rows.length === 0 && allowEmpty) return { data: null, error: null };
        return {
          data: null,
          error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `${outcome.rows.length} rows` },
        };
      };

      const query = {
        select(list = "*", options?: { count?: string; head?: boolean }) {
          columns = list;
          if (write) returning = true;
          count = options?.count === "exact";
          head = options?.head === true;
          return query;
        },
        insert(values: Record<string, unknown>) {
          write = { kind: "insert", values };
          return query;
        },
        update(values: Record<string, unknown>) {
          write = { kind: "update", values };
          return query;
        },
        upsert(values: Record<string, unknown>) {
          write = { kind: "upsert", values };
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, op: "=", value });
          return query;
        },
        gte(column: string, value: unknown) {
          filters.push({ column, op: ">=", value });
          return query;
        },
        lte(column: string, value: unknown) {
          filters.push({ column, op: "<=", value });
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push({ column, op: "in", value: values.map(String) });
          return query;
        },
        match(values: Record<string, unknown>) {
          for (const [column, value] of Object.entries(values)) filters.push({ column, op: "=", value });
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push(`${ident(column)} ${options?.ascending === false ? "DESC" : "ASC"}`);
          return query;
        },
        limit(value: number) {
          limit = value;
          return query;
        },
        range(from: number, to: number) {
          offset = from;
          limit = to - from + 1;
          return query;
        },
        single: one(false),
        maybeSingle: one(true),
        then(onFulfilled?: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) {
          return many().then(onFulfilled, onRejected);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}
