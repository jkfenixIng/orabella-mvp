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
  console.error("invoices POST non-billing error:", error instanceof Error ? (error.stack ?? error.message) : error);
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
    const pageParam = params.get("page");
    const consecutiveParam = params.get("consecutive_number");
    const data = await listInvoices(resolveSede(session.sedeId, params.get("sede_id")), {
      status: params.get("status") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      user_id: params.get("user_id") ?? undefined,
      closed_by: params.get("closed_by") ?? undefined,
      employee_id: params.get("employee_id") ?? undefined,
      consecutive_number: consecutiveParam ? Number(consecutiveParam) : undefined,
      page: pageParam ? Number(pageParam) : undefined,
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
 *
 * MO-1 (idempotencia): el cuerpo exige `idempotency_key` (uuid del intento de
 * emisión). Es una superficie pública y los reintentos sobre una red cortada
 * son exactamente su caso de uso, así que la marca NO es opcional: sin ella
 * responde VALIDATION (400) en vez de emitir sin protección. Reenviar la misma
 * marca devuelve la factura que ya existe —un no-op exitoso para el llamador—
 * con el mismo 201, en lugar de emitir una segunda factura.
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
