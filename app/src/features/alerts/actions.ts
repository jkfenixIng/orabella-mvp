"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
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
export async function getAlertsAction(input: { unreadOnly?: boolean; page?: number; module?: "caja" | "acceso"; sede_id?: string }) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await listAlerts(resolveSede(session.sedeId, input.sede_id), {
      unreadOnly: input.unreadOnly,
      page: input.page,
      module: input.module,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Sin leer de la sede (insignia del menú, solo admin). */
export async function countUnreadAlertsAction() {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await countUnreadAlerts(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Revisa una alerta con justificación (solo admin, acotado a su sede). */
export async function markAlertReadAction(id: string, note: string) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await markAlertRead(session.sedeId, id, { note }, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
