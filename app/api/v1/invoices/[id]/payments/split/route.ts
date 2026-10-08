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
 *
 * CL-2 (idempotencia): el cuerpo exige `idempotency_key` (uuid del intento de
 * cobro). Es una superficie pública y los reintentos sobre una red cortada son
 * exactamente su caso de uso, así que la marca NO es opcional: sin ella
 * responde VALIDATION (400) en vez de cobrar sin protección. Reenviar la misma
 * marca devuelve la factura ya cobrada —un no-op exitoso para el llamador— en
 * lugar de tratarlo como un cobro nuevo (que era lo que pasaba: el reintento
 * moría con OVERPAID por una operación que sí se había registrado).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireBillingWriter(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await splitPayment(id, body, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
