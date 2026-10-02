import { z } from "zod";
import { getSessionUser } from "@/src/features/auth/service";
import {
  isRoleCode,
  isSedeAssignableRole,
  roleCodeSchema,
  type RoleCode,
  type SedeAssignableRole,
} from "@/src/features/auth/schemas";
// La forma de la fila de sede es la MISMA que usa la administración del negocio
// (`admin/schemas.ts`, ADM-01). Se importa en vez de re-declararse: una sola
// definición de la fila `sedes` de `003_admin.sql` para los dos caminos de
// escritura, y el nombre duplicado —el que la 070 hace único— no puede quedar
// con dos reglas distintas.
import { sedeSchema } from "@/src/features/admin/schemas";
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
 * lecturas cross-sede de este módulo no tengan que volver a leer la sesión.
 *
 * Este archivo hospeda la lista de sedes (G3a), la fecha de nómina (G3b) y la
 * administración de sedes y admins (G5). Todas re-aplican el rol por su cuenta,
 * de modo que ninguna escritura dependa de que el llamador haya pasado por acá.
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

// ------------------------------------------------------- alta de sede ---

/** Columnas de la fila `sedes` de `003_admin.sql`, sin la columna de la 068. */
const SEDE_BASE_SELECT = "id, name, address, phone, is_active";

/** Sede creada por la plataforma: la fila, tal como la devolvió la base. */
export type CreatedSedeRow = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
};

/**
 * El cuerpo del ALTA. Sale del esquema de casa de la fila de sede con `id`
 * OMITIDO a propósito: desde la plataforma una sede se CREA, nunca se edita.
 * Con el `id` incluido, un cuerpo que lo trajera habilitaría el `upsert` por id
 * —el mismo agujero que se cierra en `admin/actions.ts`— y con él la edición de
 * la fila de la sede del sistema. Al omitirlo, el `id` ni siquiera llega a la
 * escritura: la omisión ES la garantía, no una validación que un llamador
 * pueda saltarse.
 */
const createPlatformSedeSchema = sedeSchema.omit({ id: true });

/**
 * Traduce el rechazo del índice único `uq_sedes_name` (070, sobre
 * `lower(btrim(name))`) al error de negocio de la casa: el mismo contrato con
 * el que `upsertEmployee` traduce el 23505 del código de empleado. El mensaje
 * NOMBRA la sede, porque un "ya existe" sin decir cuál no le sirve a quien está
 * creando.
 *
 * EL ÍNDICE ES LA AUTORIDAD: no hay lectura previa del nombre. Esa lectura y el
 * `insert` son DOS sentencias y entre ellas otra creación puede confirmarse, así
 * que un nombre libre en la lectura no lo garantiza en la escritura. Quien
 * decide es la base, una sola vez, dentro de la misma sentencia.
 *
 * `23505` en esta escritura es siempre el nombre: `sedes` tiene un único índice
 * más, la clave primaria, y la genera la base porque esta ruta nunca manda `id`.
 */
function duplicateSedeNameError(name: string): PlatformError {
  return new PlatformError("SEDE_NAME_TAKEN", `Ya existe una sede llamada «${name}».`, 409);
}

/**
 * G5: CREA una sede de la instalación. Es el camino único de alta: el negocio ya
 * no tiene ninguna puerta para crear sedes (las dos que tenía se cerraron en
 * `admin/actions.ts`).
 *
 * AISLAMIENTO: no usa `resolveSede` (esa es la frontera del negocio) y el
 * privilegio se re-aplica acá para que la escritura nunca dependa de que el
 * llamador haya pasado por la guarda.
 *
 * DUPLICADOS: la 070 garantiza la unicidad de `lower(btrim(name))`, así que la
 * fila de la sede del sistema tampoco se puede crear dos veces: el mismo nombre
 * cae en el mismo `23505` y vuelve con el mensaje que la nombra. No hace falta
 * —ni debe haber— una lista de nombres reservados en el código: la guarda es el
 * índice, y una lista sería una segunda fuente de verdad para los mismos datos.
 *
 * AUDITORÍA: el alta de una sede es la entrada que hasta acá no existía sin
 * rastro, así que deja una entrada con el ACTOR y los datos con que la nombró.
 * `writeAudit` nunca lanza: un fallo de auditoría no convierte una sede ya
 * escrita en un error para quien la creó.
 *
 * La proyección NO pide `payroll_start_date`: el alta no depende de la 068, y la
 * sede recién creada queda «sin configurar» porque la columna arranca nula.
 */
