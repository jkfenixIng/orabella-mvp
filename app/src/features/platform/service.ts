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

// ------------------------------------------------- lecturas cross-sede ---

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor). Mismo patrón
 * que `adminDb`: import dinámico para que las pruebas unitarias, sin red ni
 * entorno, nunca lo carguen.
 */
async function platformDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

/** Fila cruda de `sedes` tal como la devuelve PostgREST (sin `is_platform`). */
interface SedeRecord {
  id: string;
  name: string;
  is_active: boolean;
  /** Columna 068; puede faltar si el dueño todavía no la aplicó. */
  payroll_start_date?: string | null;
}

/**
 * Fila de sede tal como la ve la superficie de plataforma. `is_platform` marca
 * la sede del SISTEMA: la que ancla la cuenta de plataforma (G2) y que NO es una
 * sede del negocio. `payroll_start_date` en `null` significa «sin configurar».
 *
 * El color de la superficie —el texto que la presenta como del sistema— lo
 * decide la pantalla; acá viaja solo el hecho, no el nombre de la sede.
 */
export interface PlatformSedeRow {
  id: string;
  name: string;
  is_active: boolean;
  payroll_start_date: string | null;
  is_platform: boolean;
}

const SEDE_SELECT = "id, name, is_active, payroll_start_date";
const SEDE_SELECT_SIN_NOMINA = "id, name, is_active";

/**
 * ¿El fallo es «la columna 068 todavía no existe»? Es la degradación honesta que
 * ya hace `getPayrollStartDate`: sin la columna, lo correcto es «sin configurar»,
 * no un error interno que tape la lista de sedes entera.
 */
function isMissingPayrollColumn(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || /payroll_start_date/i.test(error.message ?? "");
}

/**
 * Lectura CROSS-SEDE de TODAS las sedes de la instalación: id, nombre, estado y
 * la fecha de activación de nómina (`sedes.payroll_start_date`). Es la lectura
 * de la CAPA DE PLATAFORMA y existe porque el negocio tiene prohibido leer más
 * de su sede.
 *
 * AISLAMIENTO: NO usa `resolveSede` (esa es la frontera del negocio, unidad de
 * G3) y NO filtra por la sede del actor. El actor solo decide qué fila se marca
 * como del sistema. Orden determinista: nombre y, para desempatar homónimos, id.
 *
 * GATE: exige un `PlatformActor`, que solo `requirePlatformAdmin` sabe construir,
 * y vuelve a aplicar el rol acá para que una lectura cross-sede nunca dependa de
 * que el llamador haya pasado por la guarda.
 */
export async function listPlatformSedes(actor: PlatformActor): Promise<PlatformSedeRow[]> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  const db = await platformDb();

  const { data, error } = await db
    .from("sedes")
    .select(SEDE_SELECT)
    .order("name")
    .order("id");

  let filas: SedeRecord[];
  if (error) {
    if (!isMissingPayrollColumn(error)) {
      throw new PlatformError("INTERNAL", "Error interno.", 500);
    }
    // 068 sin aplicar: se relee sin la columna y todas las sedes quedan «sin
    // configurar». Cualquier otro fallo de esta segunda lectura sí se propaga.
    const respaldo = await db
      .from("sedes")
      .select(SEDE_SELECT_SIN_NOMINA)
      .order("name")
      .order("id");
    if (respaldo.error) {
      throw new PlatformError("INTERNAL", "Error interno.", 500);
    }
    filas = (respaldo.data ?? []) as SedeRecord[];
  } else {
    filas = (data ?? []) as SedeRecord[];
  }

  // La sede de plataforma se reconoce por dónde está anclada la cuenta (G2): el
  // nombre vive UNA sola vez, en el script que la crea, y la app nunca lo repite.
  return filas.map((fila) => ({
    id: fila.id,
    name: fila.name,
    is_active: fila.is_active,
    payroll_start_date: fila.payroll_start_date ?? null,
    is_platform: fila.id === actor.sedeId,
  }));
}
