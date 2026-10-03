"use server";

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession, requireAdminSession } from "@/src/features/admin/service";
import { accumulateDayTotals } from "./schemas";
import {
  CashError,
  closeShift,
  deleteDenomination,
  getDayView,
  getHistory,
  getOpenShiftWithOpener,
  listDenominations,
  listRegisters,
  openShift,
  recountClosedShift,
  registerPayment,
  requireCashWriter,
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
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Misma lógica que POST /api/v1/cash/payments (solo admin/caja).
 *
 * CL-3: el mismo contrato de la ruta —un cobro con `invoice_id` exige
 * `idempotency_key` (uuid del intento) o se rechaza con VALIDATION 400—. Hoy
 * ninguna pantalla llama a esta action (el formulario de cobro no existe en
 * `/cash`), así que el llamador real de la puerta es la ruta REST.
 */
export async function registerPaymentAction(input: unknown) {
  try {
    const session = await requireCashWriter(await sessionToken());
    const data = await registerPayment(input, {
      userId: session.userId,
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
    const data = await closeShift(id, input, {
      userId: session.userId,
      roles: session.roles,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Turno abierto de la sede (requiere sesión, cualquier rol de su sede). */
export async function getOpenShiftAction() {
  try {
    await requireSession(await sessionToken());
    const data = await getOpenShiftWithOpener();
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/cash/day (admin ve todo; caja solo sus turnos). */
export async function getDayViewAction(input: { fecha: string }) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getDayView({ fecha: input.fecha });
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
            countedCash: view.vigente.counted_cash,
            baseLeft: view.vigente.base_left,
            cashWithdrawn: view.vigente.cash_withdrawn,
            baseDifference: view.vigente.base_difference,
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
export async function getHistoryAction(input: { desde: string; hasta: string; page?: number }) {
  try {
    await requireAdminSession(await sessionToken());
    const data = await getHistory({
      desde: input.desde,
      hasta: input.hasta,
      page: input.page,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Cajas (requiere sesión). */
export async function listRegistersAction() {
  try {
    await requireSession(await sessionToken());
    const data = await listRegisters();
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
    const data = await updateRegisterBase(registerId, Number(base), {
      userId: session.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * U3: reconteo de un cierre (solo admin, queda auditado). El cierre firmado
 * es inmutable: la corrección exige un conteo completo nuevo más un motivo, y
 * conserva las dos versiones en `cash_shift_recounts`.
 */
export async function recountClosedShiftAction(id: string, input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await recountClosedShift(id, input, {
      userId: session.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Denominaciones activas (requiere sesión). */
export async function listDenominationsAction() {
  try {
    await requireSession(await sessionToken());
    const data = await listDenominations();
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
    await requireAdminSession(await sessionToken());
    await deleteDenomination(id);
    revalidateTag("catalog:denominations");
    return { success: true as const };
  } catch (error) {
    return toFailure(error);
  }
}
