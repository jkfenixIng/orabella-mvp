import {
  ALERT_ACTIONS,
  ALERT_MODULES,
  ALERTS_PAGE_SIZE,
  alertsQuerySchema,
  buildVoucherAlertResolution,
  reviewNoteSchema,
  voucherAlertFilter,
  type AlertModule,
  type ShiftAuditState,
} from "./schemas";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";

export class AlertError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AlertError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function alertsDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

type DbClient = Awaited<ReturnType<typeof alertsDb>>;

export interface AlertActor {
  userId: string;
  sedeId: string;
}

export interface AlertRow {
  id: string;
  action: string;
  entity: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  user_id: string | null;
  user_name: string | null;
  is_read: boolean;
  read_at: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  created_at: string;
}

export interface AlertsResult {
  alerts: AlertRow[];
  page: number;
  pageSize: number;
  total: number;
}

const ALERT_SELECT =
  "id, action, entity, entity_id, metadata, user_id, is_read, read_at, review_note, reviewed_by, created_at";

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/**
 * Deriva por esquema desactualizado (p. ej. migraciones 011/012 sin
 * aplicar en la base a la que apunta la app) a un error accionable en
 * vez de un "Error interno" opaco.
 */
function toAlertError(error: { message?: string } | null): AlertError {
  const message = error?.message ?? "";
  if (/column .* does not exist|relation .* does not exist/i.test(message)) {
    return new AlertError(
      "SCHEMA_MISMATCH",
      "Falta aplicar las migraciones de alertas (011/012) en esta base.",
      500,
    );
  }
  return new AlertError("INTERNAL", "Error interno.", 500);
}

async function userNames(
  db: DbClient,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("users").select("id, full_name").in("id", ids);
  if (error) throw new AlertError("INTERNAL", "Error interno.", 500);
  const names = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; full_name: string }>) {
    names.set(row.id, row.full_name);
  }
  return names;
}

/**
 * Bandeja del admin: alertas de su sede, más recientes primero, paginadas
 * en servidor para que ningún rango esconda avisos.
 */
export async function listAlerts(
  sedeId: string,
  raw: unknown,
): Promise<AlertsResult> {
  const parsed = alertsQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AlertError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { unreadOnly, page, module } = parsed.data;
  const actions = module ? [...ALERT_MODULES[module].actions] : [...ALERT_ACTIONS];
  const db = await alertsDb();
  let countQuery = db
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("sede_id", sedeId)
    .in("action", actions);
  if (unreadOnly) countQuery = countQuery.eq("is_read", false);
  const { count, error: countError } = await countQuery;
  if (countError) throw toAlertError(countError);
  const total = count ?? 0;
  const offset = (page - 1) * ALERTS_PAGE_SIZE;
  let query = db
    .from("audit_logs")
    .select(ALERT_SELECT)
    .eq("sede_id", sedeId)
    .in("action", actions);
  if (unreadOnly) query = query.eq("is_read", false);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + ALERTS_PAGE_SIZE - 1);
  if (error) throw toAlertError(error);
  const rows = (data ?? []) as Array<{
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
  }>;
  const names = await userNames(
    db,
    rows.flatMap((row) => [row.user_id, row.reviewed_by]),
  );
  return {
    alerts: rows.map((row) => ({
      id: row.id,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      metadata: row.metadata ?? {},
      user_id: row.user_id,
      user_name: row.user_id ? (names.get(row.user_id) ?? null) : null,
      is_read: row.is_read,
      read_at: row.read_at,
      review_note: row.review_note,
      reviewed_by: row.reviewed_by,
      reviewed_by_name: row.reviewed_by ? (names.get(row.reviewed_by) ?? null) : null,
      created_at: row.created_at,
    })),
    page,
    pageSize: ALERTS_PAGE_SIZE,
    total,
  };
}

export interface ShiftReview {
  shiftId: string;
  audits: ShiftAuditState[];
}

/**
 * Auditorías de desajuste (apertura y cierre) de varios turnos, para el
 * estado de revisión de las vistas de caja.
 */
