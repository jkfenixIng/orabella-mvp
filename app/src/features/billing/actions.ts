"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireSession } from "@/src/features/admin/service";
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

/** Misma lógica que GET /api/v1/invoices (requiere sesión, solo su sede). */
export async function listInvoicesAction(filters: {
  sede_id?: string;
  status?: string;
  from?: string;
  to?: string;
} = {}) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await listInvoices(resolveSede(session.sedeId, filters.sede_id), {
      status: filters.status || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/invoices/:id (requiere sesión, solo su sede). */
export async function getInvoiceAction(id: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getInvoiceDetail(session.sedeId, id);
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
