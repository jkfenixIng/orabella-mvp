import { getSessionUser } from "@/src/features/auth/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import { requireSedeRole, SedeError as PlatformError } from "@/src/shared/lib/sede";

// Compatibilidad: la identidad de esta guarda vive en la clase compartida. Se
// re-exporta con el nombre del módulo para que las superficies de la plataforma
// (G3–G5) importen desde acá sin conocer `shared/lib/sede`.
export { SedeError as PlatformError } from "@/src/shared/lib/sede";

/**
 * Roles de la PLATAFORMA. Se declara como `const X: RoleCode[] = [...]` (y no
 * inline) porque `tests/action-guards.test.ts` lee del fuente los roles que
 * admite cada guarda; la lista es la única fuente de verdad de este gate.
 *
 * Es un rol ADICIONAL, no una sede nueva: quien lo tenga conserva su `sede_id`
 * y `resolveSede` sigue siendo la frontera del aislamiento por sede. El
 * privilegio de plataforma viene del ROL, y esta guarda es la que lo exige.
 */
const PLATFORM_ROLES: RoleCode[] = ["superadmin"];

/** Sesión de plataforma: autenticada, con su sede, y sus roles. */
export interface PlatformActor {
  userId: string;
  sedeId: string;
  roles: RoleCode[];
}

/**
 * Guarda de las superficies de plataforma: solo la cuenta con el rol
 * `superadmin`.
 *
 * Sigue la forma de casa de `requireAdminSession`/`requireSession`
 * (`admin/service`) y de `requirePayrollAdmin` (`payroll/service`): lee la
 * sesión, exige la sede (el rol NO relaja `users.sede_id`) y aplica el gate con
 * `requireSedeRole`, que responde FORBIDDEN/403. Devuelve el actor para que las
 * lecturas cross-sede de las unidades siguientes no tengan que volver a leer la
 * sesión.
 *
 * Este archivo hospedará esas lecturas después; por ahora solo vive la guarda.
 */
export async function requirePlatformAdmin(
  token: string | null | undefined,
): Promise<PlatformActor> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new PlatformError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  if (!session.user.sede_id) {
    throw new PlatformError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  requireSedeRole(session.roles, PLATFORM_ROLES);
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}
