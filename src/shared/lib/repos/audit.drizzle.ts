/**
 * Direct PostgreSQL adapter of the audit port (`./audit.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * Same INSERT as the PostgREST request: the five payload columns, every other
 * column (id, created_at, is_read...) from its database default.
 *
 * A failure carries only the SQLSTATE: a PostgreSQL message can quote an input
 * value (`invalid input syntax for type uuid: "..."`) and Drizzle's own message
 * lists every bound parameter, and `writeAudit` logs this message.
 */
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { auditLogs } from "@/src/shared/db/schema";
import type { AuditRepo } from "./audit";

export function drizzleAuditRepo(db: Database): AuditRepo {
  return {
    async insert(entry) {
      try {
        await db.insert(auditLogs).values({
          userId: entry.user_id,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entity_id,
          metadata: entry.metadata,
        });
      } catch (error) {
        const { code } = toDbError(error);
        throw new DbQueryError({ code, message: `audit_logs insert failed (SQLSTATE ${code ?? "unknown"})`, details: null });
      }
    },
  };
}
