import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  PayrollError,
  rejectVoucher,
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
 * POST /api/v1/vouchers/:id/reject — rechaza un vale pendiente con motivo
 * obligatorio (PAY-06, solo admin). Rechazada es terminal.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await rejectVoucher(session.sedeId, id, body);
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
