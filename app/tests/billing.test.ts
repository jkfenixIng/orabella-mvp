import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  overCollectedEdit,
  overCollectedEditMessage,
  portionsMatchBalance,
  roundMoney,
  snapshotInvoiceTaxes,
  splitPaymentSchema,
  invoiceItemSchema,
} from "@/src/features/billing/schemas";
import { computeInvoiceItemCommission } from "@/src/features/billing/commission";
import {
  BillingError,
  annulInvoice,
  countInvoices,
  createInvoice,
  editEmittedInvoiceItems,
  editInvoiceItems,
  getInvoiceDetail,
  listInvoices,
  splitPayment,
  type BillingActor,
} from "@/src/features/billing/service";
import {
  commissionRuleKey,
  resolveEmployeeLineCommission,
  type RuleRate,
} from "@/src/features/commissions/schemas";
import { IN_FILTER_CHUNK_SIZE } from "@/src/shared/lib/paged";
import { buildEmployeeCommissionDetail } from "@/src/features/payroll/schemas";

const EMPLOYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/**
 * MO-1: marcas de idempotencia de los tests. Son dos para poder probar que dos
 * envíos DISTINTOS siguen siendo dos facturas (venta repetida legítima).
 */
const IDEMPOTENCY_KEY = "0f9a2f5e-6c1d-4f2b-9c3a-5d7e8f9a0b1c";
const OTHER_IDEMPOTENCY_KEY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

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
  // MO-1: desde que la emisión exige MARCA de idempotencia, los payloads de
  // este bloque la llevan. El contrato del cuerpo ganó un campo obligatorio;
  // las aserciones no cambian (cliente vacío válido, sin ítems inválido).
  it("rechaza sin ítems; cliente vacío es válido (opcional)", () => {
    expect(
      createInvoiceSchema.safeParse({
        idempotency_key: IDEMPOTENCY_KEY,
        client_name: "  ",
        items: [productItem()],
      }).success,
    ).toBe(true);
    expect(
      createInvoiceSchema.safeParse({
        idempotency_key: IDEMPOTENCY_KEY,
        client_name: "Ana",
        items: [],
      }).success,
    ).toBe(false);
  });

  it("client_document es opcional y el descuento arranca en 0", () => {
    const parsed = createInvoiceSchema.safeParse({
      idempotency_key: IDEMPOTENCY_KEY,
      client_name: "Ana",
      items: [productItem()],
    });
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

  it("redondea a PESO ENTERO (regla del datafono)", () => {
    // CAMBIÓ con la regla del peso entero: antes redondeaba a 2 decimales
    // (10.005 → 10.01). El datafono no acepta centavos, así que el dinero
    // calculado es entero: 10.005 → 10.
    expect(roundMoney(10.005)).toBe(10);
    expect(roundMoney(10.5)).toBe(11);
    expect(roundMoney(10.4999)).toBe(10);
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

  it("confirmar_bajo_cobrado es opcional y arranca en false (payload histórico intacto)", () => {
    expect(editEmittedInvoiceSchema.parse({ items: [OLD], payments: [] }).confirmar_bajo_cobrado).toBe(
      false,
    );
    expect(
      editEmittedInvoiceSchema.safeParse({ items: [OLD], payments: [], confirmar_bajo_cobrado: true })
        .success,
    ).toBe(true);
  });
});

// ---------------- WU2: sobre-cobro al bajar el total de una emitida -------

/**
 * Cifras del aviso: la decisión del dueño es permitir el ajuste con
 * confirmación explícita, así que lo que se prueba acá es que el aviso exista,
 * lleve las tres cifras y NO se dispare cuando no hay sobre-cobro.
 *
 * Los dos números que entran son los de `invoiceNetBalance` (neto facturado del
 * total nuevo y neto cobrado), no el bruto de `invoice_payments.amount`.
 */
describe("billing: el aviso de sobre-cobro (neto, exacto, sin tolerancia nueva)", () => {
  it("cobrado 200.000 contra nuevo total 150.000: exceso 50.000", () => {
    expect(overCollectedEdit({ netBilled: 150000, netCollected: 200000 })).toEqual({
      cobrado: 200000,
      total: 150000,
      diferencia: 50000,
    });
  });

  it("un peso de exceso ya cuenta y la igualdad no (complemento exacto de moneyEquals)", () => {
    expect(overCollectedEdit({ netBilled: 150000, netCollected: 150001 })?.diferencia).toBe(1);
    expect(overCollectedEdit({ netBilled: 150000, netCollected: 150000 })).toBeNull();
    // Por debajo del nuevo total no hay nada que confirmar.
    expect(overCollectedEdit({ netBilled: 200000, netCollected: 150000 })).toBeNull();
    // Factura sin cobros: nunca hay sobre-cobro, por chico que sea el total.
    expect(overCollectedEdit({ netBilled: 1000, netCollected: 0 })).toBeNull();
  });

  it("el mensaje lleva cobrado, nuevo total y exceso (y el número de factura)", () => {
    const aviso = overCollectedEditMessage({
      cobrado: 200000,
      total: 150000,
      diferencia: 50000,
      consecutive_number: 7,
    });
    expect(aviso).toContain("#7");
    expect(aviso).toContain("200.000");
    expect(aviso).toContain("150.000");
    expect(aviso).toContain("50.000");
    // Explica la consecuencia que el operador no puede deshacer después.
    expect(aviso).toContain("no se podrían registrar más cobros");
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

// ------------ WU2: el gate de sobre-cobro vive en el SERVIDOR --------------
//
// La pantalla es solo ayuda: la regla se prueba sobre `editEmittedInvoiceItems`
// REAL, con un doble del cliente de Supabase (mismo criterio que cash.test.ts).
// Solo se sustituyen la frontera de datos y los catálogos; la aritmética del
// dinero (`invoiceNetBalance`, `computeInvoiceTotals`) es la de producción.

const overCollectionStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  INVOICE_ID: "33333333-3333-4333-8333-333333333333",
  ITEM_ID: "99999999-9999-4999-8999-999999999999",
  PAY_ID: "44444444-4444-4444-8444-444444444444",
  METHOD_ID: "55555555-5555-4555-8555-555555555555",
  /** Cobros YA registrados de la factura: es el dato que decide el gate. */
  payments: [] as Array<{
    id: string;
    amount: number;
    fee_amount: number;
    method_code: string;
    fee_percent: number;
  }>,
  /** Payload del UPDATE de `invoices`: lo que el servicio realmente escribió. */
  invoiceUpdate: null as Record<string, unknown> | null,
  /** Payload del INSERT de `audit_logs`: el rastro del acto deliberado. */
  auditInsert: null as Record<string, unknown> | null,
  /** Escrituras observadas, en orden (`tabla.op`). */
  writes: [] as string[],
  /** Consultas que el doble no sabe responder: debe quedar SIEMPRE vacío. */
  unexpectedQueries: [] as string[],
}));

/**
 * Datos paginables del candado de nómina (U5). Solo las tablas registradas acá
 * entran al camino FIEL a PostgREST del doble (`eq`/`in` de verdad, orden por
 * `order()`, ventana real de `range`/`limit`). Sin esto un doble que devuelve
 * siempre la tabla entera no podría demostrar una truncación: la truncación vive
 * en la ventana.
 */
const pagedStub = vi.hoisted(() => ({
  /** `max-rows` por request del Data API de Supabase: el tope REAL. */
  rowCap: 1000,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Número de request (1-based, por tabla) donde el doble devuelve error. */
  failAt: {} as Record<string, number[]>,
  requests: {} as Record<string, number>,
  /** Ventanas efectivamente pedidas: la prueba de que se paginó y en qué orden. */
  windows: [] as Array<{ table: string; from: number; to: number; order: string[] }>,
  /** Largo de cada `in(...)`, por tabla y columna: prueba el troceo (414). */
  inFilters: [] as Array<{ table: string; column: string; count: number }>,
}));

/**
 * Estado propio del camino de ANULACIÓN (U6). Encendido solo por el bloque de
 * anulación: los demás describe quedan con el doble de siempre.
 *
 * El doble mantiene el estado REAL de la fila `invoices` (`invoiceStatus`) y
 * aplica la guarda de estado del UPDATE como lo haría PostgREST: si `.eq`
 * pidió un estado que ya no es el de la fila, el UPDATE afecta 0 filas y
 * `.single()` devuelve PGRST116. Así la carrera de dos anulaciones se puede
 * observar de verdad, sin inventar el resultado.
 */
const annulStub = vi.hoisted(() => ({
  active: false,
  /** Estado real de la fila `invoices` mientras el bloque está activo. */
  invoiceStatus: "Emitida",
  /** Líneas de `invoice_items` (null = la línea de edición de siempre). */
  items: null as Array<Record<string, unknown>> | null,
  /** Fila de `products` (stock que la reversión devuelve). */
  product: null as Record<string, unknown> | null,
  /** IN de reversión insertados: cuántas veces se restauró stock. */
  movements: [] as Array<Record<string, unknown>>,
  /** Guardas de estado que llevó cada UPDATE de `invoices`, en orden. */
  guards: [] as string[],
  /** El UPDATE afecta 0 filas sin carrera (ruta de error de la guarda). */
  updateMisses: false,
  /** Traza `read`/`write` de `invoices`, en orden: prueba la carrera real. */
  events: [] as string[],
  /**
   * Detiene el próximo UPDATE de `invoices` hasta que el test lo libere: con eso
   * el orden de aplicación de dos anulaciones queda bajo control (la que aplica
   * segunda es la que pierde la carrera).
   */
  holdNextWrite: false,
  /** Libera la escritura detenida (lo llena el doble al detenerla). */
  releaseWrite: null as (() => void) | null,
  /** Aviso: hay una escritura detenida esperando a que el test la libere. */
  onWriteHeld: null as (() => void) | null,
}));

/**
 * CO-1: estado propio del camino de EDICIÓN de factura (serialización por
 * compare-and-swap sobre `invoices.edit_version`, migración 038).
 *
 * El doble mantiene la versión REAL de la fila por factura y aplica la guarda
 * `.eq("edit_version", v)` como lo haría PostgREST: si la fila ya no está en la
 * versión que se leyó, el UPDATE afecta 0 filas y `.single()` devuelve PGRST116.
 * Así la carrera de dos ediciones de la MISMA factura se observa de verdad, sin
 * inventar el resultado ni el desenlace.
 */
const editStub = vi.hoisted(() => ({
  active: false,
  /** Estado real de `invoices.edit_version` por factura (id → versión). */
  versions: {} as Record<string, number>,
  /** Estado real de `invoices.status` por factura. */
  statuses: {} as Record<string, string>,
  /** Versión que llevó cada guarda `.eq("edit_version", v)`, en orden. */
  versionGuards: [] as number[],
  /**
   * CL-1: estado que llevó cada guarda `.eq("status", s)` del camino de edición,
   * en orden. La otra mitad de la precondición del compare-and-swap.
   */
  statusGuards: [] as string[],
  /** La guarda afecta 0 filas sin carrera (ruta de error del candado). */
  staleGuard: false,
  /** Movimientos de inventario insertados: cuántas veces se movió el stock. */
  movements: [] as Array<Record<string, unknown>>,
  /** Traza `read`/`write` de `invoices`, en orden: prueba la carrera real. */
  events: [] as string[],
  /**
   * Detiene la PRÓXIMA escritura de la edición hasta que el test la libere. Con
   * el candado, esa escritura es el compare-and-swap; sin él, la primera
   * escritura de ítems: así la carrera se puede armar en los dos caminos y el
   * intercalado queda bajo control (la que aplica segunda es la que pierde).
   */
  holdNextWrite: false,
  /** Libera la escritura detenida (lo llena el doble al detenerla). */
  releaseWrite: null as (() => void) | null,
  /** Aviso: hay una escritura detenida esperando a que el test la libere. */
  onWriteHeld: null as (() => void) | null,
  /** Fila de `products` (el stock que la edición ajusta). */
  product: null as Record<string, unknown> | null,
  /** Líneas de `invoice_items` por factura; ausente = la línea de siempre. */
  itemsByInvoice: {} as Record<string, Array<Record<string, unknown>>>,
}));

/**
 * MO-1: estado propio del camino de EMISIÓN (idempotencia de la factura).
 *
 * Encendido solo por el bloque de idempotencia: los demás describe siguen con
 * el doble de siempre. Mantiene el estado REAL que decide el defecto —las filas
 * de `invoices`, los consecutivos que devolvió `next_invoice_number` y cuántas
 * veces se escribió cada tabla—, y aplica de verdad los dos índices únicos de
 * la migración 041: un INSERT que repita `(sede_id, consecutive_number)` o
 * `(sede_id, idempotency_key)` responde 23505 y NO agrega fila, como Postgres.
 */
const createStub = vi.hoisted(() => ({
  active: false,
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  SHIFT_ID: "77777777-7777-4777-8777-777777777777",
  /** Filas de `invoices` realmente escritas (columnas de INVOICE_SELECT + la marca). */
  invoices: [] as Array<Record<string, unknown>>,
  /** Líneas, impuestos y porciones escritos: cuántas veces se movió cada cosa. */
  items: [] as Array<Record<string, unknown>>,
  payments: [] as Array<Record<string, unknown>>,
  /** Movimientos de inventario: la salida de stock de cada emisión. */
  movements: [] as Array<Record<string, unknown>>,
  /** Consecutivos devueltos por next_invoice_number, en orden de reserva. */
  consecutives: [] as number[],
  /** Escrituras PEDIDAS por tabla (un intento cuenta aunque choque con el índice). */
  inserts: {} as Record<string, number>,
  /** Saltea el próximo lookup por marca: arma la ventana de la carrera. */
  skipLookupOnce: false,
  /** Consultas que el doble no sabe responder: debe quedar SIEMPRE vacío. */
  unexpectedQueries: [] as string[],
  /** Producto de la sede con stock de sobra para descontar. */
  product: {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sede_id: "11111111-1111-4111-8111-111111111111",
    name: "Crema de prueba",
    sku: "CRE-01",
    stock_qty: 50,
    commission_value: 100,
    is_active: true,
  } as Record<string, unknown>,
  /** Turno abierto de la sede: el emisor es quien lo abrió. */
  shift: {
    id: "77777777-7777-4777-8777-777777777777",
    sede_id: "11111111-1111-4111-8111-111111111111",
    status: "abierto",
    opened_by: "u-1",
    opened_at: "2026-01-01T00:00:00.000Z",
  } as Record<string, unknown> | null,
}));

/**
 * U7: la comisión que MUESTRA la pantalla de la factura vs. la que paga la
 * nómina. Solo el bloque de U7 redefine la línea y mira los lotes de ids.
 */
const commissionStub = vi.hoisted(() => ({
  /**
   * Línea(s) de `invoice_items` del detalle; null = la línea de siempre. Lo usa
   * el bloque U7 (comisión mostrada vs. comisión pagada).
   */
  items: null as Array<Record<string, unknown>> | null,
  /** Largo de cada `in(...)` sobre `commission_rules`: prueba el troceo (414). */
  inSizes: [] as number[],
}));

/**
 * Total emitido ANTES del ajuste (la línea vale lo mismo). 300.000 con un cobro
 * de 200.000 es el caso REAL: factura Emitida cobrada a medias (saldo 100.000),
 * no una Emitida ya completa (esa la cierra el cobro cuando cubre el neto).
 */
const STUB_EMITTED_TOTAL = 300000;

/** Fila de factura emitida, tal como la lee `loadDetail`. */
function stubInvoiceRow(total: number) {
  return {
    id: overCollectionStub.INVOICE_ID,
    sede_id: overCollectionStub.SEDE_ID,
    consecutive_number: 7,
    client_name: null,
    client_document: null,
    subtotal: total,
    discount: 0,
    tax: 0,
    surcharge: 0,
    total,
    status: "Emitida",
    user_id: "u-1",
    cash_shift_id: null,
    closed_by: null,
    closed_at: null,
    cancel_reason: null,
    created_at: "2026-01-01T00:00:00.000Z",
    // CO-1: token de serialización de la edición (migración 038). El doble del
    // camino de edición lo reemplaza por el valor VIVO de la fila.
    edit_version: 0,
  };
}

/** La única línea de la factura antes del ajuste (300.000). */
function stubItemRow() {
  return {
    id: overCollectionStub.ITEM_ID,
    invoice_id: overCollectionStub.INVOICE_ID,
    item_type: "custom",
    product_id: null,
    service_id: null,
    custom_name: "Corte y peinado",
    employee_id: EMPLOYEE_ID,
    qty: 1,
    unit_price: STUB_EMITTED_TOTAL,
    discount: 0,
    subtotal: STUB_EMITTED_TOTAL,
    no_commission: true,
    commission_value: null,
    commission_mode: "ninguna",
    commission_percent_override: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

/** Cobro registrado: `amount` es BRUTO y `fee_amount` el recargo del método. */
function stubPayment(amount: number, feeAmount = 0) {
  return {
    id: overCollectionStub.PAY_ID,
    amount,
    fee_amount: feeAmount,
    method_code: "efectivo",
    fee_percent: 0,
  };
}

/**
 * Cliente Supabase falso y encadenable. Responde lo que el camino
 * `editEmittedInvoiceItems` consulta de verdad y registra las ESCRITURAS (que es
 * lo que vuelve observable si el gate frenó antes de tocar algo); cualquier
 * consulta que no sepa responder se registra en `unexpectedQueries` y vuelve
 * como error, para que el test falle a la vista y no en silencio.
 */
function createOverCollectionStubClient(): unknown {
  const zeroRowsError = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows", hint: null };

  /** Contexto que la consulta encadenada le pasa a `response`. */
  interface QueryContext {
    /** Guarda de estado del UPDATE de anulación (U6). */
    statusGuard?: string;
    /** Guarda de versión del UPDATE de edición (CO-1). */
    versionGuard?: number;
    /** `invoices.id` pedido por el `.eq("id", …)` de esta consulta. */
    rowId?: string;
    /** `invoice_id` pedido por el `.eq("invoice_id", …)` de esta consulta. */
    itemsInvoiceId?: string;
    /** `.single()`/`.maybeSingle()`: PostgREST devuelve una fila, no una lista. */
    single: boolean;
  }

  /**
   * CO-1: escritura del camino de EDICIÓN. El doble mantiene la versión REAL por
   * factura y aplica la guarda `.eq("edit_version", v)` como PostgREST: si la
   * fila ya no está en la versión que se leyó, el UPDATE afecta 0 filas.
   */
  const editVersionResponse = (ctx: QueryContext): { data: unknown; error: unknown } => {
    const id = ctx.rowId ?? overCollectionStub.INVOICE_ID;
    const written = (overCollectionStub.invoiceUpdate ?? {}) as Record<string, unknown>;
    const status = () => editStub.statuses[id] ?? "Emitida";
    const row = () => ({
      ...stubInvoiceRow(Number(written.total ?? STUB_EMITTED_TOTAL)),
      id,
      status: status(),
      edit_version: editStub.versions[id] ?? 0,
    });
    // El UPDATE de totales de la edición libre no lleva guarda de versión: es
    // una escritura del MISMO dueño del candado, no un segundo candado.
    if (ctx.versionGuard === undefined) return { data: row(), error: null };
    // CL-1: el estado es la OTRA mitad de la precondición, y se evalúa como
    // PostgREST: la fila solo se pisa si SIGUE en el estado leído. La anulación
    // que gane la ventana lectura→candado deja la guarda sin coincidencia y el
    // UPDATE afecta 0 filas.
    if (ctx.statusGuard !== undefined && ctx.statusGuard !== status()) {
      return { data: null, error: zeroRowsError };
    }
    if (editStub.staleGuard || ctx.versionGuard !== (editStub.versions[id] ?? 0)) {
      return { data: null, error: zeroRowsError };
    }
    editStub.versions[id] = Number(written.edit_version ?? ctx.versionGuard + 1);
    return { data: row(), error: null };
  };

  const response = (
    table: string,
    op: string,
    ctx: QueryContext,
  ): { data: unknown; error: unknown } => {
    if (op !== "select") {
      overCollectionStub.writes.push(`${table}.${op}`);
      if (table === "invoices" && op === "update") {
        // CO-1: camino de EDICIÓN (compare-and-swap sobre `edit_version`).
        if (editStub.active) {
          editStub.events.push("write");
          return editVersionResponse(ctx);
        }
        annulStub.events.push("write");
        // Guarda de estado = compare-and-swap: la fila solo se pisa si sigue en
        // el estado leído. Sin coincidencia, PostgREST afecta 0 filas.
        if (ctx.statusGuard !== undefined && ctx.statusGuard !== annulStub.invoiceStatus) {
          return { data: null, error: zeroRowsError };
        }
        if (annulStub.updateMisses) return { data: null, error: zeroRowsError };
        if (annulStub.active) {
          annulStub.invoiceStatus = String(overCollectionStub.invoiceUpdate?.status ?? annulStub.invoiceStatus);
        }
        // El `total` que devuelve el UPDATE es el que el servicio ESCRIBIÓ: la
        // aserción compara contra el recálculo real y no contra un número
        // puesto a mano en el doble. La anulación no reescribe `total`: en ese
        // camino la fila conserva el emitido.
        const written = (overCollectionStub.invoiceUpdate ?? {}) as Record<string, unknown>;
        const total = Number(written.total ?? (annulStub.active ? STUB_EMITTED_TOTAL : 0));
        return {
          data: {
            ...stubInvoiceRow(total),
            ...(annulStub.active
              ? {
                  status: String(written.status ?? annulStub.invoiceStatus),
                  cancel_reason: (written.cancel_reason as string | null) ?? null,
                }
              : {}),
          },
          error: null,
        };
      }
      if (table === "inventory_movements" && op === "insert") {
        // El movimiento ya lo registró `insert()`: acá solo se devuelve la fila
        // como la devolvería el trigger + PostgREST.
        const movements = editStub.active ? editStub.movements : annulStub.movements;
        return { data: movements.at(-1) ?? null, error: null };
      }
      return { data: null, error: null };
    }
    switch (table) {
      case "invoices":
        if (editStub.active) {
          editStub.events.push("read");
          const id = ctx.rowId ?? overCollectionStub.INVOICE_ID;
          return {
            data: {
              ...stubInvoiceRow(STUB_EMITTED_TOTAL),
              id,
              status: editStub.statuses[id] ?? "Emitida",
              edit_version: editStub.versions[id] ?? 0,
            },
            error: null,
          };
        }
        if (annulStub.active) {
          annulStub.events.push("read");
          return {
            data: { ...stubInvoiceRow(STUB_EMITTED_TOTAL), status: annulStub.invoiceStatus },
            error: null,
          };
        }
        return { data: stubInvoiceRow(STUB_EMITTED_TOTAL), error: null };
      case "products":
        if (editStub.active) {
          // `getProductsStock` (lista) y `getProduct` (fila) comparten tabla.
          if (ctx.single) return { data: editStub.product, error: null };
          return { data: editStub.product ? [editStub.product] : [], error: null };
        }
        return { data: annulStub.product, error: null };
      case "invoice_items":
        if (commissionStub.items) return { data: commissionStub.items, error: null };
        if (annulStub.active && annulStub.items) return { data: annulStub.items, error: null };
        if (editStub.active) {
          const id = ctx.itemsInvoiceId ?? overCollectionStub.INVOICE_ID;
          return { data: editStub.itemsByInvoice[id] ?? [stubItemRow()], error: null };
        }
        return { data: [stubItemRow()], error: null };
      case "invoice_taxes":
        return { data: [], error: null };
      case "invoice_payments":
        return { data: overCollectionStub.payments, error: null };
      case "commission_rules":
        return { data: [], error: null };
      case "employees":
        return {
          data: [
            {
              id: EMPLOYEE_ID,
              sede_id: overCollectionStub.SEDE_ID,
              user_id: "u-1",
              full_name: "Empleada de prueba",
            },
          ],
          error: null,
        };
      case "payroll_periods":
        return { data: [], error: null };
      default:
        overCollectionStub.unexpectedQueries.push(`${table}.select`);
        return { data: null, error: { message: `stub sin respuesta para ${table}.select` } };
    }
  };

  /**
   * Camino FIEL a PostgREST, solo para las tablas de `pagedStub.tables`: aplica
   * `eq`/`in`, ordena por las claves de `order()` y sirve la ventana pedida
   * (`range`/`limit`) con el techo por request del Data API (`rowCap`). Así el
   * tope que el código pide (200, 2000) y el que el servidor impone (1000) se
   * comportan como en producción.
   */
  const pagedResponse = (
    table: string,
    spec: {
      filters: Array<(row: Record<string, unknown>) => boolean>;
      orderKeys: Array<{ column: string; ascending: boolean }>;
      rangeFrom: number;
      rangeTo: number;
      single: boolean;
    },
  ): { data: unknown; error: unknown; total: number } => {
    const rows = pagedStub.tables[table];
    if (!rows) return { data: null, error: null, total: 0 };
    pagedStub.requests[table] = (pagedStub.requests[table] ?? 0) + 1;
    const attempt = pagedStub.requests[table] as number;
    if ((pagedStub.failAt[table] ?? []).includes(attempt)) {
      return { data: null, error: { message: `doble: fallo inyectado en ${table} (request ${attempt})` }, total: 0 };
    }
    const to = Math.min(spec.rangeTo, spec.rangeFrom + pagedStub.rowCap - 1);
    pagedStub.windows.push({ table, from: spec.rangeFrom, to, order: spec.orderKeys.map((key) => key.column) });
    const filtered = rows.filter((row) => spec.filters.every((matches) => matches(row)));
    if (spec.orderKeys.length > 0) {
      filtered.sort((left, right) => {
        for (const key of spec.orderKeys) {
          const leftValue = String(left[key.column] ?? "");
          const rightValue = String(right[key.column] ?? "");
          if (leftValue === rightValue) continue;
          return (leftValue < rightValue ? -1 : 1) * (key.ascending ? 1 : -1);
        }
        return 0;
      });
    }
    const window = filtered.slice(spec.rangeFrom, to + 1);
    return { data: spec.single ? window[0] ?? null : window, error: null, total: filtered.length };
  };

  const from = (table: string) => {
    let op = "select";
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const orderKeys: Array<{ column: string; ascending: boolean }> = [];
    let rangeFrom = 0;
    let rangeTo = pagedStub.rowCap - 1;
    /** Guarda de estado del UPDATE (U6): la precondición del compare-and-swap. */
    let statusGuard: string | undefined;
    /** Guarda de versión del UPDATE de edición (CO-1). */
    let versionGuard: number | undefined;
    /** `invoices.id` del `.eq("id", …)` de esta consulta (CO-1). */
    let rowId: string | undefined;
    /** `invoice_id` del `.eq("invoice_id", …)` de esta consulta (CO-1). */
    let itemsInvoiceId: string | undefined;
    // `select(cols, { count, head })`: PostgREST responde el total sin filas.
    let countRequested = false;
    let headOnly = false;
    // Las tablas NO registradas en `pagedStub` conservan la respuesta fija de
    // siempre: los filtros y la ventana se aceptan y se ignoran.
    const resolve = (single: boolean) => {
      const result =
        op === "select" && pagedStub.tables[table]
          ? pagedResponse(table, { filters, orderKeys, rangeFrom, rangeTo, single })
          : response(table, op, { statusGuard, versionGuard, rowId, itemsInvoiceId, single });
      if (!countRequested) return result;
      return {
        data: headOnly ? null : (result as { data?: unknown }).data,
        error: (result as { error?: unknown }).error,
        count: (result as { total?: number }).total ?? 0,
      };
    };
    /**
     * Cierra la consulta. Si el test pidió detener la próxima escritura de la
     * anulación o de la edición, esa escritura queda EN VUELO hasta que la
     * libere: así se puede ordenar a mano cuál de las dos aplica primero (la que
     * aplica segunda es la que pierde la carrera).
     */
    const settle = (single: boolean): Promise<unknown> => {
      const holdAnnul =
        op === "update" && table === "invoices" && annulStub.active && annulStub.holdNextWrite;
      // CO-1: la edición se detiene en su PRÓXIMA escritura, cualquiera sea: con
      // el candado la primera es el compare-and-swap; sin él, la primera
      // escritura de ítems. Así la carrera se puede armar en los dos caminos.
      const holdEdit = op !== "select" && editStub.active && editStub.holdNextWrite;
      if (!holdAnnul && !holdEdit) return Promise.resolve(resolve(single));
      const holder = holdAnnul ? annulStub : editStub;
      holder.holdNextWrite = false;
      return new Promise<void>((release) => {
        holder.releaseWrite = release;
        holder.onWriteHeld?.();
      }).then(() => resolve(single) as unknown);
    };
    const query: Record<string, unknown> = {
      select: (_columns?: unknown, options?: { count?: string; head?: boolean }) => {
        if (options?.count) countRequested = true;
        if (options?.head) headOnly = true;
        return query;
      },
      insert: (payload?: unknown) => {
        op = "insert";
        if (table === "audit_logs") {
          overCollectionStub.auditInsert = payload as Record<string, unknown>;
        }
        if (table === "inventory_movements") {
          const movement = (payload ?? {}) as Record<string, unknown>;
          const log = editStub.active ? editStub.movements : annulStub.movements;
          log.push({
            id: `mov-${log.length + 1}`,
            created_at: "2026-01-01T00:00:00.000Z",
            ...movement,
          });
        }
        return query;
      },
      update: (payload?: unknown) => {
        op = "update";
        if (table === "invoices") {
          overCollectionStub.invoiceUpdate = payload as Record<string, unknown>;
        }
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      eq: (column: string, value: unknown) => {
        if (table === "invoices" && column === "status") {
          statusGuard = String(value);
          if (annulStub.active) annulStub.guards.push(String(value));
          if (editStub.active) editStub.statusGuards.push(String(value));
        }
        if (table === "invoices" && column === "id") rowId = String(value);
        if (table === "invoices" && column === "edit_version") {
          versionGuard = Number(value);
          if (editStub.active) editStub.versionGuards.push(Number(value));
        }
        if (table === "invoice_items" && column === "invoice_id") itemsInvoiceId = String(value);
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        if (table === "commission_rules") commissionStub.inSizes.push(values.length);
        pagedStub.inFilters.push({ table, column, count: values.length });
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return query;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orderKeys.push({ column, ascending: options?.ascending !== false });
        return query;
      },
      range: (start: number, end: number) => {
        rangeFrom = start;
        rangeTo = end;
        return query;
      },
      limit: (count: number) => {
        rangeFrom = 0;
        rangeTo = Math.max(0, count - 1);
        return query;
      },
      single: () => settle(true) as Promise<{ data: unknown; error: unknown }>,
      maybeSingle: () => settle(true) as Promise<{ data: unknown; error: unknown }>,
      // `await` directo sobre la cadena (p. ej. `insert(...)` o
      // `delete().eq(...)`) resuelve al objeto de respuesta, igual que PostgREST.
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        settle(false).then(onFulfilled, onRejected),
    };
    return query;
  };

  return { from };
}

/**
 * MO-1: doble del cliente Supabase para el camino de EMISIÓN.
 *
 * No sustituye la frontera de inventario ni la aritmética: `deductStock`,
 * `registerMovement`, `planStockDeduction`, `computeInvoiceTotals` y `loadDetail`
 * son los de producción y corren de verdad contra este doble. Lo que el doble
 * mantiene es el ESTADO que decide el defecto (filas, consecutivos, escrituras)
 * y las dos barreras únicas de la migración 041.
 */
function createInvoiceStubClient(): unknown {
  const from = (table: string) => {
    let op = "select";
    let single = false;
    let askedIdempotencyKey = false;
    let payload: Record<string, unknown> = {};
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];

    const matches = (row: Record<string, unknown>) => filters.every((test) => test(row));

    const resolve = (): { data: unknown; error: unknown } => {
      if (table === "invoices") {
        if (op === "select") {
          if (askedIdempotencyKey && createStub.skipLookupOnce) {
            // La carrera: cuando esta emisión miró, la otra todavía no había
            // confirmado. Se consume una sola vez.
            createStub.skipLookupOnce = false;
            return { data: null, error: null };
          }
          return { data: createStub.invoices.find(matches) ?? null, error: null };
        }
        if (op === "insert") {
          const key = (payload.idempotency_key ?? null) as string | null;
          const clash = (column: string, value: unknown) =>
            createStub.invoices.some(
              (row) => row.sede_id === payload.sede_id && row[column] === value,
            );
          // Barrera REAL de 041: la marca repetida gana sobre cualquier otra
          // lectura, igual que el índice único parcial de Postgres.
          if (key !== null && clash("idempotency_key", key)) {
            return {
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "uq_invoices_sede_idempotency_key"',
              },
            };
          }
          if (clash("consecutive_number", payload.consecutive_number)) {
            return {
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "invoices_sede_id_consecutive_number_key"',
              },
            };
          }
          const row: Record<string, unknown> = {
            id: `invoice-${createStub.invoices.length + 1}`,
            client_name: null,
            client_document: null,
            cash_shift_id: null,
            closed_by: null,
            closed_at: null,
            cancel_reason: null,
            edit_version: 0,
            created_at: "2026-01-01T00:00:00.000Z",
            ...payload,
          };
          createStub.invoices.push(row);
          return { data: row, error: null };
        }
      }
      if (table === "invoice_items") {
        if (op === "insert") {
          createStub.items.push({
            ...payload,
            id: `item-${createStub.items.length + 1}`,
            created_at: "2026-01-01T00:00:00.000Z",
            // Join embebido de ITEM_SELECT en `loadDetail`.
            employees: {
              full_name: "Empleada de prueba",
              employee_code: "E-01",
              commission_percent: 35,
              pay_type: "porcentaje",
              payout_mode: "normal",
            },
          });
          return { data: null, error: null };
        }
        return { data: createStub.items, error: null };
      }
      if (table === "invoice_payments") {
        if (op === "insert") {
          createStub.payments.push({
            ...payload,
            id: `payment-${createStub.payments.length + 1}`,
            created_at: "2026-01-01T00:00:00.000Z",
          });
          return { data: null, error: null };
        }
        return { data: createStub.payments, error: null };
      }
      if (table === "invoice_taxes") {
        return { data: op === "insert" ? null : [], error: null };
      }
      if (table === "products") {
        // El sondeo de `resolveProductSelect` (columna `commission_value`) y
        // `getProductsStock` leen en lista; `getProduct` lee en single.
        if (op !== "select") return { data: null, error: null };
        return { data: single ? createStub.product : [createStub.product], error: null };
      }
      if (table === "employees") {
        return {
          data: [
            {
              id: EMPLOYEE_ID,
              sede_id: createStub.SEDE_ID,
              full_name: "Empleada de prueba",
            },
          ],
          error: null,
        };
      }
      // El detalle resuelve la comisión con las reglas ítem×empleado (U7): sin
      // reglas cargadas, la lectura exhaustiva tiene que agotar en la primera
      // página, no fallar.
      if (table === "commission_rules") return { data: [], error: null };
      if (table === "cash_shifts") return { data: createStub.shift, error: null };
      if (table === "users") return { data: { full_name: "Cajera de prueba" }, error: null };
      if (table === "inventory_movements") {
        if (op === "insert") {
          const movement = {
            ...payload,
            id: `movement-${createStub.movements.length + 1}`,
            created_at: "2026-01-01T00:00:00.000Z",
          };
          createStub.movements.push(movement);
          return { data: movement, error: null };
        }
        return { data: createStub.movements, error: null };
      }
      if (table === "audit_logs") return { data: null, error: null };
      createStub.unexpectedQueries.push(`${table}.${op}`);
      return { data: null, error: { message: `doble de emisión sin respuesta para ${table}.${op}` } };
    };

    const settle = () => Promise.resolve(resolve());
    const query: Record<string, unknown> = {
      select: () => query,
      insert: (value?: unknown) => {
        op = "insert";
        const first = Array.isArray(value) ? value[0] : value;
        payload = (first ?? {}) as Record<string, unknown>;
        createStub.inserts[table] = (createStub.inserts[table] ?? 0) + 1;
        return query;
      },
      update: (value?: unknown) => {
        op = "update";
        payload = (value ?? {}) as Record<string, unknown>;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      eq: (column: string, value: unknown) => {
        if (column === "idempotency_key") askedIdempotencyKey = true;
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return query;
      },
      order: () => query,
      limit: () => query,
      range: () => query,
      gte: () => query,
      lte: () => query,
      single: () => {
        single = true;
        return settle();
      },
      maybeSingle: () => {
        single = true;
        return settle();
      },
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        settle().then(onFulfilled, onRejected),
    };
    return query;
  };

  const rpc = async (name: string) => {
    if (name !== "next_invoice_number") {
      createStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `doble de emisión: rpc desconocido ${name}` } };
    }
    // El consecutivo solo avanza cuando se RESERVA: así el hueco de la carrera
    // queda a la vista en lugar de esconderse.
    const next = createStub.consecutives.length + 1;
    createStub.consecutives.push(next);
    return { data: next, error: null };
  };

  return { from, rpc };
}

/**
 * CL-2: estado propio del camino de COBRO DIVIDIDO (`splitPayment`).
 *
 * Encendido solo por el bloque de idempotencia del cobro: los demás describe
 * siguen con el doble de siempre. Mantiene el estado REAL que decide el
 * defecto —las filas de `invoices` y de `invoice_payments`, y cuántas veces se
 * escribió cada tabla— y aplica de verdad las DOS barreras de la 042/031: el
 * tope de cobro (trigger `BEFORE INSERT`, que suma solo lo YA confirmado porque
 * las filas hermanas de un mismo INSERT no se ven entre sí) y el índice único
 * parcial por marca (que sí ve las filas anteriores del mismo INSERT, como
 * Postgres al insertarlas).
 */
const payStub = vi.hoisted(() => ({
  active: false,
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  INVOICE_ID: "33333333-3333-4333-8333-333333333333",
  OTHER_INVOICE_ID: "33333333-3333-4333-8333-333333333334",
  METHOD_ID: "55555555-5555-4555-8555-555555555555",
  SHIFT_ID: "77777777-7777-4777-8777-777777777777",
  /** Filas REALES de `invoices`, con su estado (el cobro las pasa a Pagada). */
  invoices: [] as Array<Record<string, unknown>>,
  /** Filas REALES de `invoice_payments`: el dinero cobrado. */
  payments: [] as Array<Record<string, unknown>>,
  /** Escrituras PEDIDAS por tabla (un intento cuenta aunque choque). */
  inserts: {} as Record<string, number>,
  /** Saltea el próximo lookup por marca: arma la ventana de la carrera. */
  skipMarkLookupOnce: false,
  /**
   * Snapshot de `invoice_payments` servido UNA sola vez: la lectura VIEJA del
   * saldo con la que dos cobros concurrentes pasan los dos la comprobación
   * exacta. El intercalado se arma, no se inventa el desenlace.
   */
  stalePaymentsOnce: null as Array<Record<string, unknown>> | null,
  /** Consultas que el doble no sabe responder: debe quedar SIEMPRE vacío. */
  unexpectedQueries: [] as string[],
}));

/**
 * CL-2: doble del cliente Supabase para el camino de COBRO DIVIDIDO.
 *
 * No sustituye la aritmética: `invoiceNetBalance`, `computeCardFees` y
 * `loadDetail` son los de producción y corren de verdad contra este doble. Lo
 * que el doble mantiene es el ESTADO que decide el defecto y las barreras de
 * la base.
 */
function createSplitStubClient(): unknown {
  const rowsOf = (table: string): Array<Record<string, unknown>> => {
    if (table === "invoices") return payStub.invoices;
    if (table === "invoice_payments") return payStub.payments;
    if (table === "cash_shifts") {
      return [
        {
          id: payStub.SHIFT_ID,
          cash_register_id: "reg-1",
          sede_id: payStub.SEDE_ID,
          opened_by: "u-1",
          closed_by: null,
          opened_at: "2026-01-01T00:00:00.000Z",
          closed_at: null,
          opening_base: 0,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: 0,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
      ];
    }
    if (table === "users") return [{ id: "u-1", full_name: "Cajera de prueba" }];
    // La factura de prueba no tiene líneas ni impuestos: el detalle los lee
    // vacíos y la comisión no entra en juego (el cobro no la toca).
    if (table === "invoice_items" || table === "invoice_taxes") return [];
    if (table === "commission_rules") return [];
    payStub.unexpectedQueries.push(`${table}.select`);
    return [];
  };

  const known = new Set([
    "invoices",
    "invoice_payments",
    "invoice_items",
    "invoice_taxes",
    "cash_shifts",
    "users",
    "commission_rules",
  ]);

  const from = (table: string) => {
    let op = "select";
    let single = false;
    let payload: unknown;
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const filterColumns: string[] = [];

    const matching = () => rowsOf(table).filter((row) => filters.every((test) => test(row)));

    /** Columnas del payload (una fila o varias, como manda PostgREST). */
    const payloadRows = (): Array<Record<string, unknown>> =>
      (Array.isArray(payload) ? payload : [payload ?? {}]) as Array<Record<string, unknown>>;

    const resolve = (): { data: unknown; error: unknown } => {
      if (!known.has(table)) {
        return { data: null, error: { message: `doble de cobro sin respuesta para ${table}.${op}` } };
      }
      if (table === "invoices" && op === "update") {
        // El cobro que completa la factura la pasa a Pagada: el doble lo
        // escribe de verdad, para que la lectura siguiente lo vea.
        const written = (payload ?? {}) as Record<string, unknown>;
        const matched = matching();
        for (const row of matched) Object.assign(row, written);
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if ("insert" === op) {
        if (table !== "invoice_payments") {
          return { data: single ? payloadRows()[0] ?? null : payloadRows(), error: null };
        }
        const values = payloadRows();
        // 1) El tope de cobro (031) es un trigger BEFORE INSERT: corre ANTES de
        //    que la fila entre al índice, y su SUM solo ve lo YA confirmado
        //    (las filas hermanas del mismo INSERT comparten el snapshot).
        for (const row of values) {
          const invoice = payStub.invoices.find((candidate) => candidate.id === row.invoice_id);
          if (!invoice) {
            return { data: null, error: { code: "23503", message: "Factura inexistente" } };
          }
          const paidNet = payStub.payments
            .filter((candidate) => candidate.invoice_id === row.invoice_id)
            .reduce(
              (acc, candidate) =>
                acc + (Number(candidate.amount) - Number(candidate.fee_amount ?? 0)),
              0,
            );
          const newNet = Number(row.amount) - Number(row.fee_amount ?? 0);
          const cap = Math.round(Number(invoice.total) - Number(invoice.surcharge ?? 0));
          if (paidNet + newNet - cap > 0.009) {
            return {
              data: null,
              error: { code: "P0001", message: "El cobro supera el neto facturado de la factura" },
            };
          }
        }
        // 2) El índice único PARCIAL (042): la marca no nula choca contra lo
        //    confirmado Y contra las filas anteriores del MISMO INSERT, y
        //    aborta la sentencia entera (no se persiste ninguna fila).
        const clashes = values.some((row, index) => {
          const mark = row.idempotency_key;
          if (mark === null || mark === undefined) return false;
          const keyed = (other: Record<string, unknown>) =>
            other.invoice_id === row.invoice_id && other.idempotency_key === mark;
          return [
            ...payStub.payments.filter((other) => other.invoice_id === row.invoice_id),
            ...values.slice(0, index),
          ].some(keyed);
        });
        if (clashes) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "uq_invoice_payments_invoice_idempotency_key"',
            },
          };
        }
        const persisted = values.map((row, index) => ({
          id: `pago-${payStub.payments.length + index + 1}`,
          created_at: "2026-01-01T00:00:00.000Z",
          ...row,
        }));
        payStub.payments.push(...persisted);
        return { data: single ? persisted[0] ?? null : persisted, error: null };
      }
      if (table === "invoice_payments" && payStub.stalePaymentsOnce !== null) {
        const snapshot = payStub.stalePaymentsOnce;
        payStub.stalePaymentsOnce = null;
        return { data: single ? snapshot[0] ?? null : snapshot, error: null };
      }
      if (filterColumns.includes("idempotency_key") && payStub.skipMarkLookupOnce) {
        payStub.skipMarkLookupOnce = false;
        return { data: single ? null : [], error: null };
      }
      const matched = matching();
      return { data: single ? matched[0] ?? null : matched, error: null };
    };

    const query: Record<string, unknown> = {
      select: () => query,
      insert: (value?: unknown) => {
        op = "insert";
        payload = value;
        payStub.inserts[table] = (payStub.inserts[table] ?? 0) + 1;
        return query;
      },
      update: (value?: unknown) => {
        op = "update";
        payload = value;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        filterColumns.push(column);
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return query;
      },
      order: () => query,
      limit: () => query,
      range: () => query,
      single: () => {
        single = true;
        return Promise.resolve(resolve());
      },
      maybeSingle: () => {
        single = true;
        return Promise.resolve(resolve());
      },
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return query;
  };

  return { from };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => billingStubClient(),
}));

