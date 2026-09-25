import {
  applyMovementStock,
  filterLowStock,
  matchesProductQuery,
  movementSchema,
  normalizeSku,
  planStockDeduction,
  productSchema,
  sortKardexAscending,
  type DeductionLine,
  type MovementInput,
  type MovementType,
  type PlannedDeduction,
  type ProductInput,
} from "./schemas";
import type { RoleCode } from "@/src/features/auth/schemas";
import { getSessionUser } from "@/src/features/auth/service";
import { requireSedeRole, resolveSede } from "@/src/shared/lib/sede";
import { requireSession } from "@/src/features/admin/service";

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

/**
 * Límite de lectura para listados (navegación instantánea): 50 filas por
 * defecto; kardex y alertas (excepcionales) acotados a 200. Nunca sin límite.
 */
function clampLimit(limit: number | undefined, def = 50, max = 500): number {
  if (limit === undefined) return def;
  if (!Number.isFinite(limit)) return def;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

/** Roles que pueden escribir inventario (upsert + movimientos). */
const WRITER_ROLES: RoleCode[] = ["admin", "caja"];

/** Solo admin: editar productos y movimientos que no sean entradas. */
export async function requireInventoryAdmin(
  token: string | null | undefined,
): Promise<{ userId: string; sedeId: string; roles: RoleCode[] }> {
  const session = await requireInventoryWriter(token);
  requireSedeRole(session.roles, ["admin"]);
  return session;
}

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
  /** I1: comisión sugerida del producto (absoluta); null = sin sugerencia. */
  commission_value: number | null;
  is_active: boolean;
}

const PRODUCT_SELECT =
  "id, sede_id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, commission_value, is_active";
/** Misma selección sin la comisión: la migración 027 aún sin aplicar en esta base. */
const PRODUCT_SELECT_LEGACY =
  "id, sede_id, sku, name, description, stock_qty, min_stock, cost_price, sale_price, is_active";

// I1: commission_value llega con la migración 027. La primera consulta decide y
// se cachea para no repetir la prueba; un error distinto (red/permisos) no se
// cachea, así la consulta real lo reporta en vez de degradar en silencio.
let commissionColumn: boolean | null = null;

async function resolveProductSelect(db: Awaited<ReturnType<typeof inventoryDb>>): Promise<string> {
  if (commissionColumn === null) {
    const probe = await db.from("products").select("commission_value").limit(1);
    if (!probe.error) {
      commissionColumn = true;
    } else {
      const message = String((probe.error as { message?: string }).message ?? "");
      if (/commission_value/i.test(message)) commissionColumn = false;
    }
  }
  return commissionColumn === false ? PRODUCT_SELECT_LEGACY : PRODUCT_SELECT;
}

/** Rellena commission_value cuando la columna no está disponible en esta base. */
function normalizeProduct(row: Record<string, unknown>): ProductRow {
  return {
    ...(row as unknown as ProductRow),
    commission_value: (row.commission_value as number | null) ?? null,
  };
}

/** INV-05 + lectura: lista productos activos e inactivos de la sede (máx. 50 por defecto). */
export async function listProducts(sedeId: string, limit?: number): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct);
}

export async function getProduct(id: string): Promise<ProductRow> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("id", id)
    .maybeSingle();
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  if (!data) throw new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  return normalizeProduct(data as unknown as Record<string, unknown>);
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

  const select = await resolveProductSelect(db);
  const payload = {
    ...(input.id ? { id: input.id } : {}),
    sede_id: input.sede_id,
    sku,
    name: input.name,
    description: input.description ?? null,
    min_stock: input.min_stock,
    cost_price: input.cost_price ?? null,
    sale_price: input.sale_price ?? null,
    // Con la columna ausente (027 sin aplicar) no se envía la comisión.
    ...(select === PRODUCT_SELECT ? { commission_value: input.commission_value ?? null } : {}),
    ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
  };
  const { data, error } = await db
    .from("products")
    .upsert(payload, { onConflict: "id" })
    .select(select)
    .single();
  if (error) {
    // Carrera perdida contra UNIQUE (sede_id, sku): mismo error de negocio.
    if ((error as { code?: string }).code === "23505") {
      throw new InventoryError("SKU_TAKEN", "El SKU ya existe en esta sede.", 409);
    }
    throw new InventoryError("INTERNAL", "Error interno.", 500);
  }
  if (!data) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return normalizeProduct(data as unknown as Record<string, unknown>);
}

/** INV-05: búsqueda por fragmento de nombre o SKU, solo dentro de la sede (máx. 50 por defecto). */
export async function searchProducts(sedeId: string, q: string, limit?: number): Promise<ProductRow[]> {
  const needle = q.trim();
  if (needle === "") return listProducts(sedeId, limit);
  const db = await inventoryDb();
  const escaped = needle.replace(/[%_,\\]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .or(`name.ilike.${pattern},sku.ilike.${pattern}`)
    .order("name")
    .limit(clampLimit(limit));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct);
  // Filtro de apoyo en memoria (misma regla que matchesProductQuery).
  return rows.filter((row) => matchesProductQuery(row, needle));
}

