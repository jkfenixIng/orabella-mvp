import { z } from "zod";
import { idempotencyKeySchema } from "@/src/features/billing/schemas";
import { copSchema } from "@/src/shared/money/cop";

/** INV-02: tipos de movimiento del kardex. */
export const movementTypeSchema = z.enum(["IN", "OUT", "ADJUST"]);
export type MovementType = z.infer<typeof movementTypeSchema>;

const uuidSchema = z.uuid("Identificador inválido.");

/** Length limit of the stored SKU. */
const PRODUCT_SKU_MAX_LENGTH = 40;
/** Prefix used when the name has no letter or digit. */
const PRODUCT_SKU_FALLBACK_PREFIX = "PROD";
const PRODUCT_SKU_PREFIX_LENGTH = 6;
const PRODUCT_SKU_SEQUENCE_WIDTH = 3;

/**
 * INV-01: SKU prefix from the product name: accents stripped, uppercase,
 * letters and digits only, at most 6 characters (`"Shampú de Ñandú"` →
 * `SHAMPU`). Only `[A-Z0-9]`, so it is also a literal regex fragment.
 */
export function productSkuPrefix(name: string): string {
  const prefix = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, PRODUCT_SKU_PREFIX_LENGTH);
  return prefix === "" ? PRODUCT_SKU_FALLBACK_PREFIX : prefix;
}

/**
 * INV-01: server-generated SKU `PREFIX-NNN`, the next number after the
 * highest one already used with that prefix (`SHAMPU-001`, `SHAMPU-002`, …).
 * Deterministic for the same name and existing SKUs; SKUs that do not follow
 * the pattern are ignored. Always within the 40 characters of the column.
 */
export function productSkuForName(name: string, existingSkus: Iterable<string>): string {
  const prefix = productSkuPrefix(name);
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const sku of existingSkus) {
    const match = pattern.exec(sku.trim().toUpperCase());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const sku = `${prefix}-${String(highest + 1).padStart(PRODUCT_SKU_SEQUENCE_WIDTH, "0")}`;
  return sku.slice(0, PRODUCT_SKU_MAX_LENGTH);
}

/**
 * INV-01: product (initial stock goes through an IN movement, never directly).
 * Public writes never carry the SKU: it is generated on create and immutable
 * on edit, so an unknown `sku` key is stripped and ignored.
 */
export const productSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  description: z.string().trim().max(500, "Descripción muy larga.").nullish(),
  min_stock: z.coerce.number().int("Mínimo entero.").nonnegative("El mínimo no puede ser negativo.").default(0),
  cost_price: copSchema("El costo no puede ser negativo.").nullish(),
  sale_price: copSchema("El precio no puede ser negativo.").nullish(),
  /** I1: comisión sugerida (valor absoluto) que precarga la línea de factura. */
  commission_value: copSchema("La comisión no puede ser negativa.").nullish(),
  is_active: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

/**
 * INV-02: movimiento con motivo obligatorio. qty > 0 (igual que el CHECK
 * de la migración). En ADJUST, qty es el nivel absoluto que se fija.
 *
 * CL-6: `idempotency_key` es la marca del INTENTO (ver `idempotencyKeySchema`,
 * billing/schemas.ts: una sola definición para todas las puertas que la usan).
 * Acá es OPCIONAL a propósito: este esquema lo comparte la función
 * `registerMovement`, que también llaman los caminos de FACTURACIÓN (emisión,
 * anulación, edición) y esos NO tienen un intento propio del cliente —ya están
 * cubiertos por la marca de la factura, el testigo de edición y el
 * compare-and-swap de anulación—, así que exigirles una marca sería inventarles
 * un intento que no existe. Obligarla acá rompería esos llamadores. La marca se
 * exige en `manualMovementSchema`, la frontera del camino MANUAL.
 */