export async function createPlatformSede(
  raw: unknown,
  actor: PlatformActor,
): Promise<CreatedSedeRow> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  const parsed = createPlatformSedeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { name, address, phone, is_active } = parsed.data;
  const fila = {
    name,
    address: address ?? null,
    phone: phone ?? null,
    is_active: is_active ?? true,
  };
  const db = await platformDb();

  const { data, error } = await db.from("sedes").insert(fila).select(SEDE_BASE_SELECT).single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw duplicateSedeNameError(name);
    throw new PlatformError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new PlatformError("INTERNAL", "Error interno.", 500);
  const creada = data as CreatedSedeRow;

  await writeAudit({
    sede_id: creada.id,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.PLATFORM_SEDE_CREATED,
    entity: "sedes",
    entity_id: creada.id,
    metadata: { ...fila },
  });

  return creada;
}

// -------------------------------------- usuarios y roles de una sede ---

/**
 * Fila de `users` tal como la ve la plataforma: la MISMA proyección que usa la
 * pestaña de usuarios del negocio (`SedeUserRow`), para que la pantalla de
 * plataforma y la de sede muestren los mismos datos de la misma persona.
 */
export interface PlatformSedeUserRow {
  id: string;
  sede_id: string | null;
  full_name: string;
  id_number: string;
  roles: RoleCode[];
}

const PLATFORM_USER_SELECT = "id, sede_id, full_name, id_number";

/** La sede ELEGIDA de una lectura o una escritura de plataforma. */
const platformSedeTargetSchema = z.object({ sede_id: z.uuid("Sede inválida.") });

/**
 * Traduce la excepción de `replace_user_roles` al error de negocio. Es la misma
 * tabla que usa `setUserRoles` (039): `RAISE EXCEPTION` plano, SQLSTATE P0001.
 * Se declara acá y no se importa del módulo admin para que la superficie de
 * plataforma no dependa de los catálogos cacheados de ese módulo.
 */
function roleReplacementError(error: { code?: string; message?: string }): PlatformError {
  if (error.code === "P0001") {
    const message = error.message ?? "";
    if (message.includes("USER_NOT_FOUND")) {
      return new PlatformError("NOT_FOUND", "Usuario no encontrado.", 404);
    }
    if (message.includes("ROLE_NOT_FOUND")) {
      return new PlatformError("VALIDATION", "Rol desconocido.", 400);
    }
  }
  return new PlatformError("INTERNAL", "Error interno.", 500);
}

/** Los códigos de rol que el usuario tiene HOY, leídos de la base. */
async function readPlatformUserRoles(
  db: Awaited<ReturnType<typeof platformDb>>,
  userId: string,
): Promise<RoleCode[]> {
  const { data, error } = await db
    .from("user_roles")
    .select("roles(code)")
    .eq("user_id", userId);
  if (error) throw new PlatformError("INTERNAL", "Error interno.", 500);
  const codes: RoleCode[] = [];
  for (const fila of (data ?? []) as unknown as Array<{
    roles: { code: string } | Array<{ code: string }> | null;
  }>) {
    const embebidos = Array.isArray(fila.roles) ? fila.roles : fila.roles ? [fila.roles] : [];
    for (const item of embebidos) if (isRoleCode(item.code)) codes.push(item.code);
  }
  return codes;
}

/**
 * G5: los usuarios de la sede ELEGIDA con sus roles, para que la plataforma
 * decida quién administra cada sede.
 *
 * AISLAMIENTO: lectura CROSS-SEDE explícita (service_role, sin predicado de
 * sede) como `listPlatformSedes`; NO usa `resolveSede`, que es la frontera del
 * negocio. La sede llega ELEGIDA en el cuerpo y el privilegio se re-aplica acá.
 *
 * A diferencia de la lista del negocio NO se incluye a los usuarios sin sede:
 * `users.sede_id` es NOT NULL desde la 003, así que esa rama no puede tener
 * filas, y ofrecerla en la plataforma dejaría abierta la puerta de "asignar el
 * rol de alguien que no está en ninguna sede".
 */
