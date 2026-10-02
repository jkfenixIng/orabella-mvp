import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMovementStock,
  areSkusConflicting,
  filterLowStock,
  isLowStock,
  manualMovementSchema,
  matchesProductQuery,
  movementSchema,
  normalizeSku,
  planStockDeduction,
  productSchema,
  proposeSku,
  sortKardexAscending,
} from "@/src/features/inventory/schemas";
import {
  InventoryError,
  deductStock,
  registerManualMovement,
  registerMovement,
} from "@/src/features/inventory/service";

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

  it("I1: acepta comisión sugerida válida y rechaza negativa", () => {
    expect(productSchema.safeParse(baseProduct({ commission_value: 5000 })).success).toBe(true);
    expect(productSchema.safeParse(baseProduct({ commission_value: 0 })).success).toBe(true);
    expect(productSchema.safeParse(baseProduct({ commission_value: null })).success).toBe(true);
    expect(productSchema.safeParse(baseProduct({ commission_value: -1 })).success).toBe(false);
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

describe("inventory: propuesta de SKU desde el nombre (ayuda del alta)", () => {
  it("deriva la base del nombre: sin acentos ni diacríticos, en mayúsculas", () => {
    expect(proposeSku("Shampú de Ñandú", [])).toBe("SHAMPU-DE-NANDU");
    expect(proposeSku("Jabón líquido", [])).toBe("JABON-LIQUIDO");
  });

  it("colapsa puntuación, símbolos y espacios en un solo separador", () => {
    expect(proposeSku("  Shampoo   H&S / 2x1 (500 ml) ", [])).toBe("SHAMPOO-H-S-2X1-500-ML");
    expect(proposeSku("A__B--C", [])).toBe("A-B-C");
  });

  it("recorta los separadores de los extremos y nunca deja uno colgando", () => {
    expect(proposeSku("--SH-001--", [])).toBe("SH-001");
    for (const name of ["...", "   ", "¿?", "  Shampoo  ", "ÁÉÍ-ÓÚ"]) {
      const sku = proposeSku(name, []);
      expect(sku.startsWith("-"), name).toBe(false);
      expect(sku.endsWith("-"), name).toBe(false);
    }
  });

  it("cae a una base fija cuando el nombre no aporta ningún alfanumérico", () => {
    expect(proposeSku("", [])).toBe("PROD");
    expect(proposeSku("   ", [])).toBe("PROD");
    expect(proposeSku("¡$%&/()=?", [])).toBe("PROD");
  });

  it("recorta a 40 caracteres, sufijo incluido, sin cortar dejando separador final", () => {
    expect(proposeSku("A".repeat(80), [])).toHaveLength(40);

    const tokens = Array.from({ length: 20 }, (_, index) => `TOKEN${index + 1}`).join(" ");
    const sku = proposeSku(tokens, []);
    expect(sku.length).toBeLessThanOrEqual(40);
    expect(sku.endsWith("-")).toBe(false);

    // Con la base ya tomada, el sufijo también entra en el tope de 40.
    const withSuffix = proposeSku(tokens, [sku]);
    expect(withSuffix.length).toBeLessThanOrEqual(40);
    expect(withSuffix).not.toBe(sku);
    expect(withSuffix.endsWith("-")).toBe(false);
  });

  it("desambigua contra los SKU ya cargados con la regla de la app (trim + mayúsculas)", () => {
    expect(proposeSku("Shampoo", [])).toBe("SHAMPOO");
    expect(proposeSku("Shampoo", [" shampoo "])).toBe("SHAMPOO-2");
    expect(proposeSku("Shampoo", ["SHAMPOO", "SHAMPOO-2"])).toBe("SHAMPOO-3");
    expect(proposeSku("Shampoo", ["SHAMPOO-3", "SHAMPOO", "SHAMPOO-2"])).toBe("SHAMPOO-4");
  });

  it("no agrega sufijo cuando la base está libre (control negativo)", () => {
    const sku = proposeSku("Shampoo", ["JABON", "SH-001"]);
    expect(sku).toBe("SHAMPOO");
    expect(sku).not.toContain("-2");
  });

  it("es determinista: mismos argumentos, mismo resultado, sin importar el orden", () => {
    const taken = ["SHAMPOO", "SHAMPOO-2", "SHAMPOO-3"];
    const first = proposeSku("Shampoo", taken);
    expect(first).toBe("SHAMPOO-4");
    expect(proposeSku("Shampoo", taken)).toBe(first);
    expect(proposeSku("Shampoo", [...taken].reverse())).toBe(first);
  });

  it("el resultado siempre pasa el esquema del producto (no vacío, <= 40)", () => {
    const names = [
      "",
      "   ",
      "¡$%&/()=?",
      "Shampú de Ñandú",
      "A".repeat(80),
      `Shampú de Ñandú ${"A".repeat(60)}`,
    ];
    for (const name of names) {
      const sku = proposeSku(name, []);
      expect(sku.length, name).toBeGreaterThan(0);
      expect(sku.length, name).toBeLessThanOrEqual(40);
      expect(
        productSchema.safeParse(baseProduct({ name: name.trim() || "Producto", sku })).success,
        name,
      ).toBe(true);
    }
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

describe("migración 027_products_commission.sql (I1)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "027_products_commission.sql"), "utf8");

  it("agrega commission_value nullable re-ejecutable con CHECK no negativo", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS commission_value numeric(12, 2) NULL");
    expect(sql).toContain("chk_products_commission_value");
    expect(sql).toContain("commission_value IS NULL OR commission_value >= 0");
  });

  it("documenta que la línea de factura manda sobre la sugerencia", () => {
    expect(sql).toContain("Precarga la comisión de la línea");
    expect(sql).toContain("el valor editado en la línea manda");
  });
});

/**
 * CL-6: el MOVIMIENTO MANUAL de inventario reintentado.
 *
 * Estado del doble de Supabase. `vi.hoisted` lo iza junto con los `vi.mock`,
 * que en Vitest se ejecutan antes de los imports estáticos del archivo.
 */
const invStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  OTHER_SEDE_ID: "22222222-2222-4222-8222-222222222222",
  PRODUCT_ID: "33333333-3333-4333-8333-333333333333",
  OTHER_PRODUCT_ID: "44444444-4444-4444-8444-444444444444",
  /** Filas de `products`: el doble les mueve el stock como el trigger real. */
  products: [] as Array<Record<string, unknown>>,
  /** Filas de `inventory_movements` (el kardex que el doble escribe de verdad). */
  movements: [] as Array<Record<string, unknown>>,
  /** Consultas que el doble no sabe responder (debe quedar siempre vacío). */
  unexpectedQueries: [] as string[],
  /** INSERT de movimientos INTENTADOS (sin marca de éxito): no vacuidad. */
  movementInserts: 0,
  /** Choques contra el índice único parcial (prueba de que la carrera corrió). */
  movementClashes: 0,
  /** Emulación del contrato del índice parcial. */
  enforceMarkIndex: true,
  /**
   * Saltea UNA vez el lookup por marca: arma la ventana de la carrera (otra
   * transacción con la MISMA marca se confirmó entre el lookup y el INSERT).
   */
  skipMovementLookupOnce: false,
  /** Fuerza UN 23505 en el INSERT (carrera cuya ganadora ya no está). */
  forceClashOnce: false,
  /** Esconde a la ganadora: sin ella el 23505 no es una repetición. */
  hideWinner: false,
  /**
   * CL-7: ordinal (1-based) de la escritura de movimiento que FALLA, contando
   * INTENTOS. Es la falla "a mitad de camino" del hallazgo: con el bucle, la
   * primera escritura ya había movido el stock cuando cae la segunda.
   */
  failMovementWriteOn: null as number | null,
  /**
   * CL-7: hace que el RPC falle con ese mensaje (`RAISE EXCEPTION` del
   * servidor) SIN escribir nada: es el rechazo de la CARRERA del trigger
   * (INSUFFICIENT_STOCK) y el de la red de seguridad del conteo
   * (PRODUCT_NOT_FOUND).
   */
  failDeductionWith: null as string | null,
  /** Veces que el servicio llamó al RPC de deducción (no vacuidad). */
  deductionCalls: 0,
  nextId: 0,
}));

function resetInventoryStub(): void {
  invStub.products.length = 0;
  invStub.movements.length = 0;
  invStub.unexpectedQueries.length = 0;
  invStub.movementInserts = 0;
  invStub.movementClashes = 0;
  invStub.enforceMarkIndex = true;
  invStub.skipMovementLookupOnce = false;
  invStub.forceClashOnce = false;
  invStub.hideWinner = false;
  invStub.failMovementWriteOn = null;
  invStub.failDeductionWith = null;
  invStub.deductionCalls = 0;
  invStub.nextId = 0;
}

/** Producto de la sede del actor (el stock es el estado que el doble mueve). */
function seedStockProduct(
  id: string = invStub.PRODUCT_ID,
  stock = 10,
  sedeId: string = invStub.SEDE_ID,
): void {
  invStub.products.push({
    id,
    sede_id: sedeId,
    sku: `SKU-${id.slice(0, 4)}`,
    name: "Shampoo",
    description: null,
    stock_qty: stock,
    min_stock: 2,
    cost_price: null,
    sale_price: null,
    commission_value: null,
    is_active: true,
  });
}

function stockOf(id: string = invStub.PRODUCT_ID): number {
  return Number(invStub.products.find((row) => row.id === id)?.stock_qty ?? 0);
}

/**
 * Cliente Supabase falso y encadenable. Responde lo que consulta el camino de
 * `registerMovement` y emula el contrato de 004 en el INSERT, en el MISMO orden
 * que Postgres: el BEFORE ROW trigger del stock (que rechaza el OUT que deja
 * negativo), después el índice único, y recién entonces el AFTER trigger que
 * aplica el stock. Cualquier consulta que no sepa responder vuelve como error y
 * se registra en `unexpectedQueries`, para que el test falle a la vista.
 */
function createInventoryStubClient(): unknown {
  /**
   * CL-7: UNA escritura de movimiento, con el contrato de 004 en el MISMO orden
   * que Postgres: el BEFORE ROW trigger del stock (que rechaza el OUT que deja
   * negativo), después el índice único parcial y recién entonces el AFTER ROW
   * trigger que aplica el stock. La usan el INSERT de la tabla —el camino de
   * `registerMovement`— y el RPC `deduct_stock_atomic`, que es el camino de la
   * deducción multi-producto: así los dos caminos se prueban con las MISMAS
   * barreras y el doble no puede "arreglar" uno de los dos.
   *
   * Devuelve la fila CRUDA (cada llamador decide qué proyectar) o el error.
   */
  const writeMovement = (
    payload: Record<string, unknown>,
  ): { row?: Record<string, unknown>; error?: unknown } => {
    // El contador mide INTENTOS, no éxitos: es lo que permite hacer caer la
    // N-ésima escritura.
    invStub.movementInserts += 1;
    if (invStub.failMovementWriteOn === invStub.movementInserts) {
      return { error: { code: "XX000", message: "fallo de escritura simulado" } };
    }
    const product = invStub.products.find((row) => row.id === payload.product_id);
    const qty = Number(payload.qty);
    // trg_inventory_no_negative (BEFORE INSERT): el OUT nunca deja negativo.
    if (payload.type === "OUT" && Number(product?.stock_qty ?? 0) < qty) {
      return { error: { code: "P0001", message: "INSUFFICIENT_STOCK" } };
    }
    // Índice único PARCIAL (product_id, idempotency_key) WHERE NOT NULL.
    const mark = (payload.idempotency_key ?? null) as string | null;
    if (invStub.forceClashOnce) {
      invStub.forceClashOnce = false;
      invStub.movementClashes += 1;
      return {
        error: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "uq_inventory_movements_product_idempotency_key"',
        },
      };
    }
    if (
      invStub.enforceMarkIndex &&
      mark !== null &&
      invStub.movements.some(
        (row) => row.product_id === payload.product_id && row.idempotency_key === mark,
      )
    ) {
      invStub.movementClashes += 1;
      return {
        error: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "uq_inventory_movements_product_idempotency_key"',
        },
      };
    }
    const row = {
      id: `mov-${(invStub.nextId += 1)}`,
      ...payload,
      idempotency_key: mark,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    invStub.movements.push(row);
    // trg_inventory_apply_stock (AFTER INSERT): IN suma, OUT resta, ADJUST fija.
    if (product) {
      product.stock_qty =
        payload.type === "IN"
          ? Number(product.stock_qty) + qty
          : payload.type === "OUT"
            ? Number(product.stock_qty) - qty
            : qty;
    }
    return { row };
  };

  const from = (table: string) => {
    let op = "select";
    let cols = "";
    let payload: Record<string, unknown> = {};
    const eqFilters: Record<string, unknown> = {};
    let inIds: string[] | null = null;

    /**
     * Proyección de `MOVEMENT_SELECT`: el doble no devuelve más columnas que las
     * que PostgREST devolvería (las del `select` que pidió el servicio).
     */
    const projection = (row: Record<string, unknown>) => {
      const all: Record<string, unknown> = {
        id: row.id,
        sede_id: row.sede_id,
        product_id: row.product_id,
        type: row.type,
        qty: row.qty,
        reason: row.reason,
        user_id: row.user_id,
        created_at: row.created_at,
      };
      const wanted = cols.trim() === "" ? Object.keys(all) : cols.split(",").map((c) => c.trim());
      return Object.fromEntries(wanted.filter((column) => column in all).map((column) => [column, all[column]]));
    };

    const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
      if (op === "insert") {
        if (table === "audit_logs") return { data: null, error: null };
        if (table !== "inventory_movements") {
          invStub.unexpectedQueries.push(`${table}.insert`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.insert` } };
        }
        const written = writeMovement(payload);
        if (written.error) return { data: null, error: written.error };
        return {
          data: projection(written.row as Record<string, unknown>),
          error: null,
        };
      }

      switch (table) {
        case "products": {
          if (eqFilters.id !== undefined) {
            const found = invStub.products.find((row) => row.id === eqFilters.id);
            return { data: found ? { ...found } : null, error: null };
          }
          if (inIds) {
            return {
              data: invStub.products
                .filter((row) => inIds?.includes(row.id as string))
                .map((row) => ({ ...row })),
              error: null,
            };
          }
          // Sonda de columna (commission_value) y listados.
          return { data: invStub.products.map((row) => ({ ...row })), error: null };
        }
        case "inventory_movements": {
          // Lookup por MARCA (el que la 045 hace posible). Se reconoce por su
          // filtro; devuelve la fila que la marca identifica dentro del
          // PRODUCTO, o nada. La ventana de la carrera se arma salteándolo UNA
          // vez, y `hideWinner` lo deja ciego para el caso sin ganadora.
          if (eqFilters.idempotency_key !== undefined) {
            if (invStub.skipMovementLookupOnce) {
              invStub.skipMovementLookupOnce = false;
              return { data: null, error: null };
            }
            if (invStub.hideWinner) return { data: null, error: null };
            const winner = invStub.movements.find(
              (row) =>
                row.product_id === eqFilters.product_id &&
                row.idempotency_key === eqFilters.idempotency_key,
            );
            return { data: winner ? projection(winner) : null, error: null };
          }
          invStub.unexpectedQueries.push(`inventory_movements.${op}`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.${op}` } };
        }
        default:
          invStub.unexpectedQueries.push(`${table}.${op}`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.${op}` } };
      }
    };

    const query: Record<string, unknown> = {
      select: (value?: string) => {
        cols = String(value ?? "");
        return query;
      },
      insert: (value: Record<string, unknown>) => {
        op = "insert";
        payload = value;
        return query;
      },
      eq: (column: string, value: unknown) => {
        eqFilters[column] = value;
        return query;
      },
      in: (_column: string, values: string[]) => {
        inIds = values;
        return query;
      },
      order: () => query,
      limit: () => query,
      single: () => resolve(),
      maybeSingle: () => resolve(),
      // `await` directo sobre la cadena resuelve al objeto de respuesta.
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolve().then(onFulfilled, onRejected),
    };
    return query;
  };

  /**
   * `deduct_stock_atomic` (CL-7, migración 046): el doble emula UNA transacción
   * del servidor. Toma el snapshot del stock y del kardex ANTES de escribir y,
   * si CUALQUIER escritura falla, restaura los dos: no queda nada descontado,
   * igual que el rollback de la sentencia real. Devuelve cuántos movimientos
   * aplicó (el servicio contrasta ese número contra lo que pidió).
   *
   * El doble NO reimplementa las guardas de FORMA del SQL (jsonb válido, un
   * movimiento por producto): esas viven en la función y se prueban sobre el
   * archivo. Lo que emula es lo que este test necesita observar: la
   * indivisibilidad.
   */
  const rpc = async (
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> => {
    if (name !== "deduct_stock_atomic") {
      invStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `stub sin respuesta para el rpc ${name}` } };
    }
    const items = (args?.p_items ?? []) as Array<{ product_id: string; qty: number }>;
    invStub.deductionCalls += 1;
    // El rechazo del servidor: la sentencia entera se revierte, así que no se
    // escribe nada (es la CARRERA del stock y la red de seguridad del conteo).
    if (invStub.failDeductionWith) {
      return { data: null, error: { code: "P0001", message: invStub.failDeductionWith } };
    }
    const stockSnapshot = invStub.products.map((row) => ({ row, stock_qty: row.stock_qty }));
    const movementsSnapshot = invStub.movements.length;
    let applied = 0;
    for (const item of items) {
      const written = writeMovement({
        sede_id: args?.p_sede_id ?? null,
        product_id: item.product_id,
        type: "OUT",
        qty: item.qty,
        reason: args?.p_reason ?? null,
        user_id: args?.p_user_id ?? null,
        // La deducción de FACTURACIÓN no lleva marca (045): su puerta es la
        // marca de la FACTURA (041) y su fila queda FUERA del índice parcial.
        idempotency_key: null,
      });
      if (written.error) {
        // ROLLBACK: el kardex vuelve a su largo previo y el stock a su foto.
        invStub.movements.length = movementsSnapshot;
        for (const entry of stockSnapshot) entry.row.stock_qty = entry.stock_qty;
        return { data: null, error: written.error };
      }
      applied += 1;
    }
    return { data: applied, error: null };
  };

  return { from, rpc };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createInventoryStubClient(),
}));

describe("inventory: el movimiento manual reintentado no mueve el stock dos veces (CL-6)", () => {
  const actor = { userId: "u-caja", sedeId: invStub.SEDE_ID };
  /** Marca del INTENTO: la acuña la pantalla y la conserva el reintento. */
  const MARK = "1e5b7c4a-8d29-4f36-a0b1-c7d3e9f2a5b8";
  /** Otra marca = OTRO intento (control de no-extralimitación). */
  const OTHER_MARK = "c6f2a809-3b14-4e57-92d8-0a4b7c1e6f93";

  const manualMovement = (overrides: Record<string, unknown> = {}) => ({
    product_id: invStub.PRODUCT_ID,
    type: "IN",
    qty: 5,
    reason: "Conteo físico",
    idempotency_key: MARK,
    ...overrides,
  });

  beforeEach(() => {
    resetInventoryStub();
    seedStockProduct();
  });

  it("ROJO/VERDE: el reintento del MISMO movimiento manual escribe UNA vez y mueve el stock UNA vez", async () => {
    const first = await registerMovement(manualMovement(), actor);
    // El reintento: el navegador reenvía el MISMO envío (misma marca).
    const second = await registerMovement(manualMovement(), actor);

    expect(invStub.movements).toHaveLength(1);
    expect(stockOf()).toBe(15);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.stock_qty).toBe(first.stock_qty);
    // No vacuidad: el primer intento SÍ escribió, y el reintento no intentó
    // escribir (lo reconoció el lookup, antes del INSERT).
    expect(invStub.movementInserts).toBe(1);
    expect(invStub.movementClashes).toBe(0);
  });

  it("control de no-extralimitación: otra MARCA es otro intento y escribe de nuevo", async () => {
    await registerMovement(manualMovement(), actor);
    await registerMovement(manualMovement({ idempotency_key: OTHER_MARK }), actor);

    expect(invStub.movements).toHaveLength(2);
    expect(stockOf()).toBe(20);
  });

  it("la marca es OBLIGATORIA en la frontera manual y opcional en la función compartida", () => {
    const sinMarca = { product_id: invStub.PRODUCT_ID, type: "IN", qty: 5, reason: "Conteo" };
    // Compartida: opcional, porque los caminos de facturación no tienen intento propio.
    expect(movementSchema.safeParse(sinMarca).success).toBe(true);
    // Frontera manual: obligatoria (y con la MISMA definición de marca que el dinero).
    expect(manualMovementSchema.safeParse(sinMarca).success).toBe(false);
    expect(manualMovementSchema.safeParse({ ...sinMarca, idempotency_key: MARK }).success).toBe(true);
    expect(
      manualMovementSchema.safeParse({ ...sinMarca, idempotency_key: "no-es-un-uuid" }).success,
    ).toBe(false);
  });

  it("el camino MANUAL (registerManualMovement) es idempotente de punta a punta", async () => {
    const first = await registerManualMovement(manualMovement(), actor);
    const second = await registerManualMovement(manualMovement(), actor);

    expect(invStub.movements).toHaveLength(1);
    expect(stockOf()).toBe(15);
    expect(second).toEqual(first);
    expect(invStub.movementInserts).toBe(1);
  });

  it("sin marca o con marca mal formada la frontera manual rechaza con 400 y CERO escrituras", async () => {
    const sinMarca = await registerManualMovement(
      { product_id: invStub.PRODUCT_ID, type: "IN", qty: 5, reason: "Conteo físico" },
      actor,
    ).then(
      () => "escrito" as const,
      (error: unknown) => error,
    );
    const malFormada = await registerManualMovement(
      manualMovement({ idempotency_key: "no-es-un-uuid" }),
      actor,
    ).then(
      () => "escrito" as const,
      (error: unknown) => error,
    );

    expect(sinMarca).toBeInstanceOf(InventoryError);
    expect(sinMarca).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malFormada).toBeInstanceOf(InventoryError);
    expect(malFormada).toMatchObject({ code: "VALIDATION", status: 400 });
    // El rechazo corre ANTES de cualquier escritura: sin fila y con el stock intacto.
    expect(invStub.movements).toHaveLength(0);
    expect(invStub.movementInserts).toBe(0);
    expect(stockOf()).toBe(10);
    expect(invStub.unexpectedQueries).toEqual([]);
  });

  it("un reintento de OUT se reconoce aunque el stock ya bajó (el lookup corre antes de la aritmética)", async () => {
    const first = await registerManualMovement(manualMovement({ type: "OUT", qty: 10 }), actor);
    expect(stockOf()).toBe(0);

    // Con la aritmética primero, este reintento moriría con INSUFFICIENT_STOCK:
    // el primer intento YA movió el stock. El lookup lo reconoce antes.
    const again = await registerManualMovement(manualMovement({ type: "OUT", qty: 10 }), actor);

    expect(again.movement.id).toBe(first.movement.id);
    expect(stockOf()).toBe(0);
    expect(invStub.movements).toHaveLength(1);
  });

  it("control negativo: manda la MARCA, no el contenido (misma marca con otro tipo, cantidad y motivo)", async () => {
    const first = await registerManualMovement(manualMovement(), actor);
    const second = await registerManualMovement(
      manualMovement({ type: "ADJUST", qty: 99, reason: "Otro motivo" }),
      actor,
    );

    expect(second.movement.id).toBe(first.movement.id);
    expect(second.movement.type).toBe("IN");
    expect(second.movement.qty).toBe(5);
    expect(invStub.movements).toHaveLength(1);
    expect(stockOf()).toBe(15);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) relee a la ganadora y no escribe una segunda fila", async () => {
    const first = await registerManualMovement(manualMovement(), actor);
    // La otra transacción se confirmó entre el lookup y el INSERT de esta: el
    // doble saltea el lookup para armar exactamente esa ventana.
    invStub.skipMovementLookupOnce = true;

    const second = await registerManualMovement(manualMovement(), actor);

    expect(second.movement.id).toBe(first.movement.id);
    expect(second.stock_qty).toBe(15);
    expect(invStub.movements).toHaveLength(1);
    expect(stockOf()).toBe(15);
    // No vacuidad: el INSERT de la segunda SÍ se intentó (dos intentos, una
    // fila) y el choque contra el índice único parcial fue lo que lo cortó.
    expect(invStub.movementInserts).toBe(2);
    expect(invStub.movementClashes).toBe(1);
  });

  it("la carrera SIN ganadora no se disfraza de repetición: INTERNAL, sin filas y sin mover el stock", async () => {
    invStub.forceClashOnce = true;
    invStub.hideWinner = true;

    const outcome = await registerManualMovement(manualMovement(), actor).then(
      () => "escrito" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(InventoryError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(invStub.movements).toHaveLength(0);
    expect(stockOf()).toBe(10);
    expect(invStub.movementClashes).toBe(1);
  });

  it("multi-identidad de la clave (product_id, idempotency_key): la MISMA marca en OTRO producto es OTRA operación", async () => {
    seedStockProduct(invStub.OTHER_PRODUCT_ID, 4);

    const first = await registerManualMovement(manualMovement(), actor);
    const second = await registerManualMovement(
      manualMovement({ product_id: invStub.OTHER_PRODUCT_ID }),
      actor,
    );

    expect(invStub.movements).toHaveLength(2);
    expect(stockOf()).toBe(15);
    expect(stockOf(invStub.OTHER_PRODUCT_ID)).toBe(9);
    // Y repetir el segundo sigue siendo UNA repetición, no una tercera fila.
    const repeat = await registerManualMovement(
      manualMovement({ product_id: invStub.OTHER_PRODUCT_ID }),
      actor,
    );
    expect(repeat.movement.id).toBe(second.movement.id);
    expect(first.movement.id).not.toBe(second.movement.id);
    expect(invStub.movements).toHaveLength(2);
  });

  it("la marca se resuelve dentro de la sede del actor: un producto de otra sede se rechaza con 403 y sin escrituras", async () => {
    const AJENO = "55555555-5555-4555-8555-555555555555";
    seedStockProduct(AJENO, 7, invStub.OTHER_SEDE_ID);

    const outcome = await registerManualMovement(
      manualMovement({ product_id: AJENO }),
      actor,
    ).then(
      () => "escrito" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(InventoryError);
    expect(outcome).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(invStub.movements).toHaveLength(0);
    expect(stockOf(AJENO)).toBe(7);
  });

  it("control de no-extralimitación: el camino de FACTURACIÓN descuenta stock SIN marca (la marca es opcional ahí)", async () => {
    const planned = await deductStock(
      actor,
      [{ product_id: invStub.PRODUCT_ID, qty: 2 }],
      "FACTURA #1",
    );

    expect(planned).toEqual([{ product_id: invStub.PRODUCT_ID, qty: 2 }]);
    expect(invStub.movements).toHaveLength(1);
    expect(invStub.movements[0]).toMatchObject({
      type: "OUT",
      qty: 2,
      reason: "FACTURA #1",
      // Sin marca: la fila queda FUERA del índice parcial de la 045.
      idempotency_key: null,
    });
    expect(stockOf()).toBe(8);
    // El mismo descuento por el camino de facturación vuelve a descontar: esa
    // puerta la cierra la MARCA DE LA FACTURA (041), no una marca que este
    // camino no tiene. Deduplicar por CONTENIDO acá sería el error opuesto.
    await deductStock(actor, [{ product_id: invStub.PRODUCT_ID, qty: 2 }], "FACTURA #1");
    expect(invStub.movements).toHaveLength(2);
    expect(stockOf()).toBe(6);
  });

  it("la frontera MANUAL (server action y ruta REST) llama a registerManualMovement y NO a registerMovement", () => {
    const sources = [
      readFileSync(join(process.cwd(), "src", "features", "inventory", "actions.ts"), "utf8"),
      readFileSync(
        join(process.cwd(), "app", "api", "v1", "inventory", "movements", "route.ts"),
        "utf8",
      ),
    ];

    for (const source of sources) {
      const imported = source.match(
        /import\s*\{([^}]*)\}\s*from\s*"(?:\.\/|@\/src\/features\/inventory\/)service"/,
      );
      expect(imported).not.toBeNull();
      const names = (imported?.[1] ?? "").split(",").map((name) => name.trim());
      expect(names).toContain("registerManualMovement");
      // El camino manual no puede saltar la frontera: si importara la función
      // compartida, un envío sin marca volvería a escribir sin control.
      expect(names).not.toContain("registerMovement");
      expect(source).toMatch(/await registerManualMovement\(/);
    }
  });
});

describe("migración 045_inventory_movement_idempotency.sql (CL-6)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "045_inventory_movement_idempotency.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("agrega la marca nullable y re-ejecutable, con guarda de forma", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key text NULL");
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS inventory_movements_idempotency_key_shape",
    );
    expect(sql).toContain("[0-9a-f]{8}");
    expect(sql).toContain("COMMENT ON COLUMN public.inventory_movements.idempotency_key");
  });

  it("la barrera final es un índice único PARCIAL sobre (product_id, idempotency_key)", () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movements_product_idempotency_key",
    );
    expect(sql).toContain("ON public.inventory_movements (product_id, idempotency_key)");
    expect(sql).toContain("WHERE idempotency_key IS NOT NULL");
  });

  it("no borra ni reescribe filas de datos, y no toca el stock ni los triggers", () => {
    expect(sql).not.toMatch(/^\s*DELETE/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER COLUMN/im);
    expect(sql).not.toMatch(/^\s*CREATE OR REPLACE FUNCTION/im);
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("products.stock_qty =");
  });

  it("justifica la clave del índice contra la alternativa por sede", () => {
    expect(raw).toContain("LA CLAVE DEL ÍNDICE");
    expect(raw).toContain("POR QUÉ NO `(sede_id, idempotency_key)`");
    expect(raw).toContain("el mismo\n-- `eq` set");
  });

  it("declara el costo de numeración, el acoplamiento de despliegue y las ventanas", () => {
    // El costo de NUMERACIÓN de la tabla: ninguno (no hay serie que quemar).
    expect(raw).toContain("AQUÍ NO SE QUEMA NINGÚN NÚMERO");
    expect(raw).toContain("uuid PRIMARY KEY DEFAULT gen_random_uuid()");
    expect(raw).toContain("kardex tampoco es una serie numerada");
    // El costo de numeración del ARCHIVO: 045, el siguiente libre.
    expect(raw).toContain("032 no existe y no existirá");
    expect(raw).toContain("045 va ANTES que este código");
    expect(raw).toContain("VENTANAS DECLARADAS");
    expect(raw).toContain("ORDEN DE LOS STATEMENTS");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

/**
 * Clase CL-7: ESCRITURAS MÚLTIPLES SIN TRANSACCIÓN — el descuento de stock de
 * una venta multi-producto.
 *
 * `deductStock` registraba UN movimiento por producto en un BUCLE sin
 * transacción: cada `registerMovement` es un request distinto contra PostgREST
 * (que no ofrece multi-statement por request) y el trigger del stock escribe al
 * confirmarse cada uno. Un fallo en la MITAD del bucle —una escritura que falla,
 * una conexión que se corta, el trigger que rechaza el tercer producto— dejaba
 * el descuento de los anteriores YA CONFIRMADO: la venta cobrada con el stock a
 * medias y sin ninguna compensación en este camino (`cleanupFailedInvoice` sólo
 * compensa lo que `planned` alcanzó a devolver, y una deducción que falla no
 * devuelve nada).
 *
 * El arreglo es el de la casa (039/040): una FUNCIÓN SQL por `db.rpc(...)`. Una
 * función es UNA sentencia, y una sentencia corre ENTERA dentro de una sola
 * transacción del servidor: o se aplican TODOS los movimientos, o no se aplica
 * ninguno. La deducción deja de ser un bucle de escrituras y pasa a ser una
 * sola escritura: no hay "mitad del camino" donde fallar.
 */
describe("inventory: el descuento multi-producto es todo-o-nada (CL-7)", () => {
  const actor = { userId: "u-caja", sedeId: invStub.SEDE_ID };

  beforeEach(() => {
    resetInventoryStub();
    seedStockProduct();
    seedStockProduct(invStub.OTHER_PRODUCT_ID, 10);
  });

  it("ROJO/VERDE: un fallo a mitad del descuento no deja NADA descontado", async () => {
    // La SEGUNDA escritura falla: con el bucle, la primera ya movió el stock.
    invStub.failMovementWriteOn = 2;

    const outcome = await deductStock(
      actor,
      [
        { product_id: invStub.PRODUCT_ID, qty: 2 },
        { product_id: invStub.OTHER_PRODUCT_ID, qty: 3 },
      ],
      "FACTURA #1",
    ).then(
      () => "descontado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(InventoryError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    // El síntoma, verbatim: hoy la primera mitad quedó descontada (8 en vez de
    // 10) y su movimiento quedó en el kardex. Con una sola transacción no queda
    // NADA: ni stock movido ni fila de kardex.
    expect(stockOf()).toBe(10);
    expect(stockOf(invStub.OTHER_PRODUCT_ID)).toBe(10);
    expect(invStub.movements).toEqual([]);
    // No vacuidad: el intento SÍ recorrió el camino de escritura y la falla cayó
    // DESPUÉS de la primera (dos intentos, no cero).
    expect(invStub.movementInserts).toBe(2);
  });

  it("GREEN: un descuento exitoso descuenta cada producto EXACTAMENTE una vez", async () => {
    const planned = await deductStock(
      actor,
      [
        { product_id: invStub.PRODUCT_ID, qty: 2 },
        // Dos líneas del MISMO producto: el plan las agrega en UN movimiento.
        { product_id: invStub.PRODUCT_ID, qty: 1 },
        { product_id: invStub.OTHER_PRODUCT_ID, qty: 3 },
      ],
      "FACTURA #2",
    );

    expect(planned).toEqual([
      { product_id: invStub.PRODUCT_ID, qty: 3 },
      { product_id: invStub.OTHER_PRODUCT_ID, qty: 3 },
    ]);
    expect(stockOf()).toBe(7);
    expect(stockOf(invStub.OTHER_PRODUCT_ID)).toBe(7);
    // Un producto, un movimiento: la agregación del plan no se duplica al
    // escribir, y ningún producto queda descontado dos veces.
    expect(invStub.movements).toHaveLength(2);
    expect(
      invStub.movements.filter((row) => row.product_id === invStub.PRODUCT_ID),
    ).toHaveLength(1);
    expect(invStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: el descuento SÍ escribe (no es un no-op silencioso) y sin marca de intento", async () => {
    // Si la deducción no escribiera nada, el "nada descontado" del fallo se
    // cumpliría por VACUIDAD. Este test pincha que escribe de verdad.
    await deductStock(actor, [{ product_id: invStub.PRODUCT_ID, qty: 2 }], "FACTURA #3");

    expect(invStub.movementInserts).toBe(1);
    expect(stockOf()).toBe(8);
    expect(invStub.movements[0]).toMatchObject({
      product_id: invStub.PRODUCT_ID,
      sede_id: invStub.SEDE_ID,
      type: "OUT",
      qty: 2,
      reason: "FACTURA #3",
      user_id: "u-caja",
      // La deducción NO lleva marca (045): su puerta es la marca de la FACTURA.
      idempotency_key: null,
    });
  });

  it("control de no-extralimitación: una venta sin productos no escribe nada", async () => {
    const planned = await deductStock(
      actor,
      [{ product_id: null, qty: 4 }],
      "FACTURA #4",
    );

    expect(planned).toEqual([]);
    expect(invStub.movementInserts).toBe(0);
    expect(invStub.movements).toEqual([]);
    expect(stockOf()).toBe(10);
  });

  it("la CARRERA del stock llega como 409 y sin ningún movimiento escrito", async () => {
    // El plan validó contra la lectura y el trigger rechaza igual: el stock
    // cambió en el medio. El rechazo llega por la transacción del servidor, así
    // que NADA quedó descontado —el mismo 409 de negocio que antes traducía el
    // trigger, no un INTERNAL—.
    invStub.failDeductionWith = "INSUFFICIENT_STOCK";

    const outcome = await deductStock(
      actor,
      [
        { product_id: invStub.PRODUCT_ID, qty: 2 },
        { product_id: invStub.OTHER_PRODUCT_ID, qty: 3 },
      ],
      "FACTURA #5",
    ).then(
      () => "descontado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(InventoryError);
    expect(outcome).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
    expect(invStub.movements).toEqual([]);
    expect(stockOf()).toBe(10);
    expect(stockOf(invStub.OTHER_PRODUCT_ID)).toBe(10);
    // No vacuidad: el RPC SÍ se llamó y su error se tradujo.
    expect(invStub.deductionCalls).toBe(1);
  });

  it("la red de seguridad del conteo llega como 404 y sin ningún movimiento escrito", async () => {
    // El `JOIN` por sede de la función escribe menos filas si un producto no es
    // de la sede pedida: la red de seguridad aborta y revierte todo.
    invStub.failDeductionWith = "PRODUCT_NOT_FOUND";

    const outcome = await deductStock(
      actor,
      [{ product_id: invStub.PRODUCT_ID, qty: 2 }],
      "FACTURA #6",
    ).then(
      () => "descontado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(InventoryError);
    expect(outcome).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(invStub.movements).toEqual([]);
    expect(stockOf()).toBe(10);
    expect(invStub.deductionCalls).toBe(1);
  });
});

describe("migración 046_stock_deduction_atomicity.sql (CL-7)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "046_stock_deduction_atomicity.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("la deducción entera vive en UNA función: una sentencia, una transacción", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.deduct_stock_atomic");
    expect(sql).toContain("INSERT INTO public.inventory_movements");
    expect(sql).toContain("jsonb_array_elements(p_items)");
    // Orden determinista del lock por producto (el BEFORE ROW trigger de 004
    // toma FOR UPDATE por fila): sin él, dos deducciones con productos
    // solapados en orden distinto se bloquean mutuamente.
    expect(sql).toContain("ORDER BY p.id");
  });

  it("escribe la marca en NULL: la fila de facturación queda FUERA del índice de 045", () => {
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO public.inventory_movements"),
      sql.indexOf("GET DIAGNOSTICS"),
    );
    expect(insertBlock).toContain("idempotency_key");
    expect(insertBlock).toMatch(/idempotency_key\)[\s\S]*\bNULL\b/);
  });

  it("exige UN movimiento por producto y una red de seguridad que revierte todo", () => {
    expect(sql).toContain("count(DISTINCT");
    expect(sql).toContain("GET DIAGNOSTICS");
    expect(sql).toContain("RAISE EXCEPTION");
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.deduct_stock_atomic");
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.deduct_stock_atomic");
    expect(sql).toContain("TO service_role");
  });

  it("no borra ni reescribe datos, y no toca el stock, los triggers ni la aritmética", () => {
    expect(sql).not.toMatch(/^\s*DELETE/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("products.stock_qty =");
    expect(sql).not.toContain("inventory_apply_stock()");
    expect(sql).not.toContain("inventory_no_negative_stock()");
  });

  it("declara el costo de numeración, el acoplamiento de despliegue y las ventanas", () => {
    expect(raw).toContain("032 no existe y no existirá");
    expect(raw).toContain("046");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos");
    expect(raw).toContain("VENTANAS DECLARADAS");
  });
});

/* ==========================================================================
   Inventario: botón de ayuda del SKU (guarda de fuente)

   El botón es de UI y este paquete corre sin DOM (`environment: "node"`), así
   que la guarda afirma el criterio sobre el TEXTO del cliente real —el mismo
   estilo mixto que el resto de `tests/`—: existe, es `type="button"` (no
   envía el formulario), tiene nombre accesible y `title`, y está cableado al
   helper puro contra los SKU ya cargados.
   ========================================================================== */
describe("inventory: botón de ayuda del SKU (guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "inventory", "inventory-client.tsx"),
    "utf8",
  );

  /** El bloque del botón: desde su `<Button` hasta el `</Button>`, anclado por el id. */
  function proposalButtonBlock(text: string): string {
    const anchor = text.indexOf('id="product-sku-propose"');
    if (anchor === -1) return "";
    const start = text.lastIndexOf("<Button", anchor);
    const end = text.indexOf("</Button>", anchor);
    return start === -1 || end === -1 ? "" : text.slice(start, end + "</Button>".length);
  }

  /** El cuerpo del handler de la propuesta (hasta su `}` de cierre a 2 espacios). */
  function handlerBody(text: string, name: string): string {
    const start = text.indexOf(`function ${name}`);
    if (start === -1) return "";
    const end = text.indexOf("\n  }", start);
    return end === -1 ? "" : text.slice(start, end);
  }

  it("existe, es type=\"button\" y tiene nombre accesible y title", () => {
    const block = proposalButtonBlock(source);
    expect(block, "bloque del botón del SKU").not.toBe("");
    expect(block).toContain('type="button"');
    expect(block).not.toContain('type="submit"');
    expect(block).toMatch(/aria-label="[^"]*SKU[^"]*"/);
    expect(block).toMatch(/title="[^"]+"/);
  });

  it("se importa el helper y el handler propone contra los SKU cargados", () => {
    expect(source).toMatch(
      /import \{ proposeSku \} from "@\/src\/features\/inventory\/schemas"/,
    );
    const block = proposalButtonBlock(source);
    expect(block).toContain("onClick={proposeSkuFromName}");

    const body = handlerBody(source, "proposeSkuFromName");
    expect(body, "handler proposeSkuFromName").not.toBe("");
    expect(body).toContain("proposeSku(");
    // Misma regla que el aviso `skuTaken`: el propio producto en edición queda
    // fuera, así que después de generar el aviso lee limpio.
    expect(body).toContain("row.id !== editingId");
    expect(body).toContain("row.sku");
    expect(body).toContain("setForm(");
  });

  it("no rellena el campo al abrir el diálogo (control negativo)", () => {
    // La propuesta vive en su handler: abrir el alta no la invoca.
    const body = handlerBody(source, "startProductDialog");
    expect(body, "handler startProductDialog").not.toBe("");
    expect(body).not.toContain("proposeSku");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake =
      '<Button type="submit" id="product-sku-propose" onClick={proposeSkuFromName}>Generar</Button>';
    const block = proposalButtonBlock(fake);
    expect(block).not.toBe("");
    expect(block).not.toContain('type="button"');
    // Sin el ancla no hay bloque: la guarda falla en vez de pasar sola.
    expect(proposalButtonBlock('<Button type="button">Generar</Button>')).toBe("");
  });
});
