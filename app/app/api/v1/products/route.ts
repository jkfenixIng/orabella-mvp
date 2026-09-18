import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/features/admin/service";
import {
  InventoryError,
  listProducts,
  requireInventoryWriter,
  requireSession,
  searchProducts,
  upsertProduct,
} from "@/src/features/inventory/service";

function inventoryErrorResponse(error: unknown) {
  if (error instanceof InventoryError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

function tokenOf(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * GET /api/v1/products?sede_id=&q= — lista o busca (nombre/SKU) en la sede.
 * Requiere sesión (cualquier rol de su sede).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(tokenOf(request));
    const params = request.nextUrl.searchParams;
    const sede = resolveSede(session.sedeId, params.get("sede_id"));
    const q = params.get("q") ?? "";
    const data = q.trim() ? await searchProducts(sede, q) : await listProducts(sede);
    return ok(data);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}

/**
 * POST /api/v1/products — crea o actualiza (upsert por id, solo admin/caja).
 * Mismo servicio que upsertProductAction. El stock inicial va vía
 * POST /api/v1/inventory/movements (INV-03).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireInventoryWriter(tokenOf(request));
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === "object" && body !== null ? body : {};
    const data = await upsertProduct({
      ...record,
      sede_id: resolveSede(session.sedeId, (record as { sede_id?: string }).sede_id),
    });
    return ok(data, 201);
  } catch (error) {
    return inventoryErrorResponse(error);
  }
}
