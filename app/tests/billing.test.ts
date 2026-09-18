import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  annulBlockedMessage,
  annulInvoiceSchema,
  applyPaymentSplit,
  buildInvoiceOutReason,
  buildReversalReasons,
  canAnnulStatus,
  computeInvoiceTotals,
  computeLineSubtotal,
  createInvoiceSchema,
  moneyEquals,
  nextConsecutiveNumbers,
  portionsMatchBalance,
  roundMoney,
  snapshotInvoiceTaxes,
  splitPaymentSchema,
  invoiceItemSchema,
} from "@/src/features/billing/schemas";

const EMPLOYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function productItem(overrides: Record<string, unknown> = {}) {
  return {
    item_type: "producto",
    product_id: PRODUCT_ID,
    employee_id: EMPLOYEE_ID,
    qty: 2,
    unit_price: 35000,
    discount: 0,
    ...overrides,
  };
}

// ------------------------------------------------- FAC-01: un solo origen ---

describe("billing schemas: línea con un solo origen (FAC-01)", () => {
  it("acepta producto con product_id, servicio con service_id y custom con nombre", () => {
    expect(invoiceItemSchema.safeParse(productItem()).success).toBe(true);
    expect(
      invoiceItemSchema.safeParse({
        item_type: "servicio",
        service_id: SERVICE_ID,
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 50000,
        discount: 0,
      }).success,
    ).toBe(true);
    expect(
      invoiceItemSchema.safeParse({
        item_type: "custom",
        custom_name: "Peinado novia",
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 80000,
        discount: 0,
      }).success,
    ).toBe(true);
  });

  it("producto exige product_id y rechaza mezcla de orígenes", () => {
    expect(invoiceItemSchema.safeParse(productItem({ product_id: null })).success).toBe(false);
    expect(invoiceItemSchema.safeParse(productItem({ service_id: SERVICE_ID })).success).toBe(false);
    expect(invoiceItemSchema.safeParse(productItem({ custom_name: "Extra" })).success).toBe(false);
  });

  it("servicio exige service_id y custom exige custom_name con valor", () => {
    const servicio = {
      item_type: "servicio",
      employee_id: EMPLOYEE_ID,
      qty: 1,
      unit_price: 50000,
      discount: 0,
    };
    expect(invoiceItemSchema.safeParse(servicio).success).toBe(false);
    expect(
      invoiceItemSchema.safeParse({
        item_type: "custom",
        custom_name: "   ",
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 10000,
        discount: 0,
      }).success,
    ).toBe(false);
  });

  it("rechaza qty <= 0, precio negativo y descuento mayor al bruto", () => {
    expect(invoiceItemSchema.safeParse(productItem({ qty: 0 })).success).toBe(false);
    expect(invoiceItemSchema.safeParse(productItem({ qty: -1 })).success).toBe(false);
    expect(invoiceItemSchema.safeParse(productItem({ unit_price: -5 })).success).toBe(false);
    expect(
      invoiceItemSchema.safeParse(productItem({ qty: 1, unit_price: 10000, discount: 10001 }))
        .success,
    ).toBe(false);
  });

  it("employee_id siempre requerido (FAC-02, base de comisiones T7)", () => {
    const { employee_id: _omitted, ...rest } = productItem();
    void _omitted;
    expect(invoiceItemSchema.safeParse(rest).success).toBe(false);
  });
});

describe("billing schemas: factura exige cliente e ítems", () => {
  it("rechaza sin cliente o sin ítems", () => {
    expect(
      createInvoiceSchema.safeParse({ client_name: "  ", items: [productItem()] }).success,
    ).toBe(false);
    expect(createInvoiceSchema.safeParse({ client_name: "Ana", items: [] }).success).toBe(false);
  });

  it("client_document es opcional y el descuento arranca en 0", () => {
    const parsed = createInvoiceSchema.safeParse({ client_name: "Ana", items: [productItem()] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.client_document ?? null).toBe(null);
      expect(parsed.data.discount).toBe(0);
      expect(parsed.data.payments).toEqual([]);
    }
  });
});

// ------------------------------------------------- totales e impuestos ---

describe("billing: subtotal por línea (FAC-01)", () => {
  it("qty × precio − descuento de línea", () => {
    expect(computeLineSubtotal({ qty: 2, unit_price: 35000, discount: 5000 })).toEqual({
      gross: 70000,
      discount: 5000,
      subtotal: 65000,
    });
  });

  it("redondea a 2 decimales", () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(moneyEquals(10.004, 10.0)).toBe(true);
    expect(moneyEquals(10.02, 10.0)).toBe(false);
  });
});

