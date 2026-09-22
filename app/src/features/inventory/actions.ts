"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { resolveSede } from "@/src/shared/lib/sede";
import {
  InventoryError,
  getKardex,
  getProduct,
  listProducts,
  lowStockAlerts,
  registerMovement,
  requireInventoryAdmin,
  requireInventoryWriter,
  requireSession,
  searchProducts,
  upsertProduct,
} from "./service";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof InventoryError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que GET /api/v1/products (requiere sesión, solo su sede). */
export async function listProductsAction(sedeId?: string, q?: string) {
  try {
    const session = await requireSession(await sessionToken());
    const sede = resolveSede(session.sedeId, sedeId);
    const data = q?.trim() ? await searchProducts(sede, q) : await listProducts(sede);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/products/:id (requiere sesión, solo su sede). */
export async function getProductAction(id: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getProduct(id);
    resolveSede(session.sedeId, data.sede_id);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/products (crear: admin/caja; editar: solo admin). */
export async function upsertProductAction(input: unknown) {
  try {
    const isUpdate =
      typeof input === "object" && input !== null && "id" in input &&
      typeof (input as { id?: unknown }).id === "string" &&
      (input as { id: string }).id !== "";
    const session = isUpdate
      ? await requireInventoryAdmin(await sessionToken())
      : await requireInventoryWriter(await sessionToken());
    const data = await upsertProduct({
      ...(typeof input === "object" && input !== null ? input : {}),
      sede_id: resolveSede(session.sedeId, (input as { sede_id?: string }).sede_id),
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/inventory/movements (IN: admin/caja; OUT/ADJUST: solo admin). */
export async function registerMovementAction(input: unknown) {
  try {
    const movementType =
      typeof input === "object" && input !== null
        ? (input as { type?: unknown }).type
        : undefined;
    const session = movementType === "IN" || movementType === undefined
      ? await requireInventoryWriter(await sessionToken())
      : await requireInventoryAdmin(await sessionToken());
    const data = await registerMovement(input, {
      userId: session.userId,
      sedeId: session.sedeId,
    });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/inventory/kardex (requiere sesión). */
export async function getKardexAction(productId: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await getKardex(session.sedeId, productId);
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/inventory/alerts (requiere sesión). */
export async function lowStockAlertsAction(sedeId?: string) {
  try {
    const session = await requireSession(await sessionToken());
    const data = await lowStockAlerts(resolveSede(session.sedeId, sedeId));
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
