import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { requireSession } from "@/src/features/admin/service";
import {
  PayrollError,
  getVoucherSettings,
  requirePayrollAdmin,
  setVoucherLimits,
} from "@/src/features/payroll/service";

function payrollErrorResponse(error: unknown) {
  if (error instanceof PayrollError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * GET /api/v1/voucher-settings — topes vigentes de la sede (requiere
 * sesión, solo su sede).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const data = await getVoucherSettings(session.sedeId);
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}

/**
 * POST /api/v1/voucher-settings — configura los topes día/semana de la
 * sede (PAY-05, solo admin).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePayrollAdmin(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await setVoucherLimits(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data);
  } catch (error) {
    return payrollErrorResponse(error);
  }
}
