import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { CashError, closeShift, requireCashWriter } from "@/src/features/cash/service";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/cash-shifts/:id/close — cierra con arqueo (solo
 * admin/caja). Conteo y base dejada obligatorios; base incompleta exige
 * observación; calcula recogido (= contado − base) y diferencia.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireCashWriter(tokenOf(request));
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const data = await closeShift(session.sedeId, id, body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
