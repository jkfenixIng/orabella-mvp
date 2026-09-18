import { z } from "zod";

/** INV-02: tipos de movimiento del kardex. */
export const movementTypeSchema = z.enum(["IN", "OUT", "ADJUST"]);
export type MovementType = z.infer<typeof movementTypeSchema>;

const uuidSchema = z.uuid("Identificador inválido.");
const sedeIdSchema = z.uuid("Sede inválida.");

/**
 * INV-01: normaliza el SKU (trim + mayúsculas) para que la unicidad por
 * sede sea insensible a caja y espacios. Se guarda ya normalizado.
 */
export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toUpperCase();
}

/**
 * INV-01: conflicto de SKU a nivel app (además del UNIQUE (sede_id, sku)).
 * Dos SKU normalizados iguales en la misma sede colisionan.
 */
export function areSkusConflicting(args: {
  sedeIdA: string;
  skuA: string;
  sedeIdB: string;
  skuB: string;
}): boolean {
  if (args.sedeIdA !== args.sedeIdB) return false;
  return normalizeSku(args.skuA) === normalizeSku(args.skuB);
}

/** INV-01: producto (el stock inicial va vía movimiento IN, nunca directo). */
export const productSchema = z.object({
  id: uuidSchema.optional(),
  sede_id: sedeIdSchema,
  sku: z.string().trim().min(1, "SKU requerido.").max(40, "SKU muy largo."),
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  description: z.string().trim().max(500, "Descripción muy larga.").nullish(),
  min_stock: z.coerce.number().int("Mínimo entero.").nonnegative("El mínimo no puede ser negativo.").default(0),
  cost_price: z.coerce.number().nonnegative("El costo no puede ser negativo.").nullish(),
  sale_price: z.coerce.number().nonnegative("El precio no puede ser negativo.").nullish(),
  is_active: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productSchema>;

/**
 * INV-02: movimiento con motivo obligatorio. qty > 0 (igual que el CHECK
 * de la migración). En ADJUST, qty es el nivel absoluto que se fija.
 */
export const movementSchema = z.object({
  product_id: uuidSchema,
  type: movementTypeSchema,
  qty: z.coerce.number().int("Cantidad entera.").positive("La cantidad debe ser mayor a 0."),
  reason: z.string().trim().min(1, "Motivo requerido.").max(500, "Motivo muy largo."),
});
export type MovementInput = z.infer<typeof movementSchema>;

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
 * Aplica un movimiento al stock en memoria. Lanza INSUFFICIENT_STOCK si un
 * OUT dejaría el stock negativo (misma regla que el trigger
 * trg_inventory_no_negative). Puro para poder probarlo sin base de datos.
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
