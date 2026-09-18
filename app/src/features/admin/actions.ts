"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  getEmployee,
  listEmployees,
  listPaymentMethods,
  listSedes,
  listServices,
  listTaxes,
  requireAdminSession,
  requireSession,
  resolveSede,
  setUserRoles,
  upsertEmployee,
  upsertPaymentMethod,
  upsertSede,
  upsertService,
  upsertTaxConfig,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof AdminError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que GET /api/v1/employees (requiere sesión). */
export async function listEmployeesAction(sedeId?: string) {
  try {
    const session = await requireSession(await sessionToken());
    return { success: true as const, data: await listEmployees(resolveSede(session.sedeId, sedeId)) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/employees (solo admin). */
export async function upsertEmployeeAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertEmployee({
      ...(typeof input === "object" && input !== null ? input : {}),
      sede_id: resolveSede(
        session.sedeId,
        (input as { sede_id?: string }).sede_id,
      ),
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/employees/:id (requiere sesión). */
export async function getEmployeeAction(id: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getEmployee(id);
    resolveSede(session.sedeId, data.sede_id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/services (requiere sesión). */
export async function listServicesAction(sedeId?: string) {
  try {
    const session = await requireSession(await sessionToken());
    return { success: true as const, data: await listServices(resolveSede(session.sedeId, sedeId)) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/services (solo admin). */
export async function upsertServiceAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertService({
      ...(typeof input === "object" && input !== null ? input : {}),
      sede_id: resolveSede(session.sedeId, (input as { sede_id?: string }).sede_id),
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/taxes (requiere sesión). */
export async function listTaxesAction(sedeId?: string) {
  try {
    const session = await requireSession(await sessionToken());
    return { success: true as const, data: await listTaxes(resolveSede(session.sedeId, sedeId)) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/taxes (solo admin). */
export async function upsertTaxConfigAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertTaxConfig({
      ...(typeof input === "object" && input !== null ? input : {}),
      sede_id: resolveSede(session.sedeId, (input as { sede_id?: string }).sede_id),
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/payment-methods (requiere sesión). */
export async function listPaymentMethodsAction(sedeId?: string) {
  try {
    const session = await requireSession(await sessionToken());
    return {
      success: true as const,
      data: await listPaymentMethods(resolveSede(session.sedeId, sedeId)),
    };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/payment-methods (solo admin). */
export async function upsertPaymentMethodAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertPaymentMethod({
      ...(typeof input === "object" && input !== null ? input : {}),
      sede_id: resolveSede(session.sedeId, (input as { sede_id?: string }).sede_id),
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Sedes para el selector del admin (requiere sesión). */
export async function listSedesAction() {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await listSedes() };
  } catch (error) {
    return toFailure(error);
  }
}

/** ADM-01: crear/actualizar sede (solo admin). */
export async function upsertSedeAction(input: unknown) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await upsertSede(input);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** ADM-04: asignar roles a un usuario (solo admin). */
export async function setUserRolesAction(input: unknown) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await setUserRoles(input);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
