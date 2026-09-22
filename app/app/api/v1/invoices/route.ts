import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import { requireSession } from "@/src/features/admin/service";
import {
  BillingError,
  createInvoice,
  listInvoices,
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
 * GET /api/v1/invoices?status=&from=&to= — lista de la sede con filtros
 * de estado/fecha (requiere sesión, cualquier rol de su sede).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await listInvoices(resolveSede(session.sedeId, params.get("sede_id")), {
      status: params.get("status") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}

/**
 * POST /api/v1/invoices — crea la factura (solo admin/caja).
 * Mismo servicio que createInvoiceAction: consecutivo con lock, snapshot
 * de impuestos activos, OUT de stock, porciones que cuadran con el total.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireBillingWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await createInvoice(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