/**
 * El doble que ve cada camino. Los propios de emisión (MO-1) y de cobro
 * dividido (CL-2) solo existen cuando su bloque los enciende; el resto del
 * archivo conserva el doble de siempre, así que ningún describe existente
 * cambia de comportamiento.
 */
function billingStubClient(): unknown {
  if (payStub.active) return createSplitStubClient();
  return createStub.active ? createInvoiceStubClient() : createOverCollectionStubClient();
}

vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  const method = {
    id: overCollectionStub.METHOD_ID,
    sede_id: overCollectionStub.SEDE_ID,
    code: "efectivo",
    name: "Efectivo",
    is_active: true,
    arqueable: true,
    fee_percent: 0,
  } as Awaited<ReturnType<typeof actual.listPaymentMethods>>[number];
  // CL-2: el segundo método existe porque una operación de cobro puede tener
  // DOS porciones (una por método) y esa es justo la arruga que la marca debe
  // respetar. Sin recargo: el cobro no cambia de aritmética, solo de forma.
  const transfer = {
    ...method,
    id: payStub.METHOD_ID,
    code: "transferencia",
    name: "Transferencia",
  } as Awaited<ReturnType<typeof actual.listPaymentMethods>>[number];
  return {
    ...actual,
    listTaxes: async () => [] as Awaited<ReturnType<typeof actual.listTaxes>>,
    listPaymentMethods: async () =>
      [method, transfer] as Awaited<ReturnType<typeof actual.listPaymentMethods>>,
    listServices: async () => [] as Awaited<ReturnType<typeof actual.listServices>>,
  };
});

