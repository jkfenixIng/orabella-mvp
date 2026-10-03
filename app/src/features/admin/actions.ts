"use server";

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  getEmployee,
  listEmployees,
  listPaymentMethods,
  listSedeUsers,
  listServices,
  listTaxes,
  requireAdminSession,
  requireSession,
  setUserRoles,
  upsertEmployee,
  upsertPaymentMethod,
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
export async function listEmployeesAction() {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await listEmployees() };
  } catch (error) {
    return toFailure(error);
  }
}

/** Cuentas de la instalación con roles (selector de vínculo y pestaña Usuarios). */
export async function listSedeUsersAction() {
  try {
    const session = await requireSession(await sessionToken());
    return { success: true as const, data: await listSedeUsers(session.sedeId) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/employees (solo admin). */
export async function upsertEmployeeAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertEmployee(
      typeof input === "object" && input !== null ? input : {},
      session.sedeId,
    );
    revalidateTag("catalog:employees");
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/employees/:id (requiere sesión). */
export async function getEmployeeAction(id: string) {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await getEmployee(id) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/services (requiere sesión). */
export async function listServicesAction() {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await listServices() };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/services (solo admin). */
export async function upsertServiceAction(input: unknown) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await upsertService(typeof input === "object" && input !== null ? input : {});
    revalidateTag("catalog:services");
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/taxes (requiere sesión). */
export async function listTaxesAction() {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await listTaxes() };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/taxes (solo admin). */
export async function upsertTaxConfigAction(input: unknown) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await upsertTaxConfig(typeof input === "object" && input !== null ? input : {});
    revalidateTag("catalog:taxes");
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/payment-methods (requiere sesión). */
export async function listPaymentMethodsAction() {
  try {
    await requireSession(await sessionToken());
    return {
      success: true as const,
      data: await listPaymentMethods(),
    };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/payment-methods (solo admin). */
export async function upsertPaymentMethodAction(input: unknown) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await upsertPaymentMethod(
      typeof input === "object" && input !== null ? input : {},
    );
    revalidateTag("catalog:payment-methods");
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * G5: aquí YA NO hay ninguna acción de sedes.
 *
 * Existían dos y las dos eran agujeros: `listSedesAction` guardada solo por
 * `requireSession` (cualquier rol logueado listaba TODAS las sedes) y
 * `upsertSedeAction` guardada por `requireAdminSession` (el admin de CUALQUIER
 * sede creaba y editaba sedes, incluida la fila de la sede del sistema).
 *
 * Se eliminaron y no se re-ubicaron: ninguna tenía consumidores (ni una sola
 * referencia en la app), y conservar una segunda lectura de sedes con otro
 * contrato detrás de una caché de una hora sería peor que no tenerla.
 *
 * Y ya no hay una lectura que reubicar: la instalación es de UNA SOLA SEDE
 * (decisión del dueño, 2026-10-01), así que la capa de plataforma
 * (`src/features/platform`) configura la INSTALACIÓN —la fecha de inicio de su
 * nómina— y resuelve su sede por dato (la única fila activa de `sedes`), no
 * leyendo un catálogo para que alguien elija.
 *
 * Lo que el negocio conserva es la gestión de personas de SU sede
 * (`listSedeUsers`/`setUserRoles`, con su pestaña en `/admin`), y el rol de
 * plataforma no se otorga ni se quita desde acá.
 */

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
