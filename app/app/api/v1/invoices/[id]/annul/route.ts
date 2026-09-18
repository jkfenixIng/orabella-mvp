import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  BillingError,
  annulInvoice,
  requireBillingWriter,
} from "@/src/features/billing/service";

function billingErrorResponse(error: unknown) {
  if (error instanceof BillingError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/invoices/:id/annul — anula con motivo (solo admin).
 * Mismo servicio que annulInvoiceAction: reversión de stock + motivo
 * auditado en cancel_reason (sin borrado, conserva el consecutivo).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireBillingWriter(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await annulInvoice(session.sedeId, id, body, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