describe("billing: gate de sobre-cobro al bajar el total de una emitida (WU2)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };

  /** Ajuste de la única línea: baja el precio de 300.000 a `unitPrice`. */
  function editPayload(unitPrice: number, extra: Record<string, unknown> = {}) {
    return {
      items: [
        {
          id: overCollectionStub.ITEM_ID,
          item_type: "custom",
          custom_name: "Corte y peinado",
          product_id: null,
          service_id: null,
          employee_id: EMPLOYEE_ID,
          qty: 1,
          unit_price: unitPrice,
          discount: 0,
          no_commission: true,
        },
      ],
      payments: overCollectionStub.payments.map((payment) => ({
        id: payment.id,
        method_code: payment.method_code,
      })),
      ...extra,
    };
  }

  function edit(unitPrice: number, extra: Record<string, unknown> = {}) {
    return editEmittedInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      editPayload(unitPrice, extra),
      ACTOR,
    );
  }

  beforeEach(() => {
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.auditInsert = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
  });

  it("rechaza con OVERCOLLECTED y las tres cifras cuando nadie confirmó", async () => {
    overCollectionStub.payments = [stubPayment(200000)];
    const failure: unknown = await edit(150000).catch((error: unknown) => error);
    // Código EXACTO (no "algún error"): es el contrato que consume la pantalla.
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "OVERCOLLECTED", status: 422 });
    const mensaje = (failure as BillingError).message;
    expect(mensaje).toContain("200.000");
    expect(mensaje).toContain("150.000");
    expect(mensaje).toContain("50.000");
    // El rechazo ocurre ANTES de tocar nada: ni una fila, ni auditoría.
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("con confirmar_bajo_cobrado el ajuste sigue y deja el rastro auditado", async () => {
    overCollectionStub.payments = [stubPayment(200000)];
    const detail = await edit(150000, { confirmar_bajo_cobrado: true });
    // El total sale del recálculo del servicio (300.000 → 150.000).
    expect(detail.invoice.total).toBe(150000);
    expect(overCollectionStub.invoiceUpdate?.total).toBe(150000);
    // La consecuencia que el gate evita a ciegas: saldo en 0 y factura Emitida
    // que ya no admite cobros (tope de 031 y OVERPAID de caja).
    expect(detail.remaining).toBe(0);
    // Control de vacuidad: el camino NO se frenó, escribió.
    expect(overCollectionStub.writes).toContain("invoices.update");
    // El acto deliberado queda explicable después, en la MISMA acción auditada.
    expect(overCollectionStub.auditInsert).toMatchObject({
      action: "invoice.edited",
      entity: "invoices",
      entity_id: overCollectionStub.INVOICE_ID,
      metadata: {
        total_antes: 300000,
        total_nuevo: 150000,
        bajo_cobrado_confirmado: true,
        cobrado_neto: 200000,
        bajo_cobrado_diferencia: 50000,
      },
    });
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("un ajuste que NO sobre-cobra pasa sin confirmación", async () => {
    overCollectionStub.payments = [stubPayment(100000)];
    const detail = await edit(150000);
    expect(detail.invoice.total).toBe(150000);
    expect(overCollectionStub.writes).toContain("invoices.update");
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("una factura SIN cobros no tiene nada que confirmar, por chico que sea el total", async () => {
    overCollectionStub.payments = [];
    const detail = await edit(1000);
    expect(detail.invoice.total).toBe(1000);
    expect(overCollectionStub.writes).toContain("invoices.update");
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: la ÚNICA diferencia entre rechazar y avanzar es la bandera", async () => {
    overCollectionStub.payments = [stubPayment(200000)];
    const rechazado: unknown = await edit(150000).catch((error: unknown) => error);
    expect(rechazado).toMatchObject({ code: "OVERCOLLECTED" });
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();

    const confirmado = await edit(150000, { confirmar_bajo_cobrado: true });
    expect(confirmado.invoice.total).toBe(150000);
    expect(overCollectionStub.invoiceUpdate?.total).toBe(150000);
    expect(overCollectionStub.auditInsert).not.toBeNull();
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });
});

// ------- U5: el candado de nómina cerrada no se trunca ni falla abierto -----
//
// `invoiceInClosedPayroll` decidía con `.limit(200)` períodos y `.limit(2000)`
// ítems, SIN orden y sin error al tocar el tope. Pasado cualquiera de los dos,
// la respuesta era `false`: el candado PAYROLL_LOCKED fallaba ABIERTO y una
// factura cuya comisión ya estaba pagada en un período cerrado se podía
// repreciar o reasignar. El tope era de TRANSPORTE (lo que aguanta un request),
// no de negocio. El doble de acá sirve ventanas reales para poder demostrarlo.

const CLOSED_PERIODS = 201;
const ITEMS_PER_PERIOD = 10;
const OTHER_INVOICE_ID = "77777777-7777-4777-8777-777777777777";

/**
 * Historial de nómina de la sede: 201 períodos cerrados (tope viejo: 200) con
 * 2001 ítems (tope viejo: 2000). La línea que menciona la factura vive en el
 * ÚLTIMO período y en el ÚLTIMO ítem, siempre detrás de los dos topes.
 */
function seedClosedPayroll(matching: boolean) {
  const periods: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  for (let period = 1; period <= CLOSED_PERIODS; period += 1) {
    const periodId = `periodo-${String(period).padStart(3, "0")}`;
    periods.push({ id: periodId, sede_id: overCollectionStub.SEDE_ID, status: "cerrado" });
    const isLast = period === CLOSED_PERIODS;
    const count = isLast ? 1 : ITEMS_PER_PERIOD;
    for (let item = 1; item <= count; item += 1) {
      const suffix = `${String(period).padStart(3, "0")}-${String(item).padStart(3, "0")}`;
      items.push({
        id: `nomina-${suffix}`,
        period_id: periodId,
        // Solo una línea lleva la factura: es la que `buildEmployeeCommissionDetail`
        // escribió cuando la comisión se liquidó en el período cerrado.
        detail_json: [{ invoice_id: isLast && matching ? overCollectionStub.INVOICE_ID : OTHER_INVOICE_ID }],
      });
    }
  }
  pagedStub.tables.payroll_periods = periods;
  pagedStub.tables.payroll_items = items;
  return { periods, items };
}

describe("billing: el candado de nómina cerrada no se trunca (U5)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };

  /** Ajuste del precio de la única línea: 300.000 → `unitPrice` (toca pago). */
  function editInvoice(unitPrice: number) {
    return editEmittedInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      {
        items: [
          {
            id: overCollectionStub.ITEM_ID,
            item_type: "custom",
            custom_name: "Corte y peinado",
            product_id: null,
            service_id: null,
            employee_id: EMPLOYEE_ID,
            qty: 1,
            unit_price: unitPrice,
            discount: 0,
            no_commission: true,
          },
        ],
        payments: [],
      },
      ACTOR,
    );
  }

  beforeEach(() => {
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.auditInsert = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
  });

  afterEach(() => {
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
  });

  it("una línea de nómina cerrada detrás de los topes frena la edición", async () => {
    const seed = seedClosedPayroll(true);
    // Non-vacuidad del fixture: supera los DOS topes viejos.
    expect(seed.periods).toHaveLength(CLOSED_PERIODS);
    expect(seed.items.length).toBeGreaterThan(2000);

    const failure: unknown = await editInvoice(150000).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "PAYROLL_LOCKED", status: 409 });
    // El rechazo ocurre ANTES de tocar nada: ni una fila, ni auditoría.
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("la lectura del candado pagina y va en orden determinista", async () => {
    seedClosedPayroll(true);
    await editInvoice(150000).catch(() => null);

    const periodWindows = pagedStub.windows.filter((window) => window.table === "payroll_periods");
    const itemWindows = pagedStub.windows.filter((window) => window.table === "payroll_items");
    // Los 201 períodos no entran en un request: hubo más de una lectura.
    expect(periodWindows.length).toBeGreaterThan(1);
    // Y los ítems se pidieron por páginas sucesivas, no en una sola.
    expect(itemWindows.length).toBeGreaterThan(1);
    expect(itemWindows.some((window) => window.from > 0)).toBe(true);
    // Requisito 2: el orden va explícito en cada lectura (sin `order()` no hay
    // forma de que dos páginas no se pisen ni de reproducir la corrida).
    for (const window of [...periodWindows, ...itemWindows]) expect(window.order).toEqual(["id"]);
  });

  it("si el candado no puede completar la lectura, la edición se RECHAZA", async () => {
    seedClosedPayroll(true);
    // El historial no se puede leer entero (falla la segunda página).
    pagedStub.failAt = { payroll_items: [2] };

    const failure: unknown = await editInvoice(150000).catch((error: unknown) => error);
    // NUNCA `false` por no haber podido mirar: sin historial completo no se sabe
    // si la comisión ya estaba pagada, así que la edición no se permite.
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: sin línea que mencione la factura, el MISMO ajuste pasa", async () => {
    seedClosedPayroll(false);
    const detail = await editInvoice(150000);
    expect(detail.invoice.total).toBe(150000);
    expect(overCollectionStub.invoiceUpdate?.total).toBe(150000);
    // El candado miró el historial completo (mismo volumen, otra respuesta) y
    // siguió: lo que frena arriba son los datos, no un tope del doble.
    expect(pagedStub.windows.some((window) => window.table === "payroll_items" && window.from > 0)).toBe(true);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });
});

