import {
  employeeSchema,
  normalizeEmployeeCode,
  paymentMethodSchema,
  sedeSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
  type EmployeeInput,
  type PaymentMethodInput,
  type SedeInput,
  type ServiceInput,
  type TaxConfigInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
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
  resolveSede,
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
 * El MVP opera una sola sede (`resolveSede` en `@/src/shared/lib/sede.ts`,
 * re-exportado arriba).
 */

// ----------------------------------------------------------------- sedes ---
export interface SedeRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
}

async function fetchSedes(limit?: number): Promise<SedeRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("sedes")
    .select("id, name, address, phone, is_active")
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as SedeRow[];
}

/** ADM-01: crea o actualiza una sede (upsert por id). */
export async function upsertSede(raw: unknown): Promise<SedeRow> {
  const parsed = sedeSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: SedeInput = parsed.data;
  const db = await adminDb();
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    address: input.address ?? null,
    phone: input.phone ?? null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("sedes")
    .upsert(payload, { onConflict: "id" })
    .select("id, name, address, phone, is_active")
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as SedeRow;
}

// ------------------------------------------------------------- employees ---
export interface EmployeeRow {
  id: string;
  sede_id: string;
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
  sede_id: string | null;
  full_name: string;
  id_number: string;
  roles: RoleCode[];
}

const EMPLOYEE_SELECT =
  "id, sede_id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, pay_frequency, salary_fixed, commission_percent, is_active";

async function fetchEmployees(sedeId: string, limit?: number): Promise<EmployeeRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("employees")
    .select(EMPLOYEE_SELECT)
    .eq("sede_id", sedeId)
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
 * alineación con `listEmployees(sedeId, 500)` y `clampLimit` recortaba a 500, así
 * que el empleado 501 de una sede no quedaba mal pagado —quedaba AUSENTE de la
 * nómina, sin un solo error—. El conjunto acá SÍ está acotado por la sede, así
 * que lo correcto es leerlo entero por páginas, con `order()` determinista.
 *
 * Sin caché a propósito: una sede cuya última alta es de hace un minuto tiene que
 * entrar en la nómina de hoy, y una planta cacheada es una planta incompleta (ese
 * es exactamente el defecto que esto cierra). El fallo de la lectura se PROPAGA
 * (`PagedReadError`): el llamador de plata lo convierte en un error de negocio a
 * la vista, nunca en "leí lo que alcancé".
 */
export async function listAllEmployees(sedeId: string): Promise<EmployeeRow[]> {
  const db = await adminDb();
  return readAllPaged<EmployeeRow>({
    table: "employees",
    fetchPage: (from, to) =>
      db
        .from("employees")
        .select(EMPLOYEE_SELECT)
        .eq("sede_id", sedeId)
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

/** Usuarios de la sede con sus roles (selector de vínculo + pestaña Roles).
 * Incluye sin sede para que ninguno quede invisible sin rol. */
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
      if (code !== "admin" && code !== "empleado" && code !== "caja") continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), code]);
    }
  }
  return rows.map((row) => ({ ...row, roles: byUser.get(row.id) ?? [] }));
}

/**
 * ADM-02/ADM-03/ADM-08: crea o actualiza un empleado. Valida la unicidad
 * parcial de employee_code a nivel app (además del índice
 * uq_employees_sede_code) para devolver un error de negocio claro.
 */
