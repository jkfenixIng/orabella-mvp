import {
  ALERT_ACTIONS,
  ALERT_MODULES,
  ALERTS_PAGE_SIZE,
  alertDateBounds,
  alertsQuerySchema,
  buildVoucherAlertResolution,
  reviewNoteSchema,
  voucherAlertFilter,
  type AlertModule,
  type ShiftAuditState,
} from "./schemas";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import { DbQueryError } from "@/src/shared/db/errors";
import { alertsRepo, type AlertsRepo } from "./repos/alerts";

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


export interface AlertActor {
  userId: string;
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

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/**
 * Deriva por esquema desactualizado (p. ej. migraciones 011/012 sin
 * aplicar en la base a la que apunta la app) a un error accionable en
 * vez de un "Error interno" opaco.
 */
function toAlertError(error: { message?: string } | null | undefined): AlertError {
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

/** Runs a repository call and maps a database failure with `toAlertError`. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof DbQueryError) throw toAlertError(error.error);
    throw error;
  }
}

async function userNames(repo: AlertsRepo, userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  try {
    return new Map((await repo.userNames(ids)).map((row) => [row.id, row.full_name]));
  } catch {
    throw new AlertError("INTERNAL", "Error interno.", 500);
  }
}

/**
 * Bandeja del admin: alertas, más recientes primero, paginadas en servidor
 * para que ningún rango esconda avisos.
 */
export async function listAlerts(
  raw: unknown,
): Promise<AlertsResult> {
  const parsed = alertsQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AlertError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { unreadOnly, page, module, from, to } = parsed.data;
  const actions = module ? [...ALERT_MODULES[module].actions] : [...ALERT_ACTIONS];
  // Rango inclusivo en hora de Bogotá (igual que facturación): cada extremo
  // se aplica solo cuando viene, sobre la misma consulta (sin RPC nuevo).
  const bounds = alertDateBounds(from, to);
  const repo = await alertsRepo();
  const filters = { actions, unreadOnly, ...bounds };
  const total = await guarded(() => repo.count(filters));
  const offset = (page - 1) * ALERTS_PAGE_SIZE;
  const rows = await guarded(() => repo.list({ ...filters, offset, limit: ALERTS_PAGE_SIZE }));
  const names = await userNames(
    repo,
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
  shiftIds: string[],
): Promise<Map<string, ShiftAuditState[]>> {
  const result = new Map<string, ShiftAuditState[]>();
  if (shiftIds.length === 0) return result;
  const repo = await alertsRepo();
  const rows = await guarded(() =>
    repo.shiftReviews(shiftIds, [AUDIT_ACTIONS.SHIFT_OPEN_MISMATCH, AUDIT_ACTIONS.SHIFT_CLOSE_MISMATCH]),
  );
  const names = await userNames(repo, rows.map((row) => row.reviewed_by));
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
/** Sin leer de la bandeja, opcionalmente de un módulo (insignia del menú). */
export async function countUnreadAlerts(module?: AlertModule): Promise<number> {
  const repo = await alertsRepo();
  const actions = module ? [...ALERT_MODULES[module].actions] : [...ALERT_ACTIONS];
  return guarded(() => repo.count({ actions, unreadOnly: true }));
}

/**
 * Revisa una alerta con justificación obligatoria.
 *
 * El alcance es la fila que trae el `id`, y nada más: el rastro se escribe sin
 * sede (una sola instalación), así que un filtro por `sede_id` no hallaría
 * ninguna fila y "marcar como leída" quedaría en silencio sin efecto. Quién
 * puede revisar lo define el gate de administrador de la acción, no un filtro.
 */
export async function markAlertRead(
  id: string,
  raw: unknown,
  actor: AlertActor,
): Promise<{ id: string }> {
  const parsed = reviewNoteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AlertError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const repo = await alertsRepo();
  const data = await guarded(() =>
    repo.markRead(id, {
      is_read: true,
      read_at: new Date().toISOString(),
      review_note: parsed.data.note,
      reviewed_by: actor.userId,
    }),
  );
  if (!data) throw new AlertError("NOT_FOUND", "Alerta no encontrada.", 404);
  return data;
}

/**
 * Cierra la alerta pendiente de un vale ya revisado (aprobado o rechazado).
 * La alerta decía "hay un vale pendiente de revisar": una vez revisado, ya no
 * aplica. Reutiliza el mecanismo de la bandeja (`is_read`/`read_at`/
 * `review_note`/`reviewed_by`), sin estados nuevos, y filtra por `entity_id`
 * + `is_read:false` para ser idempotente y no pisar otras alertas.
 *
 * No recibe SEDE, como `markAlertRead`: el rastro se escribe sin `sede_id`, así
 * que un alcance por sede no alcanzaría la fila y el cierre quedaría en
 * silencio. Quien puede revisar es cosa del permiso del llamador.
 *
 * NUNCA lanza: aprobar/rechazar el vale ya quedó aplicado y auditado, así que
 * un fallo al cerrar la alerta no debe tumbar la operación de negocio (la
 * alerta seguiría en la bandeja para revisarla a mano).
 */
export async function resolveVoucherAlert(
  voucherId: string,
  reviewedBy: string | null,
  note: string,
): Promise<{ resolved: boolean }> {
  try {
    const repo = await alertsRepo();
    await repo.resolveVoucher(voucherAlertFilter(voucherId), buildVoucherAlertResolution({ reviewedBy, note }));
    return { resolved: true };
  } catch (error) {
    console.error(
      "[alerts] no se pudo cerrar la alerta del vale:",
      error instanceof Error ? error.message : error,
    );
    return { resolved: false };
  }
}
