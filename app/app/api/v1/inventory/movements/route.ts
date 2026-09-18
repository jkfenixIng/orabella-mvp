import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  InventoryError,
  registerMovement,
  requireInventoryWriter,
} from "@/src/features/inventory/service";

function inventoryErrorResponse(error: unknown) {
  if (error instanceof InventoryError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * POST /api/v1/inventory/movements — registra IN/OUT/ADJUST (solo admin/caja).
 * Mismo servicio que registerMovementAction. OUT nunca deja stock negativo.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireInventoryWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await registerMovement(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