export async function upsertEmployee(raw: unknown): Promise<EmployeeRow> {
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
    .eq("sede_id", input.sede_id)
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
      .eq("sede_id", input.sede_id)
      .eq("employee_code", code)
      .limit(1);
    if (input.id) conflictQuery = conflictQuery.neq("id", input.id);
    const { data: conflicts, error: conflictError } = await conflictQuery;
    if (conflictError) throw new AdminError("INTERNAL", "Error interno.", 500);
    if (conflicts && conflicts.length > 0) {
      throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe en esta sede.", 409);
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
  const camposDelEmpleado = {
    sede_id: input.sede_id,
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
      p_employee: camposDelEmpleado,
      p_user_id: userId,
      p_create_user: userId
        ? null
        : {
            sede_id: input.sede_id,
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
          "El código de empleado ya existe en esta sede.",
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
    ...camposDelEmpleado,
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
      throw new AdminError("EMPLOYEE_CODE_TAKEN", "El código de empleado ya existe en esta sede.", 409);
    }
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as EmployeeRow;
}

// -------------------------------------------------------------- services ---
export interface ServiceRow {
  id: string;
  sede_id: string;
  name: string;
  description: string | null;
  price: number;
  duracion_min: number;
  duracion_max: number;
  is_active: boolean;
}

const SERVICE_SELECT =
  "id, sede_id, name, description, price, duracion_min, duracion_max, is_active";

async function fetchServices(sedeId: string, limit?: number): Promise<ServiceRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("services")
    .select(SERVICE_SELECT)
    .eq("sede_id", sedeId)
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
    sede_id: input.sede_id,
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
  sede_id: string;
  code: string;
  name: string;
  percent: number;
  is_active: boolean;
}

const TAX_SELECT = "id, sede_id, code, name, percent, is_active";

async function fetchTaxes(sedeId: string, limit?: number): Promise<TaxConfigRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("tax_configs")
    .select(TAX_SELECT)
    .eq("sede_id", sedeId)
    .order("code")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as TaxConfigRow[];
}

/** ADM-06: crea o actualiza un impuesto por sede (upsert por id). */
export async function upsertTaxConfig(raw: unknown): Promise<TaxConfigRow> {
  const parsed = taxConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: TaxConfigInput = parsed.data;
  const db = await adminDb();
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    code: input.code,
    name: input.name,
    percent: input.percent,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("tax_configs")
    .upsert(payload, { onConflict: "id" })
    .select(TAX_SELECT)
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as TaxConfigRow;
}

// ------------------------------------------------------- payment methods ---
export interface PaymentMethodRow {
  id: string;
  sede_id: string;
  code: string;
  name: string;
  is_active: boolean;
  arqueable: boolean;
  fee_percent: number;
}

const PAYMENT_METHOD_SELECT = "id, sede_id, code, name, is_active, arqueable, fee_percent";

async function fetchPaymentMethods(sedeId: string, limit?: number): Promise<PaymentMethodRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("payment_methods")
    .select(PAYMENT_METHOD_SELECT)
    .eq("sede_id", sedeId)
    .order("code")
    .limit(clampLimit(limit));
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as PaymentMethodRow[];
}

/** ADM-07: crea o actualiza un método de pago por sede (upsert por id). */
export async function upsertPaymentMethod(raw: unknown): Promise<PaymentMethodRow> {
  const parsed = paymentMethodSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const input: PaymentMethodInput = parsed.data;
  const db = await adminDb();
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    code: input.code,
    name: input.name,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
    ...(input.arqueable !== undefined ? { arqueable: input.arqueable } : {}),
    ...(input.fee_percent !== undefined ? { fee_percent: input.fee_percent } : {}),
  };
  const { data, error } = await db
    .from("payment_methods")
    .upsert(payload, { onConflict: "id" })
    .select(PAYMENT_METHOD_SELECT)
    .single();
  if (error || !data) throw new AdminError("INTERNAL", "Error interno.", 500);
  return data as PaymentMethodRow;
}

// ------------------------------------------------------------------ roles ---
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
  const db = await adminDb();

  const { data, error } = await db.rpc("replace_user_roles", {
    p_user_id: parsed.data.user_id,
    p_role_codes: parsed.data.roles,
  });
  if (error) throw roleReplacementError(error);

  // Post-condición: se reporta éxito sólo si la base devolvió el conjunto
  // pedido. Un arreglo vacío significa "no quedó ningún rol aplicado": eso
  // jamás es un éxito, por más que el rpc no haya dado error.
  const aplicados = (Array.isArray(data) ? data : []).filter(
    (code): code is RoleCode => code === "admin" || code === "empleado" || code === "caja",
  );
  const pedidos = parsed.data.roles;
  if (aplicados.length !== pedidos.length || !aplicados.every((code) => pedidos.includes(code))) {
    throw new AdminError("INTERNAL", "Error interno.", 500);
  }

  return { user_id: parsed.data.user_id, roles: aplicados };
}

// ------------------------------------------ listados con caché (catálogos) ---

export const listSedes = unstable_cache(fetchSedes, ["catalog:sedes"], {
  tags: ["catalog:sedes"],
  revalidate: CATALOG_TTL_SECONDS,
});

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
