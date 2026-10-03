import { z } from "zod";
import { getSessionUser } from "@/src/features/auth/service";
import { type RoleCode } from "@/src/features/auth/schemas";
// La convención de la fecha la declara el módulo de nómina: es la MISMA forma
// `yyyy-mm-dd`, nullable y con la fecha futura permitida. Se reutiliza en vez de
// repetir el regex acá: una sola definición del campo, y la plataforma no
// inventa una segunda forma de fecha para la misma columna.
import { payrollStartDateSchema } from "@/src/features/payroll/schemas";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import { requireSedeRole, SedeError as PlatformError } from "@/src/shared/lib/sede";

// Compatibilidad: la identidad de esta guarda vive en la clase compartida. Se
// re-exporta con el nombre del módulo para que las superficies de la plataforma
// importen desde acá sin conocer `shared/lib/sede`.
export { SedeError as PlatformError } from "@/src/shared/lib/sede";

/**
 * CAPA DE PLATAFORMA — la instalación es de UNA SOLA SEDE (decisión del dueño,
 * 2026-10-01).
 *
 * Lo que queda aquí es configuración del SISTEMA, no estructura de sedes: la
 * guarda `requirePlatformAdmin` y la fecha de activación de la nómina de la
 * instalación. Ya NO hay lista de sedes, ni alta de sede, ni directorio de
 * usuarios de otra sede, ni administración de roles por sede: nada de eso tiene
 * a quién aplicarse cuando la instalación tiene una sola sede, y el negocio ya
 * tiene su propia puerta de usuarios (`admin`, `/admin`).
 *
 * La fila de `sedes` NO desaparece: la columna y la tabla siguen ahí (su borrado
 * físico es otra unidad, con su migración). Lo que se retiró es el código que
 * trataba la instalación como un conjunto de sedes.
 */

/**
 * Roles de la PLATAFORMA. Se declara como `const X: RoleCode[] = [...]` (y no
 * inline) porque `tests/action-guards.test.ts` lee del fuente los roles que
 * admite cada guarda; la lista es la única fuente de verdad de este gate.
 *
 * Es un rol ADICIONAL, no una sede nueva: quien lo tenga conserva su `sede_id`
 * (`users.sede_id` es NOT NULL y esa columna no se relaxes en esta unidad) y el
 * privilegio de plataforma viene del ROL, no de dónde esté anclada la cuenta.
 */
const PLATFORM_ROLES: RoleCode[] = ["superadmin"];

/**
 * Sesión de plataforma: autenticada y con sus roles. La sede NO viaja en el
 * actor: la plataforma no la elige ni la filtra — resuelve la fila de la
 * instalación por dato (`leerSedeDeLaInstalacion`). La sesión sí exige que
 * exista, porque `users.sede_id` es NOT NULL mientras la columna exista.
 */
export interface PlatformActor {
  userId: string;
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
 * lecturas de configuración no tengan que volver a leer la sesión.
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
  return { userId: session.user.id, roles: session.roles };
}

// ---------------------------------------------------- sede de la instalación ---

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor). Mismo patrón
 * que `adminDb`: import dinámico para que las pruebas unitarias, sin red ni
 * entorno, nunca lo carguen.
 */
async function platformDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

/**
 * El cliente privilegiado que este módulo usa. Se exporta el TIPO (no el
 * cliente) porque el script de aprovisionamiento (`scripts/create-superadmin`)
 * resuelve la sede de la instalación con ESTA función y no con una copia: una
 * sola definición de "cuál es la sede de la instalación" para la pantalla, la
 * escritura y el despliegue.
 */
export type PlatformDb = Awaited<ReturnType<typeof platformDb>>;

/** Fila cruda de `sedes` tal como la devuelve PostgREST. */
interface SedeRecord {
  id: string;
  name: string;
  is_active: boolean;
  /** Columna 068; puede faltar si el dueño todavía no la aplicó. */
  payroll_start_date?: string | null;
}

/**
 * La INSTALACIÓN tal como la ve la capa de plataforma: su identificador, su
 * nombre y su configuración (`payroll_start_date`). `payroll_start_date` en
 * `null` significa «sin configurar».
 */
export interface PlatformInstallationRow {
  id: string;
  name: string;
  is_active: boolean;
  payroll_start_date: string | null;
}

const SEDE_SELECT = "id, name, is_active, payroll_start_date";
const SEDE_SELECT_SIN_NOMINA = "id, name, is_active";

/**
 * ¿El fallo es «la columna 068 todavía no existe»? Es la degradación honesta que
 * ya hacía `getPayrollStartDate`: sin la columna, lo correcto es «sin configurar»,
 * no un error interno que tape la pantalla de configuración.
 */
function isMissingPayrollColumn(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || /payroll_start_date/i.test(error.message ?? "");
}

/**
 * LA SEDE DE LA INSTALACIÓN: la única fila ACTIVA de `sedes`.
 *
 * Con una sola sede, «cuál es la sede de la instalación» tiene una respuesta
 * única, y es un DATO y no un texto: la fila activa. Por eso se reconoce por
 * `is_active` y NUNCA por su nombre —renombrarla no cambia lo que es la
 * instalación, y una lista de nombres reservados en el código sería una segunda
 * fuente de verdad para lo que la base ya dice—.
 *
 * Si no hay exactamente una fila activa NO se elige una: con cero no hay
 * dónde configurar nada, y con dos o más la instalación ya no es de una sola
 * sede, que es un dato que decide el dueño y no el código. El error nombra las
 * filas para que el arreglo sea evidente.
 *
 * AISLAMIENTO: esta lectura NO usa `resolveSede` (la frontera del negocio) y no
 * filtra por la sede del actor: no es una lectura cross-sede, es la lectura de
 * la fila que ES la instalación.
 *
 * Degradación por migración pendiente: con la 068 sin aplicar la columna no
 * existe y PostgREST responde 42703. Se relee sin la columna y la instalación
 * queda «sin configurar»; cualquier otro fallo de esa segunda lectura sí se
 * propaga.
 */