// ---------------- U6: la anulación respeta el candado y guarda el estado -----
//
// La auditoría cruzada entre módulos encontró dos huecos en `annulInvoice`:
//
// (a) La anulación estaba FUERA del candado de nómina cerrada, que las DOS
//     ediciones sí aplican (`editInvoiceItems` / `editEmittedInvoiceItems`
//     rechazan con PAYROLL_LOCKED). Anular una factura cuya comisión ya se pagó
//     en un período cerrado no devuelve esa plata: el período está congelado,
//     `commissions` solo bloquea pagos inmediatos NUEVOS sobre una anulada y la
//     nómina solo excluye anuladas de los cálculos FUTUROS. El ingreso
//     desaparece del reporte y la comisión queda pagada, sin reverso.
// (b) El UPDATE de `invoices` no llevaba guarda de estado: dos anulaciones
//     concurrentes leían el mismo estado anulable e insertaban las DOS el IN de
//     reversión → stock restaurado dos veces.

/**
 * Línea de PRODUCTO de la factura: es el origen del IN de reversión, así que es
 * la que hace observable cuántas veces se restauró stock.
 */
function annulProductItemRow() {
  return {
    id: overCollectionStub.ITEM_ID,
    invoice_id: overCollectionStub.INVOICE_ID,
    item_type: "producto",
    product_id: PRODUCT_ID,
    service_id: null,
    custom_name: null,
    employee_id: EMPLOYEE_ID,
    qty: 2,
    unit_price: 250000,
    discount: 0,
    subtotal: 500000,
    no_commission: true,
    commission_value: null,
    commission_mode: "ninguna",
    commission_percent_override: null,
    created_at: "2026-01-01T00:00:00.000Z",
    employees: {
      full_name: "Ana Pérez",
      employee_code: "E-1",
      commission_percent: 0,
      pay_type: "fijo",
      payout_mode: "normal",
    },
  };
}

