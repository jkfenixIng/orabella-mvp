import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  AdminError,
  listPaymentMethods,
  requireAdminSession,
  requireSession,
  upsertPaymentMethod,
} from "@/src/features/admin/service";

function adminErrorResponse(error: unknown) {
  if (error instanceof AdminError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/** GET /api/v1/payment-methods — métodos de pago (requiere sesión). */
export async function GET(request: NextRequest) {
  try {
    await requireSession(tokenOf(request));
    const data = await listPaymentMethods();
    return ok(data);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/**
 * POST /api/v1/payment-methods — crea o actualiza (upsert por id, solo admin).
 * Mismo servicio que upsertPaymentMethodAction.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdminSession(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertPaymentMethod(record);
    return ok(data, 201);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
