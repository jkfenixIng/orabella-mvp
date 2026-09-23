"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import { requireAdminSession, requireSession } from "@/src/features/admin/service";
import {
  BillingError,
  annulInvoice,
  countInvoices,
  createInvoice,
  editEmittedInvoiceItems,
  editInvoiceItems,
  getInvoiceDetail,
  listInvoices,
  requireBillingWriter,
  splitPayment,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof BillingError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que GET /api/v1/invoices (requiere sesión, solo su sede; empleado ve solo las propias). */
export async function listInvoicesAction(filters: {
  sede_id?: string;
  status?: string;
  from?: string;
  to?: string;
  user_id?: string;
  consecutive_number?: number;
  closed_by?: string;
  employee_id?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  try {
    const session = await requireSession(await sessionToken());
    const sedeId = resolveSede(session.sedeId, filters.sede_id);
    const isManager = session.roles.includes("admin") || session.roles.includes("caja");
    // Empleado: solo las propias (filtro forzado para que el total cuadre).
    const effectiveUserId = isManager ? filters.user_id : session.userId;
    const where = {
      status: filters.status || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      user_id: effectiveUserId,
      consecutive_number: filters.consecutive_number,
      closed_by: filters.closed_by || undefined,
      employee_id: isManager ? filters.employee_id || undefined : undefined,
    };
    const [rows, total] = await Promise.all([
      listInvoices(sedeId, { ...where, page: filters.page, pageSize: filters.pageSize }),
      countInvoices(sedeId, where),
    ]);
    return { success: true as const, data: { rows, total } };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/invoices/:id (caja no ve detalle de cerradas; empleado solo las propias). */
export async function getInvoiceAction(id: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getInvoiceDetail(session.sedeId, id);
    const isManager = session.roles.includes("admin") || session.roles.includes("caja");
    if (!isManager && data.invoice.user_id !== session.userId) {
      throw new BillingError("FORBIDDEN", "Sin acceso a esta factura.", 403);
    }
    if (session.roles.includes("caja") && !session.roles.includes("admin") && data.invoice.status !== "Emitida") {
      throw new BillingError("FORBIDDEN", "Factura cerrada: solo lectura del listado.", 403);
    }
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/invoices (solo admin/caja). */
export async function createInvoiceAction(input: unknown) {
  try {
    const session = await requireBillingWriter(await sessionToken());
    const data = await createInvoice(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Edición admin de factura con motivo (solo admin; el servicio refuerza). */
export async function editInvoiceAction(id: string, input: unknown) {
  try {
    const session = await requireAdminSession(await sessionToken());
    const data = await editInvoiceItems(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Edición LIBRE de factura EMITIDA (cajera del turno sin motivo, total se recalcula; el servicio refuerza). */
export async function editEmittedInvoiceAction(id: string, input: unknown) {
  try {
    const session = await requireBillingWriter(await sessionToken());
    const data = await editEmittedInvoiceItems(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/invoices/:id/annul (solo admin). */
export async function annulInvoiceAction(id: string, input: unknown) {
  try {
    const session = await requireBillingWriter(await sessionToken());
    const data = await annulInvoice(session.sedeId, id, input, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/invoices/:id/payments/split (solo admin/caja). */
export async function splitPaymentAction(id: string, input: unknown) {
  try {
    const session = await requireBillingWriter(await sessionToken());
    const data = await splitPayment(session.sedeId, id, input, { userId: session.userId });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
