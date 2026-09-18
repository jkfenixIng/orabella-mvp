import {
  applyMovementStock,
  filterLowStock,
  matchesProductQuery,
  movementSchema,
  normalizeSku,
  productSchema,
  sortKardexAscending,
  type MovementInput,
  type MovementType,
  type ProductInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import {
  requireSedeRole,
  requireSession,
  resolveSede,
} from "@/src/features/admin/service";

export class InventoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function inventoryDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Roles que pueden escribir inventario (upsert + movimientos). */
const WRITER_ROLES: RoleCode[] = ["admin", "caja"];

/**
 * §10 Inventario: escritura solo admin/caja de su sede; lectura cualquier
 * rol autenticado de su sede (las rutas y actions aplican este gate).
 */
export async function requireInventoryWriter(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await getSessionUser(token);
  if (!session) {
    throw new InventoryError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
  }
  requireSedeRole(session.roles, WRITER_ROLES);
  if (!session.user.sede_id) {
    throw new InventoryError("NO_SEDE", "El usuario no tiene sede asignada.", 403);
  }
  return { userId: session.user.id, sedeId: session.user.sede_id, roles: session.roles };
}

// ------------------------------------------------------------------ productos ---
export interface ProductRow {
  id: string;
  sede_id: string;
  sku: string;
  name: string;
  description: string | null;
  stock_qty: number;
  min_stock: number;
  cost_price: number | null;
  sale_price: number | null;
  is_active: boolean;
}

const PRODUCT_SELECT =
  "id, sede_id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, is_active";

/** INV-05 + lectura: lista productos activos e inactivos de la sede. */
export async function listProducts(sedeId: string): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("sede_id", sedeId)
    .order("name");
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return (data ?? []) as ProductRow[];
}

export async function getProduct(id: string): Promise<ProductRow> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  if (!data) throw new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  return data as ProductRow;
}

/**
 * INV-01: crea o actualiza un producto (upsert por id). El SKU se
 * normaliza (trim + mayúsculas) y es único por sede: se valida a nivel
 * app para devolver SKU_TAKEN y el UNIQUE (sede_id, sku) cubre carreras.
 * INV-03: nunca toca stock_qty (el stock inicial va vía movimiento IN).
 */
