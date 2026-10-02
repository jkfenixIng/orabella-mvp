"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  createPlatformSede,
  listPlatformSedeUsers,
  listPlatformSedes,
  PlatformError,
  requirePlatformAdmin,
  setPlatformPayrollStartDate,
  setPlatformSedeUserRoles,
} from "./service";

/**
 * Acciones de la SUPERFICIE de plataforma (G3a/G3b/G5). Toda acción de este
 * módulo es cross-sede, así que su PRIMERA llamada es `requirePlatformAdmin`: no
 * hay lectura ni escritura de plataforma alcanzable sin el rol `superadmin`.
 *
 * Este módulo NO opera el negocio: no lee facturas, caja ni nómina de ninguna
 * sede. Lo que hace es administrar la instalación: la lista de sedes, su ALTA y
 * quién administra cada una, y la fecha de inicio de la nómina de la sede
 * elegida.
 */

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof PlatformError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/**
 * Lista TODAS las sedes de la instalación (solo plataforma). Devuelve el mismo
 * contrato que la lectura del servicio: incluye la sede del sistema marcada con
 * `is_platform`, para que la pantalla no la presente como una sede del negocio.
 */
export async function listPlatformSedesAction() {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await listPlatformSedes(actor) };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * G3b: configura (o limpia, con `null`) la fecha de inicio de la nómina de la
 * sede ELEGIDA. La guarda se re-aplica en el servicio, que es el que escribe: el
 * servidor es la autoridad, no la pantalla que abre el formulario.
 */
export async function setPlatformPayrollStartDateAction(input: unknown) {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await setPlatformPayrollStartDate(input, actor) };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * G5: CREA una sede de la instalación. El cuerpo no admite `id`: desde la
 * plataforma una sede se crea, no se edita, y el servicio lo aplica descartando
 * ese campo.
 */
export async function createPlatformSedeAction(input: unknown) {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await createPlatformSede(input, actor) };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * G5: los usuarios de la sede ELEGIDA con sus roles, para decidir quién la
 * administra. La sede llega elegida en el cuerpo (es una lectura cross-sede) y
 * la guarda se re-aplica en el servicio, que es el que lee.
 */
export async function listPlatformSedeUsersAction(input: unknown) {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await listPlatformSedeUsers(input, actor) };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * G5: reemplaza el rol de un usuario de la sede ELEGIDA. El conjunto asignable
 * es el de la administración de una sede: el rol de plataforma no se otorga ni
 * se quita desde acá, y la base aplica el reemplazo en una sola sentencia.
 */
export async function setPlatformSedeUserRolesAction(input: unknown) {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await setPlatformSedeUserRoles(input, actor) };
  } catch (error) {
    return toFailure(error);
  }
}
