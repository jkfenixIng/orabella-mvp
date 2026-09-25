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
  computeCardFees,
  computeInvoiceTotals,
  computeLineSubtotal,
  createInvoiceSchema,
  diffInvoiceItems,
  assertEditReconciles,
  editEmittedInvoiceSchema,
  editInvoiceSchema,
  type EditInvoiceItemInput,
  moneyEquals,
  nextConsecutiveNumbers,
  portionsMatchBalance,
  roundMoney,
  snapshotInvoiceTaxes,
  splitPaymentSchema,
  invoiceItemSchema,
} from "@/src/features/billing/schemas";
import { computeInvoiceItemCommission } from "@/src/features/billing/commission";
import {
  commissionRuleKey,
  resolveEmployeeLineCommission,
  type RuleRate,
} from "@/src/features/commissions/schemas";
import { buildEmployeeCommissionDetail } from "@/src/features/payroll/schemas";

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
        no_commission: true,
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

describe("billing schemas: factura exige ítems (cliente opcional)", () => {
  it("rechaza sin ítems; cliente vacío es válido (opcional)", () => {
    expect(
      createInvoiceSchema.safeParse({ client_name: "  ", items: [productItem()] }).success,
    ).toBe(true);
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

// ------------------------------------------------- recargo tarjeta (019) ---

describe("billing: recargo por método sobre el neto (tarjeta 5%)", () => {
  const feeByMethod = (code: string): number => (code === "tarjeta" ? 5 : 0);

  it("tarjeta 100000 genera fee 5000 y bruto 105000", () => {
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 100000 }], feeByMethod);
    expect(fee).toEqual({ method_code: "tarjeta", net: 100000, feePercent: 5, fee: 5000, gross: 105000 });
  });

  it("efectivo no genera recargo", () => {
    const [fee] = computeCardFees([{ amount: 50000, method_code: "efectivo" }], feeByMethod);
    expect(fee.fee).toBe(0);
    expect(fee.gross).toBe(50000);
  });

  it("el total incluye el recargo y las porciones netas cuadran el neto", () => {
    const totals = computeInvoiceTotals({
      items: [{ qty: 2, unit_price: 50000, discount: 0 }],
      discount: 0,
      activeTaxes: [],
      surcharge: 5000,
    });
    expect(totals.surcharge).toBe(5000);
    expect(totals.total).toBe(105000);
    expect(portionsMatchBalance([{ amount: 100000 }], totals.total - totals.surcharge)).toBe(true);
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

describe("billing: frontera modular con inventario (B1)", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  );

  it("descuenta al emitir vía la frontera de inventory/service", () => {
    expect(service).toContain("deductStock");
    expect(service).toContain("planStockDeduction");
    expect(service).toContain("getProductsStock");
  });

  it("billing no toca tablas de inventory directo (products, inventory_movements)", () => {
    expect(service).not.toContain('from("products")');
    expect(service).not.toContain("from('products')");
    expect(service).not.toContain('from("inventory_movements")');
    expect(service).not.toContain("from('inventory_movements')");
  });

  it("pagar no descuenta: splitPayment no registra movimientos (momento único al emitir)", () => {
    const splitBody = service.slice(service.indexOf("export async function splitPayment"));
    expect(splitBody).not.toContain("deductStock");
    expect(splitBody).not.toContain("registerMovement");
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

// ------------------------------------------------- edición admin ---

describe("billing: edición con total inmutable y motivo (admin)", () => {
  const OLD: EditInvoiceItemInput & { id: string } = {
    id: "item-9",
    item_type: "servicio",
    product_id: null,
    service_id: SERVICE_ID,
    custom_name: null,
    employee_id: EMPLOYEE_ID,
    qty: 1,
    unit_price: 120000,
    discount: 0,
    no_commission: false,
    commission_value: null,
  };

  it("detecta agregadas, eliminadas, cambiadas y si toca pago", () => {
    const next = { ...OLD };
    const added = {
      item_type: "custom" as const,
      product_id: null,
      service_id: null,
      custom_name: "Kit",
      employee_id: EMPLOYEE_ID,
      qty: 1,
      unit_price: 6000,
      discount: 0,
      no_commission: false,
      commission_value: 6000,
    };
    const diff = diffInvoiceItems([OLD], [next, added]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.payTouched).toBe(true);
  });

  it("sin cambios no toca pago", () => {
    const diff = diffInvoiceItems([OLD], [{ ...OLD }]);
    expect(diff.payTouched).toBe(false);
    expect(diff.changed).toHaveLength(0);
  });

  it("cambio de empleado marca payTouched y eliminada también", () => {
    const other = { ...OLD, id: "item-8", employee_id: "otro-id" };
    const diff = diffInvoiceItems([OLD, other], [{ ...OLD }]);
    expect(diff.removed.map((row) => row.id)).toEqual(["item-8"]);
    expect(diff.payTouched).toBe(true);
  });

  it("reconcilia solo si subtotal y recargo cuadran", () => {
    expect(() =>
      assertEditReconciles({ oldSubtotal: 120000, newSubtotal: 120000, oldSurcharge: 0, newSurcharge: 0, oldTotal: 120000 }),
    ).not.toThrow();
    expect(() =>
      assertEditReconciles({ oldSubtotal: 120000, newSubtotal: 114000, oldSurcharge: 0, newSurcharge: 0, oldTotal: 120000 }),
    ).toThrowError("TOTAL_MISMATCH");
    expect(() =>
      assertEditReconciles({ oldSubtotal: 120000, newSubtotal: 120000, oldSurcharge: 0, newSurcharge: 500, oldTotal: 120000 }),
    ).toThrowError("TOTAL_MISMATCH");
  });

  it("el schema exige motivo e ids de cobro existentes", () => {
    expect(editInvoiceSchema.safeParse({ motivo: "  ", items: [OLD], payments: [] }).success).toBe(false);
    expect(
      editInvoiceSchema.safeParse({
        motivo: "Precio mal digitado",
        items: [{ ...OLD, id: "item-9" }],
        payments: [{ id: "no-uuid", method_code: "efectivo" }],
      }).success,
    ).toBe(false);
  });
});

describe("billing: edición libre de emitida sin motivo (cajera del turno)", () => {
  const OLD: EditInvoiceItemInput & { id: string } = {
    id: "99999999-9999-4999-8999-999999999999",
    item_type: "servicio",
    product_id: null,
    service_id: SERVICE_ID,
    custom_name: null,
    employee_id: EMPLOYEE_ID,
    qty: 1,
    unit_price: 120000,
    discount: 0,
    no_commission: false,
    commission_value: null,
  };

  it("acepta sin motivo (el total se recalcula en el servidor)", () => {
    expect(editEmittedInvoiceSchema.safeParse({ items: [OLD], payments: [] }).success).toBe(true);
    expect(
      editEmittedInvoiceSchema.safeParse({ motivo: null, items: [OLD], payments: [] }).success,
    ).toBe(true);
  });

  it("acepta motivo opcional de override ligero y exige al menos un ítem", () => {
    expect(
      editEmittedInvoiceSchema.safeParse({ motivo: "Ajuste admin", items: [OLD], payments: [] }).success,
    ).toBe(true);
    expect(editEmittedInvoiceSchema.safeParse({ payments: [] }).success).toBe(false);
    expect(editEmittedInvoiceSchema.safeParse({ items: [], payments: [] }).success).toBe(false);
  });

  it("rechaza motivo demasiado largo", () => {
    expect(
      editEmittedInvoiceSchema.safeParse({ motivo: "x".repeat(501), items: [OLD], payments: [] }).success,
    ).toBe(false);
  });
});

// ------------------------------------- comisión por línea en el detalle ---

const NO_RULES = new Map<string, RuleRate>();

/** Regla de producto para el empleado de prueba. */
function productRule(percent: number | null, amount: number | null): Map<string, RuleRate> {
  return new Map([[commissionRuleKey("producto", PRODUCT_ID), { percent, amount }]]);
}

describe("billing: comisión calculada por línea (misma regla que nómina)", () => {
  const porcentaje = {
    payoutMode: "normal",
    payType: "porcentaje",
    commissionPercent: 10,
  };

  it("producto con commission_value usa el valor del ítem, no el % del empleado", () => {
    // Caso del bug: producto con comisión 1000 vendido por un empleado de 35%.
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 42000,
        qty: 1,
        commissionValue: 1000,
        noCommission: false,
        rules: NO_RULES,
        employee: { payoutMode: "normal", payType: "porcentaje", commissionPercent: 35 },
      }),
    ).toBe(1000);
  });

  it("producto sin comisión no cae al % del empleado: 0", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: NO_RULES,
        employee: porcentaje,
      }),
    ).toBe(0);
  });

  it("producto vendido por empleado de pago fijo: comisiona el valor del ítem", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 42000,
        qty: 1,
        commissionValue: 1000,
        noCommission: false,
        rules: NO_RULES,
        employee: { payoutMode: "normal", payType: "fijo", commissionPercent: null },
      }),
    ).toBe(1000);
  });

  it("servicio con pay_type porcentaje: subtotal × porcentaje / 100", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: NO_RULES,
        employee: porcentaje,
      }),
    ).toBe(10000);
  });

  it("pay_type fijo sin reglas no genera comisión", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: NO_RULES,
        employee: { payoutMode: "normal", payType: "fijo", commissionPercent: 10 },
      }),
    ).toBe(0);
  });

  it("pay_type fijo CON regla ítem×empleado sí comisiona (el caso que estaba mal)", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: productRule(5, null),
        employee: { payoutMode: "normal", payType: "fijo", commissionPercent: null },
      }),
    ).toBe(5000);
  });

  it("la regla ítem×empleado gana al porcentaje plano", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: productRule(7, null),
        employee: porcentaje,
      }),
    ).toBe(7000);
  });

  it("regla con monto fijo por unidad respeta la cantidad", () => {
    const rules = productRule(null, 1500);
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 80000,
        qty: 4,
        commissionValue: null,
        noCommission: false,
        rules,
        employee: porcentaje,
      }),
    ).toBe(6000);
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 20000,
        qty: 1,
        commissionValue: null,
        noCommission: false,
        rules,
        employee: porcentaje,
      }),
    ).toBe(1500);
  });

  it("payout_mode no_aplica no genera comisión", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: NO_RULES,
        employee: { ...porcentaje, payoutMode: "no_aplica" },
      }),
    ).toBe(0);
  });

  it("ítem custom con commission_value usa el valor fijo (ignora el porcentaje)", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 5000,
        noCommission: false,
        rules: NO_RULES,
        employee: porcentaje,
      }),
    ).toBe(5000);
  });

  it("ítem custom con commission_value 0 cae al porcentaje del empleado (paridad con nómina)", () => {
    // Nómina normaliza con chequeo de veracidad: un 0 no es valor fijo.
    expect(
      computeInvoiceItemCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 0,
        noCommission: false,
        rules: NO_RULES,
        employee: porcentaje,
      }),
    ).toBe(10000);
  });

  it("no_commission da 0", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: true,
        rules: productRule(50, null),
        employee: porcentaje,
      }),
    ).toBe(0);
  });

  it("sin datos de empleado no es calculable (null)", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: NO_RULES,
        employee: null,
      }),
    ).toBe(null);
  });
});