/** INV-04: productos con stock en o bajo el mínimo (alerta visible, máx. 200). */
export async function lowStockAlerts(sedeId: string, limit?: number): Promise<ProductRow[]> {
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select(await resolveProductSelect(db))
    .eq("sede_id", sedeId)
    .eq("is_active", true)
    .order("stock_qty")
    .limit(clampLimit(limit, 200));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return filterLowStock(((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeProduct));
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
  actor_name?: string | null;
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

/**
 * B1/FAC-06 (frontera modular): lectura batch de stock para otros módulos.
 * Billing la usa para validar existencia/sede y pre-chequear stock SIN
 * tocar las tablas de inventario directamente. Una sola query con IN
 * (sin N+1); el mapa solo incluye productos de la sede indicada.
 */
export interface StockEntry {
  name: string;
  stock_qty: number;
  sede_id: string;
}

export async function getProductsStock(
  sedeId: string,
  productIds: string[],
): Promise<Map<string, StockEntry>> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) return new Map();
  const db = await inventoryDb();
  const { data, error } = await db
    .from("products")
    .select("id, sede_id, name, stock_qty")
    .eq("sede_id", sedeId)
    .in("id", unique);
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  return new Map(
    ((data ?? []) as Array<{ id: string; sede_id: string; name: string; stock_qty: number }>).map(
      (row) => [row.id, { name: row.name, stock_qty: Number(row.stock_qty), sede_id: row.sede_id }],
    ),
  );
}

function toStockError(error: unknown): InventoryError {
  if (error instanceof InventoryError) return error;
  if (error instanceof Error && error.message === "PRODUCT_NOT_FOUND") {
    return new InventoryError("NOT_FOUND", "Producto no encontrado.", 404);
  }
  if (error instanceof Error && error.message === "INSUFFICIENT_STOCK") {
    const details = (error as { details?: { name?: string; stock?: number; requested?: number } })
      .details;
    return new InventoryError(
      "INSUFFICIENT_STOCK",
      details
        ? `Stock insuficiente para ${details.name}: hay ${details.stock}, se piden ${details.requested}.`
        : "Stock insuficiente para el ajuste.",
      409,
    );
  }
  return new InventoryError("INTERNAL", "Error interno.", 500);
}

/**
 * B1/FAC-06 (frontera modular): descuenta stock para una venta.
 * Momento único del descuento: AL EMITIR la factura. Pagar después
 * (splitPayment) NO descuenta; anular revierte con IN; editar ajusta
 * por deltas. Servicios y líneas sin product_id no tocan stock.
 *
 * Valida todo ANTES de mover (existencia, sede, stock suficiente con
 * mensaje por producto, 409, nunca INTERNAL por falta de stock) y luego
 * registra un OUT por producto vía registerMovement (trigger aplica el
 * stock y bloquea carreras con el mismo 409).
 */
export async function deductStock(
  actor: { userId: string; sedeId: string },
  lines: DeductionLine[],
  reason: string,
): Promise<PlannedDeduction[]> {
  const wanted = [...new Set(lines.map((line) => line.product_id).filter((id): id is string => !!id))];
  // Solo servicios/custom: nada que descontar (no tocan stock).
  if (wanted.length === 0) return [];
  const stockMap = await getProductsStock(actor.sedeId, wanted);
  const stockByProduct = new Map(
    [...stockMap].map(([id, entry]) => [id, { name: entry.name, stock_qty: entry.stock_qty }]),
  );

  let planned: PlannedDeduction[];
  try {
    planned = planStockDeduction(lines, stockByProduct);
  } catch (error) {
    throw toStockError(error);
  }
  try {
    for (const item of planned) {
      await registerMovement(
        { product_id: item.product_id, type: "OUT", qty: item.qty, reason },
        actor,
      );
    }
  } catch (error) {
    throw toStockError(error);
  }
  return planned;
}

function resolveSedeOrThrow(sessionSedeId: string, rowSedeId: string): void {
  try {
    resolveSede(sessionSedeId, rowSedeId);
  } catch {
    throw new InventoryError("FORBIDDEN", "No tiene acceso a esa sede.", 403);
  }
}

/** Kardex cronológico ascendente de un producto (solo su sede, máx. 200 movimientos). */
export async function getKardex(
  sedeId: string,
  productId: string,
  limit?: number,
): Promise<MovementRow[]> {
  const product = await getProduct(productId);
  resolveSedeOrThrow(sedeId, product.sede_id);
  const db = await inventoryDb();
  const { data, error } = await db
    .from("inventory_movements")
    .select(MOVEMENT_SELECT)
    .eq("product_id", productId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(clampLimit(limit, 200));
  if (error) throw new InventoryError("INTERNAL", "Error interno.", 500);
  const rows = sortKardexAscending((data ?? []) as MovementRow[]);
  const actorIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => id !== null))];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await db.from("users").select("id, full_name").in("id", actorIds);
    for (const user of ((users ?? []) as Array<{ id: string; full_name: string }>)) {
      actorNames.set(user.id, user.full_name);
    }
  }
  return rows.map((row) => ({
    ...row,
    actor_name: row.user_id ? (actorNames.get(row.user_id) ?? null) : null,
  }));
}

export { requireSession };
