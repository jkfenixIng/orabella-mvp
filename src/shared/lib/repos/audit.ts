/**
 * Dual persistence port for audit_logs. It is server-only by construction:
 * postgres imports are dynamic and only happen with DB_ENGINE=postgres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";

export interface AuditWrite {
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  metadata: Record<string, unknown>;
}

export interface AuditRepo {
  insert(entry: AuditWrite): Promise<void>;
}

export function supabaseAuditRepo(db: SupabaseClient): AuditRepo {
  return {
    async insert(entry) {
      const { error } = await db.from("audit_logs").insert(entry);
      if (error) throw new DbQueryError(toDbError(error));
    },
  };
}

export async function auditRepo(): Promise<AuditRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleAuditRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./audit.drizzle"),
    ]);
    return drizzleAuditRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseAuditRepo(createAdminClient());
}
