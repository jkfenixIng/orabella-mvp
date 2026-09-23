/**
 * T8 — Auditoría de acciones críticas (TRA-01, PRD §5.8).
 *
 * SOLO SERVIDOR. Este módulo usa `createAdminClient()` (service_role, bypass
 * de RLS). NUNCA importarlo en Client Components ni en código con "use client":
 * expondría la service_role key. Los servicios del servidor (login fallido /
 * bloqueo, anulación de factura, cierre con base incompleta, cálculo / cierre
 * de nómina, vales sobre tope, cambio de clave) llaman a `writeAudit()`.
 *
 * `writeAudit()` NUNCA lanza: ante cualquier fallo (red, env, BD) registra en
 * consola y devuelve `{ written: false }` para no romper el flujo de negocio.
 */

export interface AuditEntry {
  /** Sede del evento. Null solo cuando se desconoce (login con documento inexistente). */
  sede_id: string | null;
  user_id?: string | null;
  action: string;
  entity: string;
  entity_id: string;
  metadata?: Record<string, unknown>;
}

export interface AuditPayload {
  sede_id: string | null;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  metadata: Record<string, unknown>;
}

/** Acciones críticas auditadas (vocabulario cerrado T8). */
export const AUDIT_ACTIONS = {
  LOGIN_FAILED: "auth.login_failed",
  LOGIN_LOCKED: "auth.login_locked",
  PASSWORD_CHANGED: "auth.password_changed",
  INVOICE_CREATED: "invoice.created",
  INVOICE_EDITED: "invoice.edited",
  INVOICE_ANNULLED: "invoice.annulled",
  SHIFT_CLOSED: "cash.shift_closed",
  SHIFT_OPEN_MISMATCH: "cash.shift_open_mismatch",
  SHIFT_CLOSE_MISMATCH: "cash.shift_close_mismatch",
  SHIFT_EDITED: "cash.shift_edited",
  REGISTER_BASE_UPDATED: "cash.register_base_updated",
  PAYROLL_CALCULATED: "payroll.calculated",
  PAYROLL_CLOSED: "payroll.closed",
  COMMISSION_PAID: "payroll.commission_paid",
  VOUCHER_APPROVED: "voucher.approved",
} as const;

/**
 * Construye el payload de `audit_logs`. Pura (sin red/BD) para probarla
 * en vitest. Normaliza nulos y garantiza `metadata` como objeto.
 */
export function buildAuditPayload(entry: AuditEntry): AuditPayload {
  return {
    sede_id: entry.sede_id ?? null,
    user_id: entry.user_id ?? null,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entity_id,
    metadata: entry.metadata ?? {},
  };
}

/**
 * Escribe una entrada en `audit_logs` con service_role.
 * Nunca lanza; devuelve `{ written: false }` si no pudo escribir.
 */
export async function writeAudit(entry: AuditEntry): Promise<{ written: boolean }> {
  try {
    const payload = buildAuditPayload(entry);
    const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
    const db = createAdminClient();
    const { error } = await db.from("audit_logs").insert(payload);
    if (error) {
      console.error("[audit] no se pudo escribir audit_logs:", error.message);
      return { written: false };
    }
    return { written: true };
  } catch (error) {
    console.error(
      "[audit] no se pudo escribir audit_logs:",
      error instanceof Error ? error.message : error,
    );
    return { written: false };
  }
}
