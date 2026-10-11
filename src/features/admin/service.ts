import {
  employeeSchema,
  normalizeEmployeeCode,
  normalizePaymentMethodCode,
  paymentMethodSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
  type EmployeeInput,
  type PaymentMethodInput,
  type ServiceInput,
  type TaxConfigInput,
} from "./schemas";
import { isRoleCode, type RoleCode } from "@/src/features/auth/schemas";
import {
  DEFAULT_EMPLOYEE_ROLE,
  roleIsAssignableForSede,
  rolesAreNonEmpty,
  violatesSuperadminGuard,
} from "./role-policy";
import { getSessionUser, hashPassword } from "@/src/features/auth/service";
import { readAllPaged } from "@/src/shared/lib/paged";
import { unstable_cache } from "next/cache";
import { servicesRepo, type ServiceRow } from "./repos/services";
import { catalogsRepo } from "./repos/catalogs";
import { adminUsersRepo } from "./repos/users";
import { DbQueryError } from "@/src/shared/db/errors";
import { COP_WHOLE_PESO_MESSAGE, isCopWholePesoError } from "@/src/shared/money/cop";

// Compatibilidad: la identidad de estos guardas vive en
// `@/src/shared/lib/sede.ts` (import cruzado entre features resuelto).
// Se re-exportan aquí para no romper importadores existentes; el código
// nuevo importa desde shared. Misma clase: `instanceof` intacto.
import {
  requireSedeRole,
  SedeError as AdminError,
} from "@/src/shared/lib/sede";
export {
  requireSedeRole,
  SedeError as AdminError,
} from "@/src/shared/lib/sede";

/**
 * Mapa de dominios (SRP, decisión pre-pruebas 2026-09-22):
 * 1) Sesión (requireSession/requireAdminSession) 2) Sedes 3) Empleados+usuarios
 * 4) Catálogos (servicios, impuestos, métodos de pago) 5) Roles.
 * El split físico en módulos se difiere a post-pruebas para no romper
 * los 12 importadores activos; el código nuevo usa `@/src/shared/lib/sede.ts`.
 */

/**
 * Límite de lectura para listados (navegación instantánea): todo listado
 * trae como máximo 50 filas por defecto; los usos internos que necesitan
 * cobertura total (p. ej. validaciones de facturación/nómina) pasan un
 * límite explícito mayor. Nunca sin límite.
 */
