/**
 * Guardas puras de sede y rol (capa compartida).
 *
 * Dirección permitida: shared → features → app. Estos guardas vivían en el
 * feature admin y eran importados por billing, cash, inventory, payroll,
 * commissions y alerts (acoplamiento entre features). Ahora viven aquí;
 * `admin/service` los re-exporta como compatibilidad sin romper identidad
 * (misma clase, `instanceof` intacto).
 */

/** Error de sede/rol con código de negocio y estado HTTP. */
export class SedeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SedeError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Roles del MVP. Unión duplicada a propósito (no se importa desde
 * features/auth para no acoplar shared → features); es estructuralmente
 * idéntica a `RoleCode`, por lo que ambas son asignables entre sí.
 */
export type SedeRole = "admin" | "empleado" | "caja";

/**
 * TRA/NFR-02: verifica que la sesión tenga al menos uno de los roles
 * exigidos. Puro (sin red) para poder probarlo en unit tests.
 */
export function requireSedeRole(roles: SedeRole[], allowed: SedeRole[]): void {
  const permitted = allowed.some((role) => roles.includes(role));
  if (!permitted) {
    throw new SedeError("FORBIDDEN", "No tiene permiso para esta acción.", 403);
  }
}

/**
 * El MVP opera una sola sede: el sede_id solicitado debe coincidir con el
 * de la sesión (si se omite, se usa el de la sesión).
 */
export function resolveSede(sessionSedeId: string, requestedSedeId?: string | null): string {
  if (!requestedSedeId || requestedSedeId === sessionSedeId) return sessionSedeId;
  throw new SedeError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
}
