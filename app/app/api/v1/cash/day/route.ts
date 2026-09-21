import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireSession } from "@/src/features/admin/service";
import { CashError, getDayView } from "@/src/features/cash/service";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * GET /api/v1/cash/day?fecha= — turnos del día + acumulado
 * (requiere sesión, cualquier rol de su sede). Sin fecha usa hoy.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await getDayView(resolveSede(session.sedeId, params.get("sede_id")), {
      fecha: params.get("fecha")?.trim() || todayLocal(),
    });
    return ok(data);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
