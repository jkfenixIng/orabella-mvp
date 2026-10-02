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
  VOUCHER_APPROVED: "voucher.approved",
  VOUCHER_REQUESTED: "voucher.requested",
  VOUCHER_REJECTED: "voucher.rejected",
  // G3b: la fecha de inicio de la nómina de una sede la configura SOLO la
  // cuenta de plataforma, para CUALQUIER sede. Antes cambiaba sin rastro y es
  // una fecha que mueve meses de dinero: queda con su propia acción para que un
  // auditor lea «la plataforma configuró la nómina de la sede X» con el valor
  // anterior y el nuevo, y no la confunda con el negocio. NO entra a ningún
  // catálogo de alertas: es una decisión de configuración, no un desvío.
  PLATFORM_PAYROLL_START_DATE_SET: "platform.payroll_start_date_set",
  // G5: la cuenta de plataforma ALTA una sede de la instalación. Es la entrada
  // que antes no existía: hasta acá las sedes se creaban desde la administración
  // de otra sede, sin rastro. Tiene su propia acción para que un auditor lea
  // «la plataforma creó la sede X» con los datos con que la nombró, y no la
  // confunda con una edición de una sede ya existente. NO entra a ningún
  // catálogo de alertas: es una decisión de configuración, no un desvío.
  PLATFORM_SEDE_CREATED: "platform.sede_created",
  // G5: la plataforma decide QUIÉN ADMINISTRA una sede. Cambia el poder de una
  // persona sobre una sede entera —quién entra a su caja, su nómina y su
  // facturación—, así que se audita con el cambio CONCRETO: de qué roles a
  // cuáles. El nombre del rol es el dato que un auditor necesita para reconstruir
  // la decisión; sin los dos conjuntos el registro sólo diría "se cambió algo".
  // NO entra a ningún catálogo de alertas: es una decisión de configuración, no
  // un desvío.
  PLATFORM_SEDE_ROLES_SET: "platform.sede_roles_set",
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
