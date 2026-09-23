import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMovementStock,
  areSkusConflicting,
  filterLowStock,
  isLowStock,
  matchesProductQuery,
  movementSchema,
  normalizeSku,
  planStockDeduction,
  productSchema,
  sortKardexAscending,
} from "@/src/features/inventory/schemas";

const SEDE_A = "11111111-1111-4111-8111-111111111111";
const SEDE_B = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    sede_id: SEDE_A,
    sku: "SH-001",
    name: "Shampoo",
    ...overrides,
  };
}

describe("inventory schemas: producto (INV-01)", () => {
  it("acepta producto válido con precios y mínimo", () => {
    const parsed = productSchema.safeParse(
      baseProduct({ min_stock: 5, cost_price: 20000, sale_price: 35000 }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rechaza SKU vacío, nombre vacío y montos negativos", () => {
    expect(productSchema.safeParse(baseProduct({ sku: "  " })).success).toBe(false);
    expect(productSchema.safeParse(baseProduct({ name: "" })).success).toBe(false);
    expect(productSchema.safeParse(baseProduct({ min_stock: -1 })).success).toBe(false);
    expect(productSchema.safeParse(baseProduct({ cost_price: -5 })).success).toBe(false);
    expect(productSchema.safeParse(baseProduct({ sale_price: -5 })).success).toBe(false);
  });

  it("normaliza el SKU (trim + mayúsculas) para unicidad por sede", () => {
    expect(normalizeSku("  sh-001 ")).toBe("SH-001");
    expect(normalizeSku("Sh-001")).toBe("SH-001");
  });

  it("SKU duplicado en la misma sede colisiona; en otra sede no", () => {
    expect(
      areSkusConflicting({ sedeIdA: SEDE_A, skuA: "sh-001", sedeIdB: SEDE_A, skuB: " SH-001 " }),
    ).toBe(true);
    expect(
      areSkusConflicting({ sedeIdA: SEDE_A, skuA: "SH-001", sedeIdB: SEDE_A, skuB: "SH-002" }),
    ).toBe(false);
    expect(
      areSkusConflicting({ sedeIdA: SEDE_A, skuA: "SH-001", sedeIdB: SEDE_B, skuB: "SH-001" }),
    ).toBe(false);
  });
});

describe("inventory schemas: movimiento (INV-02)", () => {
  it("acepta IN/OUT/ADJUST con cantidad > 0 y motivo", () => {
    for (const type of ["IN", "OUT", "ADJUST"]) {
      expect(
        movementSchema.safeParse({ product_id: PRODUCT_ID, type, qty: 3, reason: "Compra" })
          .success,
      ).toBe(true);
    }
  });

  it("rechaza cantidad 0/negativa, motivo vacío y tipo desconocido", () => {
    const base = { product_id: PRODUCT_ID, type: "IN", reason: "Compra" };
    expect(movementSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, qty: -2 }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, qty: 2, reason: "  " }).success).toBe(false);
    expect(
      movementSchema.safeParse({ ...base, qty: 2, type: "VENTA" }).success,
    ).toBe(false);
  });
});

describe("inventory: stock nunca negativo en OUT (INV-04)", () => {
  it("IN suma y ADJUST fija el nivel", () => {
    expect(applyMovementStock(2, "IN", 3)).toBe(5);
    expect(applyMovementStock(10, "ADJUST", 4)).toBe(4);
  });

  it("OUT resta y permite llegar a cero exacto", () => {
    expect(applyMovementStock(2, "OUT", 1)).toBe(1);
    expect(applyMovementStock(2, "OUT", 2)).toBe(0);
  });

  it("OUT que dejaría negativo lanza INSUFFICIENT_STOCK", () => {
    expect(() => applyMovementStock(2, "OUT", 3)).toThrowError("INSUFFICIENT_STOCK");
    expect(() => applyMovementStock(0, "OUT", 1)).toThrowError("INSUFFICIENT_STOCK");
  });
});