/** Producto de la sede con stock: la reversión le devuelve lo facturado. */
function annulProductRow() {
  return {
    id: PRODUCT_ID,
    sede_id: overCollectionStub.SEDE_ID,
    sku: "SKU-1",
    name: "Shampoo",
    description: null,
    stock_qty: 3,
    min_stock: 0,
    cost_price: null,
    sale_price: 250000,
    commission_value: null,
    is_active: true,
  };
}

describe("billing: la anulación respeta el candado de nómina y guarda el estado (U6)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };

  function annul(motivo = "Cobro duplicado") {
    return annulInvoice(overCollectionStub.SEDE_ID, overCollectionStub.INVOICE_ID, { motivo }, ACTOR);
  }

  beforeEach(() => {
    annulStub.active = true;
    annulStub.holdNextWrite = false;
    annulStub.releaseWrite = null;
    annulStub.onWriteHeld = null;
    annulStub.invoiceStatus = "Emitida";
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.auditInsert = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
  });

  afterEach(() => {
    annulStub.active = false;
    annulStub.holdNextWrite = false;
    annulStub.releaseWrite?.();
    annulStub.releaseWrite = null;
    annulStub.onWriteHeld = null;
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
  });

  it("no anula una factura cuya comisión ya se pagó en un período cerrado (U6-a)", async () => {
    seedClosedPayroll(true);

    const outcome = await annul().then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "PAYROLL_LOCKED", status: 409 });
    // El rechazo ocurre ANTES de tocar nada: ni una fila, ni stock, ni auditoría.
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(annulStub.movements).toEqual([]);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: sin línea que mencione la factura, la MISMA anulación pasa (U6-a)", async () => {
    seedClosedPayroll(false);

    const detail = await annul();

    expect(detail.invoice.status).toBe("Anulada");
    expect(overCollectionStub.invoiceUpdate?.status).toBe("Anulada");
    expect(overCollectionStub.invoiceUpdate?.cancel_reason).toBe("Cobro duplicado");
    // Mismo volumen de historial, otra respuesta: lo que frena arriba son los
    // datos, no un tope del doble. Y el candado lo miró TODO (pagina).
    expect(pagedStub.windows.some((window) => window.table === "payroll_items" && window.from > 0)).toBe(true);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("si el candado no puede completar la lectura, la anulación se RECHAZA (U6-a)", async () => {
    seedClosedPayroll(true);
    // El historial no se puede leer entero (falla la segunda página).
    pagedStub.failAt = { payroll_items: [2] };

    const outcome = await annul().then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    // Nunca un `false` por no haber podido mirar: sin historial completo no se
    // sabe si la comisión ya estaba pagada, así que la anulación se rechaza.
    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "READ_INCOMPLETE" });
    expect(overCollectionStub.writes).toEqual([]);
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(annulStub.movements).toEqual([]);
  });

  it("dos anulaciones concurrentes restauran el stock UNA sola vez (U6-b)", async () => {
    annulStub.items = [annulProductItemRow()];
    annulStub.product = annulProductRow();

    // Las DOS anulaciones entran con la misma lectura vieja (`Emitida`) y sus
    // dos escrituras quedan en vuelo. El doble detiene la de la primera y la
    // aplica después de la de la segunda: es el orden real de la carrera (la
    // que aplica segunda es la que pierde), con el intercalado bajo control.
    annulStub.holdNextWrite = true;
    const writeHeld = new Promise<void>((resolve) => {
      annulStub.onWriteHeld = resolve;
    });
    const first = annul();
    await writeHeld;
    // Non-vacuidad: la primera ya leyó `Emitida` y todavía no escribió nada.
    expect(annulStub.events).toEqual(["read"]);

    const second = annul();
    const secondResult = await second.then(
      () => "anulado" as const,
      (error: unknown) => error,
    );
    // La segunda aplica ESCRITURA y termina su reversión con la fila ya Anulada.
    expect(secondResult).toBe("anulado");

    if (annulStub.releaseWrite) annulStub.releaseWrite();
    const firstResult = await first.then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    // La carrera existió de verdad: las DOS leyeron antes de la primera
    // escritura (si el intercalado cambiara, esto falla a la vista en vez de
    // dejar pasar la prueba por un camino que ya no es el de la carrera).
    expect(annulStub.events).toEqual(["read", "read", "write", "write"]);
    // El síntoma: el stock se devuelve UNA vez, no dos.
    expect(annulStub.movements).toHaveLength(1);
    expect(annulStub.movements[0]).toMatchObject({ product_id: PRODUCT_ID, type: "IN", qty: 2 });
    // La que aplicó segunda afecta 0 filas y se rechaza con su código.
    expect(firstResult).toBeInstanceOf(BillingError);
    expect(firstResult).toMatchObject({ code: "ANNUL_CONFLICT", status: 409 });
    // El UPDATE lleva el estado leído como precondición: compare-and-swap.
    expect(annulStub.guards).toEqual(["Emitida", "Emitida"]);
    // Una sola anulación: una sola auditoría.
    expect(overCollectionStub.writes.filter((write) => write === "audit_logs.insert")).toHaveLength(1);
  });

  it("un UPDATE que afecta 0 filas se reporta con su código y no toca el stock (U6-b)", async () => {
    annulStub.items = [annulProductItemRow()];
    annulStub.product = annulProductRow();
    // El estado de la fila ya no es el leído (otra operación ganó): 0 filas.
    annulStub.updateMisses = true;

    const outcome = await annul().then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "ANNUL_CONFLICT", status: 409 });
    expect(annulStub.guards).toEqual(["Emitida"]);
    expect(annulStub.movements).toEqual([]);
    expect(overCollectionStub.auditInsert).toBeNull();
  });

  it("un estado no anulable se sigue rechazando ANTES de la guarda (U6-b)", async () => {
    annulStub.invoiceStatus = "Anulada";

    const outcome = await annul().then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "ANNUL_INVALID", status: 409 });
    expect(overCollectionStub.writes).toEqual([]);
    expect(annulStub.guards).toEqual([]);
  });
});

// ---------- U7: la comisión que se MUESTRA es la que la nómina PAGA ----------
//
// `loadCommissionRulesByEmployee` leía con `.limit(5000)`, y el `max-rows` del
// Data API sirve 1000 filas por request: pasadas 1000 reglas, la pantalla de la
// factura caía al porcentaje plano del empleado mientras la nómina —que SÍ lee
// todas las reglas— pagaba la regla. Dos cifras de la misma plata que no cuadran.
// Acá la línea de la factura es comisionable y la regla que la resuelve está
// DESPUÉS del tope, así que la divergencia se puede medir sin base de datos.

describe("billing: la comisión mostrada no se corta con las reglas (U7)", () => {
  const ITEM_SUBTOTAL = 100000;
  /** Comisión que la pantalla muestra si le falta la regla (5% plano). */
  const FLAT_PERCENT = 5;
  /** Comisión que la nómina paga con la regla ítem×empleado (10%). */
  const RULE_PERCENT = 10;
  const RULE_COMMISSION = (ITEM_SUBTOTAL * RULE_PERCENT) / 100;
  const FLAT_COMMISSION = (ITEM_SUBTOTAL * FLAT_PERCENT) / 100;

  /** Línea comisionable de la factura: producto con regla ítem×empleado. */
  function commissionableItem(employeeId: string, index: number): Record<string, unknown> {
    return {
      id: `linea-${String(index).padStart(5, "0")}`,
      invoice_id: overCollectionStub.INVOICE_ID,
      item_type: "producto",
      product_id: PRODUCT_ID,
      service_id: null,
      custom_name: null,
      employee_id: employeeId,
      qty: 1,
      unit_price: ITEM_SUBTOTAL,
      discount: 0,
      subtotal: ITEM_SUBTOTAL,
      no_commission: false,
      commission_value: null,
      commission_mode: "porcentaje",
      commission_percent_override: null,
      created_at: "2026-01-01T00:00:00.000Z",
      employees: {
        full_name: "Ana Pérez",
        employee_code: "E-1",
        commission_percent: FLAT_PERCENT,
        pay_type: "porcentaje",
        payout_mode: "normal",
      },
    };
  }

  /** Regla de comisión activa de la sede (el `id` da el orden determinista). */
  function ruleRow(index: number, employeeId: string, percent: number): Record<string, unknown> {
    return {
      id: `regla-${String(index).padStart(5, "0")}`,
      sede_id: overCollectionStub.SEDE_ID,
      employee_id: employeeId,
      item_type: "producto",
      item_id: PRODUCT_ID,
      percent,
      amount: null,
      is_active: true,
    };
  }

  beforeEach(() => {
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    commissionStub.items = null;
    commissionStub.inSizes.length = 0;
  });

  afterEach(() => {
    pagedStub.tables = {};
    commissionStub.items = null;
    commissionStub.inSizes.length = 0;
  });

  it("una regla más allá del tope por request se usa igual (misma cifra que la nómina)", async () => {
    const RULES = 1200;
    commissionStub.items = [commissionableItem(EMPLOYEE_ID, 1)];
    // Reglas de OTRO ítem llenan la tabla; la que resuelve esta línea es la
    // última, o sea la que el tope por request deja afuera.
    pagedStub.tables.commission_rules = [
      ...Array.from({ length: RULES - 1 }, (_, index) => ruleRow(index + 1, EMPLOYEE_ID, 0)),
      { ...ruleRow(RULES, EMPLOYEE_ID, RULE_PERCENT), item_id: PRODUCT_ID },
    ];
    // Non-vacuidad del fixture: hay más reglas que el tope por request.
    expect(pagedStub.tables.commission_rules).toHaveLength(RULES);
    expect(RULES).toBeGreaterThan(pagedStub.rowCap);
    // Y el 5% plano NO es lo que da la regla: las dos cifras se distinguen.
    expect(FLAT_COMMISSION).not.toBe(RULE_COMMISSION);

    const detail = await getInvoiceDetail(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
    );

    // La regla que la nómina usa es la que se muestra: 10% de 100.000 = 10.000.
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].commission_amount).toBe(RULE_COMMISSION);
  });

  it("las reglas se piden por páginas y en orden determinista", async () => {
    const RULES = 1200;
    commissionStub.items = [commissionableItem(EMPLOYEE_ID, 1)];
    pagedStub.tables.commission_rules = Array.from({ length: RULES }, (_, index) =>
      ruleRow(index + 1, EMPLOYEE_ID, RULE_PERCENT),
    );

    await getInvoiceDetail(overCollectionStub.SEDE_ID, overCollectionStub.INVOICE_ID);

    const ruleWindows = pagedStub.windows.filter((window) => window.table === "commission_rules");
    expect(ruleWindows.length).toBeGreaterThan(1);
    expect(ruleWindows[0]).toEqual({
      table: "commission_rules",
      from: 0,
      to: 999,
      order: ["id"],
    });
    expect(ruleWindows.some((window) => window.from > 0)).toBe(true);
    for (const window of ruleWindows) expect(window.order).toEqual(["id"]);
  });

  it("los ids de los empleados van en lotes que aguantan la URL (414)", async () => {
    const EMPLOYEES = 150;
    commissionStub.items = Array.from({ length: EMPLOYEES }, (_, index) =>
      commissionableItem(`empleado-${String(index + 1).padStart(5, "0")}`, index + 1),
    );
    pagedStub.tables.commission_rules = [];

    await getInvoiceDetail(overCollectionStub.SEDE_ID, overCollectionStub.INVOICE_ID);

    // Más de un lote: 150 ids no entran en una sola URL.
    expect(commissionStub.inSizes.length).toBeGreaterThan(1);
    expect(Math.max(...commissionStub.inSizes)).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
    expect(commissionStub.inSizes.reduce((acc, size) => acc + size, 0)).toBe(EMPLOYEES);
  });

  it("control negativo: una factura chica se resuelve igual (una lectura, un lote)", async () => {
    commissionStub.items = [commissionableItem(EMPLOYEE_ID, 1)];
    pagedStub.tables.commission_rules = [ruleRow(1, EMPLOYEE_ID, RULE_PERCENT)];

    const detail = await getInvoiceDetail(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
    );

    expect(detail.items[0].commission_amount).toBe(RULE_COMMISSION);
    expect(commissionStub.inSizes).toEqual([1]);
    expect(pagedStub.windows.filter((window) => window.table === "commission_rules")).toEqual([
      { table: "commission_rules", from: 0, to: 999, order: ["id"] },
    ]);
  });

  it("si la lectura de reglas no se completa, el detalle falla a la vista", async () => {
    commissionStub.items = [commissionableItem(EMPLOYEE_ID, 1)];
    pagedStub.tables.commission_rules = [ruleRow(1, EMPLOYEE_ID, RULE_PERCENT)];
    pagedStub.failAt = { commission_rules: [1] };

    const failure: unknown = await getInvoiceDetail(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
    ).catch((error: unknown) => error);

    // Nunca una comisión calculada con lo que se alcanzó a leer.
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
  });
});

