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
  user_id?: string | null;
  action: string;
  entity: string;
  entity_id: string;
  metadata?: Record<string, unknown>;
}

export interface AuditPayload {
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
  // CL-15/CL-18: el alta de usuario falló, su compensación del espejo en
  // Supabase Auth TAMBIÉN falló, y quedó un usuario huérfano para reparar a
  // mano. No describe una operación de negocio sino un TRABAJO DE REPARACIÓN:
  // vive igual en este vocabulario —y no en una cadena suelta del módulo—
  // porque la bandeja de alertas filtra por acciones de esta lista. La acción
  // declarada localmente en el servicio de auth dejaba el residuo auditable
  // pero INVISIBLE en toda pantalla; con la entrada acá, la bandeja lo muestra
  // junto al resto de los desvíos que exigen una decisión humana.
  USER_CREATE_ROLLBACK_FAILED: "auth.user_create_rollback_failed",
  INVOICE_CREATED: "invoice.created",
  INVOICE_EDITED: "invoice.edited",
  INVOICE_ANNULLED: "invoice.annulled",
  SHIFT_CLOSED: "cash.shift_closed",
  SHIFT_OPEN_MISMATCH: "cash.shift_open_mismatch",
  SHIFT_CLOSE_MISMATCH: "cash.shift_close_mismatch",
  SHIFT_EDITED: "cash.shift_edited",
  // El reconteo (033) NO edita el cierre: inserta una version corregida y deja
  // la firmada intacta. Se registra con su propia accion para que un auditor no
  // lea "el cierre se edito" donde lo que paso es lo contrario. SHIFT_EDITED se
  // conserva porque las filas historicas de audit_logs ya usan ese valor.
  SHIFT_RECOUNTED: "cash.shift_recounted",
  REGISTER_BASE_UPDATED: "cash.register_base_updated",
  PAYROLL_CALCULATED: "payroll.calculated",
  PAYROLL_CLOSED: "payroll.closed",
  PAYROLL_DELETED: "payroll.deleted",
  // PA-2a: pago de una nómina individual por caso extraordinario (despido,
  // renuncia, emergencia). Es plata que sale de la sede sin un período detrás:
  // tiene su propia acción para que un auditor lea el MOTIVO y el TIPO en el
  // registro, y no un pago de nómina ordinaria más. (Pagar un ítem de un
  // período NO se audita: ver `payPayrollItem`.)
  PAYROLL_EXTRA_PAID: "payroll.extra_paid",
  // PA-2b: corrección de un período CERRADO. NO reabre ni pisa el período: deja
  // un registro con las DOS versiones (la anterior congelada y la corregida),
  // el motivo y quién corrigió. Tiene su propia acción para que un auditor no
  // lea "la nómina se calculó" donde lo que pasó es que se corrigió una ya
  // firmada. El metadato lleva el motivo y los totales de las dos versiones.
  PAYROLL_PERIOD_CORRECTED: "payroll.period_corrected",
  COMMISSION_PAID: "payroll.commission_paid",
  // Los topes y los días permitidos de los vales los configura el admin de la
  // sede y antes cambiaban sin rastro: son los números que deciden qué vale sale
  // solo de caja y cuál espera aprobación, así que un cambio hecho con la
  // pantalla abierta tiene que quedar escrito con QUIÉN lo hizo y los dos
  // valores, el anterior y el nuevo (como la fecha de arranque, más abajo).
  // NO entra a ningún catálogo de alertas: cambiar la política es una decisión de
  // configuración, no un desvío que alguien deba autorizar o rechazar.
  VOUCHER_LIMITS_SET: "voucher.limits_set",
  VOUCHER_APPROVED: "voucher.approved",
  VOUCHER_REQUESTED: "voucher.requested",
  VOUCHER_REJECTED: "voucher.rejected",
  // La fecha de inicio de la nómina de la INSTALACIÓN la configura SOLO la cuenta
  // de plataforma. Antes cambiaba sin rastro y es una fecha que mueve meses de
  // dinero: queda con su propia acción para que un auditor lea «la plataforma
  // configuró la nómina» con el valor anterior y el nuevo, y no la confunda con
  // el negocio. NO entra a ningún catálogo de alertas: es una decisión de
  // configuración, no un desvío.
  PLATFORM_PAYROLL_START_DATE_SET: "platform.payroll_start_date_set",
  // `platform.sede_created` y `platform.sede_roles_set` (la alta de sedes y los
  // roles por sede) se retiraron del vocabulario con la decisión de una sola sede:
  // ya no hay esa operación que auditar. Las filas YA escritas en `audit_logs` con
  // esos valores se conservan tal cual, como las de `SHIFT_EDITED`: el registro
  // histórico no se reescribe.
} as const;

/**
 * Construye el payload de `audit_logs`. Pura (sin red/BD) para probarla
 * en vitest. Normaliza nulos y garantiza `metadata` como objeto.
 *
 * La instalación es UNA sola, así que el rastro no lleva sede: el evento se
 * ubica por QUIÉN lo hizo (`user_id`) y sobre QUÉ fila (`entity`/`entity_id`).
 * Antes el campo admitía NULL para los eventos sin tenant —el login con
 * documento inexistente, que no conoce ni usuario ni sede—, y esa era la única
 * razón por la que era nullable; hoy ya no hay nada que nombrar y esa entrada
 * se sigue escribiendo completa igual que las demás.
 */
export function buildAuditPayload(entry: AuditEntry): AuditPayload {
  return {
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
