/**
 * Port of the alert inbox data access (`audit_logs` + reviewer names from
 * `users`), its supabase-js adapter and the selector.
 *
 * `supabaseAlertsRepo` holds the requests the service sent through supabase-js
 * before the extraction, unchanged. The direct PostgreSQL adapter lives in
 * `./alerts.drizzle.ts` and is loaded with import() only when
 * DB_ENGINE=postgres, so the default engine evaluates no drizzle-orm. Both
 * adapters return the same domain rows and throw `DbQueryError`; the service
 * keeps its own error mapping.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";

export interface AuditAlertRow {
  id: string;
  action: string;
  entity: string;
  entity_id: string;
  metadata: Record<string, unknown> | null;
  user_id: string | null;
  is_read: boolean;
  read_at: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  created_at: string;
}

export type ShiftAuditRow = Pick<
  AuditAlertRow,
  "entity_id" | "action" | "created_at" | "is_read" | "review_note" | "reviewed_by"
>;

export interface AlertFilters {
  actions: string[];
  unreadOnly?: boolean;
  /** Inclusive `created_at` bounds, ISO with offset. */
  from?: string;
  to?: string;
}

export interface AlertPatch {
  is_read: true;
  read_at: string;
  review_note: string;
  reviewed_by: string | null;
}

export interface VoucherAlertMatch {
  action: string;
  entity: string;
  entity_id: string;
  is_read: false;
}

export interface AlertsRepo {
  /** Exact number of rows matching the filters. */
  count(filters: AlertFilters): Promise<number>;
  /** Newest first, `limit` rows starting at `offset`. */
  list(filters: AlertFilters & { offset: number; limit: number }): Promise<AuditAlertRow[]>;
  shiftReviews(shiftIds: string[], actions: string[]): Promise<ShiftAuditRow[]>;
  /** `id, full_name` of the given users; `ids` is never empty. */
  userNames(ids: string[]): Promise<Array<{ id: string; full_name: string }>>;
  /** Updates the row by id; `null` when no row matched. */
  markRead(id: string, patch: AlertPatch): Promise<{ id: string } | null>;
  /** Updates every row that matches; nothing back. */
  resolveVoucher(match: VoucherAlertMatch, patch: AlertPatch): Promise<void>;
}

// ---------------------------------------------------------------- supabase ---

const ALERT_SELECT =
  "id, action, entity, entity_id, metadata, user_id, is_read, read_at, review_note, reviewed_by, created_at";
const SHIFT_SELECT = "entity_id, action, created_at, is_read, review_note, reviewed_by";

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

export function supabaseAlertsRepo(db: SupabaseClient): AlertsRepo {
  return {
    async count(filters) {
      let query = db.from("audit_logs").select("id", { count: "exact", head: true }).in("action", filters.actions);
      if (filters.unreadOnly) query = query.eq("is_read", false);
      if (filters.from) query = query.gte("created_at", filters.from);
      if (filters.to) query = query.lte("created_at", filters.to);
      const { count, error } = await query;
      if (error) fail(error);
      return count ?? 0;
    },
    async list(filters) {
      let query = db.from("audit_logs").select(ALERT_SELECT).in("action", filters.actions);
      if (filters.unreadOnly) query = query.eq("is_read", false);
      if (filters.from) query = query.gte("created_at", filters.from);
      if (filters.to) query = query.lte("created_at", filters.to);
      // Total, stable pagination contract: ties on created_at are resolved by id.
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(filters.offset, filters.offset + filters.limit - 1);
      if (error) fail(error);
      return (data ?? []) as AuditAlertRow[];
    },
    async shiftReviews(shiftIds, actions) {
      const { data, error } = await db
        .from("audit_logs")
        .select(SHIFT_SELECT)
        .eq("entity", "cash_shifts")
        .in("entity_id", shiftIds)
        .in("action", actions);
      if (error) fail(error);
      return (data ?? []) as ShiftAuditRow[];
    },
    async userNames(ids) {
      const { data, error } = await db.from("users").select("id, full_name").in("id", ids);
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string; full_name: string }>;
    },
    async markRead(id, patch) {
      const { data, error } = await db
        .from("audit_logs")
        .update(patch)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      if (error) fail(error);
      return (data ?? null) as { id: string } | null;
    },
    async resolveVoucher(match, patch) {
      const { error } = await db.from("audit_logs").update(patch).match(match);
      if (error) fail(error);
    },
  };
}

// ---------------------------------------------------------------- selector ---

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function alertsRepo(): Promise<AlertsRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleAlertsRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./alerts.drizzle"),
    ]);
    return drizzleAlertsRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseAlertsRepo(createAdminClient());
}