export async function upsertProduct(raw: unknown): Promise<ProductRow> {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: ProductInput = parsed.data;
  const sku = normalizeSku(input.sku);
  const db = await inventoryDb();

  const conflictQuery = db
    .from("products")
    .select("id")
    .eq("sede_id", input.sede_id)
    .eq("sku", sku)
    .limit(1);
  const { data: conflicts, error: conflictError } = input.id
    ? await conflictQuery.neq("id", input.id)
    : await conflictQuery;
  if (conflictError) throw new InventoryError("INTERNAL", "Error interno.", 500);
  if (conflicts && conflicts.length > 0) {
    throw new InventoryError("SKU_TAKEN", "El SKU ya existe en esta sede.", 409);
  }

  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    sku,
    name: input.name,
    description: input.description ?? null,
    min_stock: input.min_stock,
    cost_price: input.cost_price ?? null,
    sale_price: input.sale_price ?? null,
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("products")
    .upsert(payload, { onConflict: "id" })
    .select(PRODUCT_SELECT)
    .single();
  if (error) {
    // Carrera perdida contra UNIQUE (sede_id, sku): mismo error de negocio.
    if ((error as { code?: string }).code === "23505") {
      throw new InventoryError("SKU_TAKEN", "El SKU ya existe en esta sede.", 409);
    }
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return data as ProductRow;
}

/** INV-05: búsqueda por fragmento de nombre o SKU, solo dentro de la sede. */
export async function searchProducts(sedeId: string, q: string): Promise<ProductRow[]> {
  const needle = q.trim();
  if (needle === "") return listProducts(sedeId);
  const db = await inventoryDb();
  const escaped = needle.replace(/[%_,\\]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  const { data, error } = await db
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("sede_id", sedeId)
    .or(`name.ilike.${pattern},sku.ilike.${pattern}`)
    .order("name");
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  const rows = (data ?? []) as ProductRow[];
  // Filtro de apoyo en memoria (misma regla que matchesProductQuery).
  return rows.filter((row) => matchesProductQuery(row, needle));
}

/** INV-04: productos con stock en o bajo el mínimo (alerta visible). */
export async function lowStockAlerts(sedeId: string): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(PRODUCT_SELECT)
    .eq("sede_id", sedeId)
    .eq("is_active", true)
    .order("stock_qty");
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return filterLowStock((data ?? []) as ProductRow[]);
}

// ---------------------------------------------------------------- movimientos ---
export interface MovementRow {
  id: string;
  sede_id: string;
  product_id: string;
  type: MovementType;
  qty: number;
  reason: string;
  user_id: string | null;
  created_at: string;
}

const MOVEMENT_SELECT =
  "id, sede_id, product_id, type, qty, reason, user_id, created_at";

export interface RegisterMovementResult {
  movement: MovementRow;
  stock_qty: number;
}

/**
 * INV-02/INV-03/INV-04: registra un movimiento y devuelve el stock
 * resultante. IN suma, OUT resta (bloqueado si quedaría negativo),
 * ADJUST fija el nivel con motivo obligatorio.
 *
 * El stock lo aplica el trigger trg_inventory_apply_stock (único
 * escritor); aquí se pre-verifica con applyMovementStock para un error de
 * negocio claro y se traduce la excepción INSUFFICIENT_STOCK del trigger
 * (carreras concurrentes) al mismo código 409.
 */
export async function registerMovement(
  raw: unknown,
  actor: { userId: string; sedeId: string },
): Promise<RegisterMovementResult> {
  const parsed = movementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InventoryError("VALIDATION", validationMessage(parsed.error), 400);
  }
  const input: MovementInput = parsed.data;
  const db = await inventoryDb();

  const product = await getProduct(input.product_id);
  resolveSedeOrThrow(actor.sedeId, product.sede_id);

  try {
    applyMovementStock(product.stock_qty, input.type, input.qty);
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
      throw new InventoryError(
        "INSUFFICIENT_STOCK",
        "Stock insuficiente: el movimiento dejaría el stock negativo.",
        409,
      );
    }
    throw new InventoryError("VALIDATION", "Cantidad inválida.", 400);
  }

  const { data, error } = await db
    .from("inventory_movements")
    .insert({
      sede_id: product.sede_id,
      product_id: product.id,
      type: input.type,
      qty: input.qty,
      reason: input.reason,
      user_id: actor.userId,
    })
    .select(MOVEMENT_SELECT)
    .single();
  if (error) {
    if (typeof error.message === "string" && error.message.includes("INSUFFICIENT_STOCK")) {
      throw new InventoryError(
        "INSUFFICIENT_STOCK",
        "Stock insuficiente: el movimiento dejaría el stock negativo.",
        409,
      );
    }
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new InventoryError("INTERNAL", "Error interno.", 500);

  const current = await getProduct(product.id);
  return { movement: data as MovementRow, stock_qty: current.stock_qty };
}

function resolveSedeOrThrow(sessionSedeId: string, rowSedeId: string): void {
  try {
    resolveSede(sessionSedeId, rowSedeId);
  } catch {
    throw new InventoryError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
  }
}

/** Kardex cronológico ascendente de un producto (solo su sede). */
export async function getKardex(
  sedeId: string,
  productId: string,
): Promise<MovementRow[]> {
  const product = await getProduct(productId);
  resolveSedeOrThrow(sedeId, product.sede_id);
  const db = await inventoryDb();
  const { data, error } = await db
    .from("inventory_movements")
    .select(MOVEMENT_SELECT)
    .eq("product_id", productId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return sortKardexAscending((data ?? []) as MovementRow[]);
}

export { requireSession };