export async function leerSedeDeLaInstalacion(db: PlatformDb): Promise<PlatformInstallationRow> {
  const { data, error } = await db
    .from("sedes")
    .select(SEDE_SELECT)
    .eq("is_active", true)
    .order("name")
    .order("id");

  let filas: SedeRecord[];
  if (error) {
    if (!isMissingPayrollColumn(error)) {
      throw new PlatformError("INTERNAL", "Error interno.", 500);
    }
    // 068 sin aplicar: se relee sin la columna. Cualquier otro fallo de esta
    // segunda lectura sí se propaga.
    const respaldo = await db
      .from("sedes")
      .select(SEDE_SELECT_SIN_NOMINA)
      .eq("is_active", true)
      .order("name")
      .order("id");
    if (respaldo.error) {
      throw new PlatformError("INTERNAL", "Error interno.", 500);
    }
    filas = (respaldo.data ?? []) as SedeRecord[];
  } else {
    filas = (data ?? []) as SedeRecord[];
  }

  if (filas.length === 0) {
    throw new PlatformError(
      "NOT_FOUND",
      "La instalación no tiene ninguna sede activa: no hay dónde configurar la instalación.",
      404,
    );
  }
  if (filas.length > 1) {
    throw new PlatformError(
      "SEDE_AMBIGUA",
      `Hay ${filas.length} sedes activas (${filas.map((fila) => fila.name).join(", ")}). La instalación es de una sola sede: deje activa sólo la sede del negocio.`,
      409,
    );
  }

  const sede = filas[0];
  return {
    id: sede.id,
    name: sede.name,
    is_active: sede.is_active,
    payroll_start_date: sede.payroll_start_date ?? null,
  };
}

/**
 * La CONFIGURACIÓN de la instalación que la plataforma todavía administra: la
 * fila de la sede única con su fecha de activación de nómina.
 *
 * GATE: exige un `PlatformActor`, que solo `requirePlatformAdmin` sabe construir,
 * y vuelve a aplicar el rol acá para que la lectura nunca dependa de que el
 * llamador haya pasado por la guarda.
 */
export async function readPlatformInstallation(
  actor: PlatformActor,
): Promise<PlatformInstallationRow> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  return leerSedeDeLaInstalacion(await platformDb());
}

// ------------------------------------------------------ escritura de plataforma ---

/**
 * El cuerpo de la escritura. NO admite `sede_id`: la sede objetivo NO la elige
 * el llamador, la resuelve el servicio (la instalación tiene una sola). El
 * esquema descarta la clave si llega, así que un cuerpo que la trajera no abre
 * ninguna puerta.
 */
const setPlatformPayrollStartDateSchema = z.object({
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
 * Configura (o limpia, con `null`) la fecha de inicio de la nómina DE LA
 * INSTALACIÓN. Es la única escritura de este campo: el admin de la sede ya no
 * puede cambiarla y no hay otra sede a la que elegirle una fecha.
 *
 * OBJETIVO: la sede la resuelve el servicio (`leerSedeDeLaInstalacion`), nunca el
 * cuerpo de la petición. Esa fila es a la vez el objetivo y la PRUEBA de que hay
 * una instalación: no se escribe un id fantasma.
 *
 * AUDITORÍA: la fecha mueve meses de dinero y antes cambiaba sin rastro, así que
 * cada escritura deja una entrada con el ACTOR, la sede OBJETIVO (para que sea
 * ubicable donde importa: en la historia de esa sede) y los dos valores, el
 * anterior y el nuevo. El anterior sale de la MISMA fila que se va a escribir.
 * `writeAudit` nunca lanza: un fallo de auditoría no convierte una fecha ya
 * escrita en un error para el usuario.
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
  const { payroll_start_date } = parsed.data;
  const db = await platformDb();

  // 1) La sede de la instalación: objetivo de la escritura y valor ANTERIOR.
  const sede = await leerSedeDeLaInstalacion(db);

  // 2) Escritura en ESA fila.
  const { data, error } = await db
    .from("sedes")
    .update({ payroll_start_date })
    .eq("id", sede.id)
    .select("id, payroll_start_date")
    .maybeSingle();
  if (error) {
    if (isMissingPayrollColumn(error)) {
      throw new PlatformError("VALIDATION", MIGRACION_068_PENDIENTE, 409);
    }
    throw new PlatformError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new PlatformError("NOT_FOUND", "La sede de la instalación no existe.", 404);
  const nueva = (data as { payroll_start_date?: string | null }).payroll_start_date ?? null;

  // 3) Auditoría: actor, sede objetivo y los dos valores.
  await writeAudit({
    user_id: actor.userId,
    action: AUDIT_ACTIONS.PLATFORM_PAYROLL_START_DATE_SET,
    entity: "sedes",
    entity_id: sede.id,
    metadata: {
      previous_payroll_start_date: sede.payroll_start_date,
      new_payroll_start_date: nueva,
    },
  });

  return { sede_id: sede.id, payroll_start_date: nueva };
}