import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  BillingError,
  requireBillingWriter,
  splitPayment,
} from "@/src/features/billing/service";

function billingErrorResponse(error: unknown) {
  if (error instanceof BillingError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/invoices/:id/payments/split — cobro dividido en porciones
 * por método de pago (solo admin/caja). Equivale al `payments:split` del
 * PRD §10 (en Next la carpeta no admite `:` en Windows, se usa
 * `payments/split`). Rechaza sobrepago; al completar el total → Pagada.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireBillingWriter(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await splitPayment(session.sedeId, id, body);
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
