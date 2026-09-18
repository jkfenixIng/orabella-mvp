import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PayrollError,
  closePayrollPeriod,
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
 * POST /api/v1/payroll-periods/:id/close — cierra el periodo (PAY-01,
 * solo admin). Cerrado = inmutable: bloquea cálculo, pagos y cambios
 * posteriores.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const { id } = await context.params;
    const data = await closePayrollPeriod(session.sedeId, id);
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