export async function listPlatformSedeUsers(
  raw: unknown,
  actor: PlatformActor,
): Promise<PlatformSedeUserRow[]> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  const parsed = platformSedeTargetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { sede_id } = parsed.data;
  const db = await platformDb();

  const { data: users, error } = await db
    .from("users")
    .select(PLATFORM_USER_SELECT)
    .eq("sede_id", sede_id)
    .order("full_name")
    .order("id");
  if (error) throw new PlatformError("INTERNAL", "Error interno.", 500);
  const filas = (users ?? []) as Array<{
    id: string;
    sede_id: string | null;
    full_name: string;
    id_number: string;
  }>;
  if (filas.length === 0) return [];

  const { data: roleRows, error: roleError } = await db
    .from("user_roles")
    .select("user_id, roles(code)")
    .in(
      "user_id",
      filas.map((fila) => fila.id),
    );
  if (roleError) throw new PlatformError("INTERNAL", "Error interno.", 500);

  const porUsuario = new Map<string, RoleCode[]>();
  for (const fila of (roleRows ?? []) as unknown as Array<{
    user_id: string;
    roles: { code: string } | Array<{ code: string }> | null;
  }>) {
    const codigos = Array.isArray(fila.roles)
      ? fila.roles.map((item) => item.code)
      : fila.roles
        ? [fila.roles.code]
        : [];
    for (const codigo of codigos) {
      if (!isRoleCode(codigo)) continue;
      porUsuario.set(fila.user_id, [...(porUsuario.get(fila.user_id) ?? []), codigo]);
    }
  }

  return filas.map((fila) => ({ ...fila, roles: porUsuario.get(fila.id) ?? [] }));
}

/**
 * El cuerpo del reemplazo. `roleCodeSchema` (el catálogo completo) y NO el
 * lista de sede: la diferencia entre "no existe ese rol" y "ese rol no se
 * asigna desde acá" la decide la puerta de permisos de más abajo, que responde
 * 403 con el motivo. Es exactamente el criterio de `setUserRoles`.
 */
const setPlatformSedeUserRolesSchema = z.object({
  sede_id: z.uuid("Sede inválida."),
  user_id: z.uuid("Identificador inválido."),
  roles: z.array(roleCodeSchema).length(1, "Un solo rol por usuario."),
});

/**
 * G5: reemplaza el rol de un usuario de la sede ELEGIDA —es la forma de dar Y
 * de quitar `admin`: quitarla es dejarle el rol que sí corresponde— de
 * forma ATÓMICA, con la misma función `replace_user_roles` (039) que usa el
 * negocio y el mismo post-condición. NO hay DELETE + INSERT sueltos: entre dos
 * sentencias sin transacción un fallo deja al usuario con CERO roles.
 *
 * AISLAMIENTO: escritura CROSS-SEDE explícita; la sede y el usuario llegan
 * ELEGIDOS en el cuerpo y el privilegio se re-aplica acá, antes de leer y de
 * escribir. El usuario tiene que PERTENECER a esa sede: es el mismo 403 de
 * `resolveSede` que usa el negocio, con el mensaje que lo dice.
 *
 * El conjunto asignable es el MISMO que en la administración de una sede
 * (`sedeAssignableRoleSchema`): la plataforma administra QUIÉN administra cada
 * sede, no inventa un catálogo propio. Por eso `superadmin` NO se otorga ni se
 * quita desde acá —eso lo mantiene el mismo candado que en `setUserRoles`—: sin
 * esta puerta, la plataforma sería una segunda puerta de atrás hacia el techo de
 * privilegios.
 *
 * AUDITORÍA: el cambio mueve el poder de una persona sobre una sede entera, así
 * que la entrada lleva el cambio CONCRETO —los roles de antes y los de después—
 * para que un auditor pueda reconstruir la decisión y no sólo ver que algo se
 * movió.
 */