describe("billing: snapshot de impuestos con solo activos (FAC-03)", () => {
  it("calcula cada activo sobre (subtotal − descuento) e ignora inactivos", () => {
    const taxes = snapshotInvoiceTaxes(
      [{ code: "IVA", name: "IVA general", percent: 19 }],
      100000,
    );
    expect(taxes).toEqual([
      { tax_code: "IVA", tax_name: "IVA general", percent: 19, amount: 19000 },
    ]);
  });

  it("sin activos no hay snapshot (inactivo suma 0)", () => {
    expect(snapshotInvoiceTaxes([], 100000)).toEqual([]);
    expect(
      snapshotInvoiceTaxes([{ code: "IVA", name: "IVA", percent: 0 }], 100000),
    ).toEqual([{ tax_code: "IVA", tax_name: "IVA", percent: 0, amount: 0 }]);
  });
});

describe("billing: total con 3 tipos de ítem, descuento e impuestos (FAC-01/03)", () => {
  const items = [
    { qty: 2, unit_price: 35000, discount: 0 }, // producto 70000
    { qty: 1, unit_price: 50000, discount: 5000 }, // servicio 45000
    { qty: 1, unit_price: 20000, discount: 0 }, // custom 20000
  ];

  it("total = subtotal − descuento + impuestos", () => {
    const totals = computeInvoiceTotals({
      items,
      discount: 5000,
      activeTaxes: [{ code: "IVA", name: "IVA general", percent: 19 }],
    });
    expect(totals.subtotal).toBe(135000);
    expect(totals.discount).toBe(5000);
    expect(totals.base).toBe(130000);
    expect(totals.tax).toBe(24700);
    expect(totals.total).toBe(154700);
  });

  it("sin impuestos activos el total no lleva cargos", () => {
    const totals = computeInvoiceTotals({ items, discount: 0, activeTaxes: [] });
    expect(totals.total).toBe(135000);
  });

  it("descuento mayor al subtotal se rechaza (DESCUENTO_EXCEDE)", () => {
    expect(() =>
      computeInvoiceTotals({ items, discount: 135001, activeTaxes: [] }),
    ).toThrowError("DESCUENTO_EXCEDE");
  });
});

// ------------------------------------------------- cobro dividido (FAC-07) ---

