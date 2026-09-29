import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import {
  PayrollError,
  listVouchers,
  requestVoucher,
  requirePayrollPayer,
} from "@/src/features/payroll/service";

function payrollErrorResponse(error: unknown) {
  if (error instanceof PayrollError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * GET /api/v1/vouchers — lista los vales de la sede con filtro opcional
 * (?status=&employee_id=&request_date=). Requiere sesión, solo su sede.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await listVouchers(session.sedeId, {
      status: params.get("status") ?? undefined,
      employee_id: params.get("employee_id") ?? undefined,
      request_date: params.get("request_date") ?? undefined,
    });
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}

/**
 * POST /api/v1/vouchers — la caja (turno abierto) abre un vale para el
 * empleado que lo solicita en el mostrador (admin/caja vía requirePayrollPayer;
 * el servicio exige turno abierto y dueño o admin). El método arqueable se
 * elige al crear. Dentro de rango se genera directo; fuera de rango queda
 * pendiente (alerta voucher.requested) para autorización del admin.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePayrollPayer(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await requestVoucher(body, {
      userId: session.userId,
      sedeId: session.sedeId,
      roles: session.roles,
    });
    return ok(data, 201);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
