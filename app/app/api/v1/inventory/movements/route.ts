import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  InventoryError,
  registerManualMovement,
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
 *
 * CL-6: esta ruta es la frontera del camino MANUAL y exige `idempotency_key` en
 * el cuerpo (uuid del intento), igual que la server action: sin marca la
 * operación se rechaza con VALIDATION 400 y sin escribir nada, porque un envío
 * sin marca no se puede reconocer como repetición. Un reintento con la MISMA
 * marca devuelve el movimiento ya registrado (no-op exitoso) en vez de escribir
 * un segundo movimiento y mover el stock dos veces. Es la superficie que más
 * reintenta —doble clic o reenvío del navegador— cuando se corta la red.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireInventoryWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const data = await registerManualMovement(body, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return ok(data, 201);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
