"use server";

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import {
  InventoryError,
  getKardex,
  getProduct,
  listProducts,
  lowStockAlerts,
  registerManualMovement,
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

/** Misma lógica que GET /api/v1/products (requiere sesión). */
export async function listProductsAction(q?: string) {
  try {
    await requireSession(await sessionToken());
    const data = q?.trim() ? await searchProducts(q) : await listProducts();
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/products/:id (requiere sesión). */
export async function getProductAction(id: string) {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await getProduct(id) };
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
    if (isUpdate) {
      await requireInventoryAdmin(await sessionToken());
    } else {
      await requireInventoryWriter(await sessionToken());
    }
    return {
      success: true as const,
      data: await upsertProduct(typeof input === "object" && input !== null ? input : {}),
    };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Misma lógica que POST /api/v1/inventory/movements (IN: admin/caja; OUT/ADJUST: solo admin).
 *
 * CL-6: llama a `registerManualMovement`, la frontera del camino MANUAL, que
 * exige `idempotency_key` (uuid que la pantalla acuña al empezar el intento y
 * reutiliza en sus reintentos). Sin marca se rechaza con VALIDATION y CERO
 * escrituras: un envío sin marca no se puede reconocer como repetición, así que
 * aceptarlo reabriría el defecto (un segundo movimiento y el stock movido dos
 * veces). Con la marca repetida devuelve el movimiento ya registrado, no otro.
 * La acción NO llama a `registerMovement` directo: ese es el punto de la
 * frontera.
 */
export async function registerMovementAction(input: unknown) {
  try {
    const movementType =
      typeof input === "object" && input !== null
        ? (input as { type?: unknown }).type
        : undefined;
    const session = movementType === "IN" || movementType === undefined
      ? await requireInventoryWriter(await sessionToken())
      : await requireInventoryAdmin(await sessionToken());
    const data = await registerManualMovement(input, { userId: session.userId });
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/inventory/kardex (requiere sesión). */
export async function getKardexAction(productId: string) {
  try {
    await requireSession(await sessionToken());
    return { success: true as const, data: await getKardex(productId) };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que GET /api/v1/inventory/alerts (requiere sesión). */
export async function lowStockAlertsAction() {
  try {
    await requireSession(await sessionToken());
    const data = await lowStockAlerts();
    return { success: true as const, data };
  } catch (error) {
    return toFailure(error);
  }
}
