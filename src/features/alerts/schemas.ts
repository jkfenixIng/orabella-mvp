import { z } from "zod";
import { dayBounds } from "@/src/shared/lib/dates";

/**
 * Acción del residuo de un alta de usuario cuya compensación también falló
 * (CL-15/CL-18). Es trabajo de REPARACIÓN y por eso avisa en la bandeja, igual
 * que un bloqueo de cuenta. El valor tiene que coincidir con
 * `AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED` del vocabulario compartido; se
 * escribe literal a propósito: este módulo lo importa un Client Component
 * (`alerts-client.tsx`) y `src/shared/lib/audit.ts` es SOLO SERVIDOR, así que
 * no se puede importar acá sin arrastrar la superficie de service_role al
 * bundle del navegador. `tests/alerts.test.ts` fija la igualdad entre los dos.
 */
export const ROLLBACK_ALERT_ACTION = "auth.user_create_rollback_failed";
export const ROLLBACK_ALERT_ENTITY = "users";

/**
 * Bandeja admin: subconjunto de `audit_logs` que genera un aviso
 * (desajustes de caja, cuentas bloqueadas y el residuo de un alta). El resto
 * de la auditoría sigue existiendo pero no interrumpe ni avisa.
 */
export const ALERT_ACTIONS = [
  "cash.shift_open_mismatch",
  "cash.shift_close_mismatch",
  "auth.login_locked",
  "voucher.requested",
  ROLLBACK_ALERT_ACTION,
] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

/**
 * Módulos de alerta: cada alerta pertenece a exactamente un módulo para
 * que no se mezclen (hoy caja y acceso; futuros módulos agregan el suyo).
 */
export const ALERT_MODULES = {
  caja: {
    label: "Caja",
    actions: ["cash.shift_open_mismatch", "cash.shift_close_mismatch", "voucher.requested"],
  },
  acceso: {
    label: "Acceso",
    actions: ["auth.login_locked", ROLLBACK_ALERT_ACTION],
  },
} as const;
export type AlertModule = keyof typeof ALERT_MODULES;

/** Página fija de la bandeja (igual que el historial de caja). */
export const ALERTS_PAGE_SIZE = 10;

/** Fecha calendario (yyyy-mm-dd) para el filtro de la bandeja. */
const alertDateString = (message: string): z.ZodString =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message);

export const alertsQuerySchema = z
  .object({
    unreadOnly: z.boolean().default(false),
    page: z.coerce.number().int().min(1).default(1),
    module: z.enum(["caja", "acceso"]).optional(),
    from: alertDateString("Fecha inicial inválida (use yyyy-mm-dd).").optional(),
    to: alertDateString("Fecha final inválida (use yyyy-mm-dd).").optional(),
  })
  .superRefine((value, context) => {
    // Igual que el historial de caja: rango invertido se rechaza por el
    // camino de validación existente (AlertError VALIDATION, 400).
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: "custom", message: "El rango de fechas es inválido." });
    }
  });
export type AlertsQueryInput = z.infer<typeof alertsQuerySchema>;

/**
 * Ventana inclusiva (timestamptz, hora de Bogotá) del rango de la bandeja.
 * Cada extremo es opcional: sin `from` no hay piso y sin `to` no hay techo.
 * Pura para probar la semántica de la ventana sin base de datos.
 */
export function alertDateBounds(from?: string, to?: string): { from?: string; to?: string } {
  const bounds: { from?: string; to?: string } = {};
  if (from) bounds.from = dayBounds(from).from;
  if (to) bounds.to = dayBounds(to).to;
  return bounds;
}

/** Revisar exige dejar traza escrita de lo sucedido (obligatoria). */
export const reviewNoteSchema = z.object({
  note: z.string().trim().min(1, "La justificación es obligatoria.").max(500, "Justificación muy larga."),
});
export type ReviewNoteInput = z.infer<typeof reviewNoteSchema>;

/**
 * Alerta de vale: la solicitud fuera de rango abre una alerta
 * (`voucher.requested` sobre `voucher_requests`). Aprobar o rechazar el vale
 * la resuelve; el vínculo es `entity_id` = id del vale. Sin tabla nueva: la
 * alerta es una fila de `audit_logs` con acción de `ALERT_ACTIONS`.
 */
export const VOUCHER_ALERT_ACTION = "voucher.requested";
export const VOUCHER_ALERT_ENTITY = "voucher_requests";

/**
 * ¿Un vale en este estado deja pendiente una alerta por revisar? Solo el
 * vale `pendiente` (fuera de rango) abre alerta; uno dentro de rango nace
 * `aprobada` y no genera nada. Puro para probarlo sin base de datos.
 */
