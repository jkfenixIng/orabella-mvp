"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PlatformError,
  requirePlatformAdmin,
  setPlatformPayrollStartDate,
} from "./service";

/**
 * Acciones de la SUPERFICIE de plataforma. Toda acción de este módulo es de
 * configuración del SISTEMA, así que su PRIMERA llamada es `requirePlatformAdmin`:
 * no hay lectura ni escritura de plataforma alcanzable sin el rol `superadmin`.
 *
 * Este módulo NO opera el negocio: no lee facturas, caja ni nómina. Lo que hace
 * es configurar la instalación, que es de una sola sede: la fecha de inicio de
 * la nómina. Ya NO hay lista de sedes, ni alta de sede, ni directorio de
 * usuarios de otra sede, ni roles por sede — la administración de usuarios
 * pertenece al admin de la sede (`/admin`), y el rol de plataforma nunca se
 * otorga ni se quita desde ninguna de las dos puertas.
 *
 * La LECTURA de la configuración no es una acción: la hace el componente
 * servidor de `/plataforma` con el mismo `requirePlatformAdmin`, para que el
 * valor inicial llegue por SSR y la pantalla no abra vacía.
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
 * Configura (o limpia, con `null`) la fecha de inicio de la nómina DE LA
 * INSTALACIÓN. El cuerpo NO lleva la sede: la resuelve el servicio, que es el
 * único que sabe cuál es la sede de una instalación de una sola sede.
 *
 * La guarda se re-aplica en el servicio, que es el que escribe: el servidor es
 * la autoridad, no la pantalla que abre el formulario.
 */
export async function setPlatformPayrollStartDateAction(input: unknown) {
  try {
    const actor = await requirePlatformAdmin(await sessionToken());
    return { success: true as const, data: await setPlatformPayrollStartDate(input, actor) };
  } catch (error) {
    return toFailure(error);
  }
}