// ------------------------- paridad: detalle === resolución compartida/nómina ---

describe("billing: paridad del detalle con la resolución compartida y la nómina", () => {
  /**
   * Comisión que la nómina produce para una línea (0 si la descarta). Reproduce
   * el input tal como lo arma calculatePayroll: normaliza `commission_value`
   * con chequeo de veracidad antes de llamar a la resolución compartida.
   */
  function payrollLineCommission(args: {
    itemType: string;
    itemRefId: string | null;
    subtotal: number;
    qty: number;
    commissionValue: number | null;
    payType: string;
    commissionPercent: number | null;
    payoutMode?: string | null;
    rules: Map<string, RuleRate>;
  }): number {
    const detail = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: args.payoutMode ?? "normal",
      payType: args.payType,
      commissionPercent: args.commissionPercent,
      lines: [
        {
          invoice_id: "inv-1",
          consecutive_number: 1,
          item_id: "line-1",
          item_type: args.itemType,
          qty: args.qty,
          unit_price: args.qty > 0 ? args.subtotal / args.qty : 0,
          line_subtotal: args.subtotal,
          commission_value: args.commissionValue ? Number(args.commissionValue) : null,
          item_ref_id: args.itemRefId,
        },
      ],
      rules: args.rules,
    });
    return detail.reduce((acc, line) => acc + line.commission, 0);
  }

  it("mismo input: detalle === resolución compartida (resolveEmployeeLineCommission)", () => {
    const rules = new Map([[commissionRuleKey("servicio", SERVICE_ID), { percent: 12, amount: 500 }]]);
    const flatPercent = 10;
    const input = {
      itemType: "servicio",
      itemRefId: SERVICE_ID,
      subtotal: 100000,
      qty: 2,
      commissionValue: null,
      noCommission: false,
      rules,
      employee: { payoutMode: "normal", payType: "porcentaje", commissionPercent: flatPercent },
    };
    expect(computeInvoiceItemCommission(input)).toBe(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        rules,
        flatPercent,
      }),
    );
    // Regla: 100000×12% + 500×2 = 13000.
    expect(computeInvoiceItemCommission(input)).toBe(13000);
  });

  it("mismo input: detalle === comisión de nómina (fijo + regla, porcentaje, mixto)", () => {
    const rules = productRule(7, 1500);
    const cases = [
      { payType: "fijo", commissionPercent: null },
      { payType: "porcentaje", commissionPercent: 10 },
      { payType: "mixto", commissionPercent: 4 },
    ];
    for (const employee of cases) {
      const input = {
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 3,
        commissionValue: null,
        noCommission: false,
        rules,
        employee: { payoutMode: "normal", ...employee },
      };
      const billing = computeInvoiceItemCommission(input);
      const payroll = payrollLineCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 3,
        commissionValue: null,
        payType: employee.payType,
        commissionPercent: employee.commissionPercent,
        rules,
      });
      expect(billing).toBe(payroll);
      // 100000×7% + 1500×3 = 11500 (la regla gana en los tres pay_type).
      expect(billing).toBe(11500);
    }
  });

  it("fijo sin reglas: detalle y nómina coinciden en 0", () => {
    const input = {
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 100000,
      qty: 2,
      commissionValue: null,
      noCommission: false,
      rules: NO_RULES,
      employee: { payoutMode: "normal", payType: "fijo", commissionPercent: 10 },
    };
    expect(computeInvoiceItemCommission(input)).toBe(0);
    expect(
      payrollLineCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        payType: "fijo",
        commissionPercent: 10,
        rules: NO_RULES,
      }),
    ).toBe(0);
  });

  it("custom con commission_value: valor del ítem para cualquier pay_type (sin regla)", () => {
    // Empleado con porcentaje: ambos usan el valor fijo del ítem.
    expect(
      computeInvoiceItemCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 5000,
        noCommission: false,
        rules: NO_RULES,
        employee: { payoutMode: "normal", payType: "porcentaje", commissionPercent: 10 },
      }),
    ).toBe(5000);
    expect(
      payrollLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 5000,
        payType: "porcentaje",
        commissionPercent: 10,
        rules: NO_RULES,
      }),
    ).toBe(5000);
    // Empleado fijo sin regla: el valor del ítem también comisiona (el % plano
    // no aplica al personalizado CON comisión).
    expect(
      computeInvoiceItemCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 5000,
        noCommission: false,
        rules: NO_RULES,
        employee: { payoutMode: "normal", payType: "fijo", commissionPercent: null },
      }),
    ).toBe(5000);
    expect(
      payrollLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: 5000,
        payType: "fijo",
        commissionPercent: null,
        rules: NO_RULES,
      }),
    ).toBe(5000);
  });

  it("no_commission y no_aplica: 0 en el detalle y sin línea en nómina", () => {
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: true,
        rules: productRule(5, null),
        employee: { payoutMode: "normal", payType: "fijo", commissionPercent: null },
      }),
    ).toBe(0);
    expect(
      computeInvoiceItemCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        noCommission: false,
        rules: productRule(5, null),
        employee: { payoutMode: "no_aplica", payType: "porcentaje", commissionPercent: 10 },
      }),
    ).toBe(0);
    expect(
      payrollLineCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 2,
        commissionValue: null,
        payType: "porcentaje",
        commissionPercent: 10,
        payoutMode: "no_aplica",
        rules: productRule(5, null),
      }),
    ).toBe(0);
  });

  it("paridad producto con comisión: inmediato ≡ nómina ≡ detalle = valor del ítem", () => {
    // La resolución compartida es la del pago inmediato (earnedCommissionFor).
    const inmediato = resolveEmployeeLineCommission({
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 42000,
      qty: 1,
      commissionValue: 1000,
      rules: NO_RULES,
      flatPercent: 35,
    });
    const nomina = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: "normal",
      payType: "porcentaje",
      commissionPercent: 35,
      lines: [
        {
          invoice_id: "inv-1",
          consecutive_number: 1,
          item_id: "line-1",
          item_type: "producto",
          qty: 1,
          unit_price: 42000,
          line_subtotal: 42000,
          commission_value: 1000,
          item_ref_id: PRODUCT_ID,
        },
      ],
      rules: NO_RULES,
    }).reduce((acc, line) => acc + line.commission, 0);
    const detalle = computeInvoiceItemCommission({
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 42000,
      qty: 1,
      commissionValue: 1000,
      noCommission: false,
      rules: NO_RULES,
      employee: { payoutMode: "normal", payType: "porcentaje", commissionPercent: 35 },
    });
    expect(inmediato).toBe(1000);
    expect(nomina).toBe(1000);
    expect(detalle).toBe(1000);
  });

  it("paridad con cantidad: inmediato ≡ nómina ≡ detalle (producto 1000 × 3 = 3000)", () => {
    // El valor fijo del ítem es POR UNIDAD: los tres caminos multiplican por qty.
    const inmediato = resolveEmployeeLineCommission({
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 126000,
      qty: 3,
      commissionValue: 1000,
      rules: NO_RULES,
      flatPercent: 35,
    });
    const nomina = payrollLineCommission({
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 126000,
      qty: 3,
      commissionValue: 1000,
      payType: "porcentaje",
      commissionPercent: 35,
      rules: NO_RULES,
    });
    const detalle = computeInvoiceItemCommission({
      itemType: "producto",
      itemRefId: PRODUCT_ID,
      subtotal: 126000,
      qty: 3,
      commissionValue: 1000,
      noCommission: false,
      rules: NO_RULES,
      employee: { payoutMode: "normal", payType: "porcentaje", commissionPercent: 35 },
    });
    expect(inmediato).toBe(3000);
    expect(nomina).toBe(3000);
    expect(detalle).toBe(3000);
  });
});

