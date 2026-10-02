import { z } from "zod";
import { getSessionUser } from "@/src/features/auth/service";
import type { RoleCode } from "@/src/features/auth/schemas";
// La convención de la fecha la declara el módulo de nómina: es la MISMA forma
// `yyyy-mm-dd`, nullable y con la fecha futura permitida. Se reutiliza en vez de
// repetir el regex acá: una sola definición para el campo, en los dos caminos
// de escritura (el de plataforma reemplaza al de nómina).
import { payrollStartDateSchema } from "@/src/features/payroll/schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
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

// ------------------------------------------- escritura de plataforma ---

/**
 * G3b: la sede ELEGIDA y la fecha que se le escribe. `null` es un estado legal
 * («sin configurar») y la fecha conserva la forma del módulo de nómina.
 */
const setPlatformPayrollStartDateSchema = z.object({
  sede_id: z.uuid("Sede inválida."),
  payroll_start_date: payrollStartDateSchema,
});

/** Mensaje único para la 068 sin aplicar: la base no tiene la columna todavía. */
const MIGRACION_068_PENDIENTE =
  "La fecha de inicio de la nómina todavía no se puede configurar en esta base: falta aplicar la migración 068.";

/** Primera violación del esquema, con el mismo criterio que el módulo de nómina. */
function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/**
 * G3b: configura (o limpia, con `null`) la fecha de inicio de la nómina de la
 * sede ELEGIDA. Es la única escritura de este campo: el admin de la sede ya no
 * puede cambiarla.
 *
 * AISLAMIENTO: NO usa `resolveSede` (esa es la frontera del negocio) y NO
 * escribe la sede del actor: la sede objetivo llega ELEGIDA en el cuerpo, como
 * en la lectura cross-sede de G3a. El privilegio es de plataforma y se re-aplica
 * acá para que la escritura nunca dependa de que el llamador haya pasado por la
 * guarda.
 *
 * AUDITORÍA: la fecha mueve meses de dinero y antes cambiaba sin rastro, así que
 * cada escritura deja una entrada con el ACTOR, la sede OBJETIVO (para que sea
 * ubicable donde importa: en la historia de esa sede) y los dos valores, el
 * anterior y el nuevo. `writeAudit` nunca lanza: un fallo de auditoría no
 * convierte una fecha ya escrita en un error para el usuario.
 *
 * Degradación por migración pendiente: con la 068 sin aplicar la columna no
 * existe y PostgREST responde 42703. Se responde con el mensaje accionable que
 * ya usaba el módulo de nómina en vez del error crudo de la base.
 */
export async function setPlatformPayrollStartDate(
  raw: unknown,
  actor: PlatformActor,
): Promise<{ sede_id: string; payroll_start_date: string | null }> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  const parsed = setPlatformPayrollStartDateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { sede_id, payroll_start_date } = parsed.data;
  const db = await platformDb();

  // 1) Estado ANTERIOR de la sede objetivo. Es lo que la auditoría necesita y,
  // de paso, la prueba de que la sede existe: no se escribe un id fantasma.
  const anterior = await readSedePayrollStartDate(db, sede_id);

  // 2) Escritura en la sede ELEGIDA, no en la del actor.
  const { data, error } = await db
    .from("sedes")
    .update({ payroll_start_date })
    .eq("id", sede_id)
    .select("id, payroll_start_date")
    .maybeSingle();
  if (error) {
    if (isMissingPayrollColumn(error)) {
      throw new PlatformError("VALIDATION", MIGRACION_068_PENDIENTE, 409);
    }
    throw new PlatformError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new PlatformError("NOT_FOUND", "La sede no existe.", 404);
  const nueva = (data as { payroll_start_date?: string | null }).payroll_start_date ?? null;

  // 3) Auditoría: actor, sede objetivo y los dos valores.
  await writeAudit({
    sede_id: sede_id,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.PLATFORM_PAYROLL_START_DATE_SET,
    entity: "sedes",
    entity_id: sede_id,
    metadata: {
      previous_payroll_start_date: anterior,
      new_payroll_start_date: nueva,
    },
  });

  return { sede_id, payroll_start_date: nueva };
}

/**
 * Lee la fecha de la sede objetivo. `404` cuando la fila no existe; con la 068
 * sin aplicar degrada al mismo mensaje accionable que la escritura. Se comparte
 * con `setPlatformPayrollStartDate` para que el «no existe» y el «falta la
 * columna» se decidan UNA vez.
 */
async function readSedePayrollStartDate(
  db: Awaited<ReturnType<typeof platformDb>>,
  sedeId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("sedes")
    .select("id, payroll_start_date")
    .eq("id", sedeId)
    .maybeSingle();
  if (error) {
    if (isMissingPayrollColumn(error)) {
      throw new PlatformError("VALIDATION", MIGRACION_068_PENDIENTE, 409);
    }
    throw new PlatformError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new PlatformError("NOT_FOUND", "La sede no existe.", 404);
  return (data as { payroll_start_date?: string | null }).payroll_start_date ?? null;
}