describe("billing: porciones que cuadran con el total (FAC-07)", () => {
  it("porciones exactas marcan pago completo", () => {
    const check = applyPaymentSplit({
      paidSoFar: 0,
      portions: [{ amount: 60000 }, { amount: 40000 }],
      total: 100000,
    });
    expect(check).toEqual({ paid: 100000, remaining: 0, fullyPaid: true });
    expect(portionsMatchBalance([{ amount: 60000 }, { amount: 40000 }], 100000)).toBe(true);
  });

  it("pago incremental deja saldo pendiente sin marcar completo", () => {
    const check = applyPaymentSplit({
      paidSoFar: 0,
      portions: [{ amount: 60000 }],
      total: 100000,
    });
    expect(check).toEqual({ paid: 60000, remaining: 40000, fullyPaid: false });
    expect(portionsMatchBalance([{ amount: 60000 }], 100000)).toBe(false);
  });

  it("sobrepago se rechaza (SOBREPAGO)", () => {
    expect(() =>
      applyPaymentSplit({ paidSoFar: 60000, portions: [{ amount: 50000 }], total: 100000 }),
    ).toThrowError("SOBREPAGO");
    expect(() =>
      applyPaymentSplit({ paidSoFar: 0, portions: [{ amount: 100001 }], total: 100000 }),
    ).toThrowError("SOBREPAGO");
  });

  it("split exige al menos una porción y montos > 0", () => {
    expect(splitPaymentSchema.safeParse({ portions: [] }).success).toBe(false);
    expect(
      splitPaymentSchema.safeParse({ portions: [{ method_code: "nequi", amount: 0 }] }).success,
    ).toBe(false);
    expect(
      splitPaymentSchema.safeParse({ portions: [{ method_code: "  ", amount: 1000 }] }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------- anulación (FAC-04) ---

describe("billing: anulación solo Emitida/Pagada con motivo (FAC-04)", () => {
  it("Emitida y Pagada admiten anulación; Anulada es terminal", () => {
    expect(canAnnulStatus("Emitida")).toBe(true);
    expect(canAnnulStatus("Pagada")).toBe(true);
    expect(canAnnulStatus("Anulada")).toBe(false);
    expect(canAnnulStatus("Borrador")).toBe(false);
  });

  it("mensaje claro cuando ya está anulada", () => {
    expect(annulBlockedMessage("Anulada")).toContain("ya está anulada");
  });

  it("motivo obligatorio y no vacío", () => {
    expect(annulInvoiceSchema.safeParse({ motivo: "Cobro duplicado" }).success).toBe(true);
    expect(annulInvoiceSchema.safeParse({ motivo: "   " }).success).toBe(false);
    expect(annulInvoiceSchema.safeParse({}).success).toBe(false);
  });
});

describe("billing: reversión de stock al anular (FAC-06)", () => {
  it("genera un IN por cada ítem producto con motivo auditable", () => {
    const reversals = buildReversalReasons({
      consecutiveNumber: 7,
      motivo: "Cobro duplicado",
      productItems: [
        { product_id: PRODUCT_ID, qty: 2 },
        { product_id: SERVICE_ID, qty: 1 },
      ],
    });
    expect(reversals).toHaveLength(2);
    expect(reversals[0]).toEqual({
      product_id: PRODUCT_ID,
      qty: 2,
      reason: "Reversión factura #7 — Cobro duplicado",
    });
  });

  it("sin productos no hay reversiones; el OUT lleva el consecutivo", () => {
    expect(
      buildReversalReasons({ consecutiveNumber: 7, motivo: "Error", productItems: [] }),
    ).toEqual([]);
    expect(buildInvoiceOutReason(7, "Ana Ruiz")).toBe("FACTURA #7 — Ana Ruiz");
  });
});

// ------------------------------------------------- consecutivo (FAC-05) ---

describe("billing: consecutivo sin huecos bajo concurrencia (FAC-05)", () => {
  it("reserva series únicas y continuas", () => {
    expect(nextConsecutiveNumbers(0, 3)).toEqual([1, 2, 3]);
    expect(nextConsecutiveNumbers(41, 2)).toEqual([42, 43]);
    expect(() => nextConsecutiveNumbers(0, 0)).toThrowError("CONTEO_INVALIDO");
  });

  it("10 reservas concurrentes bajo lock producen 1..10 sin huecos", async () => {
    // Simula a nivel servicio lo que next_invoice_number() garantiza en BD
    // con SELECT … FOR UPDATE: reservas serializadas, serie continua.
    // En producción la serialización la hace el lock de fila por sede
    // (ver migración 005); aquí el mutex emula ese lock.
    let last = 0;
    let lock: Promise<void> = Promise.resolve();
    const reserve = (): Promise<number> => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      return previous.then(() => {
        const [next] = nextConsecutiveNumbers(last, 1);
        last = next;
        release();
        return next;
      });
    };
    const numbers = await Promise.all(Array.from({ length: 10 }, () => reserve()));
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(10);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ------------------------------------------------- migración 005 ---

describe("migración 005_billing.sql (T5)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "005_billing.sql"), "utf8");

  it("crea secuencias, facturas, ítems, impuestos y porciones", () => {
    expect(sql).toContain("CREATE TABLE public.invoice_sequences");
    expect(sql).toContain("CREATE TABLE public.invoices");
    expect(sql).toContain("CREATE TABLE public.invoice_items");
    expect(sql).toContain("CREATE TABLE public.invoice_taxes");
    expect(sql).toContain("CREATE TABLE public.invoice_payments");
  });

  it("consecutivo por sede único con función de reserva bajo lock", () => {
    expect(sql).toContain("UNIQUE (sede_id, consecutive_number)");
    expect(sql).toContain("next_invoice_number");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("CHECK (consecutive_number > 0)");
  });

  it("un solo origen por línea y empleado obligatorio", () => {
    expect(sql).toContain("CHECK (item_type IN ('producto', 'servicio', 'custom'))");
    expect(sql).toContain("employee_id uuid NOT NULL");
    expect(sql).toContain("CHECK (qty > 0)");
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("estados Emitida/Pagada/Anulada con motivo obligatorio al anular", () => {
    expect(sql).toContain("CHECK (status IN ('Emitida', 'Pagada', 'Anulada'))");
    expect(sql).toContain("cancel_reason");
  });

  it("montos >= 0 con tolerancia de redondeo y cash_shift_id forward-ref T6", () => {
    expect(sql).toContain("CHECK (subtotal >= 0)");
    expect(sql).toContain("cash_shift_id uuid NULL");
    expect(sql).not.toContain("REFERENCES public.cash_shifts");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY pol_invoices_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_invoice_items_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_invoice_taxes_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_invoice_payments_sede_isolation");
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("documenta FAC-01…07 y que es factura interna sin DIAN", () => {
    expect(sql).toContain("FAC-05");
    expect(sql).toContain("SIN DIAN");
  });
});
