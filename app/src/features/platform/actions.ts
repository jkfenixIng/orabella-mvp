"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { listPlatformSedes, PlatformError, requirePlatformAdmin } from "./service";

/**
 * Acciones de la SUPERFICIE de plataforma (G3a). Toda acción de este módulo es
 * cross-sede, así que su PRIMERA llamada es `requirePlatformAdmin`: no hay
 * lectura ni escritura de plataforma alcanzable sin el rol `superadmin`.
 *
 * Este módulo NO opera el negocio: no lee facturas, caja ni nómina de ninguna
 * sede. La única lectura de esta unidad es la lista de sedes de la instalación.
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
