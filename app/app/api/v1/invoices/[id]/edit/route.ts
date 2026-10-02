import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireAdminSession, AdminError } from "@/src/features/admin/service";
import {
  BillingError,
  editInvoiceItems,
} from "@/src/features/billing/service";

function billingErrorResponse(error: unknown) {
  if (error instanceof BillingError) return fail(error.code, error.message, error.status);
  if (error instanceof AdminError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/invoices/:id/edit — edición admin con motivo (total
 * inmutable, inventario reajustado, guard de nómina cerrada). Solo admin.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdminSession(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await editInvoiceItems(session.sedeId, id, body, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return ok(data);
  } catch (error) {
    return billingErrorResponse(error);
  }
}
