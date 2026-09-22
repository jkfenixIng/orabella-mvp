import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireSession } from "@/src/features/admin/service";
import { CashError, getDayView } from "@/src/features/cash/service";
import { accumulateDayTotals, bogotaDay } from "@/src/features/cash/schemas";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

function todayLocal(): string {
  return bogotaDay(0);
}

/**
 * GET /api/v1/cash/day?fecha= — turnos del día + acumulado.
 * Admin ve todo; el resto solo sus turnos (igual que la server action).
 * Sin fecha usa hoy.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await getDayView(resolveSede(session.sedeId, params.get("sede_id")), {
      fecha: params.get("fecha")?.trim() || todayLocal(),
    });
    if (session.roles.includes("admin")) return ok(data);
    const shifts = data.shifts.filter((view) => view.shift.opened_by === session.userId);
    return ok({
      ...data,
      shifts,
      totals: accumulateDayTotals(
        shifts.map((view) => ({
          expectedCash: view.efectivo,
          countedCash: view.shift.counted_cash,
          baseLeft: view.shift.base_left,
          cashWithdrawn: view.shift.cash_withdrawn,
          baseDifference: view.shift.base_difference,
          ventas: view.ventas,
        })),
      ),
    });
  } catch (error) {
    return cashErrorResponse(error);
  }
}
