/**
 * Direct PostgreSQL adapter of the alerts port (`./alerts.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * Equivalences with the supabase-js adapter:
 * - `count(*)` is the `count: "exact", head: true` answer.
 * - `limit/offset` is `.range(offset, offset + limit - 1)`, and both adapters
 *   order by `created_at DESC, id DESC` (a total order: pages never repeat or
 *   skip a row when several alerts share the same instant).
 * - Timestamps go through `toPostgrestTimestamp` (same string as PostgREST).
 */
import { and, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { auditLogs, users } from "@/src/shared/db/schema";
import { toPostgrestTimestamp } from "@/src/shared/db/timestamps";
import type { AlertFilters, AlertPatch, AlertsRepo, AuditAlertRow, VoucherAlertMatch } from "./alerts";

const ALERT_COLUMNS = {
  id: auditLogs.id,
  action: auditLogs.action,
  entity: auditLogs.entity,
  entity_id: auditLogs.entityId,
  metadata: auditLogs.metadata,
  user_id: auditLogs.userId,
  is_read: auditLogs.isRead,
  read_at: auditLogs.readAt,
  review_note: auditLogs.reviewNote,
  reviewed_by: auditLogs.reviewedBy,
  created_at: auditLogs.createdAt,
};

const SHIFT_COLUMNS = {
  entity_id: auditLogs.entityId,
  action: auditLogs.action,
  created_at: auditLogs.createdAt,
  is_read: auditLogs.isRead,
  review_note: auditLogs.reviewNote,
  reviewed_by: auditLogs.reviewedBy,
};

function where(filters: AlertFilters): SQL | undefined {
  return and(
    inArray(auditLogs.action, filters.actions),
    filters.unreadOnly ? eq(auditLogs.isRead, false) : undefined,
    filters.from ? gte(auditLogs.createdAt, filters.from) : undefined,
    filters.to ? lte(auditLogs.createdAt, filters.to) : undefined,
  );
}

function patchColumns(patch: AlertPatch) {
  return { isRead: patch.is_read, readAt: patch.read_at, reviewNote: patch.review_note, reviewedBy: patch.reviewed_by };
}

async function run<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new DbQueryError(toDbError(error));
  }
}

export function drizzleAlertsRepo(db: Database): AlertsRepo {
  return {
    count: (filters) =>
      run(async () => {
        const [row] = await db.select({ total: count() }).from(auditLogs).where(where(filters));
        return Number(row?.total ?? 0);
      }),
    list: (filters) =>
      run(async () => {
        const rows = await db
          .select(ALERT_COLUMNS)
          .from(auditLogs)
          .where(where(filters))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(filters.limit)
          .offset(filters.offset);
        return rows.map(
          (row): AuditAlertRow => ({
            ...row,
            read_at: toPostgrestTimestamp(row.read_at),
            created_at: toPostgrestTimestamp(row.created_at),
          }),
        );
      }),
    shiftReviews: (shiftIds, actions) =>
      run(async () => {
        const rows = await db
          .select(SHIFT_COLUMNS)
          .from(auditLogs)
          .where(
            and(eq(auditLogs.entity, "cash_shifts"), inArray(auditLogs.entityId, shiftIds), inArray(auditLogs.action, actions)),
          );
        return rows.map((row) => ({ ...row, created_at: toPostgrestTimestamp(row.created_at) }));
      }),
    userNames: (ids) =>
      run(() => db.select({ id: users.id, full_name: users.fullName }).from(users).where(inArray(users.id, ids))),
    markRead: (id, patch) =>
      run(async () => {
        const rows = await db
          .update(auditLogs)
          .set(patchColumns(patch))
          .where(eq(auditLogs.id, id))
          .returning({ id: auditLogs.id });
        return rows[0] ?? null;
      }),
    resolveVoucher: (match: VoucherAlertMatch, patch) =>
      run(async () => {
        await db
          .update(auditLogs)
          .set(patchColumns(patch))
          .where(
            and(
              eq(auditLogs.action, match.action),
              eq(auditLogs.entity, match.entity),
              eq(auditLogs.entityId, match.entity_id),
              eq(auditLogs.isRead, match.is_read),
            ),
          );
      }),
  };
}
