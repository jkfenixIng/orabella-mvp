import { z } from "zod";

/**
 * Bandeja admin: subconjunto de `audit_logs` que genera un aviso
 * (desajustes de caja y cuentas bloqueadas). El resto de la auditoría
 * sigue existiendo pero no interrumpe ni avisa.
 */
export const ALERT_ACTIONS = [
  "cash.shift_open_mismatch",
  "cash.shift_close_mismatch",
  "auth.login_locked",
  "payroll.commission_paid",
  "voucher.requested",
] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

/**
 * Módulos de alerta: cada alerta pertenece a exactamente un módulo para
 * que no se mezclen (hoy caja y acceso; futuros módulos agregan el suyo).
 */
export const ALERT_MODULES = {
  caja: {
    label: "Caja",
    actions: ["cash.shift_open_mismatch", "cash.shift_close_mismatch", "payroll.commission_paid", "voucher.requested"],
  },
  acceso: {
    label: "Acceso",
    actions: ["auth.login_locked"],
  },
} as const;
export type AlertModule = keyof typeof ALERT_MODULES;

/** Página fija de la bandeja (igual que el historial de caja). */
export const ALERTS_PAGE_SIZE = 10;

export const alertsQuerySchema = z.object({
  unreadOnly: z.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  module: z.enum(["caja", "acceso"]).optional(),
});
export type AlertsQueryInput = z.infer<typeof alertsQuerySchema>;

/** Revisar exige dejar traza escrita de lo sucedido (obligatoria). */
export const reviewNoteSchema = z.object({
  note: z.string().trim().min(1, "La justificación es obligatoria.").max(500, "Justificación muy larga."),
});
export type ReviewNoteInput = z.infer<typeof reviewNoteSchema>;

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
