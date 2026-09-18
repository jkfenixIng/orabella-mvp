import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  InventoryError,
  getKardex,
  requireSession,
} from "@/src/features/inventory/service";

function inventoryErrorResponse(error: unknown) {
  if (error instanceof InventoryError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * GET /api/v1/inventory/kardex?product_id= — kardex cronológico ascendente.
 * Requiere sesión (cualquier rol de su sede).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const productId = request.nextUrl.searchParams.get("product_id")?.trim() ?? "";
    if (!productId) return fail("VALIDATION", "product_id requerido.", 400);
    const data = await getKardex(session.sedeId, productId);
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