export async function setPlatformSedeUserRoles(
  raw: unknown,
  actor: PlatformActor,
): Promise<{ sede_id: string; user_id: string; roles: SedeAssignableRole[] }> {
  requireSedeRole(actor.roles, PLATFORM_ROLES);
  const parsed = setPlatformSedeUserRolesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlatformError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const { sede_id, user_id, roles: pedidos } = parsed.data;

  // 1) El conjunto pedido tiene que ser asignable desde la lista de sede. Se
  //    comprueba ANTES de tocar la base: un rechazo no lee ni escribe.
  if (pedidos.some((rol) => !isSedeAssignableRole(rol))) {
    throw new PlatformError(
      "FORBIDDEN",
      "El rol de plataforma no se asigna ni se quita desde la lista de roles de una sede.",
      403,
    );
  }

  // 2) La fila propia de la plataforma no es una sede que la plataforma administre:
  //    es donde se ancla la cuenta de plataforma (G2), y sus usuarios son los de
  //    la cuenta, no una sede del negocio. Se reconoce por la MISMA bandera de
  //    dato que usa `listPlatformSedes` —`fila.id === actor.sedeId`— y NUNCA por
  //    el nombre de la fila.
  if (sede_id === actor.sedeId) {
    throw new PlatformError(
      "FORBIDDEN",
      "La fila de sede de la plataforma no administra sus propios usuarios.",
      403,
    );
  }

  const db = await platformDb();

  // 3) El usuario tiene que existir y PERTENECER a la sede elegida. Un usuario de
  //    otra sede es el mismo 403 de `resolveSede` del negocio: no hay acceso.
  const { data: usuario, error: usuarioError } = await db
    .from("users")
    .select("id, sede_id, full_name")
    .eq("id", user_id)
    .maybeSingle();
  if (usuarioError) throw new PlatformError("INTERNAL", "Error interno.", 500);
  if (!usuario) throw new PlatformError("NOT_FOUND", "Usuario no encontrado.", 404);
  if ((usuario as { sede_id: string | null }).sede_id !== sede_id) {
    throw new PlatformError("FORBIDDEN", "El usuario no pertenece a esa sede.", 403);
  }

  // 4) Los roles ACTUALES, que son las dos cosas que esta función necesita: lo
  //    que va a la auditoría, y la comprobación de que el reemplazo no le
  //    arranque a una cuenta de plataforma el rol que sólo la base le da.
  const actuales = await readPlatformUserRoles(db, user_id);
  if (actuales.some((rol) => !isSedeAssignableRole(rol))) {
    throw new PlatformError(
      "FORBIDDEN",
      "El rol de plataforma no se asigna ni se quita desde la lista de roles de una sede.",
      403,
    );
  }

  // 5) El reemplazo entero, en UNA sentencia (039), con el candado de la fila
  //    del usuario adentro: dos reemplazos concurrentes se serializan.
  const { data, error } = await db.rpc("replace_user_roles", {
    p_user_id: user_id,
    p_role_codes: pedidos,
  });
  if (error) throw roleReplacementError(error);

  // 6) Post-condición: éxito sólo si la base devolvió EXACTAMENTE lo pedido. Un
  //    arreglo vacío o un subconjunto significa "no quedó el rol aplicado", y eso
  //    jamás es un éxito, por más que el rpc no haya dado error.
  const aplicados = (Array.isArray(data) ? data : []).filter(isSedeAssignableRole);
  if (aplicados.length !== pedidos.length || !aplicados.every((code) => pedidos.includes(code))) {
    throw new PlatformError("INTERNAL", "Error interno.", 500);
  }

  // 7) Auditoría: actor, sede objetivo, usuario y el cambio de conjuntos.
  await writeAudit({
    sede_id,
    user_id: actor.userId,
    action: AUDIT_ACTIONS.PLATFORM_SEDE_ROLES_SET,
    entity: "users",
    entity_id: user_id,
    metadata: {
      previous_roles: actuales,
      new_roles: aplicados,
    },
  });

  return { sede_id, user_id, roles: aplicados };
}
