"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import { requireSession } from "@/src/features/admin/service";
import {
  BillingError,
  annulInvoice,
  createInvoice,
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
} = {}) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listInvoices(resolveSede(session.sedeId, filters.sede_id), {
      status: filters.status || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      user_id: filters.user_id,
      consecutive_number: filters.consecutive_number,
    });
    const isManager = session.roles.includes("admin") || session.roles.includes("caja");
    const scoped = isManager ? data : data.filter((row) => row.user_id === session.userId);
    return { success: true as const, data: scoped };
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
    const data = await splitPayment(session.sedeId, id, input);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