export const movementSchema = z.object({
  product_id: uuidSchema,
  type: movementTypeSchema,
  qty: z.coerce.number().int("Cantidad entera.").positive("La cantidad debe ser mayor a 0."),
  reason: z.string().trim().min(1, "Motivo requerido.").max(500, "Motivo muy largo."),
  /** CL-6: marca del INTENTO; opcional en la función compartida (ver arriba). */
  idempotency_key: idempotencyKeySchema.optional(),
});
export type MovementInput = z.infer<typeof movementSchema>;

/**
 * CL-6: el movimiento MANUAL —el que registra una persona desde la pantalla de
 * inventario o desde la ruta REST— exige la MARCA del intento. Es la MISMA
 * definición (`idempotencyKeySchema`), sólo que obligatoria: un envío sin marca
 * no se puede reconocer como repetición, así que aceptarlo sin marca es reabrir
 * el defecto (un reintento escribe un segundo movimiento y mueve el stock dos
 * veces) para ESE llamador. El rechazo es ruidoso (VALIDATION 400) y no escribe
 * nada.
 *
 * Por qué la obligatoriedad vive acá y no en `movementSchema`: porque los
 * llamadores de FACTURACIÓN de `registerMovement` no tienen un intento propio
 * que marcar. Esta frontera es la del camino manual: la server action y la
 * ruta REST validan con ESTE esquema antes de tocar la base.
 */
export const manualMovementSchema = movementSchema.extend({
  idempotency_key: idempotencyKeySchema,
});
export type ManualMovementInput = z.infer<typeof manualMovementSchema>;

/** INV-05: búsqueda por fragmento de nombre o SKU (insensible a caja). */
export function matchesProductQuery(
  product: { name: string; sku: string },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return (
    product.name.toLowerCase().includes(needle) ||
    product.sku.toLowerCase().includes(needle)
  );
}

export interface LowStockCandidate {
  stock_qty: number;
  min_stock: number;
}

/** INV-04: true cuando el stock está en o bajo el mínimo (alerta visible). */
export function isLowStock(product: LowStockCandidate): boolean {
  return product.stock_qty <= product.min_stock;
}

export const stockFilterSchema = z.enum(["all", "low", "out"]);
export type StockFilter = z.infer<typeof stockFilterSchema>;
export type StockBadge = "empty" | "low" | null;

/** Visible stock state: zero is red; positive stock at or below minimum is orange. */
export function stockBadge(product: LowStockCandidate): StockBadge {
  if (product.stock_qty === 0) return "empty";
  return product.stock_qty <= product.min_stock ? "low" : null;
}

export function matchesStockFilter(product: LowStockCandidate, filter: StockFilter): boolean {
  if (filter === "all") return true;
  return stockBadge(product) === (filter === "out" ? "empty" : "low");
}

/** INV-04: filtra los productos que necesitan alerta de mínimo. */
export function filterLowStock<T extends LowStockCandidate>(rows: T[]): T[] {
  return rows.filter(isLowStock);
}

export interface KardexEntry {
  id: string;
  created_at: string;
}

/**
 * Kardex cronológico ascendente (más antiguo primero). Desempata por id
 * para un orden total estable cuando dos movimientos comparten timestamp.
 */
export function sortKardexAscending<T extends KardexEntry>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const byDate = a.created_at.localeCompare(b.created_at);
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });
}

/**
 * B1/FAC-06: planifica el descuento de stock de una venta (puro, sin BD).
 *
 * - Agrega cantidades por producto (varias líneas del mismo producto suman).
 * - Ignora líneas sin product_id (servicios y custom no tocan stock).
 * - Lanza PRODUCT_NOT_FOUND si el producto no está en el mapa de stock.
 * - Lanza INSUFFICIENT_STOCK si el OUT agregado dejaría negativo (misma
 *   regla que applyMovementStock y el trigger trg_inventory_no_negative).
 *   El error lleva `details` { productId, name, stock, requested } para que
 *   el servicio construya el mensaje de negocio sin adivinar.
 */
export interface DeductionLine {
  product_id: string | null | undefined;
  qty: number;
}

export interface PlannedDeduction {
  product_id: string;
  qty: number;
}

