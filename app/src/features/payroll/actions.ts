"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import { resolveSede } from "@/src/features/admin/service";
import {
  PayrollError,
  approveVoucher,
  calculatePayroll,
  closePayrollPeriod,
  getPeriodDetail,
  getVoucherSettings,
  listPeriods,
  listVouchers,
  openPayrollPeriod,
  payPayrollItem,
  rejectVoucher,
  requestVoucher,
  requirePayrollAdmin,
  requirePayrollPayer,
  setVoucherLimits,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof PayrollError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que POST /api/v1/payroll-periods (solo admin). */
export async function openPayrollPeriodAction(input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await openPayrollPeriod(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/payroll-periods/:id/calculate (solo admin). */
export async function calculatePayrollAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await calculatePayroll(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/payroll-items/:id/payments (admin/caja). */
export async function payPayrollItemAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollPayer(await sessionToken());
    const data = await payPayrollItem(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/payroll-periods/:id/close (solo admin). */
export async function closePayrollPeriodAction(id: string) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await closePayrollPeriod(session.sedeId, id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Periodos de la sede (requiere sesión, cualquier rol de su sede). */
export async function listPeriodsAction() {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listPeriods(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Detalle del periodo con ítems y saldos (requiere sesión, solo su sede). */
export async function getPeriodDetailAction(id: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getPeriodDetail(session.sedeId, id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Topes vigentes de la sede (requiere sesión, solo su sede). */
export async function getVoucherSettingsAction() {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getVoucherSettings(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/voucher-settings (solo admin). */
export async function setVoucherLimitsAction(input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await setVoucherLimits(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/vouchers (cualquier rol de la sede). */
export async function requestVoucherAction(input: unknown) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await requestVoucher(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Vales de la sede (requiere sesión; empleado ve los suyos vía filtro). */
export async function listVouchersAction(input: { status?: string; employee_id?: string; sede_id?: string }) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listVouchers(resolveSede(session.sedeId, input.sede_id), {
      status: input.status,
      employee_id: input.employee_id,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/vouchers/:id/approve (solo admin). */
export async function approveVoucherAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await approveVoucher(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/vouchers/:id/reject (solo admin). */
export async function rejectVoucherAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await rejectVoucher(session.sedeId, id, input);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
