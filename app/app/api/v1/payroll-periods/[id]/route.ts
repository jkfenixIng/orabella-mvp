import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import {
  PayrollError,
  deletePayrollPeriod,
  getPeriodDetail,
  requirePayrollAdmin,
} from "@/src/features/payroll/service";

function payrollErrorResponse(error: unknown) {
  if (error instanceof PayrollError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * GET /api/v1/payroll-periods/:id — periodo con sus ítems y el saldo de
 * cada uno (requiere sesión, solo su sede).
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(tokenOf(_request));
    const { id } = await context.params;
    const data = await getPeriodDetail(session.sedeId, id);
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}

/**
 * DELETE /api/v1/payroll-periods/:id — borra un período en borrador (solo
 * admin de su sede). Arrastra ítems y pagos por cascada y devuelve a su estado
 * previo los vales que el borrador había descontado.
 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const { id } = await context.params;
    const data = await deletePayrollPeriod(session.sedeId, id, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
