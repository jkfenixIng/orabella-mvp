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
  normalizeCommissionFields,
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
  buildInvoiceOutReasonTemplate,
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
import { sameEmployeeProductLine } from "@/app/invoices/invoices-client";

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
    // CL-13: el descuento dejó de ser un segundo request del cliente —el plan se
    // computa con la frontera de inventario (`getProductsStock` +
    // `planStockDeduction`) y viaja como DATO (`p_out_items`) a la transacción de
    // la emisión, que lo escribe con `deduct_stock_atomic` (046), con su conteo y
    // su trigger. Billing sigue sin tocar las tablas de inventario.
    expect(service).toContain("planStockDeduction");
    expect(service).toContain("getProductsStock");
    expect(service).toContain("p_out_items:");
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
  /**
   * CL-12: impuestos ACTIVOS de la sede (lo que responde `listTaxes`). Vacío en
   * todos los bloques menos el de la edición libre, que necesita un snapshot de
   * impuestos NO vacío para poder probar que el reemplazo es todo-o-nada.
   */
  taxes: [] as Array<{
    code: string;
    name: string;
    percent: number;
    is_active: boolean;
  }>,
  /** Consultas que el doble no sabe responder: debe quedar SIEMPRE vacío. */
  unexpectedQueries: [] as string[],
}));

/**
 * CL-11: cola de locks por FILA. Modela el `SELECT … FOR UPDATE` de la
 * transacción de la 050: el segundo llamador ESPERA a que el primero suelte la
 * fila, en vez de leer su estado viejo y escribir por su lado. Es lo que hace
 * observable la serialización (y lo que impide el intercalado que producía el
 * estado parcial). Devuelve también si TUVO que esperar, para poder trazarlo.
 */
function createRowLocks(): (
  key: string,
  onContended: () => void,
) => Promise<{ release: () => void; waited: boolean }> {
  const held = new Map<string, Promise<void>>();
  return async (key, onContended) => {
    const previous = held.get(key);
    if (previous) onContended();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = (previous ?? Promise.resolve()).then(() => current);
    held.set(key, queue);
    await previous;
    return {
      waited: previous !== undefined,
      release: () => {
        release();
        if (held.get(key) === queue) held.delete(key);
      },
    };
  };
}

/**
 * CL-11: los locks por fila son de MÓDULO, no del doble.
 *
 * `createAdminClient()` devuelve una instancia nueva en cada llamada al servicio
 * (`billingDb()`), así que un mapa por instancia no serializaría NADA: dos
 * llamadas al mismo servicio tendrían cada una su cola. En la base el lock es
 * uno solo —la fila—, y eso es lo que el doble tiene que modelar.
 */
const annulRowLocks = createRowLocks();
const splitRowLocks = createRowLocks();
/**
 * CL-12: el lock de la fila de la FACTURA en las dos ediciones. Es el MISMO
 * candado que la 038 pedía desde el cliente (`edit_version`), ahora tomado por
 * `SELECT … FOR UPDATE` dentro de la transacción (051): la edición que llega
 * segunda ESPERA a la primera en vez de leer su estado viejo y escribir por su
 * lado.
 */
const editRowLocks = createRowLocks();

/**
 * Espera —con techo— a que el doble registre algo. Se usa para aseverar un
 * intercalado ("la segunda edición quedó esperando el lock") sin depender de un
 * tick ni de un temporizador fijo.
 */
async function waitFor(predicate: () => boolean, budgetMs = 400): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

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
  /**
   * CL-11: el N-ésimo movimiento de reversión NO se puede escribir (la
   * conexión se corta, el trigger rechaza). Es el fallo que cae ENTRE las dos
   * escrituras de la anulación y deja el estado parcial: sirve para medir la
   * ventana hoy y para probar el rollback después. `null` = no se inyecta.
   */
  failMovementAt: null as number | null,
  /**
   * CL-11: traza del RPC `invoice_annul_atomic`, en orden. `wait` = el llamador
   * encontró el lock de la fila tomado (en vez de leer el estado viejo) y
   * `resume` = lo obtuvo; `commit` = la transacción escribió y confirmó. Es la
   * prueba de que la segunda anulación ESPERA a la primera.
   */
  rpcEvents: [] as string[],
  /** CL-11: transacciones de anulación que CONFIRMARON (escribieron filas). */
  commits: 0,
  /**
   * CL-11: aviso de que una anulación quedó ESPERANDO el lock de la fila. El
   * test lo espera para aseverar el intercalado sin depender de un tick: sin
   * esto, la aserción podría correr antes de que la segunda llegue al RPC.
   */
  onLockWait: null as (() => void) | null,
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
  /**
   * CL-12: los productos de la sede que la consulta PIDE (`.in("id", …)`), para
   * que una edición pueda tocar DOS productos y escribir DOS movimientos: con
   * una sola fila fija, el "stock a medias" de una edición multi-producto no se
   * puede medir. Vacío = se usa `product` (los bloques de antes).
   */
  products: [] as Array<Record<string, unknown>>,
  /** Líneas de `invoice_items` por factura; ausente = la línea de siempre. */
  itemsByInvoice: {} as Record<string, Array<Record<string, unknown>>>,

  /**
   * CL-12: `invoice_taxes` por factura. La edición libre REEMPLAZA el snapshot
   * (borra el que leyó e inserta el que computó), así que el doble tiene que
   * poder mostrar las filas que quedaron: sin eso, "no se escribió nada" y "se
   * escribió todo" se verían iguales.
   */
  taxesByInvoice: {} as Record<string, Array<Record<string, unknown>>>,
  /**
   * CL-12: la escritura de ESTE grupo no se puede aplicar. En la ruta VIEJA —la
   * que mide el RED— cada escritura es un request suelto desde el cliente; en la
   * transacción (051) es un GRUPO de escritura. El nombre del grupo es el MISMO
   * en las dos rutas, para que la prueba del antes y la del después se lean
   * igual (el mapa está en `legacyEditWriteFails`).
   */
  failWriteKind: null as EditWriteKind | null,
  /**
   * Con `failWriteKind = "movements"`: cuál de los N movimientos (0 = el
   * primero). En la ruta vieja cada movimiento es un request y el N-ésimo es el
   * que falla —el stock queda A MEDIAS—; en la transacción los N son UNA
   * sentencia y el grupo falla entero (el offset no elige una fila: dentro de
   * una sentencia no hay filas a medio escribir).
   */
  failWriteOffset: 0,
  /**
   * CL-12: traza del RPC de edición, en orden. `wait` = el llamador encontró el
   * lock de la fila tomado; `resume` = lo obtuvo; `commit` = la transacción
   * escribió y confirmó; `reject` = la precondición o un grupo la abortaron.
   */
  rpcEvents: [] as string[],
  /** CL-12: transacciones de edición que CONFIRMARON (escribieron filas). */
  commits: 0,
  /** Aviso: una edición quedó ESPERANDO el lock de la fila. */
  onLockWait: null as (() => void) | null,
}));

/**
 * CL-12: el doble modela las DOS rutas de la edición a propósito.
 *
 * La de HOY es la transacción del RPC (los tres campos de arriba), y es la que
 * usan los describes. La de ANTES —la que la edición escribía desde el cliente—
 * sigue modelada (`editVersionResponse`, el `insert()` de movimientos y
 * `legacyEditWriteFails`) porque es la que hace REPRODUCIBLE el RED: con el
 * código previo a la 051, `editStub.failWriteKind` cae en la escritura de
 * cliente equivalente y el test vuelve a medir los ítems escritos, el stock a
 * medias y el token avanzado. Sin eso, la medición del defecto se perdería.
 */
type EditWriteKind =
  | "invoice"
  | "taxes-remove"
  | "taxes-insert"
  | "items-remove"
  | "items-update"
  | "items-insert"
  | "payments"
  | "movements";

/**
 * CL-13: qué punto de la emisión falla. El nombre del grupo es el MISMO en las
 * dos rutas que el doble modela a propósito —en la ruta VIEJA cada grupo es un
 * request suelto del cliente; en la transacción del RPC son grupos de UNA
 * sentencia—, para que la medición del defecto y la prueba del arreglo se lean
 * igual. `detail` no es un grupo de escritura: es la RELECTURA del detalle
 * (`loadDetail`), el único punto de fallo que le queda a la emisión después de
 * que la deducción de 046 se volvió atómica.
 */
type EmissionGroup = "invoice" | "items" | "taxes" | "payments" | "stock" | "detail";

/**
 * CL-13: qué paso de la COMPENSACIÓN de la ruta vieja (`cleanupFailedInvoice`)
 * no se puede aplicar. Es el fallo que el `catch {}` de esa compensación se
 * tragaba en silencio.
 */
type CompensationStep = "stock" | "payments" | "taxes" | "items" | "invoice";

/**
 * MO-1 + CL-13: estado propio del camino de EMISIÓN (idempotencia de la factura
 * y atomicidad de la emisión).
 *
 * Encendido solo por el bloque de idempotencia y el de atomicidad: los demás
 * describe siguen con el doble de siempre. Mantiene el estado REAL que decide
 * el defecto —las filas de `invoices`, los consecutivos que devolvió
 * `next_invoice_number` y cuántas veces se escribió cada tabla—, y aplica de
 * verdad los dos índices únicos de la migración 041: un INSERT que repita
 * `(sede_id, consecutive_number)` o `(sede_id, idempotency_key)` responde 23505
 * y NO agrega fila, como Postgres.
 *
 * CL-13: el mismo doble modela las DOS rutas del camino de emisión. La de HOY es
 * la transacción del RPC `invoice_create_atomic` (una sentencia, todos los grupos
 * o ninguno, y el consecutivo reservado ADENTRO) y es la que usan los describes.
 * La de ANTES —la secuencia de requests sueltos del cliente más la compensación
 * de `cleanupFailedInvoice`— sigue modelada porque es la que hace REPRODUCIBLE
 * el RED: con el código previo a la 052, los mismos flags de fallo caen en las
 * escrituras equivalentes y el test vuelve a medir el residuo silencioso (la
 * factura viva con su dinero borrado, o el kardex con su OUT y su IN para una
 * factura que no existe). Sin eso, la medición del defecto se perdería.
 */
