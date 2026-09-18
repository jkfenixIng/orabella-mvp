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
import { getSessionUser } from "@/src/features/auth/service";

export class AdminError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function adminDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

// ------------------------------------------------------- roles por sede ---
/**
 * TRA/NFR-02 + §10: verifica que la sesión tenga al menos uno de los roles
 * exigidos. Puro (sin red) para poder probarlo en unit tests.
 */
export function requireSedeRole(roles: RoleCode[], allowed: RoleCode[]): void {
  const permitted = allowed.some((role) => roles.includes(role));
  if (!permitted) {
    throw new AdminError("FORBIDDEN", "No tiene permiso para esta acción.", 403);
  }
}

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
 * El MVP opera una sola sede: el sede_id solicitado debe coincidir con el
 * de la sesión (si se omite, se usa el de la sesión).
 */
export function resolveSede(sessionSedeId: string, requestedSedeId?: string | null): string {
  if (!requestedSedeId || requestedSedeId === sessionSedeId) return sessionSedeId;
  throw new AdminError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
}

// ----------------------------------------------------------------- sedes ---
export interface SedeRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
}

export async function listSedes(): Promise<SedeRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("sedes")
    .select("id, name, address, phone, is_active")
    .order("name");
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
  employee_code: string | null;
  document: string;
  phone: string | null;
  position: string | null;
  pay_type: string;
  salary_fixed: number | null;
  commission_percent: number | null;
  is_active: boolean;
}

export async function listEmployees(sedeId: string): Promise<EmployeeRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("employees")
    .select(
      "id, sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent, is_active",
    )
    .eq("sede_id", sedeId)
    .order("document");
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as EmployeeRow[];
}

export async function getEmployee(id: string): Promise<EmployeeRow> {
  const db = await adminDb();
  const { data, error } = await db
    .from("employees")
    .select(
      "id, sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent, is_active",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new AdminError("INTERNAL", "Error interno.", 500);
  if (!data) throw new AdminError("NOT_FOUND", "Empleado no encontrado.", 404);
  return data as EmployeeRow;
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
    user_id: input.user_id ?? null,
    employee_code: code,
    document: input.document,
    phone: input.phone ?? null,
    position: input.position ?? null,
    pay_type: input.pay_type,
    salary_fixed: input.salary_fixed ?? null,
    commission_percent: input.commission_percent ?? null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("employees")
    .upsert(payload, { onConflict: "id" })
    .select(
      "id, sede_id, user_id, employee_code, document, phone, position, pay_type, salary_fixed, commission_percent, is_active",
    )
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

export async function listServices(sedeId: string): Promise<ServiceRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("services")
    .select(SERVICE_SELECT)
    .eq("sede_id", sedeId)
    .order("name");
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

export async function listTaxes(sedeId: string): Promise<TaxConfigRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("tax_configs")
    .select(TAX_SELECT)
    .eq("sede_id", sedeId)
    .order("code");
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
}

const PAYMENT_METHOD_SELECT = "id, sede_id, code, name, is_active";

export async function listPaymentMethods(sedeId: string): Promise<PaymentMethodRow[]> {
  const db = await adminDb();
  const { data, error } = await db
    .from("payment_methods")
    .select(PAYMENT_METHOD_SELECT)
    .eq("sede_id", sedeId)
    .order("code");
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
 * ADM-04: reemplaza los roles de un usuario (incluye doble rol, p. ej.
 * empleado + caja). Surte efecto en el siguiente refresh de sesión porque
 * getSessionUser lee user_roles en cada request.
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