export interface InsufficientStockDetails {
  productId: string;
  name: string;
  stock: number;
  requested: number;
}

/**
 * Application authority for a multi-product OUT projection before an atomic
 * writer persists it. It aggregates repeated products and delegates every
 * resulting movement to `applyMovementStock`.
 */
export function planStockDeduction(
  lines: DeductionLine[],
  stockByProduct: Map<string, { name: string; stock_qty: number }>,
): PlannedDeduction[] {
  const totalByProduct = new Map<string, number>();
  for (const line of lines) {
    if (!line.product_id) continue;
    totalByProduct.set(line.product_id, (totalByProduct.get(line.product_id) ?? 0) + line.qty);
  }
  const planned: PlannedDeduction[] = [];
  for (const [productId, qty] of totalByProduct) {
    const entry = stockByProduct.get(productId);
    if (!entry) {
      const error = new Error("PRODUCT_NOT_FOUND");
      (error as { productId?: string }).productId = productId;
      throw error;
    }
    try {
      applyMovementStock(entry.stock_qty, "OUT", qty);
    } catch {
      const error = new Error("INSUFFICIENT_STOCK");
      (error as { details?: InsufficientStockDetails }).details = {
        productId,
        name: entry.name,
        stock: entry.stock_qty,
        requested: qty,
      };
      throw error;
    }
    planned.push({ product_id: productId, qty });
  }
  return planned;
}

export interface StockMovementLine {
  product_id: string;
  type: MovementType;
  qty: number;
}

/**
 * Projects a batch of movements in order through `applyMovementStock`. Unknown
 * products start at 0 for IN/ADJUST (only quantity validity matters there) and
 * fail with PRODUCT_NOT_FOUND for OUT, the same code the trigger raises.
 */
export function projectStockMovements(
  moves: readonly StockMovementLine[],
  stockByProduct: ReadonlyMap<string, { stock_qty: number }>,
): Map<string, number> {
  const projected = new Map<string, number>();
  for (const move of moves) {
    const known = projected.get(move.product_id) ?? stockByProduct.get(move.product_id)?.stock_qty;
    if (known === undefined && move.type === "OUT") throw new Error("PRODUCT_NOT_FOUND");
    projected.set(move.product_id, applyMovementStock(known ?? 0, move.type, move.qty));
  }
  return projected;
}

export interface StockReversalLine {
  product_id: string;
  qty: number;
  reason: string;
}

/**
 * Application authority for annulment reversals: one IN per invoice line (the
 * kardex keeps every line, so nothing is aggregated) validated through
 * `projectStockMovements`. The lines are returned unchanged. There is no upper
 * business-stock rule in the application; PostgreSQL's integer representation
 * remains the physical range defense.
 */
export function planStockReversals(lines: readonly StockReversalLine[]): StockReversalLine[] {
  // IN never depends on the current stock, so no read is needed; a missing
  // product is still rejected by the RPC count net (PRODUCT_NOT_FOUND).
  projectStockMovements(
    lines.map((line) => ({ product_id: line.product_id, type: "IN" as const, qty: line.qty })),
    new Map(),
  );
  return lines.map((line) => ({ product_id: line.product_id, qty: line.qty, reason: line.reason }));
}

/**
 * Aplica un movimiento al stock en memoria. Lanza INSUFFICIENT_STOCK si un
 * OUT dejaría el stock negativo (misma regla que el trigger
 * trg_inventory_no_negative). Puro para poder probarlo sin base de datos.
 * Application authority for the stock projection. All TS writers must plan or
 * validate through this function; the inventory triggers remain the locked,
 * TOCTOU-safe physical defense at persistence time.
 */
export function applyMovementStock(
  current: number,
  type: MovementType,
  qty: number,
): number {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("INVALID_QTY");
  }
  switch (type) {
    case "IN":
      return current + qty;
    case "OUT": {
      const next = current - qty;
      if (next < 0) throw new Error("INSUFFICIENT_STOCK");
      return next;
    }
    case "ADJUST":
      return qty;
  }
}