const createStub = vi.hoisted(() => ({
  active: false,
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  SHIFT_ID: "77777777-7777-4777-8777-777777777777",
  /** Filas de `invoices` realmente escritas (columnas de INVOICE_SELECT + la marca). */
  invoices: [] as Array<Record<string, unknown>>,
  /** Líneas, impuestos y porciones escritos: cuántas veces se movió cada cosa. */
  items: [] as Array<Record<string, unknown>>,
  /**
   * CL-13: filas de `invoice_taxes` (el snapshot). La ruta vieja las contaba
   * pero no las guardaba; ahora se guardan COMPLETAS —una fila por impuesto
   * activo— para poder afirmar que el grupo escribe lo que el servicio computó.
   */
  taxes: [] as Array<Record<string, unknown>>,
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
  /** CL-13: el grupo (o la relectura) que falla. `null` = camino normal. */
  failGroup: null as EmissionGroup | null,
  /** CL-13: el paso de la compensación de la ruta vieja que falla. */
  failCompensation: null as CompensationStep | null,
  /** CL-13: pasos de compensación EJECUTADOS, en orden (ruta vieja). */
  compensationSteps: [] as string[],
  /** CL-13: transacciones de emisión que CONFIRMARON (escribieron filas). */
  commits: 0,
  /** CL-13: traza del RPC de emisión, en orden (`reject` / `commit`). */
  rpcEvents: [] as string[],
  /** CL-13: llamadas al RPC, con sus argumentos: el DATO que viajó. */
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
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

  /**
   * CL-11: el error de escritura inyectado por `annulStub.failMovementAt`. Se
   * consume UNA sola vez, en la escritura que lo armó.
   */
  let forcedWriteError: { code: string; message: string } | null = null;

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
    /** CL-12: ids que la consulta de `products` pidió (`.eq`/`.in`). */
    productIds?: string[];
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

  /**
   * CL-12 (ruta VIEJA, la que mide el RED): a qué escritura de cliente
   * corresponde cada GRUPO de la transacción. Es el mismo nombre de grupo en las
   * dos rutas, así que la prueba del antes y la del después se leen igual.
   *
   * `movements` NO está acá: el N-ésimo movimiento se cae al construir el INSERT
   * (si no, la fila quedaría contada como escrita cuando la escritura falló).
   */
  const legacyEditWriteFails = (table: string, op: string): boolean => {
    switch (editStub.failWriteKind) {
      case "invoice":
        return table === "invoices" && op === "update";
      case "taxes-remove":
        return table === "invoice_taxes" && op === "delete";
      case "taxes-insert":
        return table === "invoice_taxes" && op === "insert";
      case "items-remove":
        return table === "invoice_items" && op === "delete";
      case "items-update":
        return table === "invoice_items" && op === "update";
      case "items-insert":
        return table === "invoice_items" && op === "insert";
      case "payments":
        return table === "invoice_payments" && op === "update";
      default:
        return false;
    }
  };

  const response = (
    table: string,
    op: string,
    ctx: QueryContext,
  ): { data: unknown; error: unknown } => {
    if (op !== "select") {
      overCollectionStub.writes.push(`${table}.${op}`);
      // CL-11: el fallo inyectado aborta ESTA escritura (y sólo el camino que
      // la pidió): es el fallo que hoy cae entre las dos escrituras.
      if (forcedWriteError) {
        const injected = forcedWriteError;
        forcedWriteError = null;
        return { data: null, error: injected };
      }
      // CL-12: el fallo de la EDICIÓN, escrito como grupo. En la ruta vieja
      // —la de hoy— cada grupo de la transacción es un request suelto: acá es
      // donde se puede medir que un fallo a mitad de la secuencia deja los
      // ítems y el stock a medias con la versión ya avanzada.
      if (editStub.active && legacyEditWriteFails(table, op)) {
        return { data: null, error: { code: "08006", message: "connection closed" } };
      }
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
        return {
          data: {
            ...stubInvoiceRow(STUB_EMITTED_TOTAL),
            // CL-12: la versión REAL de la fila, también fuera del bloque de
            // edición: la transacción escribe `edit_version` y una lectura
            // posterior tiene que ver lo que se escribió.
            edit_version: editStub.versions[ctx.rowId ?? overCollectionStub.INVOICE_ID] ?? 0,
          },
          error: null,
        };
      case "products": {
        if (!editStub.active) return { data: annulStub.product, error: null };
        // `getProductsStock` (lista, por `.in("id", …)`) y `getProduct` (fila,
        // por `.eq("id", …)`) comparten tabla: el doble sirve las filas que la
        // consulta PIDE —no una sola fija— porque una edición puede tocar DOS
        // productos (y escribir DOS movimientos de stock).
        const rows =
          editStub.products.length > 0
            ? editStub.products
            : editStub.product
              ? [editStub.product]
              : [];
        const wanted = ctx.productIds ?? [];
        const match = wanted.length > 0 ? rows.filter((row) => wanted.includes(String(row.id))) : rows;
        if (ctx.single) return { data: match[0] ?? null, error: null };
        return { data: match, error: null };
      }
      case "invoice_items":
        if (commissionStub.items) return { data: commissionStub.items, error: null };
        if (annulStub.active && annulStub.items) return { data: annulStub.items, error: null };
        if (editStub.active) {
          const id = ctx.itemsInvoiceId ?? overCollectionStub.INVOICE_ID;
          return { data: editStub.itemsByInvoice[id] ?? [stubItemRow()], error: null };
        }
        return { data: [stubItemRow()], error: null };
      case "invoice_taxes": {
        const id = ctx.itemsInvoiceId ?? overCollectionStub.INVOICE_ID;
        return { data: editStub.taxesByInvoice[id] ?? [], error: null };
      }
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
    /** CL-12: ids del `.eq`/`.in` de `products` (qué filas sirve el doble). */
    let productIds: string[] | undefined;
    // `select(cols, { count, head })`: PostgREST responde el total sin filas.
    let countRequested = false;
    let headOnly = false;
    // Las tablas NO registradas en `pagedStub` conservan la respuesta fija de
    // siempre: los filtros y la ventana se aceptan y se ignoran.
    const resolve = (single: boolean) => {
      const result =
        op === "select" && pagedStub.tables[table]
          ? pagedResponse(table, { filters, orderKeys, rangeFrom, rangeTo, single })
          : response(table, op, { statusGuard, versionGuard, rowId, itemsInvoiceId, single, productIds });
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
          // CL-11: la N-ésima reversión no se escribe: el fallo cae a mitad del
          // bucle de `registerMovement` (hoy) o dentro de la transacción (050).
          // CL-12: lo mismo para el N-ésimo movimiento de una EDICIÓN —el fallo
          // que hoy cae entre los ítems y el stock—, con `failWriteOffset`.
          const lateMovementFailure = editStub.active
            ? editStub.failWriteKind === "movements" && log.length === editStub.failWriteOffset
            : annulStub.failMovementAt === log.length + 1;
          if (lateMovementFailure) {
            forcedWriteError = { code: "08006", message: "connection closed" };
            return query;
          }
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
        if (table === "products" && column === "id") productIds = [String(value)];
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        if (table === "commission_rules") commissionStub.inSizes.push(values.length);
        if (table === "products" && column === "id") productIds = values.map(String);
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

  /**
   * CL-12: `invoice_edit_items_atomic` / `invoice_edit_emitted_atomic` (051).
   *
   * El doble modela la TRANSACCIÓN y, sobre todo, el REEMPLAZO: los ítems —y el
   * snapshot de impuestos— son una colección que se REEMPLAZA (se borra la que
   * se leyó y se inserta la nueva), no un apéndice. Por eso trabaja sobre un
   * estado APARTE (`staged`) y sólo lo publica si TODOS los grupos aplicaron: un
   * grupo que falla no deja medio reemplazo, deja el reemplazo entero sin hacer
   * —la colección anterior, intacta—. Un doble que escribiera directo sobre
   * `editStub.itemsByInvoice` no podría representar eso: el fallo de la segunda
   * mitad del reemplazo ya habría borrado la primera, que es exactamente el
   * estado a medias que este bloque mide.
   */
  const runEditTransaction = async (
    isEmittedEdit: boolean,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> => {
    const edit = (args?.p_edit ?? {}) as Record<string, unknown>;
    const id = String(args?.p_invoice_id ?? overCollectionStub.INVOICE_ID);
    // La sede ya NO viaja en la llamada (071): es la de la instalación, y el
    // doble escribe la de la factura que está editando.
    const sedeId = overCollectionStub.SEDE_ID;
    const userId = args?.p_user_id ?? null;
    const expectedVersion = Number(args?.p_expected_version ?? 0);
    const expectedStatus = String(args?.p_expected_status ?? "Emitida");

    const release = await editRowLocks(id, () => {
      editStub.rpcEvents.push("wait");
      editStub.onLockWait?.();
    });
    editStub.rpcEvents.push(release.waited ? "resume" : "lock");
    try {
      // Donde el test detiene la transacción: con el lock de la fila TOMADO y
      // antes de releer la precondición. Es el intercalado real de CL-1 (la
      // factura se anula entre la lectura del servicio y la transacción) y el de
      // CO-1 (la segunda edición espera este lock).
      if (editStub.holdNextWrite) {
        editStub.holdNextWrite = false;
        await new Promise<void>((resolve) => {
          editStub.releaseWrite = resolve;
          editStub.onWriteHeld?.();
        });
      }
      // La precondición del candado (versión + estado), RELEÍDA de la fila
      // BLOQUEADA y no del dato que mandó el llamador: es la mitad que el
      // servicio ya decidió y la 051 la repite adentro.
      editStub.versionGuards.push(expectedVersion);
      editStub.statusGuards.push(expectedStatus);
      if (
        editStub.staleGuard ||
        (editStub.versions[id] ?? 0) !== expectedVersion ||
        (editStub.statuses[id] ?? "Emitida") !== expectedStatus
      ) {
        editStub.rpcEvents.push("reject");
        editStub.events.push("write");
        return { data: null, error: { code: "P0001", message: "EDIT_CONFLICT" } };
      }

      const list = (key: string): Array<Record<string, unknown>> =>
        Array.isArray(edit[key]) ? (edit[key] as Array<Record<string, unknown>>) : [];
      const removeIds = list("items_remove").map((row) => String(row));
      const updates = list("items_update");
      const inserts = list("items_insert");
      const paymentsPayload = list("payments");
      const movementsPayload = list("movements");
      const taxesRemoveIds = list("taxes_remove").map((row) => String(row));
      const taxesPayload = list("taxes");
      const totals = (edit.totals ?? {}) as Record<string, unknown>;

      const staged = {
        items: [...(editStub.itemsByInvoice[id] ?? [stubItemRow()])],
        taxes: [...(editStub.taxesByInvoice[id] ?? [])],
        payments: overCollectionStub.payments.map((row) => ({ ...row })) as Array<
          Record<string, unknown>
        >,
        movements: [] as Array<Record<string, unknown>>,
        invoiceUpdate: {} as Record<string, unknown>,
        itemsWritten: 0,
      };

      // Los grupos, uno por sentencia de la 051 y en su MISMO orden.
      const groups: Array<{ kind: EditWriteKind; trace: string; run: () => void }> = [];
      groups.push({
        kind: "invoice",
        trace: "invoices.update",
        run: () => {
          // La edición ADMIN escribe SÓLO el token: el total es inmutable y su
          // función no tiene un grupo capaz de escribir dinero. La LIBRE
          // reescribe los totales en la MISMA sentencia que el token.
          staged.invoiceUpdate = isEmittedEdit
            ? {
                edit_version: expectedVersion + 1,
                subtotal: totals.subtotal,
                discount: totals.discount,
                tax: totals.tax,
                surcharge: totals.surcharge,
                total: totals.total,
              }
            : { edit_version: expectedVersion + 1 };
        },
      });
      if (isEmittedEdit) {
        groups.push({
          kind: "taxes-remove",
          trace: "invoice_taxes.delete",
          run: () => {
            staged.taxes = staged.taxes.filter((row) => !taxesRemoveIds.includes(String(row.id)));
          },
        });
        groups.push({
          kind: "taxes-insert",
          trace: "invoice_taxes.insert",
          run: () => {
            staged.taxes = taxesPayload.map((tax, index) => ({
              id: `tax-${id}-${index + 1}`,
              invoice_id: id,
              tax_code: tax.tax_code,
              tax_name: tax.tax_name,
              percent: tax.percent,
              amount: tax.amount,
            }));
          },
        });
      }
      groups.push({
        kind: "items-remove",
        trace: "invoice_items.delete",
        run: () => {
          staged.items = staged.items.filter((row) => !removeIds.includes(String(row.id)));
          staged.itemsWritten += removeIds.length;
        },
      });
      groups.push({
        kind: "items-update",
        trace: "invoice_items.update",
        run: () => {
          for (const update of updates) {
            const index = staged.items.findIndex((row) => String(row.id) === String(update.id));
            if (index === -1) continue;
            staged.items[index] = { ...staged.items[index], ...update };
          }
          staged.itemsWritten += updates.length;
        },
      });
      groups.push({
        kind: "items-insert",
        trace: "invoice_items.insert",
        run: () => {
          for (const item of inserts) {
            staged.items.push({
              id: `item-${id}-${staged.items.length + 1}`,
              invoice_id: id,
              created_at: "2026-01-01T00:00:00.000Z",
              employees: {
                full_name: "Empleada de prueba",
                employee_code: "E-01",
                commission_percent: 35,
                pay_type: "porcentaje",
                payout_mode: "normal",
              },
              ...item,
            });
          }
          staged.itemsWritten += inserts.length;
        },
      });
      groups.push({
        kind: "payments",
        trace: "invoice_payments.update",
        run: () => {
          for (const payment of paymentsPayload) {
            const index = staged.payments.findIndex((row) => String(row.id) === String(payment.id));
            if (index === -1) continue;
            staged.payments[index] = {
              ...staged.payments[index],
              method_code: payment.method_code,
              method_id: payment.method_id,
            };
          }
        },
      });
      groups.push({
        kind: "movements",
        trace: "inventory_movements.insert",
        run: () => {
          for (const movement of movementsPayload) {
            staged.movements.push({
              id: `mov-${id}-${staged.movements.length + 1}`,
              created_at: "2026-01-01T00:00:00.000Z",
              sede_id: sedeId,
              product_id: movement.product_id,
              type: movement.type,
              qty: movement.qty,
              reason: movement.reason,
              user_id: userId,
              idempotency_key: null,
            });
          }
        },
      });

      for (const group of groups) {
        // La escritura se PIDIÓ (queda trazada aunque revierta), pero si es el
        // grupo que el test marcó como imposible, la transacción aborta y NADA
        // de lo staged se publica.
        overCollectionStub.writes.push(group.trace);
        if (editStub.failWriteKind === group.kind) {
          editStub.rpcEvents.push("reject");
          return { data: null, error: { code: "08006", message: "connection closed" } };
        }
        group.run();
      }

      // COMMIT: se publica el estado staged, ENTERO.
      editStub.versions[id] = expectedVersion + 1;
      editStub.itemsByInvoice[id] = staged.items;
      editStub.taxesByInvoice[id] = staged.taxes;
      overCollectionStub.payments = staged.payments as typeof overCollectionStub.payments;
      editStub.movements.push(...staged.movements);
      overCollectionStub.invoiceUpdate = staged.invoiceUpdate;
      editStub.events.push("write");
      editStub.commits += 1;
      editStub.rpcEvents.push("commit");
      const total = isEmittedEdit ? Number(totals.total ?? STUB_EMITTED_TOTAL) : STUB_EMITTED_TOTAL;
      return {
        data: {
          invoice: {
            ...stubInvoiceRow(total),
            id,
            status: expectedStatus,
            edit_version: expectedVersion + 1,
            ...(isEmittedEdit
              ? {
                  subtotal: totals.subtotal,
                  discount: totals.discount,
                  tax: totals.tax,
                  surcharge: totals.surcharge,
                  total: totals.total,
                }
              : {}),
          },
          items: staged.itemsWritten,
          movements: staged.movements.length,
        },
        error: null,
      };
    } finally {
      release.release();
    }
  };

  /**
   * CL-11: `invoice_annul_atomic` (050). El doble modela la TRANSACCIÓN: toma el
   * lock de la fila de la factura, RELEE la precondición sobre la fila bloqueada
   * y aplica sus DOS grupos de escritura —la factura y las reversiones de
   * stock— o ninguno. Escribe las MISMAS filas que el camino viejo (el payload
   * de `overCollectionStub.invoiceUpdate` y las de `annulStub.movements`), así
   * que las aserciones de "exactamente lo mismo" siguen significando lo mismo.
   */
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    // CL-12: las dos ediciones, cada una UNA transacción.
    if (name === "invoice_edit_items_atomic") return runEditTransaction(false, args);
    if (name === "invoice_edit_emitted_atomic") return runEditTransaction(true, args);
    if (name !== "invoice_annul_atomic") {
      overCollectionStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `doble sin respuesta para rpc.${name}` } };
    }
    const invoiceId = String(args?.p_invoice_id ?? "");
    const expected = String(args?.p_expected_status ?? "");
    const release = await annulRowLocks(invoiceId, () => {
      annulStub.rpcEvents.push("wait");
      annulStub.onLockWait?.();
    });
    annulStub.rpcEvents.push(release.waited ? "resume" : "lock");
    try {
      // La precondición, releída de la fila BLOQUEADA (no del dato del llamador).
      annulStub.guards.push(expected);
      if (annulStub.updateMisses || annulStub.invoiceStatus !== expected) {
        annulStub.rpcEvents.push("reject");
        return { data: null, error: { code: "P0001", message: "ANNUL_CONFLICT" } };
      }
      const items = (args?.p_items ?? []) as Array<Record<string, unknown>>;
      // El fallo inyectado: la transacción no puede terminar su segundo grupo
      // (los movimientos), así que NO se aplica ninguno de los dos.
      if (annulStub.failMovementAt !== null && annulStub.failMovementAt <= items.length) {
        return { data: null, error: { code: "08006", message: "connection closed" } };
      }
      // Donde el test detiene la transacción: después del lock, antes de escribir.
      if (annulStub.holdNextWrite) {
        annulStub.holdNextWrite = false;
        await new Promise<void>((resolve) => {
          annulStub.releaseWrite = resolve;
          annulStub.onWriteHeld?.();
        });
      }
      // COMMIT: los dos grupos, o nada.
      const motivo = String(args?.p_motivo ?? "");
      overCollectionStub.invoiceUpdate = {
        status: "Anulada",
        cancel_reason: motivo,
        closed_by: args?.p_user_id ?? null,
        closed_at: args?.p_closed_at ?? null,
      };
      overCollectionStub.writes.push("invoices.update", "inventory_movements.insert");
      annulStub.invoiceStatus = "Anulada";
      for (const item of items) {
        annulStub.movements.push({
          id: `mov-${annulStub.movements.length + 1}`,
          created_at: "2026-01-01T00:00:00.000Z",
          sede_id: overCollectionStub.SEDE_ID,
          product_id: item.product_id,
          type: "IN",
          qty: item.qty,
          reason: item.reason,
          user_id: args?.p_user_id ?? null,
          idempotency_key: null,
        });
      }
      annulStub.commits += 1;
      annulStub.rpcEvents.push("commit");
      return {
        data: {
          ...stubInvoiceRow(STUB_EMITTED_TOTAL),
          status: "Anulada",
          cancel_reason: motivo,
          closed_by: args?.p_user_id ?? null,
          closed_at: args?.p_closed_at ?? null,
        },
        error: null,
      };
    } finally {
      release.release();
    }
  };

  return { from, rpc };
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
  /**
   * CL-13: los pasos de la COMPENSACIÓN de la ruta vieja. El doble los registra
   * —para poder afirmar que la transacción NO compensa porque no hay nada que
   * compensar— y permite inyectar el fallo de UNO: es exactamente el fallo que
   * el `catch {}` de `cleanupFailedInvoice` se tragaba.
   */
  const compensate = (
    step: CompensationStep,
    apply: () => void,
  ): { data: unknown; error: unknown } => {
    createStub.compensationSteps.push(step);
    if (createStub.failCompensation === step) {
      return { data: null, error: { code: "08006", message: "connection closed" } };
    }
    apply();
    return { data: null, error: null };
  };

  /** Grupo que falla, como error de escritura: en la ruta vieja es un request
   *  del cliente y en la transacción es un grupo de la misma sentencia; en las
   *  dos, el grupo NO se aplica. */
  const writeFailure = (): { data: unknown; error: unknown } => ({
    data: null,
    error: { code: "08006", message: "connection closed" },
  });

  /** Fila de `invoice_items` tal como la escribe el camino de emisión (el join
   *  embebido de ITEM_SELECT es de `loadDetail`). */
  const pushItemRows = (invoiceId: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      createStub.items.push({
        ...row,
        invoice_id: invoiceId,
        id: `item-${createStub.items.length + 1}`,
        created_at: "2026-01-01T00:00:00.000Z",
        employees: {
          full_name: "Empleada de prueba",
          employee_code: "E-01",
          commission_percent: 35,
          pay_type: "porcentaje",
          payout_mode: "normal",
        },
      });
    }
  };

  /** Fila de `invoice_taxes`: el snapshot COMPLETO, una fila por impuesto. */
  const pushTaxRows = (invoiceId: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      createStub.taxes.push({
        ...row,
        invoice_id: invoiceId,
        id: `tax-${createStub.taxes.length + 1}`,
      });
    }
  };

  /** Fila de `invoice_payments`: la porción que escribía el cliente. */
  const pushPaymentRows = (invoiceId: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      createStub.payments.push({
        ...row,
        invoice_id: invoiceId,
        id: `payment-${createStub.payments.length + 1}`,
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
  };

  /** Fila del kardex: el OUT de la emisión (la deducción la escribe el RPC). */
  const pushMovements = (rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      createStub.movements.push({
        ...row,
        id: `movement-${createStub.movements.length + 1}`,
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
  };

  /**
   * CL-13: el motivo del OUT como lo rinde la función: la plantilla trae el
   * token UNA vez y la PRIMERA ocurrencia se sustituye por el consecutivo que la
   * transacción reservó (el `overlay` del SQL). Si el token no está, la
   * transacción rechaza con OUT_REASON_INVALID, igual que la función.
   */
  const OUT_REASON_TOKEN = "{consecutivo}";
  const renderOutReason = (template: string, consecutive: number): string | null => {
    if (!template.includes(OUT_REASON_TOKEN)) return null;
    return template.replace(OUT_REASON_TOKEN, String(consecutive));
  };

  /**
   * CL-13: el doble de la TRANSACCIÓN de emisión (`invoice_create_atomic`, 052).
   *
   * Modela lo que decide el defecto, no lo que el test quiere oír: (a) la
   * barrera de la marca de la 041 se evalúa ADENTRO y su choque no escribe una
   * fila; (b) el consecutivo se reserva ADENTRO y sólo existe si la transacción
   * CONFIRMA —un aborto lo revierte, igual que el incremento de
   * `invoice_sequences`—; (c) los cuatro grupos de escritura (la factura, las
   * líneas, el snapshot de impuestos y las porciones) más el grupo de stock, o se
   * aplican TODOS o ninguno; (d) el motivo del OUT se rinde sustituyendo el
   * token por el consecutivo reservado, con la misma regla que la función (la
   * PRIMERA ocurrencia, como el `overlay` del SQL) y su ausencia rechaza con
   * OUT_REASON_INVALID; (e) el turno abierto es una precondición que se vuelve a
   * comprobar sobre la fila leída.
   */
  const createInvoiceTransaction = (args?: Record<string, unknown>) => {
    // La sede ya NO viaja en la llamada (071): la función la toma del TURNO que
    // bloquea, así que el doble la saca de la misma fila.
    const sedeId = String(createStub.shift?.sede_id ?? "");
    const mark = String(args?.p_idempotency_key ?? "");
    const invoice = (args?.p_invoice ?? {}) as Record<string, unknown>;
    const items = (args?.p_items ?? []) as Array<Record<string, unknown>>;
    const taxes = (args?.p_taxes ?? []) as Array<Record<string, unknown>>;
    const payments = (args?.p_payments ?? []) as Array<Record<string, unknown>>;
    const outItems = (args?.p_out_items ?? []) as Array<{ product_id: string; qty: number }>;
    // Una tentativa cuenta aunque la transacción aborte: el contador tiene el
    // MISMO significado que en la ruta vieja (escrituras PEDIDAS por tabla).
    createStub.inserts.invoices = (createStub.inserts.invoices ?? 0) + 1;

    // La precondición del turno, releída de la fila que el servicio ya leyó: la
    // transacción no es un camino para saltear una guarda.
    const shift = createStub.shift;
    if (!shift || shift.id !== args?.p_cash_shift_id || shift.status !== "abierto") {
      createStub.rpcEvents.push("reject");
      return { data: null, error: { code: "P0001", message: "SHIFT_NOT_OPEN" } };
    }
    // La barrera de la 041, adentro: la marca repetida aborta la transacción
    // entera (y con ella la reserva del consecutivo).
    if (
      createStub.invoices.some((row) => row.sede_id === sedeId && row.idempotency_key === mark)
    ) {
      createStub.rpcEvents.push("reject");
      return {
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "uq_invoices_sede_idempotency_key"',
        },
      };
    }
    // El grupo que falla aborta la transacción ENTERA: no se escribe un solo
    // grupo, y el consecutivo —que se reserva adentro— no llega a existir.
    if (createStub.failGroup !== null && createStub.failGroup !== "detail") {
      createStub.rpcEvents.push("reject");
      if (createStub.failGroup === "stock") {
        return { data: null, error: { code: "P0001", message: "INSUFFICIENT_STOCK" } };
      }
      if (createStub.failGroup === "payments") {
        return {
          data: null,
          error: {
            code: "P0001",
            message:
              "El cobro supera el neto facturado de la factura (total 70000, recargo 0, cobrado neto 0, nuevo neto 70000)",
          },
        };
      }
      return { data: null, error: { code: "08006", message: "connection closed" } };
    }
    // El motivo del OUT: la plantilla tiene que traer el token y se sustituye con
    // el consecutivo que esta MISMA transacción reservó.
    const consecutive = createStub.consecutives.length + 1;
    const reason = renderOutReason(String(args?.p_out_reason ?? ""), consecutive);
    if (outItems.length > 0 && reason === null) {
      createStub.rpcEvents.push("reject");
      return { data: null, error: { code: "P0001", message: "OUT_REASON_INVALID" } };
    }

    // COMMIT: o se aplican todos los grupos, o ninguno.
    createStub.consecutives.push(consecutive);
    const row: Record<string, unknown> = {
      id: `invoice-${createStub.invoices.length + 1}`,
      cancel_reason: null,
      edit_version: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      ...invoice,
      sede_id: sedeId,
      consecutive_number: consecutive,
      idempotency_key: mark,
      user_id: args?.p_user_id ?? null,
      cash_shift_id: args?.p_cash_shift_id ?? null,
    };
    createStub.invoices.push(row);
    const invoiceId = String(row.id);
    pushItemRows(invoiceId, items);
    createStub.inserts.invoice_items =
      (createStub.inserts.invoice_items ?? 0) + (items.length > 0 ? 1 : 0);
    pushTaxRows(invoiceId, taxes);
    createStub.inserts.invoice_taxes =
      (createStub.inserts.invoice_taxes ?? 0) + (taxes.length > 0 ? 1 : 0);
    // `cash_shift_id` no viaja por porción: la función escribe el escalar (el
    // mismo valor en todas, como lo hacía el cliente).
    pushPaymentRows(
      invoiceId,
      payments.map((portion) => ({ ...portion, cash_shift_id: args?.p_cash_shift_id ?? null })),
    );
    createStub.inserts.invoice_payments =
      (createStub.inserts.invoice_payments ?? 0) + (payments.length > 0 ? 1 : 0);
    pushMovements(
      outItems.map((item) => ({
        sede_id: sedeId,
        product_id: item.product_id,
        type: "OUT",
        qty: item.qty,
        reason,
        user_id: args?.p_user_id ?? null,
        idempotency_key: null,
      })),
    );
    createStub.inserts.inventory_movements =
      (createStub.inserts.inventory_movements ?? 0) + (outItems.length > 0 ? 1 : 0);
    createStub.commits += 1;
    createStub.rpcEvents.push("commit");
    return { data: row, error: null };
  };

  const from = (table: string) => {
    let op = "select";
    let single = false;
    let askedIdempotencyKey = false;
    let payload: Record<string, unknown> = {};
    /** Filas VERBATIM de un INSERT multi-fila (`payload` guarda la primera). */
    let insertedRows: Array<Record<string, unknown>> = [];
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
          // CL-13: el grupo de la FACTURA (el primer grupo de escritura). En la
          // ruta vieja es el INSERT del cliente; en la transacción, el mismo
          // grupo dentro de la sentencia.
          if (createStub.failGroup === "invoice") return writeFailure();
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
        if (op === "delete") {
          // CL-13 ruta VIEJA: la compensación borra la factura (después de sus
          // líneas, sus impuestos y sus porciones).
          //
          // El doble modela el ON DELETE CASCADE de las FK de 005: borrar la
          // factura arrastra sus hijos —PORQUE LA BASE LO HACE— y por eso los
          // cuatro `DELETE` de la compensación NO pesan lo mismo: un error en el
          // borrado de una línea, de un impuesto o de una porción queda TAPADO
          // por el borrado de la factura que viene después, y el único borrado
          // que de verdad carga el peso es el de la factura. Sin este cascade el
          // doble mostraría filas huérfanas que en la base son imposibles.
          return compensate("invoice", () => {
            const doomed = createStub.invoices.filter((row) => matches(row)).map((row) => row.id);
            createStub.invoices = createStub.invoices.filter((row) => !matches(row));
            createStub.items = createStub.items.filter((row) => !doomed.includes(row.invoice_id));
            createStub.taxes = createStub.taxes.filter((row) => !doomed.includes(row.invoice_id));
            createStub.payments = createStub.payments.filter(
              (row) => !doomed.includes(row.invoice_id),
            );
          });
        }
      }
      if (table === "invoice_items") {
        if (op === "insert") {
          // CL-13: el grupo de las líneas. En la ruta vieja es un request suelto
          // y el fallo NO escribe nada; en la transacción aborta los cuatro
          // grupos.
          if (createStub.failGroup === "items") return writeFailure();
          pushItemRows(String(payload.invoice_id), insertedRows);
          return { data: null, error: null };
        }
        if (op === "delete") {
          return compensate("items", () => {
            createStub.items = createStub.items.filter((row) => !matches(row));
          });
        }
        // La RELECTURA del detalle (`loadDetail`): el punto de fallo que le
        // queda a la emisión después de la deducción atómica de 046.
        if (createStub.failGroup === "detail") {
          createStub.failGroup = null;
          return writeFailure();
        }
        return { data: createStub.items.filter(matches), error: null };
      }
      if (table === "invoice_payments") {
        if (op === "insert") {
          // CL-13: el grupo del dinero que entra. El P0001 del tope de 031 es su
          // fallo real (el servicio lo traduce a OVERPAID).
          if (createStub.failGroup === "payments") {
            return {
              data: null,
              error: {
                code: "P0001",
                message:
                  "El cobro supera el neto facturado de la factura (total 70000, recargo 0, cobrado neto 0, nuevo neto 70000)",
              },
            };
          }
          pushPaymentRows(String(payload.invoice_id), insertedRows);
          return { data: null, error: null };
        }
        if (op === "delete") {
          return compensate("payments", () => {
            createStub.payments = createStub.payments.filter((row) => !matches(row));
          });
        }
        return { data: createStub.payments.filter(matches), error: null };
      }
      if (table === "invoice_taxes") {
        if (op === "insert") {
          if (createStub.failGroup === "taxes") return writeFailure();
          pushTaxRows(String(payload.invoice_id), insertedRows);
          return { data: null, error: null };
        }
        if (op === "delete") {
          return compensate("taxes", () => {
            createStub.taxes = createStub.taxes.filter((row) => !matches(row));
          });
        }
        return { data: createStub.taxes.filter(matches), error: null };
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
          // CL-13: el ÚNICO IN que escribe este doble es el de la REVERSIÓN de la
          // compensación de la ruta vieja (`registerMovement` con type IN): se
          // registra como paso y se puede hacer fallar. La emisión no escribe
          // ningún IN.
          if (payload.type === "IN") {
            return compensate("stock", () => {
              createStub.movements.push(movement);
            });
          }
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
        // El contador cuenta ESCRITURAS (una sentencia), no filas: es el mismo
        // significado que tiene en la transacción del RPC.
        insertedRows = (Array.isArray(value) ? value : [value ?? {}]) as Array<
          Record<string, unknown>
        >;
        payload = (insertedRows[0] ?? {}) as Record<string, unknown>;
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

  const rpc = async (name: string, args?: Record<string, unknown>) => {
    createStub.rpcCalls.push({ name, args: (args ?? {}) as Record<string, unknown> });
    if (name === "deduct_stock_atomic") {
      // CL-7/046: el OUT de la emisión ya no es un `registerMovement` por
      // producto en un bucle sin transacción, sino UNA sentencia del servidor
      // (la deducción entera, todo-o-nada). El doble registra EXACTAMENTE lo
      // mismo que registraba —una fila por producto, con su motivo y SIN marca
      // de intento— y cuenta la escritura en el MISMO contador
      // (`inserts.inventory_movements`): las aserciones de "una salida de stock
      // por emisión" siguen significando lo mismo que antes. El contador cuenta
      // ESCRITURAS (una sentencia), no filas; por eso suma 1 cuando hay ítems.
      //
      // CL-13: en la transacción de la 052 este RPC es el GRUPO DE STOCK, y en
      // la ruta vieja es el request suelto de la deducción: el fallo se inyecta
      // en los dos casos con el MISMO flag.
      if (createStub.failGroup === "stock") {
        return { data: null, error: { code: "P0001", message: "INSUFFICIENT_STOCK" } };
      }
      const items = (args?.p_items ?? []) as Array<{ product_id: string; qty: number }>;
      pushMovements(
        items.map((item) => ({
          // El movimiento toma la sede del PRODUCTO (la fila que el `JOIN` de
          // 046 trae), no una sede recibida: la instalación es de una sola sede
          // (071) y la llamada ya no manda ninguna.
          sede_id:
            item.product_id === createStub.product?.id
              ? (createStub.product.sede_id ?? null)
              : null,
          product_id: item.product_id,
          type: "OUT",
          qty: item.qty,
          reason: args?.p_reason ?? null,
          user_id: args?.p_user_id ?? null,
          idempotency_key: null,
        })),
      );
      createStub.inserts.inventory_movements =
        (createStub.inserts.inventory_movements ?? 0) + (items.length > 0 ? 1 : 0);
      return { data: items.length, error: null };
    }
    if (name === "invoice_create_atomic") {
      return createInvoiceTransaction(args);
    }
    if (name !== "next_invoice_number") {
      createStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `doble de emisión: rpc desconocido ${name}` } };
    }
    // El consecutivo solo avanza cuando se RESERVA: así el hueco de la carrera
    // queda a la vista en lugar de esconderse. Es la reserva de la RUTA VIEJA
    // (un request suelto ANTES de la factura); en la transacción de la 052 la
    // reserva es de adentro y se aplica —o se revierte— con ella.
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
  /**
   * CL-11: la escritura que CIERRA la factura (el paso a `Pagada`) no se puede
   * aplicar una vez. Dentro de `invoice_split_payment_atomic` es un fallo a
   * mitad de la transacción: las porciones ya escritas se revierten con ella.
   */
  failCloseOnce: false,
  /** Payload del UPDATE de `invoices`: lo que el servicio realmente escribió. */
  invoiceUpdate: null as Record<string, unknown> | null,
  /**
   * CL-11: traza del RPC `invoice_split_payment_atomic`, en orden (`lock`,
   * `wait`, `resume`): prueba que el cobro serializa por la fila de la factura.
   */
  rpcEvents: [] as string[],
  /**
   * CL-17: el estado del turno. La transacción de la 056 lo bloquea con
   * `FOR SHARE` y lo revalida: si está `cerrado`, el cobro rechaza con
   * `SHIFT_CLOSED` en vez de escribir sus porciones en un turno cerrado.
   */
  shiftStatus: "abierto",
  /**
   * CL-17: un `closeShift` que gana la carrera entre la lectura del servicio y
   * la transacción. El doble cierra el turno antes de revalidarlo.
   */
  closeShiftBeforeCommit: false,
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
          status: payStub.shiftStatus,
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
        payStub.invoiceUpdate = written;
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

  /**
   * CL-11: `invoice_split_payment_atomic` (050). El doble modela la
   * TRANSACCIÓN: toma el lock de la fila de la factura, relee su precondición
   * (una factura Anulada no admite cobros), evalúa las DOS barreras reales del
   * INSERT —el tope de 031 y el índice único parcial de la 042— y aplica sus dos
   * grupos —las porciones y el cierre— o NINGUNO. Nada se escribe hasta el
   * final: si algo falla, el doble no deja ni una fila, como la transacción.
   * Cuenta UNA escritura pedida por llamada (no una por porción), que es lo que
   * ya significaba `payInserts()`.
   */
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    if (name !== "invoice_split_payment_atomic") {
      payStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `doble de cobro: rpc desconocido ${name}` } };
    }
    // CL-17: el TURNO se bloquea (`FOR SHARE`) ANTES de la factura (orden global
    // `cash_shifts > invoices`). El cierre concurrente se dispara acá.
    if (payStub.closeShiftBeforeCommit) {
      payStub.closeShiftBeforeCommit = false;
      payStub.shiftStatus = "cerrado";
    }
    if (String(args?.p_shift_id ?? "") !== payStub.SHIFT_ID) {
      return { data: null, error: { code: "P0001", message: "SHIFT_NOT_FOUND" } };
    }
    if (payStub.shiftStatus !== "abierto") {
      // El turno que se cerró a mitad del cobro: la transacción lo revalida
      // sobre la fila bloqueada y rechaza SIN escribir nada.
      return { data: null, error: { code: "P0001", message: "SHIFT_CLOSED" } };
    }
    const invoiceId = String(args?.p_invoice_id ?? "");
    const release = await splitRowLocks(invoiceId, () => {
      payStub.rpcEvents.push("wait");
    });
    payStub.rpcEvents.push(release.waited ? "resume" : "lock");
    try {
      const invoice = payStub.invoices.find((row) => row.id === invoiceId);
      if (!invoice) {
        return { data: null, error: { code: "P0001", message: "INVOICE_NOT_FOUND" } };
      }
      if (invoice.status === "Anulada") {
        return { data: null, error: { code: "P0001", message: "ANNUL_INVALID" } };
      }
      const values = (args?.p_portions ?? []) as Array<Record<string, unknown>>;
      // La factura del cobro la identifica el PARÁMETRO de la operación (la URL),
      // no cada porción: así lo escribe la función.
      const withInvoice: Array<Record<string, unknown>> = values.map((row) => ({
        invoice_id: invoiceId,
        ...row,
      }));
      // El INSERT de las porciones: UNA sentencia (el contador cuenta la
      // escritura PEDIDA, aunque choque, como contaba el `.insert` de antes).
      payStub.inserts.invoice_payments = (payStub.inserts.invoice_payments ?? 0) + 1;
      // 1) El tope de cobro (031) es un trigger BEFORE INSERT: corre ANTES de que
      //    la fila entre al índice, y su suma solo ve lo YA confirmado (las
      //    filas hermanas del mismo INSERT comparten el snapshot).
      for (const row of withInvoice) {
        const paidNet = payStub.payments
          .filter((candidate) => candidate.invoice_id === row.invoice_id)
          .reduce(
            (acc, candidate) => acc + (Number(candidate.amount) - Number(candidate.fee_amount ?? 0)),
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
      //    confirmado Y contra las filas anteriores del MISMO INSERT, y aborta la
      //    sentencia entera (no se persiste ninguna fila).
      const clashes = withInvoice.some((row, index) => {
        const mark = row.idempotency_key;
        if (mark === null || mark === undefined) return false;
        const keyed = (other: Record<string, unknown>) =>
          other.invoice_id === row.invoice_id && other.idempotency_key === mark;
        return [
          ...payStub.payments.filter((other) => other.invoice_id === row.invoice_id),
          ...withInvoice.slice(0, index),
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
      // 3) La escritura que CIERRA la factura, dentro de la MISMA transacción:
      //    si falla, las porciones de arriba se revierten con ella.
      if (args?.p_mark_paid === true && payStub.failCloseOnce) {
        payStub.failCloseOnce = false;
        return { data: null, error: { code: "P0001", message: "PAYMENT_MISMATCH" } };
      }
      // COMMIT: los dos grupos, o nada.
      const persisted = withInvoice.map((row, index) => ({
        id: `pago-${payStub.payments.length + index + 1}`,
        created_at: "2026-01-01T00:00:00.000Z",
        ...row,
      }));
      payStub.payments.push(...persisted);
      if (args?.p_mark_paid === true) {
        const closed = {
          status: "Pagada",
          closed_by: args?.p_user_id ?? null,
          closed_at: args?.p_closed_at ?? null,
        };
        payStub.invoiceUpdate = closed;
        Object.assign(invoice, closed);
      }
      return { data: { invoice: { ...invoice }, portions: persisted.length }, error: null };
    } finally {
      release.release();
    }
  };

  return { from, rpc };
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
    listTaxes: async () =>
      overCollectionStub.taxes as unknown as Awaited<ReturnType<typeof actual.listTaxes>>,
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
function annulProductItemRow(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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
    annulStub.onLockWait = null;
    annulStub.invoiceStatus = "Emitida";
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    annulStub.rpcEvents.length = 0;
    annulStub.commits = 0;
    annulStub.failMovementAt = null;
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
    annulStub.onLockWait = null;
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    annulStub.rpcEvents.length = 0;
    annulStub.commits = 0;
    annulStub.failMovementAt = null;
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

  it("dos anulaciones concurrentes restauran el stock UNA sola vez (U6-b, CL-11)", async () => {
    annulStub.items = [annulProductItemRow()];
    annulStub.product = annulProductRow();

    // CL-11: la anulación entera es UNA transacción, así que el doble detiene la
    // transacción de la primera DESPUÉS de tomar el lock de la fila y ANTES de
    // escribir: la segunda queda esperando ese lock, que es exactamente lo que
    // hace `FOR UPDATE` en la base. El intercalado sigue bajo control (la que
    // aplica segunda es la que pierde), pero ya no es "las dos leen y después
    // las dos escriben": ése era el intercalado que producía el doble stock.
    annulStub.holdNextWrite = true;
    const writeHeld = new Promise<void>((resolve) => {
      annulStub.onWriteHeld = resolve;
    });
    const first = annul();
    await writeHeld;
    // Non-vacuidad: la primera ya tiene el lock de la fila y no escribió nada.
    expect(annulStub.rpcEvents).toEqual(["lock"]);

    const lockWait = new Promise<void>((resolve) => {
      annulStub.onLockWait = resolve;
    });
    const second = annul();
    // La segunda ESPERA el lock: no lee el estado viejo ni escribe por su lado.
    await lockWait;
    expect(annulStub.rpcEvents).toEqual(["lock", "wait"]);
    // Las DOS lecturas de estado que quedaron registradas son la MISMA foto
    // (`Emitida`): la carrera existió de verdad y lo que la resuelve es la
    // transacción, no una relectura oportuna.
    expect(annulStub.events).toEqual(["read", "read"]);

    if (annulStub.releaseWrite) annulStub.releaseWrite();
    const firstResult = await first.then(
      () => "anulado" as const,
      (error: unknown) => error,
    );
    const secondResult = await second.then(
      () => "anulado" as const,
      (error: unknown) => error,
    );

    // La que tomó el lock gana; la que esperaba pierde y se rechaza.
    expect(firstResult).toBe("anulado");
    expect(secondResult).toBeInstanceOf(BillingError);
    expect(secondResult).toMatchObject({ code: "ANNUL_CONFLICT", status: 409 });
    // El síntoma: el stock se devuelve UNA vez, no dos.
    expect(annulStub.movements).toHaveLength(1);
    expect(annulStub.movements[0]).toMatchObject({ product_id: PRODUCT_ID, type: "IN", qty: 2 });
    // Una sola transacción escribió (la perdedora no dejó ni una fila),
    expect(annulStub.commits).toBe(1);
    // la precondición se revalidó ADENTRO sobre la fila bloqueada —las dos la
    // llevaron, la segunda la encontró falsa—,
    expect(annulStub.guards).toEqual(["Emitida", "Emitida"]);
    expect(annulStub.rpcEvents).toEqual(["lock", "wait", "commit", "resume", "reject"]);
    // y una sola anulación deja una sola auditoría.
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

// ---------- CL-11: la anulación entera, en UNA transacción ----------
//
// `annulInvoice` escribía DOS veces: la factura a `Anulada` (con su
// compare-and-swap) y DESPUÉS las N reversiones de stock, un `registerMovement`
// por línea de producto. Son dos requests distintos contra PostgREST, que no
// ofrece multi-statement por request: un fallo entre los dos dejaba la factura
// Anulada con el stock devuelto A MEDIAS, y como el compare-and-swap sólo pisa
// una factura en el estado leído, el reintento ya no encontraba una factura
// anulable: un callejón sin salida sin compensación.
//
// El doble modela la transacción de la 050: el RPC toma el lock de la fila
// (`wait` cuando ya está tomado, en vez de leer el estado viejo), revalida la
// precondición y aplica sus DOS grupos de escritura —o ninguno—.
describe("billing: la anulación es UNA transacción (CL-11)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };

  function annul(motivo = "Cobro duplicado") {
    return annulInvoice(overCollectionStub.SEDE_ID, overCollectionStub.INVOICE_ID, { motivo }, ACTOR);
  }

  /** Segunda línea de PRODUCTO: dos reversiones = el bucle de ayer. */
  function secondProductLine() {
    return annulProductItemRow({ id: "99999999-9999-4999-8999-999999999998", qty: 3 });
  }

  beforeEach(() => {
    annulStub.active = true;
    annulStub.holdNextWrite = false;
    annulStub.releaseWrite = null;
    annulStub.onWriteHeld = null;
    annulStub.onLockWait = null;
    annulStub.invoiceStatus = "Emitida";
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    annulStub.failMovementAt = null;
    annulStub.rpcEvents.length = 0;
    annulStub.commits = 0;
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
    annulStub.onLockWait = null;
    annulStub.items = null;
    annulStub.product = null;
    annulStub.movements.length = 0;
    annulStub.guards.length = 0;
    annulStub.updateMisses = false;
    annulStub.events.length = 0;
    annulStub.failMovementAt = null;
    annulStub.rpcEvents.length = 0;
    annulStub.commits = 0;
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
  });

  it("un fallo entre las dos escrituras no deja NADA escrito, y el reintento COMPLETA la anulación", async () => {
    annulStub.items = [annulProductItemRow(), secondProductLine()];
    annulStub.product = annulProductRow();
    // La SEGUNDA reversión no se puede escribir: el fallo cae entre las dos
    // escrituras de la anulación.
    annulStub.failMovementAt = 2;

    const failure: unknown = await annul().catch((error: unknown) => error);

    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 050): la
    // factura quedaba `Anulada`, el stock a medias (una de dos líneas) y el
    // reintento moría con `ANNUL_INVALID` —callejón sin salida—.
    // Ahora la anulación es UNA transacción: o se escriben las dos cosas, o
    // ninguna.
    expect(failure).toBeInstanceOf(BillingError);
    expect(annulStub.invoiceStatus).toBe("Emitida");
    expect(annulStub.movements).toEqual([]);
    expect(annulStub.commits).toBe(0);

    // El reintento del MISMO intento COMPLETA la operación entera: no hay
    // estado a medias que lo bloquee.
    annulStub.failMovementAt = null;
    const detail = await annul();

    expect(detail.invoice.status).toBe("Anulada");
    expect(annulStub.movements.map((row) => row.qty)).toEqual([2, 3]);
    expect(annulStub.commits).toBe(1);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("el camino de éxito escribe EXACTAMENTE las filas de siempre (una IN por línea, con su motivo)", async () => {
    annulStub.items = [annulProductItemRow()];
    annulStub.product = annulProductRow();

    const detail = await annul("Cobro duplicado");

    expect(detail.invoice.status).toBe("Anulada");
    // La fila de la factura: los MISMOS cuatro campos, con los MISMOS valores.
    expect(overCollectionStub.invoiceUpdate).toEqual({
      status: "Anulada",
      cancel_reason: "Cobro duplicado",
      closed_by: "u-1",
      closed_at: expect.any(String),
    });
    // El movimiento: la MISMA fila que escribía `registerMovement`, sin marca de
    // intento (la anulación no tiene intento de cliente: la cubre el CAS).
    // DATO DE ENTRADA → FILA ESCRITA: el motivo lo arma `buildReversalReasons`
    // (TypeScript) y viaja como dato; la función no lo construye ni lo traduce.
    const expected = buildReversalReasons({
      consecutiveNumber: 7,
      motivo: "Cobro duplicado",
      productItems: [{ product_id: PRODUCT_ID, qty: 2 }],
    });
    expect(
      annulStub.movements.map((row) => ({
        product_id: row.product_id,
        qty: row.qty,
        reason: row.reason,
      })),
    ).toEqual(expected);
    expect(annulStub.movements[0]).toMatchObject({
      sede_id: overCollectionStub.SEDE_ID,
      type: "IN",
      user_id: "u-1",
      idempotency_key: null,
    });
    expect(annulStub.commits).toBe(1);
  });

  it("control negativo: una factura sin líneas de producto se anula con CERO movimientos (el arreglo vacío es legal)", async () => {
    // A diferencia de la deducción de la emisión (046, que rechaza el arreglo
    // vacío porque una venta sin productos no descuenta nada), la reversión de
    // una factura de servicios es VACÍA y la anulación tiene que pasar: la
    // transacción escribe la factura y no escribe ningún movimiento.
    annulStub.items = [];

    const detail = await annul();

    expect(detail.invoice.status).toBe("Anulada");
    expect(annulStub.movements).toEqual([]);
    expect(annulStub.commits).toBe(1);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
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

    const total = await countInvoices({ employee_id: EMPLOYEE_ID });

    expect(total).toBe(1200);
  });

  it("countInvoices manda los ids en lotes que aguantan la URL y pagina la lectura", async () => {
    seedEmployeeInvoices(1200);

    await countInvoices({ employee_id: EMPLOYEE_ID });

    const sizes = invoiceIdInSizes();
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
    // La lectura de `invoice_items` paginó: no se cortó en el tope por request.
    expect(pagedStub.windows.filter((window) => window.table === "invoice_items").length).toBeGreaterThan(1);
  });

  it("RED: listInvoices no pierde facturas del empleado", async () => {
    seedEmployeeInvoices(1200);

    const rows = await listInvoices({ employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows).toHaveLength(10);
    // La más reciente del conjunto COMPLETO del empleado, no del recorte.
    expect(rows[0].consecutive_number).toBe(1200);
  });

  it("listInvoices no arma un `in` gigante y mantiene el orden descendente", async () => {
    seedEmployeeInvoices(1200);

    const rows = await listInvoices({ employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows.map((row) => row.consecutive_number)).toEqual([
      1200, 1199, 1198, 1197, 1196, 1195, 1194, 1193, 1192, 1191,
    ]);
    expect(Math.max(...invoiceIdInSizes())).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
  });

  it("RED: con más de 1000 líneas en la página no se pierde factura ni participante", async () => {
    // 10 facturas × 120 líneas = 1200 ítems en la página: el `.limit(2000)` que
    // el `max-rows` baja a 1000 dejaba a las últimas facturas sin participantes.
    seedEmployeeInvoices(10, 120);

    const rows = await listInvoices({ employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.employee_names.length === 1)).toBe(true);
  });

  it("control: un empleado con pocas facturas sigue listando y contando igual", async () => {
    seedEmployeeInvoices(3);

    const rows = await listInvoices({ employee_id: EMPLOYEE_ID, page: 1, pageSize: 10 });

    expect(rows.map((row) => row.consecutive_number)).toEqual([3, 2, 1]);
    expect(await countInvoices({ employee_id: EMPLOYEE_ID })).toBe(3);
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
// fila sigue en la versión que leyó, y si no se rechaza con `EDIT_CONFLICT`
// (409) sin tocar los ítems, el stock ni la auditoría.
//
// CL-12: el candado ya no se reclama desde el cliente. Vive DENTRO de la
// transacción de la edición (051): `FOR UPDATE` sobre la fila de la factura y
// `(versión, estado)` en el `WHERE` de la MISMA sentencia que escribe. Con eso,
// una edición concurrente ESPERA el lock de la fila y después se rechaza (antes,
// la perdedora alcanzaba a reclamar su token y el fallo a mitad de la secuencia
// dejaba el estado parcial con el token avanzado). El ajuste de stock tampoco
// pasa ya por `registerMovement`: viaja como DATO y lo escribe la transacción.
//
// `editStub` mantiene la versión REAL por factura y el RPC la contrasta sobre la
// fila bloqueada, así que la carrera se observa de verdad: la primera edición
// toma el lock y queda EN VUELO, la segunda ESPERA ese lock, y la que lo esperó
// es la que pierde.

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

  it("dos ediciones libres concurrentes mueven el stock UNA sola vez (CL-12: en la transacción)", async () => {
    const commitsBefore = editStub.commits;
    const { pending: first } = await holdFirstWrite(() => freeEdit());

    // CL-12: el candado dejó de ser un compare-and-swap desde el cliente y pasó
    // a ser el `FOR UPDATE` de la fila DENTRO de la transacción. La segunda
    // edición pide el MISMO lock de fila y ESPERA —no lee el estado viejo ni
    // escribe por su lado—: la que tomó el lock gana, la que esperó evalúa su
    // precondición contra la versión nueva y se rechaza.
    const second = freeEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    // La traza se mira a partir de lo que ya había: los bloques de antes
    // comparten el doble y sus ediciones también dejan rastro.
    const eventsBefore = editStub.rpcEvents.length;
    const waited = await waitFor(() => editStub.rpcEvents.slice(eventsBefore).includes("wait"));
    if (editStub.releaseWrite) editStub.releaseWrite();
    const secondResult = await second;
    const firstResult = await first;

    // Non-vacuidad del intercalado: la segunda ESPERÓ el lock de la fila. Si el
    // candado no estuviera adentro, correría entera y este expect falla a la
    // vista, en vez de dejar pasar la prueba por un camino que ya no existe.
    expect(waited, "la segunda edición esperó el lock de la fila").toBe(true);
    // El síntoma del hallazgo: el delta (+2) se aplica UNA vez, no dos.
    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({ product_id: PRODUCT_ID, type: "OUT", qty: QTY_DELTA });
    // La carrera existió de verdad: las DOS leyeron ANTES de la primera
    // escritura. Las escrituras de `invoices` son DOS: el grupo de la ganadora
    // —UNA sentencia que pisa la versión (y los totales, en la libre)— y el CAS
    // RECHAZADO de la perdedora, que es su única escritura.
    expect(editStub.events).toEqual(["read", "read", "write", "write"]);
    expect(editStub.rpcEvents.slice(-5)).toEqual(["lock", "wait", "commit", "resume", "reject"]);
    // La que TOMÓ el lock gana; la que esperó pierde con su código.
    expect(firstResult).toBe("aplicada");
    expect(secondResult).toBeInstanceOf(BillingError);
    expect(secondResult).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    // Las dos entraron con la MISMA versión leída: por eso la segunda pierde.
    expect(editStub.versionGuards).toEqual([0, 0]);
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    // Una sola transacción confirmó y una sola edición dejó su auditoría.
    expect(editStub.commits - commitsBefore).toBe(1);
    expect(
      overCollectionStub.writes.filter((write) => write === "audit_logs.insert"),
    ).toHaveLength(1);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("la edición admin de una PAGADA se serializa igual (mismo candado)", async () => {
    const commitsBefore = editStub.commits;
    editStub.statuses[overCollectionStub.INVOICE_ID] = "Pagada";

    const { pending: first } = await holdFirstWrite(() => adminEdit());

    const second = adminEdit().then(
      () => "aplicada" as const,
      (error: unknown) => error,
    );
    // CL-12: la segunda espera el lock de la fila; la que lo tomó gana y la que
    // esperó se rechaza. El candado es el MISMO para las dos ediciones y para
    // una factura PAGADA. La traza se mira a partir de lo que ya había (los
    // bloques de antes comparten el doble).
    const eventsBefore = editStub.rpcEvents.length;
    const waited = await waitFor(() => editStub.rpcEvents.slice(eventsBefore).includes("wait"));
    if (editStub.releaseWrite) editStub.releaseWrite();
    const secondResult = await second;
    const firstResult = await first;

    expect(waited, "la segunda edición esperó el lock de la fila").toBe(true);
    expect(editStub.movements).toHaveLength(1);
    expect(editStub.movements[0]).toMatchObject({ type: "OUT", qty: QTY_DELTA });
    expect(firstResult).toBe("aplicada");
    expect(secondResult).toBeInstanceOf(BillingError);
    expect(secondResult).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
    expect(editStub.versionGuards).toEqual([0, 0]);
    expect(editStub.commits - commitsBefore).toBe(1);
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
    // Nada más que el CAS rechazado: ni stock, ni auditoría, ni una fila. CL-12:
    // el rechazo lo produce la transacción, así que no escribió NADA (antes
    // quedaba trazado el UPDATE del candado: la escritura que el cliente
    // mandaba y que afectaba 0 filas).
    expect(editStub.movements).toEqual([]);
    expect(overCollectionStub.auditInsert).toBeNull();
    expect(editStub.rpcEvents.slice(-1)).toEqual(["reject"]);
    expect(overCollectionStub.writes).toEqual([]);
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
// ventana, y recién ahí la libera. El doble aplica la precondición sobre la fila
// bloqueada, así que una guarda que el servicio no mande no puede rechazar nada.
//
// CL-12: el candado dejó de reclamarse desde el cliente y ahora VIVE en la
// transacción de la edición (051), con `FOR UPDATE` sobre la fila y `(versión,
// estado)` en el `WHERE`. Estos tests no cambian de significado —siguen probando
// que una edición en vuelo NO se aplica sobre una factura que dejó de estar en el
// estado leído—; lo que cambió es dónde se evalúa la guarda. La edición se detiene
// ahora con el LOCK de la fila tomado y antes de releer la precondición, que es el
// intercalado real: la lectura del servicio ya ocurrió y la transacción todavía no.

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
    // CL-12: la transacción rechazada no escribió NADA (antes quedaba trazado el
    // UPDATE del candado desde el cliente, que afectaba 0 filas).
    expect(editStub.rpcEvents.slice(-1)).toEqual(["reject"]);
    expect(overCollectionStub.writes).toEqual([]);
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
    expect(editStub.rpcEvents.slice(-1)).toEqual(["reject"]);
    expect(overCollectionStub.writes).toEqual([]);
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

// ------------- CL-12: las DOS ediciones, en UNA transacción ----------------
//
// `editInvoiceItems` (edición admin, total INMUTABLE) y
// `editEmittedInvoiceItems` (edición libre de una emitida, total RECALCULADO)
// escribían su edición como una SECUENCIA de requests sueltos contra PostgREST
// —que no ofrece multi-statement por request—: borrar los ítems que sobran,
// actualizar los que cambian, insertar los nuevos, cambiar los métodos de pago,
// (en la libre) reemplazar el snapshot de impuestos y pisar los totales, y
// DESPUÉS aplicar el ajuste de stock por delta, un `registerMovement` por
// producto. Un fallo a mitad de esa secuencia dejaba los ítems (y los
// impuestos, y los totales) YA escritos, el stock a medias y —peor— el token de
// serialización `edit_version` (038) YA avanzado: el candado de la edición
// siguiente la rechaza con EDIT_CONFLICT, así que el ajuste que faltaba no se
// aplicaba NUNCA. En la edición libre, además, el cierre de turno se firma
// ARRIBA de ese estado.
//
// CL-12 cierra las dos ventanas con UNA FUNCIÓN SQL por edición (051), llamada
// por `db.rpc`: una función es UNA sentencia y una sentencia corre ENTERA dentro
// de una sola transacción del servidor. El servicio COMPUTA todo —el diff de
// ítems, los subtotales, el snapshot de impuestos, los totales, el delta NETO de
// stock por producto, el motivo del kardex, la reconciliación del total
// inmutable— y la función sólo ESCRIBE filas, en el mismo orden en que la
// edición las escribía.
//
// EL REEMPLAZO, QUE ES LO DISTINTO DE ESTAS DOS VENTANAS: a diferencia de la
// anulación (050) o del cobro (050) —que AGREGAN filas—, acá la edición
// REEMPLAZA una colección: los ítems (borra los que leyó, actualiza los que
// cambian, inserta los nuevos) y, en la libre, el snapshot de impuestos (borra
// el que leyó e inserta el que computó). "Todo o nada" en un reemplazo quiere
// decir las DOS mitades: o queda la colección anterior COMPLETA, o queda la
// nueva COMPLETA. Un fallo entre el borrado y la inserción es el peor de los
// casos —la colección vacía, que no es ninguna de las dos—, y es exactamente lo
// que la transacción hace imposible. Por eso el doble trabaja sobre un estado
// APARTE y lo publica entero: un doble que escribiera directo sobre la colección
// no podría representar el rollback (el borrado ya habría pasado).
describe("billing: las dos ediciones de factura son UNA transacción (CL-12)", () => {
  const ACTOR: BillingActor = {
    userId: "u-1",
    sedeId: overCollectionStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Segundo producto de la sede: la edición toca DOS y escribe DOS movimientos. */
  const PRODUCT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
  const ITEM_A = overCollectionStub.ITEM_ID;
  const ITEM_B = "99999999-9999-4999-8999-999999999998";
  const ITEM_C = "99999999-9999-4999-8999-999999999997";
  const ADMIN_MOTIVO = "Cantidad mal digitada";
  /** El motivo del kardex lo arma el SERVICIO (TypeScript) y viaja como dato. */
  const ADMIN_REASON = `Ajuste edición factura #7 — ${ADMIN_MOTIVO}`;
  const FREE_REASON = "Edición libre emitida factura #7";
  /** Impuesto ACTIVO de la sede: la edición libre reemplaza su snapshot. */
  const IVA_19 = { code: "IVA", name: "IVA 19", percent: 19, is_active: true };

  function productRow(id: string, stockQty = 5) {
    return { ...annulProductRow(), id, stock_qty: stockQty };
  }

  /** Línea de PRODUCTO: es el origen del delta de stock. */
  function productLine(itemId: string, productId: string, qty: number, unitPrice: number) {
    return annulProductItemRow({
      id: itemId,
      product_id: productId,
      qty,
      unit_price: unitPrice,
      subtotal: qty * unitPrice,
    });
  }

  /** Línea CUSTOM: se puede quitar sin mover stock (no es de producto). */
  function customLine(itemId: string, name: string, unitPrice: number) {
    return annulProductItemRow({
      id: itemId,
      item_type: "custom",
      product_id: null,
      custom_name: name,
      qty: 1,
      unit_price: unitPrice,
      subtotal: unitPrice,
    });
  }

  /**
   * Edición ADMIN con el subtotal INTACTO (300.000): las tres líneas originales
   * suman 300.000 y las dos nuevas también (150.000 + 150.000), así que
   * `assertEditReconciles` pasa. Los DELTAS de stock son +1 (A), +1 (B) y −1 (C,
   * que se quita) → TRES movimientos, el escenario multi-producto del hallazgo.
   */
  function adminPayload() {
    return {
      items: [
        {
          id: ITEM_A,
          item_type: "producto",
          product_id: PRODUCT_ID,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 2,
          unit_price: 75000,
          discount: 0,
          no_commission: true,
        },
        {
          id: ITEM_B,
          item_type: "producto",
          product_id: PRODUCT_B,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 2,
          unit_price: 75000,
          discount: 0,
          no_commission: true,
        },
      ],
      payments: [],
      motivo: ADMIN_MOTIVO,
    };
  }

  /** Edición LIBRE: el total se RECALCULA (y con IVA activo hay snapshot). */
  function freePayload() {
    return {
      items: [
        {
          id: ITEM_A,
          item_type: "producto",
          product_id: PRODUCT_ID,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 3,
          unit_price: 100000,
          discount: 0,
          no_commission: true,
        },
        {
          id: ITEM_B,
          item_type: "producto",
          product_id: PRODUCT_B,
          service_id: null,
          custom_name: null,
          employee_id: EMPLOYEE_ID,
          qty: 2,
          unit_price: 100000,
          discount: 0,
          no_commission: true,
        },
        {
          item_type: "custom",
          custom_name: "Propina",
          product_id: null,
          service_id: null,
          employee_id: EMPLOYEE_ID,
          qty: 1,
          unit_price: 50000,
          discount: 0,
          no_commission: true,
        },
      ],
      payments: [],
    };
  }

  function adminEdit() {
    return editInvoiceItems(overCollectionStub.SEDE_ID, overCollectionStub.INVOICE_ID, adminPayload(), ACTOR);
  }

  function freeEdit() {
    return editEmittedInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      freePayload(),
      ACTOR,
    );
  }

  /** Estado de la colección de ítems de la factura, tal como quedó. */
  function itemsById(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      (editStub.itemsByInvoice[overCollectionStub.INVOICE_ID] ?? []).map((row) => [String(row.id), row]),
    );
  }

  /**
   * Lo que el SERVICIO computa para el ajuste de stock de una edición: el delta
   * NETO por producto, con su tipo y el motivo del kardex. Se recalcula acá con
   * la MISMA regla de producción para poder contrastarlo contra las filas que la
   * función escribió (DATO DE ENTRADA → FILA ESCRITA).
   */
  function expectedMoves(
    before: Array<{ product_id: string | null; qty: number }>,
    after: Array<{ product_id: string | null; qty: number }>,
    reason: string,
  ) {
    const sum = (rows: Array<{ product_id: string | null; qty: number }>) => {
      const map = new Map<string, number>();
      for (const row of rows) {
        if (!row.product_id) continue;
        map.set(row.product_id, (map.get(row.product_id) ?? 0) + Number(row.qty));
      }
      return map;
    };
    const oldQty = sum(before);
    const newQty = sum(after);
    const ids = [...new Set([...oldQty.keys(), ...newQty.keys()])];
    return ids
      .map((id) => ({ product_id: id, delta: (newQty.get(id) ?? 0) - (oldQty.get(id) ?? 0) }))
      .filter((move) => move.delta !== 0)
      .map((move) => ({
        product_id: move.product_id,
        type: move.delta > 0 ? "OUT" : "IN",
        qty: Math.abs(move.delta),
        reason,
      }));
  }

  /** Las filas de `inventory_movements` como las escribió la transacción. */
  function writtenMoves() {
    return editStub.movements
      .map((row) => ({
        product_id: row.product_id,
        type: row.type,
        qty: row.qty,
        reason: row.reason,
      }))
      .sort((left, right) => String(left.product_id).localeCompare(String(right.product_id)));
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
    editStub.onLockWait = null;
    editStub.rpcEvents.length = 0;
    editStub.commits = 0;
    editStub.failWriteKind = null;
    editStub.failWriteOffset = 0;
    editStub.product = null;
    editStub.products = [productRow(PRODUCT_ID), productRow(PRODUCT_B)];
    editStub.itemsByInvoice = {
      [overCollectionStub.INVOICE_ID]: [
        productLine(ITEM_A, PRODUCT_ID, 1, 100000),
        productLine(ITEM_B, PRODUCT_B, 1, 100000),
        customLine(ITEM_C, "Corte y peinado", 100000),
      ],
    };
    editStub.taxesByInvoice = {};
    overCollectionStub.taxes = [];
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
    editStub.onLockWait = null;
    editStub.versions = {};
    editStub.statuses = {};
    editStub.versionGuards.length = 0;
    editStub.statusGuards.length = 0;
    editStub.staleGuard = false;
    editStub.movements.length = 0;
    editStub.events.length = 0;
    editStub.rpcEvents.length = 0;
    editStub.commits = 0;
    editStub.failWriteKind = null;
    editStub.failWriteOffset = 0;
    editStub.product = null;
    editStub.products = [];
    editStub.itemsByInvoice = {};
    editStub.taxesByInvoice = {};
    overCollectionStub.taxes = [];
    pagedStub.tables = {};
    pagedStub.failAt = {};
    pagedStub.requests = {};
    pagedStub.windows.length = 0;
    pagedStub.inFilters.length = 0;
  });

  it("RED/GREEN: un fallo entre los ítems y el stock no deja NADA escrito, y el reintento COMPLETA la edición admin", async () => {
    // El SEGUNDO movimiento de stock no se puede escribir: el fallo cae entre
    // los ítems (ya escritos) y el resto del stock.
    editStub.failWriteKind = "movements";
    editStub.failWriteOffset = 1;

    const failure: unknown = await adminEdit().catch((error: unknown) => error);

    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 051): los
    // ítems quedaban YA escritos, el token `edit_version` quedaba en 1 y el
    // stock a medias (el primero de los dos movimientos entró y el segundo no).
    // En UNA sola aserción para que el RED se lea ENTERO: acá salía
    //   { moves: [{ type: "OUT", qty: 1 }], version: 1, commit: 0 }
    // —stock a medias y token avanzado— con los ítems ya reemplazados (sus
    // escrituras quedaron trazadas en `writes`), y el reintento del MISMO
    // intento moría en EDIT_CONFLICT: el ajuste no se aplicaba nunca.
    //
    // Ahora la edición es UNA transacción: o se escriben TODOS los grupos, o
    // ninguno. El intento SÍ llegó a pedir la escritura (no vacuidad), pero no
    // publicó ni una fila.
    expect({
      moves: writtenMoves().map((move) => ({ type: move.type, qty: move.qty })),
      version: editStub.versions[overCollectionStub.INVOICE_ID] ?? 0,
      commits: editStub.commits,
    }).toEqual({ moves: [], version: 0, commits: 0 });
    expect(failure).toBeInstanceOf(BillingError);
    expect(overCollectionStub.writes).toContain("inventory_movements.insert");
    expect(editStub.movements).toEqual([]);
    expect(editStub.versions[overCollectionStub.INVOICE_ID] ?? 0).toBe(0);
    expect(editStub.commits).toBe(0);
    // La colección de ítems quedó EXACTAMENTE como estaba: las tres líneas.
    expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B, ITEM_C].sort());
    expect(itemsById()[ITEM_A]).toMatchObject({ qty: 1, unit_price: 100000, subtotal: 100000 });
    expect(overCollectionStub.auditInsert).toBeNull();

    // El reintento del MISMO intento COMPLETA la edición entera: no hay estado a
    // medias ni un token que lo bloquee.
    editStub.failWriteKind = null;
    const writesBeforeRetry = overCollectionStub.writes.length;
    const detail = await adminEdit();

    expect(detail.invoice.edit_version).toBe(1);
    expect(editStub.versions[overCollectionStub.INVOICE_ID]).toBe(1);
    expect(editStub.commits).toBe(1);
    expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(itemsById()[ITEM_A]).toMatchObject({ qty: 2, unit_price: 75000, subtotal: 150000 });
    expect(itemsById()[ITEM_B]).toMatchObject({ qty: 2, unit_price: 75000, subtotal: 150000 });
    expect(writtenMoves()).toEqual(
      expectedMoves(
        [
          { product_id: PRODUCT_ID, qty: 1 },
          { product_id: PRODUCT_B, qty: 1 },
          { product_id: null, qty: 1 },
        ],
        [
          { product_id: PRODUCT_ID, qty: 2 },
          { product_id: PRODUCT_B, qty: 2 },
        ],
        ADMIN_REASON,
      ),
    );
    // Los grupos, EN EL ORDEN de la 051, y una sola confirmación: la auditoría
    // sigue siendo la última escritura y va FUERA de la transacción.
    expect(overCollectionStub.writes.slice(writesBeforeRetry)).toEqual([
      "invoices.update",
      "invoice_items.delete",
      "invoice_items.update",
      "invoice_items.insert",
      "invoice_payments.update",
      "inventory_movements.insert",
      "audit_logs.insert",
    ]);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("la edición admin escribe EXACTAMENTE las filas de siempre (y SÓLO el token en la factura)", async () => {
    await adminEdit();

    // La fila de la factura: SÓLO el token. La función de la edición admin no
    // tiene un grupo capaz de escribir dinero —el total es INMUTABLE—, así que
    // la inmutabilidad deja de ser una regla que el llamador promete.
    expect(overCollectionStub.invoiceUpdate).toEqual({ edit_version: 1 });
    // Las DOS líneas del kardex, con su tipo, su cantidad y el motivo que armó
    // el servicio (la función no arma texto: escribe el dato).
    expect(writtenMoves()).toEqual(
      [
        { product_id: PRODUCT_ID, type: "OUT", qty: 1, reason: ADMIN_REASON },
        { product_id: PRODUCT_B, type: "OUT", qty: 1, reason: ADMIN_REASON },
      ].sort((left, right) => String(left.product_id).localeCompare(String(right.product_id))),
    );
    // La frontera de inventario no cambia: sin marca de intento (la edición no
    // tiene una), con la sede y con el responsable.
    expect(editStub.movements[0]).toMatchObject({
      sede_id: overCollectionStub.SEDE_ID,
      user_id: "u-1",
      idempotency_key: null,
    });
    // La auditoría sigue FUERA de la transacción y con las MISMAS cifras.
    expect(overCollectionStub.auditInsert).toMatchObject({
      action: "invoice.edited",
      entity: "invoices",
      entity_id: overCollectionStub.INVOICE_ID,
      metadata: { motivo: ADMIN_MOTIVO, items_before: 3, items_added: 0 },
    });
    expect((overCollectionStub.auditInsert?.metadata as { inventory_moves: unknown[] }).inventory_moves).toHaveLength(2);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: una edición sin cambios escribe SÓLO el token (los grupos vacíos son legales)", async () => {
    // El MISMO contenido que la factura ya tiene: ni borrados, ni cambios, ni
    // altas, ni un solo movimiento de stock. La transacción escribe el token y
    // nada más —los grupos vacíos pasan sus redes de conteo (0 = 0)—, que es lo
    // que hace legal editar una factura de servicios sin tocar el kardex.
    const detail = await editEmittedInvoiceItems(
      overCollectionStub.SEDE_ID,
      overCollectionStub.INVOICE_ID,
      {
        items: [
          {
            id: ITEM_A,
            item_type: "producto",
            product_id: PRODUCT_ID,
            service_id: null,
            custom_name: null,
            employee_id: EMPLOYEE_ID,
            qty: 1,
            unit_price: 100000,
            discount: 0,
            no_commission: true,
          },
          {
            id: ITEM_B,
            item_type: "producto",
            product_id: PRODUCT_B,
            service_id: null,
            custom_name: null,
            employee_id: EMPLOYEE_ID,
            qty: 1,
            unit_price: 100000,
            discount: 0,
            no_commission: true,
          },
          {
            id: ITEM_C,
            item_type: "custom",
            product_id: null,
            service_id: null,
            custom_name: "Corte y peinado",
            employee_id: EMPLOYEE_ID,
            qty: 1,
            unit_price: 100000,
            discount: 0,
            no_commission: true,
          },
        ],
        payments: [],
      },
      ACTOR,
    );

    expect(detail.invoice.edit_version).toBe(1);
    expect(editStub.movements).toEqual([]);
    expect(editStub.commits).toBe(1);
    // Las tres líneas siguen siendo las mismas (ni una fila borrada de más).
    expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B, ITEM_C].sort());
    expect(overCollectionStub.writes).toEqual([
      "invoices.update",
      "invoice_taxes.delete",
      "invoice_taxes.insert",
      "invoice_items.delete",
      "invoice_items.update",
      "invoice_items.insert",
      "invoice_payments.update",
      "inventory_movements.insert",
      "audit_logs.insert",
    ]);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("la edición libre escribe EXACTAMENTE lo que el servicio computa: impuestos, totales, ítems y stock", async () => {
    overCollectionStub.taxes = [IVA_19];
    // El snapshot VIEJO de la factura: es el que el reemplazo tiene que borrar.
    editStub.taxesByInvoice[overCollectionStub.INVOICE_ID] = [
      {
        id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
        invoice_id: overCollectionStub.INVOICE_ID,
        tax_code: "IVA",
        tax_name: "IVA 19",
        percent: 19,
        amount: 30000,
      },
    ];

    const payload = freePayload();
    const detail = await freeEdit();

    // DATO DE ENTRADA → FILA ESCRITA: los totales y el snapshot los computa
    // `computeInvoiceTotals`/`snapshotInvoiceTaxes` en TypeScript; la función
    // escribe los números VERBATIM (escribe = convertir la representación, no
    // operar). Se recalcula acá con la MISMA función de producción.
    const totals = computeInvoiceTotals({
      items: payload.items,
      discount: 0,
      activeTaxes: [{ code: IVA_19.code, name: IVA_19.name, percent: IVA_19.percent }],
    });
    expect(overCollectionStub.invoiceUpdate).toEqual({
      edit_version: 1,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      surcharge: 0,
      total: totals.total,
    });
    expect(detail.invoice.total).toBe(totals.total);
    expect(
      (editStub.taxesByInvoice[overCollectionStub.INVOICE_ID] ?? []).map((row) => ({
        tax_code: row.tax_code,
        tax_name: row.tax_name,
        percent: row.percent,
        amount: row.amount,
      })),
    ).toEqual(totals.taxes);
    // La colección de ítems: la línea que se quitó no está, las dos que cambiaron
    // están con su subtotal recomputado y la nueva está con su nombre recortado.
    expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B, "item-" + overCollectionStub.INVOICE_ID + "-3"].sort());
    expect(itemsById()[ITEM_A]).toMatchObject({ qty: 3, unit_price: 100000, subtotal: 300000 });
    expect(itemsById()[ITEM_B]).toMatchObject({ qty: 2, unit_price: 100000, subtotal: 200000 });
    expect(editStub.movements).toHaveLength(2);
    expect(writtenMoves()).toEqual(
      expectedMoves(
        [
          { product_id: PRODUCT_ID, qty: 1 },
          { product_id: PRODUCT_B, qty: 1 },
        ],
        [
          { product_id: PRODUCT_ID, qty: 3 },
          { product_id: PRODUCT_B, qty: 2 },
        ],
        FREE_REASON,
      ),
    );
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("el reemplazo del snapshot de impuestos es todo-o-nada: un fallo al insertarlo deja el VIEJO intacto, y el reintento lo reemplaza", async () => {
    overCollectionStub.taxes = [IVA_19];
    const oldTax = {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      invoice_id: overCollectionStub.INVOICE_ID,
      tax_code: "IVA",
      tax_name: "IVA 19",
      percent: 19,
      amount: 30000,
    };
    editStub.taxesByInvoice[overCollectionStub.INVOICE_ID] = [oldTax];
    // El INSERT del snapshot nuevo no se puede aplicar: es la SEGUNDA mitad del
    // reemplazo, con el borrado ya pedido.
    editStub.failWriteKind = "taxes-insert";

    const failure: unknown = await freeEdit().catch((error: unknown) => error);

    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 051): el
    // snapshot viejo YA estaba BORRADO y el nuevo no había entrado —la factura
    // quedaba SIN impuestos—, con los ítems escritos y el token avanzado. En UNA
    // sola aserción para que el RED se lea ENTERO: acá salía
    //   { taxes: [], version: 1, total: null, moves: 0 }
    // y el reintento moría en EDIT_CONFLICT con la factura sin impuestos.
    // Con la 051 el reemplazo entero se revierte: o el snapshot viejo COMPLETO,
    // o el nuevo COMPLETO.
    expect({
      taxes: editStub.taxesByInvoice[overCollectionStub.INVOICE_ID] ?? [],
      version: editStub.versions[overCollectionStub.INVOICE_ID] ?? 0,
      total: overCollectionStub.invoiceUpdate?.total ?? null,
      moves: editStub.movements.length,
    }).toEqual({ taxes: [oldTax], version: 0, total: null, moves: 0 });
    expect(failure).toBeInstanceOf(BillingError);
    expect(overCollectionStub.writes).toContain("invoice_taxes.insert");
    expect(overCollectionStub.invoiceUpdate).toBeNull();
    expect(editStub.versions[overCollectionStub.INVOICE_ID] ?? 0).toBe(0);
    expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B, ITEM_C].sort());
    expect(editStub.movements).toEqual([]);
    expect(editStub.commits).toBe(0);

    // El reintento reemplaza el snapshot entero y cierra la edición.
    editStub.failWriteKind = null;
    const detail = await freeEdit();

    const totals = computeInvoiceTotals({
      items: freePayload().items,
      discount: 0,
      activeTaxes: [{ code: IVA_19.code, name: IVA_19.name, percent: IVA_19.percent }],
    });
    expect(detail.invoice.total).toBe(totals.total);
    expect(editStub.taxesByInvoice[overCollectionStub.INVOICE_ID]).toHaveLength(1);
    expect(editStub.taxesByInvoice[overCollectionStub.INVOICE_ID]?.[0]).toMatchObject({
      tax_code: "IVA",
      percent: 19,
      amount: totals.taxes[0]?.amount,
    });
    expect(editStub.movements).toHaveLength(2);
    expect(editStub.commits).toBe(1);
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });

  it("una edición que pierde el candado se RECHAZA sin escribir una sola fila (las dos ediciones)", async () => {
    // El token ya no es el que se leyó: es la MISMA ruta de error que produce
    // una edición concurrente que gana la carrera. Las dos ediciones la tienen.
    for (const run of [adminEdit, freeEdit]) {
      editStub.staleGuard = true;
      editStub.versions[overCollectionStub.INVOICE_ID] = 0;
      const before = overCollectionStub.writes.length;

      const outcome: unknown = await run().catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(BillingError);
      expect(outcome).toMatchObject({ code: "EDIT_CONFLICT", status: 409 });
      expect((outcome as BillingError).message).toContain("simultánea");
      // Ni el token, ni los ítems, ni los impuestos, ni el stock, ni la
      // auditoría: la transacción rechazada no escribió NADA.
      expect(overCollectionStub.writes.slice(before)).toEqual([]);
      expect(editStub.versions[overCollectionStub.INVOICE_ID] ?? 0).toBe(0);
      expect(editStub.movements).toEqual([]);
      expect(Object.keys(itemsById()).sort()).toEqual([ITEM_A, ITEM_B, ITEM_C].sort());
      expect(overCollectionStub.auditInsert).toBeNull();
      expect(editStub.rpcEvents.slice(-1)).toEqual(["reject"]);
      editStub.staleGuard = false;
      editStub.rpcEvents.length = 0;
    }
    expect(overCollectionStub.unexpectedQueries).toEqual([]);
  });
});

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

  it("la carrera (misma marca entre el lookup y la escritura) devuelve la factura existente y NO quema el consecutivo", async () => {
    const first = await createInvoice(emissionPayload(), ACTOR);
    // La otra emisión se confirmó entre el lookup y la escritura de esta: el
    // doble saltea el lookup para armar exactamente esa ventana.
    createStub.skipLookupOnce = true;

    const second = await createInvoice(emissionPayload(), ACTOR);

    // Devuelve la factura de la ganadora: el reintento sigue siendo un no-op.
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(createStub.invoices).toHaveLength(1);
    // No vacuidad: la escritura de la segunda SÍ se intentó (dos intentos, una
    // fila). Si el lookup hubiera encontrado la marca, el segundo intento no
    // existiría y este camino nunca se habría ejercitado.
    expect(createStub.inserts.invoices).toBe(2);
    // ANTES (041): la perdedora de la carrera ya había reservado el consecutivo
    // 2 —fuera de la transacción— y el choque del índice único la dejaba SIN
    // factura: un hueco en la serie, declarado como costo.
    // AHORA (052, CL-13): la reserva es de la MISMA transacción que el choque, así
    // que la perdedora la REVIERTE con ella. Un consecutivo, una factura, ningún
    // hueco: los dos arreglos tienen el mismo largo.
    expect(createStub.consecutives).toEqual([1]);
    expect(createStub.consecutives.length).toBe(createStub.invoices.length);
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

// ------------- CL-13: la emisión es UNA transacción -------------------------
//
// LA VENTANA MEDIDA. `createInvoice` reservaba el consecutivo e insertaba la
// factura, sus líneas, sus impuestos, sus porciones y la deducción de stock como
// una SECUENCIA de requests sueltos contra PostgREST (que no ofrece
// multi-statement por request), y la compensaba con `cleanupFailedInvoice`: un
// bucle de reversiones y cuatro `DELETE`, cada uno su propia sentencia, todos
// DENTRO de un `catch {}` que se tragaba su propio error. Si la compensación
// fallaba a mitad —el borrado de las líneas no se puede aplicar, la conexión se
// corta— quedaba un RESIDUO SILENCIOSO: una factura VIVA con su dinero ya
// borrado y su stock ya devuelto (y entonces una anulación posterior devolvería
// el stock OTRA vez), o el borrado completo con el kardex conservando su OUT y
// su IN de una factura que no existe. Nadie se enteraba de nada más que del
// error original.
//
// MECANISMO (a): una FUNCIÓN, `invoice_create_atomic` (052). Es la respuesta de
// la casa a "PostgREST no tiene transacción multi-statement" (005, 039–051) y la
// misma decisión que tomaron los seis gemelos: una función es UNA sentencia, y
// una sentencia corre ENTERA dentro de una sola transacción del servidor. Los
// grupos de escritura de la emisión —la factura, las líneas, el snapshot de
// impuestos, las porciones y el OUT de stock— pasan a ser grupos de la MISMA
// sentencia: o se escriben TODOS, o no se escribe ninguno, y con ellos se
// revierte la reserva del consecutivo. No hay compensación, así que no hay
// `catch {}` que trague nada y no hay residuo que reparar.
//
// EL CONSECUTIVO (y por qué se mueve adentro). Reservarlo era un request aparte
// ANTES de la factura: un fallo posterior lo dejaba quemado —un hueco en la
// serie, uno de los dos residuos que el hallazgo nombra—. Adentro, el incremento
// de `invoice_sequences` (005) pertenece a la MISMA transacción: si la emisión
// aborta, la reserva se revierte con ella y la serie queda SIN huecos. Lo único
// que no conocía el servicio al armar el pedido es el número, y el único texto
// que depende de él es el motivo del OUT: viaja como PLANTILLA con un token
// (`FACTURA #{consecutivo} — Cliente`, armado por `buildInvoiceOutReason`, la
// MISMA función de formato) y la transacción sustituye la PRIMERA ocurrencia con
// el número que ella reservó. El texto, el separador y el recorte siguen siendo
// de TypeScript: la función no arma una frase, sustituye un número.

const THIRD_IDEMPOTENCY_KEY = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";

describe("billing: la emisión es UNA transacción (CL-13)", () => {
  const ACTOR: BillingActor = { userId: "u-1", sedeId: createStub.SEDE_ID, roles: ["admin"] };

  /** Emisión de siempre, con nombre de cliente para poder mirar el motivo del OUT. */
  function emit(extra: Record<string, unknown> = {}) {
    return createInvoice(emissionPayload({ client_name: "Ana Ruiz", ...extra }), ACTOR);
  }

  /**
   * INVARIANTE DE ESTADO, la misma para las dos rutas: después de un fallo, o no
   * quedó NADA escrito, o quedó una emisión COMPLETA y coherente (su factura, sus
   * líneas, su dinero y su propia salida de stock, sin una sola reversión). Una
   * factura viva con su stock devuelto, o con su dinero borrado, es el residuo; y
   * un kardex con su OUT y su IN para una factura que no existe también —"nada
   * escrito" quiere decir ninguna fila, no una ida y vuelta—.
   */
  function assertNoResidue() {
    if (createStub.invoices.length === 0) {
      expect(createStub.items).toEqual([]);
      expect(createStub.taxes).toEqual([]);
      expect(createStub.payments).toEqual([]);
      expect(createStub.movements).toEqual([]);
      return;
    }
    expect(createStub.invoices).toHaveLength(1);
    expect(createStub.items.length).toBeGreaterThan(0);
    expect(createStub.payments.length).toBeGreaterThan(0);
    expect(createStub.movements.map((row) => row.type)).toEqual(["OUT"]);
  }

  beforeEach(() => {
    createStub.active = true;
    createStub.invoices = [];
    createStub.items = [];
    createStub.taxes = [];
    createStub.payments = [];
    createStub.movements = [];
    createStub.consecutives = [];
    createStub.inserts = {};
    createStub.skipLookupOnce = false;
    createStub.failGroup = null;
    createStub.failCompensation = null;
    createStub.compensationSteps = [];
    createStub.commits = 0;
    createStub.rpcEvents = [];
    createStub.rpcCalls = [];
    createStub.unexpectedQueries = [];
  });

  afterEach(() => {
    createStub.active = false;
    createStub.failGroup = null;
    createStub.failCompensation = null;
    overCollectionStub.taxes = [];
  });

  it("un fallo cuya compensación TAMBIÉN falla no deja residuo ni silencio (MEDIDO)", async () => {
    // El fallo cae en medio de la secuencia de escrituras: el grupo de stock no
    // se puede aplicar (la carrera de stock que el plan pre-verificado no vio) y
    // la factura, sus líneas y sus porciones YA se escribieron. En la ruta VIEJA
    // eso dispara la compensación, y la compensación TAMBIÉN falla. El paso que
    // falla es el ÚLTIMO borrado —el de la FACTURA—, y no es un detalle: con el
    // ON DELETE CASCADE de 005, un error en el borrado de las líneas, de los
    // impuestos o de las porciones queda tapado por el borrado de la factura que
    // viene después. El borrado que de verdad carga el peso es el de la factura,
    // y es el que este test rompe.
    createStub.failGroup = "stock";
    createStub.failCompensation = "invoice";

    const failure: unknown = await emit().catch((error: unknown) => error);

    // El llamador recibe el error ORIGINAL: nada le dice que la compensación
    // falló ni qué quedó a medias. Eso es la parte silenciosa. (Además, el
    // código no LEE el resultado de ningún `DELETE`: un borrado que devuelve error
    // ni siquiera entra al `catch {}`.)
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 052): la
    // compensación borraba las porciones y los impuestos, su último borrado
    // fallaba y el error quedaba en el aire. Quedaba una factura VIVA que el
    // sistema da por `Pagada` con CERO porciones registradas —el dinero cobrado
    // desaparecido de una factura que sigue ahí— y con su stock sin descontar,
    // sin que nadie se entere más que del error original.
    // Ahora la emisión es UNA transacción: o se escribieron los cinco grupos, o
    // ninguno, y no hay compensación que pueda fallar.
    assertNoResidue();
    // El mecanismo, no la prosa: la transacción NO compensa porque no hay nada
    // que compensar (el servidor revierte solo); la ruta vieja compensaba y su
    // `catch {}` se tragaba el fallo.
    expect(createStub.compensationSteps).toEqual([]);
  });

  it("el tope de cobro de 031 (P0001) sigue traduciéndose a OVERPAID, y sin residuo", async () => {
    // La cuarta puerta del tope de cobro que traducía P0001 a OVERPAID era el
    // INSERT del cliente de la emisión; ahora la traducción vive en el error del
    // RPC (`toRpcCreateError`) y el contrato de negocio es el MISMO: el mismo
    // código, el mismo mensaje y el mismo 422.
    createStub.failGroup = "payments";

    const failure: unknown = await emit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect((failure as BillingError).message).toBe("Las porciones superan el saldo pendiente.");
    assertNoResidue();
    expect(createStub.consecutives).toEqual([]);
  });

  it("el camino de éxito escribe EXACTAMENTE las filas de siempre (dato computado → fila escrita)", async () => {
    // Un impuesto ACTIVO: el snapshot tiene que viajar completo y su monto es el
    // que computa `snapshotInvoiceTaxes`.
    overCollectionStub.taxes = [{ code: "IVA", name: "IVA 19%", percent: 19, is_active: true }];
    const payload = emissionPayload({
      client_name: "Ana Ruiz",
      payments: [{ method_code: "efectivo", amount: 83300 }],
    });
    const lines = payload.items.map((item) => invoiceItemSchema.parse(item));

    const detail = await emit({
      payments: [{ method_code: "efectivo", amount: 83300 }],
    });

    // El consecutivo lo reserva la MISMA transacción (005, adentro).
    expect(createStub.consecutives).toEqual([1]);
    expect(createStub.commits).toBe(1);
    // La factura: los montos de `computeInvoiceTotals` con el impuesto activo,
    // escritos verbatim.
    const totals = computeInvoiceTotals({
      items: lines,
      discount: 0,
      activeTaxes: [{ code: "IVA", name: "IVA 19%", percent: 19 }],
    });
    expect(createStub.invoices[0]).toMatchObject({
      sede_id: createStub.SEDE_ID,
      consecutive_number: 1,
      idempotency_key: IDEMPOTENCY_KEY,
      client_name: "Ana Ruiz",
      client_document: null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      surcharge: 0,
      total: totals.total,
      status: "Pagada",
      user_id: "u-1",
      cash_shift_id: createStub.SHIFT_ID,
      closed_by: "u-1",
    });
    expect(createStub.invoices[0]?.closed_at).toEqual(expect.any(String));
    // El snapshot de impuestos: el grupo ENTERO, con el monto computado.
    expect(createStub.taxes).toHaveLength(1);
    expect(createStub.taxes[0]).toMatchObject({
      invoice_id: createStub.invoices[0]?.id,
      ...totals.taxes[0],
    });
    // La línea: el subtotal de `computeLineSubtotal` y los campos de comisión de
    // `normalizeCommissionFields`.
    expect(createStub.items).toHaveLength(1);
    expect(createStub.items[0]).toMatchObject({
      invoice_id: createStub.invoices[0]?.id,
      item_type: "producto",
      product_id: PRODUCT_ID,
      service_id: null,
      employee_id: EMPLOYEE_ID,
      qty: 2,
      unit_price: 35000,
      discount: 0,
      subtotal: computeLineSubtotal(lines[0]).subtotal,
      ...normalizeCommissionFields(lines[0]),
    });
    // La porción: el bruto y el recargo de `computeCardFees` (efectivo, 0%).
    const fees = computeCardFees(payload.payments, () => 0);
    expect(createStub.payments).toHaveLength(1);
    expect(createStub.payments[0]).toMatchObject({
      invoice_id: createStub.invoices[0]?.id,
      method_code: "efectivo",
      amount: fees[0].gross,
      fee_percent: fees[0].feePercent,
      fee_amount: fees[0].fee,
      cash_shift_id: createStub.SHIFT_ID,
    });
    // El kardex: UN OUT por la deducción (046), con el motivo de
    // `buildInvoiceOutReason` —el del consecutivo que reservó la transacción—.
    expect(createStub.movements).toHaveLength(1);
    expect(createStub.movements[0]).toMatchObject({
      sede_id: createStub.SEDE_ID,
      product_id: PRODUCT_ID,
      type: "OUT",
      qty: 2,
      user_id: "u-1",
      idempotency_key: null,
      reason: buildInvoiceOutReason(1, "Ana Ruiz"),
    });
    // Una ESCRITURA por grupo, como antes (una sentencia cada uno).
    expect(createStub.inserts).toMatchObject({
      invoices: 1,
      invoice_items: 1,
      invoice_taxes: 1,
      invoice_payments: 1,
      inventory_movements: 1,
    });
    // Y el detalle que recibe el llamador es el de la factura escrita.
    expect(detail.invoice.total).toBe(totals.total);
    expect(detail.remaining).toBe(0);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("un fallo de un grupo dentro de la transacción no deja NADA escrito: ni una fila, ni el consecutivo", async () => {
    createStub.failGroup = "stock";

    const failure: unknown = await emit().catch((error: unknown) => error);

    // El contrato de negocio del camino de stock NO cambia: el mismo código y
    // el mismo 409 que devolvía el bucle viejo.
    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "INSUFFICIENT_STOCK", status: 409 });
    assertNoResidue();
    // El consecutivo NO se quema: la reserva es de la MISMA transacción y se
    // revierte con ella. La serie no tiene hueco en ningún camino.
    expect(createStub.consecutives).toEqual([]);
    expect(createStub.commits).toBe(0);
    // Y no hay nada que compensar: no queda un `catch {}` que tragarse el fallo.
    expect(createStub.compensationSteps).toEqual([]);
    // El reintento del MISMO intento (la marca no se consumió) emite la factura
    // completa: no quedó un estado a medias que lo bloquee.
    createStub.failGroup = null;
    const detail = await emit();
    expect(detail.invoice.consecutive_number).toBe(1);
    expect(createStub.consecutives).toEqual([1]);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("la relectura del detalle NO borra una emisión ya confirmada, y el reintento la devuelve", async () => {
    createStub.failGroup = "detail";

    const failure: unknown = await emit().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    // El fallo es de LECTURA, posterior a la escritura. MEDIDO: este caso ya era
    // el menos malo de la ruta vieja —`return loadDetail(...)` devolvía la
    // promesa SIN `await` dentro del `try`, así que su rechazo escapaba y la
    // compensación no corría— y dejaba una emisión completa; lo que NO podía
    // decir era que la emisión SÍ se había hecho, y el llamador veía un fallo de
    // emisión con una factura viva (que el reintento de la 041 resolvía de
    // casualidad).
    // Con la transacción, el commit es UNO y anterior a la lectura: la emisión
    // quedó COMPLETA, no hay compensación posible ni deseable, y el reintento del
    // MISMO envío devuelve la factura — no es casualidad, es el contrato de 041.
    assertNoResidue();
    expect(createStub.commits).toBe(1);
    expect(createStub.compensationSteps).toEqual([]);
    // El reintento del MISMO envío (la marca de 041) devuelve la factura ya
    // emitida: el cliente no necesita reparar nada.
    const detail = await emit();
    expect(detail.invoice.consecutive_number).toBe(1);
    expect(createStub.invoices).toHaveLength(1);
    expect(createStub.consecutives).toEqual([1]);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("el consecutivo se rinde en TODOS los caminos: se consume, no se reserva en la repetición y NO se quema al fallar", async () => {
    await emit();
    expect(createStub.consecutives).toEqual([1]);

    // La repetición de la MISMA marca ni reserva (041): es un no-op.
    await emit();
    expect(createStub.consecutives).toEqual([1]);

    await emit({ idempotency_key: OTHER_IDEMPOTENCY_KEY });
    expect(createStub.consecutives).toEqual([1, 2]);

    // Un fallo a mitad de la transacción NO quema el 3.
    createStub.failGroup = "items";
    const failure: unknown = await emit({ idempotency_key: THIRD_IDEMPOTENCY_KEY }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BillingError);
    expect(createStub.consecutives).toEqual([1, 2]);
    // Y como no se quemó, el MISMO intento reintentado toma el 3: la serie sigue
    // CONTINUA, sin hueco, en el camino de éxito y en el de fallo.
    createStub.failGroup = null;
    const retried = await emit({ idempotency_key: THIRD_IDEMPOTENCY_KEY });
    expect(retried.invoice.consecutive_number).toBe(3);
    expect(createStub.consecutives).toEqual([1, 2, 3]);
    expect(createStub.invoices).toHaveLength(3);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("la repetición (041) sigue siendo un no-op: una sola transacción y un solo consecutivo", async () => {
    const first = await emit();
    const second = await emit();

    expect(second.invoice.id).toBe(first.invoice.id);
    expect(createStub.commits).toBe(1);
    expect(createStub.invoices).toHaveLength(1);
    expect(createStub.consecutives).toEqual([1]);
    // La repetición se resuelve ANTES de la transacción (el lookup de la 041):
    // el RPC se llamó UNA sola vez.
    expect(
      createStub.rpcCalls.filter((call) => call.name === "invoice_create_atomic"),
    ).toHaveLength(1);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: un fallo con la marca A no la consume (no queda una emisión fantasma)", async () => {
    createStub.failGroup = "stock";
    const failure: unknown = await emit().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BillingError);
    createStub.failGroup = null;

    // Otra venta, otra marca: se emite y NO reconoce la marca A.
    const other = await emit({ idempotency_key: OTHER_IDEMPOTENCY_KEY });
    expect(other.invoice.consecutive_number).toBe(1);
    // El MISMO intento fallido, reintentado: emite de verdad (no hay factura
    // fantasma que lo haga pasar por repetido) y la serie sigue continua.
    const retried = await emit();
    expect(retried.invoice.consecutive_number).toBe(2);
    expect(createStub.invoices).toHaveLength(2);
    expect(createStub.consecutives).toEqual([1, 2]);
    expect(createStub.unexpectedQueries).toEqual([]);
  });

  it("los grupos viajan como DATO en UN solo request: la marca, el turno y los arreglos completos", async () => {
    await emit();

    const calls = createStub.rpcCalls.filter((call) => call.name === "invoice_create_atomic");
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    // La sede NO viaja: la instalación es de una sola sede (071) y la función
    // la toma del turno que bloquea. Mandarla sería la segunda frontera.
    expect(args).not.toHaveProperty("p_sede_id");
    expect(args).toMatchObject({
      p_user_id: "u-1",
      p_cash_shift_id: createStub.SHIFT_ID,
      p_idempotency_key: IDEMPOTENCY_KEY,
    });
    // Los cuatro grupos son ARREGLOS (nunca una fila por request) y el motivo del
    // OUT es una PLANTILLA: el consecutivo lo pone la transacción.
    expect(args.p_items).toHaveLength(1);
    expect(args.p_payments).toHaveLength(1);
    expect(args.p_out_items).toEqual([{ product_id: PRODUCT_ID, qty: 2 }]);
    expect(String(args.p_out_reason)).toContain("{consecutivo}");
    // Auditoría del acto: sigue FUERA de la transacción (posterior al commit).
    expect(createStub.commits).toBe(1);
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
    payStub.failCloseOnce = false;
    payStub.invoiceUpdate = null;
    payStub.rpcEvents.length = 0;
    payStub.unexpectedQueries = [];
    payStub.active = true;
    payStub.shiftStatus = "abierto";
    payStub.closeShiftBeforeCommit = false;
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

  it("el tope de 031 sigue traduciéndose a OVERPAID cuando la marca NO es una repetición", async () => {
    // El primer cobro cierra la factura...
    await splitPayment(payStub.SEDE_ID, payStub.INVOICE_ID, closeInvoice(payStub.INVOICE_ID), ACTOR);
    // ...y un SEGUNDO intento distinto entra con una lectura VIEJA del saldo (el
    // doble le sirve la foto previa una sola vez), con lo que pasa la
    // comprobación exacta y llega a escribir: ahí lo rechaza el tope de 031
    // (P0001) y, como su marca no está registrada, NO es una repetición.
    payStub.stalePaymentsOnce = [];

    const failure: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID, TOTAL, OTHER_MARK),
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    // El cobro rechazado no dejó NADA: ni su porción ni un cambio de estado.
    expect(payStub.payments).toHaveLength(1);
    expect(payInserts()).toBe(2);
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

  // ---- CL-11: el cobro y el cierre de la factura, en UNA transacción ---
  //
  // `splitPayment` escribía DOS veces: las N porciones (el dinero que entra) y
  // DESPUÉS el paso a `Pagada`. Un fallo entre los dos dejaba las porciones
  // escritas con la factura todavía Emitida: el dinero cobrado, el saldo en cero
  // —así que ningún cobro posterior podía completarlo— y la factura que nunca se
  // cerraba.

  it("un fallo en la transacción no deja NADA escrito, y el reintento COMPLETA el cobro", async () => {
    // El paso a `Pagada` (la SEGUNDA escritura) no se puede aplicar. Antes de la
    // 050 eso dejaba las porciones ya escritas; ahora la transacción entera se
    // revierte.
    payStub.failCloseOnce = true;

    const failure: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    ).catch((error: unknown) => error);

    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 050): la
    // porción quedaba escrita (el dinero cobrado), la factura seguía Emitida con
    // el saldo cobrable en CERO, el reintento era un no-op que la devolvía
    // abierta y ningún cobro posterior podía cerrarla (OVERPAID). La factura
    // nunca se cerraba.
    expect(failure).toBeInstanceOf(BillingError);
    expect(payStub.payments).toEqual([]);
    const invoice = () => payStub.invoices.find((row) => row.id === payStub.INVOICE_ID) as Record<string, unknown>;
    expect(invoice().status).toBe("Emitida");
    // No vacuidad: el intento SÍ llegó a pedir la escritura de las porciones
    // (la transacción las revirtió, no es que nunca se hayan pedido).
    expect(payInserts()).toBe(1);

    // El reintento del MISMO intento COMPLETA el cobro entero.
    const retry = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    );

    expect(retry.invoice.status).toBe("Pagada");
    expect(payStub.payments).toHaveLength(1);
    expect(payStub.payments[0].idempotency_key).toBe(MARK);
    expect(invoice().status).toBe("Pagada");
  });

  it("el camino de éxito escribe EXACTAMENTE las porciones que computa el servicio", async () => {
    const portions = [
      { method_code: "efectivo", amount: 60000 },
      { method_code: "transferencia", amount: 40000 },
    ];

    const result = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      { idempotency_key: MARK, portions },
      ACTOR,
    );

    // DATO DE ENTRADA → FILA ESCRITA: el reparto por método (neto, recargo,
    // bruto) lo computa `computeCardFees` en TypeScript y la función lo escribe
    // verbatim. Se recalcula acá con la MISMA función de producción.
    const expected = computeCardFees(portions, () => 0);
    expect(
      payStub.payments.map((row) => ({
        method_code: row.method_code,
        amount: row.amount,
        fee_percent: row.fee_percent,
        fee_amount: row.fee_amount,
      })),
    ).toEqual(
      expected.map((fee) => ({
        method_code: fee.method_code,
        amount: fee.gross,
        fee_percent: fee.feePercent,
        fee_amount: fee.fee,
      })),
    );
    // Y el cierre de la factura: los MISMOS tres campos de siempre.
    expect(result.invoice.status).toBe("Pagada");
    expect(payStub.invoiceUpdate).toEqual({
      status: "Pagada",
      closed_by: "u-1",
      closed_at: expect.any(String),
    });
    expect(payStub.unexpectedQueries).toEqual([]);
  });

  it("una factura anulada se rechaza con CERO escrituras (la precondición también se revalida adentro)", async () => {
    const invoice = payStub.invoices.find((row) => row.id === payStub.INVOICE_ID) as Record<string, unknown>;
    invoice.status = "Anulada";

    const failure: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "ANNUL_INVALID", status: 409 });
    expect(payStub.payments).toEqual([]);
    expect(payInserts()).toBe(0);
    expect(invoice.status).toBe("Anulada");
  });

  // ---- CL-17: el TURNO se bloquea y se revalida dentro de la transacción ---
  //
  // El cobro dividido lee el turno abierto en el SERVICIO y después escribe sus
  // porciones con ese `cash_shift_id`. Entre la lectura y el commit cabe un
  // `closeShift` (049), y la transacción no lo miraba: las porciones caían en un
  // turno YA cerrado. MEDIDO ANTES DEL ARREGLO (verbatim):
  //
  //     expected BillingError { code: 'OVERPAID', status: 422 } to match object
  //       { code: 'NO_OPEN_SHIFT', status: 409 }
  //     expected [ { id: 'pago-1', …(9) } ] to deeply equal []   (invoice_payments)

  it("CL-17: el turno que se cierra a mitad del cobro lo RECHAZA, sin escribir nada", async () => {
    payStub.closeShiftBeforeCommit = true;

    const failure: unknown = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BillingError);
    expect(failure).toMatchObject({ code: "NO_OPEN_SHIFT", status: 409 });
    // Nada escrito: ni una porción, ni el cierre de la factura.
    expect(payStub.payments).toEqual([]);
    expect(payInserts()).toBe(0);
    expect(payStub.invoiceUpdate).toBeNull();
    const invoice = payStub.invoices.find((row) => row.id === payStub.INVOICE_ID) as Record<string, unknown>;
    expect(invoice.status).toBe("Emitida");
    expect(payStub.unexpectedQueries).toEqual([]);
  });

  it("CL-17: el reintento COMPLETA el cobro cuando el turno vuelve a estar abierto", async () => {
    payStub.closeShiftBeforeCommit = true;
    await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    ).catch((error: unknown) => error);
    expect(payStub.payments).toEqual([]);

    // La transacción rechazada no dejó marca (se revirtió entera): el reintento
    // con el turno abierto es una operación NUEVA que termina el cobro.
    payStub.shiftStatus = "abierto";
    const retry = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    );

    expect(retry.invoice.status).toBe("Pagada");
    expect(payStub.payments).toHaveLength(1);
    expect(payStub.invoiceUpdate).toEqual({
      status: "Pagada",
      closed_by: "u-1",
      closed_at: expect.any(String),
    });
  });

  it("control negativo: con el turno abierto el mismo cobro cierra la factura", async () => {
    const result = await splitPayment(
      payStub.SEDE_ID,
      payStub.INVOICE_ID,
      closeInvoice(payStub.INVOICE_ID),
      ACTOR,
    );

    // El lock del turno no puede romper el camino feliz: con el turno abierto el
    // cobro cierra la factura con sus datos de cierre, como siempre.
    expect(result.invoice.status).toBe("Pagada");
    expect(payStub.payments).toHaveLength(1);
    expect(payStub.invoiceUpdate).toMatchObject({ status: "Pagada", closed_by: "u-1" });
    expect(payStub.unexpectedQueries).toEqual([]);
  });
});

// ---------------- CL-11: el diff del servicio vive en la persistencia ---
//
// Tercera de las tres comprobaciones de "no se movió aritmética de dinero a
// SQL": el diff del servicio toca SÓLO el bloque de escritura. Las dos
// operaciones cambian su forma de persistir —dos requests sueltos pasan a ser
// una transacción— y nada más: el estado anulable, el candado de nómina, el
// texto de la reversión, el reparto por método, el saldo, la igualdad exacta y
// la decisión `Pagada` siguen siendo líneas de TypeScript.

describe("billing: CL-11 el diff del servicio vive en el bloque de persistencia", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  );

  /** Cuerpo del `export async function <name>` (hasta la siguiente exportada). */
  function bodyOf(name: string): string {
    const start = service.indexOf(`export async function ${name}`);
    expect(start, `existe ${name}`).toBeGreaterThan(-1);
    const end = service.indexOf("export async function", start + 10);
    return service.slice(start, end === -1 ? service.length : end);
  }

  it("las DOS operaciones escriben por RPC y ninguna abre una escritura suelta", () => {
    const cases = [
      { name: "annulInvoice", rpc: "invoice_annul_atomic" },
      { name: "splitPayment", rpc: "invoice_split_payment_atomic" },
    ] as const;

    for (const item of cases) {
      const body = bodyOf(item.name);
      // UNA transacción por operación: ni dos `rpc` por un descuido, ni uno de
      // menos.
      expect(body.match(/db\.rpc\(/g) ?? [], item.name).toHaveLength(1);
      expect(body, item.name).toContain(`db.rpc("${item.rpc}"`);
      // La factura ya no se escribe desde el cliente en ninguna de las dos.
      expect(body, item.name).not.toContain('.from("invoices")');
    }
    // La anulación ya no escribe sus reversiones con `registerMovement` (045 la
    // listaba entre sus llamadores de facturación) ni toca la tabla del kardex.
    const annul = bodyOf("annulInvoice");
    expect(annul).not.toContain("registerMovement(");
    expect(annul).not.toContain("inventory_movements");
    // El cobro ya no inserta sus porciones desde el cliente.
    const split = bodyOf("splitPayment");
    expect(split).not.toContain('.from("invoice_payments")');
    expect(split).not.toContain(".insert(");
  });

  it("la aritmética y las decisiones de plata se quedan en TypeScript: viajan como DATO", () => {
    // La anulación: qué se revierte y con qué motivo.
    const annul = bodyOf("annulInvoice");
    expect(annul).toContain("canAnnulStatus(");
    expect(annul).toContain("invoiceInClosedPayroll(");
    expect(annul).toContain("buildReversalReasons(");
    expect(annul).toContain("p_items: reversals.map(");
    // El cobro: el reparto por método, el saldo, la igualdad exacta y la
    // decisión de cerrar la factura — exactamente las líneas que ya estaban.
    const split = bodyOf("splitPayment");
    expect(split).toContain("computeCardFees(");
    expect(split).toContain("invoiceNetBalance({");
    expect(split).toContain("moneyEquals(");
    expect(split).toContain("balance.netCollected + netSum - balance.netBilled");
    expect(split).toContain(
      'const closesInvoice = fullyPaid && detail.invoice.status === "Emitida"',
    );
    expect(split).toContain("p_mark_paid: closesInvoice,");
    expect(split).toContain("p_portions: fees.map(");
    // Y la marca de la 042 se sigue buscando ANTES de la escritura: una
    // repetición no llega a la transacción.
    expect(split.indexOf("findInvoicePaymentsByIdempotencyKey(")).toBeLessThan(
      split.indexOf('db.rpc("invoice_split_payment_atomic"'),
    );
  });

  it("las funciones escriben las MISMAS columnas que el servicio leía con INVOICE_SELECT", () => {
    // La lista no es una transcripción a mano: es la del `select(...)` con el
    // que el servicio leía esa fila, y es la que el `jsonb_build_object` de la
    // 050 devuelve (ver el bloque de la migración).
    const match = /const INVOICE_SELECT =\s*\n?\s*"([^"]+)"/.exec(service);
    expect(match, "INVOICE_SELECT").not.toBeNull();
    const columns = (match as RegExpExecArray)[1].split(",").map((column) => column.trim());
    expect(columns).toEqual([
      "id",
      "sede_id",
      "consecutive_number",
      "client_name",
      "client_document",
      "subtotal",
      "discount",
      "tax",
      "surcharge",
      "total",
      "status",
      "user_id",
      "cash_shift_id",
      "closed_by",
      "closed_at",
      "cancel_reason",
      "created_at",
      "edit_version",
    ]);
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "050_billing_state_atomic.sql"),
      "utf8",
    );
    for (const column of columns) expect(sql, column).toContain(`'${column}'`);
  });

  it("CL-17: el cobro manda el TURNO a la transacción y traduce su cierre", () => {
    // El turno viaja como DATO (parámetro de la operación) además de dentro de
    // cada porción: es el turno que la función BLOQUEA y al que exige que
    // pertenezcan TODAS las porciones.
    const split = bodyOf("splitPayment");
    expect(split).toContain("p_shift_id: payShift.id");
    // Y el rechazo de adentro (SHIFT_CLOSED/SHIFT_NOT_FOUND, que llegan con el
    // SQLSTATE del tope P0001) se traduce al MISMO error que el servicio usa
    // para "no hay caja abierta", mirando el MENSAJE antes que el código.
    expect(split).toContain('message.includes("SHIFT_CLOSED")');
    expect(split).toContain('message.includes("SHIFT_NOT_FOUND")');
    expect(split).toContain('"NO_OPEN_SHIFT",');
    expect(split).toContain("No hay caja abierta: abre tu turno para pagar.");
    expect(split.indexOf('message.includes("SHIFT_CLOSED")')).toBeLessThan(
      split.indexOf('if (code === "23505" || code === "P0001")'),
    );
  });
});

// ---------------- CL-17: la migración 056 ----------------

describe("migración 056_collection_closes_invoice.sql (CL-17)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "056_collection_closes_invoice.sql"),
    "utf8",
  );
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("dropea la firma vieja del cobro dividido y crea la nueva", () => {
    // HISTORIA, NO ESTADO: estas aserciones fijan el archivo 056 tal como se
    // aplicó. Una migración aplicada no se reescribe, así que acá la firma lleva
    // el parámetro de sede aunque hoy la vigente sea la de 071 (que ya no lo
    // tiene); la firma de hoy se afirma en la suite de 071, más abajo.
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_split_payment_atomic\(\s*p_sede_id uuid,\s*p_invoice_id uuid,\s*p_shift_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,/,
    );
  });

  it("el cobro dividido bloquea el TURNO (FOR SHARE) antes de la factura y lo revalida", () => {
    // El orden global `cash_shifts > invoices` es la propiedad que hace que el
    // lock no pueda deadlockear con `closeShift` (que sólo toma el turno).
    expect(sql).toContain("FROM public.cash_shifts s");
    expect(sql).toContain("FOR SHARE OF s");
    expect(sql).toContain("v_turno.status <> 'abierto'");
    expect(sql).toContain("'SHIFT_CLOSED'");
    const shiftsLock = sql.indexOf("FOR SHARE OF s");
    const invoicesLock = sql.indexOf("FOR UPDATE OF i");
    expect(shiftsLock).toBeGreaterThan(-1);
    expect(invoicesLock).toBeGreaterThan(shiftsLock);
    // Y todas las porciones pertenecen al turno bloqueado.
    expect(sql).toMatch(/\(item ->> 'cash_shift_id'\)::uuid <> p_shift_id/);
  });

  it("conserva el cierre del dividido con sus datos y las redes de conteo", () => {
    const splitStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic");
    const update = sql.slice(
      sql.indexOf("UPDATE public.invoices", splitStart),
      sql.indexOf("RETURNING * INTO v_factura", splitStart),
    );
    expect(update).toMatch(/status = 'Pagada'/);
    expect(update).toMatch(/closed_by = p_user_id/);
    expect(update).toMatch(/closed_at = p_closed_at/);
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(5);
    expect(sql).toContain("PAYMENT_MISMATCH");
  });

  it("cierra el permiso de las dos funciones y no mueve aritmética de dinero", () => {
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb) TO service_role",
    );
    expect(sql).toContain("SECURITY INVOKER");
    for (const column of ["amount", "fee_amount", "total", "surcharge"]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(ddl).not.toMatch(/round\s*\(/i);
    expect(ddl).not.toMatch(/invoices\.total/);
  });
});

// ---------------- CL-11: la migración 050 ----------------

describe("migración 050_billing_state_atomic.sql (CL-11)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "050_billing_state_atomic.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("las DOS operaciones viven cada una en UNA función: una sentencia, una transacción", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.invoice_annul_atomic");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.invoice_split_payment_atomic");
    // Los grupos de escritura de cada operación, en la misma función.
    expect(sql).toMatch(/UPDATE public\.invoices/);
    expect(sql).toMatch(/INSERT INTO public\.inventory_movements/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_payments/);
    // Las reversiones y las porciones llegan como ARREGLO (nunca una fila por
    // request).
    expect(sql).toMatch(/jsonb_array_elements\(p_items\)/);
    expect(sql).toMatch(/jsonb_array_elements\(p_portions\)/);
    // El lock de la fila de la factura (el punto de serialización del dinero).
    expect(sql).toMatch(/FOR UPDATE/);
    // Orden determinista de los locks de stock (el orden del trigger de 004).
    expect(sql).toMatch(/ORDER BY p\.id/);
    // Las porciones NO llevan orden: se conserva el del llamador (la fila de
    // identidad de la 042 es la primera).
    expect(sql).toMatch(/FROM jsonb_array_elements\(p_portions\) AS item;/);
  });

  it("conserva las precondiciones de estado que el servicio ya tenía", () => {
    // El compare-and-swap de la anulación, adentro de la transacción.
    expect(sql).toMatch(/v_factura\.status <> p_expected_status/);
    expect(sql).toMatch(/i\.status = p_expected_status/);
    expect(sql).toContain("ANNUL_CONFLICT");
    // La factura anulada no admite cobros.
    expect(sql).toMatch(/v_factura\.status = 'Anulada'/);
    expect(sql).toContain("ANNUL_INVALID");
    // La marca de la 042: a lo sumo UNA porción marcada (la premisa del índice).
    expect(sql).toMatch(/v_marcadas > 1/);
  });

  it("tiene una red de conteo por grupo de escritura, con rollback", () => {
    // Cuatro: el CAS de la factura y las reversiones en la anulación; las
    // porciones y el cierre en el cobro.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(4);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("ANNUL_CONFLICT");
    expect(sql).toContain("PRODUCT_NOT_FOUND");
    expect(sql).toContain("PAYMENT_MISMATCH");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL
    // (la misma trampa que 046–049 documentan).
    expect(sql).toMatch(/coalesce\(/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    // Las tablas ya validan sus montos con los CHECK de 005/019 (validar no es
    // calcular): esta migración no agrega una sola expresión aritmética sobre
    // las columnas de dinero. Escribir = convertir la representación
    // (jsonb → la columna), no operar. Los textos de los `COMMENT ON …` se
    // excluyen: son PROSA que viaja como string, no sentencias.
    const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");
    for (const column of [
      "amount",
      "fee_amount",
      "fee_percent",
      "qty",
      "subtotal",
      "discount",
      "tax",
      "surcharge",
      "total",
    ]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(ddl).not.toContain("CHECK");
    expect(ddl).not.toMatch(/sum\s*\(/i);
    expect(ddl).not.toMatch(/round\s*\(/i);
    // El stock lo sigue aplicando EXCLUSIVAMENTE el trigger de 004: acá no se
    // escribe una sola columna de stock ni se redefinen sus funciones.
    expect(ddl).not.toContain("stock_qty");
    expect(ddl).not.toContain("inventory_apply_stock");
    expect(ddl).not.toContain("inventory_no_negative_stock");
    expect(sql).not.toContain("DROP TRIGGER");
  });

  it("escribe la marca en NULL en las reversiones: quedan FUERA del índice de la 045", () => {
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO public.inventory_movements"),
      sql.indexOf("PRODUCT_NOT_FOUND"),
    );
    expect(insertBlock).toContain("idempotency_key");
    expect(insertBlock).toMatch(/idempotency_key\)[\s\S]*\bNULL\b/);
  });

  it("devuelve EXACTAMENTE lo que el servicio leía (mismo shape)", () => {
    // Tres devoluciones: la factura de la anulación, y la factura + el conteo de
    // porciones del cobro. Cada una lista sus columnas, sin `to_jsonb` de la
    // fila entera (que agregaría `updated_at`, que el servicio nunca leyó).
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(3);
    expect(sql).toMatch(/'portions', v_escritos/);
  });

  it("cierra el permiso: sólo service_role puede ejecutarlas", () => {
    for (const signature of [
      "public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb)",
      "public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public");
  });

  it("no borra ni reescribe datos: sólo las funciones y sus permisos", () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(2);
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(2);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(2);
    // Ningún borrado, y dos UPDATE EJECUTABLES: los mismos que el servicio ya
    // hacía (la anulación y el paso a Pagada).
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(2);
    // `updated_at` lo sigue escribiendo el trigger de 005, no esta migración.
    expect(sql).not.toMatch(/updated_at/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("declara el acoplamiento, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    expect(raw).toContain("050");
    expect(raw).toContain("049");
  });

  it("declara lo que se midió del trigger del stock: el IN no pasa por la guarda", () => {
    // El acoplamiento con la frontera de inventario (el "giro" del stock): la
    // reversión NO reusa `deduct_stock_atomic` (escribe OUT y rechaza el
    // producto repetido) y su IN no toma el lock del BEFORE ROW.
    expect(raw).toContain("trg_inventory_no_negative");
    expect(raw).toContain("trg_inventory_apply_stock");
    expect(raw).toMatch(/IF NEW\.type = 'OUT'/);
    expect(raw).toContain("deduct_stock_atomic");
    expect(raw).toContain("count(DISTINCT product_id)");
  });
});

// ---------------- CL-12: el diff del servicio vive en la persistencia ---
//
// Tercera de las tres comprobaciones de "no se movió aritmética de dinero a
// SQL": las DOS ediciones cambian su forma de persistir —la secuencia de
// requests sueltos pasa a ser una transacción— y nada más. El diff de ítems, el
// subtotal de cada línea, el snapshot de impuestos, los totales, el delta NETO de
// stock con su motivo, el candado y la reconciliación del total inmutable siguen
// siendo líneas de TypeScript.
//
// (La segunda comprobación —el DATO DE ENTRADA → FILA ESCRITA— vive en el
// describe de CL-12 de arriba: los ítems, los impuestos, los totales y los
// movimientos se contrastan contra las funciones de producción que los computan.)

describe("billing: CL-12 el diff del servicio vive en el bloque de persistencia", () => {
  // El archivo se normaliza a LF: el repositorio lo guarda en CRLF y las
  // aserciones de abajo miran LÍNEAS (`\n}\n` cierra una función).
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  /** Cuerpo de `export async function <name>` (hasta su llave de cierre). */
  function bodyOf(name: string): string {
    const start = service.indexOf(`export async function ${name}(`);
    expect(start, `existe ${name}`).toBeGreaterThan(-1);
    const end = service.indexOf("\n}\n", start);
    expect(end, `${name} cierra`).toBeGreaterThan(start);
    return service.slice(start, end + 2);
  }

  /** Cuerpo de una función interna de módulo (`function <name>(`). */
  function functionBody(name: string): string {
    const start = service.indexOf(`\nfunction ${name}(`);
    expect(start, `existe ${name}`).toBeGreaterThan(-1);
    const end = service.indexOf("\n}\n", start);
    expect(end, `${name} cierra`).toBeGreaterThan(start);
    return service.slice(start, end + 2);
  }

  it("las DOS ediciones escriben por RPC y ninguna abre una escritura suelta", () => {
    const cases = [
      { name: "editInvoiceItems", rpc: "invoice_edit_items_atomic" },
      { name: "editEmittedInvoiceItems", rpc: "invoice_edit_emitted_atomic" },
    ] as const;

    for (const item of cases) {
      const body = bodyOf(item.name);
      // UNA transacción por edición: ni dos `rpc` por un descuido, ni uno de
      // menos.
      expect(body.match(/db\.rpc\(/g) ?? [], item.name).toHaveLength(1);
      expect(body, item.name).toContain(`db.rpc("${item.rpc}"`);
      // Ninguna escritura suelta: ni la factura, ni los ítems, ni los impuestos,
      // ni los cobros, ni el kardex (el kardex lo escribe la función).
      for (const table of [
        "invoices",
        "invoice_items",
        "invoice_taxes",
        "invoice_payments",
        "inventory_movements",
      ]) {
        expect(body, `${item.name} no escribe ${table}`).not.toContain(`.from("${table}")`);
      }
      // El ajuste de stock ya no pasa por la frontera de inventario del cliente:
      // viaja como DATO y lo escribe la función.
      expect(body, item.name).not.toContain("registerMovement(");
      // Y el candado ya no se reclama desde el cliente.
      expect(body, item.name).not.toContain("claimInvoiceEdit");
    }
  });

  it("el candado de la 038 se movió adentro: viaja como precondición de la transacción", () => {
    // El compare-and-swap del cliente ya no existe en ninguna parte del módulo.
    expect(service).not.toContain("claimInvoiceEdit");
    // Las dos ediciones llevan las DOS mitades de la precondición (versión y
    // estado, CL-1) leídas antes de llamar: la función las contrasta contra la
    // fila bloqueada.
    for (const name of ["editInvoiceItems", "editEmittedInvoiceItems"] as const) {
      const body = bodyOf(name);
      expect(body, name).toContain("p_expected_version: Number(detail.invoice.edit_version)");
      expect(body, name).toContain("p_expected_status: detail.invoice.status");
    }
  });

  it("la aritmética y las decisiones de plata se quedan en TypeScript: viajan como DATO", () => {
    // La edición ADMIN: la reconciliación del total inmutable, el candado de
    // nómina, el pre-chequeo de stock y las dos proyecciones computadas.
    const admin = bodyOf("editInvoiceItems");
    expect(admin).toContain("assertEditReconciles(");
    expect(admin).toContain("invoiceInClosedPayroll(");
    expect(admin).toContain("planStockDeduction(");
    expect(admin).toContain("editItemColumns(next)");
    expect(admin).toContain("buildEditStockMoves({");
    expect(admin).toContain("items_remove: diff.removed.map(");
    expect(admin).toContain("movements: inventoryMoves,");
    // El subtotal de cada línea y los campos de comisión: `computeLineSubtotal`
    // y `normalizeCommissionFields`, en la proyección del ítem.
    const columns = functionBody("editItemColumns");
    expect(columns).toContain("computeLineSubtotal(");
    expect(columns).toContain("normalizeCommissionFields(");
    // El delta NETO por producto y su tipo: el signo del delta decide OUT/IN y la
    // cantidad absoluta es lo que se escribe. Nada de esto cruza a SQL.
    const moves = functionBody("buildEditStockMoves");
    expect(moves).toContain('type: delta > 0 ? "OUT" : "IN"');
    expect(moves).toContain("Math.abs(delta)");

    // La edición LIBRE: los totales, el snapshot, el saldo y el gate de
    // sobre-cobro — exactamente las líneas que ya estaban.
    const free = bodyOf("editEmittedInvoiceItems");
    expect(free).toContain("computeInvoiceTotals(");
    expect(free).toContain("invoiceNetBalance({");
    expect(free).toContain("overCollectedEdit(");
    expect(free).toContain("overCollectedEditMessage(");
    expect(free).toContain("taxes_remove: detail.taxes.map(");
    expect(free).toContain("taxes: totals.taxes.map(");
    expect(free).toContain("total: newTotal,");
    expect(free).toContain("surcharge,");
    // Y el candado de nómina que la libre comparte con la admin.
    expect(free).toContain("invoiceInClosedPayroll(");
  });

  it("la auditoría queda FUERA de la transacción en las dos ediciones", () => {
    for (const name of ["editInvoiceItems", "editEmittedInvoiceItems"] as const) {
      const body = bodyOf(name);
      // El RPC se llama ANTES de la auditoría: la fila de auditoría no forma
      // parte de la transacción (es el mismo límite que declaran 049 y 050).
      expect(body.indexOf('db.rpc("'), name).toBeLessThan(body.indexOf("await writeAudit("));
    }
  });
});

// ---------------- CL-12: la migración 051 ----------------

describe("migración 051_invoice_edit_atomic.sql (CL-12)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "051_invoice_edit_atomic.sql"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  /**
   * El DDL EJECUTABLE: sin los cuerpos de las funciones (donde vive la
   * operación) y sin los textos de los `COMMENT ON …` (que son PROSA que viaja
   * como string, no sentencias). Es lo que la migración ejecuta fuera de las
   * funciones.
   */
  const ddl = sql
    .replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS $$ ... $$;")
    .replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("las DOS ediciones viven cada una en UNA función: una sentencia, una transacción", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic");
    // Los grupos de escritura de cada edición, cada uno en UNA sentencia.
    expect(sql).toMatch(/UPDATE public\.invoices/);
    expect(sql).toMatch(/DELETE FROM public\.invoice_items/);
    expect(sql).toMatch(/UPDATE public\.invoice_items/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_items/);
    expect(sql).toMatch(/UPDATE public\.invoice_payments/);
    expect(sql).toMatch(/INSERT INTO public\.inventory_movements/);
    // Los del reemplazo: el snapshot de impuestos, que se borra y se inserta.
    expect(sql).toMatch(/DELETE FROM public\.invoice_taxes/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_taxes/);
    // Los grupos llegan como ARREGLO, uno por clave de `p_edit` (nunca una fila
    // por request).
    for (const key of [
      "items_remove",
      "items_update",
      "items_insert",
      "payments",
      "movements",
      "taxes_remove",
      "taxes",
    ]) {
      expect(sql, key).toContain(`p_edit -> '${key}'`);
    }
    expect(sql).toMatch(/jsonb_array_elements\(coalesce\(p_edit -> 'items_update'/);
    // Una clave AUSENTE es un arreglo vacío: el caso legal de "no hay nada de ese
    // grupo" (0 = 0 en las redes de conteo).
    expect(sql.match(/\[\]'::jsonb/g) ?? []).not.toHaveLength(0);
    // El lock de la fila de la factura (el punto de serialización de la 038 y
    // del dinero de esa factura) y el orden determinista de los locks de stock.
    expect(sql).toMatch(/FOR UPDATE OF i/);
    expect(sql).toMatch(/ORDER BY p\.id/);
  });

  it("mueve el candado de la 038 adentro: la precondición (versión + estado) sobre la fila bloqueada", () => {
    // El token se escribe con la versión leída como precondición, en su propio
    // WHERE, y la fila se relee bloqueada antes.
    expect(sql).toMatch(/edit_version = p_expected_version \+ 1/);
    expect(sql).toMatch(/i\.edit_version = p_expected_version/);
    expect(sql).toMatch(/i\.status = p_expected_status/);
    expect(sql).toMatch(/v_factura\.edit_version <> p_expected_version/);
    expect(sql).toMatch(/v_factura\.status <> p_expected_status/);
    expect(sql).toContain("EDIT_CONFLICT");
    // El estado leído sigue siendo la OTRA mitad (CL-1) y la fila tiene que ser
    // de la sede del actor. HISTORIA DEL ARCHIVO 051: con la instalación de una
    // sola sede, 071 saca ese predicado (y el parámetro) sin tocar el candado.
    expect(sql).toMatch(/i\.sede_id = p_sede_id/);
  });

  it("tiene una red de conteo por grupo de escritura, con rollback", () => {
    // Catorce: seis en la edición admin (la factura, los tres de ítems, los
    // cobros y los movimientos) y ocho en la libre (los seis MÁS el borrado y la
    // inserción del snapshot de impuestos).
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(14);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("EDIT_CONFLICT");
    expect(sql).toContain("ITEM_MISMATCH");
    expect(sql).toContain("PAYMENT_MISMATCH");
    expect(sql).toContain("TAX_MISMATCH");
    expect(sql).toContain("PRODUCT_NOT_FOUND");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL (la
    // misma trampa que 046–050 documentan).
    expect((sql.match(/coalesce\(/g) ?? []).length).toBeGreaterThan(10);
  });

  it("el REEMPLAZO se cuenta en las DOS mitades: lo que se leyó y lo que se computó", () => {
    // El borrado de ítems y el del snapshot viejo van por ID y por factura, y su
    // cuenta es contra los ids RECIBIDOS: un reemplazo se puede contar así, un
    // `DELETE ... WHERE invoice_id = …` a ciegas no.
    expect(sql).toMatch(/DELETE FROM public\.invoice_items d[\s\S]*?AND d\.id IN/);
    expect(sql).toMatch(/DELETE FROM public\.invoice_taxes t[\s\S]*?AND t\.id IN/);
    // Y las dos inserciones del reemplazo se cuentan contra lo que llegó.
    expect(sql.match(/INSERT INTO public\.invoice_taxes/g) ?? []).toHaveLength(1);
    expect(sql.match(/INSERT INTO public\.invoice_items/g) ?? []).toHaveLength(2);
  });

  it("el UPDATE y el INSERT de ítems escriben LAS MISMAS columnas", () => {
    // Las dos proyecciones tienen que coincidir columna por columna: si se
    // separan, una línea editada y una línea nueva quedarían con datos distintos
    // sin que nada lo note.
    const updateBlock = sql.slice(
      sql.indexOf("UPDATE public.invoice_items d"),
      sql.indexOf("INSERT INTO public.invoice_items"),
    );
    const insertBlock = sql.slice(
      sql.indexOf("INSERT INTO public.invoice_items", sql.indexOf("INSERT INTO public.invoice_items") + 1),
      sql.indexOf("GET DIAGNOSTICS", sql.indexOf("INSERT INTO public.invoice_items", sql.indexOf("INSERT INTO public.invoice_items") + 1)),
    );
    const columns = [
      "item_type",
      "product_id",
      "service_id",
      "custom_name",
      "employee_id",
      "qty",
      "unit_price",
      "discount",
      "no_commission",
      "commission_value",
      "commission_mode",
      "commission_percent_override",
      "subtotal",
    ];
    for (const column of columns) {
      expect(updateBlock, `update ${column}`).toContain(`item ->> '${column}'`);
      expect(insertBlock, `insert ${column}`).toContain(`item ->> '${column}'`);
    }
    // La edición admin escribe SÓLO el token en la factura: su función no tiene
    // un grupo capaz de escribir dinero. Es la inmutabilidad del total como
    // AUSENCIA, no como promesa del llamador.
    const adminBlock = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.invoice_edit_items_atomic"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.invoice_edit_emitted_atomic"),
    );
    const adminInvoiceUpdate = adminBlock.slice(
      adminBlock.indexOf("UPDATE public.invoices"),
      adminBlock.indexOf("RETURNING * INTO v_factura;"),
    );
    expect(adminInvoiceUpdate).toContain("SET edit_version = p_expected_version + 1");
    for (const column of ["subtotal", "discount", "tax", "surcharge", "total"]) {
      expect(adminInvoiceUpdate, `admin no escribe ${column}`).not.toMatch(
        new RegExp(`SET[\\s\\S]*${column}\\s*=`),
      );
    }
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    // Las tablas ya validan sus montos con los CHECK de 005/019 (validar no es
    // calcular): esta migración no agrega una sola expresión aritmética sobre
    // las columnas de dinero. Los CUERPOS de las funciones son las únicas
    // sentencias que escriben: si la aritmética de dinero se hubiera mudado a
    // SQL, estaría acá. Escribir = convertir la representación (jsonb → la
    // columna), no operar.
    const bodies = (sql.match(/AS \$\$[\s\S]*?\n\$\$;/g) ?? []).join("\n");
    expect(bodies.length).toBeGreaterThan(5000);
    for (const column of [
      "amount",
      "percent",
      "qty",
      "unit_price",
      "subtotal",
      "discount",
      "tax",
      "surcharge",
      "total",
      "commission_value",
    ]) {
      expect(bodies, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    // Ninguna agregación ni redondeo: el subtotal, los impuestos y el total
    // llegan calculados.
    expect(bodies).not.toMatch(/sum\s*\(/i);
    expect(bodies).not.toMatch(/round\s*\(/i);
    expect(bodies).not.toMatch(/count\s*\(/i);
    expect(bodies).not.toContain("CHECK");
    // El stock lo sigue aplicando EXCLUSIVAMENTE el trigger de 004: acá no se
    // escribe una sola columna de stock ni se redefinen sus funciones.
    expect(bodies).not.toContain("stock_qty");
    expect(bodies).not.toContain("inventory_apply_stock");
    expect(bodies).not.toContain("inventory_no_negative");
    expect(sql).not.toContain("DROP TRIGGER");
    // La única escritura sobre `products` es una LECTURA para el JOIN del kardex
    // (la sede del producto), nunca un UPDATE.
    expect(bodies).not.toMatch(/UPDATE public\.products/);
  });

  it("escribe la marca en NULL en los movimientos: quedan FUERA del índice de la 045", () => {
    const inserts = sql.match(/INSERT INTO public\.inventory_movements[\s\S]*?ORDER BY p\.id;/g) ?? [];
    expect(inserts).toHaveLength(2);
    for (const block of inserts) {
      expect(block).toContain("idempotency_key");
      expect(block).toMatch(/idempotency_key\)[\s\S]*?\bNULL\b/);
    }
  });

  it("devuelve EXACTAMENTE lo que el servicio leía (mismo shape)", () => {
    // Cuatro devoluciones: la factura y los conteos de cada edición. Cada una
    // lista sus columnas, sin `to_jsonb` de la fila entera (que agregaría
    // `updated_at`, que el servicio nunca leyó).
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(4);
    expect(sql.match(/'items', v_items_escritos/g) ?? []).toHaveLength(2);
    expect(sql.match(/'movements', v_movimientos/g) ?? []).toHaveLength(2);
    // Las mismas columnas de INVOICE_SELECT, en las dos.
    for (const column of [
      "consecutive_number",
      "client_document",
      "cancel_reason",
      "closed_by",
      "closed_at",
      "cash_shift_id",
      "edit_version",
    ]) {
      expect(sql.match(new RegExp(`'${column}'`, "g")) ?? []).toHaveLength(2);
    }
  });

  it("cierra el permiso: sólo service_role puede ejecutarlas", () => {
    for (const signature of [
      "public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb)",
      "public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public");
  });

  it("la migración sólo crea funciones y permisos: no toca el esquema ni los datos", () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(2);
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(2);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(2);
    // El DDL SIN los cuerpos de las funciones: lo que la migración ejecuta
    // fuera de ellas no tiene una sola sentencia de datos. Los DELETE/INSERT/
    // UPDATE que el archivo contiene son la OPERACIÓN de la edición (el
    // reemplazo de ítems e impuestos) y viven ADENTRO de la transacción de esa
    // operación, no son una migración de datos.
    expect(ddl).not.toMatch(/\bDELETE\b/);
    expect(ddl).not.toMatch(/\bINSERT\b/);
    expect(ddl).not.toMatch(/\bUPDATE public\./);
    expect(ddl).not.toMatch(/^\s*ALTER TABLE/im);
    expect(ddl).not.toMatch(/^\s*CREATE INDEX/im);
    expect(ddl).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP CONSTRAINT");
    // `updated_at` lo sigue escribiendo el trigger de 005, no esta migración.
    expect(sql).not.toMatch(/updated_at/);
    // Los seis UPDATE y los cinco INSERT/TRES DELETE de los cuerpos: las MISMAS
    // escrituras que el servicio ya hacía.
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(6);
    expect(sql.match(/INSERT INTO public\./g) ?? []).toHaveLength(5);
    expect(sql.match(/DELETE FROM public\./g) ?? []).toHaveLength(3);
  });

  it("declara el acoplamiento, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    expect(raw).toContain("051");
    expect(raw).toContain("050");
    expect(raw).toContain("038");
    expect(raw).toContain("032 no existe");
  });

  it("declara el REEMPLAZO y lo que se midió de las dos ventanas", () => {
    // El archivo tiene que decir qué significa todo-o-nada cuando la operación
    // reemplaza una colección en vez de agregar filas, y de dónde salen las
    // líneas que se midieron.
    expect(raw).toContain("REEMPLAZO");
    expect(raw).toContain("editInvoiceItems");
    expect(raw).toContain("editEmittedInvoiceItems");
    expect(raw).toContain("invoice_taxes");
    expect(raw).toContain("CIERRE DEL TURNO");
    expect(raw).toContain("EDIT_CONFLICT");
    // Las líneas que se MIDIERON: las dos ventanas, con su archivo y su línea.
    expect(raw).toContain("service.ts:1516");
    expect(raw).toContain("service.ts:1765");
    expect(raw).toContain("idempotency_key");
    expect(raw).toContain("INMUTABLE");
  });
});

// ---------------- CL-13: la emisión vive en UNA transacción ---
//
// Cuarta de las comprobaciones de "no se movió aritmética de dinero a SQL": la
// emisión cambia su forma de persistir —la secuencia de requests sueltos con su
// compensación pasa a ser una transacción— y nada más. Los subtotales de línea,
// el snapshot de impuestos, los totales, el recargo, el estado, el plan de stock
// y el motivo del kardex siguen siendo líneas de TypeScript.
//
// (La comprobación DATO DE ENTRADA → FILA ESCRITA vive en el describe de CL-13
// de arriba, contra las funciones de producción que computan cada dato.)

describe("billing: CL-13 la emisión vive en UNA transacción", () => {
  // El archivo se normaliza a LF: el repositorio lo guarda en CRLF y las
  // aserciones de abajo miran LÍNEAS (`\n}\n` cierra una función).
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  /** Cuerpo de `export async function <name>` (hasta su llave de cierre). */
  function bodyOf(name: string): string {
    const start = service.indexOf(`export async function ${name}(`);
    expect(start, `existe ${name}`).toBeGreaterThan(-1);
    const end = service.indexOf("\n}\n", start);
    expect(end, `${name} cierra`).toBeGreaterThan(start);
    return service.slice(start, end + 2);
  }

  it("la emisión escribe por RPC y no abre una sola escritura suelta", () => {
    const body = bodyOf("createInvoice");
    // UNA transacción: ni dos `rpc` por un descuido, ni uno de menos.
    expect(body.match(/db\.rpc\(/g) ?? []).toHaveLength(1);
    expect(body).toContain('db.rpc("invoice_create_atomic"');
    // Ninguna escritura suelta: ni la factura, ni los ítems, ni los impuestos,
    // ni los cobros, ni el kardex (el kardex lo escribe la función).
    for (const table of [
      "invoices",
      "invoice_items",
      "invoice_taxes",
      "invoice_payments",
      "inventory_movements",
    ]) {
      expect(body, `createInvoice no escribe ${table}`).not.toContain(`.from("${table}")`);
    }
    // Y el descuento de stock dejó de ser un request del cliente.
    expect(body).not.toContain("registerMovement(");
    // El consecutivo ya no se reserva desde el cliente: lo reserva la
    // transacción (es lo que evita el hueco).
    expect(body).not.toContain("next_invoice_number");
  });

  it("la compensación desaparece: no queda un `catch {}` que tragarse su propio fallo", () => {
    // El defecto medido: si la compensación fallaba, el error se lo tragaba el
    // `catch {}` y el residuo quedaba sin que nadie lo supiera. Ninguna de las
    // dos cosas existe más.
    expect(service).not.toContain("cleanupFailedInvoice");
    const body = bodyOf("createInvoice");
    expect(body).not.toContain("catch {");
    expect(body).not.toContain(".delete(");
    // Y no hay compensación porque no hay nada que compensar: el servidor
    // revierte la transacción entera.
    expect(body).toContain('db.rpc("invoice_create_atomic"');
  });

  it("la aritmética y las decisiones de plata se quedan en TypeScript: viajan como DATO", () => {
    const body = bodyOf("createInvoice");
    // Los subtotales de línea, los totales, el snapshot, el recargo, el estado,
    // el plan de stock y el motivo: exactamente las líneas que ya estaban.
    expect(body).toContain("computeInvoiceTotals(");
    expect(body).toContain("computeLineSubtotal(");
    expect(body).toContain("computeCardFees(");
    expect(body).toContain("roundMoney(");
    expect(body).toContain("normalizeCommissionFields(");
    expect(body).toContain("planStockDeduction(");
    expect(body).toContain("buildInvoiceOutReasonTemplate(");
    expect(body).toContain("portionsMatchBalance(");
    expect(body).toContain("insufficientStockError(");
    // Los cinco grupos viajan como ARREGLOS computados, en UN solo pedido.
    expect(body).toContain("p_items: input.items.map(");
    expect(body).toContain("p_taxes: totals.taxes.map(");
    expect(body).toContain("p_payments: fees.map(");
    expect(body).toContain("p_out_items: stockPlan.map(");
    expect(body).toContain("p_invoice: {");
  });

  it("la marca (041) se busca ANTES de la transacción y la auditoría queda FUERA", () => {
    const body = bodyOf("createInvoice");
    // Una repetición no llega a la transacción: el lookup de la marca va primero.
    expect(body.indexOf("findInvoiceByIdempotencyKey(")).toBeLessThan(
      body.indexOf('db.rpc("invoice_create_atomic"'),
    );
    // La auditoría se escribe DESPUÉS del commit (fuera de la transacción), como
    // en las anulaciones y las ediciones: no es un punto de fallo de estado.
    expect(body.indexOf('db.rpc("invoice_create_atomic"')).toBeLessThan(
      body.indexOf("await writeAudit("),
    );
  });

  it("la PLANTILLA del motivo sale de la misma función de formato (el texto no se duplica)", () => {
    // `buildInvoiceOutReasonTemplate` usa `buildInvoiceOutReason` con un
    // consecutivo sentinela y sustituye SÓLO el sentinela: el texto, el separador
    // y el recorte siguen decidiéndose en un solo lugar.
    expect(service).toContain("buildInvoiceOutReasonTemplate");
    expect(service).toContain("buildInvoiceOutReason(OUT_REASON_SENTINEL");
    expect(service).toContain("const OUT_REASON_TOKEN = \"{consecutivo}\"");
    // `String.replace` con un patrón de texto reemplaza sólo la PRIMERA
    // ocurrencia: un nombre de cliente no puede confundirse con el número.
    const start = service.indexOf("export function buildInvoiceOutReasonTemplate");
    const end = service.indexOf("\n}\n", start);
    const template = service.slice(start, end + 2);
    expect(template).toContain(".replace(");
    expect(template).not.toContain("replaceAll");
    // Y el contrato del token se comporta: la plantilla rinde el texto de
    // `buildInvoiceOutReason` con el número reemplazado por el token.
    expect(buildInvoiceOutReasonTemplate("Ana Ruiz")).toBe("FACTURA #{consecutivo} — Ana Ruiz");
    expect(buildInvoiceOutReasonTemplate(null)).toBe(
      "FACTURA #{consecutivo} — Cliente sin nombre",
    );
    expect(buildInvoiceOutReasonTemplate("Ana Ruiz").replace("{consecutivo}", "7")).toBe(
      buildInvoiceOutReason(7, "Ana Ruiz"),
    );
  });
});

// ---------------- CL-13: la migración 052 ----------------

describe("migración 052_invoice_create_atomic.sql (CL-13)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "052_invoice_create_atomic.sql"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  /**
   * El DDL EJECUTABLE: sin los textos de los `COMMENT ON …` (que son PROSA que
   * viaja como string, no sentencias) y sin los cuerpos de las funciones.
   */
  const ddl = sql
    .replace(/AS \$\$[\s\S]*?\n\$\$;/g, "AS $$ ... $$;")
    .replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("la emisión entera vive en UNA función: una sentencia, una transacción", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.invoice_create_atomic");
    // La reserva del consecutivo, ADENTRO (la autoridad de 005). HISTORIA DEL
    // ARCHIVO 052: la sede de la llamada se reemplaza en 071 por la del turno que
    // la función bloquea.
    expect(sql).toContain("public.next_invoice_number(p_sede_id)");
    // Los grupos de escritura, cada uno en UNA sentencia.
    expect(sql).toMatch(/INSERT INTO public\.invoices/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_items/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_taxes/);
    expect(sql).toMatch(/INSERT INTO public\.invoice_payments/);
    // El stock lo escribe la función de 046: una sola escritura, y la misma.
    // En 071 la llamada pierde su primer argumento y conserva los otros tres.
    expect(sql).toContain("public.deduct_stock_atomic(p_sede_id, p_user_id, v_motivo, p_out_items)");
    // Los grupos llegan como ARREGLO (nunca una fila por request).
    for (const key of ["p_items", "p_taxes", "p_payments", "p_out_items"]) {
      expect(sql, key).toContain(`jsonb_array_elements(${key})`);
    }
    // La precondición del turno, sobre la fila bloqueada.
    expect(sql).toMatch(/FOR UPDATE OF s/);
    expect(sql).toContain("'abierto'");
    expect(sql).toContain("SHIFT_NOT_OPEN");
    // El motivo del OUT: la plantilla se sustituye SÓLO en su primera
    // ocurrencia (overlay), no con `replace` (que sustituye todas).
    expect(sql).toContain("'{consecutivo}'");
    expect(sql).toContain("overlay(");
    expect(sql).toContain("strpos(");
    expect(sql).not.toMatch(/replace\s*\(/i);
  });

  it("tiene una red de conteo por grupo de escritura, con rollback", () => {
    // Cuatro grupos que insertan filas en ESTA función (la factura, las líneas,
    // los impuestos y las porciones); el grupo de stock tiene la suya adentro de
    // 046 y acá se contrasta su respuesta.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(4);
    for (const code of [
      "INVOICE_MISMATCH",
      "ITEM_MISMATCH",
      "TAX_MISMATCH",
      "PAYMENT_MISMATCH",
      "MOVEMENT_MISMATCH",
      "INVOICE_INVALID",
      "OUT_REASON_INVALID",
    ]) {
      expect(sql, code).toContain(code);
    }
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL (la
    // misma trampa que 046–051 documentan).
    expect(sql).toMatch(/coalesce\(/);
    // Y el cast a integer sólo se evalúa cuando el texto ya validó su forma.
    expect(sql).toMatch(/WHEN coalesce\(item ->> 'qty', ''\) ~ '\^\[0-9\]\{1,9\}\$'/);
  });

  it("conserva las precondiciones y los datos que el servicio ya tenía", () => {
    // La MARCA del intento (041): obligatoria, con la forma del CHECK, y escrita
    // en la fila. Su barrera (el índice único parcial) se evalúa adentro.
    expect(sql).toContain("p_idempotency_key");
    expect(sql).toMatch(/idempotency_key,[\s\S]*?p_idempotency_key/);
    // La factura nace cerrada con su estado y su instante, y las porciones
    // llevan el turno (el MISMO escalar en todas las filas).
    expect(sql).toContain("(p_invoice ->> 'closed_at')::timestamptz");
    expect(sql).toMatch(/p_cash_shift_id\n\s+FROM jsonb_array_elements\(p_payments\)/);
    // El orden de las porciones se conserva (sin ORDER BY: el de la 042).
    expect(sql).toMatch(/FROM jsonb_array_elements\(p_payments\) AS item;/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    // Las tablas ya validan sus montos con los CHECK de 005/019/020/030 (validar
    // no es calcular): esta migración no agrega una sola expresión aritmética
    // sobre las columnas de dinero. Escribir = convertir la representación
    // (jsonb → la columna), no operar. Los textos de los `COMMENT ON …` se
    // excluyen: son PROSA que viaja como string, no sentencias.
    const withoutComments = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");
    for (const column of [
      "amount",
      "fee_amount",
      "fee_percent",
      "qty",
      "subtotal",
      "discount",
      "tax",
      "surcharge",
      "total",
    ]) {
      expect(withoutComments, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(withoutComments).not.toContain("CHECK");
    expect(withoutComments).not.toMatch(/sum\s*\(/i);
    expect(withoutComments).not.toMatch(/round\s*\(/i);
    // El stock lo sigue aplicando EXCLUSIVAMENTE el trigger de 004: acá no se
    // escribe una sola columna de stock ni se redefinen sus funciones.
    expect(withoutComments).not.toContain("stock_qty");
    expect(withoutComments).not.toContain("inventory_apply_stock");
    expect(withoutComments).not.toContain("inventory_no_negative_stock");
    expect(sql).not.toContain("DROP TRIGGER");
    // Ni se redefinen las dos autoridades que la función LLAMA.
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
  });

  it("devuelve EXACTAMENTE lo que el servicio leía (mismo shape)", () => {
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(1);
    const match = /const INVOICE_SELECT =\s*\n?\s*"([^"]+)"/.exec(
      readFileSync(join(process.cwd(), "src", "features", "billing", "service.ts"), "utf8"),
    );
    expect(match, "INVOICE_SELECT").not.toBeNull();
    for (const column of (match as RegExpExecArray)[1].split(",").map((c) => c.trim())) {
      expect(sql, column).toContain(`'${column}'`);
    }
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    const signature =
      "public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb)";
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public");
  });

  it("no borra ni reescribe datos: sólo la función y sus permisos", () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(1);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(1);
    // Ningún borrado ni reescritura de filas, y ningún cambio de esquema.
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bUPDATE public\./);
    expect(ddl).not.toMatch(/^\s*ALTER TABLE/im);
    expect(ddl).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP CONSTRAINT");
    // `updated_at` lo sigue escribiendo el trigger de 005.
    expect(sql).not.toMatch(/updated_at/);
  });

  it("declara el acoplamiento, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    expect(raw).toContain("052");
    expect(raw).toContain("051");
    expect(raw).toContain("032 no existe");
    // La decisión central, escrita: la reserva se mueve adentro y NO se quema
    // ningún consecutivo en ningún rechazo.
    expect(raw).toContain("LA NUMERACIÓN");
    expect(raw).toContain("NO se quema ningún consecutivo");
    expect(raw).toContain("se REVIERTE");
    expect(raw).toContain("COSTO DECLARADO DE LA RESERVA ADENTRO");
  });

  it("declara lo que se midió: la ventana, la compensación y el residuo", () => {
    // El archivo tiene que decir de dónde salen las líneas que se midieron y qué
    // era exactamente lo que quedaba a medias.
    expect(raw).toContain("cleanupFailedInvoice");
    expect(raw).toContain("createInvoice");
    expect(raw).toContain("Compensación fallo emisión factura #N");
    expect(raw).toContain("Best-effort: el error original manda");
    // Y por qué NO se eligió la compensación robusta y audible.
    expect(raw).toContain("auditable");
    expect(raw).toContain("writeAudit");
    expect(raw).toContain("046");
    expect(raw).toContain("041");
  });
});

// ---------------- UX-EMPLEADO: el producto repetido se juzga por empleado ----------------

/**
 * Al emitir o editar una factura, el MISMO producto con el MISMO empleado no se
 * duplica: se avisa en `itemError` y se guía a la fila existente para subir la
 * cantidad. Con OTRO empleado la línea nueva es legítima (precio, comisión y
 * descuento por línea), así que se agrega sin aviso. La regla vive en
 * `invoices-client.tsx`; acá se prueban sus dos mitades: la decisión pura y las
 * costuras del marcado/alta que la consumen.
 */
describe("invoices-client: el producto repetido con el MISMO empleado se frena y guía a la fila", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "invoices", "invoices-client.tsx"),
    "utf8",
  );

  const PRODUCT = "producto-1";
  const EMPLOYEE_A = "empleado-a";
  const EMPLOYEE_B = "empleado-b";
  const draftLine = (overrides: Partial<{ item_type: string; ref_id: string; employee_id: string }>) => ({
    item_type: "producto",
    ref_id: PRODUCT,
    employee_id: EMPLOYEE_A,
    ...overrides,
  });

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(130_000);
    expect(source).toContain("export function InvoicesClient(props: InvoicesClientProps)");
  });

  it("mismo producto y mismo empleado: devuelve la fila (1-based)", () => {
    const lines = [draftLine({ ref_id: "otro-producto" }), draftLine({})];
    expect(sameEmployeeProductLine(lines, PRODUCT, EMPLOYEE_A)).toBe(2);
  });

  it("mismo producto con OTRO empleado: no hay coincidencia y la línea se permite", () => {
    const lines = [draftLine({ employee_id: EMPLOYEE_B })];
    expect(sameEmployeeProductLine(lines, PRODUCT, EMPLOYEE_A)).toBeNull();
  });

  it("CONTROL NEGATIVO: sin empleado en el borrador no se marca ninguna fila", () => {
    // La regla es por empleado; sin empleado no se puede afirmar la coincidencia.
    expect(sameEmployeeProductLine([draftLine({})], PRODUCT, "")).toBeNull();
    // Y tampoco hay coincidencia sin producto, ni con un servicio homónimo.
    expect(sameEmployeeProductLine([draftLine({})], "", EMPLOYEE_A)).toBeNull();
    expect(sameEmployeeProductLine([draftLine({ item_type: "servicio" })], PRODUCT, EMPLOYEE_A)).toBeNull();
  });

  it("al editar, la propia fila no se cuenta (excludeIndex)", () => {
    expect(sameEmployeeProductLine([draftLine({})], PRODUCT, EMPLOYEE_A, 0)).toBeNull();
    expect(sameEmployeeProductLine([draftLine({}), draftLine({})], PRODUCT, EMPLOYEE_A, 0)).toBe(2);
  });

  it("el alta frena el duplicado y escribe el aviso en itemError antes de agregar", () => {
    const handler = source.slice(
      source.indexOf("function addItemFromDialog()"),
      source.indexOf("// Inventory-style cancel: closing the dialog always resets its draft."),
    );
    // La coincidencia se busca con el producto y el empleado del borrador.
    expect(handler).toContain("sameEmployeeProductLine(list, itemDraft.ref_id, itemDraft.employee_id)");
    // Se exige empleado ANTES de juzgar el duplicado y el bloqueo va ANTES de
    // empujar la línea: no se agrega nada cuando hay coincidencia.
    expect(handler.indexOf("Elija el empleado que atiende.")).toBeLessThan(
      handler.indexOf("sameEmployeeProductLine(list"),
    );
    expect(handler.indexOf("sameEmployeeProductLine(list")).toBeLessThan(
      handler.indexOf("setItems((prev) => [...prev, draft])"),
    );
    // Sólo se frena cuando HAY coincidencia: con otro empleado `line` es null y
    // el alta cae al `setItems`/`setEditItems` de siempre.
    expect(handler).toContain("if (line != null) {");
    expect(handler).toContain("setItems((prev) => [...prev, draft]);");
    expect(handler).toContain("setEditItems((prev) => [...prev, { ...draft, discount: 0 }]);");
    // El aviso nombra la fila y pide subir la cantidad allí; la fila se resalta.
    expect(handler).toMatch(/ya está en \$\{where\}, fila \$\{line\}, con este empleado/);
    expect(handler).toContain("Aumente la cantidad en esa fila en vez de agregar otra línea.");
    expect(handler).toContain("setSteeredRow({ target: itemDialogTarget, index: line - 1 })");
  });

  it("la opción del producto se marca SÓLO con el mismo empleado y el deshabilitado no se usa", () => {
    // Diálogo compartido de alta (crear y agregar a la edición).
    expect(source).toMatch(/sameEmployeeProductLine\(\s*itemDialogTarget === "edit" \? editItems : items,/);
    // Fila en edición: ignora su propia línea con el índice.
    expect(source).toContain("sameEmployeeProductLine(editItems, row.id, item.employee_id, index)");
    // La marca reusa `description` (nunca `disabled`, que borraría el caso
    // legítimo del otro empleado).
    expect(source).toMatch(/ya está en \$\{where\}, fila \$\{line\}/);
    expect(source).toContain("ya está en la edición, fila ${line}");
    expect(source).not.toContain("disabled: true");
  });

  it("la cantidad de la fila de la factura es editable y alimenta los totales vivos", () => {
    // La fila de la factura emite la cantidad a través de `patchDraftItem`,
    // filtrada por la máscara de cantidad (ver el bloque siguiente).
    expect(source).toContain("patchDraftItem(index, { qty: stripQuantityInput(event.target.value) })");
    // El subtotal y el total siguen derivándose de `items`.
    expect(source).toContain("const draftSubtotal = items.reduce((acc, item) => {");
    expect(source).toMatch(/const qty = toNumber\(item\.qty\) \?\? 0;/);
  });
});

/**
 * La cantidad de una línea es un entero positivo: una letra tecleada no puede
 * llegar al estado. `inputMode="numeric"` NO lo impide (es una pista del
 * teclado, no una validación), así que los tres campos de cantidad de
 * `invoices-client.tsx` pasan por `stripQuantityInput` antes de escribir el
 * estado. Este bloque es la guarda de fuente: falla si alguien quita el cable.
 */
describe("invoices-client: los campos de cantidad sólo aceptan dígitos", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "invoices", "invoices-client.tsx"),
    "utf8",
  );

  /**
   * Línea de `onChange` del campo cuya llamada al estado empieza con `call`.
   * Devuelve "" si el campo no existe, para que la guarda falle en vez de
   * pasar sola.
   */
  function quantityOnChange(text: string, call: string): string {
    const at = text.indexOf(call);
    if (at === -1) return "";
    const start = text.lastIndexOf("onChange", at);
    if (start === -1) return "";
    const end = text.indexOf("\n", start);
    return text.slice(start, end === -1 ? text.length : end);
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(130_000);
    expect(source).toContain("stripQuantityInput");
  });

  it("la fila de alta filtra la cantidad antes de escribir el estado", () => {
    const line = quantityOnChange(source, "patchDraftItem(index, { qty:");
    expect(line, "campo cantidad de alta").not.toBe("");
    expect(line).toContain("stripQuantityInput(event.target.value)");
    expect(line).not.toContain("qty: event.target.value");
  });

  it("la fila de edición filtra la cantidad antes de escribir el estado", () => {
    const line = quantityOnChange(source, "patchEditItem(index, { qty:");
    expect(line, "campo cantidad de edición").not.toBe("");
    expect(line).toContain("stripQuantityInput(event.target.value)");
    expect(line).not.toContain("qty: event.target.value");
  });

  it("el diálogo de ítem filtra la cantidad antes de escribir el estado", () => {
    const line = quantityOnChange(source, "patchDraft({ qty:");
    expect(line, "campo cantidad del diálogo").not.toBe("");
    expect(line).toContain("stripQuantityInput(event.target.value)");
    expect(line).not.toContain("qty: event.target.value");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake =
      '<input onChange={(event) => patchDraftItem(index, { qty: event.target.value })} />';
    const line = quantityOnChange(fake, "patchDraftItem(index, { qty:");
    expect(line).not.toBe("");
    // Sin el cable al helper, la misma guarda falla.
    expect(line).not.toContain("stripQuantityInput");
    // Sin el ancla no hay línea: la guarda falla en vez de pasar sola.
    expect(quantityOnChange(fake, "patchEditItem(index, { qty:")).toBe("");
  });
});

/* ==========================================================================
   Facturas: cada campo numérico pasa por SU máscara (guarda de fuente)

   `inputMode="numeric"`/`"decimal"` son pistas del teclado, no validaciones:
   una letra tecleada llegaba al estado. Cada campo numérico de
   `invoices-client.tsx` pasa ahora por la máscara que le corresponde —dinero,
   cantidad entera o porcentaje— antes de escribir el estado. Esta guarda falla
   si alguien quita el cable a la máscara o vuelve a leer el valor crudo.
   ========================================================================== */
describe("invoices-client: cada campo numérico pasa por su máscara (guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "invoices", "invoices-client.tsx"),
    "utf8",
  );

  /**
   * Bloque `onChange={...}` cuyo cuerpo contiene `anchor`; `occurrence` elige
   * la aparición cuando el ancla se repite. Devuelve "" si el ancla no existe,
   * para que la guarda falle en vez de pasar sola.
   */
  function onChangeBlock(text: string, anchor: string, occurrence = 0): string {
    let at = -1;
    let from = 0;
    for (let i = 0; i <= occurrence; i += 1) {
      at = text.indexOf(anchor, from);
      if (at === -1) return "";
      from = at + anchor.length;
    }
    const start = text.lastIndexOf("onChange={", at);
    if (start === -1) return "";
    let depth = 0;
    for (let i = start + "onChange=".length; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return text.slice(start);
  }

  /** El campo lleva la máscara y NO además el valor crudo. */
  function assertMasked(block: string, mask: string): void {
    expect(block).not.toBe("");
    expect(block).toContain(`strip${mask}Input(event.target.value)`);
    expect(block).not.toContain("Number(event.target.value)");
    expect(block).not.toContain(": event.target.value");
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(130_000);
    expect(source).toContain("stripPercentageInput");
  });

  it("el filtro Nº Factura usa la máscara de cantidad (entero)", () => {
    assertMasked(onChangeBlock(source, "setFilters({ ...filters, number:"), "Quantity");
  });

  it("el % override del ítem en edición usa la máscara de porcentaje", () => {
    const block = onChangeBlock(source, 'placeholder="% ítem"');
    assertMasked(block, "Percentage");
    expect(block).toContain("patchEditItem(index, {");
  });

  it("el % override del diálogo usa la máscara de porcentaje", () => {
    const block = onChangeBlock(source, 'placeholder="Ej. 15"');
    assertMasked(block, "Percentage");
    expect(block).toContain("patchDraft({");
  });

  it("los dos valores de comisión del diálogo usan la máscara de dinero", () => {
    // Los dos campos comparten placeholder (producto y personalizado): se
    // cubren por aparición para que perder la máscara en cualquiera falle.
    for (const occurrence of [0, 1]) {
      const block = onChangeBlock(source, 'placeholder="Ej. 10000"', occurrence);
      assertMasked(block, "Money");
    }
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake = `onChange={(event) => patchDraft({ commission_value: event.target.value === "" ? null : Number(event.target.value) })}`;
    const block = onChangeBlock(fake, "commission_value:");
    expect(block).not.toBe("");
    // Sin el cable a la máscara, la misma guarda falla.
    expect(block).not.toContain("stripMoneyInput(event.target.value)");
    expect(block).toContain("Number(event.target.value)");
    // Sin el ancla no hay bloque: la guarda falla en vez de pasar sola.
    expect(onChangeBlock(fake, "no-existe:")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 071_rpc_single_sede.sql: la facturación re-emite sus CINCO funciones sin el
// parámetro de sede.
//
// LO QUE ESTA SUITE FIJA (y antes fijaba contra la firma vieja): 050, 051, 052,
// 060 y 056 declaraban `p_sede_id` al principio de la firma y filtraban por
// `sede_id` en la factura, en el turno y en el producto. Con una sola sede,
// ese parámetro es una frontera más dentro de una base que ya tiene una, y la
// firma que declara la base tiene que ser EXACTAMENTE la que manda el servidor:
// un `p_sede_id` de sobra hace fallar al llamador nuevo, y una sobrecarga vieja
// viva deja pasar al viejo sin que nadie lo note. Por eso el archivo dropea la
// firma vieja antes de crear la nueva.
// ---------------------------------------------------------------------------

describe("migración 071_rpc_single_sede.sql (facturación)", () => {
  const path = join(process.cwd(), "supabase", "migrations", "071_rpc_single_sede.sql");
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("las CINCO funciones se crean SIN el parámetro de sede", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_create_atomic\(\s*p_user_id uuid,\s*p_cash_shift_id uuid,\s*p_idempotency_key text,\s*p_invoice jsonb,\s*p_items jsonb,\s*p_taxes jsonb,\s*p_payments jsonb,\s*p_out_reason text,\s*p_out_items jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_annul_atomic\(\s*p_invoice_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,\s*p_motivo text,\s*p_expected_status text,\s*p_items jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_edit_items_atomic\(\s*p_invoice_id uuid,\s*p_user_id uuid,\s*p_expected_version integer,\s*p_expected_status text,\s*p_edit jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_edit_emitted_atomic\(\s*p_invoice_id uuid,\s*p_user_id uuid,\s*p_expected_version integer,\s*p_expected_status text,\s*p_edit jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_split_payment_atomic\(\s*p_invoice_id uuid,\s*p_shift_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,\s*p_mark_paid boolean,\s*p_portions jsonb\s*\)/,
    );
    // Y el predicado de sede NO está en ninguna: si volviera, la firma y el
    // cuerpo dejarían de contar la misma historia.
    expect(sql).not.toMatch(/\bsede_id\s*=\s*p_sede_id/);
    expect(sql).not.toContain("p_sede_id IS NULL");
    expect(sql).not.toContain("p_sede_id");
  });

  it("dropea la firma VIEJA de las CINCO antes de crear la nueva", () => {
    const drops = [
      "DROP FUNCTION IF EXISTS public.invoice_create_atomic(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb)",
      "DROP FUNCTION IF EXISTS public.invoice_annul_atomic(uuid, uuid, uuid, timestamptz, text, text, jsonb)",
      "DROP FUNCTION IF EXISTS public.invoice_edit_items_atomic(uuid, uuid, uuid, integer, text, jsonb)",
      "DROP FUNCTION IF EXISTS public.invoice_edit_emitted_atomic(uuid, uuid, uuid, integer, text, jsonb)",
      "DROP FUNCTION IF EXISTS public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    ];
    for (const statement of drops) {
      expect(sql).toContain(statement);
      const name = statement.slice(statement.indexOf("public.") + 7, statement.indexOf("("));
      expect(sql.indexOf(statement)).toBeLessThan(
        sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`),
      );
    }
  });

  it("la SEDE que se ESCRIBE sale de la fila bloqueada, no de un parámetro", () => {
    // La emisión y la anulación no escriben la sede que reciben (ya no la
    // reciben): toman la del TURNO o la del PRODUCTO que la operación ya tiene
    // bloqueados. Es lo que deja la columna lista para el `DROP COLUMN`.
    expect(sql).toMatch(
      /SELECT s\.status, s\.sede_id\s*\n\s*INTO v_turno_estado, v_sede\s*\n\s*FROM public\.cash_shifts s/,
    );
    expect(sql).toContain("public.next_invoice_number(v_sede)");
    expect(sql).toContain("public.deduct_stock_atomic(v_sede, p_user_id, v_motivo, p_out_items)");
    // El movimiento de stock, en las cuatro funciones que lo escriben, toma la
    // del producto (`p.sede_id`), igual que en 046/050/051.
    expect(sql.match(/SELECT\s*\n\s*p\.sede_id,/g)).toHaveLength(4);
    // Y la fila espejo/cajón del cobro toma la del turno bloqueado.
    expect(sql).toContain("(v_turno.sede_id,");
  });

  it("el permiso y el search_path viajan con la firma NUEVA, y el comentario también", () => {
    for (const signature of [
      "invoice_create_atomic(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, text, jsonb)",
      "invoice_annul_atomic(uuid, uuid, timestamptz, text, text, jsonb)",
      "invoice_edit_items_atomic(uuid, uuid, integer, text, jsonb)",
      "invoice_edit_emitted_atomic(uuid, uuid, integer, text, jsonb)",
      "invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    ]) {
      expect(sql).toContain(`ALTER FUNCTION public.${signature} SET search_path = public;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon;`);
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${signature} FROM authenticated;`,
      );
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
      expect(sql).toContain(`COMMENT ON FUNCTION public.${signature} IS`);
    }
  });

  it("conserva las redes de conteo y los candados: el cambio es de firma, no de comportamiento", () => {
    for (const code of [
      "INVOICE_INVALID",
      "OUT_REASON_INVALID",
      "SHIFT_NOT_OPEN",
      "INVOICE_MISMATCH",
      "ITEM_MISMATCH",
      "TAX_MISMATCH",
      "PAYMENT_MISMATCH",
      "MOVEMENT_MISMATCH",
      "ANNUL_CONFLICT",
      "ANNUL_INVALID",
      "PRODUCT_NOT_FOUND",
      "EDIT_CONFLICT",
      "SHIFT_CLOSED",
      "SHIFT_NOT_FOUND",
    ]) {
      expect(sql).toContain(`RAISE EXCEPTION '${code}'`);
    }
    // El candado de la edición (038) y el de la 056 sobre el turno siguen.
    expect(sql).toContain("AND i.edit_version = p_expected_version");
    expect(sql).toContain("FOR SHARE OF s");
    expect(sql).toContain("FOR UPDATE OF i");
    // Y el consecutive la red 041 y el motivo del OUT. El marcador de 060
    // viaja porque `diagnostics/migraciones_faltantes.sql` distingue la
    // versión corregida de 052 POR TEXTO.
    expect(raw).toContain("-- fix-060: esperados ANTES del INSERT");
    expect(sql).toContain("idempotency_key");
  });

  it("NO borra la columna ni toca las políticas: ése es el paso irreversible de otra unidad", () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/\bPOLICY\b/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(raw).toContain("POR QUÉ ESTE ARCHIVO CORRE ANTES DEL BORRADO DE LA COLUMNA");
  });

  it("NO re-emite next_invoice_number: su parámetro es la FILA del contador, no la sede del actor", () => {
    // `invoice_sequences` tiene `sede_id` como clave primaria: el parámetro
    // selecciona la fila que la función bloquea e incrementa. Elegirla sola
    // dentro de SQL sería inventar una regla de sede que nadie decidió, así que
    // la función queda como está y quien la llama le pasa la del turno que ya
    // tiene bloqueada.
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.next_invoice_number");
    expect(raw).toContain(
      "`public.next_invoice_number(p_sede_id uuid)` (005), que se deja tal cual",
    );
  });
});

// ---------------------------------------------------------------------------
// 072_system_settings.sql: el consecutivo pasa a ser un AJUSTE de la
// INSTALACIÓN (`public.system_settings`, una fila por `clave`).
//
// La serie de una sola sede (071) dejó `next_invoice_number` como estaba, por una
// razón que entonces era cierta: `invoice_sequences` tenía `sede_id` como clave
// primaria, el parámetro SELECCIONABA la fila del contador y no había forma de
// elegirla dentro de SQL. La 072 resuelve justamente eso —la fila pasa a ser la
// clave 'invoice_sequence' de una tabla que no tiene sede—, y por eso es la que
// re-emite la función. Que lo haga un archivo y no el otro no es una
// contradicción: es el ORDEN de la serie. El parámetro se conserva (aunque el
// cuerpo ya no lo use) para que la firma que declara la base siga siendo la que
// `invoice_create_atomic` manda, y su retiro queda para la unidad que borra
// `sede_id`.
//
// Lo que esta suite fija: la FIRMA no cambia, el LOCK de fila se conserva (es lo
// único que impide el consecutivo duplicado) y la serie no puede REBAJAR con una
// segunda corrida de la migración.
// ---------------------------------------------------------------------------

describe("migración 072_system_settings.sql (consecutivo de factura)", () => {
  const path = join(process.cwd(), "supabase", "migrations", "072_system_settings.sql");
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  /** El cuerpo desplegado de la función, sin prosa. */
  const functionBody = (): string => {
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.next_invoice_number");
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start);
    const end = body.indexOf("$$;");
    return end === -1 ? body : body.slice(0, end);
  };

  it("crea la tabla de ajustes con la forma declarada: clave, valor y updated_at", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.system_settings");
    expect(sql).toContain("key text PRIMARY KEY");
    expect(sql).toContain("value jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(sql).toContain("updated_at timestamptz NOT NULL DEFAULT now()");
    expect(sql).toContain("EXECUTE FUNCTION public.set_updated_at()");
    // Sin sede: es un ajuste de la instalación, no de una sede.
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.system_settings \([^)]*sede_id/is);
  });

  it("re-emite next_invoice_number con la MISMA firma de 005", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)");
    expect(sql).toContain("RETURNS integer");
    expect(sql).toContain("ALTER FUNCTION public.next_invoice_number(uuid) SET search_path = public");
    // El parámetro sigue declarado pero el cuerpo ya no lo usa: la fila del
    // contador es la clave, no la sede. Retirarlo de la firma es de la unidad que
    // borra `sede_id`.
    // `sede_id` aparece UNA vez en toda la definición: en la firma.
    const cuerpo = functionBody();
    expect(cuerpo.match(/sede_id/g) ?? []).toHaveLength(1);
    expect(cuerpo.slice(cuerpo.indexOf("DECLARE"))).not.toMatch(/sede_id/);
    expect(raw).toContain("POR QUÉ `next_invoice_number` CONSERVA SU PARÁMETRO");
  });

  it("el lock de fila se conserva: bloquea la clave del contador y la incrementa adentro", () => {
    const body = functionBody();
    // El `SELECT … FOR UPDATE` sobre la fila de la clave: es el idioma que
    // serializa a los emisores concurrentes (FAC-05) y hace que el segundo espere
    // y vea el número que el primero dejó.
    expect(body).toMatch(
      /SELECT[\s\S]*FROM public\.system_settings s[\s\S]*WHERE s\.key = 'invoice_sequence'[\s\S]*FOR UPDATE;/,
    );
    // Y el incremento sigue DENTRO de la misma función, o sea dentro de la
    // transacción del llamador: un aborto no quema el número.
    expect(body.indexOf("FOR UPDATE")).toBeLessThan(body.indexOf("UPDATE public.system_settings"));
    expect(body).toContain("jsonb_set(value, '{last_number}', to_jsonb(v_last + 1), true)");
    expect(body).toContain("RETURN v_last + 1");
    // La fila vieja no vuelve a aparecer en el cuerpo.
    expect(body).not.toContain("invoice_sequences");
  });

  it("la fila tiene que existir antes de bloquearla, sin pisar el contador vigente", () => {
    const body = functionBody();
    expect(body).toContain("INSERT INTO public.system_settings (key, value)");
    expect(body).toContain("ON CONFLICT (key) DO NOTHING");
    // El `IF NOT FOUND` conserva el nombre del error de 005, que es lo que
    // traduce el servicio.
    expect(body).toContain("IF NOT FOUND THEN");
    expect(body).toContain("RAISE EXCEPTION 'SEDE_NOT_FOUND'");
  });

  it("el contador se mueve adelante y NO puede rebajar en una segunda corrida", () => {
    // El MÁXIMO de `invoice_sequences` (nunca el mínimo: el mínimo devuelve la
    // serie hacia atrás y repite un número ya emitido) con `DO NOTHING` (nunca
    // `DO UPDATE`: una segunda corrida no puede rebajar el contador que ya
    // avanzó con las emisiones de la primera).
    expect(sql).toMatch(/jsonb_build_object\('last_number', coalesce\(max\(s\.last_number\), 0\)\)/);
    expect(sql).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(sql).not.toMatch(/UPDATE\s+public\.invoice_sequences/i);
  });

  it("invoice_create_atomic la sigue llamando con la misma firma", () => {
    // 071 no le quitó el parámetro al llamador, y la 072 tampoco se lo quitó a la
    // función: la llamada y la declaración siguen coincidiendo, que es lo que
    // hace que un despliegue no falle por una sobrecarga vieja.
    const previous = readFileSync(
      join(process.cwd(), "supabase", "migrations", "071_rpc_single_sede.sql"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(previous).toContain("public.next_invoice_number(v_sede)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)");
  });

  it("NO borra invoice_sequences ni la columna: el borrado es de la unidad que quita sede_id", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.invoice_sequences/i);
    expect(raw).toContain("NO borra `invoice_sequences` ni `voucher_settings`");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});
