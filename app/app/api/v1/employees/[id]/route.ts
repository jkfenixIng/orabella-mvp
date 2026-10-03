import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  getEmployee,
  requireAdminSession,
  requireSession,
  upsertEmployee,
} from "@/src/features/admin/service";

function adminErrorResponse(error: unknown) {
  if (error instanceof AdminError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/** GET /api/v1/employees/:id — detalle (requiere sesión). */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession(tokenOf(request));
    const { id } = await context.params;
    const data = await getEmployee(id);
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
    // La existencia se comprueba antes de editar: sin legajo no hay nada que
    // actualizar, y el error de negocio sigue siendo NOT_FOUND.
    await getEmployee(id);
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertEmployee({ ...record, id }, session.sedeId);
    return ok(data);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
