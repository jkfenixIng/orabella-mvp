import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PayrollError,
  listPeriods,
  openPayrollPeriod,
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
 * GET /api/v1/payroll-periods — lista los periodos
 * (solo admin: es lectura de nómina completa y el API no tiene alcance por
 * fila; el recibo del empleado se ve por la action, que sí lo aplica).
 */
export async function GET(request: NextRequest) {
  try {
    await requirePayrollAdmin(tokenOf(request));
    const data = await listPeriods();
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}

/**
 * POST /api/v1/payroll-periods — abre un periodo borrador por sede y
 * rango (PAY-01, solo admin). Un solo borrador por sede y rango.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await openPayrollPeriod(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
