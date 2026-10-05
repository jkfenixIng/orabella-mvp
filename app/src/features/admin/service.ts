import {
  employeeSchema,
  normalizeEmployeeCode,
  paymentMethodSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
  type EmployeeInput,
  type PaymentMethodInput,
  type ServiceInput,
  type TaxConfigInput,
} from "./schemas";
import { isRoleCode, isSedeAssignableRole, type RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser, hashPassword } from "@/src/features/auth/service";
import { readAllPaged } from "@/src/shared/lib/paged";
import { unstable_cache } from "next/cache";

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
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function adminDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

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
export interface EmployeeRow {
  id: string;
  user_id: string | null;
  full_name: string;
  employee_code: string | null;
  document: string;
  phone: string | null;
  position: string | null;
  payout_mode: string;
  email: string | null;
  birth_date: string | null;
  pay_type: string;
  /**
   * F2: cadencia acordada con el empleado (`employees.pay_frequency`, 063).
   * `null` es «sin cadencia definida»: el fijo se prorratea por los días del
   * período, que es el comportamiento de hoy.
   *
   * REQUERIDA: `EMPLOYEE_SELECT` la trae siempre, así que el tipo no puede
   * mentir dejándola opcional. Una fila sin la clave sería un legajo leído con
   * un `select` incompleto, no un caso válido.
   */
  pay_frequency: string | null;
  salary_fixed: number | null;
  commission_percent: number | null;
  is_active: boolean;
}

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

const EMPLOYEE_SELECT =
  "id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, pay_frequency, salary_fixed, commission_percent, is_active";

async function fetchEmployees(limit?: number): Promise<EmployeeRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("employees")
    .select(EMPLOYEE_SELECT)
    .order("full_name")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as EmployeeRow[];
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
  const db = await adminDb();
  return readAllPaged<EmployeeRow>({
    table: "employees",
    fetchPage: (from, to) =>
      db
        .from("employees")
        .select(EMPLOYEE_SELECT)
        // El nombre es el orden histórico de la lista; `id` desempata para que
        // dos homónimos no caigan en páginas distintas (ni se repitan ni falten).
        .order("full_name")
        .order("id")
        .range(from, to),
  });
}

