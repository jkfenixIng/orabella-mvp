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
  "id, sede_id, user_id, full_name, employee_code, document, phone, position, payout_mode, email, birth_date, pay_type, salary_fixed, commission_percent, is_active";

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
  // es el de la sede con el mismo documento; sin coincidencia se crea
  // automáticamente (nunca se pide creación manual).
  // El user_id que traiga el input se ignora a propósito.
  const { data: linked, error: linkedError } = await db
    .from("users")
    .select("id")
    .eq("sede_id", input.sede_id)
    .eq("id_number", input.document)
    .maybeSingle();
  if (linkedError) throw new AdminError("INTERNAL", "Error interno.", 500);
  let userId = (linked as { id: string } | null)?.id ?? null;
  if (!userId && !input.id) {
    const { data: createdUser, error: createError } = await db
      .from("users")
      .insert({
        sede_id: input.sede_id,
        email: input.email?.trim() ? input.email.trim() : null,
        phone: input.phone ?? null,
        id_type: "CC",
        id_number: input.document,
        password_hash: await hashPassword(input.document),
        full_name: input.full_name,
        must_change_password: true,
      })
      .select("id")
      .single();
    if (createError || !createdUser) throw new AdminError("INTERNAL", "Error interno.", 500);
    userId = (createdUser as { id: string }).id;
  }
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

  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    user_id: userId,
    full_name: input.full_name,
    employee_code: code,
    document: input.document,
    phone: input.phone ?? null,
    position: input.position ?? null,
    ...(input.payout_mode !== undefined ? { payout_mode: input.payout_mode } : {}),
    email: input.email?.trim() ? input.email.trim() : null,
    birth_date: input.birth_date?.trim() ? input.birth_date : null,
    pay_type: input.pay_type,
    salary_fixed: input.salary_fixed ?? null,
    commission_percent: input.commission_percent ?? null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
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
  // Red de seguridad (solo al crear): si el usuario vinculado quedó sin
  // roles, se le asigna empleado para que nadie quede sin acceso por olvido.
  if (!input.id && userId) {
    const { data: existingRoles } = await db
      .from("user_roles")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    if (!existingRoles || existingRoles.length === 0) {
      const { data: empRole } = await db.from("roles").select("id").eq("code", "empleado").maybeSingle();
      if (empRole) {
        const { error: roleError } = await db
          .from("user_roles")
          .insert({ user_id: userId, role_id: (empRole as { id: string }).id });
        if (roleError) console.error("[admin] no se pudo asignar rol empleado:", roleError.message);
      }
    }
  }
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
}

const PAYMENT_METHOD_SELECT = "id, sede_id, code, name, is_active, arqueable";

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
 * ADM-04: reemplaza el rol de un usuario (uno solo). Surte efecto en el
 * siguiente refresh de sesión porque getSessionUser lee user_roles en
 * cada request.
 */
export async function setUserRoles(raw: unknown): Promise<{ user_id: string; roles: RoleCode[] }> {
  const parsed = setUserRolesSchema.safeParse(raw);
  if (!parsed.success) throw new AdminError("VALIDATION", validationMessage(parsed.error), 400);
  const db = await adminDb();

  const { data: roleRows, error: roleError } = await db
    .from("roles")
    .select("id, code")
    .in("code", parsed.data.roles);
  if (roleError) throw new AdminError("INTERNAL", "Error interno.", 500);
  const found = ((roleRows ?? []) as Array<{ id: string; code: string }>);
  if (found.length !== parsed.data.roles.length) {
    throw new AdminError("VALIDATION", "Rol desconocido.", 400);
  }

  const { error: deleteError } = await db
    .from("user_roles")
    .delete()
    .eq("user_id", parsed.data.user_id);
  if (deleteError) throw new AdminError("INTERNAL", "Error interno.", 500);

  const { error: insertError } = await db
    .from("user_roles")
    .insert(found.map((role) => ({ user_id: parsed.data.user_id, role_id: role.id })));
  if (insertError) throw new AdminError("INTERNAL", "Error interno.", 500);

  return { user_id: parsed.data.user_id, roles: parsed.data.roles };
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
