/**
 * A supabase-js double that answers through the SAME PGlite instance the
 * Drizzle adapter uses, the way PostgREST does: every result is serialized by
 * PostgreSQL itself (`json_agg` / `to_json`), so timestamps, numerics and
 * jsonb arrive in exactly the JSON PostgREST would send, and a database error
 * arrives as `{ code, message, details }` with the SQLSTATE.
 *
 * It covers only the builder calls the repositories use: select (plain
 * column lists and a many-to-one embed `table(col)` resolved through the
 * `<singular>_id` foreign key, an object or null like PostgREST), count exact
 * head, in/eq/neq/is/gte/lte/match, `or` with `ilike`/`eq`/`is.null` items, order,
 * range/limit, insert/upsert of one row or an array (upsert with an
 * onConflict column list, default id), update, delete, single and maybeSingle
 * (PGRST116 when the row count does not fit), and `rpc` with PostgREST's named
 * arguments (resolved against pg_proc, result serialized with to_json).
 *
 * `or()` parses PostgREST's logic-tree grammar: a double-quoted value with `\`
 * escapes, or an unquoted value that ends at `,` or `)`; `*` becomes `%` in a
 * like value. That is what makes the quoting of a search observable here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "./harness";

type Result = { data: unknown; count?: number | null; error: unknown };
type Filter =
  | { column: string; op: "=" | "<>" | ">=" | "<=" | "in" | "is"; value: unknown }
  | { op: "or"; items: OrItem[] };

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A PostgREST error object from a PostgreSQL error, as PostgREST sends it. */
function toPostgrestError(raw: unknown) {
  const error = raw as { code?: string; message: string; detail?: string };
  return { code: error.code ?? null, message: error.message, details: error.detail ?? null };
}

type OrItem = { column: string; op: "ilike" | "eq" | "is"; value: string };

/** `col.ilike.value,col.ilike."value"` -> items; the PostgREST logic-tree grammar. */
export function parseOrIlike(tree: string): Array<{ column: string; value: string }> {
  return parseOrTree(tree).map((item) => {
    if (item.op !== "ilike") throw new Error(`unsupported or() item: ${item.column}.${item.op}`);
    return { column: item.column, value: item.value };
  });
}

/** `col.ilike|eq|is.value` items; `is` accepts only `null`, `*` is `%` only in ilike. */
export function parseOrTree(tree: string): OrItem[] {
  const items: OrItem[] = [];
  let rest = tree;
  while (rest.length > 0) {
    const head = /^([a-z_]+)\.(ilike|eq|is)\./.exec(rest);
    if (!head) throw new Error(`unsupported or() item: ${rest}`);
    const op = head[2] as OrItem["op"];
    rest = rest.slice(head[0].length);
    let value = "";
    if (rest.startsWith('"')) {
      let index = 1;
      for (; index < rest.length && rest[index] !== '"'; index += 1) {
        if (rest[index] === "\\") index += 1;
        value += rest[index];
      }
      rest = rest.slice(index + 1);
    } else {
      const end = rest.search(/[,)]/);
      value = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? "" : rest.slice(end);
    }
    if (op === "is" && value !== "null") throw new Error(`unsupported is value: ${value}`);
    items.push({ column: head[1], op, value: op === "ilike" ? value.replace(/\*/g, "%") : value });
    if (rest.startsWith(",")) rest = rest.slice(1);
    else if (rest.length > 0) throw new Error(`malformed or() filter near: ${rest}`);
  }
  return items;
}

