import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import { BillingError, getInvoiceDetail } from "@/src/features/billing/service";

function billingErrorResponse(error: unknown) {
  if (error instanceof BillingError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/** GET /api/v1/invoices/:id — detalle con ítems, impuestos y porciones. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    // La puerta sigue siendo `requireSession`: el detalle ya no se acota por
    // sede, así que el resultado no se usa, pero sin sesión la ruta no abre.
    await requireSession(tokenOf(request));
    const { id } = await context.params;
    const data = await getInvoiceDetail(id);
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
