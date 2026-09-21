"use server";

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireSession, requireAdminSession } from "@/src/features/admin/service";
import { accumulateDayTotals } from "./schemas";
import {
  CashError,
  closeShift,
  deleteDenomination,
  getDayView,
  getHistory,
  getOpenShift,
  listDenominations,
  listRegisters,
  openShift,
  registerPayment,
  requireCashWriter,
  updateClosedShift,
  updateRegisterBase,
  upsertDenomination,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof CashError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que POST /api/v1/cash-shifts/open (solo admin/caja). */
export async function openShiftAction(input: unknown) {
  try {
    const session = await requireCashWriter(await sessionToken());
    const data = await openShift(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/cash/payments (solo admin/caja). */
export async function registerPaymentAction(input: unknown) {
  try {
    const session = await requireCashWriter(await sessionToken());
    const data = await registerPayment(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/cash-shifts/:id/close (solo admin/caja). */
export async function closeShiftAction(id: string, input: unknown) {
  try {
    const session = await requireCashWriter(await sessionToken());
    const data = await closeShift(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Turno abierto de la sede (requiere sesión, cualquier rol de su sede). */
export async function getOpenShiftAction() {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getOpenShift(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/cash/day (admin ve todo; caja solo sus turnos). */
export async function getDayViewAction(input: { fecha: string; sede_id?: string }) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getDayView(resolveSede(session.sedeId, input.sede_id), {
      fecha: input.fecha,
    });
    if (session.roles.includes("admin")) return { success: true as const, data };
    const shifts = data.shifts.filter((view) => view.shift.opened_by === session.userId);
    return {
      success: true as const,
      data: {
        ...data,
        shifts,
        totals: accumulateDayTotals(
          shifts.map((view) => ({
            expectedCash: view.efectivo,
            countedCash: view.shift.counted_cash,
            baseLeft: view.shift.base_left,
            cashWithdrawn: view.shift.cash_withdrawn,
            baseDifference: view.shift.base_difference,
            ventas: view.ventas,
          })),
        ),
      },
    };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/cash/history (solo admin). */
export async function getHistoryAction(input: { desde: string; hasta: string; sede_id?: string }) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await getHistory(resolveSede(session.sedeId, input.sede_id), {
      desde: input.desde,
      hasta: input.hasta,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Cajas de la sede (requiere sesión, cualquier rol de su sede). */
export async function listRegistersAction() {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listRegisters(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Base configurada de la caja (solo admin, queda auditado). */
export async function updateRegisterBaseAction(registerId: string, input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const base = (input as { base_configurada?: unknown }).base_configurada;
    const data = await updateRegisterBase(session.sedeId, registerId, Number(base), {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Edición de turno cerrado (solo admin, queda auditado). */
export async function updateClosedShiftAction(id: string, input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await updateClosedShift(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Denominaciones activas de la sede (requiere sesión). */
export async function listDenominationsAction() {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listDenominations(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Crear/ajustar denominación (solo admin). */
export async function upsertDenominationAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertDenomination(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    revalidateTag("catalog:denominations");
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Eliminar denominación (solo admin). */
export async function deleteDenominationAction(id: string) {
  try {
    const session = await requireAdminSession(await sessionToken());
    await deleteDenomination(session.sedeId, id);
    revalidateTag("catalog:denominations");
    return { success: true as const };
  } catch (error) {
    return toFailure(error);
  }
}
