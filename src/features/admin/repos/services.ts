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

export interface ServicesRepo {
  /** Services ordered by name; `limit` is already clamped by the caller. */
  list(limit: number): Promise<ServiceRow[]>;
  /** Insert or update by id; `null` when no row came back. */
  upsert(write: ServiceWrite): Promise<ServiceRow | null>;
}

// ---------------------------------------------------------------- supabase ---

const SERVICE_SELECT =
  "id, name, description, price, duracion_min, duracion_max, is_active";

export function supabaseServicesRepo(db: SupabaseClient): ServicesRepo {
  return {
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
