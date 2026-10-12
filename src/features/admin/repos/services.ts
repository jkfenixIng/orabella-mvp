/**
 * Port of the service catalog (ADM-05), its supabase-js adapter and the
 * selector.
 *
 * `supabaseServicesRepo` is the request the service sent through supabase-js
 * before the extraction, moved here unchanged. The direct PostgreSQL adapter
 * lives in `./services.drizzle.ts` and is loaded on demand, so the default
 * `supabase` engine loads neither drizzle-orm nor the postgres driver. Both
 * adapters return the same domain rows and throw `DbQueryError` on a database
 * failure; the service turns that into its own `AdminError`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";

export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  duracion_min: number;
  duracion_max: number;
  is_active: boolean;
}

/** Validated write: `id` updates that row, its absence inserts a new one. */
export interface ServiceWrite {
  id?: string;
  name: string;
  description: string | null;
  price: number;
  duracion_min: number;
  duracion_max: number;
  is_active?: boolean;
}

export interface ServicePage {
  rows: ServiceRow[];
  total: number;
}

export interface ServicePageQuery {
  query: string;
  active?: boolean;
  limit: number;
  offset: number;
}

export interface ServicesRepo {
  /** Services ordered by name; `limit` is already clamped by the caller. */
  list(limit: number): Promise<ServiceRow[]>;
  listPage(query: ServicePageQuery): Promise<ServicePage>;
  /** Insert or update by id; `null` when no row came back. */
  upsert(write: ServiceWrite): Promise<ServiceRow | null>;
}

// ---------------------------------------------------------------- supabase ---

const SERVICE_SELECT =
  "id, name, description, price, duracion_min, duracion_max, is_active";

/** LIKE pattern with `\`, `%` and `_` escaped, so the needle is literal text. */
export function containsPattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** A PostgREST double-quoted value: commas and parentheses stay data. */
function quotePostgrest(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

export function supabaseServicesRepo(db: SupabaseClient): ServicesRepo {
  return {
    async listPage({ query, active, limit, offset }) {
      let request = db.from("services").select(SERVICE_SELECT, { count: "exact" });
      const needle = query.trim();
      if (needle !== "") {
        const pattern = quotePostgrest(containsPattern(needle));
        request = request.or(`name.ilike.${pattern},description.ilike.${pattern}`);
      }
      if (active !== undefined) request = request.eq("is_active", active);
      const { data, error, count } = await request
        .order("name")
        .order("id")
        .range(offset, offset + limit - 1);
      if (error) throw new DbQueryError(toDbError(error));
      return { rows: (data ?? []) as ServiceRow[], total: count ?? 0 };
    },
    async list(limit) {
      const { data, error } = await db
        .from("services")
        .select(SERVICE_SELECT)
        .order("name")
        .limit(limit);
      if (error) throw new DbQueryError(toDbError(error));
      return (data ?? []) as ServiceRow[];
    },
    async upsert(payload) {
      const { data, error } = await db
        .from("services")
        .upsert(payload, { onConflict: "id" })
        .select(SERVICE_SELECT)
        .single();
      if (error) throw new DbQueryError(toDbError(error));
      return (data ?? null) as ServiceRow | null;
    },
  };
}

// ---------------------------------------------------------------- selector ---

/**
 * The adapter for the configured engine. Every engine-specific module is
 * loaded on demand (server only): with the default `supabase` engine nothing
 * from drizzle-orm, postgres-js or `src/shared/db/client.ts` is evaluated.
 */
export async function servicesRepo(): Promise<ServicesRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleServicesRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./services.drizzle"),
    ]);
    return drizzleServicesRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseServicesRepo(createAdminClient());
}
