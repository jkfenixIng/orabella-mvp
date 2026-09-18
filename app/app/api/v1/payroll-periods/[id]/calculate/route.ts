import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PayrollError,
  calculatePayroll,
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
 * POST /api/v1/payroll-periods/:id/calculate — calcula (o recalcula) el
 * borrador (PAY-02/PAY-03/PAY-07, solo admin). Fijo según pay_type +
 * comisiones desde invoice_items del rango con detail_json por
 * factura/ítem + bonos − vales (que pasan a descontada) − otros = neto.
 * Periodo cerrado → PERIOD_CLOSED.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await calculatePayroll(session.sedeId, id, body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
