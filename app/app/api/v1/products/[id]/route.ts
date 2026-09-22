import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import {
  InventoryError,
  getProduct,
  requireInventoryWriter,
  requireSession,
  upsertProduct,
} from "@/src/features/inventory/service";

function inventoryErrorResponse(error: unknown) {
  if (error instanceof InventoryError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/v1/products/:id — detalle (requiere sesión, solo su sede). */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireSession(tokenOf(request));
    const { id } = await context.params;
    const data = await getProduct(id);
    resolveSede(session.sedeId, data.sede_id);
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}

/**
 * PATCH /api/v1/products/:id — actualiza parcial (solo admin/caja).
 * Misma validación y servicio que upsertProductAction. Nunca toca stock.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireInventoryWriter(tokenOf(request));
    const { id } = await context.params;
    const current = await getProduct(id);
    resolveSede(session.sedeId, current.sede_id);
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertProduct({
      ...record,
      id,
      sede_id: resolveSede(session.sedeId, (record as { sede_id?: string }).sede_id),
    });
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
