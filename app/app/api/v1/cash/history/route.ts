import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireSession } from "@/src/features/admin/service";
import { CashError, getHistory } from "@/src/features/cash/service";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

function isoDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * GET /api/v1/cash/history?desde=&hasta= — historial de turnos por rango
 * (requiere sesión, cualquier rol de su sede). Sin rango usa los últimos
 * 30 días.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await getHistory(resolveSede(session.sedeId, params.get("sede_id")), {
      desde: params.get("desde")?.trim() || isoDay(-30),
      hasta: params.get("hasta")?.trim() || isoDay(0),
    });
    return ok(data);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