export async function getEmployee(id: string): Promise<EmployeeRow> {
  const db = await adminDb();
  const { data, error } = await db
    .from("employees")
    .select(EMPLOYEE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  if (!data) throw new AdminError("NOT_FOUND", "Empleado no encontrado.", 404);
  return data as EmployeeRow;
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
  const db = await adminDb();
  const { data: users, error } = await db
    .from("users")
    .select("id, sede_id, full_name, id_number")
    .or(`sede_id.eq.${sedeId},sede_id.is.null`)
    .order("full_name");
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  const rows = (users ?? []) as Array<{ id: string; sede_id: string | null; full_name: string; id_number: string }>;
  const { data: roleRows, error: roleError } = await db
    .from("user_roles")
    .select("user_id, roles(code)")
    .in(
      "user_id",
      rows.map((row) => row.id),
    );
  if (roleError) throw new AdminError("INTERNAL", "Error interno.", 500);
  const byUser = new Map<string, RoleCode[]>();
  for (const row of (roleRows ?? []) as unknown as Array<{
    user_id: string;
    roles: { code: string } | Array<{ code: string }> | null;
  }>) {
    const codes = Array.isArray(row.roles)
      ? row.roles.map((item) => item.code)
      : row.roles
        ? [row.roles.code]
        : [];
    for (const code of codes) {
      if (!isRoleCode(code)) continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), code]);
    }
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
  const db = await adminDb();

  // Vínculo automático por documento (no editable): el usuario de acceso
  // es el de la sede con el mismo documento. El user_id que traiga el input se
  // ignora a propósito.
  //
  // CL-15: si NO hay coincidencia, el usuario NO se crea acá. La creación viaja
  // adentro de `upsert_employee_atomic` (054), en la MISMA sentencia que el rol
  // y el legajo: un usuario creado desde el cliente era la mitad de la ventana
  // —quedaba con login y rol, y sin legajo, cuando la escritura siguiente
  // fallaba—.
  const { data: linked, error: linkedError } = await db
    .from("users")
    .select("id")
    .eq("id_number", input.document)
    .maybeSingle();
  if (linkedError) throw new AdminError("INTERNAL", "Error interno.", 500);
  const userId = (linked as { id: string } | null)?.id ?? null;
  if (userId) {
    let takenQuery = db.from("employees").select("id").eq("user_id", userId).limit(1);
    if (input.id) takenQuery = takenQuery.neq("id", input.id);
    const { data: taken, error: takenError } = await takenQuery;
    if (takenError) throw new AdminError("INTERNAL", "Error interno.", 500);
    if (taken && taken.length > 0) {
      throw new AdminError("USER_ALREADY_LINKED", "Ese documento ya está vinculado a otro empleado.", 409);
    }
  }

  if (code !== null) {
    let conflictQuery = db
      .from("employees")
      .select("id")
      .eq("employee_code", code)
      .limit(1);
    if (input.id) conflictQuery = conflictQuery.neq("id", input.id);
    const { data: conflicts, error: conflictError } = await conflictQuery;
    if (conflictError) throw new AdminError("INTERNAL", "Error interno.", 500);
    if (conflicts && conflicts.length > 0) {
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
    const { data: creado, error: altaError } = await db.rpc("upsert_employee_atomic", {
      // El legajo NO lleva la sede: `employees.sede_id` se borra en la 077 y la
      // guarda de `upsert_employee_atomic` que exigía la clave desaparece con
      // ella. Mandarla sería mandar un dato que nadie lee.
      //
      // La cuenta de acceso SÍ la lleva: `users.sede_id` sobrevive a propósito
      // (es el anclaje de la cuenta a la instalación y el origen de
      // `session.sedeId`), así que `p_create_user.sede_id` se sigue mandando
      // abajo, y es la que ancla la fila de `users` en la instalación única.
      p_employee: columnasDelLegajo,
      p_user_id: userId,
      p_create_user: userId
        ? null
        : {
            sede_id: sedeId,
            email: input.email?.trim() ? input.email.trim() : null,
            phone: input.phone ?? null,
            id_type: "CC",
            id_number: input.document,
            password_hash: await hashPassword(input.document),
            full_name: input.full_name,
          },
      p_role_code: "empleado",
    });
    if (altaError) {
      if ((altaError as { code?: string }).code === "23505") {
        throw new AdminError(
          "EMPLOYEE_CODE_TAKEN",
          "El código de empleado ya existe.",
          409,
        );
      }
      throw new AdminError("INTERNAL", "Error interno.", 500);
    }
    if (!creado) throw new AdminError("INTERNAL", "Error interno.", 500);
    return creado as EmployeeRow;
  }

  const payload = {
    ...(input.id ? { id: input.id } : {}),
    ...columnasDelLegajo,
    user_id: userId,
  };
  const { data, error } = await db
    .from("employees")
    .upsert(payload, { onConflict: "id" })
    .select(EMPLOYEE_SELECT)
    .single();
  // 23505: carrera perdida contra el índice parcial (doble escritura
  // simultánea); se traduce al mismo error de negocio.
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe.", 409);
    }
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as EmployeeRow;
}

// -------------------------------------------------------------- services ---
export interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  duracion_min: number;
  duracion_max: number;
  is_active: boolean;
}

const SERVICE_SELECT =
  "id, name, description, price, duracion_min, duracion_max, is_active";

async function fetchServices(limit?: number): Promise<ServiceRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("services")
    .select(SERVICE_SELECT)
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as ServiceRow[];
}

/** ADM-05: crea o actualiza un servicio (upsert por id). */
export async function upsertService(raw: unknown): Promise<ServiceRow> {
  const parsed = serviceSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: ServiceInput = parsed.data;
  const db = await adminDb();
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    description: input.description ?? null,
    price: input.price,
    duracion_min: input.duracion_min,
    duracion_max: input.duracion_max,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("services")
    .upsert(payload, { onConflict: "id" })
    .select(SERVICE_SELECT)
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as ServiceRow;
}

// ----------------------------------------------------------------- taxes ---
export interface TaxConfigRow {
  id: string;
  code: string;
  name: string;
  percent: number;
  is_active: boolean;
}

const TAX_SELECT = "id, code, name, percent, is_active";

async function fetchTaxes(limit?: number): Promise<TaxConfigRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("tax_configs")
    .select(TAX_SELECT)
    .order("code")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as TaxConfigRow[];
}

/** ADM-06: crea o actualiza un impuesto de la instalación (upsert por id). */
export async function upsertTaxConfig(raw: unknown): Promise<TaxConfigRow> {
  const parsed = taxConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: TaxConfigInput = parsed.data;
  const db = await adminDb();
  const { data, error } = await db
    .from("tax_configs")
    .upsert({
      ...(input.id ? { id: input.id } : {}),
      code: input.code,
      name: input.name,
      percent: input.percent,
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
    }, { onConflict: "id" })
    .select(TAX_SELECT)
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as TaxConfigRow;
}

// ------------------------------------------------------- payment methods ---
export interface PaymentMethodRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  arqueable: boolean;
  fee_percent: number;
}

