import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
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
 * cada uno (solo admin). Esta lectura NO tiene alcance por fila: devuelve la
 * nómina de toda la planta, así que no puede quedar en manos de otro rol. El
 * recibo del empleado se ve por la action, que sí recorta por legajo.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(_request));
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
