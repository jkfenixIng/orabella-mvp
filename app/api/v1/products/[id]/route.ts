import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
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

/** GET /api/v1/products/:id — detalle (requiere sesión). */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireSession(tokenOf(request));
    const { id } = await context.params;
    const data = await getProduct(id);
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
    await requireInventoryWriter(tokenOf(request));
    const { id } = await context.params;
    // La existencia se comprueba antes de editar: sin producto no hay nada que
    // actualizar, y el error de negocio sigue siendo NOT_FOUND.
    await getProduct(id);
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertProduct({ ...record, id });
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
