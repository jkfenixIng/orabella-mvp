/**
 * Guardas puras de sede y rol (capa compartida).
 *
 * Dirección permitida: shared → features → app. Estos guardas vivían en el
 * feature admin y eran importados por billing, cash, inventory, payroll,
 * commissions y alerts (acoplamiento entre features). Ahora viven aquí;
 * `admin/service` los re-exporta como compatibilidad sin romper identidad
 * (misma clase, `instanceof` intacto).
 *
 * Lo que queda aquí autoriza por ROL. La comparación por sede (`resolveSede`)
 * se retiró con la columna `sede_id`: la instalación es de una sola sede, así
 * que comparar la sede solicitada con la de la sesión ya no acotaba nada.
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
 * Roles del MVP más el rol de plataforma `superadmin` (G1). Unión duplicada a
 * propósito (no se importa desde features/auth para no acoplar shared →
 * features); es estructuralmente idéntica a `RoleCode`, por lo que ambas son
 * asignables entre sí. Si una agrega un código y la otra no, la asignación
 * recíproca deja de compilar: el espejo se mantiene a la vista del typecheck.
 */
export type SedeRole = "admin" | "empleado" | "caja" | "superadmin";

/**
 * TRA/NFR-02: verifica que la sesión tenga al menos uno de los roles
 * exigidos. Puro (sin red) para poder probarlo en unit tests.
 *
 * ÉSTA es la frontera que sobrevive: autoriza por ROL. La comparación por sede
 * (`resolveSede`) se retiró junto con la columna: la instalación es de una sola
 * sede, así que comparar la sede solicitada con la de la sesión ya no acotaba
 * nada.
 */
export function requireSedeRole(roles: SedeRole[], allowed: SedeRole[]): void {
  const permitted = allowed.some((role) => roles.includes(role));
  if (!permitted) {
    throw new SedeError("FORBIDDEN", "No tiene permiso para esta acción.", 403);
  }
}
