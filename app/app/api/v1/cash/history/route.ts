import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede, requireAdminSession } from "@/src/features/admin/service";
import { CashError, getHistory } from "@/src/features/cash/service";
import { bogotaDay } from "@/src/features/cash/schemas";

function cashErrorResponse(error: unknown) {
  if (error instanceof CashError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

function isoDay(offsetDays: number): string {
  return bogotaDay(offsetDays);
}

/**
 * GET /api/v1/cash/history?desde=&hasta= — historial de turnos por rango
 * (solo admin, igual que la server action). Sin rango usa los últimos
 * 30 días.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireAdminSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const data = await getHistory(resolveSede(session.sedeId, params.get("sede_id")), {
      desde: params.get("desde")?.trim() || isoDay(-30),
      hasta: params.get("hasta")?.trim() || isoDay(0),
      page: params.get("page") ?? undefined,
    });
    return ok(data);
  } catch (error) {
    return cashErrorResponse(error);
  }
}