// ------------------------------- filtro por empleado: ni recorte ni 414 (U8) ---
// `countInvoices` leía los ids de factura del empleado con `.limit(5000)` (que el
// `max-rows` del Data API baja a 1000) y después filtraba `in("id", ids)` SIN
// lotes: el conteo salía CORTO —páginas inalcanzables— y con 1000+ ids la URL
// (~44 KB) no entra y el Data API responde 414, así que la lectura no ocurría.
// `listInvoices` tenía el mismo recorte (`.limit(2000)`) y el mismo `in` sin
// lotes, más un `.limit(2000)` en el enriquecimiento que truncaba los ítems de
// la página.
describe("billing: el filtro por empleado no recorta ni rompe la URL (U8)", () => {
  const SEDE = overCollectionStub.SEDE_ID;

  function seedEmployeeInvoices(count: number, itemsPerInvoice = 1) {
    const items: Array<Record<string, unknown>> = [];
    const invoices: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= count; index += 1) {
      const suffix = String(index).padStart(5, "0");
      const invoiceId = `fac-${suffix}`;
      invoices.push({
        id: invoiceId,
        sede_id: SEDE,
        consecutive_number: index,
        client_name: null,
        client_document: null,
        subtotal: 1000,
        discount: 0,
        tax: 0,
        surcharge: 0,
        total: 1000,
        status: "Emitida",
        user_id: "u-1",
        cash_shift_id: null,
        closed_by: null,
        closed_at: null,
        cancel_reason: null,
        created_at: "2026-01-01T00:00:00.000Z",
      });
      for (let line = 1; line <= itemsPerInvoice; line += 1) {
        items.push({
          id: `li-${suffix}-${String(line).padStart(3, "0")}`,
          invoice_id: invoiceId,
          employee_id: EMPLOYEE_ID,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
    }
    pagedStub.tables = { invoice_items: items, invoices };
  }

  function invoiceIdInSizes(): number[] {
    return pagedStub.inFilters
      .filter((entry) => entry.table === "invoices" && entry.column === "id")
      .map((entry) => entry.count);
  }

  beforeEach(() => {
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  it("RED: countInvoices cuenta TODAS las facturas del empleado, no un recorte", async () => {
    seedEmployeeInvoices(1200);

    const total = await countInvoices(SEDE, { employee_id: EMPLOYEE_ID });

    expect(total).toBe(1200);
  });

  it("countInvoices manda los ids en lotes que aguantan la URL y pagina la lectura", async () => {
    seedEmployeeInvoices(1200);

    await countInvoices(SEDE, { employee_id: EMPLOYEE_ID });

    const sizes = invoiceIdInSizes();
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
    // La lectura de `invoice_items` paginó: no se cortó en el tope por request.
    expect(pagedStub.windows.filter((window) => window.table === "invoice_items").length).toBeGreaterThan(1);
  });

  it("RED: listInvoices no pierde facturas del empleado", async () => {
    seedEmployeeInvoices(1200);

    const rows = await listInvoices(SEDE, { employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows).toHaveLength(10);
    // La más reciente del conjunto COMPLETO del empleado, no del recorte.
    expect(rows[0].consecutive_number).toBe(1200);
  });

  it("listInvoices no arma un `in` gigante y mantiene el orden descendente", async () => {
    seedEmployeeInvoices(1200);

    const rows = await listInvoices(SEDE, { employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows.map((row) => row.consecutive_number)).toEqual([
      1200, 1199, 1198, 1197, 1196, 1195, 1194, 1193, 1192, 1191,
    ]);
    expect(Math.max(...invoiceIdInSizes())).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
  });

  it("RED: con más de 1000 líneas en la página no se pierde factura ni participante", async () => {
    // 10 facturas × 120 líneas = 1200 ítems en la página: el `.limit(2000)` que
    // el `max-rows` baja a 1000 dejaba a las últimas facturas sin participantes.
    seedEmployeeInvoices(10, 120);

    const rows = await listInvoices(SEDE, { employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.employee_names.length === 1)).toBe(true);
  });

  it("control: un empleado con pocas facturas sigue listando y contando igual", async () => {
    seedEmployeeInvoices(3);

    const rows = await listInvoices(SEDE, { employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows.map((row) => row.consecutive_number)).toEqual([3, 2, 1]);
    expect(await countInvoices(SEDE, { employee_id: EMPLOYEE_ID })).toBe(3);
    // Cada lectura pidió su único lote (uno para el listado, uno para el conteo)
    // y ninguna paginó más allá de la primera página: el conjunto entra entero.
    expect(invoiceIdInSizes().every((size) => size <= IN_FILTER_CHUNK_SIZE)).toBe(true);
    expect(
      pagedStub.windows
        .filter((window) => window.table === "invoice_items")
        .every((window) => window.from === 0),
    ).toBe(true);
  });
});

// --------- CO-1: dos ediciones de la MISMA factura se serializan -----------
//
// `editInvoiceItems` y `editEmittedInvoiceItems` leían los ítems de la factura,
// calculaban el delta NETO por producto y lo aplicaban con `registerMovement`.
// Entre la lectura y la escritura no había ningún candado: dos ediciones
// simultáneas de la MISMA factura calculaban el MISMO delta y las dos lo
// aplicaban, así que el stock se descontaba (o se devolvía) dos veces.
//
// El candado es un compare-and-swap sobre `invoices.edit_version` (migración
// 038), el mismo patrón que la anulación de factura (U6: `.eq("status", …)` →
// `ANNUL_CONFLICT`) y el cierre de caja (`.eq("status","abierto")` →
// `SHIFT_ALREADY_CLOSED`): la edición escribe la versión SIGUIENTE solo si la
// fila sigue en la versión que leyó, y si no, afecta 0 filas y se rechaza con
// `EDIT_CONFLICT` (409) ANTES de la primera escritura — ítems, stock o
// auditoría. La frontera de inventario no cambia: el ajuste sigue yendo por
// `registerMovement`.
//
// `editStub` mantiene la versión REAL por factura, así que la carrera se
// observa de verdad: la primera edición queda EN VUELO en su próxima escritura,
// la segunda corre completa y la primera se libera después — es el orden real
// de la carrera (la que aplica segunda es la que pierde).

describe("billing: dos ediciones de la misma factura se serializan (CO-1)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Otra factura de la misma sede: el control anti-extralimitación. */
  const OTHER_INVOICE_ID = "77777777-7777-4777-8777-777777777777";
  const OTHER_ITEM_ID = "88888888-8888-4888-8888-888888888888";
  /** Cantidad final: 1 → 3. El delta es +2 (dos unidades de descuento). */
  const QTY_DELTA = 2;

  /** Línea de PRODUCTO de la factura (el origen del delta de stock). */
  function productLine(invoiceId: string, itemId: string, qty: number, unitPrice: number) {
    return {
      ...annulProductItemRow(),
      id: itemId,
      invoice_id: invoiceId,
      qty,
      unit_price: unitPrice,
      subtotal: qty * unitPrice,
    };
  }

  /**
   * La MISMA línea con qty 3 a 100.000: el subtotal queda intacto (300.000) y el
   * delta es +2. Las dos ediciones concurrentes piden exactamente el mismo
   * ajuste, que es el caso del hallazgo.
   */
  function payload(itemId: string) {
    return {
      items: [
        {
          id: itemId,
          item_type: "producto",
          product_id: PRODUCT_ID,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 1 + QTY_DELTA,
          unit_price: 100000,
          discount: 0,
          no_commission: true,
        },
      ],
      payments: [],
    };
  }

  /** Edición LIBRE de emitida (cajera/turno; acá admin, que también puede). */
  function freeEdit(
    invoiceId = overCollectionStub.INVOICE_ID,
    itemId = overCollectionStub.ITEM_ID,
  ) {
    return editEmittedInvoiceItems(overCollectionStub.SEDE_ID, invoiceId, payload(itemId), ACTOR);
  }

  /** Edición ADMIN (total inmutable + motivo): el otro camino del hallazgo. */
  function adminEdit(
    invoiceId = overCollectionStub.INVOICE_ID,
    itemId = overCollectionStub.ITEM_ID,
  ) {
    return editInvoiceItems(
      overCollectionStub.SEDE_ID,
      invoiceId,
      { ...payload(itemId), motivo: "Cantidad mal digitada" },
      ACTOR,
    );
  }

  /**
   * Arranca una edición y espera —por SONDEO, sin callbacks compartidos— a que
   * su PRÓXIMA escritura quede EN VUELO. Con el candado esa escritura es el
   * compare-and-swap; sin él, la primera escritura de ítems: por eso el mismo
   * control sirve para el RED y para el GREEN. Devuelve la promesa DENTRO de un
   * objeto porque `return pending` esperaría a que la edición (detenida)
   * termine, y el test quiere justamente lo contrario: seguir con la segunda
   * edición mientras la primera está en vuelo.
   */
  async function holdFirstWrite(start: () => Promise<unknown>) {
    editStub.holdNextWrite = true;
    editStub.releaseWrite = null;
    const pending = start().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 400 && !editStub.releaseWrite; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Si la edición falla antes de escribir, el sondeo no ve la escritura y la
    // prueba falla a la vista, sin quedarse esperando.
    expect(editStub.releaseWrite).not.toBeNull();
    // Non-vacuidad del intercalado: la primera ya leyó la factura y todavía no
    // escribió nada, así que las dos ediciones partieron de la MISMA versión.
    expect(editStub.events).toEqual(["read"]);
    return { pending };
  }

  beforeEach(() => {
    editStub.active = true;
    editStub.versions = {};
    editStub.statuses = {};
    editStub.versionGuards.length = 0;
    editStub.statusGuards.length = 0;
    editStub.staleGuard = false;
    editStub.movements.length = 0;
    editStub.events.length = 0;
    editStub.holdNextWrite = false;
    editStub.releaseWrite = null;
    editStub.onWriteHeld = null;
    editStub.product = annulProductRow();
    editStub.itemsByInvoice = {
      [overCollectionStub.INVOICE_ID]: [
        productLine(overCollectionStub.INVOICE_ID, overCollectionStub.ITEM_ID, 1, STUB_EMITTED_TOTAL),
      ],
      [OTHER_INVOICE_ID]: [
        productLine(OTHER_INVOICE_ID, OTHER_ITEM_ID, 1, STUB_EMITTED_TOTAL),
      ],
    };
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.auditInsert = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  afterEach(() => {
    editStub.active = false;
    editStub.holdNextWrite = false;
    editStub.releaseWrite?.();
    editStub.releaseWrite = null;
    editStub.onWriteHeld = null;
    editStub.versions = {};
    editStub.statuses = {};
    editStub.versionGuards.length = 0;
    editStub.statusGuards.length = 0;
    editStub.staleGuard = false;
    editStub.movements.length = 0;
    editStub.events.length = 0;
    editStub.product = null;
    editStub.itemsByInvoice = {};
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  it("dos ediciones libres concurrentes mueven el stock UNA sola vez", async () => {
    const { pending: first } = await holdFirstWrite(() => freeEdit());

    const second = await freeEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    // Non-vacuidad: la segunda corrió entera y su ajuste quedó aplicado.
    expect(second).toBe("aplicada");
    const writesAfterWinner = overCollectionStub.writes.length;

    if (editStub.releaseWrite) editStub.releaseWrite();
    const firstResult = await first;

    // El síntoma del hallazgo: el delta (+2) se aplica UNA vez, no dos.
    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({ product_id: PRODUCT_ID, type: "OUT", qty: QTY_DELTA });
    // La carrera existió de verdad: las DOS leyeron ANTES de la primera
    // escritura (si el intercalado cambiara, esto falla a la vista en vez de
    // dejar pasar la prueba por un camino que ya no es el de la carrera).
    // Las tres escrituras: el CAS de la ganadora, su UPDATE de totales y el CAS
    // RECHAZADO de la perdedora (que es su única escritura).
    expect(editStub.events).toEqual(["read", "read", "write", "write", "write"]);
    // La que aplicó segunda afecta 0 filas y se rechaza con su código.
    expect(firstResult).toBeInstanceOf(BillingError);
    expect(firstResult).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    // Las dos entraron con la MISMA versión leída: por eso la segunda pierde.
    expect(editStub.versionGuards).toEqual([0, 0]);
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    // El candado es la PRIMERA escritura: la perdedora no escribió nada más
    // (ni ítems, ni stock, ni auditoría). Su única escritura es el CAS rechazado.
    expect(overCollectionStub.writes.slice(writesAfterWinner)).toEqual(["invoices.update"]);
    // Una sola edición aplicada: una sola auditoría.
    expect(
      overCollectionStub.writes.filter((write) => write === "audit_logs.insert"),
    ).toHaveLength(1);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("la edición admin de una PAGADA se serializa igual (mismo candado)", async () => {
    editStub.statuses[overCollectionStub.INVOICE_ID] = "Pagada";

    const { pending: first } = await holdFirstWrite(() => adminEdit());

    const second = await adminEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    expect(second).toBe("aplicada");

    if (editStub.releaseWrite) editStub.releaseWrite();
    const firstResult = await first;

    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({ type: "OUT", qty: QTY_DELTA });
    expect(firstResult).toBeInstanceOf(BillingError);
    expect(firstResult).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    expect(editStub.versionGuards).toEqual([0, 0]);
  });

  it("control anti-extralimitación: la edición de OTRA factura no se bloquea", async () => {
    const { pending: first } = await holdFirstWrite(() => freeEdit());

    // Otra factura, otra línea, el mismo ajuste: mientras la primera está EN
    // VUELO, esta pasa. Un candado global (una sola versión compartida) haría
    // que la primera se rechazara al liberarse, y este control falla a la vista.
    const other = await freeEdit(OTHER_INVOICE_ID, OTHER_ITEM_ID).then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    expect(other).toBe("aplicada");

    if (editStub.releaseWrite) editStub.releaseWrite();
    const firstResult = await first;
    expect(firstResult).toBe("aplicada");

    // Dos facturas distintas: cada una con su propia versión.
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    expect(editStub.versions[OTHER_INVOICE_ID]).toBe(1);
    // Y cada una movió su propio ajuste: dos movimientos, uno por factura.
    expect(editStub.movements).toHaveLength(2);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: una versión vencida rechaza la edición y no mueve stock", async () => {
    // Sin carrera: la fila ya no está en la versión que se leyó, así que el
    // UPDATE afecta 0 filas. Es la MISMA ruta de error que produce la carrera
    // perdida, y prueba que el rechazo no depende del intercalado del test.
    editStub.staleGuard = true;

    const outcome = await freeEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    // El mensaje nombra el conflicto y dice qué hacer: es un rechazo accionable,
    // no un 500.
    expect((outcome as BillingError).message).toContain("simultánea");
    expect(editStub.versionGuards).toEqual([0]);
    // Nada más que el CAS rechazado: ni stock, ni auditoría, ni una fila.
    expect(editStub.movements).toEqual([]);
    expect(overCollectionStub.auditInsert).toBeNull();
    expect(overCollectionStub.writes).toEqual(["invoices.update"]);
  });

  it("una edición sin carrera sigue funcionando de punta a punta", async () => {
    const detail = await freeEdit();

    expect(detail.invoice.total).toBe(STUB_EMITTED_TOTAL);
    // Non-vacuidad del candado: la guarda se miró, la versión avanzó y el ajuste
    // se aplicó UNA vez.
    expect(editStub.versionGuards).toEqual([0]);
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({ type: "OUT", qty: QTY_DELTA });
    expect(overCollectionStub.writes).toContain("invoices.update");
    expect(overCollectionStub.writes).toContain("audit_logs.insert");
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });
});

// ------------- CL-1: el candado de edición cubre el ESTADO ----------------
//
// `claimInvoiceEdit` reclamaba el token de edición con un compare-and-swap
// sobre `invoices.edit_version` y nada más. La edición decide con la lectura que
// la abre (`getInvoiceDetail`): Anulada es terminal y la edición libre rechaza
// Pagada. Pero esa lectura no es la fila: entre el `read` y el candado cabe otra
// escritura —una anulación, que además revierte stock, o un cobro que cierra la
// factura—, y la edición en vuelo aplicaba igual sobre la fila ya anulada o ya
// pagada. El estado quedaba bien y los ítems, el stock y las comisiones se
// escribían DESPUÉS del hecho terminal.
//
// El precedente hermano es `annulInvoice`, que ya hace
// `.eq("id", id).eq("status", detail.invoice.status)` y mapea las 0 filas a
// `ANNUL_CONFLICT`. Acá el estado entra en el MISMO compare-and-swap y las 0
// filas siguen saliendo por el MISMO `EDIT_CONFLICT` (409): lo que cambia para
// la carrera es el mensaje —ahora nombra el estado—, no el código.
//
// El intercalado es real, no simulado: la edición se detiene EN su candado, el
// test mueve el estado de la fila como lo haría la anulación que ganó esa
// ventana, y recién ahí la libera. El doble aplica `.eq("status", v)` como
// PostgREST, así que una guarda que el servicio no mande no puede rechazar nada.

describe("billing: el candado de edición cubre el estado de la factura (CL-1)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Cantidad final: 1 → 3. El delta es +2 (dos unidades de descuento). */
  const QTY_DELTA = 2;

  /** Línea de PRODUCTO de la factura (el origen del delta de stock). */
  function productLine(invoiceId: string, itemId: string, qty: number, unitPrice: number) {
    return {
      ...annulProductItemRow(),
      id: itemId,
      invoice_id: invoiceId,
      qty,
      unit_price: unitPrice,
      subtotal: qty * unitPrice,
    };
  }

  /** La MISMA línea con qty 3 a 100.000: el subtotal queda intacto (300.000). */
  function payload(itemId: string) {
    return {
      items: [
        {
          id: itemId,
          item_type: "producto",
          product_id: PRODUCT_ID,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 1 + QTY_DELTA,
          unit_price: 100000,
          discount: 0,
          no_commission: true,
        },
      ],
      payments: [],
    };
  }

  /** Edición ADMIN (total inmutable + motivo). */
  function adminEdit() {
    return editInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      { ...payload(overCollectionStub.ITEM_ID), motivo: "Cantidad mal digitada" },
      ACTOR,
    );
  }

  /** Edición LIBRE de emitida (cajera/turno; acá admin, que también puede). */
  function freeEdit() {
    return editEmittedInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      payload(overCollectionStub.ITEM_ID),
      ACTOR,
    );
  }

  /**
   * Arranca una edición y espera —por SONDEO, igual que el bloque CO-1— a que su
   * próxima escritura (el compare-and-swap) quede EN VUELO. Con la edición
   * detenida se mueve el estado de la fila y recién ahí se libera: la edición ya
   * leyó Emitida y el candado evalúa el estado NUEVO.
   */
  async function startHeldEdit(start: () => Promise<unknown>): Promise<{ pending: unknown }> {
    editStub.holdNextWrite = true;
    editStub.releaseWrite = null;
    const pending = start().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 400 && !editStub.releaseWrite; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Si la edición falla antes de escribir, el sondeo no ve la escritura y la
    // prueba falla a la vista, sin quedarse esperando.
    expect(editStub.releaseWrite).not.toBeNull();
    // Non-vacuidad del intercalado: la edición ya leyó la factura y todavía no
    // escribió nada (el candado es su primera escritura).
    expect(editStub.events).toEqual(["read"]);
    // La promesa vuelve DENTRO de un objeto a propósito: `return pending` en una
    // función async adoptaría la promesa y esperaría a que la edición (detenida)
    // termine —justo lo contrario de lo que el test necesita.
    return { pending };
  }

  beforeEach(() => {
    editStub.active = true;
    editStub.versions = {};
    editStub.statuses = {};
    editStub.versionGuards.length = 0;
    editStub.statusGuards.length = 0;
    editStub.staleGuard = false;
    editStub.movements.length = 0;
    editStub.events.length = 0;
    editStub.holdNextWrite = false;
    editStub.releaseWrite = null;
    editStub.onWriteHeld = null;
    editStub.product = annulProductRow();
    editStub.itemsByInvoice = {
      [overCollectionStub.INVOICE_ID]: [
        productLine(overCollectionStub.INVOICE_ID, overCollectionStub.ITEM_ID, 1, STUB_EMITTED_TOTAL),
      ],
    };
    overCollectionStub.payments = [];
    overCollectionStub.invoiceUpdate = null;
    overCollectionStub.auditInsert = null;
    overCollectionStub.writes.length = 0;
    overCollectionStub.unexpectedQueries.length = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  afterEach(() => {
    editStub.active = false;
    editStub.holdNextWrite = false;
    editStub.releaseWrite?.();
    editStub.releaseWrite = null;
    editStub.onWriteHeld = null;
    editStub.versions = {};
    editStub.statuses = {};
    editStub.versionGuards.length = 0;
    editStub.statusGuards.length = 0;
    editStub.staleGuard = false;
    editStub.movements.length = 0;
    editStub.events.length = 0;
    editStub.product = null;
    editStub.itemsByInvoice = {};
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  it("una edición en vuelo NO se aplica si la factura se anula entre la lectura y el candado", async () => {
    const { pending } = await startHeldEdit(() => adminEdit());

    // La anulación gana la ventana lectura→candado: deja la fila terminal (y
    // revierte stock, fuera de este doble). Es el desenlace que la edición ya
    // había leído como Emitida.
    editStub.statuses[overCollectionStub.INVOICE_ID] = "Anulada";
    if (editStub.releaseWrite) editStub.releaseWrite();

    const outcome = await pending;
    // El síntoma del hallazgo: la edición se aplicaba igual sobre la anulada.
    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    // El rechazo es accionable y nombra lo que pasó: el estado se movió.
    expect((outcome as BillingError).message).toContain("estado");
    expect((outcome as BillingError).message).toContain("simultánea");
    // La precondición de estado salió de la LECTURA (Emitida), no de re-leer la
    // fila ya anulada: el candado compara contra lo que se decidió.
    expect(editStub.statusGuards).toEqual(["Emitida"]);
    // Y no se ajustó nada: ni el token avanzó (el doble solo anota la versión
    // cuando el CAS APLICA), ni hubo stock, ni auditoría, ni una segunda
    // escritura (la única es el CAS rechazado).
    expect(editStub.versions, "el CAS no aplicó: la versión de la fila no avanzó").toEqual({});
    expect(editStub.movements).toEqual([]);
    expect(overCollectionStub.auditInsert).toBeNull();
    expect(overCollectionStub.writes).toEqual(["invoices.update"]);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("lo mismo si el cobro cierra la factura (Pagada) entre la lectura y el candado", async () => {
    const { pending } = await startHeldEdit(() => freeEdit());

    editStub.statuses[overCollectionStub.INVOICE_ID] = "Pagada";
    if (editStub.releaseWrite) editStub.releaseWrite();

    const outcome = await pending;
    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    expect(editStub.statusGuards).toEqual(["Emitida"]);
    expect(editStub.movements).toEqual([]);
    expect(overCollectionStub.writes).toEqual(["invoices.update"]);
  });

  it("control anti-extralimitación: la edición legítima sigue aplicándose con su estado", async () => {
    const outcome = await freeEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBe("aplicada");
    // El candado llevó las DOS mitades de la precondición, y el estado que se
    // leyó: sin carrera la guarda coincide y la edición pasa.
    expect(editStub.statusGuards).toEqual(["Emitida"]);
    expect(editStub.versionGuards).toEqual([0]);
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    // Y el ajuste se aplicó UNA vez.
    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({
      product_id: PRODUCT_ID,
      type: "OUT",
      qty: QTY_DELTA,
    });
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });
});

// ------------- MO-1: la emisión repetida no emite dos veces ----------------
//
// El defecto: `createInvoice` reservaba un consecutivo e insertaba la factura
// sin mirar nada del ENVÍO, así que reenviar la MISMA emisión (doble clic, o el
// navegador reintentando tras cortarse la red) reservaba un NUEVO consecutivo y
// escribía una SEGUNDA factura con su propia salida de stock y su propia
// comisión.
//
// La decisión del dueño: dos envíos idénticos son UNA factura, y se reconocen
// por la MARCA que manda la pantalla, no por el contenido. Deduplicar por
// CONTENIDO bloquearía una venta legítimamente repetida —dos clientes distintos
// comprando lo mismo, o el mismo cliente comprando dos veces—; la marca es lo
// único que distingue "el mismo envío" de "el mismo contenido".

/** Emisión de una línea de producto con su cobro completo en efectivo. */
function emissionPayload(extra: Record<string, unknown> = {}) {
  return {
    idempotency_key: IDEMPOTENCY_KEY,
    items: [
      {
        item_type: "producto",
        product_id: PRODUCT_ID,
        employee_id: EMPLOYEE_ID,
        qty: 2,
        unit_price: 35000,
        discount: 0,
        no_commission: false,
        commission_value: 1000,
        commission_mode: "comision",
      },
    ],
    discount: 0,
    payments: [{ method_code: "efectivo", amount: 70000 }],
    ...extra,
  };
}

describe("billing: la emisión repetida no emite dos veces (MO-1)", () => {
  const ACTOR: BillingActor = { userId: "u-1", sedeId: createStub.SEDE_ID, roles: ["admin"] };

  beforeEach(() => {
    createStub.active = true;
    createStub.invoices = [];
    createStub.items = [];
    createStub.payments = [];
    createStub.movements = [];
    createStub.consecutives = [];
    createStub.inserts = {};
    createStub.skipLookupOnce = false;
    createStub.unexpectedQueries = [];
  });

  afterEach(() => {
    createStub.active = false;
  });

  it("reenviar la misma emisión devuelve la MISMA factura: una fila, un consecutivo, una salida de stock, una comisión", async () => {
    const first = await createInvoice(emissionPayload(), ACTOR);
    const second = await createInvoice(emissionPayload(), ACTOR);

    // Hoy esto es DOS: el `[1, 2]` del segundo expect es el defecto verbatim.
    expect(createStub.consecutives).toEqual([1]);
    expect(createStub.invoices).toHaveLength(1);
    // El reintento es un NO-OP EXITOSO para el llamador: la misma factura, no
    // un error de negocio.
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.invoice.consecutive_number).toBe(first.invoice.consecutive_number);
    expect(second.invoice.total).toBe(first.invoice.total);
    expect(second.invoice.status).toBe("Pagada");
    // Una sola escritura de cada cosa: la comisión vive en la ÚNICA línea
    // (payroll la deriva de ahí), así que una línea es una comisión.
    expect(createStub.inserts.invoice_items).toBe(1);
    expect(createStub.items).toHaveLength(1);
    expect(createStub.items[0]).toMatchObject({ commission_mode: "comision", commission_value: 1000 });
    expect(createStub.inserts.invoice_payments).toBe(1);
    expect(createStub.inserts.inventory_movements).toBe(1);
    // El reintento ni siquiera INTENTÓ escribir la factura: lo detectó antes.
    expect(createStub.inserts.invoices).toBe(1);
    expect(createStub.movements).toHaveLength(1);
    expect(createStub.movements[0]).toMatchObject({ type: "OUT", qty: 2 });
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS facturas", async () => {
    // Un "solo una factura" global pasaría el caso anterior y sería incorrecto:
    // esto es una venta repetida legítima (mismo contenido, envío distinto).
    const first = await createInvoice(emissionPayload(), ACTOR);
    const second = await createInvoice(
      emissionPayload({ idempotency_key: OTHER_IDEMPOTENCY_KEY }),
      ACTOR,
    );

    expect(createStub.consecutives).toEqual([1, 2]);
    expect(createStub.invoices).toHaveLength(2);
    expect(second.invoice.id).not.toBe(first.invoice.id);
    expect(second.invoice.consecutive_number).toBe(2);
    expect(createStub.movements).toHaveLength(2);
    expect(createStub.items).toHaveLength(2);
    // Y reenviar la SEGUNDA marca sigue devolviendo la segunda factura, no la
    // primera: el mapa es por marca.
    const repeat = await createInvoice(
      emissionPayload({ idempotency_key: OTHER_IDEMPOTENCY_KEY }),
      ACTOR,
    );
    expect(repeat.invoice.id).toBe(second.invoice.id);
    expect(createStub.invoices).toHaveLength(2);
    expect(createStub.consecutives).toEqual([1, 2]);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) devuelve la factura existente y deja el consecutivo como hueco reportado", async () => {
    const first = await createInvoice(emissionPayload(), ACTOR);
    // La otra emisión se confirmó entre el lookup y el INSERT de esta: el doble
    // saltea el lookup para armar exactamente esa ventana.
    createStub.skipLookupOnce = true;

    const second = await createInvoice(emissionPayload(), ACTOR);

    // Devuelve la factura de la ganadora: el reintento sigue siendo un no-op.
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(createStub.invoices).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó (dos intentos, una
    // fila). Si el lookup hubiera encontrado la marca, el segundo INSERT no
    // existiría y este camino nunca se habría ejercitado.
    expect(createStub.inserts.invoices).toBe(2);
    // COSTO DECLARADO, no escondido: la perdedora reservó el consecutivo 2, el
    // índice único cortó su INSERT y esa reserva quedó SIN factura. Dos
    // consecutivos reservados, una factura: el hueco es real y está a la vista.
    expect(createStub.consecutives).toEqual([1, 2]);
    expect(createStub.consecutives.length - createStub.invoices.length).toBe(1);
    // Nada más se escribió: sin segunda línea, sin segundo movimiento.
    expect(createStub.items).toHaveLength(1);
    expect(createStub.movements).toHaveLength(1);
  });

  it("una marca mal formada se rechaza y no reserva consecutivo ni escribe nada", async () => {
    const outcome = await createInvoice(
      emissionPayload({ idempotency_key: "no-es-un-uuid" }),
      ACTOR,
    ).then(
      () => "emitida" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de cualquier escritura: el rechazo es barato.
    expect(createStub.consecutives).toEqual([]);
    expect(createStub.invoices).toEqual([]);
    expect(createStub.movements).toEqual([]);
  });

  it("una emisión SIN marca se rechaza: no es un passthrough sin protección", async () => {
    // Decisión explícita: la marca es OBLIGATORIA. Aceptar un envío sin marca es
    // reabrir el defecto para ese llamador —y la ruta REST es una superficie
    // pública, justo la que reintenta sobre redes—. El rechazo es ruidoso.
    const payload = emissionPayload();
    delete (payload as { idempotency_key?: unknown }).idempotency_key;

    const outcome = await createInvoice(payload, ACTOR).then(
      () => "emitida" as const,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(BillingError);
    expect(outcome).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(createStub.consecutives).toEqual([]);
    expect(createStub.invoices).toEqual([]);
  });

  it("control negativo: la marca manda, no el contenido (misma marca, contenido distinto = la factura ya emitida)", async () => {
    const first = await createInvoice(emissionPayload(), ACTOR);
    // Mismo envío (misma marca) con el carrito cambiado: se reconoce por la
    // marca y NO se emite una segunda factura con el contenido nuevo.
    const second = await createInvoice(
      emissionPayload({ discount: 5000, payments: [{ method_code: "efectivo", amount: 65000 }] }),
      ACTOR,
    );

    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.invoice.total).toBe(70000);
    expect(createStub.invoices).toHaveLength(1);
    expect(createStub.consecutives).toEqual([1]);
  });

  it("la migración 041 guarda la marca con un índice único PARCIAL y no reescribe filas", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "041_invoice_idempotency.sql"),
      "utf8",
    );
    // La prosa explica justamente lo que NO hace el archivo y nombra esas
    // sentencias; las aserciones de abajo miran el SQL, sin los comentarios.
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // La columna nace NULL: las filas ya emitidas no tienen marca y no hay
    // backfill que inventar.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key");
    // La barrera final: a lo sumo una factura por marca y sede.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_sede_idempotency_key");
    expect(sql).toContain("ON public.invoices (sede_id, idempotency_key)");
    // PARCIAL: las filas históricas (marca NULL) quedan fuera del índice.
    expect(sql).toContain("WHERE idempotency_key IS NOT NULL");
    // No borra ni reescribe filas ni toca el consecutivo de 005.
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.invoices\b/i);
    expect(sql).not.toMatch(/consecutive_number/);
  });
});

// ------------- CL-2: el cobro repetido no cobra dos veces -------------------
//
// El defecto reportado: `splitPayment` leía el saldo y DESPUÉS insertaba las
// porciones en `invoice_payments`, sin ninguna marca del ENVÍO y sin barrera de
// identidad, igual que `payPayrollItem`.
//
// LO MEDIDO, que corrige el diagnóstico: en el cobro de factura el dinero NO se
// cobra dos veces. `splitPayment` exige que el NETO de las porciones iguale el
// SALDO exacto, así que después de un cobro bueno el saldo queda en cero y el
// reintento no llega ni a insertar: muere en la comprobación del saldo con
// OVERPAID (422). Lo que sí falta es el RECONOCIMIENTO: el reintento de una
// operación que SÍ se registró no se reconoce como repetición, y la protección
// descansa en una coincidencia aritmética (el cobro exacto) más el tope de 031
// —que sí frena la carrera concurrente— en vez de en la identidad del envío.
// Un cambio futuro de esa regla (permitir abonos parciales desde acá) abriría
// la puerta al doble cobro sin que nada lo avise. El test de abajo PINCHA las
// dos cosas: hoy no hay doble cobro, y hoy el reintento NO se reconoce.
//
// La decisión es la misma de la emisión (MO-1, 041) y del abono de nómina
// (CL-2, 042): dos envíos iguales son UNA operación y se reconocen por la MARCA
// que manda la pantalla, no por el contenido.
//
// LA ARRUGA, resuelta acá: una operación NO es una fila. El cobro inserta N
// porciones (una por método) en UNA sola sentencia multi-fila, así que un
// índice único sobre la marca a secas rechazaría la SEGUNDA porción de una
// operación legítima. La marca vive SÓLO en la primera porción y el índice es
// PARCIAL sobre (invoice_id, idempotency_key) WHERE NOT NULL: el 23505 aborta el
// INSERT completo, así que ninguna porción de una repetición sobrevive.

describe("billing: el cobro repetido no cobra dos veces (CL-2)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: payStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Marca del intento; la segunda existe para el control de no-extralimitación. */
  const MARK = "8d4e2b6a-5c39-4e71-a2b8-9f0d3c6e1a47";
  const OTHER_MARK = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const TOTAL = 100000;

  /** Factura Emitida sin cobros (una o dos, para el control de alcance). */
  function seedInvoice(id: string, consecutive: number, total = TOTAL): void {
    payStub.invoices.push({
      id,
      sede_id: payStub.SEDE_ID,
      consecutive_number: consecutive,
      client_name: null,
      client_document: null,
      subtotal: total,
      discount: 0,
      tax: 0,
      surcharge: 0,
      total,
      status: "Emitida",
      user_id: "u-1",
      cash_shift_id: payStub.SHIFT_ID,
      closed_by: null,
      closed_at: null,
      cancel_reason: null,
      created_at: "2026-01-01T00:00:00.000Z",
      edit_version: 0,
    });
  }

  const payInserts = () => payStub.inserts.invoice_payments ?? 0;

  /** Cobro de una sola porción que cierra el saldo. */
  function closeInvoice(invoiceId: string, amount = TOTAL, mark = MARK) {
    return {
      idempotency_key: mark,
      portions: [{ method_code: "efectivo", amount }],
    };
  }

  beforeEach(() => {
    payStub.invoices = [];
    payStub.payments = [];
    payStub.inserts = {};
    payStub.skipMarkLookupOnce = false;
    payStub.stalePaymentsOnce = null;
    payStub.unexpectedQueries = [];
    payStub.active = true;
    seedInvoice(payStub.INVOICE_ID, 7);
  });

  afterEach(() => {
    payStub.active = false;
  });

  it("RED: hoy el reintento del MISMO cobro no se reconoce (y el doble cobro no ocurre por el cobro exacto)", async () => {
    const first = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);
    const second: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    ).catch((error: unknown) => error);

    // LO MEDIDO, en una aserción para que no se pierda: hoy el reintento NO
    // escribe una segunda fila. El cobro exacto y el tope de 031 ya lo frenan.
    expect(payStub.payments).toHaveLength(1);
    expect(payInserts()).toBe(1);
    // Y lo que falta: que se reconozca como repetición en vez de morir en el
    // saldo. HOY: BillingError OVERPAID (422). Con la marca: el mismo detalle.
    expect(second).not.toBeInstanceOf(BillingError);
    expect(second).toMatchObject({ invoice: { id: first.invoice.id, status: "Pagada" } });
    expect((second as { payments: unknown[] }).payments).toHaveLength(1);
  });

  it("la repetición devuelve el MISMO resultado escribiendo nada (no-op exitoso)", async () => {
    const first = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);
    const repeat = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);

    expect(repeat.invoice.id).toBe(first.invoice.id);
    expect(repeat.invoice.status).toBe("Pagada");
    expect(repeat.invoice.total).toBe(first.invoice.total);
    expect(repeat.paid).toBe(first.paid);
    expect(repeat.remaining).toBe(0);
    // El reintento ni siquiera INTENTÓ escribir: lo reconoció antes.
    expect(payInserts()).toBe(1);
    expect(payStub.payments).toHaveLength(1);
    expect(payStub.unexpectedQueries).toEqual([]);
  });

  it("la carrera (lectura vieja del saldo + marca ya confirmada) relee a la ganadora", async () => {
    const first = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);
    // La otra petición leyó el saldo ANTES de que la ganadora confirmara (el
    // doble le sirve el snapshot viejo una sola vez) y tampoco vio la marca (el
    // doble saltea ese lookup una vez): así pasa la comprobación exacta y llega
    // al INSERT como pasaría en la base, sin que el test invente el desenlace.
    payStub.stalePaymentsOnce = [];
    payStub.skipMarkLookupOnce = true;

    const second = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);

    // El reintento sigue siendo un no-op: devuelve la factura de la ganadora.
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(second.invoice.status).toBe("Pagada");
    expect(payStub.payments).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó y lo frenó el tope de
    // 031 (el trigger corre ANTES del índice y ve la fila confirmada). Sin el
    // reconocimiento por marca, ese camino terminaba en OVERPAID.
    expect(payInserts()).toBe(2);
    // Y el lookup del reintento lo ve a la ganadora: su fila es la que quedó.
    expect(payStub.payments).toHaveLength(1);
    expect(payStub.payments[0].idempotency_key).toBe(MARK);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS cobros", async () => {
    // Un "un solo cobro por factura" global pasaría el primer caso y estaría
    // mal. En esta puerta el cobro exacto impide un segundo cobro sobre la
    // MISMA factura (el saldo queda en cero), así que el control se hace con
    // dos facturas: la marca reconoce UNA operación, no encadena cobros.
    seedInvoice(payStub.OTHER_INVOICE_ID, 8);
    const first = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);
    const second = await splitPayment(
      payStub.SEDE_ID,
      payStub.OTHER_INVOICE_ID,
      closeInvoice(payStub.OTHER_INVOICE_ID, TOTAL, OTHER_MARK),
      ACTOR,
    );

    expect(payStub.payments).toHaveLength(2);
    expect(payInserts()).toBe(2);
    expect(second.invoice.id).not.toBe(first.invoice.id);
    expect(second.invoice.status).toBe("Pagada");
    // Y repetir la SEGUNDA marca devuelve la SEGUNDA factura, no la primera.
    const repeat = await splitPayment(
      payStub.SEDE_ID,
      payStub.OTHER_INVOICE_ID,
      closeInvoice(payStub.OTHER_INVOICE_ID, TOTAL, OTHER_MARK),
      ACTOR,
    );
    expect(payStub.payments).toHaveLength(2);
    expect(repeat.invoice.id).toBe(second.invoice.id);
  });

  it("una operación de VARIAS porciones no la rechaza su propio índice único", async () => {
    // La arruga: dos porciones (una por método) en UNA sola operación.
    const portions = {
      idempotency_key: MARK,
      portions: [
        { method_code: "efectivo", amount: 60000 },
        { method_code: "transferencia", amount: 40000 },
      ],
    };
    const result = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, portions, ACTOR);

    // UNA sentencia multi-fila (no dos inserts fila por fila): es la premisa de
    // la que depende que el 23505 aborte la operación entera.
    expect(payInserts()).toBe(1);
    expect(payStub.payments).toHaveLength(2);
    // La marca vive SOLO en la primera porción: si estuviera en las dos, el
    // propio índice la rechazaría (y el doble, como Postgres, lo haría).
    expect(payStub.payments[0]).toMatchObject({
      idempotency_key: MARK,
      amount: 60000,
      method_code: "efectivo",
    });
    expect(payStub.payments[1]).toMatchObject({ idempotency_key: null, amount: 40000 });
    expect(result.invoice.status).toBe("Pagada");

    // Y repetir ESA operación también es un no-op: las dos porciones.
    const repeat = await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, portions, ACTOR);
    expect(payStub.payments).toHaveLength(2);
    expect(payInserts()).toBe(1);
    expect(repeat.payments).toHaveLength(2);
  });

  it("control negativo: la marca no cambia la aritmética del cobro", async () => {
    // Una marca nueva NO convierte en cobrable lo que el saldo rechaza: la
    // comprobación exacta y el tope siguen mandando, con marca o sin ella.
    const failure: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID, 60000),
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "SUM_MISMATCH", status: 422 });
    expect(payStub.payments).toHaveLength(0);
    expect(payInserts()).toBe(0);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    // Decisión explícita, igual que en la emisión: la marca es OBLIGATORIA. Un
    // envío sin marca no se puede reconocer como repetición, y la ruta REST es
    // pública: es justo la que reintenta sobre redes. El rechazo es ruidoso.
    const withoutMark: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      { portions: [{ method_code: "efectivo", amount: TOTAL }] },
      ACTOR,
    ).catch((error: unknown) => error);
    const malformed: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      { idempotency_key: "no-es-un-uuid", portions: [{ method_code: "efectivo", amount: TOTAL }] },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(BillingError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(BillingError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de leer el detalle y de cualquier escritura.
    expect(payInserts()).toBe(0);
    expect(payStub.payments).toHaveLength(0);
  });

  it("el esquema exige la marca y mantiene la exigencia de porciones", () => {
    expect(splitPaymentSchema.safeParse({ portions: [] }).success).toBe(false);
    expect(
      splitPaymentSchema.safeParse({ portions: [{ method_code: "efectivo", amount: TOTAL }] }).success,
    ).toBe(false);
    expect(
      splitPaymentSchema.safeParse({ idempotency_key: "no-es-un-uuid", portions: [{ method_code: "efectivo", amount: TOTAL }] })
        .success,
    ).toBe(false);
    expect(
      splitPaymentSchema.safeParse({
        idempotency_key: MARK,
        portions: [{ method_code: "efectivo", amount: TOTAL }],
      }).success,
    ).toBe(true);
  });
});
