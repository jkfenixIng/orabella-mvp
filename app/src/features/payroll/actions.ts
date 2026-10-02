"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import { listAllEmployees } from "@/src/features/admin/service";
import { resolveSede } from "@/src/shared/lib/sede";
import { PagedReadError } from "@/src/shared/lib/paged";
import {
  PayrollError,
  approveVoucher,
  calculatePayroll,
  closePayrollPeriod,
  correctPayrollPeriod,
  deletePayrollPeriod,
  getPayrollPeriodCorrection,
  getPayrollSettlementSources,
  getPayrollStartDate,
  getPeriodDetail,
  getVoucherSettings,
  listPayrollExtras,
  listPayrollMonthRows,
  listPeriods,
  listVouchers,
  payPayrollExtra,
  openPayrollPeriod,
  payPayrollItem,
  rejectVoucher,
  requestVoucher,
  requirePayrollAdmin,
  requirePayrollPayer,
  requirePayrollViewer,
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
  // U8: la planta se lee de forma exhaustiva (`listAllEmployees`). Una lectura
  // que no se completó nunca puede convertirse en "no encontré al empleado":
  // se reporta con el código accionable en vez de degradar a INTERNAL.
  if (error instanceof PagedReadError) {
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

/**
 * Misma lógica que POST /api/v1/payroll-items/:id/payments (solo admin).
 *
 * Pagar un ítem es parte de liquidar la nómina: era la superficie por la que la
 * caja entraba al módulo (requirePayrollPayer). Esa guarda quedó para los vales.
 *
 * CL-2: el cuerpo debe traer `idempotency_key` (uuid que la pantalla acuña al
 * empezar el intento y reutiliza en sus reintentos). Sin marca el servicio
 * rechaza con VALIDATION: un envío sin marca no se puede reconocer como
 * repetición, así que aceptarlo reabriría el defecto (pagar dos veces). Con la
 * marca repetida el servicio devuelve el pago ya registrado, no otro.
 */
export async function payPayrollItemAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await payPayrollItem(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * PA-2a: registra un pago de nómina individual por caso extraordinario
 * (despido, renuncia, emergencia) con motivo y tipo. Solo admin: es nómina.
 */
export async function payPayrollExtraAction(input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await payPayrollExtra(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * PA-2a: pagos extraordinarios de la sede (el registro visible del módulo).
 * Solo admin: es nómina, y el módulo no es de caja.
 */
export async function listPayrollExtrasAction() {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await listPayrollExtras(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * PA3 (consulta puntual): los pagos de UN mes de UN empleado. Es la misma
 * lectura del panorama acotada a la consulta que el admin hace en la pantalla:
 * el mes de toda la planta ya no viaja al abrir, viaja cuando se pide.
 */
export async function listPayrollMonthRowsAction(input: { month: string; employeeId: string }) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await listPayrollMonthRows({
      sedeId: session.sedeId,
      month: input.month,
      employeeId: input.employeeId,
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

/** Misma lógica que DELETE /api/v1/payroll-periods/:id (solo admin). */
export async function deletePayrollPeriodAction(id: string) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await deletePayrollPeriod(session.sedeId, id, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * PA-2b: corrige un período CERRADO sin reabrirlo ni pisarlo: recalcula con las
 * reglas vigentes y guarda las dos versiones con el motivo. NO mueve plata.
 * Solo admin: es nómina, y el módulo de nómina no es de caja.
 */
export async function correctPayrollPeriodAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await correctPayrollPeriod(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * PA-2b: la corrección de un período (si existe), con las dos versiones ya
 * comparadas. Solo admin: muestra la nómina completa de la sede.
 */
export async function getPayrollPeriodCorrectionAction(id: string) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await getPayrollPeriodCorrection(session.sedeId, id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Periodos de la sede (admin y el empleado que mira SU recibo).
 *
 * El empleado necesita los periodos para llegar a su propio detalle; la caja no
 * entra al módulo de nómina.
 */
export async function listPeriodsAction() {
  try {
    const session = await requirePayrollViewer(await sessionToken());
    const data = await listPeriods(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Detalle del periodo con ítems y saldos (admin ven todo; empleado solo sus
 * ítems; la caja no entra al módulo).
 */
export async function getPeriodDetailAction(id: string) {
  try {
    const session = await requirePayrollViewer(await sessionToken());
    const data = await getPeriodDetail(session.sedeId, id);
    // Solo el admin ve la nómina completa; el empleado ve la suya. La caja no
    // llega hasta acá (requirePayrollViewer la rechaza antes).
    const isManager = (session.roles ?? []).includes("admin");
    if (isManager) return { success: true as const, data };
    // U8: ubicar al empleado logueado es encontrar UNO, no armar el listado de
    // navegación. `listEmployees` corta en 50 (`clampLimit`), así que en una sede
    // con más de 50 empleados quien estaba después del 50 recibía
    // `ownId = "sin-acceso"` y veía su propio detalle vacío. `listAllEmployees`
    // lee la planta COMPLETA, con orden determinista, y propaga el fallo de la
    // lectura en vez de recortar en silencio.
    const mine = (await listAllEmployees(session.sedeId)).find((row) => row.user_id === session.userId);
    const ownId = mine?.id ?? "sin-acceso";
    return { success: true as const, data: { ...data, items: data.items.filter((item) => item.employee_id === ownId) } };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * F6: las facturas, el ajuste del mixto y los vales de la liquidación de UN
 * empleado de UN período, para el modal "Ver facturas y vales".
 *
 * Mismo alcance por fila que `getPeriodDetailAction`: el admin ve al empleado
 * que pida; el empleado logueado solo puede abrir SU liquidación, así que su
 * `employeeId` se reemplaza por el suyo (no se le devuelve la de otro). La caja
 * no entra al módulo (`requirePayrollViewer`). Una lectura incompleta no se
 * degrada a vacío: sale con el código accionable de `toFailure`.
 */
export async function getPayrollSettlementSourcesAction(periodId: string, employeeId: string) {
  try {
    const session = await requirePayrollViewer(await sessionToken());
    const isManager = (session.roles ?? []).includes("admin");
    let targetEmployeeId = employeeId;
    if (!isManager) {
      // Mismo motivo que en el detalle del período: la planta COMPLETA (no el
      // listado recortado a 50) para ubicar al empleado logueado.
      const mine = (await listAllEmployees(session.sedeId)).find((row) => row.user_id === session.userId);
      targetEmployeeId = mine?.id ?? "sin-acceso";
    }
    const data = await getPayrollSettlementSources(session.sedeId, periodId, targetEmployeeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * F10/G3b: la fecha desde la que la nómina OPERA en la sede (la fecha de inicio
 * de la implementación). Nada anterior a esa fecha existe para el sistema.
 *
 * La LECTURA sigue en nómina porque el aviso de ciclos pendientes y el diálogo
 * de apertura la necesitan; la ESCRITURA se movió a la plataforma (G3b): el
 * admin de la sede ya no puede cambiarla.
 */
export async function getPayrollStartDateAction() {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await getPayrollStartDate(session.sedeId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Topes vigentes de la sede: lectura del flujo de VALES (no de nómina), así que
 * mantiene la guarda que tenía: cualquier rol autenticado de su sede. La caja
 * los necesita para saber si el vale entra en rango.
 */
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

/** Misma lógica que POST /api/v1/vouchers (admin/caja; el servicio exige turno abierto). */
export async function requestVoucherAction(input: unknown) {
  try {
    const session = await requirePayrollPayer(await sessionToken());
    const data = await requestVoucher(input, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Vales de la sede (admin/caja ven todo; empleado solo los suyos; máx. 50 por defecto). */
export async function listVouchersAction(input: {
  status?: string;
  employee_id?: string;
  request_date?: string;
  date_from?: string;
  date_to?: string;
  sede_id?: string;
  limit?: number;
}) {
  try {
    const session = await requireSession(await sessionToken());
    const sedeId = resolveSede(session.sedeId, input.sede_id);
    const isManager = session.roles.includes("admin") || session.roles.includes("caja");
    let employeeId = input.employee_id;
    if (!isManager) {
      // U8: mismo motivo que en el detalle del período: la planta completa, no
      // el listado recortado a 50, para que quien está después del 50 no vea su
      // pantalla de vales vacía.
      const mine = (await listAllEmployees(sedeId)).find((row) => row.user_id === session.userId);
      employeeId = mine?.id ?? "sin-acceso";
    }
    const data = await listVouchers(sedeId, {
      status: input.status,
      employee_id: employeeId,
      request_date: input.request_date,
      date_from: input.date_from,
      date_to: input.date_to,
      limit: input.limit,
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

/** Misma lógica que POST /api/v1/vouchers/:id/reject (solo admin, motivo + auditoría). */
export async function rejectVoucherAction(id: string, input: unknown) {
  try {
    const session = await requirePayrollAdmin(await sessionToken());
    const data = await rejectVoucher(session.sedeId, id, input, { userId: session.userId });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
