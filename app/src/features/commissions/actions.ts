"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import { requireAdminSession, requireSession } from "@/src/features/admin/service";
import { requireCashWriter } from "@/src/features/cash/service";
import {
  CommissionError,
  deleteCommissionRule,
  earnedCommissionFor,
  immediatePaidTotal,
  listCommissionPayouts,
  listCommissionRules,
  payCommissionNow,
  upsertCommissionRule,
} from "./service";
import { pendingCommission } from "./schemas";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof CommissionError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Reglas de la sede (requiere sesión). */
export async function listCommissionRulesAction(input: {
  item_type?: string;
  item_id?: string;
  employee_id?: string;
  sede_id?: string;
}) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listCommissionRules(resolveSede(session.sedeId, input.sede_id), {
      item_type: input.item_type,
      item_id: input.item_id,
      employee_id: input.employee_id,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Crea o ajusta una regla (solo admin). */
export async function upsertCommissionRuleAction(input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await upsertCommissionRule(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Elimina una regla (solo admin). */
export async function deleteCommissionRuleAction(id: string) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await deleteCommissionRule(session.sedeId, id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Paga de inmediato desde la caja del turno (admin/caja). */
export async function payCommissionNowAction(input: unknown) {
  try {
    const session = await requireCashWriter(await sessionToken());
    const data = await payCommissionNow(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Comisión pendiente por (factura × empleado): ganado − pagado inmediato.
 * Solo lectura; el cálculo autoritativo vive en el servicio (no se duplica).
 * La usa el modal de pago inmediato al cobrar la factura.
 */
export async function getPendingCommissionsAction(input: {
  invoice_id: string;
  employee_ids: string[];
}) {
  try {
    const session = await requireSession(await sessionToken());
    const rows = [];
    for (const employee_id of input.employee_ids) {
      const earned = await earnedCommissionFor(session.sedeId, input.invoice_id, employee_id);
      const paid = await immediatePaidTotal(session.sedeId, input.invoice_id, employee_id);
      rows.push({
        employee_id,
        earned: earned.earned,
        paid,
        pending: pendingCommission(earned.earned, paid),
      });
    }
    return { success: true as const, data: rows };
  } catch (error) {
    return toFailure(error);
  }
}

/** Pagos inmediatos de la sede (requiere sesión). */
export async function listCommissionPayoutsAction(input: {
  employee_id?: string;
  invoice_id?: string;
  shift_id?: string;
  sede_id?: string;
}) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listCommissionPayouts(resolveSede(session.sedeId, input.sede_id), {
      employee_id: input.employee_id,
      invoice_id: input.invoice_id,
      shift_id: input.shift_id,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