describe("inventory: kardex ordenado cronológico (INV-02/INV-03)", () => {
  it("ordena ascendente por fecha y desempata por id", () => {
    const rows = [
      { id: "b", created_at: "2026-09-18T10:02:00Z" },
      { id: "a", created_at: "2026-09-18T10:01:00Z" },
      { id: "d", created_at: "2026-09-18T10:01:00Z" },
      { id: "c", created_at: "2026-09-18T10:03:00Z" },
    ];
    const sorted = sortKardexAscending(rows);
    expect(sorted.map((row) => row.id)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("inventory: alertas de mínimo (INV-04)", () => {
  it("alerta cuando stock <= mínimo, incluso en cero", () => {
    expect(isLowStock({ stock_qty: 2, min_stock: 5 })).toBe(true);
    expect(isLowStock({ stock_qty: 5, min_stock: 5 })).toBe(true);
    expect(isLowStock({ stock_qty: 0, min_stock: 0 })).toBe(true);
    expect(isLowStock({ stock_qty: 6, min_stock: 5 })).toBe(false);
  });

  it("filtra solo los productos bajo mínimo", () => {
    const rows = [
      { id: "ok", stock_qty: 10, min_stock: 2 },
      { id: "bajo", stock_qty: 1, min_stock: 5 },
      { id: "igual", stock_qty: 3, min_stock: 3 },
    ];
    expect(filterLowStock(rows).map((row) => row.id)).toEqual(["bajo", "igual"]);
  });
});

describe("inventory: búsqueda por nombre o SKU (INV-05)", () => {
  it("encuentra por fragmento de nombre o SKU sin importar caja", () => {
    const product = { name: "Shampoo Herbal", sku: "SH-001" };
    expect(matchesProductQuery(product, "sham")).toBe(true);
    expect(matchesProductQuery(product, "SHAM")).toBe(true);
    expect(matchesProductQuery(product, "sh-00")).toBe(true);
    expect(matchesProductQuery(product, "acondicionador")).toBe(false);
  });

  it("consulta vacía coincide con todo", () => {
    expect(matchesProductQuery({ name: "X", sku: "Y" }, "   ")).toBe(true);
  });
});

describe("inventory: planStockDeduction descuenta la venta (B1/FAC-06)", () => {
  const OTHER_ID = "44444444-4444-4444-8444-444444444444";
  const stock = () =>
    new Map([
      [PRODUCT_ID, { name: "Shampoo", stock_qty: 10 }],
      [OTHER_ID, { name: "Acondicionador", stock_qty: 3 }],
    ]);

  it("agrega líneas del mismo producto y descuenta exacto hasta cero", () => {
    expect(
      planStockDeduction(
        [
          { product_id: PRODUCT_ID, qty: 4 },
          { product_id: PRODUCT_ID, qty: 6 },
        ],
        stock(),
      ),
    ).toEqual([{ product_id: PRODUCT_ID, qty: 10 }]);
  });

  it("ignora líneas sin product_id (servicios/custom no tocan stock)", () => {
    expect(
      planStockDeduction(
        [
          { product_id: null, qty: 2 },
          { product_id: undefined, qty: 1 },
          { product_id: OTHER_ID, qty: 3 },
        ],
        stock(),
      ),
    ).toEqual([{ product_id: OTHER_ID, qty: 3 }]);
    expect(planStockDeduction([{ product_id: null, qty: 5 }], stock())).toEqual([]);
  });

  it("stock insuficiente lanza INSUFFICIENT_STOCK con detalle del producto", () => {
    try {
      planStockDeduction([{ product_id: OTHER_ID, qty: 4 }], stock());
      expect.unreachable("debió lanzar INSUFFICIENT_STOCK");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("INSUFFICIENT_STOCK");
      expect((error as { details?: unknown }).details).toEqual({
        productId: OTHER_ID,
        name: "Acondicionador",
        stock: 3,
        requested: 4,
      });
    }
  });

  it("producto ausente del mapa lanza PRODUCT_NOT_FOUND", () => {
    expect(() =>
      planStockDeduction([{ product_id: "99999999-9999-4999-8999-999999999999", qty: 1 }], stock()),
    ).toThrowError("PRODUCT_NOT_FOUND");
  });
});

describe("migración 004_inventory.sql (T4)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "004_inventory.sql"), "utf8");

  it("crea products e inventory_movements con triggers set_updated_at en products", () => {
    expect(sql).toContain("CREATE TABLE public.products");
    expect(sql).toContain("CREATE TABLE public.inventory_movements");
    expect(sql).toContain("trg_products_updated_at");
    expect(sql).toContain("set_updated_at()");
  });

  it("SKU único por sede y checks de cantidades y precios", () => {
    expect(sql).toContain("UNIQUE (sede_id, sku)");
    expect(sql).toContain("CHECK (stock_qty >= 0)");
    expect(sql).toContain("CHECK (qty > 0)");
    expect(sql).toContain("CHECK (type IN ('IN', 'OUT', 'ADJUST'))");
  });

  it("bloquea OUT negativo con lock de fila y aplica stock vía trigger", () => {
    expect(sql).toContain("inventory_no_negative_stock");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("INSUFFICIENT_STOCK");
    expect(sql).toContain("inventory_apply_stock");
    expect(sql).toContain("trg_inventory_no_negative");
    expect(sql).toContain("trg_inventory_apply_stock");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY pol_products_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_movements_sede_isolation");
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("documenta que el stock solo se escribe vía movimientos", () => {
    expect(sql).toContain("INV-03");
  });
});
