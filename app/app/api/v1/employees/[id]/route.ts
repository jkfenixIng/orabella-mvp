import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  getEmployee,
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

/** GET /api/v1/employees/:id — detalle (requiere sesión, solo su sede). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession(tokenOf(request));
    const { id } = await context.params;
    const data = await getEmployee(id);
    resolveSede(session.sedeId, data.sede_id);
    return ok(data);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/**
 * PATCH /api/v1/employees/:id — actualiza parcial (solo admin).
 * Misma validación y servicio que upsertEmployeeAction.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdminSession(tokenOf(request));
    const { id } = await context.params;
    const current = await getEmployee(id);
    resolveSede(session.sedeId, current.sede_id);
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertEmployee({
      ...record,
      id,
      sede_id: resolveSede(session.sedeId, (record as { sede_id?: string }).sede_id),
    });
    return ok(data);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