async function rpc(pg: Db, fn: string, args: Record<string, unknown> = {}): Promise<{ data: unknown; error: unknown }> {
  const { rows } = await pg.query<{ name: string; type: string; returns_set: boolean }>(
    `SELECT unnest(p.proargnames) AS name, unnest(string_to_array(oidvectortypes(p.proargtypes), ', ')) AS type, p.proretset AS returns_set
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [fn],
  );
  const types = new Map(rows.map((row) => [row.name, row.type]));
  const params: unknown[] = [];
  const named = Object.entries(args).map(([name, value]) => {
    const type = types.get(name);
    if (!type) throw new Error(`rpc ${fn}: unknown argument ${name}`);
    params.push(type === "jsonb" && value !== null ? JSON.stringify(value) : value);
    return `${ident(name)} => $${params.length}::${type}`;
  });
  try {
    const returnsSet = rows[0]?.returns_set === true;
    const statement = returnsSet
      ? `SELECT coalesce(json_agg(result), '[]'::json) AS result FROM (SELECT * FROM public.${ident(fn)}(${named.join(", ")})) result`
      : `SELECT to_json(public.${ident(fn)}(${named.join(", ")})) AS result`;
    const result = await pg.query<{ result: unknown }>(statement, params);
    return { data: result.rows[0].result, error: null };
  } catch (raw) {
    return { data: null, error: toPostgrestError(raw) };
  }
}

export interface AuthAdminDouble {
  createUser(values: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export function postgrestDouble(
  pg: Db,
  authAdmin?: AuthAdminDouble,
  onRpc?: (fn: string, args: Record<string, unknown>) => void,
): SupabaseClient {
  return {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      const named = args ?? {};
      onRpc?.(fn, named);
      return rpc(pg, fn, named);
    },
    auth: { admin: authAdmin },

    from(table: string) {
      let columns = "*";
      let head = false;
      let count = false;
      let write:
        | {
            kind: "insert" | "update" | "upsert" | "delete";
            values: Record<string, unknown> | Record<string, unknown>[];
            onConflict?: string;
          }
        | null = null;
      const inner: string[] = [];
      let returning = false;
      const filters: Filter[] = [];
      const orders: string[] = [];
      let limit: number | null = null;
      let offset = 0;

      const where = (params: unknown[]) => {
        if (filters.length === 0) return "";
        return ` WHERE ${filters
          .map((filter) => {
            if (filter.op === "or") {
              return `(${filter.items
                .map((item) => {
                  if (item.op === "is") return `${ident(item.column)} IS NULL`;
                  params.push(item.value);
                  // `eq` compares as text: PostgREST hands the literal to the column's input
                  // function, so a malformed uuid is still data (22P02), never syntax.
                  return item.op === "eq"
                    ? `${ident(item.column)} = $${params.length}`
                    : `${ident(item.column)} ILIKE $${params.length}`;
                })
                .join(" OR ")})`;
            }
            if (filter.op === "is") return `${ident(filter.column)} IS NULL`;
            params.push(filter.value);
            return filter.op === "in"
              ? `${ident(filter.column)}::text = ANY($${params.length}::text[])`
              : `${ident(filter.column)} ${filter.op} $${params.length}`;
          })
          .join(" AND ")}`;
      };

      const statement = (params: unknown[]): string => {
        const projection = (() => {
          const parts: string[] = [];
          let rest = columns;
          while (rest.length > 0) {
            const embedded = /^([a-z_]+)(?:!([a-z_]+))?\(([a-z_, ]+)\)(?:,\s*|$)/.exec(rest);
            if (embedded) {
              parts.push(embedded[0].replace(/,\s*$/, ""));
              rest = rest.slice(embedded[0].length);
              continue;
            }
            const plain = /^([^,]+)(?:,\s*|$)/.exec(rest);
            if (!plain) throw new Error(`unsupported select: ${rest}`);
            parts.push(plain[1]);
            rest = rest.slice(plain[0].length);
          }
          return parts;
        })()
          .map((column) => {
            const embed = /^([a-z_]+)(?:!([a-z_]+))?\(([a-z_, ]+)\)$/.exec(column.trim());
            if (!embed) return ident(column.trim());
            // Many-to-one embed: the row of `target` its foreign key points to.
            // `!<table>_<column>_fkey` names the FK column; `!inner` keeps only
            // rows whose embed exists (applied in `where`).
            const [, target, hint, list] = embed;
            const fields = list.split(",").map((field) => `'${field.trim()}', e.${ident(field.trim())}`);
            const named = hint && hint !== "inner" ? /^[a-z]+_([a-z_]+)_fkey$/.exec(hint)?.[1] : undefined;
            const fk = named ?? `${target.replace(/s$/, "")}_id`;
            if (hint === "inner") inner.push(`EXISTS (SELECT 1 FROM public.${ident(target)} e WHERE e.id = t.${ident(fk)})`);
            return `(SELECT json_build_object(${fields.join(", ")}) FROM public.${ident(target)} e WHERE e.id = t.${ident(fk)}) AS ${ident(target)}`;
          })
          .join(", ");
        if (write) {
          // PostgREST takes one object or an array (one multi-row statement).
          const writeRows = (Array.isArray(write.values) ? write.values : [write.values]) as Record<string, unknown>[];
          const keys = Object.keys(writeRows[0] ?? {});
          const placeholder = (value: unknown) => {
            params.push(value);
            return `$${params.length}`;
          };
          // PostgREST `on_conflict` + merge-duplicates: the arbiter is the given
          // column list (default the primary key) and every SENT key is set from
          // `excluded`, including `id` when the payload carries it.
          const target = (write.onConflict ?? "id").split(",").map((column) => ident(column.trim())).join(", ");
          let body: string;
          if (write.kind === "delete") {
            body = `DELETE FROM public.${ident(table)} t${where(params)}`;
          } else if (write.kind === "update") {
            const set = keys.map((key) => `${ident(key)} = ${placeholder(writeRows[0][key])}`).join(", ");
            body = `UPDATE public.${ident(table)} SET ${set}${where(params)}`;
          } else {
            const rows = writeRows.map((row) => `(${keys.map((key) => placeholder(row[key])).join(", ")})`).join(", ");
            body =
              `INSERT INTO public.${ident(table)} (${keys.map(ident).join(", ")}) VALUES ${rows}` +
              (write.kind === "upsert"
                ? ` ON CONFLICT (${target}) DO UPDATE SET ${keys.map((key) => `${ident(key)} = excluded.${ident(key)}`).join(", ")}`
                : "");
          }
          return `WITH w AS (${body} RETURNING ${returning ? projection : "1 AS x"}) SELECT coalesce(json_agg(w), '[]'::json) AS rows FROM w`;
        }
        const filtered = where(params);
        const innerClause = inner.length ? `${filtered ? " AND " : " WHERE "}${inner.join(" AND ")}` : "";
        const base = `SELECT ${projection} FROM public.${ident(table)} t${filtered}${innerClause}`;
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
          return { error: toPostgrestError(raw) };
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
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          write = { kind: "insert", values };
          return query;
        },
        update(values: Record<string, unknown>) {
          write = { kind: "update", values };
          return query;
        },
        upsert(values: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) {
          write = { kind: "upsert", values, onConflict: options?.onConflict };
          return query;
        },
        delete() {
          write = { kind: "delete", values: {} };
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, op: "=", value });
          return query;
        },
        neq(column: string, value: unknown) {
          filters.push({ column, op: "<>", value });
          return query;
        },
        is(column: string, value: null) {
          if (value !== null) throw new Error("is() supports only null");
          filters.push({ column, op: "is", value });
          return query;
        },
        or(tree: string) {
          filters.push({ op: "or", items: parseOrTree(tree) });
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