export function voucherAlertRequired(status: string): boolean {
  return status === "pendiente";
}

/**
 * Motivo con el que la revisión (aprobar/rechazar) cierra la alerta del
 * vale. Queda como `review_note` en la traza que ya muestra la bandeja.
 */
export function voucherAlertResolutionNote(
  decision: "aprobada" | "rechazada",
  motivo?: string | null,
): string {
  const detail = motivo?.trim();
  if (decision === "rechazada") {
    return detail ? `Vale rechazado: ${detail}` : "Vale rechazado.";
  }
  return detail ? `Vale aprobado: ${detail}` : "Vale aprobado.";
}

/**
 * Parche con el que se resuelve una alerta de vale. Reutiliza el mecanismo
 * de la bandeja (`is_read` + `read_at` + `review_note` + `reviewed_by`):
 * no inventa estados nuevos. Puro para probarlo sin base de datos.
 */
export function buildVoucherAlertResolution(args: {
  reviewedBy: string | null;
  note: string;
  /** Inyectable para prueba determinista. */
  now?: string;
}): {
  is_read: true;
  read_at: string;
  review_note: string;
  reviewed_by: string | null;
} {
  return {
    is_read: true,
    read_at: args.now ?? new Date().toISOString(),
    review_note: args.note,
    reviewed_by: args.reviewedBy,
  };
}

/**
 * Criterio de cierre: SOLO la alerta del vale indicado que siga pendiente.
 * Acotar por `entity_id` + `is_read:false` evita tocar revisiones previas u
 * otras alertas, y hace el cierre idempotente (un segundo cierre no cambia
 * nada porque ya no queda la fila `is_read:false`).
 *
 * SIN SEDE, a propósito. El rastro se escribe sin `sede_id` (una sola
 * instalación, ver `buildAuditPayload`), así que un filtro por `sede_id` no
 * hallaría ninguna fila y, como `.match()` no lanza cuando nada coincide, el
 * vale quedaría aprobado o rechazado con su alerta todavía abierta y el
 * llamador recibiría `resolved: true` sin haber cerrado nada. Quien puede
 * revisar lo define el permiso del llamador, no un filtro sobre una columna
 * que las filas no tienen.
 */
export function voucherAlertFilter(voucherId: string): {
  action: string;
  entity: string;
  entity_id: string;
  is_read: false;
} {
  return {
    action: VOUCHER_ALERT_ACTION,
    entity: VOUCHER_ALERT_ENTITY,
    entity_id: voucherId,
    is_read: false,
  };
}

/**
 * Detalle del residuo de un alta fallida para la bandeja: nombra el usuario
 * que quedó y POR QUÉ, sin filtrar jamás una clave ni un hash (la clave inicial
 * del MVP es el documento, así que el detalle toma el CORREO del metadato y
 * nunca el documento). Puro para probarlo sin base de datos.
 */
export function rollbackAlertDetail(metadata: Record<string, unknown>): string {
  const email = typeof metadata.email === "string" && metadata.email ? metadata.email : null;
  const motivo =
    typeof metadata.motivo === "string" && metadata.motivo ? metadata.motivo : null;
  const sujeto = email ?? "sin correo registrado";
  return `El alta falló y su compensación también: quedó el usuario ${sujeto} para reparar${
    motivo ? ` (motivo: ${motivo})` : ""
  }.`;
}

export interface ShiftAuditState {
  action: string;
  fecha: string;
  revisada: boolean;
  justificacion: string | null;
  revisor: string | null;
}

export interface ShiftRevision {
  revisada: boolean;
  notas: Array<{ accion: string; fecha: string; nota: string; revisor: string | null }>;
}

/**
 * Revisión de un turno desde sus auditorías de desajuste (apertura y/o
 * cierre): null sin desajustes; revisada solo cuando todas están leídas.
 * Puro para probarlo sin base de datos.
 */
export function assembleShiftRevision(
  audits: ShiftAuditState[],
  hasComputedDiffs: boolean,
): ShiftRevision | null {
  if (audits.length === 0 && !hasComputedDiffs) return null;
  const read = audits.filter((audit) => audit.revisada);
  return {
    revisada: audits.length > 0 && read.length === audits.length,
    notas: read
      .filter((audit) => audit.justificacion)
      .map((audit) => ({
        accion: audit.action === "cash.shift_open_mismatch" ? "Apertura" : "Cierre",
        fecha: audit.fecha,
        nota: audit.justificacion as string,
        revisor: audit.revisor,
      })),
  };
}
