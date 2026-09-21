import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  listEmployees,
  requireAdminSession,
  requireSession,
  resolveSede,
  upsertEmployee,
} from "@/src/features/admin/service";

function adminErrorResponse(error: unknown) {
  if (error instanceof AdminError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/** GET /api/v1/employees?sede_id= — lista de la sede (requiere sesión). */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const requested = request.nextUrl.searchParams.get("sede_id");
    const data = await listEmployees(resolveSede(session.sedeId, requested));
    return ok(data);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/**
 * POST /api/v1/employees — crea o actualiza (upsert por id, solo admin).
 * Misma validación y servicio que upsertEmployeeAction.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminSession(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertEmployee({
      ...record,
      sede_id: resolveSede(session.sedeId, (record as { sede_id?: string }).sede_id),
    });
    return ok(data, 201);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