export async function getShiftReviews(
  sedeId: string,
  shiftIds: string[],
): Promise<Map<string, ShiftAuditState[]>> {
  const result = new Map<string, ShiftAuditState[]>();
  if (shiftIds.length === 0) return result;
  const db = await alertsDb();
  const { data, error } = await db
    .from("audit_logs")
    .select("entity_id, action, created_at, is_read, review_note, reviewed_by")
    .eq("sede_id", sedeId)
    .eq("entity", "cash_shifts")
    .in("entity_id", shiftIds)
    .in("action", [AUDIT_ACTIONS.SHIFT_OPEN_MISMATCH, AUDIT_ACTIONS.SHIFT_CLOSE_MISMATCH]);
  if (error) throw toAlertError(error);
  const rows = (data ?? []) as Array<{
    entity_id: string;
    action: string;
    created_at: string;
    is_read: boolean;
    review_note: string | null;
    reviewed_by: string | null;
  }>;
  const names = await userNames(
    db,
    rows.map((row) => row.reviewed_by),
  );
  for (const row of rows) {
    const list = result.get(row.entity_id) ?? [];
    list.push({
      action: row.action,
      fecha: row.created_at,
      revisada: row.is_read,
      justificacion: row.review_note,
      revisor: row.reviewed_by ? (names.get(row.reviewed_by) ?? null) : null,
    });
    result.set(row.entity_id, list);
  }
  return result;
}
/** Sin leer de la sede, opcionalmente de un módulo (insignia del menú). */
export async function countUnreadAlerts(sedeId: string, module?: AlertModule): Promise<number> {
  const db = await alertsDb();
  const actions = module ? [...ALERT_MODULES[module].actions] : [...ALERT_ACTIONS];
  const { count, error } = await db
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("sede_id", sedeId)
    .in("action", actions)
    .eq("is_read", false);
  if (error) throw toAlertError(error);
  return count ?? 0;
}

/** Revisa una alerta con justificación obligatoria (acotado a su sede). */
export async function markAlertRead(
  sedeId: string,
  id: string,
  raw: unknown,
  actor: AlertActor,
): Promise<{ id: string }> {
  const parsed = reviewNoteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AlertError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const db = await alertsDb();
  const { data, error } = await db
    .from("audit_logs")
    .update({
      is_read: true,
      read_at: new Date().toISOString(),
      review_note: parsed.data.note,
      reviewed_by: actor.userId,
    })
    .eq("id", id)
    .eq("sede_id", sedeId)
    .select("id")
    .maybeSingle();
  if (error) throw toAlertError(error);
  if (!data) throw new AlertError("NOT_FOUND", "Alerta no encontrada.", 404);
  return { id: (data as { id: string }).id };
}

/**
 * Cierra la alerta pendiente de un vale ya revisado (aprobado o rechazado).
 * La alerta decía "hay un vale pendiente de revisar": una vez revisado, ya no
 * aplica. Reutiliza el mecanismo de la bandeja (`is_read`/`read_at`/
 * `review_note`/`reviewed_by`), sin estados nuevos, y filtra por `entity_id`
 * + `is_read:false` para ser idempotente y no pisar otras alertas.
 *
 * NUNCA lanza: aprobar/rechazar el vale ya quedó aplicado y auditado, así que
 * un fallo al cerrar la alerta no debe tumbar la operación de negocio (la
 * alerta seguiría en la bandeja para revisarla a mano).
 */
export async function resolveVoucherAlert(
  sedeId: string,
  voucherId: string,
  reviewedBy: string | null,
  note: string,
): Promise<{ resolved: boolean }> {
  try {
    const db = await alertsDb();
    const { error } = await db
      .from("audit_logs")
      .update(buildVoucherAlertResolution({ reviewedBy, note }))
      .match(voucherAlertFilter(sedeId, voucherId));
    if (error) {
      console.error("[alerts] no se pudo cerrar la alerta del vale:", error.message);
      return { resolved: false };
    }
    return { resolved: true };
  } catch (error) {
    console.error(
      "[alerts] no se pudo cerrar la alerta del vale:",
      error instanceof Error ? error.message : error,
    );
    return { resolved: false };
  }
}