const PAYMENT_METHOD_SELECT = "id, code, name, is_active, arqueable, fee_percent";

async function fetchPaymentMethods(limit?: number): Promise<PaymentMethodRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("payment_methods")
    .select(PAYMENT_METHOD_SELECT)
    .order("code")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as PaymentMethodRow[];
}

/** ADM-07: crea o actualiza un método de pago de la instalación (upsert por id). */
export async function upsertPaymentMethod(raw: unknown): Promise<PaymentMethodRow> {
  const parsed = paymentMethodSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: PaymentMethodInput = parsed.data;
  const db = await adminDb();
  const { data, error } = await db
    .from("payment_methods")
    .upsert({
      ...(input.id ? { id: input.id } : {}),
      code: input.code,
      name: input.name,
      ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
      ...(input.arqueable !== undefined ? { arqueable: input.arqueable } : {}),
      ...(input.fee_percent !== undefined ? { fee_percent: input.fee_percent } : {}),
    }, { onConflict: "id" })
    .select(PAYMENT_METHOD_SELECT)
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as PaymentMethodRow;
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
  const db = await adminDb();
  const { data, error } = await db
    .from("user_roles")
    .select("roles(code)")
    .eq("user_id", userId);
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  const codes: RoleCode[] = [];
  for (const row of (data ?? []) as unknown as Array<{
    roles: { code: string } | Array<{ code: string }> | null;
  }>) {
    const embedded = Array.isArray(row.roles) ? row.roles : row.roles ? [row.roles] : [];
    for (const item of embedded) if (isRoleCode(item.code)) codes.push(item.code);
  }
  return codes;
}

/**
 * Traduce la excepción de `replace_user_roles` a error de negocio. La función
 * levanta `RAISE EXCEPTION` plano (SQLSTATE P0001), el mismo código que ya
 * traducen payroll, cash, billing, commissions y los topes 031/034.
 */
function roleReplacementError(error: { code?: string; message?: string }): AdminError {
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
  if (parsed.data.roles.some((rol) => !isSedeAssignableRole(rol))) {
    throw new AdminError(
      "FORBIDDEN",
      "El rol superadmin no se puede asignar ni quitar desde la aplicación.",
      403,
    );
  }
  const rolesActuales = await currentRoleCodes(parsed.data.user_id);
  if (rolesActuales.some((rol) => !isSedeAssignableRole(rol))) {
    throw new AdminError(
      "FORBIDDEN",
      "El rol superadmin no se puede asignar ni quitar desde la aplicación.",
      403,
    );
  }

  const db = await adminDb();

  const { data, error } = await db.rpc("replace_user_roles", {
    p_user_id: parsed.data.user_id,
    p_role_codes: parsed.data.roles,
  });
  if (error) throw roleReplacementError(error);

  // Post-condición: se reporta éxito sólo si la base devolvió el conjunto
  // pedido. Un arreglo vacío significa "no quedó ningún rol aplicado": eso
  // jamás es un éxito, por más que el rpc no haya dado error.
  const aplicados = (Array.isArray(data) ? data : []).filter(isSedeAssignableRole);
  const pedidos = parsed.data.roles;
  if (aplicados.length !== pedidos.length || !aplicados.every((code) => pedidos.includes(code))) {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }

  return { user_id: parsed.data.user_id, roles: aplicados };
}

// ------------------------------------------ listados con caché (catálogos) ---
//
// G5: la lista de sedes (`listSedes`, etiqueta `catalog:sedes`) se eliminó con
// sus dos acciones. Estos servicios ya no leen ni escriben la tabla `sedes`:
// esa fila la nombra la capa de plataforma, para resolver cuál es la sede de la
// instalación (la única fila activa) y configurar su fecha de nómina, y el
// módulo de nómina la lee por clave primaria (`getPayrollStartDate`,
// `payroll/service.ts`), sin pasar por ninguna lista.
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
//     devuelve `sede_id` y acota con `sede_id.eq.<sede>,sede_id.is.null`, para
//     que las cuentas todavía sin sede no queden invisibles sin rol.
//
// Todo eso se retira con el borrado FÍSICO de la columna en la migración final
// de una sola sede (M3c), no antes: hasta entonces el servicio tiene que
// escribirla donde la base la exige. Y mientras la fila exista, la fecha de
// nómina tiene dónde escribirse.
//
// Lo que queda autorizando es el ROL, no la fila: `requireSedeRole` y las guardas
// de sesión (`requireSession`, `requireAdminSession`) no se tocan. La sede de la
// sesión sigue siendo un dato real —la cuenta la tiene— y es lo que permite
// localizar la fila de la instalación (`getPayrollStartDate`); lo que ya no
// está es el alcance por sede en las lecturas del resto del negocio.

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