function clampLimit(limit: number | undefined, def = 50, max = 500): number {
  if (limit === undefined) return def;
  if (!Number.isFinite(limit)) return def;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

/**
 * Caché de catálogos (lecturas de referencia que cambian rara vez).
 * Frescura por evento: cada mutación del admin invalida su etiqueta con
 * revalidateTag, así un cambio se ve al instante. `revalidate` (1 hora)
 * es solo el respaldo por si la base se edita fuera de la app.
 */
const CATALOG_TTL_SECONDS = 3600;

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

// ------------------------------------------------------- roles por sede ---
// `requireSedeRole` vive en `@/src/shared/lib/sede.ts` (re-exportado arriba).

export interface AdminSession {
  userId: string;
  sedeId: string;
  roles: RoleCode[];
}

/**
 * Sesión del MVP (cookie orabella_session) con rol admin verificado.
 * Lecturas: cualquier rol autenticado. Escrituras: solo admin.
 */
export async function requireAdminSession(
  token: string | null | undefined,
): Promise<AdminSession> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new AdminError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  requireSedeRole(session.roles, ["admin"]);
  if (!session.user.sede_id) {
    throw new AdminError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

/** Sesión autenticada (cualquier rol) con sede asignada. Para lecturas. */
export async function requireSession(token: string | null | undefined): Promise<AdminSession> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new AdminError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  if (!session.user.sede_id) {
    throw new AdminError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

/**
 * El MVP es de una sola sede: la fila de `sedes` describe LA INSTALACIÓN y
 * ninguna escritura ni lectura del negocio la nombra ya (ver el bloque final de
 * este archivo).
 */

// ------------------------------------------------------------- empleados ---
/**
 * F2: `pay_frequency` is always selected; `null` means no declared cadence.
 * Re-exported from the port so both adapters have exactly this domain contract.
 */
export type { EmployeeCatalogRow as EmployeeRow } from "./repos/catalogs";
import type { EmployeeCatalogRow as EmployeeRow } from "./repos/catalogs";

export interface SedeUserRow {
  id: string;
  /**
   * La fila de la cuenta sigue nombrando la instalación a la que pertenece, y
   * la pestaña de Roles la muestra (`· sin instalación`). Es un campo DEVUELTO de la
   * lectura, no un criterio con el que esta lectura se acote.
   */
  sede_id: string | null;
  full_name: string;
  id_number: string;
  roles: RoleCode[];
}

async function fetchEmployees(limit?: number): Promise<EmployeeRow[]> {
  const repo = await catalogsRepo();
  return internalOnFailure(() => repo.listEmployees(clampLimit(limit)));
}

/** A repository failure keeps the historical answer of the catalog readers. */
async function internalOnFailure<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
}

/**
 * U7: la planta COMPLETA de la sede, sin el tope del listado.
 *
 * `fetchEmployees` existe para LISTAR con respuesta instantánea: 50 filas por
 * defecto y 500 como techo interno (`clampLimit`). Ese tope es correcto para una
 * lista de navegación y equivocado para la nómina: `calculatePayroll` armaba su
 * alineación con el listado acotado y `clampLimit` recortaba a 500, así que el
 * empleado 501 no quedaba mal pagado —quedaba AUSENTE de la nómina, sin un solo
 * error—. Lo correcto es leerlo entero por páginas, con `order()` determinista.
 *
 * Sin caché a propósito: una sede cuya última alta es de hace un minuto tiene que
 * entrar en la nómina de hoy, y una planta cacheada es una planta incompleta (ese
 * es exactamente el defecto que esto cierra). El fallo de la lectura se PROPAGA
 * (`PagedReadError`): el llamador de plata lo convierte en un error de negocio a
 * la vista, nunca en "leí lo que alcancé".
 */
export async function listAllEmployees(): Promise<EmployeeRow[]> {
  const repo = await catalogsRepo();
  // Orden (full_name, id) determinista: lo fija el puerto en ambos motores.
  return readAllPaged<EmployeeRow>({
    table: "employees",
    fetchPage: (from, to) => repo.employeesPage(from, to),
  });
}

export async function getEmployee(id: string): Promise<EmployeeRow> {
  const repo = await catalogsRepo();
  const data = await internalOnFailure(() => repo.findEmployee(id));
  if (!data) throw new AdminError("NOT_FOUND", "Empleado no encontrado.", 404);
  return data;
}

/**
 * Usuarios de la instalación con sus roles (selector de vínculo + pestaña
 * Roles). Incluye las cuentas sin sede para que ninguna quede invisible sin
 * rol.
 *
 * El alcance se sigue declarando por `sedeId` (la fila DEVUELTA trae `sede_id` y
 * la pestaña de Roles la muestra) pero ya NO es una frontera: con una sola
 * instalación, `sedeId` es el identificador de esa instalación y el filtro sólo
 * reúne sus cuentas más las que todavía no tienen ninguna.
 */
export async function listSedeUsers(sedeId: string): Promise<SedeUserRow[]> {
  // Data access goes through `./repos/users` (DB_ENGINE). Intentional change on
  // both engines: the sede is a quoted/typed value, never PostgREST syntax, and
  // the order is total (full_name, id).
  const repo = await adminUsersRepo();
  const rows = await internalOnFailure(() => repo.listSedeUsers(sedeId));
  const roleRows = await internalOnFailure(() => repo.roleEmbeds(rows.map((row) => row.id)));
  const byUser = new Map<string, RoleCode[]>();
  for (const code of roleRows) {
    if (!code.roles || !isRoleCode(code.roles.code)) continue;
    byUser.set(code.user_id, [...(byUser.get(code.user_id) ?? []), code.roles.code]);
  }
  return rows.map((row) => ({ ...row, roles: byUser.get(row.id) ?? [] }));
}

/**
 * ADM-02/ADM-03/ADM-08: crea o actualiza un empleado. Valida la unicidad
 * parcial de employee_code a nivel app (además del índice
 * uq_employees_sede_code) para devolver un error de negocio claro.
 *
 * `sedeId` NO viene del cuerpo: lo resuelve el servidor (la sesión) y sólo se usa
 * para los ARGUMENTOS de `upsert_employee_atomic`, que son contrato de la base y
 * este cambio no toca. La escritura suelta de una edición NO manda la columna.
 */
export async function upsertEmployee(raw: unknown, sedeId: string): Promise<EmployeeRow> {
  const parsed = employeeSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: EmployeeInput = parsed.data;
  const code = normalizeEmployeeCode(input.employee_code);
  const repo = await adminUsersRepo();

  // Vínculo automático por documento (no editable): el usuario de acceso
  // es el de la sede con el mismo documento. El user_id que traiga el input se
  // ignora a propósito.
  //
  // CL-15: si NO hay coincidencia, el usuario NO se crea acá. La creación viaja
  // adentro de `upsert_employee_atomic` (054), en la MISMA sentencia que el rol
  // y el legajo: un usuario creado desde el cliente era la mitad de la ventana
  // —quedaba con login y rol, y sin legajo, cuando la escritura siguiente
  // fallaba—.
  const linked = await internalOnFailure(() => repo.findUserByDocument(input.document));
  const userId = linked?.id ?? null;
  if (userId) {
    const taken = await internalOnFailure(() => repo.employeeForUser(userId, input.id));
    if (taken.length > 0) {
      throw new AdminError("USER_ALREADY_LINKED", "Ese documento ya está vinculado a otro empleado.", 409);
    }
  }

  if (code !== null) {
    const conflicts = await internalOnFailure(() => repo.employeeCodeConflicts(code, input.id));
    if (conflicts.length > 0) {
      throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe.", 409);
    }
  }

  // Red de seguridad de roles (solo al crear): si el usuario vinculado NO tiene
  // ningún rol, se le asigna `empleado` para que nadie quede sin acceso por
  // olvido.
  //
  // CO-4: la decisión ya NO se toma desde el cliente. Un `select` seguido de un
  // `insert` son DOS requests de PostgREST —dos transacciones— y entre ellos
  // nada impide que otro escritor confirme un rol: la red leía "cero roles",
  // `setUserRoles` dejaba `admin`, y el insert de la red agregaba `empleado`.
  // El usuario terminaba con DOS roles, y el modelo del proyecto es uno por
  // usuario (`setUserRolesSchema` exige `.length(1)`). Una relectura de
  // compensación no arregla nada: también está sin lock y podría borrar un rol
  // legítimo. La decisión viaja por lo tanto a UNA sentencia del servidor —hoy
  // `upsert_employee_atomic` (054), que COMPONE `ensure_user_has_role` (040) y
  // toma el lock de la fila del usuario (`FOR UPDATE`) antes de escribir—. Ese
  // lock es el MISMO que toma `replace_user_roles` (039): los dos escritores de
  // roles quedan serializados y el intercalado deja de ser posible.
  //
  // CL-15: además, el alta ENTERA —el usuario si hay que crearlo, su rol y el
  // legajo— viaja en esa misma sentencia. Antes eran hasta TRES requests de
  // PostgREST: el `insert` del usuario, el rpc de la red de seguridad y el
  // `upsert` del empleado. Un fallo entre ellos dejaba un usuario con login y
  // rol pero SIN legajo —puede entrar y no existe como empleado—, y el legajo
  // quedaba sin la persona que lo respalda. Adentro de una transacción no hay
  // "entre ellos": o se escriben las tres cosas, o no se escribe ninguna.
  //
  // Las comprobaciones de negocio de arriba (`USER_ALREADY_LINKED`,
  // `EMPLOYEE_CODE_TAKEN`) SIGUEN mandando para el error legible, y la función
  // las repite adentro sobre la fila bloqueada, que es lo que las vuelve
  // verdaderas al momento de escribir.
  //
  // El rpc levanta `RAISE EXCEPTION` plano (SQLSTATE P0001, o el 23505 del
  // índice parcial de `employee_code`) cuando el usuario o el rol no existen.
  // Acá NO se traduce a un error de negocio como en `setUserRoles`: el usuario
  // y el rol los eligió el propio servicio, así que cualquiera de los dos casos
  // significa dato o permiso roto —el mismo contrato que ya tenía esta ruta
  // cuando el catálogo no traía `empleado`— y se reporta como error interno. El
  // único 23505 que se traduce es el del código de empleado, que es el mismo
  // contrato de carrera que ya tenía el `upsert` suelto.
  //
  // Al actualizar (`input.id`) no se consulta: los roles no se tocan, y el
  // legajo se sigue escribiendo con su `upsert` de siempre (UNA escritura, que
  // no necesita transacción para ser atómica).
  // El argumento del RPC (054/065) es contrato de la base: se entrega completo,
  // con la fila que nombra la instalación. `columnasDelLegajo` es la MISMA lista
  // sin esa columna, y es lo que viaja en la escritura suelta de una edición:
  // el alta y la edición no pueden escribir conjuntos distintos de columnas.
  const columnasDelLegajo = {
    full_name: input.full_name,
    employee_code: code,
    document: input.document,
    phone: input.phone ?? null,
    position: input.position ?? null,
    ...(input.payout_mode !== undefined ? { payout_mode: input.payout_mode } : {}),
    email: input.email?.trim() ? input.email.trim() : null,
    birth_date: input.birth_date?.trim() ? input.birth_date : null,
    pay_type: input.pay_type,
    // F2: la cadencia viaja en la MISMA escritura que el resto del legajo, tanto
    // en el alta (dentro de `p_employee`, que la escribe la 065) como en la
    // edición (el `upsert` suelto escribe las columnas por nombre). El nulo es
    // "sin cadencia definida" y no cambia el cálculo de hoy.
    pay_frequency: input.pay_frequency ?? null,
    salary_fixed: input.salary_fixed ?? null,
    commission_percent: input.commission_percent ?? null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };

  if (!input.id) {
    // El legajo NO lleva la sede (`employees.sede_id` se borró en la 077); la
    // cuenta de acceso SÍ: `p_create_user.sede_id` ancla la fila de `users` a la
    // instalación y es el origen de `session.sedeId`.
    let created: EmployeeRow | null;
    try {
      created = await repo.upsertEmployeeAtomic(columnasDelLegajo, userId, userId ? null : {
        sede_id: sedeId,
        email: input.email?.trim() ? input.email.trim() : null,
        phone: input.phone ?? null,
        id_type: "CC",
        id_number: input.document,
        password_hash: await hashPassword(input.document),
        full_name: input.full_name,
      }, DEFAULT_EMPLOYEE_ROLE);
    } catch (error) {
      if (error instanceof DbQueryError && error.error.code === "23505") {
        throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe.", 409);
      }
      throw new AdminError("INTERNAL", "Error interno.", 500);
    }
    if (!created) throw new AdminError("INTERNAL", "Error interno.", 500);
    return created;
  }

  let data: EmployeeRow | null;
  try {
    data = await repo.upsertEmployee({ id: input.id, ...columnasDelLegajo, user_id: userId });
  } catch (error) {
    if (error instanceof DbQueryError && error.error.code === "23505") {
      throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe.", 409);
    }
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data;
}

// -------------------------------------------------------------- services ---
// Data access goes through the repository port (`./repos/services.ts`), which
// picks supabase-js or the direct PostgreSQL connection from DB_ENGINE. Any
// repository failure keeps the historical answer: INTERNAL 500.
export type { ServiceRow } from "./repos/services";

async function fetchServices(limit?: number): Promise<ServiceRow[]> {
  const repo = await servicesRepo();
  try {
    return await repo.list(clampLimit(limit));
  } catch {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
}

/** ADM-05: crea o actualiza un servicio (upsert por id). */
export async function upsertService(raw: unknown): Promise<ServiceRow> {
  const parsed = serviceSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: ServiceInput = parsed.data;
  const repo = await servicesRepo();
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    duracion_min: input.duracion_min,
    duracion_max: input.duracion_max,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  let data: ServiceRow | null;
  try {
    data = await repo.upsert(payload);
  } catch {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data;
}

// ----------------------------------------------------------------- taxes ---
export type { TaxConfigRow } from "./repos/catalogs";
import type { TaxConfigRow } from "./repos/catalogs";

async function fetchTaxes(limit?: number): Promise<TaxConfigRow[]> {
  const repo = await catalogsRepo();
  return internalOnFailure(() => repo.listTaxes(clampLimit(limit)));
}

/** ADM-06: crea o actualiza un impuesto de la instalación (upsert por id). */
export async function upsertTaxConfig(raw: unknown): Promise<TaxConfigRow> {
  const parsed = taxConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: TaxConfigInput = parsed.data;
  const repo = await catalogsRepo();
  const data = await internalOnFailure(() =>
    repo.upsertTax({
      ...(input.id ? { id: input.id } : {}),
      code: input.code,
      name: input.name,
      percent: input.percent,
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
    }),
  );
  if (!data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data;
}

// ------------------------------------------------------- payment methods ---
export type { PaymentMethodRow } from "./repos/catalogs";
import type { PaymentMethodRow } from "./repos/catalogs";

async function fetchPaymentMethods(limit?: number): Promise<PaymentMethodRow[]> {
  const repo = await catalogsRepo();
  return internalOnFailure(() => repo.listPaymentMethods(clampLimit(limit)));
}

/**
 * ADM-07/003: creates a method with a free normalized code, or edits name,
 * active flag, fee and arqueo mode of an existing one. The code is immutable:
 * an edit that sends a different code is rejected before writing (the
 * database trigger is the final barrier).
 */
export async function upsertPaymentMethod(raw: unknown): Promise<PaymentMethodRow> {
  const parsed = paymentMethodSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: PaymentMethodInput = parsed.data;
  const code = input.code ? normalizePaymentMethodCode(input.code) : undefined;
  const repo = await catalogsRepo();
  const fields = {
    name: input.name,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
    ...(input.arqueo_mode !== undefined ? { arqueo_mode: input.arqueo_mode } : {}),
    ...(input.fee_percent !== undefined ? { fee_percent: input.fee_percent } : {}),
  };
  if (input.id) {
    const id = input.id;
    const current = await internalOnFailure(() => repo.findPaymentMethod(id));
    if (!current) throw new AdminError("NOT_FOUND", "Método de pago no encontrado.", 404);
    if (code && code !== current.code) {
      throw new AdminError("PAYMENT_METHOD_CODE_IMMUTABLE", "El código de un método no se puede cambiar.", 409);
    }
    return paymentMethodWrite(() => repo.updatePaymentMethod(id, fields));
  }
  // `code` is present on creation: the schema requires it without an id.
  return paymentMethodWrite(() =>
    repo.insertPaymentMethod({ code: code as string, arqueo_mode: "none", ...fields }),
  );
}

/** A write that fails or returns no row goes through `paymentMethodWriteError`. */
async function paymentMethodWrite(call: () => Promise<PaymentMethodRow | null>): Promise<PaymentMethodRow> {
  let data: PaymentMethodRow | null;
  try {
    data = await call();
  } catch (error) {
    throw paymentMethodWriteError(error instanceof DbQueryError ? error.error : null);
  }
  if (!data) throw paymentMethodWriteError(null);
  return data;
}

/** Maps the stable database errors of 003 to business errors. */
export function paymentMethodWriteError(
  error: { code?: string | null; message?: string; details?: string | null } | null,
): AdminError {
  const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
  if (text.includes("PAYMENT_METHOD_CODE_IMMUTABLE")) {
    return new AdminError("PAYMENT_METHOD_CODE_IMMUTABLE", "El código de un método no se puede cambiar.", 409);
  }
  if (text.includes("uq_payment_methods_single_denominations")) {
    return new AdminError("VALIDATION", "Solo un método puede contarse por denominaciones.", 400);
  }
  if (error?.code === "23505") {
    return new AdminError("PAYMENT_METHOD_CODE_TAKEN", "Ya existe un método con ese código.", 409);
  }
  if (text.includes("payment_methods_code_format_check")) {
    return new AdminError("VALIDATION", "Código inválido: use minúsculas, números, guion o guion bajo.", 400);
  }
  return new AdminError("INTERNAL", "Error interno.", 500);
}

// ------------------------------------------------------------------ roles ---
/**
 * Códigos de rol que el usuario tiene HOY, leídos de la base.
 *
 * Es la lectura previa del reemplazo: la administración de una sede no puede
 * QUITARLE un rol de plataforma a nadie, y `replace_user_roles` reemplaza el
 * conjunto entero, así que la única forma de saber si el cambio lo revocaría es
 * mirar el conjunto actual antes de pedirlo.
 */
async function currentRoleCodes(userId: string): Promise<RoleCode[]> {
  const repo = await adminUsersRepo();
  const rows = await internalOnFailure(() => repo.userRoleEmbeds(userId));
  return rows.flatMap((row) => row.roles && isRoleCode(row.roles.code) ? [row.roles.code] : []);
}

/**
 * Traduce la excepción de `replace_user_roles` a error de negocio. La función
 * levanta `RAISE EXCEPTION` plano (SQLSTATE P0001), el mismo código que ya
 * traducen payroll, cash, billing, commissions y los topes 031/034.
 */
function roleReplacementError(error: { code?: string; message?: string }): AdminError {
  if (isCopWholePesoError(error)) return new AdminError("VALIDATION", COP_WHOLE_PESO_MESSAGE, 400);
  if (error.code === "P0001") {
    const message = error.message ?? "";
    if (message.includes("USER_NOT_FOUND")) {
      return new AdminError("NOT_FOUND", "Usuario no encontrado.", 404);
    }
    if (message.includes("ROLE_NOT_FOUND")) {
      return new AdminError("VALIDATION", "Rol desconocido.", 400);
    }
  }
  return new AdminError("INTERNAL", "Error interno.", 500);
}

/**
 * ADM-04: reemplaza el rol de un usuario (uno solo) de forma ATÓMICA.
 *
 * El reemplazo viaja en UNA sentencia —la función `replace_user_roles` vía
 * `db.rpc`— y no en un DELETE + INSERT sueltos desde el cliente: PostgREST no
 * ofrece multi-statement por request (misma nota del README de facturación para
 * `createInvoice`), así que entre los dos statements no hay transacción. Con el
 * INSERT fallando, el DELETE ya había confirmado y el usuario quedaba con CERO
 * roles: `requireSedeRole` lo rechazaba con 403 en todo el app. Adentro de la
 * función, en cambio, el DELETE y el INSERT comparten la transacción del
 * servidor: o entra el conjunto nuevo entero, o no entra nada y queda el viejo.
 * No es una cuestión de orden: borrar primero deja cero roles si el insert
 * falla, e insertar primero sobre-privilegia si el delete falla. La función
 * toma además el lock de la fila del usuario, así que dos reemplazos
 * concurrentes se serializan en vez de intercalarse en un conjunto mezclado.
 *
 * Surte efecto en el siguiente refresh de sesión porque getSessionUser lee
 * user_roles en cada request.
 */
export async function setUserRoles(raw: unknown): Promise<{ user_id: string; roles: RoleCode[] }> {
  const parsed = setUserRolesSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);

  // G1: el catálogo ya incluye `superadmin`, así que validar "el código existe"
  // dejó de alcanzar —ese era exactamente el agujero—. La administración de una
  // sede SOLO toca roles asignables desde sede; el rol de plataforma se rechaza
  // ANTES del rpc, así que la base no escribe nada: ni lo otorga ni lo quita.
  //
  // Y con la capa de plataforma ya retirada (U12), no hay a dónde ir por él: el
  // mensaje que se lleva la persona lo dice, en vez de mandarla a una puerta que
  // no existe. Es el MISMO literal en las dos guardas —otorgar y quitar son la
  // misma verdad sobre el mismo rol— y el rechazo queda idéntico: mismo
  // `FORBIDDEN`, mismo 403, misma puerta antes del rpc.
  if (!rolesAreNonEmpty(parsed.data.roles)) {
    throw new AdminError("VALIDATION", "Un solo rol por usuario.", 400);
  }
  if (violatesSuperadminGuard(parsed.data.roles)) {
    throw new AdminError(
      "FORBIDDEN",
      "El rol superadmin no se puede asignar ni quitar desde la aplicación.",
      403,
    );
  }
  const rolesActuales = await currentRoleCodes(parsed.data.user_id);
  if (violatesSuperadminGuard(rolesActuales)) {
    throw new AdminError(
      "FORBIDDEN",
      "El rol superadmin no se puede asignar ni quitar desde la aplicación.",
      403,
    );
  }

  const repo = await adminUsersRepo();
  let data: unknown;
  try {
    data = await repo.replaceUserRoles(parsed.data.user_id, parsed.data.roles);
  } catch (error) {
    throw roleReplacementError(error instanceof DbQueryError ? { code: error.error.code ?? undefined, message: error.error.message } : {});
  }

  // Post-condición: se reporta éxito sólo si la base devolvió el conjunto
  // pedido. Un arreglo vacío significa "no quedó ningún rol aplicado": eso
  // jamás es un éxito, por más que el rpc no haya dado error.
  const aplicados = (Array.isArray(data) ? data : []).filter(
    (code): code is RoleCode => roleIsAssignableForSede(code),
  );
  const pedidos = parsed.data.roles;
  if (aplicados.length !== pedidos.length || !aplicados.every((code) => pedidos.includes(code))) {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }

  return { user_id: parsed.data.user_id, roles: aplicados };
}

// ------------------------------------------ listados con caché (catálogos) ---
//
// G5: la lista de sedes (`listSedes`, etiqueta `catalog:sedes`) se eliminó con
// sus dos acciones. Estos servicios ya no leen ni escriben la tabla `sedes`, y
// ya no queda nadie que la lea: se retiró la capa de plataforma, que era la
// única que nombraba esa fila para CONFIGURAR la fecha de arranque de la nómina.
// Esa fecha dejó de ser una configuración y pasó a ser un HECHO DERIVADO —
// `payrollHistoryFloor(periods)`, el `min(payroll_periods.start_date)`, el día
// del PRIMER período (`payroll/service.ts`)— y cuando todavía no hay ningún
// período, la declara la primera liquidación, dentro del diálogo de apertura.
// La fila de `sedes` y su columna de fecha quedan como DEUDA declarada, igual
// que el rol `superadmin`: borrarlas obliga a regenerar el archivo único de
// esquema y a resetear las dos bases.
//
// La columna `sede_id` sigue existiendo y esta unidad NO la retira: lo que se
// retiró fue el alcance multi sede de las lecturas que ya no lo necesitan, no la
// columna. Donde la columna todavía la exige, estos servicios la siguen
// mandando, porque mientras exista la base la exige:
//
//   * `upsertEmployee` la manda en el alta, dentro de `p_employee` y de
//     `p_create_user` de `upsert_employee_atomic` (065), que inserta en
//     `employees` y en `users`.
//   * `listSedeUsers` la trae de vuelta y la usa como predicado: la lectura
//     devuelve `sede_id` y acota con "sede_id = <sede> o sede_id nulo", para
//     que las cuentas todavía sin sede no queden invisibles sin rol.
//
// Todo eso se retira con el borrado FÍSICO de la columna en la migración final
// de una sola sede (M3c), no antes: hasta entonces el servicio tiene que
// escribirla donde la base la exige.
//
// Lo que queda autorizando es el ROL, no la fila: `requireSedeRole` y las guardas
// de sesión (`requireSession`, `requireAdminSession`) no se tocan. La sede de la
// sesión sigue siendo un dato real —la cuenta la tiene— y es lo que esos dos
// candados autorizan; lo que ya no está es el alcance por sede en las lecturas
// del resto del negocio.

export const listEmployees = unstable_cache(fetchEmployees, ["catalog:employees"], {
  tags: ["catalog:employees"],
  revalidate: CATALOG_TTL_SECONDS,
});

export const listServices = unstable_cache(fetchServices, ["catalog:services"], {
  tags: ["catalog:services"],
  revalidate: CATALOG_TTL_SECONDS,
});

export const listTaxes = unstable_cache(fetchTaxes, ["catalog:taxes"], {
  tags: ["catalog:taxes"],
  revalidate: CATALOG_TTL_SECONDS,
});

export const listPaymentMethods = unstable_cache(fetchPaymentMethods, ["catalog:payment-methods"], {
  tags: ["catalog:payment-methods"],
  revalidate: CATALOG_TTL_SECONDS,
});
