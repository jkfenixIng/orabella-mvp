import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  InventoryError,
  lowStockAlerts,
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
 * GET /api/v1/inventory/alerts — productos con stock <= mínimo.
 * Requiere sesión (cualquier rol).
 */
export async function GET(request: NextRequest) {
  try {
    await requireSession(tokenOf(request));
    const data = await lowStockAlerts();
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
