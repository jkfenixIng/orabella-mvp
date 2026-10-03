"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireAdminSession } from "@/src/features/admin/service";
import {
  AlertError,
  countUnreadAlerts,
  listAlerts,
  markAlertRead,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof AlertError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que GET /api/v1/alerts (solo admin). */
export async function getAlertsAction(input: { unreadOnly?: boolean; page?: number; module?: "caja" | "acceso"; from?: string; to?: string }) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await listAlerts({
      unreadOnly: input.unreadOnly,
      page: input.page,
      module: input.module,
      from: input.from || undefined,
      to: input.to || undefined,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Sin leer de la bandeja (insignia del menú, solo admin). */
export async function countUnreadAlertsAction() {
  try {
    await requireAdminSession(await sessionToken());
    const data = await countUnreadAlerts();
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Revisa una alerta con justificación (solo admin). */
export async function markAlertReadAction(id: string, note: string) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await markAlertRead(id, { note }, { userId: session.userId });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
