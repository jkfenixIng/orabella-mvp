import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveVoucherSchema,
  assertCorrectablePeriod,
  assertDeletablePeriod,
  assertDraftPeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeCommissionDetail,
  buildEmployeeDetail,
  buildPayrollCorrectionView,
  buildPayrollEmployeeIndex,
  buildPayrollMonthToDate,
  calculatePayrollSchema,
  calendarCycleDaysForFrequency,
  canDiscountVoucher,
  canReviewVoucher,
  capPayrollDiscounts,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeLineCommission,
  computeNetPay,
  correctPayrollPeriodSchema,
  cycleDaysForFrequency,
  cycleProrationFactor,
  daysInMonthWithinRange,
  detailLineCommissionOrigin,
  fixedFractionForFrequency,
  groupPayrollPeriodsByMonth,
  isPayrollCycleRange,
  isPayrollCycleSettled,
  isRangeBeforePayrollStart,
  isVoucherDayAllowed,
  lastCompletedCycleEndDate,
  lastCompletedPayrollCycles,
  MIXED_ABSORBED_ITEM_TYPE,
  mixedAbsorbedDetailLine,
  nextPeriodStartDate,
  normalizeAllowedDays,
  normalizePerDayLimits,
  openPeriodSchema,
  overlapBlocksDeletion,
  PAY_CYCLE_CALENDAR_DAYS,
  PAY_CYCLE_DAYS,
  payPayrollItemSchema,
  PENDING_SETTLEMENT_LIMIT,
  PENDING_SETTLEMENT_NAME_LIMIT,
  pendingPayrollSettlements,
  payrollCycleRange,
  payrollEmployeeName,
  payrollExtraGuide,
  payrollExtraKindSchema,
  payrollExtraSchema,
  payrollMonthLabel,
  payrollPeriodCountLabel,
  payFrequencySchema,
  periodCadenceBucket,
  periodExcludesEmployeeByCadence,
  periodRangeDays,
  prorateFixedSalary,
  rangesOverlap,
  readVoucherCapSetting,
  readVoucherDaysSetting,
  readVoucherPerDaySetting,
  resolveFixedSalaryForPeriod,
  resolveMixedBlock,
  resolveOpenPayrollRange,
  splitCommissionByOrigin,
  rejectVoucherSchema,
  replacePayrollMonthPeriod,
  requestVoucherSchema,
  requiresVoucherApproval,
  resolveVoucherDayCap,
  resolveVoucherInitialStatus,
  restoreVoucherStatus,
  sumMoney,
  summarizePayrollItems,
  voucherApprovalCashOutViolation,
  voucherCapSettingValue,
  voucherDaysSettingValue,
  voucherLimitsSchema,
  voucherPerDaySettingValue,
  voucherRequiresReview,
  weekdayIso,
  weekStartOf,
  type PayrollCommissionLine,
  type PendingPayrollSettlement,
} from "@/src/features/payroll/schemas";
import {
  commissionRuleKey,
  employeeLineCommissionPercent,
  resolveEmployeeLineCommission,
} from "@/src/features/commissions/schemas";
import {
  approveVoucher,
  calculatePayroll,
  getPayrollPeriodCorrection,
  getPayrollSettlementSources,
  getPayrollStartDate,
  getPeriodDetail,
  getVoucherSettings,
  groupSettlementInvoices,
  listPayrollMonthRows,
  listPayrollOverview,
  listPeriods,
  openPayrollPeriod,
  PayrollError,
  rejectVoucher,
  setVoucherLimits,
  type PayrollActor,
} from "@/src/features/payroll/service";
import { listAllEmployees, listEmployees } from "@/src/features/admin/service";
import * as payrollExtrasService from "@/src/features/payroll/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import {
  getPayrollSettlementSourcesAction,
  getPayrollStartDateAction,
  getPeriodDetailAction,
  listVouchersAction,
} from "@/src/features/payroll/actions";
import * as payrollActions from "@/src/features/payroll/actions";
import type { AdminSession } from "@/src/features/admin/service";
import {
  chunkIds,
  IN_FILTER_CHUNK_SIZE,
  PagedReadError,
  readAllPaged,
} from "@/src/shared/lib/paged";

// ------------------------------------------------- neto (PAY-02) ---

describe("payroll: neto = fijo + comisiones + bonos − vales − otros (PAY-02)", () => {
  it("empleado mixto: 800000 + 150000 + 50000 − 100000 − 20000 = 880000", () => {
    expect(
      computeNetPay({
        baseFixed: 800000,
        commissions: 150000,
        bonuses: 50000,
        vales: 100000,
        otherDiscounts: 20000,
      }),
    ).toBe(880000);
  });

  it("empleado solo fijo ignora facturación (sin comisiones ni vales)", () => {
    expect(computeNetPay({ baseFixed: 1200000, commissions: 0 })).toBe(1200000);
  });

  it("empleado porcentual sin base fija: solo comisiones menos vales", () => {
    expect(computeNetPay({ baseFixed: 0, commissions: 320000, vales: 50000 })).toBe(270000);
  });

  it("el neto nunca queda negativo (descuentos mayores que el bruto → 0)", () => {
    expect(computeNetPay({ baseFixed: 100000, commissions: 0, vales: 300000 })).toBe(0);
  });

  it("recalcular con los mismos insumos reproduce el mismo neto", () => {
    const args = { baseFixed: 800000, commissions: 150000, bonuses: 50000, vales: 100000, otherDiscounts: 20000 };
    expect(computeNetPay(args)).toBe(computeNetPay({ ...args }));
  });
});

// --------------------- descuento que supera el bruto (contradicción CHECK) ---

describe("payroll: descuento mayor que el bruto es persistible (PAY-02)", () => {
  /**
   * Réplica del payload que arma calculatePayroll: gross = base + comisiones +
   * bonos, descuentos topados al bruto y neto con la regla vigente.
   */
  function persist(args: {
    baseFixed: number;
    commissions: number;
    bonuses?: number;
    vales?: number;
    otherDiscounts?: number;
  }) {
    const gross = (args.baseFixed ?? 0) + (args.commissions ?? 0) + (args.bonuses ?? 0);
    const applied = capPayrollDiscounts({
      gross,
      vales: args.vales ?? 0,
      otherDiscounts: args.otherDiscounts ?? 0,
    });
    const netPay = computeNetPay({
      baseFixed: args.baseFixed,
      commissions: args.commissions,
      bonuses: args.bonuses,
      vales: applied.vales,
      otherDiscounts: applied.otherDiscounts,
    });
    return { gross, ...applied, netPay };
  }

  it("empleado porcentaje sin ventas con un vale que supera el bruto no revienta", () => {
    // Caso alcanzable: base 0 + comisiones 0 (sin facturación) + vale 300000.
    const row = persist({ baseFixed: 0, commissions: 0, vales: 300000 });
    expect(row.netPay).toBe(0);
    expect(row.vales).toBe(0);
    expect(row.otherDiscounts).toBe(0);
  });

  it("el descuento persistido nunca excede el bruto (neto = bruto − descuentos)", () => {
    const cases = [
      { baseFixed: 0, commissions: 0, vales: 300000 },
      { baseFixed: 100000, commissions: 0, vales: 300000 },
      { baseFixed: 100000, commissions: 0, vales: 80000, otherDiscounts: 50000 },
      { baseFixed: 800000, commissions: 150000, bonuses: 50000, vales: 100000, otherDiscounts: 20000 },
    ];
    for (const args of cases) {
      const row = persist(args);
      // Invariante del CHECK de payroll_items con tolerancia de centavo.
      expect(Math.abs(row.netPay - (row.gross - row.vales - row.otherDiscounts))).toBeLessThan(0.01);
      expect(row.netPay).toBeGreaterThanOrEqual(0);
      expect(row.vales).toBeGreaterThanOrEqual(0);
      expect(row.otherDiscounts).toBeGreaterThanOrEqual(0);
    }
  });

  it("el recorte prioriza recuperar el vale: baja first other_discounts y luego vales", () => {
    // Bruto 100000; vales 80000 + otros 50000 = 130000. Se recorta otros a 20000.
    const withBoth = persist({ baseFixed: 100000, commissions: 0, vales: 80000, otherDiscounts: 50000 });
    expect(withBoth.vales).toBe(80000);
    expect(withBoth.otherDiscounts).toBe(20000);
    expect(withBoth.netPay).toBe(0);
    // Vale solo por encima del bruto: queda parcialmente descontado (remanente).
    const valeOnly = persist({ baseFixed: 100000, commissions: 0, vales: 300000 });
    expect(valeOnly.vales).toBe(100000);
    expect(valeOnly.netPay).toBe(0);
  });

  it("sin exceso no toca los montos (comportamiento preservado)", () => {
    const row = persist({ baseFixed: 800000, commissions: 150000, bonuses: 50000, vales: 100000, otherDiscounts: 20000 });
    expect(row.vales).toBe(100000);
    expect(row.otherDiscounts).toBe(20000);
    expect(row.netPay).toBe(880000);
  });
});

// ------------------------------------------------- comisiones y detail_json (PAY-03) ---

describe("payroll: cálculo mixto con detail_json reproducible (PAY-02/PAY-03)", () => {
  const lines = [
    {
      employee_id: "emp-1",
      invoice_id: "inv-b",
      consecutive_number: 12,
      item_id: "item-2",
      item_type: "servicio",
      qty: 1,
      unit_price: 200000,
      line_subtotal: 200000,
      commission: computeLineCommission(200000, 10),
      commission_value: null,
    },
    {
      employee_id: "emp-1",
      invoice_id: "inv-a",
      consecutive_number: 11,
      item_id: "item-1",
      item_type: "servicio",
      qty: 2,
      unit_price: 150000,
      line_subtotal: 300000,
      commission: computeLineCommission(300000, 10),
      commission_value: null,
    },
  ];

  it("cada peso de comisión traza a una línea de factura", () => {
    expect(lines[0].commission).toBe(20000);
    expect(lines[1].commission).toBe(30000);
    const { detail, commissions } = buildEmployeeDetail(lines);
    expect(commissions).toBe(50000);
    expect(detail).toHaveLength(2);
    expect(detail.reduce((acc, row) => acc + row.commission, 0)).toBe(commissions);
  });

  it("el detalle se ordena por factura/ítem y es reproducible", () => {
    const first = buildEmployeeDetail(lines);
    const second = buildEmployeeDetail([...lines].reverse());
    expect(second.detail).toEqual(first.detail);
    expect(second.commissions).toBe(first.commissions);
    // Ordenado por consecutivo: factura 11 antes que 12.
    expect(first.detail[0].invoice_id).toBe("inv-a");
  });

  it("el fijo no lleva comisión aunque tenga líneas (solo fijo → 0)", () => {
    expect(computeLineCommission(500000, null)).toBe(0);
  });
});

// --------------------------------- detalle con resolución compartida (PAY-02/03) ---

describe("payroll: detalle de comisiones con la resolución compartida (PAY-02/PAY-03)", () => {
  function line(overrides: Partial<PayrollCommissionLine> = {}): PayrollCommissionLine {
    return {
      invoice_id: "inv-1",
      consecutive_number: 10,
      item_id: "item-1",
      item_type: "producto",
      qty: 1,
      unit_price: 100000,
      line_subtotal: 100000,
      commission_value: null,
      item_ref_id: "prod-1",
      ...overrides,
    };
  }

  it("fijo + regla ítem×empleado: la regla comisiona (NO cero) — bug corregido", () => {
    const rules = new Map([[commissionRuleKey("producto", "prod-1"), { percent: 10, amount: null }]]);
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [line()],
      rules,
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].commission).toBe(10000);
  });

  it("fijo sin regla: sin detalle (comisión 0), comportamiento preservado", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [line()],
      rules: new Map(),
    });
    expect(detail).toHaveLength(0);
    expect(buildEmployeeDetail(detail).commissions).toBe(0);
  });

  it("servicio: subtotal × commission_percent (comportamiento preservado)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [line({ item_type: "servicio", item_ref_id: "svc-1" })],
      rules: new Map(),
    });
    expect(detail[0].commission).toBe(10000);
  });

  it("producto con valor fijo: comisiona el valor del ítem (no el % plano)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 35,
      lines: [line({ unit_price: 42000, line_subtotal: 42000, commission_value: 1000 })],
      rules: new Map(),
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].commission).toBe(1000);
  });

  it("producto sin valor fijo no cae al % plano: sin detalle", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 35,
      lines: [line()],
      rules: new Map(),
    });
    expect(detail).toHaveLength(0);
    expect(buildEmployeeDetail(detail).commissions).toBe(0);
  });

  it("producto con valor fijo vendido por empleado fijo: comisiona (antes 0)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [line({ commission_value: 1000 })],
      rules: new Map(),
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].commission).toBe(1000);
  });

  it("regla con monto fijo por unidad: se multiplica por la cantidad", () => {
    const rules = new Map([[commissionRuleKey("producto", "prod-1"), { percent: null, amount: 5000 }]]);
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [line({ qty: 3, unit_price: 30000, line_subtotal: 90000 })],
      rules,
    });
    expect(detail[0].commission).toBe(15000);
  });

  it("la regla gana sobre el porcentaje plano", () => {
    const rules = new Map([[commissionRuleKey("producto", "prod-1"), { percent: 10, amount: null }]]);
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "mixto",
      commissionPercent: 30,
      lines: [line()],
      rules,
    });
    expect(detail[0].commission).toBe(10000);
  });

  it("custom con valor fijo: se respeta el valor del ítem", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 20,
      lines: [line({ item_type: "custom", item_ref_id: null, commission_value: 12000 })],
      rules: new Map(),
    });
    expect(detail[0].commission).toBe(12000);
  });

  it("varias líneas del mismo empleado se SUMAN (producto 3000 + servicio 10000 = 13000)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [
        line({
          item_id: "item-producto",
          item_type: "producto",
          item_ref_id: "prod-1",
          qty: 3,
          unit_price: 42000,
          line_subtotal: 126000,
          commission_value: 1000,
        }),
        line({
          item_id: "item-servicio",
          item_type: "servicio",
          item_ref_id: "svc-1",
          qty: 1,
          unit_price: 100000,
          line_subtotal: 100000,
          commission_value: null,
        }),
      ],
      rules: new Map(),
    });
    // Producto: 1000 × 3 = 3000. Servicio: 100000 × 10% = 10000.
    const summed = buildEmployeeDetail(detail);
    expect(summed.detail).toHaveLength(2);
    expect(summed.commissions).toBe(13000);
  });

  it("no_aplica: sin detalle ni comisión", () => {
    const rules = new Map([[commissionRuleKey("producto", "prod-1"), { percent: 10, amount: null }]]);
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "no_aplica",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [line()],
      rules,
    });
    expect(detail).toHaveLength(0);
    expect(buildEmployeeDetail(detail).commissions).toBe(0);
  });

  it("paridad: el detalle de nómina usa la misma resolución que el pago inmediato", () => {
    const rules = new Map([[commissionRuleKey("producto", "prod-1"), { percent: 8, amount: 1000 }]]);
    const source = line({ qty: 2, unit_price: 125000, line_subtotal: 250000 });
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [source],
      rules,
    });
    expect(detail[0].commission).toBe(
      resolveEmployeeLineCommission({
        itemType: source.item_type,
        itemRefId: source.item_ref_id,
        subtotal: source.line_subtotal,
        qty: source.qty,
        commissionValue: source.commission_value,
        rules,
        flatPercent: null,
      }),
    );
    // 250000 × 8% = 20000 + 1000 × 2 = 22000.
    expect(detail[0].commission).toBe(22000);
  });

  it("marca el origen y la tasa de una línea por porcentaje (con decimales)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 7.5,
      lines: [
        line({
          item_id: "svc",
          item_type: "servicio",
          item_ref_id: "svc-1",
          qty: 1,
          unit_price: 123456,
          line_subtotal: 123456,
        }),
      ],
      rules: new Map(),
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].commission_origin).toBe("percent");
    expect(detail[0].commission_percent).toBe(7.5);
    // 123456 × 7.5% = 9259.2 → 9259: la tasa y el monto salen de la misma
    // resolución y el dinero del sistema es a peso entero (roundMoney).
    expect(detail[0].commission).toBe(9259);
    expect(
      employeeLineCommissionPercent({
        itemType: "servicio",
        itemRefId: "svc-1",
        commissionValue: null,
        rules: new Map(),
        flatPercent: 7.5,
      }),
    ).toBe(7.5);
  });

  it("una línea fija/producto no lleva tasa y su origen es commission", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [line({ commission_value: 1000 })],
      rules: new Map(),
    });
    expect(detail[0].commission_origin).toBe("commission");
    expect(detail[0].commission_percent).toBeNull();
    expect(
      employeeLineCommissionPercent({
        itemType: "producto",
        itemRefId: "prod-1",
        commissionValue: 1000,
        rules: new Map(),
        flatPercent: 10,
      }),
    ).toBeNull();
  });

  it("reclasificación: fija + porcentaje suman EXACTAMENTE las comisiones del ítem", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 7.5,
      lines: [
        line({
          item_id: "svc",
          item_type: "servicio",
          item_ref_id: "svc-1",
          qty: 1,
          unit_price: 123456,
          line_subtotal: 123456,
        }),
        line({ item_id: "prod", commission_value: 1000 }),
      ],
      rules: new Map(),
    });
    const { commissions } = buildEmployeeDetail(detail);
    const split = splitCommissionByOrigin({ commissions, detail });
    expect(split.percent).toBe(9259);
    expect(split.fixed).toBe(1000);
    expect(split.fixed + split.percent).toBe(commissions);
  });

  it("la parte fija se DERIVA por resta: con pago inmediato descontado, el total no se mueve", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 7.5,
      lines: [
        line({
          item_id: "svc",
          item_type: "servicio",
          item_ref_id: "svc-1",
          qty: 1,
          unit_price: 123456,
          line_subtotal: 123456,
        }),
        line({ item_id: "prod", commission_value: 1000 }),
      ],
      rules: new Map(),
    });
    // La nómina persiste `earned − pagado inmediato`: solo el producto (1000)
    // pudo pagarse de inmediato, así que el total baja a 9259 y la parte fija
    // se absorbe por completo. Las dos columnas siguen sumando el total.
    const netOfImmediate = 9259;
    const split = splitCommissionByOrigin({ commissions: netOfImmediate, detail });
    expect(split.percent).toBe(9259);
    expect(split.fixed).toBe(0);
    expect(split.fixed + split.percent).toBe(netOfImmediate);
  });

  it("la parte porcentual con decimales se redondea a peso y las columnas siguen cuadrando", () => {
    // 123456 × 7.5% = 9259.2: el porcentaje puede producir fracción de peso,
    // pero el dinero es a peso entero (roundMoney). La parte fija derivada por
    // resta garantiza fija + porcentaje === total redondeado, sin deriva.
    const detail = [{ commission: 9259.2, commission_origin: "percent" as const }];
    const split = splitCommissionByOrigin({ commissions: 9259.2, detail });
    expect(split.percent).toBe(9259);
    expect(split.fixed).toBe(0);
    expect(split.fixed + split.percent).toBe(Math.round(9259.2));
  });

  it("el invariante se sostiene aunque el porcentaje supere el total (tope, no negativo)", () => {
    const detail = [{ commission: 10, commission_origin: "percent" as const }];
    const split = splitCommissionByOrigin({ commissions: 6, detail });
    expect(split.percent).toBe(6);
    expect(split.fixed).toBe(0);
    expect(split.fixed + split.percent).toBe(6);
  });

  // ---------------------------------- filas viejas sin `commission_origin` ---
  //
  // El `commission_origin` solo lo escribe el calculador: los ítems guardados
  // ANTES del cambio no lo traen y un período CERRADO no se puede recalcular.
  // El origen se DEDUCE al leer, con lo que la fila ya guarda, para que el
  // porcentaje no siga apareciendo como comisión fija.
  it("una línea vieja por porcentaje se deduce `percent` y NO cae en la parte fija", () => {
    // Fila persistida por la versión anterior: servicio con el % del empleado,
    // sin `commission_origin` y sin `commission_percent`.
    const oldLine = {
      item_type: "servicio",
      commission_value: null,
      line_subtotal: 100000,
      commission: 10000, // 100000 × 10%
      qty: 1,
    };
    expect(detailLineCommissionOrigin(oldLine)).toBe("percent");

    const split = splitCommissionByOrigin({
      commissions: 10000,
      detail: [{ ...oldLine, commission_percent: undefined }],
    });
    expect(split.percent).toBe(10000);
    expect(split.fixed).toBe(0);
    expect(split.fixed + split.percent).toBe(10000);
  });

  it("una línea vieja de producto con valor fijo se deduce `commission`", () => {
    expect(
      detailLineCommissionOrigin({
        item_type: "producto",
        commission_value: 1000,
        line_subtotal: 3000,
        commission: 3000,
        qty: 3,
      }),
    ).toBe("commission");
  });

  it("una línea vieja sin comisión no tiene origen que mostrar", () => {
    expect(
      detailLineCommissionOrigin({
        item_type: "servicio",
        commission_value: null,
        line_subtotal: 100000,
        commission: 0,
        qty: 1,
      }),
    ).toBe("none");
  });

  it("una fila vieja mixta (porcentaje + valor fijo) cuadra el total en ambas columnas", () => {
    const oldDetail = [
      {
        item_type: "servicio",
        commission_value: null,
        line_subtotal: 100000,
        commission: 10000,
        qty: 1,
      },
      {
        item_type: "producto",
        commission_value: 1000,
        line_subtotal: 3000,
        commission: 3000,
        qty: 3,
      },
    ];
    const total = 13000;
    const split = splitCommissionByOrigin({ commissions: total, detail: oldDetail });
    expect(split.percent).toBe(10000);
    expect(split.fixed).toBe(3000);
    expect(split.fixed + split.percent).toBe(total);
  });

  it("el origen persistido manda sobre la deducción (no se pisa lo que el cálculo ya marcó)", () => {
    expect(
      detailLineCommissionOrigin({
        item_type: "producto",
        commission_value: 1000,
        line_subtotal: 3000,
        commission: 3000,
        qty: 3,
        commission_origin: "percent",
      }),
    ).toBe("percent");
  });
});

// ------------------- comisión solo de facturas PAGADAS (regla del dueño) ---
//
// Decisión del dueño (2026-10-01): la comisión se gana cuando la factura queda
// `Pagada`. Una factura `Emitida` —o anulada después— no comisiona: el dinero no
// entró a caja. El filtro de la lectura de nómina es `= Pagada`, no "≠ Anulada".
describe("payroll: la comisión solo sale de facturas Pagada (regla del dueño)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const SUBTOTAL = 10_000;

  function employeeRow() {
    return {
      id: payrollPagedStub.EMPLOYEE_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: "Empleada pagada",
      employee_code: "E-9",
      document: "1000000009",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "porcentaje",
      salary_fixed: null,
      commission_percent: 10,
      is_active: true,
    };
  }

  function seedInvoices(statuses: string[]) {
    const invoices = statuses.map((status, index) => ({
      id: `factura-${index + 1}`,
      consecutive_number: index + 1,
      sede_id: payrollPagedStub.SEDE_ID,
      status,
      created_at: "2026-01-15T12:00:00.000Z",
    }));
    const items = invoices.map((invoice) => ({
      id: `linea-${invoice.id}`,
      invoice_id: invoice.id,
      item_type: "servicio",
      employee_id: payrollPagedStub.EMPLOYEE_ID,
      qty: 1,
      unit_price: SUBTOTAL,
      subtotal: SUBTOTAL,
      no_commission: false,
      commission_value: null,
      commission_percent_override: null,
      product_id: null,
      service_id: payrollPagedStub.SERVICE_ID,
    }));
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: ACTOR.userId,
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      employees: [employeeRow()],
      invoices,
      invoice_items: items,
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("una factura `Emitida` NO comisiona; una `Pagada` sí", async () => {
    seedInvoices(["Pagada", "Emitida", "Anulada"]);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    // Tres líneas idénticas de 10.000 al 10%: solo la pagada suma 1.000.
    expect(persisted[0].commissions).toBe(1_000);
    // Y el detalle lista solo la pagada: las otras no aportan línea.
    expect(persisted[0].detail_json).toHaveLength(1);
  });

  it("control: sin ninguna factura pagada la comisión es 0", async () => {
    seedInvoices(["Emitida", "Anulada"]);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].commissions).toBe(0);
    expect(persisted[0].detail_json).toHaveLength(0);
  });
});

// --------- el vale ya descontado sigue contando al recalcular el borrador ---
//
// Al aplicar, los vales del período pasan a `descontada`. Si el recálculo leyera
// solo `pendiente|aprobada`, el descuento desaparecería del neto aunque los
// vales siguieran descontados: la nómina mostraría más plata de la que el vale
// ya consumió. El borrador cuenta los `descontada` DENTRO del rango del período;
// la restricción de exclusión de 035 garantiza que ese vale es de este período.
describe("payroll: el vale ya descontado se sigue contando al recalcular el borrador", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const SALARY = 1_400_000;

  function employeeRow() {
    return {
      id: payrollPagedStub.EMPLOYEE_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: "Empleada con vale",
      employee_code: "E-10",
      document: "10000000010",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: SALARY,
      commission_percent: null,
      is_active: true,
    };
  }

  function voucher(id: string, requestDate: string, amount: number) {
    return {
      id,
      sede_id: payrollPagedStub.SEDE_ID,
      employee_id: payrollPagedStub.EMPLOYEE_ID,
      amount,
      request_date: requestDate,
      status: "descontada",
      approved_by: "u-1",
      approval_code: null,
      observation: null,
      method_code: "efectivo",
      cash_shift_id: null,
      created_by: "u-1",
    };
  }

  function seed(vouchers: Array<Record<string, unknown>>) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: ACTOR.userId,
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      employees: [employeeRow()],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: vouchers,
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("un vale `descontada` del rango se vuelve a descontar (no queda en 0)", async () => {
    seed([voucher("vale-1", "2026-01-15", 100_000)]);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].deductions_vales).toBe(100_000);
    expect(persisted[0].net_pay).toBe(SALARY - 100_000);
    // Un vale ya descontado no se reescribe: no entra a `p_voucher_ids`.
    expect(payrollPagedStub.rpcCalls[0].args.p_voucher_ids).toEqual([]);
    expect(payrollPagedStub.voucherFlips.flat()).toEqual([]);
  });

  it("un vale `descontada` de OTRO período (fuera del rango) no se cuenta", async () => {
    seed([
      voucher("vale-1", "2026-01-15", 100_000),
      voucher("vale-otro", "2025-12-20", 50_000),
    ]);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    // Solo el vale del rango: 100.000, no 150.000.
    expect(persisted[0].deductions_vales).toBe(100_000);
    expect(persisted[0].net_pay).toBe(SALARY - 100_000);
  });
});

// ------------------------------------------------- pago dividido (PAY-04) ---

describe("payroll: pago dividido suma el neto exacto (PAY-04)", () => {
  it("40% efectivo + 40% transferencia + 20% descuento cuadran 880000", () => {
    expect(() =>
      assertPortionsMatchNet(
        [{ amount: 352000 }, { amount: 352000 }, { amount: 176000 }],
        880000,
      ),
    ).not.toThrow();
  });

  it("suma distinta al neto se rechaza (SUM_MISMATCH)", () => {
    expect(() => assertPortionsMatchNet([{ amount: 800000 }], 880000)).toThrowError("SUM_MISMATCH");
  });

  it("sobrepago se rechaza (OVERPAID) y el acumulado nunca excede el neto", () => {
    expect(() => assertPortionsMatchNet([{ amount: 900000 }], 880000)).toThrowError("OVERPAID");
    expect(() => assertNoOverpay({ alreadyPaid: 500000, newAmount: 380000, netPay: 880000 })).not.toThrow();
    expect(() => assertNoOverpay({ alreadyPaid: 500000, newAmount: 380001, netPay: 880000 })).toThrowError(
      "OVERPAID",
    );
  });

  it("el esquema exige porciones con método y monto > 0, y la marca del intento (CL-2)", () => {
    // CL-2: el cuerpo del pago ganó un campo obligatorio, la marca del intento.
    const mark = "3f1c8a2e-9d47-4b6e-8f21-0c5a7b3d9e14";
    expect(
      payPayrollItemSchema.safeParse({
        idempotency_key: mark,
        portions: [{ method_code: "efectivo", amount: 100000 }],
      }).success,
    ).toBe(true);
    // Sin marca no hay forma de reconocer una repetición, y una marca mal
    // formada no la reconocería nunca: las dos se rechazan antes de escribir.
    expect(
      payPayrollItemSchema.safeParse({ portions: [{ method_code: "efectivo", amount: 100000 }] }).success,
    ).toBe(false);
    expect(
      payPayrollItemSchema.safeParse({
        idempotency_key: "no-es-un-uuid",
        portions: [{ method_code: "efectivo", amount: 100000 }],
      }).success,
    ).toBe(false);
    expect(payPayrollItemSchema.safeParse({ idempotency_key: mark, portions: [] }).success).toBe(false);
    expect(
      payPayrollItemSchema.safeParse({
        idempotency_key: mark,
        portions: [{ method_code: "efectivo", amount: 0 }],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------- periodo cerrado (PAY-01) ---

describe("payroll: periodo cerrado es inmutable (PAY-01)", () => {
  it("borrador admite cambios; cerrado bloquea todo cambio posterior", () => {
    expect(() => assertDraftPeriod("borrador")).not.toThrow();
    expect(() => assertDraftPeriod("cerrado")).toThrowError("PERIOD_CLOSED");
  });

  it("F7: apertura exige cadencia y cierre de ciclo (ya no hay rango libre)", () => {
    // El rango sale del ciclo: la cadencia y el sábado que cierra el ciclo son
    // obligatorios, y un envío sin ellos no es una apertura.
    expect(
      openPeriodSchema.safeParse({ frequency: "semanal", cycle_end_date: "2026-09-05" }).success,
    ).toBe(true);
    // Un cierre que no es sábado no cierra ningún ciclo.
    expect(
      openPeriodSchema.safeParse({ frequency: "semanal", cycle_end_date: "2026-09-04" }).success,
    ).toBe(false);
    // Sin cadencia: los períodos NUEVOS ya no pueden quedar en NULL.
    expect(openPeriodSchema.safeParse({ cycle_end_date: "2026-09-05" }).success).toBe(false);
    expect(
      openPeriodSchema.safeParse({ frequency: null, cycle_end_date: "2026-09-05" }).success,
    ).toBe(false);
    // Una fecha imposible no se normaliza.
    expect(
      openPeriodSchema.safeParse({ frequency: "semanal", cycle_end_date: "2026-02-30" }).success,
    ).toBe(false);
    // El rango enviado, si viene, tiene que coincidir con el ciclo derivado.
    expect(
      openPeriodSchema.safeParse({
        frequency: "semanal",
        cycle_end_date: "2026-09-05",
        start_date: "2026-08-30",
        end_date: "2026-09-05",
      }).success,
    ).toBe(true);
    expect(
      openPeriodSchema.safeParse({
        frequency: "semanal",
        cycle_end_date: "2026-09-05",
        start_date: "2026-08-31",
        end_date: "2026-09-05",
      }).success,
    ).toBe(false);
  });

  it("cálculo acepta ajustes por empleado (bonos y otros descuentos)", () => {
    expect(
      calculatePayrollSchema.safeParse({
        adjustments: [{ employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bonuses: 50000, other_discounts: 10000 }],
      }).success,
    ).toBe(true);
    expect(calculatePayrollSchema.safeParse({}).success).toBe(true);
  });
});

// ------------------------------------------------- vales y topes (PAY-05…07) ---

describe("payroll: tope con aprobación obligatoria (PAY-05/PAY-06)", () => {
  it("dentro de topes no exige aprobación; sobre el diario sí", () => {
    const inside = checkVoucherCaps({
      dayTotal: 20000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
    });
    expect(requiresVoucherApproval(inside)).toBe(false);

    const overDay = checkVoucherCaps({
      dayTotal: 80000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
    });
    expect(overDay.overDay).toBe(true);
    expect(requiresVoucherApproval(overDay)).toBe(true);
  });

  it("sobre el tope semanal también exige aprobación", () => {
    const overWeek = checkVoucherCaps({
      dayTotal: 10000,
      weekTotal: 280000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
    });
    expect(overWeek.overWeek).toBe(true);
    expect(requiresVoucherApproval(overWeek)).toBe(true);
  });

  it("sin topes configurados (0) no hay límite", () => {
    const caps = checkVoucherCaps({
      dayTotal: 999999,
      weekTotal: 999999,
      requested: 999999,
      maxPerDay: 0,
      maxPerWeek: 0,
    });
    expect(requiresVoucherApproval(caps)).toBe(false);
  });

  it("sin código de aprobación: el esquema de aprobar solo lleva observación", () => {
    // El flujo ya no genera ni valida códigos: la autorización queda en
    // approved_by + observation.
    expect(approveVoucherSchema.safeParse({}).success).toBe(true);
    expect(approveVoucherSchema.safeParse({ observation: "Autorizado por el admin." }).success).toBe(true);
  });

  it("dentro de rango nace aprobada (directo); fuera de rango nace pendiente", () => {
    const base = {
      dayTotal: 20000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
      requestDate: "2026-09-14",
      allowedDays: [1, 2, 3, 4, 5],
    };
    expect(resolveVoucherInitialStatus(checkVoucherEligibility(base))).toBe("aprobada");
    // Día no permitido → pendiente.
    expect(
      resolveVoucherInitialStatus(checkVoucherEligibility({ ...base, requestDate: "2026-09-20" })),
    ).toBe("pendiente");
    // Sobre el tope diario → pendiente.
    expect(
      resolveVoucherInitialStatus(checkVoucherEligibility({ ...base, dayTotal: 80000 })),
    ).toBe("pendiente");
  });

  it("la semana arranca el lunes (para el tope semanal)", () => {
    // 2026-09-18 es viernes → la semana arranca el lunes 2026-09-14.
    expect(weekStartOf("2026-09-18")).toBe("2026-09-14");
    expect(weekStartOf("2026-09-14")).toBe("2026-09-14");
    expect(weekStartOf("2026-09-20")).toBe("2026-09-14");
  });

  it("descontada y rechazada son terminales (doble descuento imposible)", () => {
    expect(canDiscountVoucher("pendiente")).toBe(true);
    expect(canDiscountVoucher("aprobada")).toBe(true);
    expect(canDiscountVoucher("descontada")).toBe(false);
    expect(canDiscountVoucher("rechazada")).toBe(false);
    expect(canReviewVoucher("pendiente")).toBe(true);
    expect(canReviewVoucher("aprobada")).toBe(false);
    expect(canReviewVoucher("descontada")).toBe(false);
  });

  it("solicitud exige monto > 0 y rechazo exige motivo", () => {
    // CL-5: la marca del intento es obligatoria (la misma definición para todas
    // las puertas del dinero). El cuerpo válido la lleva; sin ella —o con una que
    // no es uuid— se rechaza con CERO escrituras.
    const idempotency_key = "6d2f9b14-7a35-4e08-9c61-2b8e4d0f7a53";
    expect(
      requestVoucherSchema.safeParse({
        idempotency_key,
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
        method_code: "efectivo",
      }).success,
    ).toBe(true);
    expect(
      requestVoucherSchema.safeParse({
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
        method_code: "efectivo",
      }).success,
    ).toBe(false);
    expect(
      requestVoucherSchema.safeParse({
        idempotency_key: "no-es-un-uuid",
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
        method_code: "efectivo",
      }).success,
    ).toBe(false);
    // El método arqueable se elige AL CREAR el vale: es obligatorio.
    expect(
      requestVoucherSchema.safeParse({
        idempotency_key,
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
      }).success,
    ).toBe(false);
    expect(
      requestVoucherSchema.safeParse({
        idempotency_key,
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 0,
        method_code: "efectivo",
      }).success,
    ).toBe(false);
    expect(rejectVoucherSchema.safeParse({ motivo: "Sin justificación" }).success).toBe(true);
    expect(rejectVoucherSchema.safeParse({ motivo: "  " }).success).toBe(false);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000 }).success,
    ).toBe(true);
    expect(voucherLimitsSchema.safeParse({ max_per_day: -1, max_per_week: 0 }).success).toBe(false);
  });
});

// ------------------------------------------------- migración 007 ---
describe("migración 007_payroll.sql (T7)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "007_payroll.sql"), "utf8");

  it("crea payroll_periods, payroll_items, payroll_payments, voucher_settings y voucher_requests", () => {
    expect(sql).toContain("CREATE TABLE public.payroll_periods");
    expect(sql).toContain("CREATE TABLE public.payroll_items");
    expect(sql).toContain("CREATE TABLE public.payroll_payments");
    expect(sql).toContain("CREATE TABLE public.voucher_settings");
    expect(sql).toContain("CREATE TABLE public.voucher_requests");
  });

  it("periodo con fin >= inicio, borrador/cerrado y borrador único por rango y sede", () => {
    expect(sql).toContain("CHECK (end_date >= start_date)");
    expect(sql).toContain("CHECK (status IN ('borrador', 'cerrado'))");
    expect(sql).toContain("uq_payroll_draft_per_range");
    expect(sql).toContain("WHERE status = 'borrador'");
  });

  it("ítem con neto = base + comisiones + bonos − vales − otros y detail_json", () => {
    expect(sql).toContain("detail_json jsonb NOT NULL");
    expect(sql).toContain("base_fixed + commissions + bonuses - deductions_vales - other_discounts");
    expect(sql).toContain("UNIQUE (period_id, employee_id)");
  });

  it("pagos con monto > 0, trigger anti-sobrepago y vales con estados y topes", () => {
    expect(sql).toContain("CHECK (amount > 0)");
    expect(sql).toContain("check_payroll_payments_cap");
    expect(sql).toContain("CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'descontada'))");
    expect(sql).toContain("max_per_day");
    expect(sql).toContain("max_per_week");
    expect(sql).toContain("approval_code");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY pol_payroll_periods_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_payroll_items_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_payroll_payments_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_voucher_settings_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_voucher_requests_sede_isolation");
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("documenta PAY-01…07 y el cierre inmutable", () => {
    expect(sql).toContain("PAY-01");
    expect(sql).toContain("PAY-07");
    expect(sql).toContain("inmutable");
  });
});

// ------------------------------------------------- item 5: días permitidos ---

describe("vales item 5: días permitidos + elegibilidad (sin romper topes)", () => {
  it("weekdayIso: 1=lunes…7=domingo", () => {
    // 2026-09-14 es lunes, 2026-09-20 es domingo.
    expect(weekdayIso("2026-09-14")).toBe(1);
    expect(weekdayIso("2026-09-18")).toBe(5);
    expect(weekdayIso("2026-09-20")).toBe(7);
  });

  it("sin config (null) todos los días están permitidos", () => {
    expect(isVoucherDayAllowed("2026-09-20", null)).toBe(true);
    expect(isVoucherDayAllowed("2026-09-20", [])).toBe(true);
  });

  it("con días L–V el domingo no está permitido y el lunes sí", () => {
    expect(isVoucherDayAllowed("2026-09-20", [1, 2, 3, 4, 5])).toBe(false);
    expect(isVoucherDayAllowed("2026-09-14", [1, 2, 3, 4, 5])).toBe(true);
  });

  it("normaliza: únicos, ordenados y solo 1…7", () => {
    expect(normalizeAllowedDays([5, 1, 5, 0, 8])).toEqual([1, 5]);
    expect(normalizeAllowedDays(null)).toBeNull();
  });

  it("dentro de topes y en día permitido no exige revisión", () => {
    const ok = checkVoucherEligibility({
      dayTotal: 20000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
      requestDate: "2026-09-14",
      allowedDays: [1, 2, 3, 4, 5],
    });
    expect(ok.dayNotAllowed).toBe(false);
    expect(voucherRequiresReview(ok)).toBe(false);
  });

  it("día no permitido exige revisión aunque esté dentro de topes", () => {
    const off = checkVoucherEligibility({
      dayTotal: 20000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
      requestDate: "2026-09-20",
      allowedDays: [1, 2, 3, 4, 5],
    });
    expect(off.dayNotAllowed).toBe(true);
    expect(off.overDay).toBe(false);
    expect(voucherRequiresReview(off)).toBe(true);
  });

  it("sobre tope sigue exigiendo revisión (compatibilidad F4)", () => {
    const over = checkVoucherEligibility({
      dayTotal: 80000,
      weekTotal: 50000,
      requested: 30000,
      maxPerDay: 100000,
      maxPerWeek: 300000,
      requestDate: "2026-09-14",
      allowedDays: null,
    });
    expect(over.overDay).toBe(true);
    expect(voucherRequiresReview(over)).toBe(true);
  });

  it("el esquema de topes acepta días opcionales y rechaza inválidos", () => {
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000 }).success,
    ).toBe(true);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000, allowed_days: [1, 2, 3, 4, 5] })
        .success,
    ).toBe(true);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000, allowed_days: [] }).success,
    ).toBe(false);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000, allowed_days: [0] }).success,
    ).toBe(false);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 100000, max_per_week: 300000, allowed_days: [8] }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------- V2: tope por día ---

describe("V2 topes de vales: opcionales y por día", () => {
  it("normaliza los topes por día a un mapa y descarta inválidos", () => {
    expect(normalizePerDayLimits([{ day: 3, amount: 50000 }, { day: 5, amount: "80000" }])).toEqual({
      "3": 50000,
      "5": 80000,
    });
    expect(normalizePerDayLimits([{ day: 0, amount: 1000 }, { day: 9, amount: 1000 }])).toBeNull();
    expect(normalizePerDayLimits([])).toBeNull();
    expect(normalizePerDayLimits(null)).toBeNull();
  });

  it("las entradas repetidas se quedan con la última", () => {
    expect(normalizePerDayLimits([{ day: 1, amount: 1000 }, { day: 1, amount: 2000 }])).toEqual({
      "1": 2000,
    });
  });

  it("el tope propio del día reemplaza al general ese día", () => {
    const limits = { "3": 50000 };
    // 2026-09-16 es miércoles (ISO 3) y 2026-09-14 lunes (ISO 1).
    expect(resolveVoucherDayCap(100000, limits, "2026-09-16")).toBe(50000);
    expect(resolveVoucherDayCap(100000, limits, "2026-09-14")).toBe(100000);
  });

  it("sin tope propio ni general el tope es nulo (ilimitado)", () => {
    expect(resolveVoucherDayCap(null, null, "2026-09-16")).toBeNull();
    expect(resolveVoucherDayCap(null, {}, "2026-09-16")).toBeNull();
  });

  it("con tope propio más bajo, el vale que cabía en el general exige revisión", () => {
    const base = {
      dayTotal: 20000,
      weekTotal: 50000,
      requested: 40000,
      maxPerWeek: 300000,
      requestDate: "2026-09-16",
      allowedDays: null,
    };
    const withGeneral = checkVoucherEligibility({ ...base, maxPerDay: 100000 });
    expect(withGeneral.overDay).toBe(false);
    const withOwnDay = checkVoucherEligibility({
      ...base,
      maxPerDay: 100000,
      perDayLimits: { "3": 50000 },
    });
    expect(withOwnDay.overDay).toBe(true);
    expect(voucherRequiresReview(withOwnDay)).toBe(true);
  });

  it("sin topes (null) ningún monto exige revisión por topes", () => {
    const noCaps = checkVoucherEligibility({
      dayTotal: 0,
      weekTotal: 0,
      requested: 500000,
      maxPerDay: null,
      maxPerWeek: null,
      requestDate: "2026-09-16",
      allowedDays: null,
    });
    expect(noCaps.overDay).toBe(false);
    expect(noCaps.overWeek).toBe(false);
    expect(voucherRequiresReview(noCaps)).toBe(false);
  });

  it("el esquema acepta topes opcionales y tope por día, y rechaza inválidos", () => {
    expect(voucherLimitsSchema.safeParse({ max_per_day: null, max_per_week: null }).success).toBe(true);
    expect(
      voucherLimitsSchema.safeParse({
        max_per_day: null,
        max_per_week: 300000,
        allowed_days: [1, 3, 5],
        per_day_limits: [{ day: 1, amount: 50000 }],
      }).success,
    ).toBe(true);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 1000, max_per_week: 1000, per_day_limits: [{ day: 8, amount: 1 }] })
        .success,
    ).toBe(false);
    expect(
      voucherLimitsSchema.safeParse({ max_per_day: 1000, max_per_week: 1000, per_day_limits: [{ day: 1, amount: -1 }] })
        .success,
    ).toBe(false);
  });
});

// ------------------------------------------------- migración 026 ---

describe("migración 026_voucher_limits.sql (V2)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "026_voucher_limits.sql"), "utf8");

  it("vuelve opcionales los topes y agrega per_day_limits re-ejecutable", () => {
    expect(sql).toContain("max_per_day DROP NOT NULL");
    expect(sql).toContain("max_per_week DROP NOT NULL");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS per_day_limits jsonb");
    expect(sql).toContain("chk_voucher_settings_per_day_limits");
  });
});

// ------------------------------------------------- migración 024 ---

describe("migración 024_voucher_days.sql (item 5)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "024_voucher_days.sql"), "utf8");

  it("agrega allowed_days re-ejecutable con CHECK 1…7 y valor por defecto", () => {
    expect(sql).toContain("allowed_days");
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).toContain("chk_voucher_settings_allowed_days");
    expect(sql).toContain("'{1,2,3,4,5,6,7}'");
  });
});

// ------------------------------------------------- migración 028 ---

describe("migración 028_voucher_payment_method.sql (método y turno del vale)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "028_voucher_payment_method.sql"),
    "utf8",
  );

  it("agrega method_code y cash_shift_id re-ejecutable y sin borrar approval_code", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS method_code text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS cash_shift_id uuid");
    expect(sql).toContain("REFERENCES public.cash_shifts");
    expect(sql).toContain("idx_voucher_requests_cash_shift");
    expect(sql).toContain("chk_voucher_requests_method_code");
    // No destructiva: la columna histórica del código se conserva sin uso.
    expect(sql).not.toContain("DROP COLUMN approval_code");
  });
});

// ------------------------------------------------- migración 029 ---

describe("migración 029_voucher_created_by.sql (autor del vale)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "029_voucher_created_by.sql"),
    "utf8",
  );

  it("agrega created_by re-ejecutable sin borrar approved_by ni approval_code", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS created_by uuid");
    expect(sql).toContain("REFERENCES public.users");
    expect(sql).toContain("ON DELETE SET NULL");
    // No destructiva: las columnas de aprobación se conservan intactas.
    expect(sql).not.toContain("DROP COLUMN approved_by");
    expect(sql).not.toContain("DROP COLUMN approval_code");
  });
});

// ------------------------------------------------- borrar borrador (PAY-01) ---

describe("payroll: borrado de un período en borrador (PAY-01)", () => {
  it("solo el borrador puede borrarse; el cerrado se rechaza con código propio", () => {
    expect(() => assertDeletablePeriod("borrador")).not.toThrow();
    expect(() => assertDeletablePeriod("cerrado")).toThrowError("PERIOD_NOT_DRAFT");
  });

  it("solapar con otro BORRADOR no bloquea el borrado (no hay plata pagada)", () => {
    expect(overlapBlocksDeletion([])).toBe(false);
    expect(overlapBlocksDeletion(["borrador"])).toBe(false);
    expect(overlapBlocksDeletion(["borrador", "borrador"])).toBe(false);
  });

  it("solapar con un período CERRADO sí bloquea (se destruiría nómina pagada)", () => {
    expect(overlapBlocksDeletion(["cerrado"])).toBe(true);
    // Basta un cerrado entre varios solapados para bloquear.
    expect(overlapBlocksDeletion(["borrador", "cerrado"])).toBe(true);
    expect(overlapBlocksDeletion(["cerrado", "borrador"])).toBe(true);
  });

  it("(b) la reversión es por rango + estado: puede alcanzar vales que descontó OTRO borrador", () => {
    // Escenario documentado (sin FK vale↔período; migración 007):
    // A [2026-09-01, 2026-09-15] y B [2026-09-10, 2026-09-20], ambos borradores.
    // B liquidó primero el vale V (request_date 2026-09-12): V = descontada.
    // A, al liquidar, filtra status IN (pendiente, aprobada) y NO vuelve a
    // descontar V. Al borrar A, la reversión (status = descontada + rango de A)
    // SÍ alcanza V aunque su descuento provenga de B: el filtro no tiene
    // atribución de período. B queda inconsistente hasta que se recalcule
    // (calculatePayroll vuelve a marcar V como descontada).
    const periodA = { start_date: "2026-09-01", end_date: "2026-09-15" };
    const voucher = { request_date: "2026-09-12", status: "descontada", approved_by: "user-1" };
    // Réplica exacta del filtro SQL de deletePayrollPeriod.
    const reaches = voucher.status === "descontada"
      && voucher.request_date >= periodA.start_date
      && voucher.request_date <= periodA.end_date;
    expect(reaches).toBe(true);
    expect(restoreVoucherStatus(voucher.approved_by)).toBe("aprobada");
  });

  it("los vales descontados vuelven a su estado previo según approved_by", () => {
    // Aprobado (o auto-aprobado) tenía aprobador: vuelve a aprobada.
    expect(restoreVoucherStatus("user-1")).toBe("aprobada");
    // Pendiente nunca tuvo aprobador: vuelve a pendiente.
    expect(restoreVoucherStatus(null)).toBe("pendiente");
  });

  it("las FK de 007 son ON DELETE CASCADE (ítems y pagos caen con el período)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "007_payroll.sql"), "utf8");
    expect(sql).toContain(
      "period_id uuid NOT NULL REFERENCES public.payroll_periods (id) ON DELETE CASCADE",
    );
    expect(sql).toContain(
      "payroll_item_id uuid NOT NULL REFERENCES public.payroll_items (id) ON DELETE CASCADE",
    );
  });
});

// ------------------------------------------- tope de efectivo al aprobar (PAY-06) ---

describe("payroll: tope del 50% de salidas en efectivo al APROBAR un vale (PAY-06)", () => {
  it("aprueba un vale de efectivo dentro del tope (acumulado + vale <= 50% de la base)", () => {
    // Base 200000 → tope 100000; ya salió 20000; el vale de 50000 deja 70000.
    expect(
      voucherApprovalCashOutViolation({
        methodCode: "efectivo",
        cashShiftId: "shift-1",
        openingBase: 200000,
        cashOutUsed: 20000,
        amount: 50000,
      }),
    ).toBeNull();
  });

  it("rechaza un vale de efectivo que supera el tope contando lo ya salido del turno", () => {
    // Base 200000 → tope 100000; ya salió 80000; el vale de 30000 proyecta 110000.
    const violation = voucherApprovalCashOutViolation({
      methodCode: "efectivo",
      cashShiftId: "shift-1",
      openingBase: 200000,
      cashOutUsed: 80000,
      amount: 30000,
    });
    expect(violation?.code).toBe("CASH_OUT_LIMIT_EXCEEDED");
    expect(violation?.message).toContain("30000");
    expect(violation?.message).toContain("200000");
  });

  it("no aplica tope a un vale NO efectivo aunque supere el 50%", () => {
    expect(
      voucherApprovalCashOutViolation({
        methodCode: "nequi",
        cashShiftId: "shift-1",
        openingBase: 200000,
        cashOutUsed: 80000,
        amount: 300000,
      }),
    ).toBeNull();
  });

  it("un vale histórico sin turno ni método no tiene tope (no se puede acumular)", () => {
    expect(
      voucherApprovalCashOutViolation({
        methodCode: "efectivo",
        cashShiftId: null,
        openingBase: null,
        cashOutUsed: 0,
        amount: 999999,
      }),
    ).toBeNull();
  });
});

// ---- U5: el cálculo lee TODAS las filas (tope de transporte ≠ tope de negocio) ----
//
// `calculatePayroll` leía facturas, ítems, reglas, vales y pagos inmediatos con
// `.limit(N)` — sin `order()` y sin error al tocar el tope. El Data API de
// Supabase sirve por request la ventana pedida y a lo sumo `max-rows` filas: ese
// tope de TRANSPORTE se comportaba como tope de NEGOCIO. Una sede que lo pasa
// liquida comisiones y vales con un conjunto recortado: al empleado le falta
// plata y los topes de vales se evalúan contra un acumulado que no es el real.
// El doble de acá sirve ventanas reales (filtros, orden y tope por request) para
// poder demostrarlo sin base de datos.

const payrollPagedStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  PERIOD_ID: "22222222-2222-4222-8222-222222222222",
  EMPLOYEE_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  SERVICE_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  /** `max-rows` por request del Data API de Supabase: el tope REAL. */
  rowCap: 1000,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Número de request (1-based, por tabla) donde el doble devuelve error. */
  failAt: {} as Record<string, number[]>,
  requests: {} as Record<string, number>,
  /** Ventanas efectivamente pedidas: prueba de que se paginó y en qué orden. */
  windows: [] as Array<{ table: string; from: number; to: number; order: string[] }>,
  /** Payload del upsert de `payroll_items`: la plata que el servicio persistió. */
  itemsUpsert: null as Array<Record<string, unknown>> | null,
  /**
   * Largo de cada `in(...)`: prueba de que los ids se parten (URL de 414).
   */
  inFilters: [] as Array<{ table: string; column: string; count: number }>,
  /**
   * Falla la lectura (o la escritura) de `table` cuando entre sus filtros está
   * `filter`, con el `code` indicado (F10: `42703` = columna inexistente).
   */
  failOn: null as { table: string; filter: string; code?: string } | null,
  /**
   * U8: simula la ESCRITURA concurrente de otra transacción (la nómina que
   * descuenta el vale) justo antes de que el UPDATE del servicio evalúe sus
   * filtros. Así la carrera entre la lectura y la escritura se observa de
   * verdad: la fila cambió entre la lectura y el compare-and-swap.
   */
  beforeUpdate: null as { table: string; run: () => void } | null,
  /** Sesión que devuelve el `requireSession` simulado (pruebas de actions, U8). */
  session: {
    userId: "u-empleado-55",
    sedeId: "11111111-1111-4111-8111-111111111111",
    roles: ["empleado"],
  } as AdminSession,
  /** Payload de cada INSERT (auditoría y demás): qué se registró de verdad. */
  inserts: [] as Array<{ table: string; payload: unknown }>,
  /**
   * CL-5: consecutivo de las filas que el doble inserta. En la base `id` es
   * `uuid DEFAULT gen_random_uuid()`: dos filas NUNCA comparten id, ni las de
   * dos INSERT distintos de una sola fila. El doble numeraba por índice DENTRO
   * del statement, así que dos pagos distintos se llamaban los dos
   * `fila-insertada-1` —imposible en la tabla real— y cualquier aserción sobre
   * la identidad de dos pagos legítimos medía un artefacto del doble.
   */
  rowSeq: 0,
  /**
   * PR1: falla el INSERT de `table` con este código. El doble tiene que poder
   * responder como la BASE (una restricción violada, `23P01`), no sólo como un
   * cliente feliz: si no, la carrera contra la restricción de exclusión no se
   * podría probar.
   *
   * La base manda las dos cosas de un error de Postgres y las dos sirven: el
   * `code` describe una restricción violada (`23P01`) y el `message` cualquier
   * otro fallo —un `upsert` que la base rechaza sin violated constraint no tiene
   * un `code` que inventarle—. Con `code` el doble arma el mensaje; con
   * `message` lo usa tal cual; sin ninguno, un error genérico de la base.
   */
  insertError: null as { table: string; code?: string; message?: string } | null,
  /** Payload de cada UPDATE, por tabla: si la escritura ocurrió o no. */
  updates: [] as Array<{ table: string; payload: unknown }>,
  /**
   * CL-2: índices únicos PARCIALES (columnas de marca no nula) que el doble
   * aplica de verdad. Un INSERT que los repita responde 23505 y NO persiste
   * NINGUNA fila: en Postgres la sentencia entera aborta, y eso es
   * exactamente lo que hace sonora la opción "la marca en la primera fila".
   * Vacío = la tabla se comporta como antes (ningún bloque existente cambia).
   */
  uniqueKeys: [] as Array<{ table: string; columns: string[] }>,
  /**
   * CL-2: saltea UNA vez el lookup por marca: arma la ventana de la carrera
   * (la otra transacción se confirmó entre el lookup y el INSERT).
   */
  skipMarkLookupOnce: false,
  /**
   * CL-16: el tope de `payroll_payments` (007 `check_payroll_payments_cap`,
   * reescrito por 055) como lo aplica la BASE, con su lock de la fila PADRE.
   * Apagado por defecto (mismo idioma que `uniqueKeys`): ningún bloque
   * existente cambia de conducta.
   */
  capEnabled: false,
  /**
   * CL-16: la otra transacción. Pagó `amount` del ítem `itemId` y CONFIRMÓ entre
   * la lectura del acumulado de este servicio y su INSERT: la ventana exacta que
   * el lock cierra. Se consume una sola vez. `null` = no hay carrera.
   */
  capRace: null as { itemId: string; amount: number; method_code?: string } | null,
  /**
   * CL-16: qué vio cada evaluación del tope. Es la prueba de que el trigger
   * corrió de verdad (no vacuidad): sin esto, un tope que nunca se evalúa
   * pasaría cualquier aserción de rechazo.
   */
  capChecks: [] as Array<{
    itemId: string;
    sum: number;
    incoming: number;
    net: number;
    sawConcurrent: boolean;
  }>,
  /**
   * CL-8: el fallo de la escritura que descuenta los vales.
   *
   * El punto de fallo es SEMÁNTICO y por eso sirve para los dos caminos: en el
   * camino viejo falla el `UPDATE` suelto de `voucher_requests` (el ítem ya
   * quedó escrito, porque es otro request); con la transacción del servidor
   * falla el RPC entero, que revierte las DOS escrituras. Es la misma falla
   * —"no se pudo marcar el vale"— vista desde cada mecanismo.
   */
  failVoucherFlip: null as string | null,
  /**
   * CL-8: el servidor RECHAZA el RPC. Es el rechazo de las guardas de forma y
   * de las redes de conteo (entrada mal formada, período/empleado ausente,
   * carrera perdida): la sentencia no escribió nada.
   */
  failRpcWith: null as string | null,
  /**
   * CL-8: payloads de ítems que la base CONFIRMÓ, uno por escritura aplicada.
   * Un ítem con `deductions_vales` es un conocimiento del vale ya consumado:
   * dos entradas con el mismo vale = el vale descontado DOS veces.
   */
  itemWrites: [] as Array<Array<Record<string, unknown>>>,
  /** CL-8: ids de vales que cada escritura confirmada marcó `descontada`. */
  voucherFlips: [] as string[][],
  /** CL-8: cada llamada al RPC, con lo que la transacción recibió. */
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /**
   * CL-9: el fallo de la escritura que BORRA el período, DESPUÉS de haber
   * revertido los vales.
   *
   * El punto de fallo es SEMÁNTICO y por eso sirve para los dos caminos: en el
   * camino viejo falla el `.delete()` suelto de `payroll_periods` (los vales ya
   * quedaron revertidos, porque son otros requests); con la transacción del
   * servidor falla el paso del DELETE y se revierte TODO, reversión incluida.
   */
  failDeletePeriod: null as string | null,
  /**
   * CL-9: el fallo de la escritura de las FILAS de la corrección, DESPUÉS de
   * haber insertado la cabecera. Misma simetría que `failDeletePeriod`: en el
   * camino viejo falla el INSERT suelto de
   * `payroll_period_correction_items`; con la transacción falla ese paso y se
   * revierte también la cabecera.
   */
  failCorrectionLines: null as string | null,
  /**
   * CL-9: escritura de OTRA transacción justo ANTES de que el RPC evalúe sus
   * precondiciones (la carrera real). Se consume una sola vez. No es
   * `beforeUpdate`: estos dos caminos ya no pasan por un `UPDATE` del cliente.
   */
  beforeRpc: null as { run: () => void } | null,
  /** CL-9: borrados efectivos del doble, por tabla (no intentos: hechos). */
  deletes: [] as Array<{ table: string; count: number }>,
  /**
   * 072: cada RESERVA del consecutivo y a qué rival vio, para que la prueba de
   * que el número no se repite no afirme una bandera que ella misma puso.
   */
  sequenceChecks: [] as Array<{ sawRival: boolean; emitida: number }>,
  /**
   * 072: CONTROL NEGATIVO del guardián. `null` (lo normal) = el lock se lee del
   * ARTEFACTO. Un booleano lo apaga o lo enciende para comprobar que el doble
   * DE VERDAD ve el duplicado cuando la fila no se bloquea: sin esta prueba, un
   * doble que siempre «no repite números» no probaría nada. Sólo lo usan las
   * pruebas de control; el comportamiento se lee del archivo.
   */
  sequenceLockOverride: null as boolean | null,
}));

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * CL-16: el cuerpo del tope de nómina que está DESPLEGADO. La 007 lo declara y
 * la 055 lo reescribe; se toma la ÚLTIMA definición, así que quitar el lock de
 * la 055 (o no tenerla) deja a la 007 vigente. El cuerpo se mira sin comentarios:
 * la prosa no es la barrera.
 */
function deployedPayrollCapBody(): string {
  const files = ["007_payroll.sql", "055_payroll_payments_cap_lock.sql"].filter((file) =>
    existsSync(join(MIGRATIONS_DIR, file)),
  );
  const last = files[files.length - 1];
  if (!last) return "";
  const raw = readFileSync(join(MIGRATIONS_DIR, last), "utf8");
  const start = raw.indexOf("CREATE OR REPLACE FUNCTION public.check_payroll_payments_cap");
  if (start === -1) return "";
  const body = raw.slice(start);
  const end = body.indexOf("$$;");
  return (end === -1 ? body : body.slice(0, end))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * CL-16: ¿el tope desplegado bloquea la fila del padre? El doble NO recibe esta
 * respuesta del test: la lee del ARTEFACTO. Por eso el test de comportamiento
 * se cae solo si el lock desaparece de la migración (vuelve la carrera
 * vulnerable), en vez de afirmar una bandera que el test eligió.
 */
function payrollCapLocksParent(): boolean {
  return /\bFOR\s+UPDATE\b/.test(deployedPayrollCapBody());
}

/**
 * 072: el cuerpo DESPLEGADO de `next_invoice_number`: lo declara 005 y lo
 * re-emite 072 con el cuerpo nuevo (misma firma, otra fila que bloquear). Se
 * toma la ÚLTIMA definición, así que la 005 deja de mandar en cuanto la 072
 * está —y si la 072 no existiera, la 005 seguiría siendo la vigente. El cuerpo
 * se mira sin comentarios: la prosa no es la barrera.
 */
function deployedNextInvoiceNumberBody(): string {
  const files = ["005_billing.sql", "072_system_settings.sql"].filter((file) =>
    existsSync(join(MIGRATIONS_DIR, file)),
  );
  for (const file of files.reverse()) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const start = raw.indexOf("CREATE OR REPLACE FUNCTION public.next_invoice_number");
    if (start === -1) continue;
    const body = raw.slice(start);
    const end = body.indexOf("$$;");
    return (end === -1 ? body : body.slice(0, end))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
  }
  return "";
}

/**
 * 072: ¿el contador desplegado toma el lock de la fila que incrementa? El doble
 * NO recibe esta respuesta del test: la lee del ARTEFACTO, igual que
 * `payrollCapLocksParent`. Por eso el test de comportamiento se cae solo si el
 * `FOR UPDATE` desaparece de la 072 (la serie vuelve a poder repetir un número),
 * en vez de afirmar una bandera que el test eligió.
 */
function invoiceSequenceLocksRow(): boolean {
  const override = payrollPagedStub.sequenceLockOverride;
  if (override !== null) return override;
  const body = deployedNextInvoiceNumberBody();
  return /\bFOR\s+UPDATE\b/.test(body) && body.includes("'invoice_sequence'");
}

/**
 * 072: la fila del consecutivo como la aplica Postgres: se bloquea la fila de la
 * clave, se lee su `last_number` y se incrementa en la MISMA transacción.
 *
 * La parte que decide es la FOTO de la lectura, y depende del lock:
 *   * con el lock desplegado, el segundo emisor ESPERÓ y su foto es POSTERIOR al
 *     commit del primero: ve el número que el primero dejó y se lleva el
 *     siguiente;
 *   * sin lock, la foto es la de su propia lectura, ANTERIOR: no lo ve y los dos
 *     emiten el mismo número (el defecto FAC-05 de 005).
 *
 * `rival` modela esa otra transacción: su incremento YA está confirmado cuando
 * ésta entra.
 */
function reserveInvoiceSequence(rival: { before: number; emitted: number } | null = null): number {
  const locksRow = invoiceSequenceLocksRow();
  const key = "invoice_sequence";
  const filas = (): Array<Record<string, unknown>> => payrollPagedStub.tables.system_settings ?? [];
  const fila = () => filas().find((row) => row.key === key);
  // La fila tiene que existir antes de poder bloquearla: es el
  // `INSERT … ON CONFLICT DO NOTHING` de la función.
  if (!fila()) {
    payrollPagedStub.tables.system_settings = [
      ...filas(),
      { key, value: { last_number: 0 }, updated_at: "2026-01-31T23:59:59.000Z" },
    ];
  }
  if (rival !== null) {
    // La otra transacción reservó y CONFIRMÓ antes de que ésta leyera: la fila
    // de la clave queda con el número que ella emitió.
    fila()!.value = { last_number: rival.emitted };
    payrollPagedStub.tables.system_settings = filas();
  }
  const actual = Number((fila()?.value as { last_number?: unknown })?.last_number ?? 0);
  // LA FOTO de la lectura: con el lock, esta transacción ESPERÓ y lee lo que la
  // otra dejó (posterior a su commit); sin lock, su foto es la de su propia
  // lectura, anterior al commit rival, así que emite el mismo número.
  const leido = rival !== null && !locksRow ? rival.before : actual;
  const emitida = leido + 1;
  fila()!.value = { last_number: emitida };
  payrollPagedStub.tables.system_settings = filas();
  payrollPagedStub.sequenceChecks.push({ sawRival: locksRow, emitida });
  return emitida;
}

/** 072: lo que la fila del consecutivo tiene escrito ahora mismo. */
function storedInvoiceSequence(): number {
  const fila = (payrollPagedStub.tables.system_settings ?? []).find(
    (row) => row.key === "invoice_sequence",
  );
  return Number((fila?.value as { last_number?: unknown })?.last_number ?? 0);
}

/**
 * 072: las filas de `system_settings` que equivalen a una configuración de topes
 * de vales. Cada ajuste es UNA fila con su clave y su sobre, que es la forma en
 * que los escribe `setVoucherLimits` y en que los deja la migración.
 */
function voucherSettingRows(settings: {
  max_per_day?: number | null;
  max_per_week?: number | null;
  allowed_days?: number[] | null;
  per_day_limits?: Record<string, number> | null;
}): Array<Record<string, unknown>> {
  return [
    { key: "voucher_max_per_day", value: { amount: settings.max_per_day ?? null } },
    { key: "voucher_max_per_week", value: { amount: settings.max_per_week ?? null } },
    { key: "voucher_per_day_limits", value: { limits: settings.per_day_limits ?? null } },
    { key: "voucher_allowed_days", value: { days: settings.allowed_days ?? null } },
  ];
}

/**
 * CL-16: el tope de `payroll_payments` como lo aplica Postgres en un trigger
 * `BEFORE INSERT`: por cada fila, foto del acumulado del ítem y rechazo si
 * `suma + nuevo − neto > 0,009`, con `RAISE EXCEPTION` plano (P0001).
 *
 * La parte que importa es la FOTO, y depende del lock:
 *   * con el lock desplegado, el trigger esperó a que la transacción rival
 *     confirmara y su sentencia del SUM toma una foto POSTERIOR: ve la fila
 *     rival y la compara;
 *   * sin el lock, la foto es la de su propia sentencia, PREVIA al commit
 *     rival: no la ve, y las dos filas entran (el hueco de la 007).
 */
function applyPayrollPaymentsCap(
  values: Array<Record<string, unknown>>,
): { data: null; error: { code: string; message: string } } | null {
  const locksParent = payrollCapLocksParent();
  const payments = (): Array<Record<string, unknown>> =>
    payrollPagedStub.tables.payroll_payments ?? [];
  for (const row of values) {
    const itemId = String(row.payroll_item_id ?? "");
    // La otra transacción confirmó su fila mientras ésta esperaba el lock. Su
    // fila es un HECHO (otra transacción ya cerró), entre o no la nuestra.
    let seen = payments();
    const race = payrollPagedStub.capRace;
    const sawConcurrent = race !== null && race.itemId === itemId;
    if (sawConcurrent && race) {
      payrollPagedStub.capRace = null;
      const concurrentRow: Record<string, unknown> = {
        id: `fila-insertada-${(payrollPagedStub.rowSeq += 1)}`,
        payroll_item_id: itemId,
        method_id: null,
        method_code: race.method_code ?? "efectivo",
        amount: race.amount,
        paid_at: "2026-01-31T23:59:59.000Z",
        paid_by: "u-otra-transaccion",
        reference: null,
        idempotency_key: null,
        created_at: "2026-01-31T23:59:59.000Z",
      };
      const before = payments();
      payrollPagedStub.tables.payroll_payments = [...before, concurrentRow];
      // Con el lock desplegado el trigger ESPERÓ y su foto es POSTERIOR al
      // commit rival: ve la fila. Sin el lock su foto es la de su propia
      // sentencia, ANTERIOR: no la ve y las dos filas entran (el hueco de 007).
      seen = locksParent ? payments() : before;
    }
    const item = (payrollPagedStub.tables.payroll_items ?? []).find(
      (candidate) => String(candidate.id) === itemId,
    );
    if (!item) {
      return {
        data: null,
        error: { code: "P0001", message: `Ítem de nómina inexistente (${itemId})` },
      };
    }
    const sum = seen
      .filter((other) => String(other.payroll_item_id) === itemId)
      .reduce((acc, other) => acc + Number(other.amount), 0);
    const net = Number(item.net_pay);
    const incoming = Number(row.amount ?? 0);
    payrollPagedStub.capChecks.push({ itemId, sum, incoming, net, sawConcurrent });
    if (sum + incoming - net > 0.009) {
      return {
        data: null,
        error: {
          code: "P0001",
          message: `El pago supera el neto del ítem (neto ${net}, pagado ${sum}, nuevo ${incoming})`,
        },
      };
    }
  }
  return null;
}

/**
 * Cliente Supabase falso con la conducta del Data API: aplica filtros
 * (`eq`/`neq`/`gte`/`lte`/`in`), ordena por `order()` y sirve SOLO la ventana
 * pedida (`range`/`limit`), con el techo por request de `rowCap`. Sin eso la
 * truncación no existiría en el doble y el test no probaría nada.
 */
function createPayrollPagedStubClient(): unknown {
  const from = (table: string) => {
    let op = "select";
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    /** Columnas filtradas, en orden: identifica QUÉ lectura se está pidiendo. */
    const filterColumns: string[] = [];
    const orderKeys: Array<{ column: string; ascending: boolean }> = [];
    let rangeFrom = 0;
    let rangeTo = payrollPagedStub.rowCap - 1;
    let updatePayload: Record<string, unknown> | undefined;
    let insertPayload: unknown;
    /** 072: columna (o columnas) del destino de conflicto del `upsert`. */
    let upsertConflict: string | null = null;

    const rows = (): Array<Record<string, unknown>> => payrollPagedStub.tables[table] ?? [];

    const select = (single: boolean): { data: unknown; error: unknown } => {
      if (op === "update") {
        // U8: la otra transacción escribe ANTES de que este UPDATE evalúe sus
        // filtros (la carrera real). Se dispara una sola vez.
        const beforeUpdate = payrollPagedStub.beforeUpdate;
        if (beforeUpdate && beforeUpdate.table === table) {
          payrollPagedStub.beforeUpdate = null;
          beforeUpdate.run();
        }
        // F10: la escritura puede fallar por el MISMO motivo inyectado que la
        // lectura (la columna que la migración todavía no agregó): el doble
        // contesta como la base, no como un cliente feliz.
        const updateFailure = payrollPagedStub.failOn;
        if (
          updateFailure &&
          updateFailure.table === table &&
          filterColumns.includes(updateFailure.filter)
        ) {
          return {
            data: null,
            error: {
              code: updateFailure.code ?? null,
              message: `doble: fallo inyectado en ${table} (filtro ${updateFailure.filter})`,
            },
          };
        }
        // PostgREST devuelve las filas que el UPDATE afectó, con el payload ya
        // aplicado: la aprobación del vale necesita esa fila de vuelta.
        const matched = rows().filter((row) => filters.every((matches) => matches(row)));
        // CL-8: la escritura que descuenta los vales FALLA. Acá no hay
        // transacción que revierta el ítem ya escrito: es exactamente la
        // ventana que CL-8 cierra.
        if (payrollPagedStub.failVoucherFlip && table === "voucher_requests") {
          return {
            data: null,
            error: { code: "P0001", message: payrollPagedStub.failVoucherFlip },
          };
        }
        // `.single()` sobre 0 filas es PGRST116 (el patrón del cliente
        // Supabase): la señal de que el compare-and-swap perdió la carrera.
        if (single && matched.length === 0) {
          return {
            data: null,
            error: {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
            },
          };
        }
        for (const row of matched) Object.assign(row, updatePayload ?? {});
        // CL-8: el descuento por el camino SUELTO (el `UPDATE` del servicio).
        // Queda registrado igual que el del RPC: si un test ve DOS descuentos
        // confirmados, el vale se consumió dos veces sin importar el camino.
        if (table === "voucher_requests" && updatePayload?.status === "descontada") {
          payrollPagedStub.voucherFlips.push(
            matched.map((row) => String(row.id)),
          );
        }
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op === "delete") {
        // CL-9: el `.delete()` del cliente (el DELETE suelto del camino viejo).
        // El doble borra DE VERDAD las filas que los filtros alcanzan, y
        // arrastra lo que la FK ON DELETE CASCADE de 007 arrastra. Si el test
        // pide el fallo SEMÁNTICO de esta escritura, contesta como la base.
        if (payrollPagedStub.failDeletePeriod && table === "payroll_periods") {
          return { data: null, error: { code: "P0001", message: payrollPagedStub.failDeletePeriod } };
        }
        const matched = rows().filter((row) => filters.every((matches) => matches(row)));
        payrollPagedStub.deletes.push({ table, count: matched.length });
        payrollPagedStub.tables[table] = rows().filter((row) => !filters.every((m) => m(row)));
        if (table === "payroll_periods") {
          const periods = new Set(matched.map((row) => String(row.id)));
          const itemIds = new Set(
            (payrollPagedStub.tables.payroll_items ?? [])
              .filter((row) => periods.has(String(row.period_id)))
              .map((row) => String(row.id)),
          );
          payrollPagedStub.tables.payroll_items = (payrollPagedStub.tables.payroll_items ?? []).filter(
            (row) => !periods.has(String(row.period_id)),
          );
          payrollPagedStub.tables.payroll_payments = (
            payrollPagedStub.tables.payroll_payments ?? []
          ).filter((row) => !itemIds.has(String(row.payroll_item_id)));
        }
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op !== "select") {
        // INSERT: PostgREST devuelve las filas insertadas y las deja en la
        // tabla (el upsert ya persistía: `getPeriodDetail` lee después esas
        // filas). Hacía falta acá para `openPayrollPeriod`, que necesita la
        // fila de vuelta; y para poder inyectar el fallo de la BASE.
        // CL-9: el fallo SEMÁNTICO de las filas de la corrección (el INSERT
        // suelto del camino viejo): la cabecera ya quedó firmada.
        if (payrollPagedStub.failCorrectionLines && table === "payroll_period_correction_items") {
          return { data: null, error: { code: "P0001", message: payrollPagedStub.failCorrectionLines } };
        }
        const failure = payrollPagedStub.insertError;
        if (failure && failure.table === table) {
          return {
            data: null,
            error: {
              code: failure.code ?? "P0001",
              message: failure.message ?? `doble: ${failure.code ?? "P0001"} inyectado en el INSERT de ${table}`,
            },
          };
        }
        const values = (Array.isArray(insertPayload) ? insertPayload : [insertPayload]) as Array<
          Record<string, unknown>
        >;
        // CL-16: el tope de `payroll_payments` (007, reescrito por 055) con su
        // lock de la fila padre. Un trigger `BEFORE INSERT` corre ANTES de los
        // índices únicos, así que el tope se evalúa primero (mismo orden que la
        // base). Sólo cuando el bloque lo enciende.
        if (payrollPagedStub.capEnabled && table === "payroll_payments") {
          const capFailure = applyPayrollPaymentsCap(values);
          if (capFailure) return capFailure;
        }
        // CL-2: los índices únicos de verdad. Postgres comprueba cada fila al
        // insertarla —así que verla repetida DENTRO del mismo statement de
        // varias filas también es un choque— y aborta todo: el doble no
        // persiste nada, igual que la sentencia que falla.
        for (const key of payrollPagedStub.uniqueKeys) {
          if (key.table !== table) continue;
          const nonNull = (row: Record<string, unknown>) =>
            key.columns.every((column) => row[column] !== null && row[column] !== undefined);
          const sameKey = (left: Record<string, unknown>, right: Record<string, unknown>) =>
            key.columns.every((column) => left[column] === right[column]);
          const clash = values.some((row, index) =>
            nonNull(row) &&
            [...rows(), ...values.slice(0, index)].some((other) => nonNull(other) && sameKey(other, row)),
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: "23505",
                message: `doble: índice único (${key.columns.join(", ")}) violado en ${table}`,
              },
            };
          }
        }
        const persisted = values.map((row) => ({
          id: `fila-insertada-${(payrollPagedStub.rowSeq += 1)}`,
          created_at: "2026-01-31T23:59:59.000Z",
          closed_at: null,
          ...row,
        }));
        // 072: `ON CONFLICT (clave) DO UPDATE` reemplaza la fila que ya tenía
        // esa clave en vez de dejar dos filas con el mismo ajuste.
        payrollPagedStub.tables[table] =
          op === "upsert" && upsertConflict !== null && !upsertConflict.includes(",")
            ? [
                ...rows().filter((row) => !values.some((value) => value[upsertConflict!] === row[upsertConflict!])),
                ...persisted,
              ]
            : [...rows(), ...persisted];
        if (table === "payroll_items" && op === "upsert") {
          payrollPagedStub.itemsUpsert = persisted;
          // CL-8: esta escritura quedó CONFIRMADA (camino suelto). Si el descuento
          // de los vales falla después, el ítem ya es un hecho.
          payrollPagedStub.itemWrites.push(persisted);
        }
        return { data: single ? persisted[0] ?? null : persisted, error: null };
      }
      const failOn = payrollPagedStub.failOn;
      if (failOn && failOn.table === table && filterColumns.includes(failOn.filter)) {
        return {
          data: null,
          error: {
            code: failOn.code ?? null,
            message: `doble: fallo inyectado en ${table} (filtro ${failOn.filter})`,
          },
        };
      }
      const index = (payrollPagedStub.requests[table] = (payrollPagedStub.requests[table] ?? 0) + 1);
      if ((payrollPagedStub.failAt[table] ?? []).includes(index)) {
        return { data: null, error: { message: `doble: fallo inyectado en ${table} (request ${index})` } };
      }
      // CL-2: la carrera del reintento. Cuando la consulta es la del lookup por
      // marca y el test pidió saltearla, el doble contesta "no hay nada" como
      // si la otra transacción todavía no hubiera confirmado. Se consume una
      // sola vez.
      if (filterColumns.includes("idempotency_key") && payrollPagedStub.skipMarkLookupOnce) {
        payrollPagedStub.skipMarkLookupOnce = false;
        return { data: single ? null : [], error: null };
      }
      const to = Math.min(rangeTo, rangeFrom + payrollPagedStub.rowCap - 1);
      payrollPagedStub.windows.push({ table, from: rangeFrom, to, order: orderKeys.map((key) => key.column) });
      const filtered = rows().filter((row) => filters.every((matches) => matches(row)));
      for (const key of [...orderKeys].reverse()) {
        filtered.sort((left, right) => {
          const leftValue = String(left[key.column] ?? "");
          const rightValue = String(right[key.column] ?? "");
          if (leftValue === rightValue) return 0;
          return (leftValue < rightValue ? -1 : 1) * (key.ascending ? 1 : -1);
        });
      }
      const window = filtered.slice(rangeFrom, to + 1);
      return { data: single ? window[0] ?? null : window, error: null };
    };

    const query: Record<string, unknown> = {
      select: () => query,
      insert: (payload?: unknown) => {
        op = "insert";
        insertPayload = payload;
        payrollPagedStub.inserts.push({ table, payload });
        return query;
      },
      update: (payload?: unknown) => {
        op = "update";
        updatePayload = (payload ?? {}) as Record<string, unknown>;
        payrollPagedStub.updates.push({ table, payload });
        return query;
      },
      upsert: (value?: unknown, options?: { onConflict?: string }) => {
        op = "upsert";
        // 072: el destino de conflicto del `ON CONFLICT`. Con UNA sola columna
        // el doble reemplaza la fila que ya tiene ese valor (es lo que hace el
        // upsert real); con una lista de columnas se deja el comportamiento de
        // siempre, que es el que el RPC de la 047 emula aparte.
        upsertConflict = options?.onConflict ?? null;
        // El upsert persiste de verdad: `getPeriodDetail` lee después estas
        // filas. La escritura la aplica el `INSERT` de `select()`, que es por
        // donde pasa todo upsert que devuelve fila (`… .upsert().select()`).
        insertPayload = value;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      eq: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) => row[column] === value);
        return query;
      },
      neq: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) => row[column] !== value);
        return query;
      },
      gte: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) => String(row[column] ?? "") >= String(value));
        return query;
      },
      lte: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) => String(row[column] ?? "") <= String(value));
        return query;
      },
      // `.is(col, null)` del cliente Supabase: la lectura de pendientes
      // (`applied_period_id IS NULL`). `null` matchea también la columna
      // ausente, que en el doble es lo mismo que la columna NULL.
      is: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) =>
          value === null
            ? row[column] === null || row[column] === undefined
            : row[column] === value,
        );
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        filterColumns.push(column);
        payrollPagedStub.inFilters.push({ table, column, count: values.length });
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return query;
      },
      match: (criteria: Record<string, unknown>) => {
        for (const [column, value] of Object.entries(criteria)) {
          filterColumns.push(column);
          filters.push((row) => row[column] === value);
        }
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
      single: () => Promise.resolve(select(true)),
      maybeSingle: () => Promise.resolve(select(true)),
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(select(false)).then(onFulfilled, onRejected),
    };
    return query;
  };

  /**
   * CL-8: `payroll_apply_atomic` (047). El doble emula UNA transacción del
   * servidor: el upsert de los ítems y el flip de los vales son UNA sola
   * escritura, así que toma las dos tablas ANTES de escribir y, si algo falla,
   * las restaura. La red de conteo también es del doble: si no marcó
   * EXACTAMENTE los vales que recibió —porque otro cálculo ya los descontó—,
   * aborta y no queda nada escrito.
   *
   * El `ON CONFLICT (period_id, employee_id)` sí se emula: una segunda corrida
   * del mismo período REEMPLAZA la fila del empleado, no la duplica (es lo que
   * hace el upsert real).
   *
   * El doble NO reimplementa las guardas de FORMA del SQL (jsonb válido, uuid
   * bien formado, columnas numéricas, `detail_json` arreglo): ésas viven en la
   * función y se prueban sobre el archivo. Lo que emula es lo que este test
   * necesita observar: la indivisibilidad y la red de conteo.
   */
  const rpc = async (
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> => {
    payrollPagedStub.rpcCalls.push({ name, args: args ?? {} });
    /**
     * CL-9: `payroll_delete_period_atomic` (048). El doble emula UNA
     * transacción del servidor: la reversión de los vales y el borrado del
     * período son UNA sola escritura, así que toma las tablas ANTES de escribir
     * (después de la carrera) y, si algo falla, las restaura.
     *
     * El doble NO reimplementa las guardas de FORMA del SQL: ésas viven en la
     * función y se prueban sobre el archivo. Lo que emula es lo que estos tests
     * necesitan observar: la precondición de estado del período, el guardia de
     * solapamiento dentro de la transacción, la red de conteo de la reversión y
     * la indivisibilidad.
     */
    if (name === "payroll_delete_period_atomic") {
      const toApproved = (args?.p_to_approved ?? []) as string[];
      const toPending = (args?.p_to_pending ?? []) as string[];
      const beforeWrite = payrollPagedStub.beforeRpc;
      if (beforeWrite) {
        payrollPagedStub.beforeRpc = null;
        beforeWrite.run();
      }
      const vouchers = payrollPagedStub.tables.voucher_requests ?? [];
      const voucherSnapshot = vouchers.map((row) => ({ row, status: row.status }));
      const periodSnapshot = [...(payrollPagedStub.tables.payroll_periods ?? [])];
      const itemSnapshot = [...(payrollPagedStub.tables.payroll_items ?? [])];
      const paymentSnapshot = [...(payrollPagedStub.tables.payroll_payments ?? [])];
      // PAY-01 (066): la deuda también entra en la foto. Se clona cada fila
      // porque el `SET NULL` de `applied_period_id` muta el objeto.
      const carrySnapshot = (payrollPagedStub.tables.payroll_discount_carries ?? []).map(
        (row) => ({ ...row }),
      );
      const rollback = (message: string) => {
        for (const entry of voucherSnapshot) entry.row.status = entry.status;
        payrollPagedStub.tables.payroll_periods = periodSnapshot;
        payrollPagedStub.tables.payroll_items = itemSnapshot;
        payrollPagedStub.tables.payroll_payments = paymentSnapshot;
        payrollPagedStub.tables.payroll_discount_carries = carrySnapshot;
        return { data: null, error: { code: "P0001", message } };
      };
      if (payrollPagedStub.failRpcWith) {
        return { data: null, error: { code: "P0001", message: payrollPagedStub.failRpcWith } };
      }
      const periods = payrollPagedStub.tables.payroll_periods ?? [];
      const period = periods.find((row) => row.id === args?.p_period_id) ?? null;
      // El período BLOQUEADO y su precondición de estado, dentro de la
      // transacción: un borrado concurrente (o un cierre) rechaza, no pisa.
      // La sede ya NO es un parámetro de la función (071): es la de la
      // instalación, así que el doble no la filtra.
      if (!period || period.status !== "borrador") {
        return rollback("PAYROLL_PERIOD_CONFLICT");
      }
      // El mismo guardia de solapamiento del servicio, re-evaluado acá: un
      // período CERRADO que solapa el rango impide el borrado.
      const overlapping = periods.some(
        (row) =>
          row.id !== period.id &&
          row.sede_id === period.sede_id &&
          row.status === "cerrado" &&
          String(row.start_date) <= String(period.end_date) &&
          String(row.end_date) >= String(period.start_date),
      );
      if (overlapping) return rollback("PERIOD_OVERLAP_AMBIGUOUS");
      // La reversión, con la precondición `status = descontada` y su red de
      // conteo: un vale que otro camino ya revirtió hace fallar el conteo.
      const expected = [...toApproved, ...toPending];
      const reverted: string[] = [];
      for (const id of expected) {
        const row = vouchers.find((entry) => entry.id === id);
        if (row && row.status === "descontada") {
          row.status = toApproved.includes(id) ? "aprobada" : "pendiente";
          reverted.push(id);
        }
      }
      if (reverted.length !== expected.length) return rollback("PAYROLL_VOUCHER_CONFLICT");
      // El BORRADO del período, con su propia precondición y el arrastre de las
      // FK ON DELETE CASCADE de 007 (ítems y, con ellos, sus pagos).
      if (payrollPagedStub.failDeletePeriod) {
        return rollback(payrollPagedStub.failDeletePeriod);
      }
      const gone = new Set([String(period.id)]);
      const itemIds = new Set(
        (payrollPagedStub.tables.payroll_items ?? [])
          .filter((row) => gone.has(String(row.period_id)))
          .map((row) => String(row.id)),
      );
      payrollPagedStub.tables.payroll_periods = periods.filter((row) => !gone.has(String(row.id)));
      payrollPagedStub.tables.payroll_items = (payrollPagedStub.tables.payroll_items ?? []).filter(
        (row) => !gone.has(String(row.period_id)),
      );
      payrollPagedStub.tables.payroll_payments = (
        payrollPagedStub.tables.payroll_payments ?? []
      ).filter((row) => !itemIds.has(String(row.payroll_item_id)));
      // PAY-01 (066): las FK de `payroll_discount_carries` al período ya tienen
      // `ON DELETE`: la deuda que el borrador PRODUJO (`origin_period_id`) cae
      // CON él (CASCADE), y la que CONSUMIÓ (`applied_period_id`) vuelve a
      // PENDIENTE (SET NULL), porque borrar los ítems deshace la absorción y el
      // período de ORIGEN sigue existiendo. Las dos mutaciones son parte de la
      // MISMA transacción que el borrado.
      payrollPagedStub.tables.payroll_discount_carries = (
        payrollPagedStub.tables.payroll_discount_carries ?? []
      )
        .filter((row) => !gone.has(String(row.origin_period_id)))
        .map((row) =>
          gone.has(String(row.applied_period_id)) ? { ...row, applied_period_id: null } : row,
        );
      payrollPagedStub.deletes.push({ table: "payroll_periods", count: 1 });
      return { data: reverted.length, error: null };
    }
    /**
     * CL-9: `payroll_correct_period_atomic` (048). Misma emulación: la cabecera
     * y las filas de la corrección son UNA sola escritura. Devuelve la fila
     * escrita (el SQL devuelve `to_jsonb` de la cabecera), que es lo que el
     * servicio usa como resultado.
     */
    if (name === "payroll_correct_period_atomic") {
      const headerPayload = (args?.p_correction ?? {}) as Record<string, unknown>;
      const lines = (args?.p_items ?? []) as Array<Record<string, unknown>>;
      const beforeWrite = payrollPagedStub.beforeRpc;
      if (beforeWrite) {
        payrollPagedStub.beforeRpc = null;
        beforeWrite.run();
      }
      const periodSnapshot = [...(payrollPagedStub.tables.payroll_periods ?? [])];
      const correctionSnapshot = [...(payrollPagedStub.tables.payroll_period_corrections ?? [])];
      const lineSnapshot = [...(payrollPagedStub.tables.payroll_period_correction_items ?? [])];
      const rollback = (message: string, code = "P0001") => {
        payrollPagedStub.tables.payroll_periods = periodSnapshot;
        payrollPagedStub.tables.payroll_period_corrections = correctionSnapshot;
        payrollPagedStub.tables.payroll_period_correction_items = lineSnapshot;
        return { data: null, error: { code, message } };
      };
      if (payrollPagedStub.failRpcWith) {
        return { data: null, error: { code: "P0001", message: payrollPagedStub.failRpcWith } };
      }
      const period =
        (payrollPagedStub.tables.payroll_periods ?? []).find(
          (row) => row.id === args?.p_period_id,
        ) ?? null;
      if (!period) {
        return rollback("PAYROLL_CORRECTION_CONFLICT");
      }
      if (period.status !== "cerrado") return rollback("PERIOD_NOT_CLOSED");
      // El índice único por período (037): la corrección de otro gana.
      if (
        (payrollPagedStub.tables.payroll_period_corrections ?? []).some(
          (row) => row.period_id === args?.p_period_id,
        )
      ) {
        return rollback("doble: índice único (period_id) violado en payroll_period_corrections", "23505");
      }
      const header = {
        id: `correccion-${(payrollPagedStub.rowSeq += 1)}`,
        corrected_at: "2026-09-07T23:59:00.000Z",
        ...headerPayload,
      };
      payrollPagedStub.tables.payroll_period_corrections = [
        ...(payrollPagedStub.tables.payroll_period_corrections ?? []),
        header,
      ];
      if (payrollPagedStub.failCorrectionLines) {
        return rollback(payrollPagedStub.failCorrectionLines);
      }
      payrollPagedStub.tables.payroll_period_correction_items = [
        ...(payrollPagedStub.tables.payroll_period_correction_items ?? []),
        ...lines.map((row) => ({
          id: `fila-insertada-${(payrollPagedStub.rowSeq += 1)}`,
          // La columna que el SQL resuelve con `v_cabecera.id`: el payload sólo
          // lleva los montos y el empleado.
          correction_id: header.id,
          ...row,
        })),
      ];
      // Las escrituras que la transacción CONFIRMÓ: el doble las registra como
      // los INSERT del camino viejo, así las pruebas que ya miraban `inserts`
      // siguen midiendo lo mismo (qué quedó escrito).
      payrollPagedStub.inserts.push({ table: "payroll_period_corrections", payload: headerPayload });
      payrollPagedStub.inserts.push({ table: "payroll_period_correction_items", payload: lines });
      return { data: header, error: null };
    }
    if (name !== "payroll_apply_atomic") {
      return { data: null, error: { message: `doble sin respuesta para el rpc ${name}` } };
    }
    const items = (args?.p_items ?? []) as Array<Record<string, unknown>>;
    const requested = (args?.p_voucher_ids ?? []) as string[];
    // U8/CL-8: la otra transacción escribe ANTES de que esta transacción evalúe
    // su precondición (la carrera real). Se dispara una sola vez, y ANTES de la
    // foto: lo que la otra transacción confirmó ya es parte del estado previo.
    const beforeWrite = payrollPagedStub.beforeUpdate;
    if (beforeWrite && beforeWrite.table === "voucher_requests") {
      payrollPagedStub.beforeUpdate = null;
      beforeWrite.run();
    }
    // La foto ANTES de escribir: es el rollback de la sentencia.
    const itemSnapshot = payrollPagedStub.tables.payroll_items ?? [];
    const vouchers = payrollPagedStub.tables.voucher_requests ?? [];
    const voucherSnapshot = vouchers.map((row) => ({ row, status: row.status }));
    // NV-01: la deuda (saliente y consumida) también entra en la foto: la
    // transacción del doble la revierte entera si algo falla. Se clona cada
    // fila porque el marcado muta `applied_period_id` en el objeto.
    const carrySnapshot = (payrollPagedStub.tables.payroll_discount_carries ?? []).map(
      (row) => ({ ...row }),
    );
    // El rechazo del servidor (guardas de forma y redes de conteo): no se
    // escribió nada, así que no hay nada que revertir.
    if (payrollPagedStub.failRpcWith) {
      return { data: null, error: { code: "P0001", message: payrollPagedStub.failRpcWith } };
    }
    const rollback = (message: string) => {
      payrollPagedStub.tables.payroll_items = itemSnapshot;
      payrollPagedStub.tables.payroll_discount_carries = carrySnapshot;
      for (const entry of voucherSnapshot) entry.row.status = entry.status;
      return { data: null, error: { code: "P0001", message } };
    };
    // 1. El FLIP, con la precondición de estado: sólo desde pendiente/aprobada.
    const flipped: string[] = [];
    for (const id of requested) {
      const row = vouchers.find((entry) => entry.id === id);
      if (row && (row.status === "pendiente" || row.status === "aprobada")) {
        row.status = "descontada";
        flipped.push(id);
      }
    }
    if (payrollPagedStub.failVoucherFlip) {
      return rollback(payrollPagedStub.failVoucherFlip);
    }
    // 1b. La red de conteo: no se marcaron EXACTAMENTE los vales recibidos (uno
    // ya estaba descontado por otro cálculo). Se aborta el par completo.
    if (flipped.length !== requested.length) {
      return rollback("PAYROLL_VOUCHER_CONFLICT");
    }
    // 2. El upsert de los ítems: ESCRIBE lo que recibió, sin recalcular nada.
    const persisted: Array<Record<string, unknown>> = items.map((row) => ({
      ...row,
      id: `item-nomina-${(payrollPagedStub.rowSeq += 1)}`,
      created_at: "2026-01-31T23:59:59.000Z",
    }));
    const overwritten = new Set(persisted.map((row) => `${row.period_id}|${row.employee_id}`));
    payrollPagedStub.tables.payroll_items = [
      ...itemSnapshot.filter((row) => !overwritten.has(`${row.period_id}|${row.employee_id}`)),
      ...persisted,
    ];
    if (persisted.length > 0) {
      payrollPagedStub.itemsUpsert = persisted;
      payrollPagedStub.itemWrites.push(persisted);
    }
    payrollPagedStub.voucherFlips.push(flipped);
    // 3. La DEUDA saliente (061, paso 1.6): por cada ítem con voucher_excess > 0
    //    se inserta UNA fila PENDIENTE con el período como origen, y sólo si no
    //    existe ya una deuda del mismo empleado originada en ese período
    //    (recalcular no duplica). NV-02: la guarda acota además por
    //    `origin_kind` —el default histórico es 'voucher_excess'— para no
    //    confundir este sobrante con el sobrante de la deuda (paso 3b).
    const carries = payrollPagedStub.tables.payroll_discount_carries ?? [];
    const periodRow = (payrollPagedStub.tables.payroll_periods ?? []).find(
      (row) => row.id === args?.p_period_id,
    );
    const carryKind = (carry: Record<string, unknown>) =>
      String(carry.origin_kind ?? "voucher_excess");
    const newCarries = items
      .filter((row) => Number(row.voucher_excess ?? 0) > 0)
      .filter(
        (row) =>
          !carries.some(
            (carry) =>
              carry.origin_period_id === args?.p_period_id &&
              carry.employee_id === row.employee_id &&
              carryKind(carry) === "voucher_excess",
          ),
      )
      .map((row) => ({
        id: `deuda-${(payrollPagedStub.rowSeq += 1)}`,
        sede_id: periodRow?.sede_id ?? null,
        employee_id: row.employee_id,
        amount: Number(row.voucher_excess),
        origin_period_id: args?.p_period_id,
        applied_period_id: null,
        origin_kind: "voucher_excess",
        created_at: "2026-01-31T23:59:59.000Z",
      }));
    // 3b. El SOBRANTE DE LA DEUDA (064, paso 1.8): el ítem trae
    //     `debt_remainder` (> 0) cuando el tope no alcanzó a absorber toda la
    //     deuda entrante. Se re-registra como una fila PENDIENTE NUEVA con este
    //     período como origen y `origin_kind = 'carry_remainder'`, con la misma
    //     guarda anti-duplicado que 3 pero por su propio tipo.
    const newRemainders = items
      .filter((row) => Number(row.debt_remainder ?? 0) > 0)
      .filter(
        (row) =>
          !carries.some(
            (carry) =>
              carry.origin_period_id === args?.p_period_id &&
              carry.employee_id === row.employee_id &&
              carryKind(carry) === "carry_remainder",
          ),
      )
      .map((row) => ({
        id: `sobrante-deuda-${(payrollPagedStub.rowSeq += 1)}`,
        sede_id: periodRow?.sede_id ?? null,
        employee_id: row.employee_id,
        amount: Number(row.debt_remainder),
        origin_period_id: args?.p_period_id,
        applied_period_id: null,
        origin_kind: "carry_remainder",
        created_at: "2026-01-31T23:59:59.000Z",
      }));
    payrollPagedStub.tables.payroll_discount_carries = [
      ...carries,
      ...newCarries,
      ...newRemainders,
    ];
    // 4. La DEUDA consumida (062, paso 1.7): marca aplicadas las deudas
    //    recibidas que sigan pendientes. Una ya consumida queda igual: el
    //    replay es un no-op.
    const consumed = (args?.p_carry_ids ?? []) as string[];
    for (const id of consumed) {
      const carry = payrollPagedStub.tables.payroll_discount_carries.find(
        (row) => row.id === id,
      );
      if (carry && (carry.applied_period_id === null || carry.applied_period_id === undefined)) {
        carry.applied_period_id = args?.p_period_id;
      }
    }
    return { data: persisted.length, error: null };
  };

  return { from, rpc };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createPayrollPagedStubClient(),
}));

/**
 * Estado limpio del doble: cada bloque arma sus datos desde cero. (El bloque de
 * U5 conserva el suyo tal cual: no se toca una prueba existente.)
 */
function resetPayrollStubState(): void {
  payrollPagedStub.tables = {};
  payrollPagedStub.capEnabled = false;
  payrollPagedStub.capRace = null;
  payrollPagedStub.capChecks.length = 0;
  payrollPagedStub.failAt = {};
  payrollPagedStub.requests = {};
  payrollPagedStub.windows.length = 0;
  payrollPagedStub.itemsUpsert = null;
  payrollPagedStub.inFilters.length = 0;
  payrollPagedStub.failOn = null;
  payrollPagedStub.beforeUpdate = null;
  payrollPagedStub.session = {
    userId: "u-empleado-55",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["empleado"],
  };
  payrollPagedStub.inserts.length = 0;
  payrollPagedStub.rowSeq = 0;
  payrollPagedStub.insertError = null;
  payrollPagedStub.updates.length = 0;
  payrollPagedStub.uniqueKeys.length = 0;
  payrollPagedStub.skipMarkLookupOnce = false;
  payrollPagedStub.failVoucherFlip = null;
  payrollPagedStub.failRpcWith = null;
  payrollPagedStub.itemWrites.length = 0;
  payrollPagedStub.voucherFlips.length = 0;
  payrollPagedStub.rpcCalls.length = 0;
  payrollPagedStub.failDeletePeriod = null;
  payrollPagedStub.failCorrectionLines = null;
  payrollPagedStub.beforeRpc = null;
  payrollPagedStub.deletes.length = 0;
  payrollPagedStub.sequenceChecks.length = 0;
  payrollPagedStub.sequenceLockOverride = null;
}

// Los catálogos de admin/cash son `unstable_cache` (caché de Next). Fuera de un
// request de Next no hay caché incremental: se usa la función tal cual, así la
// lectura corre de verdad contra el doble de PostgREST que arma cada test.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
}));

// Las actions de nómina leen la cookie de sesión; acá la sesión la resuelve el
// `requireSession` simulado del mock de admin/service (ver abajo).
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "token-de-prueba" }) }),
}));

vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  const employee: Awaited<ReturnType<typeof actual.listEmployees>>[number] = {
    id: payrollPagedStub.EMPLOYEE_ID,
    sede_id: payrollPagedStub.SEDE_ID,
    user_id: null,
    full_name: "Empleada de prueba",
    employee_code: null,
    document: "1000000001",
    phone: null,
    position: null,
    payout_mode: "normal",
    email: null,
    birth_date: null,
    pay_type: "porcentaje",
    // F3: el legajo sin cadencia es el estado heredado (el fijo se prorratea
    // por días). Se declara para que el tipo pueda apretarse después sin
    // cambiar esta prueba.
    pay_frequency: null,
    salary_fixed: null,
    commission_percent: 10,
    is_active: true,
  };
  // La planta: cuando el test SIEMBRA la tabla `employees` la lectura corre de
  // verdad (con el tope del listado y todo, que es justo lo que hay que probar);
  // si no, el fixture de un empleado que usan las pruebas de U5.
  return {
    ...actual,
    requireSession: async () => payrollPagedStub.session,
    listEmployees: async (limit?: number) =>
      payrollPagedStub.tables.employees
        ? actual.listEmployees(limit)
        : ([employee] as Awaited<ReturnType<typeof actual.listEmployees>>),
    listAllEmployees: async () =>
      payrollPagedStub.tables.employees
        ? actual.listAllEmployees()
        : ([employee] as Awaited<ReturnType<typeof actual.listEmployees>>),
  };
});

describe("payroll: el cálculo lee todas las filas (U5)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Facturas de una sede en el rango: más que el tope por request (1000). */
  const INVOICE_COUNT = 1200;
  /** Cada línea vale 10.000 y el empleado comisiona el 10% => 1.000 por línea. */
  const LINE_SUBTOTAL = 10000;
  const COMMISSION_PER_LINE = 1000;

  function seedCalculation(invoiceCount: number) {
    const invoices: Array<Record<string, unknown>> = [];
    const items: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= invoiceCount; index += 1) {
      const suffix = String(index).padStart(5, "0");
      invoices.push({
        id: `factura-${suffix}`,
        consecutive_number: index,
        sede_id: payrollPagedStub.SEDE_ID,
        // Pagada: solo las facturas pagadas comisionan (regla del dueño).
        status: "Pagada",
        // Dentro del rango del período: el filtro `created_at` de la lectura es real.
        created_at: "2026-01-15T12:00:00.000Z",
      });
      items.push({
        id: `linea-${suffix}`,
        invoice_id: `factura-${suffix}`,
        item_type: "servicio",
        employee_id: payrollPagedStub.EMPLOYEE_ID,
        qty: 1,
        unit_price: LINE_SUBTOTAL,
        subtotal: LINE_SUBTOTAL,
        no_commission: false,
        commission_value: null,
        commission_percent_override: null,
        product_id: null,
        service_id: payrollPagedStub.SERVICE_ID,
      });
    }
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: "u-1",
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      invoices,
      invoice_items: items,
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
    return { invoices, items };
  }

  beforeEach(() => {
    payrollPagedStub.tables = {};
    payrollPagedStub.failAt = {};
    payrollPagedStub.requests = {};
    payrollPagedStub.windows.length = 0;
    payrollPagedStub.itemsUpsert = null;
  });

  it("una sede con más facturas que el tope por request no pierde comisiones", async () => {
    const seed = seedCalculation(INVOICE_COUNT);
    // Non-vacuidad del fixture: hay más facturas que el tope por request.
    expect(seed.items).toHaveLength(INVOICE_COUNT);
    expect(INVOICE_COUNT).toBeGreaterThan(payrollPagedStub.rowCap);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    // Las 1200 líneas, en pesos enteros: 1200 × 1.000 = 1.200.000.
    expect(persisted[0].commissions).toBe(INVOICE_COUNT * COMMISSION_PER_LINE);
    expect(persisted[0].detail_json).toHaveLength(INVOICE_COUNT);
    expect(persisted[0].net_pay).toBe(INVOICE_COUNT * COMMISSION_PER_LINE);
  });

  it("control negativo: una sede por debajo del tope se lee igual", async () => {
    // El caso chico no cambia en nada: una sola lectura por tabla y las mismas
    // comisiones (si la paginación duplicara o perdiera filas, esto lo delata).
    const seed = seedCalculation(50);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    expect(seed.invoices).toHaveLength(50);
    expect(payrollPagedStub.itemsUpsert?.[0].commissions).toBe(50 * COMMISSION_PER_LINE);
    expect(payrollPagedStub.itemsUpsert?.[0].detail_json).toHaveLength(50);
    expect(payrollPagedStub.windows.filter((window) => window.table === "invoices")).toEqual([
      { table: "invoices", from: 0, to: 999, order: ["id"] },
    ]);
  });

  it("pide el conjunto completo, en páginas y con orden explícito", async () => {
    seedCalculation(INVOICE_COUNT);
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const invoiceWindows = payrollPagedStub.windows.filter((window) => window.table === "invoices");
    expect(invoiceWindows.length).toBeGreaterThan(1);
    expect(invoiceWindows[0]).toEqual({ table: "invoices", from: 0, to: 999, order: ["id"] });
    expect(invoiceWindows.some((window) => window.from > 0)).toBe(true);
    // Requisito 2: cada lectura que alimenta una decisión va ordenada. Sin
    // `order()` dos páginas pueden pisarse o repetir filas sin que se note.
    for (const table of [
      "invoices",
      "invoice_items",
      "commission_rules",
      "voucher_requests",
      "commission_payouts",
    ]) {
      const windows = payrollPagedStub.windows.filter((window) => window.table === table);
      expect(windows.length, `sin lectura de ${table}`).toBeGreaterThan(0);
      for (const window of windows) expect(window.order, table).toEqual(["id"]);
    }
  });

  it("si una página falla, el cálculo se detiene a la vista (no liquida con menos)", async () => {
    seedCalculation(INVOICE_COUNT);
    payrollPagedStub.failAt = { invoices: [2] };

    const failure: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
    // Control de vacuidad: no se persistió NADA (ni una nómina recortada).
    expect(payrollPagedStub.itemsUpsert).toBeNull();
  });
});

// ------------------------------------------- F3: cadencia y regla del mixto ---

describe("payroll: la cadencia decide el fijo y el mixto cobra el mayor (F3)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };

  interface SeedEmployee {
    pay_type: string;
    pay_frequency: string | null;
    salary_fixed: number | null;
    commission_percent: number | null;
  }
  interface SeedLine {
    employeeIndex?: number;
    item_type: string;
    subtotal: number;
    commission_value?: number | null;
  }

  /** Siembra el período, la planta y las facturas Pagada del rango. */
  function seed(args: {
    periodFrequency: string | null;
    startDate?: string;
    endDate?: string;
    employees: SeedEmployee[];
    lines?: SeedLine[];
  }) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: args.startDate ?? "2026-01-01",
          end_date: args.endDate ?? "2026-01-31",
          frequency: args.periodFrequency,
          status: "borrador",
          created_by: "u-1",
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      employees: args.employees.map((employee, index) => ({
        id: `empleado-${index + 1}`,
        sede_id: payrollPagedStub.SEDE_ID,
        user_id: null,
        full_name: `Empleado ${index + 1}`,
        employee_code: null,
        document: String(10_000_000 + index),
        phone: null,
        position: null,
        payout_mode: "nomina",
        email: null,
        birth_date: null,
        pay_type: employee.pay_type,
        pay_frequency: employee.pay_frequency,
        salary_fixed: employee.salary_fixed,
        commission_percent: employee.commission_percent,
        is_active: true,
      })),
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
    const invoices: Array<Record<string, unknown>> = [];
    const items: Array<Record<string, unknown>> = [];
    for (const [index, line] of (args.lines ?? []).entries()) {
      const suffix = String(index + 1).padStart(3, "0");
      invoices.push({
        id: `factura-${suffix}`,
        consecutive_number: index + 1,
        sede_id: payrollPagedStub.SEDE_ID,
        status: "Pagada",
        created_at: "2026-01-05T12:00:00.000Z",
      });
      items.push({
        id: `linea-${suffix}`,
        invoice_id: `factura-${suffix}`,
        item_type: line.item_type,
        employee_id: `empleado-${(line.employeeIndex ?? 0) + 1}`,
        qty: 1,
        unit_price: line.subtotal,
        subtotal: line.subtotal,
        no_commission: false,
        commission_value: line.commission_value ?? null,
        commission_percent_override: null,
        product_id: line.item_type === "producto" ? "producto-1" : null,
        service_id: line.item_type === "servicio" ? payrollPagedStub.SERVICE_ID : null,
      });
    }
    payrollPagedStub.tables.invoices = invoices;
    payrollPagedStub.tables.invoice_items = items;
  }

  function itemFor(employeeId: string): Record<string, unknown> {
    const item = (payrollPagedStub.itemsUpsert ?? []).find((row) => row.employee_id === employeeId);
    expect(item, `sin ítem para ${employeeId}`).toBeDefined();
    return item as Record<string, unknown>;
  }

  function detailLinesOf(item: Record<string, unknown>): Array<{ item_type: string; commission: number }> {
    return (item.detail_json ?? []) as Array<{ item_type: string; commission: number }>;
  }

  function detailSum(item: Record<string, unknown>): number {
    return detailLinesOf(item).reduce((acc, line) => acc + Number(line.commission), 0);
  }

  /** La identidad del CHECK de `payroll_items`, en cada caso. */
  function expectIdentity(item: Record<string, unknown>) {
    expect(Number(item.net_pay)).toBe(
      Number(item.base_fixed) +
        Number(item.commissions) +
        Number(item.bonuses) -
        Number(item.deductions_vales) -
        Number(item.other_discounts),
    );
  }

  beforeEach(() => {
    resetPayrollStubState();
    payrollPagedStub.session = { userId: "u-1", sedeId: payrollPagedStub.SEDE_ID, roles: ["admin"] };
  });

  it("semanal que coincide: el fijo es mensual/4, no el prorrateo de los días", async () => {
    seed({
      periodFrequency: "semanal",
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      employees: [
        { pay_type: "fijo", pay_frequency: "semanal", salary_fixed: 1_500_000, commission_percent: null },
      ],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    expect(item.base_fixed).toBe(375_000);
    expect(item.commissions).toBe(0);
    expect(item.net_pay).toBe(375_000);
    // El prorrateo de esos 7 días de enero daría 338.710: la cadencia manda.
    expect(item.base_fixed).not.toBe(
      prorateFixedSalary({ salaryFixed: 1_500_000, startDate: "2026-01-01", endDate: "2026-01-07" }),
    );
    expectIdentity(item);
  });

  it("quincenal y mensual que coinciden: la mitad y el mes completo", async () => {
    seed({
      periodFrequency: "quincenal",
      employees: [
        { pay_type: "fijo", pay_frequency: "quincenal", salary_fixed: 1_500_000, commission_percent: null },
      ],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    expect(itemFor("empleado-1").base_fixed).toBe(750_000);

    seed({
      periodFrequency: "mensual",
      employees: [
        { pay_type: "fijo", pay_frequency: "mensual", salary_fixed: 1_500_000, commission_percent: null },
      ],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    expect(itemFor("empleado-1").base_fixed).toBe(1_500_000);
    expectIdentity(itemFor("empleado-1"));
  });

  it("cadencia DISTINTA: el empleado queda FUERA del período, sin ítem (F4)", async () => {
    seed({
      periodFrequency: "semanal",
      employees: [
        { pay_type: "fijo", pay_frequency: "mensual", salary_fixed: 1_500_000, commission_percent: null },
      ],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    // F4: antes F3 le escribía un ítem en 0 fijo. Ahora la exclusión ocurre al
    // armar el conjunto de empleados, así que NO hay fila: nada aguas abajo
    // (ítems, totales, resúmenes) ve al excluido.
    expect(payrollPagedStub.itemsUpsert).toBeNull();
    // Sin ítems, sin vales y sin deudas no se abre transacción: el período no
    // se tocó.
    expect(payrollPagedStub.rpcCalls).toHaveLength(0);
  });

  it("cadencia distinta: tampoco se le liquidan comisiones (facturas fuera de la ventana) (F4)", async () => {
    seed({
      periodFrequency: "semanal",
      employees: [
        { pay_type: "mixto", pay_frequency: "mensual", salary_fixed: 1_200_000, commission_percent: 10 },
      ],
      // Factura Pagada DENTRO del rango del período y del empleado excluido.
      lines: [{ item_type: "servicio", subtotal: 4_000_000 }],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    // La comisión de 400.000 NO aparece en ninguna parte: no hay ítem que la
    // lleve y no hay `detail_json` con la factura. Es lo que evita liquidar dos
    // veces la misma factura cuando el semanal y el mensual se superponen.
    expect(payrollPagedStub.itemsUpsert).toBeNull();
    expect(payrollPagedStub.itemWrites).toEqual([]);
    expect(payrollPagedStub.rpcCalls).toHaveLength(0);
  });

  it("cadencia indefinida en el legajo: conserva el prorrateo por días Y las comisiones (F4)", async () => {
    seed({
      periodFrequency: "semanal",
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      employees: [
        { pay_type: "mixto", pay_frequency: null, salary_fixed: 1_200_000, commission_percent: 10 },
      ],
      lines: [{ item_type: "servicio", subtotal: 4_000_000 }],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    // Falta la cadencia del empleado: rige el comportamiento de HOY, exacto.
    expect(item.base_fixed).toBe(
      prorateFixedSalary({ salaryFixed: 1_200_000, startDate: "2026-01-01", endDate: "2026-01-07" }),
    );
    expect(item.base_fixed).not.toBe(300_000); // no la fracción mensual/4
    expect(item.commissions).toBe(400_000); // 10% de 4.000.000, como hoy
    expect(item.net_pay).toBe(Math.round(item.base_fixed as number) + 400_000);
    expect(detailSum(item)).toBe(400_000);
    expectIdentity(item);
  });

  it("sin cadencia en el período ni en el legajo rige el prorrateo por días de hoy", async () => {
    seed({
      periodFrequency: null,
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      employees: [{ pay_type: "fijo", pay_frequency: null, salary_fixed: 1_500_000, commission_percent: null }],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    expect(item.base_fixed).toBe(
      prorateFixedSalary({ salaryFixed: 1_500_000, startDate: "2026-01-01", endDate: "2026-01-07" }),
    );
    expect(item.base_fixed).toBe(338_710);
    expect(item.base_fixed).not.toBe(375_000);
    expectIdentity(item);
  });

  it("mixto: básico 300.000 con 400.000 de porcentajes paga 400.000", async () => {
    seed({
      periodFrequency: "semanal",
      employees: [
        { pay_type: "mixto", pay_frequency: "semanal", salary_fixed: 1_200_000, commission_percent: 10 },
      ],
      lines: [{ item_type: "servicio", subtotal: 4_000_000 }],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    // 1.200.000 / 4 = 300.000 de básico del período; 10% de 4.000.000 = 400.000.
    expect(item.base_fixed).toBe(300_000);
    expect(item.commissions).toBe(100_000); // 400.000 − 300.000
    expect(item.net_pay).toBe(400_000); // el mayor
    expect(detailSum(item)).toBe(100_000); // el detalle reproduce commissions
    expectIdentity(item);
  });

  it("mixto: básico 300.000 con 200.000 paga 300.000 y muestra el absorbido", async () => {
    seed({
      periodFrequency: "semanal",
      employees: [
        { pay_type: "mixto", pay_frequency: "semanal", salary_fixed: 1_200_000, commission_percent: 10 },
      ],
      lines: [{ item_type: "servicio", subtotal: 2_000_000 }],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    expect(item.base_fixed).toBe(300_000);
    expect(item.commissions).toBe(0); // los porcentajes se absorben
    expect(item.net_pay).toBe(300_000);
    // El absorbido queda VISIBLE como una línea negativa: no desaparece.
    const absorbed = detailLinesOf(item).filter((line) => line.item_type === MIXED_ABSORBED_ITEM_TYPE);
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0].commission).toBe(-200_000);
    expect(detailSum(item)).toBe(0);
    expectIdentity(item);
  });

  it("mixto: porcentajes sobre el básico y comisiones fijas por producto se pagan las dos", async () => {
    seed({
      periodFrequency: "semanal",
      employees: [
        { pay_type: "mixto", pay_frequency: "semanal", salary_fixed: 1_200_000, commission_percent: 10 },
      ],
      lines: [
        { item_type: "servicio", subtotal: 4_000_000 }, // 10% → 400.000
        { item_type: "producto", subtotal: 500_000, commission_value: 50_000 }, // fija
      ],
    });
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);
    const item = itemFor("empleado-1");
    // El mayor (400.000) + la comisión fija del producto (50.000).
    expect(item.base_fixed).toBe(300_000);
    expect(item.commissions).toBe(150_000); // 50.000 fijas + 100.000 del exceso
    expect(item.net_pay).toBe(450_000);
    expect(detailSum(item)).toBe(150_000);
    const absorbed = detailLinesOf(item).filter((line) => line.item_type === MIXED_ABSORBED_ITEM_TYPE);
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0].commission).toBe(-300_000);
    expectIdentity(item);
  });
});

// --- El límite del candado de nómina cerrada: qué NO se puede ver (U5) -------

describe("payroll: el detalle que alimenta el candado de nómina cerrada (U5)", () => {
  /**
   * Evidencia del límite conocido de `invoiceInClosedPayroll` (billing): el
   * candado reconoce la factura por una línea de `detail_json`, y ese detalle
   * SOLO escribe las líneas con base de comisión. Acá están las formas de que
   * una línea no entre: sin base (empleado fijo sin regla ni valor de ítem) y
   * empleado con `payout_mode = "no_aplica"`.
   */
  const LINE: PayrollCommissionLine = {
    invoice_id: "33333333-3333-4333-8333-333333333333",
    consecutive_number: 7,
    item_id: "item-1",
    item_type: "servicio",
    qty: 1,
    unit_price: 50000,
    line_subtotal: 50000,
    commission_value: null,
    item_ref_id: null,
  };

  it("un empleado fijo sin regla ni valor de ítem no deja línea en el detalle", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payType: "fijo",
      commissionPercent: null,
      lines: [LINE],
      rules: new Map(),
    });
    // Sin línea no hay comisión liquidada por esa factura: para el candado la
    // factura es invisible (y no había plata pagada que proteger).
    expect(detail).toEqual([]);
  });

  it("con la misma línea, un empleado porcentual SÍ deja la línea (control)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [LINE],
      rules: new Map(),
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].invoice_id).toBe(LINE.invoice_id);
    expect(detail[0].commission).toBe(5000);
  });

  it("payout_mode = no_aplica deja el detalle vacío aunque haya base", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: "emp-1",
      payType: "porcentaje",
      payoutMode: "no_aplica",
      commissionPercent: 10,
      lines: [LINE],
      rules: new Map(),
    });
    expect(detail).toEqual([]);
  });
});

// --- El helper compartido por los dos sitios de U5 --------------------------

describe("paged: la lectura exhaustiva no recorta en silencio (U5)", () => {
  /** Servidor falso: filas totales y techo por request, con ventanas reales. */
  function server(total: number, rowCap = 1000, failAt: number | null = null) {
    const windows: Array<{ from: number; to: number }> = [];
    let request = 0;
    return {
      windows,
      fetchPage: (from: number, to: number) => {
        request += 1;
        if (request === failAt) {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        const capped = Math.min(to, from + rowCap - 1);
        windows.push({ from, to: capped });
        const rows = Array.from({ length: Math.max(0, Math.min(total, capped + 1) - from) }, (_, index) => from + index);
        return Promise.resolve({ data: rows, error: null });
      },
    };
  }

  it("pagina hasta agotar el conjunto, con ventanas sucesivas", async () => {
    const fake = server(2500);
    const rows = await readAllPaged<number>({ table: "x", fetchPage: fake.fetchPage });

    expect(rows).toHaveLength(2500);
    // Sin duplicados ni huecos: el conjunto completo, en orden de lectura.
    expect(rows[0]).toBe(0);
    expect(rows[rows.length - 1]).toBe(2499);
    expect(new Set(rows).size).toBe(2500);
    expect(fake.windows).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
  });

  it("un conjunto más chico que la página se lee en un solo request", async () => {
    const fake = server(3);
    const rows = await readAllPaged<number>({ table: "x", fetchPage: fake.fetchPage });
    expect(rows).toEqual([0, 1, 2]);
    expect(fake.windows).toEqual([{ from: 0, to: 999 }]);
  });

  it("un error de página LANZA y no devuelve lo que alcanzó a leer", async () => {
    const fake = server(2500, 1000, 2);
    const failure: unknown = await readAllPaged<number>({ table: "x", fetchPage: fake.fetchPage }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PagedReadError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE", table: "x", requestedFrom: 1000 });
  });

  it("el techo de seguridad LANZA: no es una lista recortada", async () => {
    const fake = server(50_000);
    const failure: unknown = await readAllPaged<number>({
      table: "x",
      maxRows: 2000,
      fetchPage: fake.fetchPage,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PagedReadError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
  });

  it("los ids se parten en lotes del tamaño que aguanta la URL", () => {
    expect(chunkIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(chunkIds([], 2)).toEqual([]);
    expect(chunkIds(Array.from({ length: 250 }, (_, index) => String(index)))).toHaveLength(3);
  });
});

// ---- U7: los sitios de plata que quedaban con lectura recortada -------------
//
// La auditoría que produjo U5 encontró cuatro sitios más de la misma familia:
//
//   1. `calculatePayroll` armaba su alineación con `listEmployees(sedeId, 500)`.
//      El tope no es de la nómina: es `clampLimit(limit, 50, 500)` del listado de
//      admin, así que el empleado 501 de una sede NO se liquidaba —ausente, sin
//      un solo error—. Acá se siembra la planta REAL contra el doble de PostgREST
//      (con el tope del listado puesto) para poder medirlo.
//   2. `loadCommissionRulesByEmployee` (billing) leía con `.limit(5000)`, que el
//      `max-rows` del Data API baja a 1000: la pantalla de la factura mostraba el
//      porcentaje plano donde la nómina —que sí lee todo— paga la regla.
//   3. `getPeriodDetail` leía los ítems sin tope explícito (→ 1000) y los pagos
//      con un `in(...)` sin tope ni lotes: el `paid`/`remaining` del período se
//      mostraba corto (plata ya pagada que parece debida).
//   4. `approveVoucher` envolvía el chequeo de topes en un `catch {}` que dejaba
//      `over_tope: false`: la auditoría afirmaba "no superó topes" cuando el
//      chequeo NO SE PUDO EVALUAR.

describe("payroll: la alineación de la planta se lee completa (U7)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  /** El techo del listado de admin: `clampLimit(limit, 50, 500)`. */
  const LIST_CAP = 500;
  /** Cada línea vale 10.000 y el empleado comisiona el 10% => 1.000. */
  const LINE_SUBTOTAL = 10000;
  const COMMISSION_PER_EMPLOYEE = 1000;

  function employeeRow(index: number): Record<string, unknown> {
    const suffix = String(index).padStart(5, "0");
    return {
      id: `empleado-${suffix}`,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: `Empleado ${suffix}`,
      employee_code: `E-${suffix}`,
      document: `1000${suffix}`,
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "porcentaje",
      salary_fixed: null,
      commission_percent: 10,
      is_active: true,
    };
  }

  /** Planta de la sede: un empleado activo y UNA línea comisionable cada uno. */
  function seedPlant(count: number) {
    const employees: Array<Record<string, unknown>> = [];
    const invoices: Array<Record<string, unknown>> = [];
    const items: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= count; index += 1) {
      const suffix = String(index).padStart(5, "0");
      employees.push(employeeRow(index));
      invoices.push({
        id: `factura-${suffix}`,
        consecutive_number: index,
        sede_id: payrollPagedStub.SEDE_ID,
        // Pagada: solo las facturas pagadas comisionan (regla del dueño).
        status: "Pagada",
        created_at: "2026-01-15T12:00:00.000Z",
      });
      items.push({
        id: `linea-${suffix}`,
        invoice_id: `factura-${suffix}`,
        item_type: "servicio",
        employee_id: `empleado-${suffix}`,
        qty: 1,
        unit_price: LINE_SUBTOTAL,
        subtotal: LINE_SUBTOTAL,
        no_commission: false,
        commission_value: null,
        commission_percent_override: null,
        product_id: null,
        service_id: payrollPagedStub.SERVICE_ID,
      });
    }
    payrollPagedStub.tables = {
      employees,
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: "u-1",
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      invoices,
      invoice_items: items,
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
    return { employees, items };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("una sede con más empleados que el tope del listado liquida a TODOS", async () => {
    const PLANT = 1200;
    const seed = seedPlant(PLANT);
    // Non-vacuidad del fixture: supera el tope del listado (500) y el de
    // transporte del Data API (1000), que es lo que hay que cruzar.
    expect(seed.employees).toHaveLength(PLANT);
    expect(PLANT).toBeGreaterThan(LIST_CAP);
    expect(PLANT).toBeGreaterThan(payrollPagedStub.rowCap);

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    // Los 1200, cada uno con su comisión: 1200 × 1.000 = 1.200.000.
    expect(persisted).toHaveLength(PLANT);
    expect(persisted.map((row) => row.employee_id)).toContain("empleado-01200");
    expect(persisted.every((row) => row.commissions === COMMISSION_PER_EMPLOYEE)).toBe(true);
    expect(persisted.reduce((acc, row) => acc + Number(row.net_pay), 0)).toBe(
      PLANT * COMMISSION_PER_EMPLOYEE,
    );
  });

  it("la planta se pide entera y en orden (sin el tope de 500)", async () => {
    seedPlant(1200);
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    const employeeWindows = payrollPagedStub.windows.filter((window) => window.table === "employees");
    // Más de una página: la ventana pedida es la del Data API (1000), no 500.
    expect(employeeWindows.length).toBeGreaterThan(1);
    expect(employeeWindows[0]).toEqual({
      table: "employees",
      from: 0,
      to: 999,
      order: ["full_name", "id"],
    });
    expect(employeeWindows.some((window) => window.from > 0)).toBe(true);
    // Requisito 2: orden determinista. Sin desempate, dos empleados homónimos
    // pueden caer en páginas distintas y repetirse o perderse.
    for (const window of employeeWindows) expect(window.order).toEqual(["full_name", "id"]);
  });

  it("control negativo: una sede chica se lee igual (mismos montos, sin duplicados)", async () => {
    const seed = seedPlant(3);
    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    );

    expect(seed.items).toHaveLength(3);
    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(3);
    // Ni duplicados ni faltantes: una fila por empleado, con su monto.
    expect(new Set(persisted.map((row) => row.employee_id)).size).toBe(3);
    expect(persisted.reduce((acc, row) => acc + Number(row.net_pay), 0)).toBe(3 * COMMISSION_PER_EMPLOYEE);
    expect(detail.items).toHaveLength(3);
    // Una sola lectura de la planta (el conjunto entra en la primera página).
    expect(payrollPagedStub.windows.filter((window) => window.table === "employees")).toEqual([
      { table: "employees", from: 0, to: 999, order: ["full_name", "id"] },
    ]);
  });

  it("si la planta no se puede leer entera, el cálculo se detiene a la vista", async () => {
    seedPlant(1200);
    // Falla la SEGUNDA página de la planta: la lectura no se completa.
    payrollPagedStub.failAt = { employees: [2] };

    const failure: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
    // Control de vacuidad: no se liquidó una nómina con la planta recortada.
    expect(payrollPagedStub.itemsUpsert).toBeNull();
  });
});

describe("payroll: el detalle del período muestra TODO lo pagado (U7)", () => {
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const NET_PER_ITEM = 1000;
  const PAID_PER_ITEM = 1000;

  function seedPeriod(itemCount: number, paidPerItem: number) {
    const items: Array<Record<string, unknown>> = [];
    const payments: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= itemCount; index += 1) {
      const suffix = String(index).padStart(5, "0");
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      items.push({
        id: `item-${suffix}`,
        period_id: PERIOD_ID,
        employee_id: `empleado-${suffix}`,
        base_fixed: 0,
        commissions: NET_PER_ITEM,
        bonuses: 0,
        deductions_vales: 0,
        other_discounts: 0,
        net_pay: NET_PER_ITEM,
        detail_json: [],
        created_at: `2026-01-15T12:${minute}:${second}.000Z`,
      });
      if (paidPerItem > 0) {
        payments.push({
          id: `pago-${suffix}`,
          payroll_item_id: `item-${suffix}`,
          method_code: "efectivo",
          amount: paidPerItem,
          paid_at: `2026-01-15T13:${minute}:${second}.000Z`,
        });
      }
    }
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "cerrado",
          created_by: "u-1",
          closed_at: "2026-02-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      payroll_items: items,
      payroll_payments: payments,
    };
    return { items, payments };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("un período con más ítems que el tope por request muestra los pagos reales", async () => {
    const ITEMS = 1200;
    const seed = seedPeriod(ITEMS, PAID_PER_ITEM);
    expect(seed.items).toHaveLength(ITEMS);
    expect(ITEMS).toBeGreaterThan(payrollPagedStub.rowCap);

    const detail = await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);

    // Ni una línea de menos: el período se muestra completo.
    expect(detail.items).toHaveLength(ITEMS);
    // El pagado mostrado es el REAL: 1200 × 1.000 = 1.200.000, y no queda saldo.
    expect(detail.items.reduce((acc, item) => acc + item.paid, 0)).toBe(ITEMS * PAID_PER_ITEM);
    expect(detail.items.reduce((acc, item) => acc + item.remaining, 0)).toBe(0);
    expect(detail.items.every((item) => item.paid === PAID_PER_ITEM && item.remaining === 0)).toBe(true);
  });

  it("los ids de los pagos van en lotes que aguantan la URL (414)", async () => {
    seedPeriod(1200, PAID_PER_ITEM);
    await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);

    const paymentInFilters = payrollPagedStub.inFilters.filter(
      (entry) => entry.table === "payroll_payments",
    );
    // Más de un lote: 1200 ids no entran en una sola URL.
    expect(paymentInFilters.length).toBeGreaterThan(1);
    const counts = [...new Set(paymentInFilters.map((entry) => entry.count))];
    expect(Math.max(...counts)).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
  });

  it("las dos lecturas van ordenadas y por páginas", async () => {
    seedPeriod(1200, PAID_PER_ITEM);
    await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);

    const itemWindows = payrollPagedStub.windows.filter((window) => window.table === "payroll_items");
    const paymentWindows = payrollPagedStub.windows.filter(
      (window) => window.table === "payroll_payments",
    );
    expect(itemWindows).toEqual([
      { table: "payroll_items", from: 0, to: 999, order: ["created_at", "id"] },
      { table: "payroll_items", from: 1000, to: 1999, order: ["created_at", "id"] },
    ]);
    for (const window of paymentWindows) expect(window.order).toEqual(["id"]);
  });

  it("control negativo: un período chico se lee igual (mismos pagos, sin duplicados)", async () => {
    const seed = seedPeriod(3, PAID_PER_ITEM);
    const detail = await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);

    expect(seed.payments).toHaveLength(3);
    expect(detail.items.map((item) => item.id)).toEqual(["item-00001", "item-00002", "item-00003"]);
    expect(detail.items.map((item) => item.paid)).toEqual([1000, 1000, 1000]);
    expect(detail.items.map((item) => item.remaining)).toEqual([0, 0, 0]);
    // Una sola lectura de cada tabla: el conjunto entra en la primera página.
    expect(payrollPagedStub.windows.filter((window) => window.table === "payroll_items")).toEqual([
      { table: "payroll_items", from: 0, to: 999, order: ["created_at", "id"] },
    ]);
    expect(payrollPagedStub.windows.filter((window) => window.table === "payroll_payments")).toEqual([
      { table: "payroll_payments", from: 0, to: 999, order: ["id"] },
    ]);
  });

  it("si una página de pagos falla, el detalle falla a la vista (no muestra menos plata)", async () => {
    seedPeriod(1200, PAID_PER_ITEM);
    payrollPagedStub.failAt = { payroll_payments: [1] };

    const failure: unknown = await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
  });
});

describe("payroll: la marca over_tope de la aprobación no puede mentir (U7)", () => {
  const VOUCHER_ID = "77777777-7777-4777-8777-777777777777";
  const EMPLEADO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const REQUEST_DATE = "2026-01-15";

  function seedPendingVoucher(amount: number, maxPerDay: number | null) {
    const voucher: Record<string, unknown> = {
      id: VOUCHER_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      employee_id: EMPLEADO,
      amount,
      request_date: REQUEST_DATE,
      status: "pendiente",
      approved_by: null,
      approval_code: null,
      observation: null,
      method_code: "transferencia",
      cash_shift_id: null,
      created_by: "u-1",
    };
    payrollPagedStub.tables = {
      voucher_requests: [voucher],
      // 072: los topes se leen de `system_settings`, una fila por ajuste.
      system_settings: voucherSettingRows({ max_per_day: maxPerDay }),
      users: [],
      audit_logs: [],
    };
    return voucher;
  }

  /** El registro de auditoría de la aprobación: la marca `over_tope` observada. */
  function approvalAudit(): Record<string, unknown> | null {
    const inserted = payrollPagedStub.inserts.find(
      (entry) =>
        entry.table === "audit_logs" &&
        (entry.payload as { action?: string }).action === "voucher.approved",
    );
    return (inserted?.payload as Record<string, unknown> | undefined) ?? null;
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("si la lectura de topes no se completa, la aprobación se RECHAZA (nunca un `false` inventado)", async () => {
    const voucher = seedPendingVoucher(150000, 200000);
    // Falla la lectura del acumulado vigente: la que filtra por `request_date`.
    payrollPagedStub.failOn = { table: "voucher_requests", filter: "request_date" };

    const failure: unknown = await approveVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    // El chequeo no se pudo evaluar: `false` significa "no superó topes" y no
    // puede venir de no haber podido mirar. Se rechaza y el admin reintenta.
    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
    // Y no queda rastro de una aprobación con la marca en falso.
    expect(payrollPagedStub.updates.filter((entry) => entry.table === "voucher_requests")).toEqual([]);
    expect(approvalAudit()).toBeNull();
    expect(voucher.status).toBe("pendiente");
  });

  it("control: dentro de topes la marca sigue siendo `false` (ahora es un dato, no un default)", async () => {
    const voucher = seedPendingVoucher(150000, 200000);

    const approved = await approveVoucher(payrollPagedStub.SEDE_ID, VOUCHER_ID, {}, ACTOR);

    expect(approved.status).toBe("aprobada");
    expect(voucher.status).toBe("aprobada");
    expect((approvalAudit()?.metadata as { over_tope?: unknown }).over_tope).toBe(false);
    expect(approvalAudit()).not.toHaveProperty("sede_id");
  });

  it("control: sobre el tope la marca sigue siendo `true`", async () => {
    seedPendingVoucher(150000, 100000);

    const approved = await approveVoucher(payrollPagedStub.SEDE_ID, VOUCHER_ID, {}, ACTOR);

    expect(approved.status).toBe("aprobada");
    expect((approvalAudit()?.metadata as { over_tope?: unknown }).over_tope).toBe(true);
    expect(approvalAudit()).not.toHaveProperty("sede_id");
  });
});

// ------------------------------------------- transición de vales (U8) ---
// `approveVoucher`/`rejectVoucher` leían el estado y después escribían con
// `.eq("id", id)` SIN precondición. Entre esa lectura y esa escritura la nómina
// puede marcar el vale `descontada` (el descuento SÍ guarda con `.in("status",
// ["pendiente","aprobada"])`). La aprobación entonces pisaba `descontada` con
// `aprobada`: el vale quedaba descontable OTRA vez en un período posterior y, a
// la vez, contado como salida de caja. Acá se reproduce la carrera con la
// escritura concurrente del doble.
//
// Matriz legal, leída del código (no adivinada):
//   - `canReviewVoucher(schemas.ts:565)` = solo `pendiente` → origen de aprobar
//     y de rechazar.
//   - aprobar escribe `aprobada`; rechazar escribe `rechazada`.
//   - `canDiscountVoucher(schemas.ts:557)` = `pendiente` | `aprobada` → origen
//     de `descontada` (nómina).
//   - `restoreVoucherStatus(schemas.ts:329)`: `descontada` → `aprobada` si hay
//     `approved_by`, si no `pendiente` (al borrar el borrador).
//   - `resolveVoucherInitialStatus(schemas.ts:520)`: nace `aprobada` o `pendiente`.
//   Por eso el origen legal de aprobar/rechazar es exactamente `pendiente`.
describe("payroll: la revisión del vale no pisa lo que la nómina descontó (U8)", () => {
  const VOUCHER_ID = "88888888-8888-4888-8888-888888888888";
  const EMPLEADO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const REQUEST_DATE = "2026-01-15";

  function seedVoucher(status: string, extra: Record<string, unknown> = {}) {
    const voucher: Record<string, unknown> = {
      id: VOUCHER_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      employee_id: EMPLEADO,
      amount: 150000,
      request_date: REQUEST_DATE,
      status,
      approved_by: null,
      approval_code: null,
      observation: null,
      method_code: "transferencia",
      cash_shift_id: null,
      created_by: "u-1",
      ...extra,
    };
    payrollPagedStub.tables = {
      voucher_requests: [voucher],
      // 072: los topes se leen de `system_settings`, una fila por ajuste.
      system_settings: voucherSettingRows({ max_per_day: 200000 }),
      users: [],
      audit_logs: [],
    };
    return voucher;
  }

  /** La nómina marca el vale `descontada` justo antes del UPDATE del admin. */
  function nominaDescuentaAntesDelUpdate(voucher: Record<string, unknown>): void {
    payrollPagedStub.beforeUpdate = {
      table: "voucher_requests",
      run: () => {
        voucher.status = "descontada";
        voucher.approved_by = "u-nomina";
      },
    };
  }

  function auditActions(): string[] {
    return payrollPagedStub.inserts
      .filter((entry) => entry.table === "audit_logs")
      .map((entry) => String((entry.payload as { action?: string }).action));
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("RED: si la nómina descuenta el vale antes de aprobarlo, la aprobación se RECHAZA", async () => {
    const voucher = seedVoucher("pendiente");
    nominaDescuentaAntesDelUpdate(voucher);

    const failure: unknown = await approveVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VOUCHER_CONFLICT", status: 409 });
    expect(voucher.status).toBe("descontada");
    expect(auditActions()).toEqual([]);
  });

  it("la carrera del rechazo también se rechaza (no pisa `descontada`)", async () => {
    const voucher = seedVoucher("pendiente");
    nominaDescuentaAntesDelUpdate(voucher);

    const failure: unknown = await rejectVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      { motivo: "Fuera de política" },
      { userId: "u-1" },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VOUCHER_CONFLICT", status: 409 });
    expect(voucher.status).toBe("descontada");
    expect(auditActions()).toEqual([]);
  });

  it("control: un vale pendiente sin carrera se aprueba (la guarda no bloquea el camino legal)", async () => {
    const voucher = seedVoucher("pendiente");

    const approved = await approveVoucher(payrollPagedStub.SEDE_ID, VOUCHER_ID, {}, ACTOR);

    expect(approved.status).toBe("aprobada");
    expect(voucher.status).toBe("aprobada");
    expect(auditActions()).toContain("voucher.approved");
  });

  it("control: un vale pendiente sin carrera se rechaza", async () => {
    const voucher = seedVoucher("pendiente");

    const rejected = await rejectVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      { motivo: "Sin justificación" },
      { userId: "u-1" },
    );

    expect(rejected.status).toBe("rechazada");
    expect(voucher.status).toBe("rechazada");
    expect(auditActions()).toContain("voucher.rejected");
  });

  it("control negativo: lo que ya no es `pendiente` se rechaza en la lectura, sin tocar la fila", async () => {
    seedVoucher("aprobada", { approved_by: "u-1" });
    const onApproved: unknown = await approveVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);
    expect(onApproved).toMatchObject({ code: "VOUCHER_IMMUTABLE", status: 409 });

    seedVoucher("descontada", { approved_by: "u-1" });
    const onDiscounted: unknown = await rejectVoucher(
      payrollPagedStub.SEDE_ID,
      VOUCHER_ID,
      { motivo: "x" },
      { userId: "u-1" },
    ).catch((error: unknown) => error);
    expect(onDiscounted).toMatchObject({ code: "VOUCHER_IN_PAYROLL", status: 409 });
    expect(auditActions()).toEqual([]);
  });
});

// ------------------------------------------- actions de nómina (U8) ---
// El empleado logueado se ubicaba con `listEmployees(sedeId)`, que corta en 50
// (`clampLimit`). En una sede con más de 50 empleados, quien estaba después del
// 50 recibía `ownId = "sin-acceso"` y veía su detalle y su nómina VACÍOS, sin un
// solo error. U7 ya había cerrado el extremo que ARMA la nómina (el cálculo);
// acá se cierra el extremo que MIRA (la pantalla del propio empleado).
describe("payroll: el empleado logueado se ubica en la planta completa (U8)", () => {
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const TARGET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeee5555";
  const TARGET_USER = "u-empleado-55";

  /** 60 empleados ordenados por nombre; el objetivo (user_id) va en `targetIndex`. */
  function seedPlanta(count: number, targetIndex: number) {
    const employees: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= count; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const isTarget = index === targetIndex;
      employees.push({
        id: isTarget ? TARGET_ID : `emp-${suffix}`,
        sede_id: payrollPagedStub.SEDE_ID,
        user_id: isTarget ? TARGET_USER : `u-${suffix}`,
        full_name: `Empleado ${suffix}`,
        employee_code: null,
        document: null,
        phone: null,
        position: null,
        payout_mode: "normal",
        email: null,
        birth_date: null,
        pay_type: "porcentaje",
        salary_fixed: null,
        commission_percent: 10,
        is_active: true,
      });
    }
    payrollPagedStub.tables.employees = employees;
    return employees;
  }

  function seedPeriodo() {
    payrollPagedStub.tables.payroll_periods = [
      {
        id: PERIOD_ID,
        sede_id: payrollPagedStub.SEDE_ID,
        start_date: "2026-01-01",
        end_date: "2026-01-31",
        status: "borrador",
        created_by: "u-1",
        closed_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
  }

  function item(id: string, employeeId: string) {
    return {
      id,
      period_id: PERIOD_ID,
      employee_id: employeeId,
      base_fixed: 0,
      commissions: 100000,
      bonuses: 0,
      deductions_vales: 0,
      other_discounts: 0,
      net_pay: 100000,
      detail_json: [],
      created_at: "2026-01-15T10:00:00.000Z",
    };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("un empleado después del tope del listado (50) ve su propio detalle", async () => {
    seedPlanta(60, 55);
    seedPeriodo();
    payrollPagedStub.tables.payroll_items = [item("item-mio", TARGET_ID), item("item-otro", "emp-02")];
    payrollPagedStub.tables.payroll_payments = [
      { id: "pago-mio", payroll_item_id: "item-mio", method_code: "efectivo", amount: 40000, paid_at: "2026-01-20T10:00:00.000Z" },
    ];

    const result = await getPeriodDetailAction(PERIOD_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items.map((row) => row.id)).toEqual(["item-mio"]);
    expect(result.data.items[0].paid).toBe(40000);
    expect(result.data.items[0].remaining).toBe(60000);
  });

  it("el mismo empleado ve sus vales (no `sin-acceso`)", async () => {
    seedPlanta(60, 55);
    payrollPagedStub.tables.voucher_requests = [
      {
        id: "99999999-9999-4999-8999-999999999999",
        sede_id: payrollPagedStub.SEDE_ID,
        employee_id: TARGET_ID,
        amount: 100000,
        request_date: "2026-01-10",
        status: "aprobada",
        approved_by: "u-1",
        approval_code: null,
        observation: null,
        method_code: "efectivo",
        cash_shift_id: null,
        created_by: "u-1",
      },
    ];
    payrollPagedStub.tables.users = [];

    const result = await listVouchersAction({});

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((voucher) => voucher.id)).toEqual([
      "99999999-9999-4999-8999-999999999999",
    ]);
  });

  it("control: un empleado dentro de los primeros 50 sigue viendo su detalle", async () => {
    seedPlanta(60, 5);
    seedPeriodo();
    payrollPagedStub.tables.payroll_items = [item("item-mio", TARGET_ID)];
    payrollPagedStub.session = { userId: TARGET_USER, sedeId: payrollPagedStub.SEDE_ID, roles: ["empleado"] };

    const result = await getPeriodDetailAction(PERIOD_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items.map((row) => row.id)).toEqual(["item-mio"]);
  });

  it("control negativo: sin legajo propio NO ve ítems ajenos (no falla abierto)", async () => {
    seedPlanta(60, 55);
    seedPeriodo();
    payrollPagedStub.tables.payroll_items = [item("item-ajeno", TARGET_ID)];
    payrollPagedStub.session = {
      userId: "u-sin-legajo",
      sedeId: payrollPagedStub.SEDE_ID,
      roles: ["empleado"],
    };

    const result = await getPeriodDetailAction(PERIOD_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items).toEqual([]);
  });
});

// --------------------------- rango de fechas del listado de vales ---
//
// La pantalla de vales nace acotada al día de hoy y amplía —o limpia— ese
// rango desde sus filtros de fecha. El rango viaja al SERVIDOR: `date_from` y
// `date_to` acotan `request_date` de forma INCLUSIVA (columna `date`, sin
// aritmética de zona horaria). El camino exacto de caja (`request_date`) queda
// intacto. Estos tests cubren las dos puntas, cada punta sola, el rango
// limpiado (sin cota) y la igualdad exacta de caja.
describe("payroll: el listado de vales acepta un rango de fechas inclusivo (pantalla de vales)", () => {
  const SEDE = payrollPagedStub.SEDE_ID;

  function voucher(id: string, fecha: string): Record<string, unknown> {
    return {
      id,
      sede_id: SEDE,
      employee_id: payrollPagedStub.EMPLOYEE_ID,
      amount: 50000,
      request_date: fecha,
      status: "aprobada",
      approved_by: "u-1",
      approval_code: null,
      observation: null,
      method_code: "efectivo",
      cash_shift_id: null,
      created_by: "u-1",
    };
  }

  /**
   * Sesión admin (sin el override de `employee_id` del rol empleado) y cinco
   * vales en fechas dispares, con dos el mismo día para probar las dos puntas.
   */
  function seedVales(): void {
    payrollPagedStub.session = { userId: "u-1", sedeId: SEDE, roles: ["admin"] };
    payrollPagedStub.tables.users = [];
    payrollPagedStub.tables.voucher_requests = [
      voucher("v-05", "2026-01-05"),
      voucher("v-10a", "2026-01-10"),
      voucher("v-10b", "2026-01-10"),
      voucher("v-15", "2026-01-15"),
      voucher("v-20", "2026-01-20"),
    ];
  }

  /** Ids ordenados: la guarda afirma PERTENENCIA, no el orden del `order by`. */
  async function ids(input: Parameters<typeof listVouchersAction>[0]): Promise<string[]> {
    const result = await listVouchersAction(input);
    expect(result.success).toBe(true);
    if (!result.success) return [];
    return result.data.map((row) => row.id).sort();
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("ambos extremos: inclusivo en las dos puntas", async () => {
    seedVales();
    expect(await ids({ date_from: "2026-01-10", date_to: "2026-01-15" })).toEqual(
      ["v-10a", "v-10b", "v-15"].sort(),
    );
  });

  it("solo `date_from`: sin tope superior", async () => {
    seedVales();
    expect(await ids({ date_from: "2026-01-10" })).toEqual(
      ["v-10a", "v-10b", "v-15", "v-20"].sort(),
    );
  });

  it("solo `date_to`: sin piso inferior", async () => {
    seedVales();
    expect(await ids({ date_to: "2026-01-10" })).toEqual(
      ["v-05", "v-10a", "v-10b"].sort(),
    );
  });

  it("sin fechas: el listado NO acota por fecha (filtros limpiados = todo)", async () => {
    seedVales();
    expect(await ids({})).toEqual(
      ["v-05", "v-10a", "v-10b", "v-15", "v-20"].sort(),
    );
  });

  it("extremos iguales: un solo día exacto", async () => {
    seedVales();
    expect(await ids({ date_from: "2026-01-10", date_to: "2026-01-10" })).toEqual(
      ["v-10a", "v-10b"].sort(),
    );
  });

  it("el camino de caja (`request_date` exacto) no cambió", async () => {
    seedVales();
    expect(await ids({ request_date: "2026-01-10", limit: 200 })).toEqual(
      ["v-10a", "v-10b"].sort(),
    );
  });
});

// ------------------------------------- prorata del fijo y solape (PR1) ---
//
// El fijo de un período (`base_fixed`) es la parte del sueldo MENSUAL que
// corresponde a los DÍAS de ese período, calculada en el servidor. Antes no
// había prorata: cada período pagaba `salary_fixed` completo, así que cuatro
// cierres semanales de septiembre pagaban 4 × el sueldo, sin error, sin aviso y
// sin señal de auditoría. La prorata sólo cierra la suma si los períodos no
// comparten días, así que el mismo trabajo cierra el solape: un día nominado
// una sola vez, en el servicio y en la base.

describe("payroll: el fijo es la parte del sueldo mensual de los DÍAS del período (PR1)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  /** Sueldo MENSUAL (migración 003: `salary_fixed` es por mes). */
  const SALARY = 1_400_000;
  const WEEK_1 = "periodo-semana-1";
  const WEEK_2 = "periodo-semana-2";

  /** Empleado de pago fijo con el sueldo mensual del ejemplo del dueño. */
  function employeeFijo(payType = "fijo", salary: number | null = SALARY) {
    return {
      id: payrollPagedStub.EMPLOYEE_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: "Empleada fija",
      employee_code: "E-001",
      document: "1000000001",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: payType,
      salary_fixed: salary,
      commission_percent: null,
      is_active: true,
    };
  }

  function periodRow(id: string, start: string, end: string, status = "borrador") {
    return {
      id,
      sede_id: payrollPagedStub.SEDE_ID,
      start_date: start,
      end_date: end,
      status,
      created_by: "u-1",
      closed_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
  }

  /** Dos semanas de septiembre (1→7 y 8→14) y una empleada fija. */
  function seedTwoWeeklyPeriods() {
    payrollPagedStub.tables = {
      employees: [employeeFijo()],
      payroll_periods: [
        periodRow(WEEK_1, "2026-09-01", "2026-09-07"),
        periodRow(WEEK_2, "2026-09-08", "2026-09-14"),
      ],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  /** `base_fixed` que el servicio persistió al calcular el período dado. */
  async function baseFixedOf(periodId: string): Promise<number> {
    await calculatePayroll(payrollPagedStub.SEDE_ID, periodId, {}, ACTOR);
    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    return Number(persisted[0].base_fixed);
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("dos semanas del mismo mes ya no pagan dos veces el sueldo", async () => {
    seedTwoWeeklyPeriods();

    const first = await baseFixedOf(WEEK_1);
    const second = await baseFixedOf(WEEK_2);

    // 7 de 30 días: 7/30 × 1.400.000 = 326.666,67 → 326.667 por período.
    // Antes cada período pagaba el sueldo MENSUAL completo: 1.400.000 +
    // 1.400.000 = 2.800.000 por 14 días de un mes de 30.
    expect([first, second]).toEqual([326_667, 326_667]);
    // Non-vacuidad de la prorata: 14 días NO son el mes entero.
    expect(first + second).toBeLessThan(SALARY);
  });

  it("un período de un mes completo paga exactamente el sueldo mensual", async () => {
    payrollPagedStub.tables = {
      employees: [employeeFijo()],
      payroll_periods: [periodRow("periodo-mes", "2026-09-01", "2026-09-30")],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };

    // El mes completo es el único caso en que el fijo es el sueldo tal cual:
    // 30 de 30 días. Sirve de ancla de la fórmula (si el divisor no fuera el
    // largo real del mes, acá no daría exacto).
    await expect(baseFixedOf("periodo-mes")).resolves.toBe(SALARY);
  });

  it("mixto: el fijo prorrateado y la comisión se SUMAN (la aritmética no cambia)", async () => {
    payrollPagedStub.tables = {
      employees: [employeeFijo("mixto")],
      payroll_periods: [periodRow(WEEK_1, "2026-09-01", "2026-09-07")],
      invoices: [
        {
          id: "factura-1",
          consecutive_number: 1,
          sede_id: payrollPagedStub.SEDE_ID,
          // Pagada: solo las facturas pagadas comisionan (regla del dueño).
          status: "Pagada",
          created_at: "2026-09-03T12:00:00.000Z",
        },
      ],
      invoice_items: [
        {
          id: "linea-1",
          invoice_id: "factura-1",
          item_type: "servicio",
          employee_id: payrollPagedStub.EMPLOYEE_ID,
          qty: 1,
          unit_price: 10_000,
          subtotal: 10_000,
          no_commission: false,
          commission_value: null,
          commission_percent_override: null,
          product_id: null,
          service_id: payrollPagedStub.SERVICE_ID,
        },
      ],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
    // El porcentaje del mixto vive en `commission_percent`.
    payrollPagedStub.tables.employees[0].commission_percent = 10;

    await calculatePayroll(payrollPagedStub.SEDE_ID, WEEK_1, {}, ACTOR);

    const persisted = payrollPagedStub.itemsUpsert ?? [];
    expect(persisted).toHaveLength(1);
    // La comisión (1.000) sigue ENCIMA del fijo prorrateado (326.667): la
    // prorata sólo cambia el fijo, no la suma de comisiones ni los descuentos.
    expect(persisted[0].base_fixed).toBe(326_667);
    expect(persisted[0].commissions).toBe(1_000);
    expect(persisted[0].net_pay).toBe(327_667);
  });

  it("un pago que no es fijo ni mixto no recibe fijo (sigue en 0)", async () => {
    payrollPagedStub.tables = {
      employees: [employeeFijo("porcentaje")],
      payroll_periods: [periodRow(WEEK_1, "2026-09-01", "2026-09-07")],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };

    // `salary_fixed` informado de más en un empleado porcentual no se paga:
    // el fijo es de fijo/mixto, y el mensual se prorratea o no se paga.
    await expect(baseFixedOf(WEEK_1)).resolves.toBe(0);
  });
});

// ------------------------------------------------- migración 035 ---
describe("migración 035_payroll_period_proration.sql (PR1)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "035_payroll_period_proration.sql"),
    "utf8",
  );
  /** Sin espacios de más: compara el DDL, no la indentación del archivo. */
  const flat = sql.replace(/\s+/g, " ");

  it("barrera en la base: exclusión de rangos que comparten días, por sede", () => {
    // El operador `=` de `sede_id` dentro del gist lo aporta `btree_gist`.
    expect(flat).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(flat).toContain("EXCLUDE USING gist");
    expect(flat).toContain("sede_id WITH =");
    // Rango INCLUSIVO en los dos extremos: fin 07 / inicio 08 NO comparte día.
    expect(flat).toContain("daterange(start_date, end_date, '[]') WITH &&");
  });

  it("cubre TODOS los estados: un período cerrado también pagó esos días", () => {
    // El DDL de la restricción, sin filtro de estado: no hay `WHERE status`
    // (PostgreSQL tampoco admite restricciones de exclusión parciales).
    expect(flat).toContain(
      "ALTER TABLE public.payroll_periods ADD CONSTRAINT ex_payroll_periods_no_overlap EXCLUDE USING gist ( sede_id WITH =, daterange(start_date, end_date, '[]') WITH && );",
    );
  });

  it("es idempotente y no borra ni reescribe datos", () => {
    expect(flat).toContain("IF NOT EXISTS");
    expect(flat).toContain("pg_constraint");
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|INDEX|CONSTRAINT|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("si ya hay filas solapadas FALLA a la vista y dice qué hacer", () => {
    // No se puede crear la restricción con datos que la violen: el archivo lo
    // detecta ANTES y aborta con los pares en conflicto en el mensaje.
    expect(flat).toContain("RAISE EXCEPTION");
    expect(flat).toContain("23P01");
    expect(flat).toMatch(/ABORTADA/i);
    expect(flat).toMatch(/qu[eé] hacer/i);
    // Nombra el conflicto: los dos períodos con sus fechas y su estado.
    expect(flat).toContain("daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')");
  });
});

describe("payroll: la prorata del fijo, fórmula (función pura, PR1)", () => {
  const SALARY = 1_400_000;
  const prorate = (startDate: string, endDate: string, salaryFixed: number | null = SALARY) =>
    prorateFixedSalary({ salaryFixed, startDate, endDate });

  it("el ejemplo del dueño: las cuatro semanas de septiembre (mes de 30 días)", () => {
    const amounts = [
      prorate("2026-09-01", "2026-09-07"),
      prorate("2026-09-08", "2026-09-14"),
      prorate("2026-09-15", "2026-09-21"),
      prorate("2026-09-22", "2026-09-30"),
    ];
    expect(amounts).toEqual([326_667, 326_667, 326_667, 420_000]);
    // Son los DÍAS, no el sueldo: la primera semana no paga 1.400.000.
    expect(amounts[0]).not.toBe(SALARY);
    // El dueño espera que las cuatro sumen 1.400.000. Con peso entero POR
    // PERÍODO la suma da 1.400.001: 7/30 = 326.666,67 redondea +0,33 y tres
    // períodos de 7 días dejan +1 peso. El desvío es ≤ 1 peso por período y no
    // se puede eliminar sin repartir el resto del mes entre períodos (un
    // período no conoce a los otros). Se documenta en vez de esconderse.
    expect(amounts.reduce((acc, value) => acc + value, 0)).toBe(SALARY + 1);
  });

  it("un mes completo paga EXACTAMENTE el sueldo, sea de 28, 29, 30 o 31 días", () => {
    expect(prorate("2026-09-01", "2026-09-30")).toBe(SALARY); // 30
    expect(prorate("2026-01-01", "2026-01-31")).toBe(SALARY); // 31
    expect(prorate("2026-02-01", "2026-02-28")).toBe(SALARY); // 28
    expect(prorate("2028-02-01", "2028-02-29")).toBe(SALARY); // bisiesto, 29
  });

  it("cruza el fin de mes: prorratea a los dos lados", () => {
    // 2026-08-28 → 2026-09-03: 4 días de agosto (31) + 3 de septiembre (30).
    // 1.400.000 × 4/31 = 180.645,16 y × 3/30 = 140.000 → 320.645,16 → 320.645.
    expect(prorate("2026-08-28", "2026-09-03")).toBe(320_645);
  });

  it("dos meses completos son DOS sueldos (no hay tope mensual)", () => {
    expect(prorate("2026-08-01", "2026-09-30")).toBe(2 * SALARY);
  });

  it("un solo día es un día del mes, no el sueldo (control negativo)", () => {
    expect(prorate("2026-09-01", "2026-09-01")).toBe(46_667);
    expect(prorate("2026-09-01", "2026-09-01")).not.toBe(SALARY);
  });

  it("usa el largo REAL del mes: 7 días de enero no valen lo mismo que 7 de septiembre", () => {
    // Control negativo del divisor: con un 30 fijo, enero daría 326.667.
    expect(prorate("2026-01-01", "2026-01-07")).toBe(316_129); // 7/31
    expect(prorate("2026-09-01", "2026-09-07")).toBe(326_667); // 7/30
  });

  it("medio mes es la mitad del sueldo", () => {
    expect(prorate("2026-09-01", "2026-09-15")).toBe(700_000);
  });

  it("sin sueldo no hay fijo (ni división por cero)", () => {
    expect(prorate("2026-09-01", "2026-09-30", null)).toBe(0);
    expect(prorate("2026-09-01", "2026-09-30", 0)).toBe(0);
  });

  it("un rango imposible LANZA en vez de inventar 0", () => {
    expect(() => prorate("2026-09-14", "2026-09-01")).toThrowError("INVALID_PERIOD_RANGE");
    expect(() => prorate("2026-02-30", "2026-03-02")).toThrowError("INVALID_PERIOD_RANGE");
    expect(() => prorate("2026-13-01", "2026-13-05")).toThrowError("INVALID_PERIOD_RANGE");
  });

  it("el predicado de solape: ADYACENTE no comparte día, un día compartido sí", () => {
    const week = { start_date: "2026-09-01", end_date: "2026-09-07" };
    expect(rangesOverlap(week, { start_date: "2026-09-08", end_date: "2026-09-14" })).toBe(false);
    expect(rangesOverlap(week, { start_date: "2026-09-07", end_date: "2026-09-14" })).toBe(true);
    expect(rangesOverlap(week, { start_date: "2026-09-03", end_date: "2026-09-04" })).toBe(true);
    expect(rangesOverlap(week, { start_date: "2026-08-01", end_date: "2026-09-30" })).toBe(true);
    expect(rangesOverlap(week, week)).toBe(true);
  });
});

describe("payroll: la fracción del fijo por cadencia (F3, función pura)", () => {
  const SALARY = 1_500_000;
  const resolve = (
    employeeFrequency: string | null | undefined,
    periodFrequency: string | null | undefined,
    salaryFixed: number | null = SALARY,
    range: { startDate: string; endDate: string } = { startDate: "2026-09-01", endDate: "2026-09-07" },
  ) =>
    resolveFixedSalaryForPeriod({
      salaryFixed,
      employeeFrequency,
      periodFrequency,
      ...range,
    });

  it("la tabla del dueño: semanal 1/4, quincenal 1/2, mensual 1, sin cadencia null", () => {
    expect(fixedFractionForFrequency("semanal")).toBe(1 / 4);
    expect(fixedFractionForFrequency("quincenal")).toBe(1 / 2);
    expect(fixedFractionForFrequency("mensual")).toBe(1);
    expect(fixedFractionForFrequency(null)).toBeNull();
    expect(fixedFractionForFrequency(undefined)).toBeNull();
    expect(fixedFractionForFrequency("anual")).toBeNull();
    // El catálogo es CERRADO y el mismo que pregunta la ficha del empleado (F2)
    // y el diálogo del período (F4).
    expect(payFrequencySchema.safeParse("semanal").success).toBe(true);
    expect(payFrequencySchema.safeParse("anual").success).toBe(false);
  });

  it("con la MISMA cadencia y el ciclo COMPLETO paga mensual × fracción, no los días del rango", () => {
    // F5: la fracción del dueño paga un ciclo COMPLETO. El rango de 7 días de
    // septiembre es el ciclo natural del semanal, pero es un ciclo PARCIAL del
    // quincenal (15) y del mensual (30): por eso cada caso usa SU ciclo natural
    // y los montos de la tabla del dueño (375.000 / 750.000 / 1.500.000) siguen
    // enteros. Los ciclos parciales tienen su propio bloque más abajo.
    expect(resolve("semanal", "semanal")).toEqual({ amount: 375_000, basis: "cadence", fraction: 1 / 4 });
    expect(resolve("quincenal", "quincenal", SALARY, { startDate: "2026-09-01", endDate: "2026-09-15" }).amount).toBe(750_000);
    expect(resolve("mensual", "mensual", SALARY, { startDate: "2026-09-01", endDate: "2026-09-30" }).amount).toBe(1_500_000);
    // La semana de 7 días de septiembre daría 350.000 por días: la cadencia manda.
    const byDays = prorateFixedSalary({ salaryFixed: SALARY, startDate: "2026-09-01", endDate: "2026-09-07" });
    expect(byDays).toBe(350_000);
    expect(resolve("semanal", "semanal").amount).not.toBe(byDays);
  });

  it("con cadencia DISTINTA el empleado cobra 0 fijo en ese período", () => {
    expect(resolve("mensual", "semanal")).toEqual({ amount: 0, basis: "other-cadence", fraction: 1 / 4 });
    expect(resolve("semanal", "mensual").amount).toBe(0);
    expect(resolve("quincenal", "semanal").amount).toBe(0);
    expect(resolve("semanal", "quincenal").amount).toBe(0);
  });

  it("sin cadencia en CUALQUIERA de los dos lados rige el prorrateo por días de hoy", () => {
    const expected = prorateFixedSalary({ salaryFixed: SALARY, startDate: "2026-09-01", endDate: "2026-09-07" });
    const pairs: Array<[string | null | undefined, string | null | undefined]> = [
      [null, null],
      [null, "semanal"],
      ["semanal", null],
      [undefined, undefined],
      ["", "semanal"],
      ["semanal", "desconocida"],
    ];
    for (const [employeeFrequency, periodFrequency] of pairs) {
      const resolution = resolve(employeeFrequency, periodFrequency);
      expect(resolution.basis, `${String(employeeFrequency)}/${String(periodFrequency)}`).toBe("prorated");
      expect(resolution.amount, `${String(employeeFrequency)}/${String(periodFrequency)}`).toBe(expected);
    }
  });

  it("sin sueldo no hay base que fraccionar", () => {
    expect(resolve("semanal", "semanal", null).amount).toBe(0);
    expect(resolve("semanal", "semanal", 0).amount).toBe(0);
  });
});

describe("payroll: la primera nómina prorratea el ciclo PARCIAL (F5, función pura)", () => {
  const SALARY = 1_500_000;
  /** Fijo resuelto del período; el empleado comparte la cadencia salvo que se diga otra. */
  const resolve = (
    periodFrequency: string | null | undefined,
    startDate: string,
    endDate: string,
    employeeFrequency: string | null | undefined = periodFrequency,
  ) =>
    resolveFixedSalaryForPeriod({
      salaryFixed: SALARY,
      employeeFrequency,
      periodFrequency,
      startDate,
      endDate,
    });
  /** La identidad de `payroll_items`, en cada caso (sin comisiones ni vales acá). */
  const expectIdentity = (amount: number, bonuses = 0, vales = 0, otherDiscounts = 0) => {
    expect(computeNetPay({ baseFixed: amount, commissions: 0, bonuses, vales, otherDiscounts })).toBe(
      amount + bonuses - vales - otherDiscounts,
    );
  };

  it("el caso concreto del dueño: mensual 1.500.000, semanal y un período de 4 días", () => {
    // 1.500.000 / 4 × 4/7 = 214.285,71 → 214.286 (redondeo ÚNICO, peso entero).
    const resolution = resolve("semanal", "2026-10-01", "2026-10-04");
    expect(resolution).toEqual({ amount: 214_286, basis: "cadence", fraction: 1 / 4 });
    expectIdentity(resolution.amount);
  });

  it("ciclos parciales de quincenal y mensual sobre la misma base comercial", () => {
    // Quincenal: 1.500.000 / 2 × 10/15 = 500.000.
    const quincenal = resolve("quincenal", "2026-10-01", "2026-10-10");
    expect(quincenal.amount).toBe(500_000);
    expect(quincenal.basis).toBe("cadence");
    expectIdentity(quincenal.amount);
    // Mensual: 1.500.000 × 20/30 = 1.000.000.
    const mensual = resolve("mensual", "2026-10-01", "2026-10-20");
    expect(mensual.amount).toBe(1_000_000);
    expect(mensual.basis).toBe("cadence");
    expectIdentity(mensual.amount);
  });

  it("el ciclo COMPLETO no cambia para las tres cadencias", () => {
    const semanal = resolve("semanal", "2026-10-01", "2026-10-07").amount;
    const quincenal = resolve("quincenal", "2026-10-01", "2026-10-15").amount;
    const mensual = resolve("mensual", "2026-10-01", "2026-10-30").amount;
    expect(semanal).toBe(375_000);
    expect(quincenal).toBe(750_000);
    expect(mensual).toBe(1_500_000);
    expectIdentity(semanal, 10_000, 5_000, 2_000);
    expectIdentity(quincenal);
    expectIdentity(mensual);
  });

  it("un rango MÁS LARGO que el ciclo se topa en la fracción entera, nunca más", () => {
    // 31 días de enero: el semanal paga 1/4, no 31/7 × 1/4; tampoco el mensual
    // paga 31/30 de la fracción. El tope es el ciclo completo.
    const semanal = resolve("semanal", "2026-01-01", "2026-01-31").amount;
    const quincenal = resolve("quincenal", "2026-01-01", "2026-01-31").amount;
    const mensual = resolve("mensual", "2026-01-01", "2026-01-31").amount;
    expect(semanal).toBe(375_000);
    expect(quincenal).toBe(750_000);
    expect(mensual).toBe(1_500_000);
    expectIdentity(semanal);
    expectIdentity(quincenal);
    expectIdentity(mensual);
    expect(cycleProrationFactor({ frequency: "semanal", startDate: "2026-01-01", endDate: "2026-01-31" })).toBe(1);
  });

  it("el factor puro: días del ciclo, días del rango y su cociente", () => {
    expect(cycleDaysForFrequency("semanal")).toBe(7);
    expect(cycleDaysForFrequency("quincenal")).toBe(15);
    expect(cycleDaysForFrequency("mensual")).toBe(30);
    expect(cycleDaysForFrequency(null)).toBeNull();
    expect(cycleDaysForFrequency("anual")).toBeNull();
    expect(PAY_CYCLE_DAYS).toEqual({ semanal: 7, quincenal: 15, mensual: 30 });
    // El rango cuenta los DOS extremos y un rango imposible no inventa días.
    expect(periodRangeDays("2026-10-01", "2026-10-04")).toBe(4);
    expect(periodRangeDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(periodRangeDays("2026-10-04", "2026-10-01")).toBeNull();
    expect(cycleProrationFactor({ frequency: "semanal", startDate: "2026-10-01", endDate: "2026-10-04" })).toBeCloseTo(4 / 7, 12);
    // Sin cadencia no hay ciclo: el factor es 1 y la rama prorrateada manda.
    expect(cycleProrationFactor({ frequency: null, startDate: "2026-10-01", endDate: "2026-10-04" })).toBe(1);
  });

  it("sin cadencia en cualquiera de los dos lados el prorrateo por días queda intacto", () => {
    const byDays = prorateFixedSalary({ salaryFixed: SALARY, startDate: "2026-10-01", endDate: "2026-10-04" });
    const pairs: Array<[string | null | undefined, string | null | undefined]> = [
      [null, null],
      [null, "semanal"],
      ["semanal", null],
      [undefined, undefined],
      ["anual", "semanal"],
    ];
    for (const [employeeFrequency, periodFrequency] of pairs) {
      const resolution = resolve(periodFrequency, "2026-10-01", "2026-10-04", employeeFrequency);
      expect(resolution.basis, `${String(employeeFrequency)}/${String(periodFrequency)}`).toBe("prorated");
      expect(resolution.amount, `${String(employeeFrequency)}/${String(periodFrequency)}`).toBe(byDays);
      expectIdentity(resolution.amount);
    }
  });

  it("la exclusión por cadencia distinta y la regla del mixto siguen igual", () => {
    // Exclusión (F4): con cadencia distinta el fijo es 0, sin importar el ciclo.
    expect(resolve("semanal", "2026-10-01", "2026-10-04", "quincenal")).toEqual({
      amount: 0,
      basis: "other-cadence",
      fraction: 1 / 4,
    });
    // Mixto (F3): el básico PRORRATEADO compite contra los porcentajes de servicios.
    const base = resolve("semanal", "2026-10-01", "2026-10-04").amount; // 214.286
    const over = resolveMixedBlock({ baseFixed: base, fixedCommissions: 0, servicePercent: 400_000 });
    expect(base + over.commissions).toBe(400_000);
    const below = resolveMixedBlock({ baseFixed: base, fixedCommissions: 0, servicePercent: 100_000 });
    expect(base + below.commissions).toBe(base);
    // La identidad se sostiene con los dos bloques y con descuentos.
    expectIdentity(base + over.commissions, 50_000, 20_000, 10_000);
  });
});

describe("payroll: el ciclo cerrado de la cadencia (F7, función pura)", () => {
  it("la tabla de ciclos: 1, 2 y 4 semanas, todas domingo a sábado", () => {
    expect(PAY_CYCLE_CALENDAR_DAYS).toEqual({ semanal: 7, quincenal: 14, mensual: 28 });
    expect(calendarCycleDaysForFrequency("semanal")).toBe(7);
    expect(calendarCycleDaysForFrequency("quincenal")).toBe(14);
    expect(calendarCycleDaysForFrequency("mensual")).toBe(28);
    expect(calendarCycleDaysForFrequency(null)).toBeNull();
    expect(calendarCycleDaysForFrequency("anual")).toBeNull();
    // Las tres cadencias comparten el domingo de inicio y cierran el sábado.
    expect(payrollCycleRange({ frequency: "semanal", cycleEndDate: "2026-09-05" })).toEqual({
      start_date: "2026-08-30",
      end_date: "2026-09-05",
    });
    expect(payrollCycleRange({ frequency: "quincenal", cycleEndDate: "2026-09-12" })).toEqual({
      start_date: "2026-08-30",
      end_date: "2026-09-12",
    });
    expect(payrollCycleRange({ frequency: "mensual", cycleEndDate: "2026-09-26" })).toEqual({
      start_date: "2026-08-30",
      end_date: "2026-09-26",
    });
  });

  it("con una fecha de referencia devuelve el ciclo que la contiene", () => {
    // Miércoles 2026-09-02: su ciclo semanal cierra el sábado 2026-09-05.
    expect(payrollCycleRange({ frequency: "semanal", referenceDate: "2026-09-02" })).toEqual({
      start_date: "2026-08-30",
      end_date: "2026-09-05",
    });
    // El domingo 2026-08-30 ya pertenece a la semana que cierra el 2026-09-05.
    expect(payrollCycleRange({ frequency: "semanal", referenceDate: "2026-08-30" })?.end_date).toBe(
      "2026-09-05",
    );
    // Sin cadencia, con un cierre que no es sábado o con una fecha imposible no
    // hay ciclo que derivar.
    expect(payrollCycleRange({ frequency: null, cycleEndDate: "2026-09-05" })).toBeNull();
    expect(payrollCycleRange({ frequency: "semanal", cycleEndDate: "2026-09-04" })).toBeNull();
    expect(payrollCycleRange({ frequency: "semanal", cycleEndDate: "2026-02-30" })).toBeNull();
    expect(payrollCycleRange({ frequency: "semanal" })).toBeNull();
  });

  it("el último ciclo COMPLETADO es el sábado anterior a la referencia", () => {
    // El domingo 2026-10-04 se liquida la semana que cerró el sábado 2026-10-03.
    expect(lastCompletedCycleEndDate("2026-10-04")).toBe("2026-10-03");
    // El propio sábado todavía no está completo: manda el anterior.
    expect(lastCompletedCycleEndDate("2026-10-03")).toBe("2026-09-26");
    expect(lastCompletedCycleEndDate("2026-10-05")).toBe("2026-10-03");
    expect(lastCompletedCycleEndDate("2026-02-30")).toBeNull();
  });

  it("la lista de ciclos completados: el más reciente PRIMERO y con su rango", () => {
    const semanal = lastCompletedPayrollCycles({
      frequency: "semanal",
      referenceDate: "2026-10-04",
      count: 3,
    });
    expect(semanal).toHaveLength(3);
    expect(semanal[0]).toMatchObject({
      start_date: "2026-09-27",
      end_date: "2026-10-03",
      label: "27 sep – 3 oct 2026",
    });
    expect(semanal[1]).toMatchObject({ start_date: "2026-09-20", end_date: "2026-09-26" });
    expect(semanal[2]).toMatchObject({ start_date: "2026-09-13", end_date: "2026-09-19" });
    // El quincenal avanza de dos en dos semanas y el mensual de cuatro.
    const quincenal = lastCompletedPayrollCycles({
      frequency: "quincenal",
      referenceDate: "2026-10-04",
      count: 2,
    });
    expect(quincenal[0]).toMatchObject({ start_date: "2026-09-20", end_date: "2026-10-03" });
    expect(quincenal[1]).toMatchObject({ start_date: "2026-09-06", end_date: "2026-09-19" });
    const mensual = lastCompletedPayrollCycles({
      frequency: "mensual",
      referenceDate: "2026-10-04",
      count: 2,
    });
    expect(mensual[0]).toMatchObject({ start_date: "2026-09-06", end_date: "2026-10-03" });
    expect(mensual[1]).toMatchObject({ start_date: "2026-08-09", end_date: "2026-09-05" });
    // Sin cadencia no hay ciclos que ofrecer.
    expect(lastCompletedPayrollCycles({ frequency: null, referenceDate: "2026-10-04" })).toEqual([]);
  });

  it("el validador: domingo a sábado y 7, 14 o 28 días, EXACTO", () => {
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-30", endDate: "2026-09-05" })).toBe(true);
    expect(isPayrollCycleRange({ frequency: "quincenal", startDate: "2026-08-30", endDate: "2026-09-12" })).toBe(true);
    expect(isPayrollCycleRange({ frequency: "mensual", startDate: "2026-08-30", endDate: "2026-09-26" })).toBe(true);
    // Un lunes no empieza un ciclo, aunque dure 7 días.
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-31", endDate: "2026-09-06" })).toBe(false);
    // 8, 13 y 29 días no son un ciclo.
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-30", endDate: "2026-09-06" })).toBe(false);
    expect(isPayrollCycleRange({ frequency: "quincenal", startDate: "2026-08-30", endDate: "2026-09-11" })).toBe(false);
    expect(isPayrollCycleRange({ frequency: "mensual", startDate: "2026-08-30", endDate: "2026-09-27" })).toBe(false);
    // Domingo a sábado pero del largo de OTRA cadencia: tampoco es SU ciclo.
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-30", endDate: "2026-09-12" })).toBe(false);
    expect(isPayrollCycleRange({ frequency: "mensual", startDate: "2026-08-30", endDate: "2026-09-12" })).toBe(false);
    // Un rango corrido un día tampoco.
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-31", endDate: "2026-09-05" })).toBe(false);
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-08-30", endDate: "2026-09-04" })).toBe(false);
    // Sin cadencia, o con una fecha imposible, no hay ciclo.
    expect(isPayrollCycleRange({ frequency: null, startDate: "2026-08-30", endDate: "2026-09-05" })).toBe(false);
    expect(isPayrollCycleRange({ frequency: "semanal", startDate: "2026-02-30", endDate: "2026-09-05" })).toBe(false);
  });

  it("un ciclo cerrado paga la fracción ENTERA (28 días mensuales son un mes, no 30)", () => {
    // El mensual de 4 semanas son 28 días: con la base comercial de 30 pagaría
    // 28/30 y los 13 cierres del año no serían 13 sueldos. El ciclo manda.
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "semanal",
        periodFrequency: "semanal",
        startDate: "2026-08-30",
        endDate: "2026-09-05",
      }),
    ).toEqual({ amount: 375_000, basis: "cadence", fraction: 1 / 4 });
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "quincenal",
        periodFrequency: "quincenal",
        startDate: "2026-08-30",
        endDate: "2026-09-12",
      }).amount,
    ).toBe(750_000);
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "mensual",
        periodFrequency: "mensual",
        startDate: "2026-08-30",
        endDate: "2026-09-26",
      }).amount,
    ).toBe(1_500_000);
  });

  it("el período heredado sin cadencia sigue prorrateando por días, intacto", () => {
    // F7 no toca la vía F3/F5: un período con NULL (o un empleado sin cadencia)
    // conserva `prorateFixedSalary` como hasta hoy.
    const legacy = resolveFixedSalaryForPeriod({
      salaryFixed: 1_500_000,
      employeeFrequency: null,
      periodFrequency: null,
      startDate: "2026-08-30",
      endDate: "2026-09-05",
    });
    expect(legacy.basis).toBe("prorated");
    expect(legacy.amount).toBe(
      prorateFixedSalary({ salaryFixed: 1_500_000, startDate: "2026-08-30", endDate: "2026-09-05" }),
    );
  });
});

describe("payroll: los ciclos cerrados que faltan por liquidar (F9, función pura)", () => {
  /** Domingo 2026-10-04: el último ciclo CERRADO es el sábado 2026-10-03. */
  const REFERENCE = "2026-10-04";

  function period(start: string, end: string, frequency: string | null = null) {
    return { start_date: start, end_date: end, frequency };
  }

  function employee(full_name: string, pay_frequency: string | null, is_active = true) {
    return { full_name, pay_frequency, is_active };
  }

  /**
   * `count` ciclos semanales embaldosados desde el domingo 2026-08-09: es la
   * sede que viene liquidando semanal (el fixture del caso del dueño).
   */
  function weeklyPeriods(count: number) {
    const base = Date.UTC(2026, 7, 9);
    return Array.from({ length: count }, (_, index) => {
      const start = base + index * 7 * 86_400_000;
      return period(
        new Date(start).toISOString().slice(0, 10),
        new Date(start + 6 * 86_400_000).toISOString().slice(0, 10),
        "semanal",
      );
    });
  }

  it("nada pendiente cuando todos los ciclos cerrados tienen su liquidación", () => {
    const periods = [
      ...weeklyPeriods(8),
      period("2026-08-09", "2026-08-22", "quincenal"),
      period("2026-08-23", "2026-09-05", "quincenal"),
      period("2026-09-06", "2026-09-19", "quincenal"),
      period("2026-09-20", "2026-10-03", "quincenal"),
      period("2026-08-09", "2026-09-05", "mensual"),
      period("2026-09-06", "2026-10-03", "mensual"),
    ];
    expect(
      pendingPayrollSettlements({
        periods,
        employees: [employee("Ana", "semanal"), employee("Beto", "quincenal"), employee("Caro", "mensual")],
        referenceDate: REFERENCE,
      }),
    ).toEqual([]);
  });

  it("el caso del dueño: dos meses de semanal al día, el quincenal sin hacer", () => {
    const pending = pendingPayrollSettlements({
      periods: weeklyPeriods(8),
      employees: [
        employee("Ana", "semanal"),
        employee("Beto", "semanal"),
        employee("Caro", "quincenal"),
        employee("Dora", "quincenal"),
        employee("Elsa", "quincenal"),
      ],
      referenceDate: REFERENCE,
    });
    // La cadencia semanal está al día: no aparece ni una entrada suya.
    expect(pending.every((row) => row.frequency === "quincenal")).toBe(true);
    // Los tres ciclos quincenales más recientes sin liquidar, el más atrasado
    // primero. El cuarto (2026-08-09..08-22) queda fuera por el tope.
    expect(pending.map((row) => `${row.start_date}..${row.end_date}`)).toEqual([
      "2026-08-23..2026-09-05",
      "2026-09-06..2026-09-19",
      "2026-09-20..2026-10-03",
    ]);
    expect(pending[2]).toMatchObject({
      frequency: "quincenal",
      label: "20 sep – 3 oct 2026",
      employeeCount: 3,
      employeeNames: ["Caro", "Dora", "Elsa"],
    });
  });

  it("no reporta una cadencia que nadie cobra (ni la que no existe)", () => {
    const periods = [period("2026-09-27", "2026-10-03", "semanal")];
    expect(pendingPayrollSettlements({ periods, employees: [], referenceDate: REFERENCE })).toEqual([]);
    // Sin cadencia definida, o con una fuera del catálogo, es AUSENCIA de cadencia.
    expect(
      pendingPayrollSettlements({ periods, employees: [employee("Ana", null)], referenceDate: REFERENCE }),
    ).toEqual([]);
    expect(
      pendingPayrollSettlements({ periods, employees: [employee("Ana", "anual")], referenceDate: REFERENCE }),
    ).toEqual([]);
    // Un empleado dado de baja tampoco cuenta: dejaría el aviso abierto para siempre.
    expect(
      pendingPayrollSettlements({
        periods,
        employees: [employee("Ana", "quincenal", false)],
        referenceDate: REFERENCE,
      }),
    ).toEqual([]);
    // Control positivo del MISMO fixture: con gente de esa cadencia SÍ reporta.
    const withCadence = pendingPayrollSettlements({
      periods,
      employees: [employee("Ana", "quincenal")],
      referenceDate: REFERENCE,
    });
    expect(withCadence.map((row) => row.end_date)).toEqual(["2026-10-03"]);
  });

  it("sin ningún período no hay historia y no se reporta nada", () => {
    expect(
      pendingPayrollSettlements({
        periods: [],
        employees: [employee("Ana", "semanal"), employee("Beto", "mensual")],
        referenceDate: REFERENCE,
      }),
    ).toEqual([]);
    // Una fecha de referencia imposible tampoco inventa ciclos.
    expect(
      pendingPayrollSettlements({
        periods: weeklyPeriods(1),
        employees: [employee("Ana", "semanal")],
        referenceDate: "2026-02-30",
      }),
    ).toEqual([]);
  });

  it("el ciclo que todavía no cerró no se reporta", () => {
    const periods = [period("2026-08-09", "2026-08-15", "semanal")];
    const employees = [employee("Ana", "semanal")];
    // El domingo, el ciclo de la semana que cerró el sábado anterior ya está cerrado.
    expect(
      pendingPayrollSettlements({ periods, employees, referenceDate: "2026-10-04", limit: 20 }).map(
        (row) => row.end_date,
      ),
    ).toContain("2026-10-03");
    // El propio sábado del cierre el ciclo AÚN no cerró: manda el anterior.
    const saturday = pendingPayrollSettlements({
      periods,
      employees,
      referenceDate: "2026-10-03",
      limit: 20,
    });
    expect(saturday.map((row) => row.end_date)).not.toContain("2026-10-03");
    expect(saturday.map((row) => row.end_date)).toEqual([
      "2026-08-22",
      "2026-08-29",
      "2026-09-05",
      "2026-09-12",
      "2026-09-19",
      "2026-09-26",
    ]);
  });

  it("un ciclo ya cubierto no se reporta: coincidencia exacta o solape", () => {
    const employees = [employee("Ana", "semanal")];
    const base = [period("2026-08-09", "2026-08-15", "semanal")];
    // Coincidencia EXACTA: el ciclo 2026-09-13..09-19 ya está liquidado.
    expect(
      pendingPayrollSettlements({
        periods: [...base, period("2026-09-13", "2026-09-19", "semanal")],
        employees,
        referenceDate: REFERENCE,
        limit: 20,
      }).map((row) => row.start_date),
    ).not.toContain("2026-09-13");
    // SOLAPE parcial (un rango heredado que comparte días) tapa el ciclo igual.
    expect(
      pendingPayrollSettlements({
        periods: [...base, period("2026-09-20", "2026-09-21", "semanal")],
        employees,
        referenceDate: REFERENCE,
        limit: 20,
      }).map((row) => row.start_date),
    ).not.toContain("2026-09-20");
    // ADYACENTE no cubre: el ciclo siguiente sigue pendiente.
    const adjacent = pendingPayrollSettlements({
      periods: [...base, period("2026-08-16", "2026-08-22", "semanal")],
      employees,
      referenceDate: REFERENCE,
      limit: 20,
    });
    expect(adjacent.map((row) => row.start_date)).not.toContain("2026-08-16");
    expect(adjacent.map((row) => row.start_date)).toContain("2026-08-23");
    // Un período de OTRA cadencia NO tapa el ciclo: se superponen a propósito y
    // el aviso no puede callarse por eso.
    expect(
      pendingPayrollSettlements({
        periods: [...base, period("2026-09-27", "2026-10-03", "quincenal")],
        employees,
        referenceDate: REFERENCE,
        limit: 20,
      }).map((row) => row.start_date),
    ).toContain("2026-09-27");
    // Un período HEREDADO sin cadencia SÍ tapa el ciclo (cobertura corregida): no
    // lo acotaba ninguna cadencia, así que le pagó a toda la planta y esos días ya
    // salieron de la nómina. Reportarlo igual era el aviso gritando de más.
    expect(
      pendingPayrollSettlements({
        periods: [...base, period("2026-09-27", "2026-10-03", null)],
        employees,
        referenceDate: REFERENCE,
        limit: 20,
      }).map((row) => row.start_date),
    ).not.toContain("2026-09-27");
  });

  it("cobertura del período heredado: cubre el ciclo de CUALQUIER cadencia", () => {
    const legacy = [period("2026-09-13", "2026-09-19", null)];
    // El período heredado le pagó a toda la planta, así que el ciclo está liquidado
    // para las TRES cadencias: el aviso no puede seguir pidiendo esos días.
    for (const frequency of payFrequencySchema.options) {
      expect(
        isPayrollCycleSettled({
          periods: legacy,
          frequency,
          cycle: { start_date: "2026-09-13", end_date: "2026-09-19" },
        }),
        frequency,
      ).toBe(true);
    }
    // Compartir UN día ya cubre; el ADYACENTE no.
    expect(
      isPayrollCycleSettled({
        periods: legacy,
        frequency: "semanal",
        cycle: { start_date: "2026-09-19", end_date: "2026-09-25" },
      }),
    ).toBe(true);
    expect(
      isPayrollCycleSettled({
        periods: legacy,
        frequency: "semanal",
        cycle: { start_date: "2026-09-20", end_date: "2026-09-26" },
      }),
    ).toBe(false);
    // La cadena vacía es el MISMO cubo heredado (`coalesce(frequency, '')` de 063):
    // la ausencia de cadencia no puede leerse de dos maneras.
    expect(
      isPayrollCycleSettled({
        periods: [period("2026-09-13", "2026-09-19", "")],
        frequency: "semanal",
        cycle: { start_date: "2026-09-13", end_date: "2026-09-19" },
      }),
    ).toBe(true);
    // CONTROL NEGATIVO: sin ningún período que cubra, el ciclo sigue pendiente.
    expect(
      isPayrollCycleSettled({
        periods: [period("2026-08-09", "2026-08-15", "semanal")],
        frequency: "semanal",
        cycle: { start_date: "2026-09-13", end_date: "2026-09-19" },
      }),
    ).toBe(false);
  });

  it("el hueco a mitad de la historia es una entrada del aviso y NO está liquidado", () => {
    // Dos ciclos semanales cerrados con el de en medio sin liquidar (el borrador se
    // borró): es el ciclo que el aviso ofrece abrir para cerrar el hueco.
    const periods = [
      period("2026-09-06", "2026-09-12", "semanal"),
      period("2026-09-20", "2026-09-26", "semanal"),
    ];
    const gap = { start_date: "2026-09-13", end_date: "2026-09-19" };
    // No está liquidado: la guarda del diálogo (la MISMA regla) lo deja pasar.
    expect(isPayrollCycleSettled({ periods, frequency: "semanal", cycle: gap })).toBe(false);
    // Y el aviso lo reporta como pendiente, con su ciclo exacto.
    expect(
      pendingPayrollSettlements({
        periods,
        employees: [employee("Ana", "semanal")],
        referenceDate: REFERENCE,
        limit: 20,
      }).map((row) => `${row.start_date}..${row.end_date}`),
    ).toContain("2026-09-13..2026-09-19");
    // CONTROL del defecto corregido: el piso que se quitó SÍ habría rechazado ese
    // ciclo (2026-09-13 < 2026-09-27) con el error "no puede empezar antes de X".
    const oldFloor = nextPeriodStartDate(periods, "semanal");
    expect(oldFloor).toBe("2026-09-27");
    expect(gap.start_date < (oldFloor ?? "")).toBe(true);
    // CONTROL NEGATIVO de la guarda nueva: el mismo ciclo CON su período ya está
    // liquidado y sí se bloquea — no se debilitó la protección.
    expect(
      isPayrollCycleSettled({
        periods: [...periods, period("2026-09-13", "2026-09-19", "semanal")],
        frequency: "semanal",
        cycle: gap,
      }),
    ).toBe(true);
  });

  it("el tope es POR cadencia y el orden pone adelante lo más atrasado", () => {
    const periods = [period("2026-08-09", "2026-08-15", "semanal")];
    const employees = [
      employee("Ana", "semanal"),
      employee("Beto", "quincenal"),
      employee("Caro", "mensual"),
    ];
    const pending = pendingPayrollSettlements({ periods, employees, referenceDate: REFERENCE });
    expect(pending.map((row) => `${row.frequency} ${row.end_date}`)).toEqual([
      "quincenal 2026-09-05",
      "mensual 2026-09-05",
      "semanal 2026-09-19",
      "quincenal 2026-09-19",
      "semanal 2026-09-26",
      "semanal 2026-10-03",
      "quincenal 2026-10-03",
      "mensual 2026-10-03",
    ]);
    // Tres por cadencia (el tope) y dos del mensual (sólo dos ciclos caben en la
    // historia desde el 2026-08-09).
    const countOf = (frequency: string) => pending.filter((row) => row.frequency === frequency).length;
    expect(countOf("semanal")).toBe(PENDING_SETTLEMENT_LIMIT);
    expect(countOf("quincenal")).toBe(PENDING_SETTLEMENT_LIMIT);
    expect(countOf("mensual")).toBe(2);
    // `limit` acota POR CADENCIA y `0` apaga el aviso.
    expect(
      pendingPayrollSettlements({ periods, employees, referenceDate: REFERENCE, limit: 1 }).map(
        (row) => `${row.frequency} ${row.end_date}`,
      ),
    ).toEqual(["semanal 2026-10-03", "quincenal 2026-10-03", "mensual 2026-10-03"]);
    expect(
      pendingPayrollSettlements({ periods, employees, referenceDate: REFERENCE, limit: 0 }),
    ).toEqual([]);
  });

  it("cada entrada dice cuántos empleados cobran esa cadencia y hasta 3 nombres", () => {
    expect(PENDING_SETTLEMENT_NAME_LIMIT).toBe(3);
    const periods = [period("2026-08-09", "2026-08-15", "semanal")];
    const pending = pendingPayrollSettlements({
      periods,
      employees: [
        employee("Zoe", "mensual"),
        employee("Ana", "mensual"),
        employee("Beto", "mensual"),
        employee("Caro", "mensual"),
        employee("Dora", "mensual"),
      ],
      referenceDate: REFERENCE,
    });
    const mensual = pending.find((row) => row.frequency === "mensual") as PendingPayrollSettlement;
    expect(mensual.employeeCount).toBe(5);
    // Tres nombres, en orden determinista (no el orden en que llegó la planta).
    expect(mensual.employeeNames).toEqual(["Ana", "Beto", "Caro"]);
    // Con UN empleado la entrada lo nombra a él.
    expect(
      pendingPayrollSettlements({
        periods,
        employees: [employee("Ana", "mensual")],
        referenceDate: REFERENCE,
      })[0],
    ).toMatchObject({ employeeCount: 1, employeeNames: ["Ana"] });
  });

  it("isPayrollCycleSettled: cubre por cadencia y solape, nunca por cercanía", () => {
    const periods = [
      period("2026-09-13", "2026-09-19", "semanal"),
      period("2026-09-20", "2026-09-21", "semanal"),
      period("2026-09-27", "2026-10-03", null),
    ];
    expect(
      isPayrollCycleSettled({
        periods,
        frequency: "semanal",
        cycle: { start_date: "2026-09-13", end_date: "2026-09-19" },
      }),
    ).toBe(true);
    expect(
      isPayrollCycleSettled({
        periods,
        frequency: "semanal",
        cycle: { start_date: "2026-09-20", end_date: "2026-09-26" },
      }),
    ).toBe(true);
    // Vecino por un día (rangos ADYACENTES) no es solape.
    expect(
      isPayrollCycleSettled({
        periods,
        frequency: "semanal",
        cycle: { start_date: "2026-08-30", end_date: "2026-09-05" },
      }),
    ).toBe(false);
    // Otro ciclo de OTRA cadencia no cubre: se superponen a propósito.
    expect(
      isPayrollCycleSettled({
        periods: [period("2026-09-20", "2026-10-03", "quincenal")],
        frequency: "semanal",
        cycle: { start_date: "2026-09-27", end_date: "2026-10-03" },
      }),
    ).toBe(false);
    // Un período HEREDADO sin cadencia SÍ cubre (aserción MOVIDA: antes se esperaba
    // `false`; el período le pagó a todo el plantel, así que esos días ya se
    // pagaron y el ciclo no puede seguir reportándose como pendiente).
    expect(
      isPayrollCycleSettled({
        periods,
        frequency: "semanal",
        cycle: { start_date: "2026-09-27", end_date: "2026-10-03" },
      }),
    ).toBe(true);
    expect(
      isPayrollCycleSettled({
        periods,
        frequency: null,
        cycle: { start_date: "2026-09-13", end_date: "2026-09-19" },
      }),
    ).toBe(false);
  });
});

describe("payroll: el resumen de la sede trae los ciclos pendientes (F9, servicio)", () => {
  const SEDE = payrollPagedStub.SEDE_ID;

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("la lectura de la página incluye el atraso y la gente de esa cadencia", async () => {
    // Reloj congelado en el domingo 2026-10-04 (Bogotá): el último ciclo cerrado
    // es el sábado 2026-10-03. Sin congelarlo, la aserción dependería del día real.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T15:00:00.000Z"));
    try {
      payrollPagedStub.tables.payroll_periods = [
        {
          id: "periodo-1",
          sede_id: SEDE,
          start_date: "2026-09-27",
          end_date: "2026-10-03",
          frequency: "semanal",
          status: "cerrado",
          created_by: "u-1",
          closed_at: null,
          created_at: "2026-09-27T00:00:00.000Z",
        },
      ];
      payrollPagedStub.tables.employees = [
        {
          id: "emp-1",
          sede_id: SEDE,
          user_id: null,
          full_name: "Ana López",
          employee_code: "E-01",
          document: "1000",
          phone: null,
          position: null,
          payout_mode: "normal",
          email: null,
          birth_date: null,
          pay_type: "fijo",
          pay_frequency: "quincenal",
          salary_fixed: 1500000,
          commission_percent: null,
          is_active: true,
        },
      ];

      const overview = await listPayrollOverview(SEDE);

      // El semanal está al día (su período lo cubre); el quincenal no.
      expect(overview.pendingSettlements).toEqual([
        {
          frequency: "quincenal",
          start_date: "2026-09-20",
          end_date: "2026-10-03",
          label: "20 sep – 3 oct 2026",
          employeeCount: 1,
          employeeNames: ["Ana López"],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sin períodos no hay historia: el resumen no inventa pendientes", async () => {
    payrollPagedStub.tables.payroll_periods = [];
    payrollPagedStub.tables.employees = [];
    const overview = await listPayrollOverview(SEDE);
    expect(overview.pendingSettlements).toEqual([]);
  });
});

describe("payroll: la cadencia del período, exclusión y cubo de solape (F4, función pura)", () => {
  it("el cubo de cadencia es `coalesce(frequency, '')`: NULL y undefined son la cadena vacía", () => {
    expect(periodCadenceBucket(null)).toBe("");
    expect(periodCadenceBucket(undefined)).toBe("");
    expect(periodCadenceBucket("semanal")).toBe("semanal");
    expect(periodCadenceBucket("mensual")).toBe("mensual");
  });

  it("excluye SÓLO cuando las dos cadencias están definidas y difieren", () => {
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: "mensual", periodFrequency: "semanal" }),
    ).toBe(true);
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: "semanal", periodFrequency: "quincenal" }),
    ).toBe(true);
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: "semanal", periodFrequency: "semanal" }),
    ).toBe(false);
    // Cualquiera de los dos lados sin cadencia conserva el comportamiento de hoy.
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: null, periodFrequency: "semanal" }),
    ).toBe(false);
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: "semanal", periodFrequency: null }),
    ).toBe(false);
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: null, periodFrequency: null }),
    ).toBe(false);
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: undefined, periodFrequency: undefined }),
    ).toBe(false);
    // Un valor fuera del catálogo es AUSENCIA, no otra cadencia.
    expect(
      periodExcludesEmployeeByCadence({ employeeFrequency: "anual", periodFrequency: "semanal" }),
    ).toBe(false);
  });
});

describe("payroll: la regla del mixto, el mayor contra los porcentajes (F3, función pura)", () => {
  it("los dos casos del dueño, con su aritmética", () => {
    // Básico 300.000 con 400.000 de porcentajes → 400.000.
    const over = resolveMixedBlock({ baseFixed: 300_000, fixedCommissions: 0, servicePercent: 400_000 });
    expect(over).toEqual({ absorbed: 300_000, commissions: 100_000 });
    expect(300_000 + over.commissions).toBe(400_000);
    // Básico 300.000 con 200.000 → 300.000 (los porcentajes se absorben).
    const below = resolveMixedBlock({ baseFixed: 300_000, fixedCommissions: 0, servicePercent: 200_000 });
    expect(below).toEqual({ absorbed: 200_000, commissions: 0 });
    expect(300_000 + below.commissions).toBe(300_000);
  });

  it("las comisiones fijas por producto NO entran al máximo y se suman aparte", () => {
    const over = resolveMixedBlock({ baseFixed: 300_000, fixedCommissions: 50_000, servicePercent: 400_000 });
    expect(over.commissions).toBe(150_000);
    expect(300_000 + over.commissions).toBe(450_000); // max(300,400) + 50
    const below = resolveMixedBlock({ baseFixed: 300_000, fixedCommissions: 50_000, servicePercent: 200_000 });
    expect(below.commissions).toBe(50_000);
    expect(300_000 + below.commissions).toBe(350_000); // max(300,200) + 50
  });

  it("la línea de absorbido es negativa y conserva la forma del detalle", () => {
    const line = mixedAbsorbedDetailLine({ employeeId: "emp-1", absorbed: 200_000 });
    expect(line.commission).toBe(-200_000);
    expect(line.item_type).toBe(MIXED_ABSORBED_ITEM_TYPE);
    expect(line.item_id).toBe(MIXED_ABSORBED_ITEM_TYPE);
    expect(line.invoice_id).toBe(MIXED_ABSORBED_ITEM_TYPE);
    expect(buildEmployeeDetail([line]).commissions).toBe(-200_000);
  });
});

describe("payroll: el piso del período nuevo, función pura (regla del dueño 2026-10-01)", () => {
  it("sin períodos no hay piso: el primero es libre", () => {
    expect(nextPeriodStartDate([])).toBeNull();
  });

  it("`null` es SOLO para la lista vacía: con cualquier período hay piso", () => {
    const nonEmpty: Array<Array<{ start_date: string; end_date: string }>> = [
      [{ start_date: "2026-09-01", end_date: "2026-09-07" }],
      [
        { start_date: "2026-09-01", end_date: "2026-09-07" },
        { start_date: "2026-09-08", end_date: "2026-09-14" },
      ],
      [{ start_date: "2026-12-31", end_date: "2026-12-31" }],
    ];
    for (const periods of nonEmpty) {
      expect(nextPeriodStartDate(periods), JSON.stringify(periods)).not.toBeNull();
    }
  });

  it("un solo período: el piso es el día siguiente a su fin", () => {
    expect(nextPeriodStartDate([{ start_date: "2026-09-01", end_date: "2026-09-07" }])).toBe(
      "2026-09-08",
    );
  });

  it("varios desordenados: manda el fin MÁS LEJANO, no el último de la lista", () => {
    // El más lejano (2026-09-30) está en la tercera fila, no en la última.
    expect(
      nextPeriodStartDate([
        { start_date: "2026-09-15", end_date: "2026-09-21" },
        { start_date: "2026-09-01", end_date: "2026-09-07" },
        { start_date: "2026-09-22", end_date: "2026-09-30" },
        { start_date: "2026-09-08", end_date: "2026-09-14" },
      ]),
    ).toBe("2026-10-01");
  });

  it("períodos contiguos: el piso sigue al último día liquidado (no lo repite)", () => {
    expect(
      nextPeriodStartDate([
        { start_date: "2026-09-01", end_date: "2026-09-07" },
        { start_date: "2026-09-08", end_date: "2026-09-14" },
      ]),
    ).toBe("2026-09-15");
  });

  it("con un hueco: el piso NO es el hueco, es el día siguiente al último fin", () => {
    expect(
      nextPeriodStartDate([
        { start_date: "2026-09-01", end_date: "2026-09-07" },
        { start_date: "2026-09-20", end_date: "2026-09-26" },
      ]),
    ).toBe("2026-09-27");
  });

  it("borde de mes: el fin de marzo salta al 1 de abril", () => {
    expect(nextPeriodStartDate([{ start_date: "2026-03-01", end_date: "2026-03-31" }])).toBe(
      "2026-04-01",
    );
    expect(nextPeriodStartDate([{ start_date: "2026-01-01", end_date: "2026-01-31" }])).toBe(
      "2026-02-01",
    );
  });

  it("borde de año: el 31 de diciembre salta al 1 de enero del año siguiente", () => {
    expect(nextPeriodStartDate([{ start_date: "2026-12-25", end_date: "2026-12-31" }])).toBe(
      "2027-01-01",
    );
    // Y el año bisiesto no se salta febrero.
    expect(nextPeriodStartDate([{ start_date: "2028-02-01", end_date: "2028-02-28" }])).toBe(
      "2028-02-29",
    );
  });

  it("no muta la entrada", () => {
    const periods = [
      { start_date: "2026-09-01", end_date: "2026-09-07" },
      { start_date: "2026-12-31", end_date: "2026-12-31" },
    ];
    const snapshot = JSON.parse(JSON.stringify(periods));
    nextPeriodStartDate(periods);
    expect(periods).toEqual(snapshot);
  });

  it("F4: el piso es de la MISMA cadencia; otro ciclo no lo impone", () => {
    const periods = [
      { start_date: "2026-09-01", end_date: "2026-09-30", frequency: "mensual" },
      { start_date: "2026-09-01", end_date: "2026-09-07", frequency: "semanal" },
    ];
    // El semanal que sigue: día después del último semanal. El mensual llega
    // más lejos, pero puede superponerse A PROPÓSITO y no impone piso.
    expect(nextPeriodStartDate(periods, "semanal")).toBe("2026-09-08");
    // El mensual: día después del último mensual.
    expect(nextPeriodStartDate(periods, "mensual")).toBe("2026-10-01");
    // Un ciclo sin períodos no tiene piso (su primero es libre).
    expect(nextPeriodStartDate(periods, "quincenal")).toBeNull();
  });

  it("F4: sin cadencia (o sin decirla) se acotan solo los períodos sin cadencia", () => {
    const periods = [
      { start_date: "2026-09-01", end_date: "2026-09-07" },
      { start_date: "2026-09-01", end_date: "2026-09-30", frequency: "mensual" },
    ];
    // El cubo vacío es el de los períodos heredados: solo esos acotan.
    expect(nextPeriodStartDate(periods)).toBe("2026-09-08");
    expect(nextPeriodStartDate(periods, null)).toBe("2026-09-08");
    expect(nextPeriodStartDate(periods, "")).toBe("2026-09-08");
  });
});

describe("payroll-client: el diálogo de apertura DERIVADO (F10, guarda de fuente)", () => {
  const client = readFileSync(join(process.cwd(), "app", "payroll", "payroll-client.tsx"), "utf8");

  /**
   * El marcado del diálogo de apertura, recortado a SU contenido: la guarda de
   * "no hay fechas ni cadencia" sólo tiene sentido sobre el diálogo (la pantalla
   * sí tiene el campo de la fecha de inicio de la nómina, que es la
   * CONFIGURACIÓN de la sede, no el rango de un período).
   */
  const dialog = (): string => {
    const start = client.indexOf("<DialogTitle>Abrir período</DialogTitle>");
    expect(start, "título del diálogo de apertura").toBeGreaterThan(-1);
    const end = client.indexOf("</DialogContent>", start);
    expect(end, "cierre del diálogo de apertura").toBeGreaterThan(start);
    return client.slice(start, end);
  };

  it("el diálogo NO pregunta: sin selector de cadencia, sin ciclo libre y sin campo de fecha", () => {
    const open = dialog();
    // F10: la cadencia y el rango ya NO son una pregunta del diálogo.
    expect(open).not.toContain("Cadencia del período");
    expect(open).not.toContain('id="payroll-open-frequency"');
    expect(open).not.toContain('id="payroll-open-cycle"');
    // Ningún `<select>`: la única entrada es la lista de ciclos pendientes.
    expect(open).not.toContain("<select");
    // Ningún campo de fecha dentro del diálogo, ni un `min`/`max` con fecha.
    expect(open).not.toContain('type="date"');
    expect(open).not.toMatch(/min="20\d{2}-\d{2}-\d{2}"/);
    expect(open).not.toMatch(/max="20\d{2}-\d{2}-\d{2}"/);
    // El estado viejo del selector tampoco vive: sin él no hay ciclo que fijar.
    for (const removed of [
      "openFrequency",
      "openCycleEnd",
      "pinnedCycle",
      "cycleMarker",
      "lastCompletedPayrollCycles",
      "payrollCycleRange(",
      "OPEN_PAY_FREQUENCY_OPTIONS",
    ]) {
      expect(client, removed).not.toContain(removed);
    }
    // Y el ciclo SÍ sigue a la vista, como lista que se confirma: la etiqueta
    // del legend y la de cada opción.
    expect(open).toContain("Ciclo a liquidar");
    expect(open).toContain("{`Ciclo ${entry.frequency} ${entry.label}`}");
    expect(open).toContain('name="payroll-open-target"');
    // El envío sigue llevando cadencia + cierre, sin rango escrito.
    expect(client).toContain("frequency: openTarget.frequency,");
    expect(client).toContain("cycle_end_date: openTarget.end_date,");
    expect(client).not.toContain('id="payroll-open-start"');
    expect(client).not.toContain('id="payroll-open-end"');
    expect(client).not.toContain('label: "Sin cadencia"');
  });

  it("el rango sale del ÚNICO validador, con la fecha de arranque de la sede", () => {
    // La MISMA función pura que aplica el servicio antes del INSERT: un ciclo
    // COMPLETO o el primer ciclo recortado a la fecha. El cliente no calcula su
    // propia forma de rango.
    expect(client).toMatch(
      /const openResolution =\s*openTarget === null\s*\? null\s*: resolveOpenPayrollRange\(\{\s*frequency: openTarget\.frequency,\s*cycleEndDate: openTarget\.end_date,\s*payrollStartDate,\s*periods,\s*\}\);/,
    );
    // El rango mostrado y el enviado salen de esa resolución.
    expect(client).toContain("const startDate = openResolution?.ok ? openResolution.start_date : \"\";");
    expect(client).toContain("const endDate = openResolution?.ok ? openResolution.end_date : \"\";");
    expect(client).toContain("openResolution.trimmed");
    // G3b: el control de la fecha salió de la pantalla (la configura la
    // plataforma). Lo que queda es la LECTURA que el diálogo usa para acotar.
    expect(client).not.toContain('id="payroll-start-date"');
    expect(client).toContain("isRangeBeforePayrollStart({ payrollStartDate, startDate, endDate })");
  });

  it("la única entrada es el aviso: el ciclo pendiente queda ELEGIDO y se confirma", () => {
    // Del aviso se llega con el ciclo de ESA entrada; el botón "Abrir período"
    // abre en el más atrasado (la lista ya viene ordenada así) y si no hay
    // ninguno lo dice en vez de ofrecer algo arbitrario.
    expect(client).toContain("function openPendingSettlement(entry: PendingPayrollSettlement) {");
    expect(client).toContain("setOpenTarget(entry);");
    expect(client).toContain("setOpenTarget(pendingSettlements[0] ?? null);");
    expect(client).toContain("onClick={() => openPendingSettlement(entry)}");
    expect(client).toContain("No hay ciclos cerrados sin liquidar en esta sede: no hay período que abrir.");
    // Confirmar no elige nada: el botón se bloquea sin ciclo pendiente elegido.
    expect(client).toContain("disabled={busy || openTarget === null}");
    // El diálogo NO puede abrir un rango que no salga de un ciclo pendiente.
    const open = dialog();
    expect(open).toContain("pendingSettlements.map((entry) => (");
    expect(open).not.toContain("openResolution.start_date =");
  });

  it("F9/F10: el envío bloquea con la regla de LIQUIDACIÓN y la de la FECHA de arranque", () => {
    // La guarda del envío (`handleOpen`) repite las DOS verdades del ciclo
    // elegido con las MISMAS funciones puras del aviso y del servicio, así el
    // diálogo no puede contradecir a quien lo abrió.
    const submit = client.slice(
      client.indexOf("async function handleOpen"),
      client.indexOf("function closeOpenDialog"),
    );
    expect(submit.length).toBeGreaterThan(500);
    expect(submit).toMatch(
      /isPayrollCycleSettled\(\{\s*periods,\s*frequency: openTarget\.frequency,\s*cycle: \{ start_date: startDate, end_date: endDate \},\s*\}\)/,
    );
    expect(submit).toContain("Este ciclo ya tiene su liquidación para la cadencia elegida");
    // F10: y el rango anterior al arranque se rechaza NOMBRANDO LA FECHA, con la
    // MISMA regla que el aviso y el servicio (`isRangeBeforePayrollStart`).
    expect(submit).toMatch(
      /isRangeBeforePayrollStart\(\{ payrollStartDate, startDate, endDate \}\)/,
    );
    expect(submit).toContain(
      'setOpenError(\n        `El período no puede empezar antes del ${payrollStartDate}: la nómina de esta sede arranca ese día y nada anterior existe para el sistema.`,\n      );',
    );
    // El piso del "día siguiente al último período" YA NO existe en ninguna forma.
    expect(submit).not.toContain("nextPeriodStartDate");
    expect(submit).not.toContain("minimumStart");
    // CONTROL NEGATIVO: el detector no es un sello de goma — el texto VIEJO trae
    // el piso prohibido y ninguna de las dos reglas que la guarda exige.
    const viejo = [
      "const minimumStart = nextPeriodStartDate(periods, openFrequency);",
      'setOpenError(`El período no puede empezar antes del ${formatFullDate(minimumStart)}: ese es el día siguiente al fin del último período registrado de esta cadencia.`);',
    ].join("\n");
    expect(viejo).not.toContain("isPayrollCycleSettled({");
    expect(viejo).not.toContain("isRangeBeforePayrollStart(");
    expect(viejo).toContain("minimumStart");
    // El botón que decide el envío vive en el diálogo: sin ciclo pendiente no hay
    // envío posible.
    expect(client).toContain("disabled={busy || openTarget === null}");
  });

  it("control negativo: el marcado VIEJO (dos selectores) no pasa las guardas nuevas", () => {
    const viejo = [
      '<DialogTitle>Abrir período</DialogTitle>',
      '<DialogDescription>Elija la cadencia y el ciclo.</DialogDescription>',
      "Cadencia del período",
      '<select id="payroll-open-frequency" value={openFrequency}>',
      '{OPEN_PAY_FREQUENCY_OPTIONS.map((option) => (',
      '<select id="payroll-open-cycle" value={openCycleEnd}>',
      '{openCycleOptions.map((option) => (',
      '<option key={option.end_date} value={option.end_date}>',
      '{option.label}',
      '{cycleMarker(option)}',
      '</select>',
      'id="payroll-open-start"',
      'type="date"',
      '</DialogContent>',
    ].join("\n");
    // El viejo trae EXACTAMENTE lo que la guarda prohíbe dentro del diálogo...
    expect(viejo).toContain("Cadencia del período");
    expect(viejo).toContain('<select id="payroll-open-cycle"');
    expect(viejo).toContain('type="date"');
    expect(viejo).toContain("cycleMarker");
    expect(viejo).toContain("openFrequency");
    // ...y NINGUNA de las señales que la guarda exige.
    expect(viejo).not.toContain('name="payroll-open-target"');
    expect(viejo).not.toContain("Ciclo a liquidar");
    expect(viejo).not.toContain("setOpenTarget(entry);");
    expect(viejo).not.toContain("resolveOpenPayrollRange({");
    // Y el fuente REAL no los tiene (control positivo del mismo detector).
    const open = dialog();
    expect(open).not.toContain('id="payroll-open-cycle"');
    expect(open).not.toContain("cycleMarker");
    expect(open).toContain('name="payroll-open-target"');
  });

  it("control negativo: nada de piso vacío, literal ni prefill hardcodeado", () => {
    expect(client).not.toMatch(/min=\{undefined\}/);
    expect(client).not.toMatch(/setStartDate\("20\d{2}-\d{2}-\d{2}"\)/);
    // No conviven dos implementaciones de "día siguiente".
    expect(client).not.toContain("function nextDay(");
    expect(client).not.toContain("latestEndDate(");
    expect(client).not.toContain("lastCompletedPayrollCycles(");
    expect(client).not.toContain("nextPeriodStartDate(");
  });
});

describe("payroll: un día se nomina una sola vez al ABRIR el período (PR1)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const OTHER_SEDE = "99999999-9999-4999-8999-999999999999";

  function seedPeriods(rows: Array<Record<string, unknown>>) {
    payrollPagedStub.tables = {
      payroll_periods: rows,
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  function periodRow(
    id: string,
    start: string,
    end: string,
    status = "borrador",
    sedeId = payrollPagedStub.SEDE_ID,
    frequency: string | null = null,
  ) {
    return {
      id,
      sede_id: sedeId,
      start_date: start,
      end_date: end,
      frequency,
      status,
      created_by: "u-1",
      closed_at: status === "cerrado" ? "2026-09-08T00:00:00.000Z" : null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
  }

  const periodInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_periods");

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("rechaza abrir un ciclo que comparte días con otro de la sede", async () => {
    seedPeriods([periodRow("periodo-1", "2026-08-01", "2026-09-30", "borrador", payrollPagedStub.SEDE_ID, "semanal")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    // El mensaje nombra los DOS rangos: el DERIVADO del ciclo y el que estorba.
    const message = (failure as PayrollError).message;
    expect(message).toContain("2026-08-30 a 2026-09-05");
    expect(message).toContain("2026-08-01 a 2026-09-30");
    // Nada se escribió: la guarda corre ANTES del INSERT.
    expect(periodInserts()).toHaveLength(0);
  });

  it("compartir UN solo día ya bloquea", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-05", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP" });
  });

  it("también bloquea contra un período CERRADO: esos días ya se pagaron", async () => {
    seedPeriods([periodRow("periodo-1", "2026-08-30", "2026-09-05", "cerrado", payrollPagedStub.SEDE_ID, "semanal")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    expect((failure as PayrollError).message).toContain("2026-08-30 a 2026-09-05");
  });

  it("control negativo: el ciclo ADYACENTE (el siguiente) se abre", async () => {
    seedPeriods([periodRow("periodo-1", "2026-08-23", "2026-08-29", "borrador", payrollPagedStub.SEDE_ID, "semanal")]);

    const created = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    );

    expect(created).toMatchObject({
      start_date: "2026-08-30",
      end_date: "2026-09-05",
      frequency: "semanal",
      status: "borrador",
      sede_id: payrollPagedStub.SEDE_ID,
    });
    expect(periodInserts()).toHaveLength(1);
  });

  it("el solape bloquea contra CUALQUIER período sembrado del rango", async () => {
    // Un día se nomina una sola vez: la installation tiene UNA sede, así que
    // cualquier período que comparta días estorba, sea del tenant que sea.
    seedPeriods([periodRow("periodo-1", "2026-08-30", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    expect((failure as PayrollError).message).toContain("2026-08-30 a 2026-09-05");
    expect(periodInserts()).toHaveLength(0);
  });

  it("F7: persiste la cadencia y el rango DERIVADO del ciclo", async () => {
    const cycles = [
      { frequency: "semanal", cycle_end_date: "2026-09-05", start_date: "2026-08-30", end_date: "2026-09-05" },
      { frequency: "quincenal", cycle_end_date: "2026-09-12", start_date: "2026-08-30", end_date: "2026-09-12" },
      { frequency: "mensual", cycle_end_date: "2026-09-26", start_date: "2026-08-30", end_date: "2026-09-26" },
    ] as const;
    for (const cycle of cycles) {
      seedPeriods([]);
      payrollPagedStub.inserts.length = 0;

      const created = await openPayrollPeriod(cycle, ACTOR);

      expect(created, cycle.frequency).toMatchObject({
        frequency: cycle.frequency,
        start_date: cycle.start_date,
        end_date: cycle.end_date,
      });
      const inserts = periodInserts();
      expect(inserts, cycle.frequency).toHaveLength(1);
      expect(inserts[0].payload, cycle.frequency).toMatchObject({
        frequency: cycle.frequency,
        start_date: cycle.start_date,
        end_date: cycle.end_date,
      });
    }
  });

  it("F7: un período NUEVO sin cadencia se rechaza (NULL es solo dato heredado)", async () => {
    seedPeriods([]);

    for (const body of [
      { cycle_end_date: "2026-09-05" },
      { frequency: null, cycle_end_date: "2026-09-05" },
    ]) {
      const failure: unknown = await openPayrollPeriod(body, ACTOR).catch((error: unknown) => error);
      expect(failure, JSON.stringify(body)).toBeInstanceOf(PayrollError);
      expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    }
    expect(periodInserts()).toHaveLength(0);
  });

  it("F4: rechaza una cadencia fuera del catálogo cerrado (nada se escribe)", async () => {
    seedPeriods([]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "anual", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(periodInserts()).toHaveLength(0);
  });

  it("F7: rechaza un rango del cliente que no coincide con su ciclo", async () => {
    seedPeriods([]);

    // Corrido un día: el ciclo derivado empieza el domingo 2026-08-30.
    const shifted: unknown = await openPayrollPeriod(
      {
        frequency: "semanal",
        cycle_end_date: "2026-09-05",
        start_date: "2026-08-31",
        end_date: "2026-09-05",
      },
      ACTOR,
    ).catch((error: unknown) => error);
    expect(shifted).toBeInstanceOf(PayrollError);
    expect(shifted).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(periodInserts()).toHaveLength(0);

    // Y el rango CORRECTO se acepta: el cliente puede mandarlo, pero el ciclo
    // derivado sigue siendo la única fuente de verdad.
    const created = await openPayrollPeriod(
      {
        frequency: "semanal",
        cycle_end_date: "2026-09-05",
        start_date: "2026-08-30",
        end_date: "2026-09-05",
      },
      ACTOR,
    );
    expect(created).toMatchObject({ start_date: "2026-08-30", end_date: "2026-09-05" });
    expect(periodInserts()).toHaveLength(1);
  });

  it("F7: rechaza un cierre que no es sábado (nada se escribe)", async () => {
    seedPeriods([]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-04" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(periodInserts()).toHaveLength(0);
  });

  it("F7: la PRIMERA liquidación de una sede usa el mismo control de ciclo", async () => {
    seedPeriods([]);

    const created = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    );

    expect(created).toMatchObject({
      start_date: "2026-08-30",
      end_date: "2026-09-05",
      frequency: "semanal",
    });
    expect(periodInserts()).toHaveLength(1);
  });

  it("F4: dos cadencias DISTINTAS de la misma sede pueden compartir días", async () => {
    seedPeriods([
      periodRow("periodo-semanal", "2026-08-30", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal"),
    ]);

    const created = await openPayrollPeriod(
      { frequency: "mensual", cycle_end_date: "2026-09-26" },
      ACTOR,
    );

    expect(created).toMatchObject({
      start_date: "2026-08-30",
      end_date: "2026-09-26",
      frequency: "mensual",
    });
    expect(periodInserts()).toHaveLength(1);
  });

  it("F9: una cadencia nueva contra un período heredado superpuesto se rechaza", async () => {
    // Aserción MOVIDA: este mismo caso se abría antes con impunidad. El heredado no
    // lo acotaba ningún ciclo, así que le pagó el fijo a todo el plantel: abrir
    // encima un rango con cadencia pagaría dos veces los mismos días.
    seedPeriods([periodRow("periodo-heredado", "2026-08-30", "2026-09-05")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    const message = (failure as PayrollError).message;
    // El mensaje nombra el rango pedido, el período heredado y POR QUÉ se rechaza.
    expect(message).toContain("2026-08-30 a 2026-09-05");
    expect(message).toContain("no tiene cadencia");
    expect(message).toContain("pagó el fijo a todo el plantel");
    expect(message).toContain("dos veces los mismos días");
    // Nada se escribió: la guarda corre ANTES del INSERT.
    expect(periodInserts()).toHaveLength(0);
    // El cubo vacío sigue siendo el cubo del heredado (la regla de 063 no se movió).
    expect(periodCadenceBucket(null)).toBe("");
  });

  it("F9: heredado contra heredado sigue en el MISMO cubo (protección conservada)", async () => {
    // Un período NUEVO sin cadencia no existe —se rechaza con VALIDATION—, así que
    // dos heredados no pueden apilarse por la apertura: su exclusión mutua sigue
    // siendo la restricción de 063, que pone los dos en el cubo vacío. La guarda
    // nueva NO toca esa regla.
    seedPeriods([periodRow("periodo-heredado-1", "2026-08-30", "2026-09-05")]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: null, cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(periodInserts()).toHaveLength(0);
    // Dos períodos sin cadencia comparten el cubo vacío y se solapan: la base (063)
    // los sigue rechazando entre sí, como siempre.
    expect(periodCadenceBucket(null)).toBe(periodCadenceBucket(undefined));
    expect(
      rangesOverlap(
        { start_date: "2026-08-30", end_date: "2026-09-05" },
        { start_date: "2026-09-01", end_date: "2026-09-10" },
      ),
    ).toBe(true);
  });

  it("F9: dos cadencias DISTINTAS siguen superponiéndose (la guarda nueva no las toca)", async () => {
    seedPeriods([
      periodRow("periodo-semanal", "2026-08-30", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal"),
    ]);

    const created = await openPayrollPeriod(
      { frequency: "quincenal", cycle_end_date: "2026-09-12" },
      ACTOR,
    );

    expect(created).toMatchObject({
      start_date: "2026-08-30",
      end_date: "2026-09-12",
      frequency: "quincenal",
    });
    expect(periodInserts()).toHaveLength(1);

    // CONTROL NEGATIVO: con un heredado presente, un ciclo ADYACENTE (sin días en
    // común) sigue abriéndose: la guarda es por SOLAPE, no por la mera existencia
    // del período heredado.
    seedPeriods([periodRow("periodo-heredado", "2026-08-23", "2026-08-29")]);
    payrollPagedStub.inserts.length = 0;

    const adjacent = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    );

    expect(adjacent).toMatchObject({ start_date: "2026-08-30", end_date: "2026-09-05" });
    expect(periodInserts()).toHaveLength(1);
  });

  it("F4/F7: la MISMA cadencia bloquea el MISMO ciclo (segunda liquidación del ciclo)", async () => {
    seedPeriods([
      periodRow("periodo-1", "2026-08-30", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal"),
    ]);

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    expect((failure as PayrollError).message).toContain("2026-08-30 a 2026-09-05");
    expect(periodInserts()).toHaveLength(0);
  });

  it("una carrera perdida (23P01 de la restricción) es el MISMO error de negocio", async () => {
    seedPeriods([]);
    // La otra transacción ganó entre la lectura y el INSERT: la base responde
    // como responde una restricción de exclusión violada.
    payrollPagedStub.insertError = { table: "payroll_periods", code: "23P01" };

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-12" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    // No es un fallo interno disfrazado: la carrera tiene su propio mensaje.
    expect((failure as PayrollError).code).not.toBe("INTERNAL");
  });

  it("si la lectura de períodos no se completa, ABRIR se detiene (no decide con menos)", async () => {
    seedPeriods([periodRow("periodo-1", "2026-08-30", "2026-09-05", "borrador", payrollPagedStub.SEDE_ID, "semanal")]);
    // La primera página de la lectura de períodos falla: con el conjunto
    // recortado la guarda podría no ver el período que estorba.
    payrollPagedStub.failAt = { payroll_periods: [1] };

    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-05" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "READ_INCOMPLETE" });
    // No se abrió nada con una lectura incompleta.
    expect(periodInserts()).toHaveLength(0);
  });
});

// --------------------------------- nómina extraordinaria individual (PA-2a) ---

/**
 * PA-2a — nómina individual por caso extraordinario (despido, renuncia,
 * emergencia).
 *
 * EL HUECO (medido, no supuesto):
 *   - `payPayrollItem` exige un período en BORRADOR (`assertDraftPeriod`, ver
 *     el bloque "periodo cerrado es inmutable"): una renuncia un miércoles,
 *     por días que ya están dentro de un período CERRADO, no tiene camino.
 *   - `payroll_payments` no tiene columna de motivo (007_payroll.sql) y
 *     `AUDIT_ACTIONS` no tiene acción de pago: nada registra POR QUÉ salió la
 *     plata. Por eso `payPayrollItem` no escribe auditoría.
 *
 * RED: los tres huecos, uno por uno. El primer `it` de este bloque es el RED
 * literal; el segundo fija el defecto que motiva el cambio.
 */
describe("payroll: nómina extraordinaria individual (PA-2a)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const OTHER_SEDE = "99999999-9999-4999-8999-999999999999";
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const METHOD = {
    id: "pm-efectivo",
    sede_id: payrollPagedStub.SEDE_ID,
    code: "efectivo",
    name: "Efectivo",
    is_active: true,
    kind: "efectivo",
  };

  function employeeRow(salaryFixed: number | null, sedeId = payrollPagedStub.SEDE_ID) {
    return {
      id: EMPLOYEE_ID,
      sede_id: sedeId,
      user_id: null,
      full_name: "Empleada de prueba",
      employee_code: "E-01",
      document: "1000000001",
      phone: null,
      position: "Ventas",
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: salaryFixed,
      commission_percent: null,
      is_active: true,
    };
  }

  /**
   * El caso que motiva PA-2a: un período CERRADO (los días ya se pagaron) con
   * la empleada que renuncia. El pago extraordinario tiene que entrar igual.
   */
  function seedClosedPeriod(salaryFixed: number | null = 1_400_000) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          status: "cerrado",
          created_by: "u-admin-1",
          closed_at: "2026-09-30T23:00:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      employees: [employeeRow(salaryFixed)],
      payment_methods: [METHOD],
      payroll_extras: [],
      audit_logs: [],
    };
  }

  function extraInput(overrides: Record<string, unknown> = {}) {
    return {
      // CL-5: la marca del intento es obligatoria desde la 044. Todas las
      // pruebas de PA-2a llevan la suya (cada llamada de estas pruebas es un
      // intento distinto); las aserciones no cambiaron.
      idempotency_key: "2d7a4e91-6c05-4b38-a7f2-9e1d0c8b5a36",
      employee_id: EMPLOYEE_ID,
      amount: 1_800_000,
      method_code: "efectivo",
      reference: "Recibo 001",
      reason: "Renuncia del 2026-09-16",
      kind: "renuncia",
      days_from: "2026-09-01",
      days_to: "2026-09-16",
      ...overrides,
    };
  }

  const extraInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_extras");

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // --------------------------------------------------------------- RED ---

  it("RED: hoy no existe la operación, ni la acción de auditoría, ni la tabla", () => {
    // 1) No hay operación: nada registra un pago individual con motivo.
    expect(typeof payrollExtrasService.payPayrollExtra).toBe("function");
    // 2) No hay acción de auditoría de pago: la plata que sale no se explica.
    expect(AUDIT_ACTIONS.PAYROLL_EXTRA_PAID).toBe("payroll.extra_paid");
    // 3) No hay tabla: la migración 036 todavía no existe.
    expect(
      existsSync(join(process.cwd(), "supabase", "migrations", "036_payroll_extra_payment.sql")),
    ).toBe(true);
  });

  it("el hueco que motiva PA-2a: un período CERRADO no admite pagar su ítem", () => {
    // Pasa hoy y es el defecto: cerrado = inmutable, así que el pago del ítem
    // se rechaza y no queda ningún camino para los días ya cubiertos.
    expect(() => assertDraftPeriod("cerrado")).toThrowError("PERIOD_CLOSED");
  });

  // -------------------------------------------------------------- GREEN ---

  it("registra el pago con tipo, motivo y actor, y escribe la auditoría", async () => {
    seedClosedPeriod();

    const row = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);

    expect(row).toMatchObject({
      sede_id: payrollPagedStub.SEDE_ID,
      employee_id: EMPLOYEE_ID,
      amount: 1_800_000,
      method_id: METHOD.id,
      method_code: "efectivo",
      reference: "Recibo 001",
      reason: "Renuncia del 2026-09-16",
      kind: "renuncia",
      days_from: "2026-09-01",
      days_to: "2026-09-16",
      paid_by: ACTOR.userId,
    });

    // La auditoría explica el dinero: quién, cuánto, de qué tipo y por qué.
    const audit = payrollPagedStub.inserts.find((entry) => entry.table === "audit_logs");
    expect(audit?.payload).toMatchObject({
      action: "payroll.extra_paid",
      entity: "payroll_extras",
      entity_id: row.id,
      user_id: ACTOR.userId,
      metadata: {
        employee_id: EMPLOYEE_ID,
        amount: 1_800_000,
        kind: "renuncia",
        reason: "Renuncia del 2026-09-16",
        method_code: "efectivo",
      },
    });
    // El pago queda trazable por QUIÉN lo hizo y sobre QUÉ fila; la sede de la
    // instalación ya no se manda.
    expect(audit?.payload).not.toHaveProperty("sede_id");
  });

  it("funciona para días ya cubiertos por un período CERRADO (el caso que motiva)", async () => {
    seedClosedPeriod();
    expect(() => assertDraftPeriod("cerrado")).toThrowError("PERIOD_CLOSED");

    const row = await payrollExtrasService.payPayrollExtra(
      extraInput({ kind: "despido", reason: "Despido con justa causa" }),
      ACTOR,
    );

    expect(row.kind).toBe("despido");
    // NO es un período: no se creó ni se tocó ninguno.
    expect(payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_periods")).toHaveLength(0);
    expect(payrollPagedStub.updates.filter((entry) => entry.table === "payroll_periods")).toHaveLength(0);

    // Y queda visible en los registros del admin (la lista del módulo).
    const listed = await payrollExtrasService.listPayrollExtras();
    expect(listed.map((entry) => entry.id)).toContain(row.id);
    expect(listed[0]).toMatchObject({ kind: "despido", reason: "Despido con justa causa" });
  });

  it("el motivo es obligatorio: vacío se rechaza sin escribir nada", async () => {
    seedClosedPeriod();

    const failure: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput({ reason: "   " }), ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(extraInserts()).toHaveLength(0);
    expect(payrollPagedStub.inserts).toHaveLength(0);
    // La misma regla en el esquema puro (y en el CHECK de la migración 036).
    expect(payrollExtraSchema.safeParse(extraInput({ reason: "" })).success).toBe(false);
    expect(payrollExtraSchema.safeParse(extraInput({ reason: undefined })).success).toBe(false);
  });

  it("control negativo: la guía NO es un tope; un monto por encima se acepta", async () => {
    seedClosedPeriod(1_400_000);
    // La guía de esos días es ~746.667; el pago de 9.999.999 (una liquidación
    // total, que no es la porción del sueldo) se registra igual.
    const row = await payrollExtrasService.payPayrollExtra(
      extraInput({ amount: 9_999_999, kind: "despido" }),
      ACTOR,
    );
    expect(row.amount).toBe(9_999_999);
  });

  it("control negativo: un método inactivo de la sede se rechaza", async () => {
    seedClosedPeriod();
    payrollPagedStub.tables.payment_methods = [{ ...METHOD, is_active: false }];

    const failure: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput(), ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "METHOD_INACTIVE", status: 422 });
    expect(extraInserts()).toHaveLength(0);
  });

  it("control negativo: un empleado de OTRA sede no se paga desde esta", async () => {
    seedClosedPeriod();
    payrollPagedStub.tables.employees = [employeeRow(1_400_000, OTHER_SEDE)];

    const failure: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput(), ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(extraInserts()).toHaveLength(0);
  });

  it("control negativo: los días invertidos se rechazan (el rango es real)", async () => {
    seedClosedPeriod();

    const failure: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput({ days_from: "2026-09-16", days_to: "2026-09-01" }), ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(extraInserts()).toHaveLength(0);
  });
});

// ------------------------- guía de la nómina extraordinaria (PA-2a, pura) ---

describe("payroll: la guía de la nómina extraordinaria, no un tope (PA-2a)", () => {
  it("la guía es la porción prorrateada de los días que se liquidan", () => {
    const guide = payrollExtraGuide({
      salaryFixed: 1_400_000,
      daysFrom: "2026-09-01",
      daysTo: "2026-09-16",
      amount: 500_000,
    });

    // 1.400.000 × 16/30 = 746.666,67 → 746.667 (peso entero, `roundMoney`).
    expect(guide.monthlySalary).toBe(1_400_000);
    expect(guide.days).toBe(16);
    expect(guide.proratedAmount).toBe(746_667);
    expect(guide.exceedsGuide).toBe(false);
  });

  it("un monto por encima de la guía se MARCA, no se bloquea", () => {
    const guide = payrollExtraGuide({
      salaryFixed: 1_400_000,
      daysFrom: "2026-09-01",
      daysTo: "2026-09-16",
      amount: 2_000_000,
    });
    expect(guide.exceedsGuide).toBe(true);
  });

  it("sin días la guía es el sueldo mensual; sin sueldo fijo no hay guía", () => {
    const withoutDays = payrollExtraGuide({ salaryFixed: 1_400_000, amount: 100 });
    expect(withoutDays.proratedAmount).toBeNull();
    expect(withoutDays.days).toBeNull();
    expect(withoutDays.monthlySalary).toBe(1_400_000);
    // La guía del mes también marca el exceso.
    expect(payrollExtraGuide({ salaryFixed: 1_400_000, amount: 2_000_000 }).exceedsGuide).toBe(true);

    const withoutSalary = payrollExtraGuide({
      salaryFixed: null,
      daysFrom: "2026-09-01",
      daysTo: "2026-09-16",
      amount: 500_000,
    });
    expect(withoutSalary.monthlySalary).toBeNull();
    expect(withoutSalary.proratedAmount).toBeNull();
    expect(withoutSalary.exceedsGuide).toBe(false);
  });

  it("control negativo: un rango invertido LANZA (no devuelve 0 en silencio)", () => {
    expect(() =>
      payrollExtraGuide({ salaryFixed: 1_400_000, daysFrom: "2026-09-16", daysTo: "2026-09-01" }),
    ).toThrowError("INVALID_PERIOD_RANGE");
  });

  it("el tipo del caso es un vocabulario cerrado", () => {
    expect(payrollExtraKindSchema.options).toEqual(["despido", "renuncia", "emergencia", "otro"]);
    expect(payrollExtraSchema.safeParse({ kind: "otro" }).success).toBe(false); // faltan campos
    expect(payrollExtraKindSchema.safeParse("despido").success).toBe(true);
    expect(payrollExtraKindSchema.safeParse("vacaciones").success).toBe(false);
  });
});

// --------------------------------- migración 036 (nómina extraordinaria) ---

describe("migración 036_payroll_extra_payment.sql (PA-2a)", () => {
  const sqlPath = join(process.cwd(), "supabase", "migrations", "036_payroll_extra_payment.sql");
  // Lectura tolerante a la ausencia: en RED el archivo no existe todavía y el
  // fallo tiene que ser la ASERCIÓN de cada prueba, no un error de colección
  // que oculte los otros dos huecos.
  const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";
  /** Sin espacios de más: compara el DDL, no la indentación del archivo. */
  const flat = sql.replace(/\s+/g, " ");

  it("crea la tabla con el motivo obligatorio y el tipo acotado", () => {
    expect(flat).toContain("CREATE TABLE IF NOT EXISTS public.payroll_extras");
    expect(flat).toContain("CHECK (amount > 0)");
    expect(flat).toContain("CHECK (btrim(reason) <> '')");
    expect(flat).toContain("CHECK (kind IN ('despido', 'renuncia', 'emergencia', 'otro'))");
  });

  it("no es un período: no toca payroll_periods", () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.payroll_periods/i);
    expect(sql).not.toMatch(/INSERT INTO public\.payroll_periods/i);
  });

  it("es idempotente y no borra ni reescribe filas", () => {
    expect(flat).toContain("IF NOT EXISTS");
    // Sólo cuentan los statements EJECUTABLES: el encabezado NOMBRA estas
    // operaciones para decir que no las hace (mismo criterio que cash.test.ts).
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|SCHEMA)/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/m);
  });

  it("explica el orden de los statements y por qué, y no se ejecutó", () => {
    expect(sql).toContain("ORDEN DE LOS STATEMENTS");
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

// ---------------------- legibilidad de la nómina con muchos pagos (PA3) ---
//
// Con muchos pagos por mes la pantalla deja de ser legible: la lista de
// períodos se recortaba SOLA (`listPeriods` con `.limit(20)`, sin total ni
// aviso), los nombres de una planta mayor a 50 personas caían al fragmento del
// id (`listEmployees` corta en 50) y no había ni totales por período, ni filtro,
// ni agrupación por mes. Esta unidad NO mueve plata: lee y muestra.
describe("payroll: la vista de nómina es legible con muchos pagos al mes (PA3)", () => {
  const SEDE = payrollPagedStub.SEDE_ID;

  /** Suma días a una fecha `yyyy-mm-dd` (aritmética UTC, como todo el módulo). */
  function isoDayAfter(base: string, offset: number): string {
    const [year, month, day] = base.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
  }

  /** `count` períodos de un solo día, consecutivos desde 2024-01-01. */
  function seedConsecutivePeriods(count: number): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < count; index += 1) {
      const day = isoDayAfter("2024-01-01", index);
      rows.push({
        id: `periodo-${String(index + 1).padStart(5, "0")}`,
        sede_id: SEDE,
        start_date: day,
        end_date: day,
        status: index % 2 === 0 ? "borrador" : "cerrado",
        created_by: "u-1",
        closed_at: null,
        created_at: `${day}T00:00:00.000Z`,
      });
    }
    payrollPagedStub.tables.payroll_periods = rows;
    return rows;
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("una sede con más de 20 períodos no pierde historia (el tope de 20 la recortaba)", async () => {
    const seed = seedConsecutivePeriods(25);
    // Non-vacuidad del fixture: hay más períodos que el tope viejo de la lista.
    expect(seed).toHaveLength(25);

    const rows = await listPeriods();

    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.id)).toContain("periodo-00001");
  });

  it("la lista pide el conjunto entero, en páginas y en orden determinista", async () => {
    seedConsecutivePeriods(1200);

    const rows = await listPeriods();

    expect(rows).toHaveLength(1200);
    const windows = payrollPagedStub.windows.filter((window) => window.table === "payroll_periods");
    // Más de una página: el conjunto cruza el `max-rows` por request del Data API.
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]).toEqual({
      table: "payroll_periods",
      from: 0,
      to: 999,
      order: ["start_date", "id"],
    });
    // Sin desempate, dos períodos con la misma fecha de inicio pueden caer en
    // páginas distintas y repetirse o perderse.
    for (const window of windows) expect(window.order).toEqual(["start_date", "id"]);
  });

  it("control negativo: una sede chica se lee igual y en una sola página", async () => {
    const seed = seedConsecutivePeriods(3);

    const rows = await listPeriods();

    expect(seed).toHaveLength(3);
    expect(rows.map((row) => row.id)).toEqual(["periodo-00003", "periodo-00002", "periodo-00001"]);
    expect(payrollPagedStub.windows.filter((window) => window.table === "payroll_periods")).toEqual([
      { table: "payroll_periods", from: 0, to: 999, order: ["start_date", "id"] },
    ]);
  });

  /** Empleado del fixture, con el `employee_code` que la vista usa como id interno. */
  function employeeFixture(suffix: string, name: string): Record<string, unknown> {
    return {
      id: `emp-${suffix}`,
      sede_id: SEDE,
      user_id: null,
      full_name: name,
      employee_code: `E-${suffix}`,
      document: `1000${suffix}`,
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: 1500000,
      commission_percent: null,
      is_active: true,
    };
  }

  function itemFixture(
    id: string,
    periodId: string,
    employeeId: string,
    baseFixed: number,
    netPay: number,
  ): Record<string, unknown> {
    return {
      id,
      period_id: periodId,
      employee_id: employeeId,
      base_fixed: baseFixed,
      commissions: 0,
      bonuses: 0,
      deductions_vales: 0,
      other_discounts: 0,
      net_pay: netPay,
      detail_json: [],
      created_at: "2026-09-30T23:59:59.000Z",
    };
  }

  function paymentFixture(id: string, itemId: string, amount: number): Record<string, unknown> {
    return {
      id,
      payroll_item_id: itemId,
      method_id: null,
      method_code: "efectivo",
      amount,
      paid_at: "2026-09-30T12:00:00.000Z",
      paid_by: "u-1",
      reference: null,
    };
  }

  const P1 = "p-2026-09-a";
  const P2 = "p-2026-09-b";
  const P3 = "p-2026-10-a";

  /**
   * Tres períodos (dos de septiembre, uno de octubre) con dos empleados y cuatro
   * ítems. Sirve para las dos proyecciones de la vista: el resumen por período y
   * el mes a la fecha por empleado.
   */
  function seedLegibilityFixture(): void {
    payrollPagedStub.tables.payroll_periods = [
      {
        id: P1,
        sede_id: SEDE,
        start_date: "2026-09-01",
        end_date: "2026-09-15",
        status: "borrador",
        created_by: "u-1",
        closed_at: null,
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: P2,
        sede_id: SEDE,
        start_date: "2026-09-16",
        end_date: "2026-09-30",
        status: "cerrado",
        created_by: "u-1",
        closed_at: "2026-10-01T00:00:00.000Z",
        created_at: "2026-09-16T00:00:00.000Z",
      },
      {
        id: P3,
        sede_id: SEDE,
        start_date: "2026-10-01",
        end_date: "2026-10-15",
        status: "borrador",
        created_by: "u-1",
        closed_at: null,
        created_at: "2026-10-01T00:00:00.000Z",
      },
    ];
    payrollPagedStub.tables.employees = [
      employeeFixture("01", "Ana López"),
      employeeFixture("02", "Beto Ruiz"),
    ];
    payrollPagedStub.tables.payroll_items = [
      itemFixture("i-1", P1, "emp-01", 800000, 1000000),
      itemFixture("i-2", P1, "emp-02", 500000, 500000),
      itemFixture("i-3", P2, "emp-01", 800000, 900000),
      itemFixture("i-4", P3, "emp-01", 800000, 1100000),
    ];
    payrollPagedStub.tables.payroll_payments = [
      paymentFixture("pay-1", "i-1", 200000),
      paymentFixture("pay-2", "i-1", 200000),
      paymentFixture("pay-3", "i-3", 900000),
      paymentFixture("pay-4", "i-4", 200000),
    ];
  }

  it("la planta de la vista no se recorta en 50: el nombre del empleado 60 resuelve", async () => {
    const plant: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= 60; index += 1) {
      const suffix = String(index).padStart(2, "0");
      plant.push(employeeFixture(suffix, `Empleado ${suffix}`));
    }
    payrollPagedStub.tables.employees = plant;
    seedConsecutivePeriods(1);

    // El listado de navegación SÍ corta en 50: es su contrato, y por eso la
    // pantalla de nómina no puede alimentarse de él.
    const browsing = await listEmployees();
    expect(browsing).toHaveLength(50);

    const all = await listAllEmployees();
    expect(all).toHaveLength(60);
    const index = buildPayrollEmployeeIndex(all);
    expect(payrollEmployeeName(index, "emp-60")).toBe("Empleado 60 (E-60)");
    // Control negativo: el id que no está en la planta cae al fragmento del id
    // (degradación explícita, nunca un nombre inventado).
    expect(payrollEmployeeName(index, "ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe("ffffffff");
  });

  it("el resumen de cada período se lee sin abrirlo: totales y cuántos empleados", async () => {
    seedLegibilityFixture();

    const overview = await listPayrollOverview(SEDE);

    // Mismo orden que la lista (inicio más reciente primero).
    expect(overview.summaries.map((row) => row.period.id)).toEqual([P3, P2, P1]);
    expect(overview.summaries[2]).toMatchObject({
      employeeCount: 2,
      netTotal: 1500000,
      paidTotal: 400000,
      remainingTotal: 1100000,
    });
    expect(overview.summaries[1]).toMatchObject({
      employeeCount: 1,
      netTotal: 900000,
      paidTotal: 900000,
      remainingTotal: 0,
    });
    expect(overview.summaries[0]).toMatchObject({
      employeeCount: 1,
      netTotal: 1100000,
      paidTotal: 200000,
      remainingTotal: 900000,
    });
  });

  it("los pagos del mes de un empleado: lo pagado y contra qué períodos (consulta puntual)", async () => {
    seedLegibilityFixture();

    const rows = await listPayrollMonthRows({
      month: "2026-09",
      employeeId: "emp-01",
    });

    // La consulta devuelve SOLO la fila del par (mes, empleado).
    expect(rows.map((row) => `${row.month}/${row.employeeId}`)).toEqual(["2026-09/emp-01"]);
    expect(rows[0]).toMatchObject({
      netTotal: 1900000,
      paidTotal: 1300000,
      remainingTotal: 600000,
      fixedTotal: 1600000,
      days: 30,
    });
    // Contra qué períodos: los dos de septiembre, en orden de fecha.
    expect(rows[0].periods.map((row) => row.periodId)).toEqual([P1, P2]);
    expect(rows[0].periods[0]).toMatchObject({
      status: "borrador",
      net: 1000000,
      paid: 400000,
      remaining: 600000,
      fixed: 800000,
      days: 15,
    });
  });

  it("la consulta del mes está acotada por mes Y por empleado", async () => {
    seedLegibilityFixture();

    // Octubre tiene pagos de emp-01 (P3) pero NINGUNO de emp-02: la consulta de
    // emp-02 en octubre devuelve vacío, no los datos de su compañero.
    expect(
      await listPayrollMonthRows({ month: "2026-10", employeeId: "emp-02" }),
    ).toEqual([]);

    // El mismo mes, el empleado que SÍ tiene pagos: una sola fila, con los
    // períodos de ESE mes (ninguno de septiembre).
    const october = await listPayrollMonthRows({
      month: "2026-10",
      employeeId: "emp-01",
    });
    expect(october.map((row) => `${row.month}/${row.employeeId}`)).toEqual(["2026-10/emp-01"]);
    expect(october[0]).toMatchObject({
      netTotal: 1100000,
      paidTotal: 200000,
      remainingTotal: 900000,
    });
    expect(october[0].periods.map((row) => row.periodId)).toEqual([P3]);
  });

  it("control negativo: una fila con más pagado que neto no resta del saldo", async () => {
    seedLegibilityFixture();
    // Con la base actual no puede pasar (`assertNoOverpay`), pero la vista no
    // puede inventar un saldo negativo si el dato llegara así igual.
    payrollPagedStub.tables.payroll_payments.push(paymentFixture("pay-5", "i-2", 700000));

    const overview = await listPayrollOverview(SEDE);

    const p1 = overview.summaries.find((row) => row.period.id === P1);
    expect(p1).toMatchObject({ paidTotal: 1100000, remainingTotal: 600000 });

    // La misma base, por la consulta puntual: el saldo de la fila tampoco se
    // inventa negativo (el pagado que supera el neto no descuenta de más).
    const september = await listPayrollMonthRows({
      month: "2026-09",
      employeeId: "emp-02",
    });
    expect(september[0]).toMatchObject({
      netTotal: 500000,
      paidTotal: 700000,
      remainingTotal: 0,
    });
  });

  it("control negativo: un mes sin períodos no devuelve filas", async () => {
    seedLegibilityFixture();

    expect(
      await listPayrollMonthRows({ month: "2026-11", employeeId: "emp-01" }),
    ).toEqual([]);
  });

  it("el conteo de la lista se lee contra el total (no hay recorte mudo)", () => {
    expect(payrollPeriodCountLabel({ total: 25, shown: 25 })).toBe("25 períodos en la sede.");
    expect(payrollPeriodCountLabel({ total: 1, shown: 1 })).toBe("1 período en la sede.");
    expect(payrollPeriodCountLabel({ total: 25, shown: 3 })).toBe("Mostrando 3 de 25 períodos.");
  });
});

// ---------------------------------- derivaciones puras de la vista (PA3) ---

describe("payroll: derivaciones de la vista de nómina (PA3, funciones puras)", () => {
  it("los días de un rango dentro de un mes son el numerador de la prorata", () => {
    expect(daysInMonthWithinRange("2026-09", "2026-09-01", "2026-09-15")).toBe(15);
    // Un período que cruza el fin de mes: la parte de cada mes, por separado.
    expect(daysInMonthWithinRange("2026-09", "2026-09-28", "2026-10-03")).toBe(3);
    expect(daysInMonthWithinRange("2026-10", "2026-09-28", "2026-10-03")).toBe(3);
    // Control negativo: un mes que el rango no toca no aporta días.
    expect(daysInMonthWithinRange("2026-08", "2026-09-28", "2026-10-03")).toBe(0);
    // Control negativo: una fecha imposible no inventa días.
    expect(daysInMonthWithinRange("2026-09", "2026-09-31", "2026-10-03")).toBe(0);
  });

  it("la etiqueta del mes no depende del locale del runtime", () => {
    expect(payrollMonthLabel("2026-09")).toBe("septiembre 2026");
    expect(payrollMonthLabel("2026-01")).toBe("enero 2026");
    // Control negativo: lo que no es un mes vuelve tal cual, sin inventar.
    expect(payrollMonthLabel("2026-13")).toBe("2026-13");
    expect(payrollMonthLabel("sin-mes")).toBe("sin-mes");
  });

  it("agrupa los períodos por mes, el más reciente primero", () => {
    const periods = [
      { id: "a", start_date: "2026-09-01", end_date: "2026-09-15", status: "cerrado" },
      { id: "b", start_date: "2026-10-01", end_date: "2026-10-15", status: "borrador" },
      { id: "c", start_date: "2026-09-16", end_date: "2026-09-30", status: "borrador" },
    ];

    const grouped = groupPayrollPeriodsByMonth(periods).map((group) => [
      group.month,
      group.periods.map((row) => row.id),
    ]);
    expect(grouped).toEqual([
      ["2026-10", ["b"]],
      ["2026-09", ["c", "a"]],
    ]);
    // Control negativo: sin períodos no hay meses que mostrar.
    expect(groupPayrollPeriodsByMonth([])).toEqual([]);
  });

  it("los totales que muestra la vista suman en peso entero, sin tolerancia", () => {
    expect(sumMoney([100.5, 200.5])).toBe(302);
    expect(Number.isInteger(sumMoney([100.5, 200.5]))).toBe(true);
    expect(sumMoney([0, 0])).toBe(0);
    // Control negativo: la lista vacía suma 0, no NaN.
    expect(sumMoney([])).toBe(0);
  });

  it("el saldo de una fila no se inventa y nunca es negativo", () => {
    expect(
      summarizePayrollItems([
        { id: "a", period_id: "p", employee_id: "e1", base_fixed: 0, net_pay: 1000000, paid: 400000 },
        { id: "b", period_id: "p", employee_id: "e2", base_fixed: 0, net_pay: 500000, paid: 700000 },
      ]),
    ).toEqual({ employeeCount: 2, netTotal: 1500000, paidTotal: 1100000, remainingTotal: 600000 });
    expect(summarizePayrollItems([])).toEqual({
      employeeCount: 0,
      netTotal: 0,
      paidTotal: 0,
      remainingTotal: 0,
    });
  });

  it("un período que cruza el fin de mes aparece en el mes donde empieza", () => {
    const rows = buildPayrollMonthToDate({
      periods: [{ id: "p", start_date: "2026-09-28", end_date: "2026-10-03", status: "borrador" }],
      items: [
        { id: "i", period_id: "p", employee_id: "e1", base_fixed: 100000, net_pay: 100000, paid: 0 },
      ],
    });

    expect(rows.map((row) => [row.month, row.days])).toEqual([["2026-09", 3]]);
    expect(rows[0].fixedTotal).toBe(100000);
    // Control negativo: sin ítems no hay fila de empleado que mostrar.
    expect(
      buildPayrollMonthToDate({
        periods: [{ id: "p", start_date: "2026-09-28", end_date: "2026-10-03", status: "borrador" }],
        items: [],
      }),
    ).toEqual([]);
  });

  it("la porción de un período se reemplaza con el detalle recién leído", () => {
    const periods = [
      { id: "p1", start_date: "2026-09-01", end_date: "2026-09-15", status: "borrador" },
      { id: "p2", start_date: "2026-09-16", end_date: "2026-09-30", status: "borrador" },
    ];
    const items = [
      { id: "i1", period_id: "p1", employee_id: "e1", base_fixed: 500000, net_pay: 1000000, paid: 0 },
      { id: "i2", period_id: "p2", employee_id: "e1", base_fixed: 500000, net_pay: 1000000, paid: 0 },
    ];
    const before = buildPayrollMonthToDate({ periods, items });
    expect(before[0]).toMatchObject({
      netTotal: 2000000,
      paidTotal: 0,
      fixedTotal: 1000000,
      days: 30,
    });

    // El admin paga 400.000 en el primer período: llega el detalle fresco.
    const after = replacePayrollMonthPeriod({
      rows: before,
      period: periods[0],
      items: [{ ...items[0], paid: 400000 }],
    });

    // El número que acaba de cambiar se ve al instante...
    expect(after[0]).toMatchObject({ netTotal: 2000000, paidTotal: 400000, remainingTotal: 1600000 });
    // ...y el OTRO período del mismo mes no se pierde ni se duplica.
    expect(after[0].periods.map((entry) => entry.periodId)).toEqual(["p1", "p2"]);
    expect(after[0].days).toBe(30);
  });

  it("control negativo: borrar un período lo saca de la vista del mes", () => {
    const period = { id: "p1", start_date: "2026-09-01", end_date: "2026-09-15", status: "borrador" };
    const rows = buildPayrollMonthToDate({
      periods: [period],
      items: [{ id: "i1", period_id: "p1", employee_id: "e1", base_fixed: 0, net_pay: 1000000, paid: 0 }],
    });
    expect(rows).toHaveLength(1);

    // Sin ítems: la porción del período se va y la fila se queda sin nada.
    expect(replacePayrollMonthPeriod({ rows, period, items: [] })).toEqual([]);
    // Y un período que no está en la vista no la cambia.
    const other = { id: "p9", start_date: "2026-09-01", end_date: "2026-09-15", status: "borrador" };
    expect(replacePayrollMonthPeriod({ rows, period: other, items: [] })).toEqual(rows);
  });
});


// ---------- PA-2b: corregir un período cerrado conservando las dos versiones ---
//
// Un período CERRADO y equivocado no tenía salida: no se borra
// (`assertDeletablePeriod` exige borrador), no se recalcula (`assertDraftPeriod`
// exige borrador) y sus días no se pueden volver a nominar (la restricción de
// exclusión de 035 cubre TODOS los estados). Antes de 035 el camino era abrir un
// segundo período sobre los mismos días, y ESE camino era el defecto: los pagaba
// dos veces. La corrección es un REGISTRO con las dos versiones, con motivo, y
// NO mueve plata: la diferencia se muestra y se salda a mano.
describe("payroll: corregir un período cerrado conserva las dos versiones (PA-2b)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const OTHER_SEDE = "99999999-9999-4999-8999-999999999999";
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const ITEM_ID = "item-nomina-1";
  const WEEK = { start: "2026-09-01", end: "2026-09-07" };
  /** Sueldo MENSUAL: 7 de 30 días son 326.667 (la versión CORRECTA). */
  const SALARY = 1_400_000;
  const PRORATED = 326_667;

  function employeeFijo(sedeId = payrollPagedStub.SEDE_ID) {
    return {
      id: EMPLOYEE_ID,
      sede_id: sedeId,
      user_id: null,
      full_name: "Empleada fija",
      employee_code: "E-001",
      document: "1000000001",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: SALARY,
      commission_percent: null,
      is_active: true,
    };
  }

  /**
   * El caso del dueño: un período semanal cerrado que liquidó el sueldo MENSUAL
   * completo (1.400.000) cuando correspondía la parte de sus 7 días (326.667),
   * y que ya se pagó por 1.400.000. Diferencia: 1.073.333.
   */
  function seedWrongClosedPeriod(overrides: {
    item?: Record<string, unknown>;
    payments?: Array<Record<string, unknown>>;
    vouchers?: Array<Record<string, unknown>>;
    sedeId?: string;
  } = {}) {
    const sedeId = overrides.sedeId ?? payrollPagedStub.SEDE_ID;
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: PERIOD_ID,
          sede_id: sedeId,
          start_date: WEEK.start,
          end_date: WEEK.end,
          status: "cerrado",
          created_by: "u-admin-1",
          closed_at: "2026-09-07T23:00:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      employees: [employeeFijo(sedeId)],
      payroll_items: [
        {
          id: ITEM_ID,
          period_id: PERIOD_ID,
          employee_id: EMPLOYEE_ID,
          base_fixed: SALARY,
          commissions: 0,
          bonuses: 0,
          deductions_vales: 0,
          other_discounts: 0,
          net_pay: SALARY,
          detail_json: [],
          created_at: "2026-09-07T23:00:00.000Z",
          ...overrides.item,
        },
      ],
      payroll_payments:
        overrides.payments ?? [
          {
            id: "pago-1",
            payroll_item_id: ITEM_ID,
            method_id: null,
            method_code: "efectivo",
            amount: SALARY,
            paid_at: "2026-09-07T23:30:00.000Z",
            paid_by: "u-admin-1",
            reference: null,
          },
        ],
      payroll_period_corrections: [],
      payroll_period_correction_items: [],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: overrides.vouchers ?? [],
      commission_payouts: [],
      audit_logs: [],
    };
  }

  const correctionInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_period_corrections");
  const correctionItemInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_period_correction_items");
  const moneyInserts = () =>
    payrollPagedStub.inserts.filter(
      (entry) => entry.table === "payroll_payments" || entry.table === "payroll_extras",
    );

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // --------------------------------------------------------------- RED ---

  it("RED: hoy un período cerrado no tiene salida, y faltan la operación, la acción y la tabla", () => {
    // 1) El hueco, verificado en las funciones puras que lo cierran: un período
    // cerrado no se borra ni se recalcula.
    expect(() => assertDeletablePeriod("cerrado")).toThrowError("PERIOD_NOT_DRAFT");
    expect(() => assertDraftPeriod("cerrado")).toThrowError("PERIOD_CLOSED");
    // Y el candado que SÍ corresponde: sólo un período cerrado se corrige (un
    // borrador se recalcula).
    expect(() => assertCorrectablePeriod("borrador")).toThrowError("PERIOD_NOT_CLOSED");
    expect(() => assertCorrectablePeriod("cerrado")).not.toThrow();
    // 2) No hay operación que lo corrija sin reabrirlo.
    expect(typeof payrollExtrasService.correctPayrollPeriod).toBe("function");
    // 3) No hay acción de auditoría propia: corregir no es "calcular".
    expect(AUDIT_ACTIONS.PAYROLL_PERIOD_CORRECTED).toBe("payroll.period_corrected");
    // 4) No hay tabla donde guardar las dos versiones.
    expect(
      existsSync(join(process.cwd(), "supabase", "migrations", "037_payroll_period_correction.sql")),
    ).toBe(true);
    // 5) El motivo no era obligatorio en ningún lado.
    expect(correctPayrollPeriodSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(correctPayrollPeriodSchema.safeParse({ reason: undefined }).success).toBe(false);
  });

  it("el candado que hace imposible que la corrección mueva plata: un cerrado no se paga", async () => {
    seedWrongClosedPeriod();
    // `payPayrollItem` es el ÚNICO camino que escribe `payroll_payments`, y
    // exige un período en BORRADOR. Aplicar los montos corregidos al registro no
    // puede cambiar ningún pago: no hay forma de pagar desde un cerrado.
    const failure: unknown = await payrollExtrasService
      .payPayrollItem(
        payrollPagedStub.SEDE_ID,
        ITEM_ID,
        {
          // CL-2: el cuerpo del pago exige ahora la marca del intento.
          idempotency_key: "3f1c8a2e-9d47-4b6e-8f21-0c5a7b3d9e14",
          portions: [{ method_code: "efectivo", amount: 1 }],
        },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_CLOSED", status: 409 });
    expect(payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_payments")).toHaveLength(0);
  });

  // ------------------------------------------------------------- GREEN ---

  it("corrige el período: recalcula con las reglas vigentes y guarda las DOS versiones", async () => {
    seedWrongClosedPeriod();

    const result = await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "El fijo se pagó completo y correspondía la parte de los días." },
      ACTOR,
    );

    // La versión anterior queda congelada y la corregida sale de las reglas
    // vigentes: 7 de 30 días de 1.400.000 = 326.667 (no 1.400.000).
    expect(result.correction).toMatchObject({
      period_id: PERIOD_ID,
      previous_net_total: SALARY,
      previous_paid_total: SALARY,
      corrected_net_total: PRORATED,
      previous_item_count: 1,
      corrected_item_count: 1,
      reason: "El fijo se pagó completo y correspondía la parte de los días.",
      corrected_by: ACTOR.userId,
    });

    // Por empleado: lo que decía, lo corregido y lo pagado, con la diferencia.
    expect(result.view.rows).toHaveLength(1);
    expect(result.view.rows[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      paid: SALARY,
      difference: SALARY - PRORATED,
    });
    expect(result.view.rows[0].previous.net_pay).toBe(SALARY);
    expect(result.view.rows[0].corrected.net_pay).toBe(PRORATED);
    expect(result.view.previousNetTotal).toBe(SALARY);
    expect(result.view.correctedNetTotal).toBe(PRORATED);
    expect(result.view.paidTotal).toBe(SALARY);
    expect(result.view.differenceTotal).toBe(1_073_333);

    // Se guardó UNA cabecera y las filas por empleado.
    expect(correctionInserts()).toHaveLength(1);
    expect(correctionItemInserts()).toHaveLength(1);
    const storedItems = correctionItemInserts()[0].payload as Array<Record<string, unknown>>;
    expect(storedItems).toHaveLength(1);
    expect(storedItems[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      previous_net_pay: SALARY,
      previous_paid: SALARY,
      corrected_net_pay: PRORATED,
    });
  });

  it("la versión anterior sigue legible: el período y sus ítems NO se tocan", async () => {
    seedWrongClosedPeriod();
    await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "Fijo mal prorrateado." },
      ACTOR,
    );

    // El original firmado sigue diciendo lo mismo (y se sigue leyendo igual).
    const stored = payrollPagedStub.tables.payroll_items.find((row) => row.id === ITEM_ID);
    expect(stored?.net_pay).toBe(SALARY);
    const detail = await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ net_pay: SALARY, paid: SALARY });

    // Ningún UPDATE en ninguna tabla: la corrección sólo inserta.
    expect(payrollPagedStub.updates).toHaveLength(0);
  });

  it("la corrección se lee de vuelta con las dos versiones comparadas", async () => {
    seedWrongClosedPeriod();
    await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "Fijo mal prorrateado." },
      ACTOR,
    );

    const read = await getPayrollPeriodCorrection(payrollPagedStub.SEDE_ID, PERIOD_ID);
    expect(read).not.toBeNull();
    expect(read?.correction).toMatchObject({
      previous_net_total: SALARY,
      corrected_net_total: PRORATED,
      reason: "Fijo mal prorrateado.",
    });
    expect(read?.view.rows[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      paid: SALARY,
      difference: 1_073_333,
    });

    // Control negativo: un período que no está en la sede no se lee (404).
    const failure: unknown = await getPayrollPeriodCorrection(
      payrollPagedStub.SEDE_ID,
      "periodo-inexistente",
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("una corrección por período: la segunda se rechaza y no se apila", async () => {
    seedWrongClosedPeriod();
    await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "Primera corrección." },
      ACTOR,
    );

    const failure: unknown = await payrollExtrasService
      .correctPayrollPeriod(
        payrollPagedStub.SEDE_ID,
        PERIOD_ID,
        { reason: "Segunda corrección." },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "ALREADY_CORRECTED", status: 409 });
    // Una sola cabecera y un solo juego de filas: la corrección también queda
    // firmada.
    expect(correctionInserts()).toHaveLength(1);
    expect(correctionItemInserts()).toHaveLength(1);
  });

  it("el motivo es obligatorio: vacío se rechaza sin escribir nada", async () => {
    seedWrongClosedPeriod();

    const failure: unknown = await payrollExtrasService
      .correctPayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, { reason: "   " }, ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(correctionInserts()).toHaveLength(0);
    expect(payrollPagedStub.inserts).toHaveLength(0);
  });

  it("control negativo: un borrador NO se corrige (se recalcula)", async () => {
    seedWrongClosedPeriod();
    payrollPagedStub.tables.payroll_periods[0].status = "borrador";
    payrollPagedStub.tables.payroll_periods[0].closed_at = null;

    const failure: unknown = await payrollExtrasService
      .correctPayrollPeriod(
        payrollPagedStub.SEDE_ID,
        PERIOD_ID,
        { reason: "No debería corregirse." },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_NOT_CLOSED", status: 409 });
    expect(correctionInserts()).toHaveLength(0);
  });

  it("control negativo: un período sin ítems no tiene nada que corregir", async () => {
    seedWrongClosedPeriod();
    payrollPagedStub.tables.payroll_items = [];

    const failure: unknown = await payrollExtrasService
      .correctPayrollPeriod(
        payrollPagedStub.SEDE_ID,
        PERIOD_ID,
        { reason: "Sin liquidación." },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "NOTHING_TO_CORRECT", status: 409 });
    expect(correctionInserts()).toHaveLength(0);
  });

  it("control negativo: un período de OTRA sede no se corrige desde esta", async () => {
    seedWrongClosedPeriod({ sedeId: OTHER_SEDE });

    const failure: unknown = await payrollExtrasService
      .correctPayrollPeriod(
        payrollPagedStub.SEDE_ID,
        PERIOD_ID,
        { reason: "De otra sede." },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(correctionInserts()).toHaveLength(0);
  });

  it("NO mueve plata: no escribe pagos ni pagos extraordinarios, y no toca vales", async () => {
    // Un vale que ESTE período ya descontó: el recálculo tiene que seguir
    // restándolo del neto (si no, la corrección subiría el neto por una razón
    // ajena a la corrección) pero sin volver a escribir el vale.
    seedWrongClosedPeriod({
      vouchers: [
        {
          id: "vale-1",
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 100_000,
          request_date: "2026-09-03",
          status: "descontada",
          approved_by: "u-admin-1",
          approval_code: null,
          observation: null,
        },
      ],
    });

    const result = await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "Fijo mal prorrateado, con vale ya descontado." },
      ACTOR,
    );

    // 326.667 − 100.000 = 226.667: el descuento del vale sigue en la versión
    // corregida (no desaparece por estar ya `descontada`).
    expect(result.view.correctedNetTotal).toBe(PRORATED - 100_000);
    expect(result.view.rows[0].corrected.deductions_vales).toBe(100_000);

    // NADA de dinero se mueve ni se reescribe:
    expect(moneyInserts()).toHaveLength(0);
    expect(
      payrollPagedStub.inserts.filter((entry) => entry.table === "voucher_requests"),
    ).toHaveLength(0);
    expect(payrollPagedStub.updates).toHaveLength(0);
    // El vale sigue como estaba.
    expect(payrollPagedStub.tables.voucher_requests[0].status).toBe("descontada");
  });

  it("la corrección es una acción auditada con el motivo y los totales de las DOS versiones", async () => {
    seedWrongClosedPeriod();
    const result = await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "El fijo se pagó completo y correspondía la parte de los días." },
      ACTOR,
    );

    const audit = payrollPagedStub.inserts.find((entry) => entry.table === "audit_logs");
    expect(audit?.payload).toMatchObject({
      action: "payroll.period_corrected",
      entity: "payroll_periods",
      entity_id: PERIOD_ID,
      user_id: ACTOR.userId,
      metadata: {
        correction_id: result.correction.id,
        reason: "El fijo se pagó completo y correspondía la parte de los días.",
        previous_net_total: SALARY,
        corrected_net_total: PRORATED,
        previous_paid_total: SALARY,
        difference_total: 1_073_333,
      },
    });
    expect(audit?.payload).not.toHaveProperty("sede_id");
    // La acción NO es la del cálculo: un auditor no puede leer "se calculó"
    // donde lo que pasó es que se corrigió una liquidación ya firmada.
    expect(AUDIT_ACTIONS.PAYROLL_PERIOD_CORRECTED).not.toBe(AUDIT_ACTIONS.PAYROLL_CALCULATED);
  });

  it("preserva los ajustes manuales: un bono escrito en la liquidación no se borra", async () => {
    // El bono no sale de ninguna regla: es una decisión que quedó escrita. La
    // corrección cambia lo que cambian las reglas (el fijo), no el bono.
    seedWrongClosedPeriod({
      item: { bonuses: 50_000, net_pay: SALARY + 50_000 },
      payments: [
        {
          id: "pago-1",
          payroll_item_id: ITEM_ID,
          method_id: null,
          method_code: "efectivo",
          amount: SALARY + 50_000,
          paid_at: "2026-09-07T23:30:00.000Z",
          paid_by: "u-admin-1",
          reference: null,
        },
      ],
    });

    const result = await payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason: "Fijo mal prorrateado." },
      ACTOR,
    );

    expect(result.view.rows[0].corrected.bonuses).toBe(50_000);
    expect(result.view.rows[0].corrected.net_pay).toBe(PRORATED + 50_000);
    expect(result.view.correctedNetTotal).toBe(PRORATED + 50_000);
  });
});

// ----------------- la comparación de la corrección (PA-2b, función pura) ---

describe("payroll: la comparación de la corrección, función pura (PA-2b)", () => {
  const amounts = (net: number) => ({
    base_fixed: net,
    commissions: 0,
    bonuses: 0,
    deductions_vales: 0,
    other_discounts: 0,
    net_pay: net,
  });

  it("la diferencia es pagado − neto corregido, por empleado y para el período", () => {
    const view = buildPayrollCorrectionView({
      previous: [{ employee_id: "e1", ...amounts(1_400_000) }],
      corrected: [{ employee_id: "e1", ...amounts(326_667) }],
      paidByEmployee: new Map([["e1", 1_400_000]]),
    });

    expect(view.previousNetTotal).toBe(1_400_000);
    expect(view.correctedNetTotal).toBe(326_667);
    expect(view.paidTotal).toBe(1_400_000);
    expect(view.rows[0].difference).toBe(1_073_333);
    expect(view.differenceTotal).toBe(1_073_333);
  });

  it("la diferencia es con signo: lo que quedó debiendo se ve como negativo", () => {
    const view = buildPayrollCorrectionView({
      previous: [{ employee_id: "e1", ...amounts(100_000) }],
      corrected: [{ employee_id: "e1", ...amounts(400_000) }],
      paidByEmployee: new Map([["e1", 100_000]]),
    });

    // La corrección sube lo debido y lo pagado no alcanza: −300.000.
    expect(view.rows[0].difference).toBe(-300_000);
    expect(view.differenceTotal).toBe(-300_000);
    // El total es la SUMA de las filas: la tabla y sus totales no pueden decir
    // cosas distintas.
    expect(view.paidTotal).toBe(100_000);
    expect(view.correctedNetTotal).toBe(400_000);
  });

  it("sin pagos, la diferencia es el neto corregido entero (nada se saldó)", () => {
    const view = buildPayrollCorrectionView({
      previous: [{ employee_id: "e1", ...amounts(500_000) }],
      corrected: [{ employee_id: "e1", ...amounts(500_000) }],
      paidByEmployee: new Map(),
    });

    expect(view.paidTotal).toBe(0);
    expect(view.rows[0].difference).toBe(-500_000);
  });

  it("un empleado que sólo está en una versión se muestra con la otra en cero (no desaparece)", () => {
    const view = buildPayrollCorrectionView({
      previous: [{ employee_id: "e1", ...amounts(100_000) }],
      corrected: [
        { employee_id: "e1", ...amounts(100_000) },
        { employee_id: "e2", ...amounts(200_000) },
      ],
      paidByEmployee: new Map([["e1", 100_000]]),
    });

    expect(view.rows.map((row) => row.employee_id)).toEqual(["e1", "e2"]);
    expect(view.rows[1].previous.net_pay).toBe(0);
    expect(view.rows[1].corrected.net_pay).toBe(200_000);
    expect(view.correctedNetTotal).toBe(300_000);
  });
});

// ----------------------------------------- migración 037 (PA-2b) ---

describe("migración 037_payroll_period_correction.sql (PA-2b)", () => {
  const sqlPath = join(process.cwd(), "supabase", "migrations", "037_payroll_period_correction.sql");
  // Lectura tolerante a la ausencia: en RED el archivo no existe todavía y el
  // fallo tiene que ser la ASERCIÓN de cada prueba, no un error de colección
  // que oculte los otros huecos.
  const sql = existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";
  /** Sin espacios de más: compara el DDL, no la indentación del archivo. */
  const flat = sql.replace(/\s+/g, " ");

  it("crea las dos tablas con el motivo obligatorio y las dos versiones", () => {
    expect(flat).toContain("CREATE TABLE IF NOT EXISTS public.payroll_period_corrections");
    expect(flat).toContain("CREATE TABLE IF NOT EXISTS public.payroll_period_correction_items");
    expect(flat).toContain("CHECK (btrim(reason) <> '')");
    expect(flat).toContain("previous_net_total numeric(12, 2)");
    expect(flat).toContain("corrected_net_total numeric(12, 2)");
    expect(flat).toContain("previous_paid numeric(12, 2)");
    expect(flat).toContain("corrected_net_pay numeric(12, 2)");
  });

  it("una sola corrección por período y una fila por empleado", () => {
    expect(flat).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_corrections_period ON public.payroll_period_corrections (period_id)",
    );
    expect(flat).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_period_correction_items_employee ON public.payroll_period_correction_items (correction_id, employee_id)",
    );
  });

  it("no reabre el período ni mueve plata: no toca las tablas de pago", () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.payroll_periods/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.payroll_items/i);
    expect(sql).not.toMatch(/INSERT INTO public\.payroll_periods/i);
    expect(sql).not.toMatch(/INSERT INTO public\.payroll_items/i);
    expect(sql).not.toMatch(/INSERT INTO public\.payroll_payments/i);
    expect(sql).not.toMatch(/INSERT INTO public\.payroll_extras/i);
    expect(sql).not.toMatch(/INSERT INTO public\.voucher_requests/i);
  });

  it("es idempotente y no borra ni reescribe filas", () => {
    expect(flat).toContain("IF NOT EXISTS");
    // Sólo cuentan los statements EJECUTABLES: el encabezado NOMBRA estas
    // operaciones para decir que no las hace (mismo criterio que cash.test.ts).
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|SCHEMA)/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/m);
  });

  it("explica el orden de los statements, qué NO hace y no se ejecutó", () => {
    expect(sql).toContain("ORDEN DE LOS STATEMENTS");
    expect(sql).toContain("QUÉ NO HACE ESTE ARCHIVO");
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
    // La decisión del dueño queda escrita: la diferencia la salda un humano.
    expect(sql).toContain("el sistema MUESTRA la diferencia y NO mueve plata por sí solo");
  });
});

// ------------------- lo que la pantalla dice de la corrección (PA-2b) ---

describe("payroll: la pantalla dice que la corrección no mueve dinero (PA-2b)", () => {
  const client = readFileSync(
    join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
    "utf8",
  );

  it("nombra las tres cifras: lo que se debía, lo que se pagó y la diferencia", () => {
    expect(client).toContain("Debido antes (versión anterior)");
    expect(client).toContain("Debido corregido (versión vigente)");
    expect(client).toContain("Diferencia (pagado - corregido)");
  });

  it("dice, palabra por palabra, que la diferencia NO la salda la corrección", () => {
    expect(client).toContain(
      "La corrección deja el registro de lo que debía pagarse; NO mueve dinero: no paga, no descuenta ni arrastra saldos.",
    );
    expect(client).toContain(
      "La diferencia (pagado - corregido) NO queda saldada por la corrección: se salda con un pago extraordinario cuyo motivo diga que es el ajuste por la corrección del período.",
    );
  });

  it("el período firmado sigue visible y se dice que la corrección no lo reescribe", () => {
    expect(client).toContain(
      "El período cerrado no se reabre ni se pisa: se guarda una corrección con las dos versiones y un motivo obligatorio.",
    );
    expect(client).toContain(
      "La liquidación firmada del período queda intacta y se sigue mostrando tal como se cerró.",
    );
  });

  it("el motivo de la corrección es obligatorio también en la pantalla", () => {
    expect(client).toContain("Motivo de la corrección");
    expect(client).toContain("El motivo de la corrección es obligatorio.");
  });

  it("no se inventa un movimiento de dinero en la copia (control negativo)", () => {
    // Ninguna copia promete pago, descuento, ajuste automático ni arrastre.
    expect(client).not.toContain("claw-back");
    expect(client).not.toContain("se descontará");
    expect(client).not.toContain("se arrastra al período siguiente");
    expect(client).not.toContain("ajuste automático");
  });
});

// ------------- CL-2: el abono parcial repetido no paga dos veces ------------
//
// El defecto: `payPayrollItem` leía el acumulado (`alreadyPaid`) y DESPUÉS
// insertaba las porciones, sin ninguna marca del ENVÍO y sin barrera de
// identidad. Reenviar el MISMO abono parcial —doble clic, o el navegador
// reintentando tras cortarse la red— releía el mismo acumulado y volvía a
// insertar: la única barrera era `trg_payroll_payments_cap` (007), y ese tope
// sólo salta cuando el total DOBLADO supera `net_pay`. Con 2 × entrante ≤ saldo
// el reintento paga dos veces, sin que nada lo note.
//
// La decisión es la misma que en la emisión de facturas (MO-1, migración 041):
// dos envíos iguales son UNA operación y se reconocen por una MARCA que manda
// la pantalla, no por el contenido. Deduplicar por contenido prohibiría dos
// abonos legítimos del mismo monto y del mismo método hechos en dos intentos
// distintos —lo normal en un pago por partes—, así que la marca es lo único que
// distingue "el mismo envío" de "el mismo contenido".
//
// LA ARRUGA, resuelta acá: una operación NO es una fila. `payPayrollItem`
// inserta N porciones (una por método) en UNA sola sentencia multi-fila, así que
// un índice único sobre la marca a secas rechazaría la SEGUNDA porción de una
// operación legítima. La marca vive entonces SÓLO en la primera porción y el
// índice es PARCIAL sobre (payroll_item_id, idempotency_key) WHERE NOT NULL.
// La premisa —una sola sentencia— es la que hace sonora la forma: el 23505
// aborta el INSERT completo, así que ninguna porción de la repetición sobrevive.
// Si las porciones se insertaran fila por fila, esta opción no serviría y habría
// que pasar a un registro de operación en una fila aparte.

describe("payroll: el abono repetido no paga dos veces (CL-2)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const ITEM_ID = "item-cl2";
  const PERIOD_ID = "periodo-cl2";
  const NET = 100000;
  /** Marca del intento; la segunda existe para el control de no-extralimitación. */
  const MARK = "3f1c8a2e-9d47-4b6e-8f21-0c5a7b3d9e14";
  const OTHER_MARK = "5b2d9c7f-4e18-4a3b-9d60-1f8c2e5a7b43";

  /** Período en BORRADOR con su ítem (neto `netPay`) y dos métodos activos. */
  function seedDraftItem(netPay = NET): void {
    payrollPagedStub.tables.payroll_periods = [
      {
        id: PERIOD_ID,
        sede_id: payrollPagedStub.SEDE_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-15",
        status: "borrador",
        created_by: ACTOR.userId,
        closed_at: null,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    payrollPagedStub.tables.payroll_items = [
      {
        id: ITEM_ID,
        period_id: PERIOD_ID,
        employee_id: payrollPagedStub.EMPLOYEE_ID,
        base_fixed: netPay,
        commissions: 0,
        bonuses: 0,
        deductions_vales: 0,
        other_discounts: 0,
        net_pay: netPay,
        detail_json: [],
        created_at: "2026-09-30T23:59:59.000Z",
      },
    ];
    payrollPagedStub.tables.payroll_payments = [];
    payrollPagedStub.tables.payment_methods = [
      {
        id: "met-efectivo",
        sede_id: payrollPagedStub.SEDE_ID,
        code: "efectivo",
        name: "Efectivo",
        is_active: true,
        arqueable: true,
        fee_percent: 0,
      },
      {
        id: "met-transferencia",
        sede_id: payrollPagedStub.SEDE_ID,
        code: "transferencia",
        name: "Transferencia",
        is_active: true,
        arqueable: true,
        fee_percent: 0,
      },
    ];
  }

  const storedPayments = () => payrollPagedStub.tables.payroll_payments ?? [];
  const paymentInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_payments");

  /** Abono parcial por un solo método. */
  function partial(amount: number, method = "efectivo") {
    return { portions: [{ method_code: method, amount }] };
  }

  beforeEach(() => {
    resetPayrollStubState();
    // El índice único PARCIAL de la 042, aplicado como lo hace Postgres.
    payrollPagedStub.uniqueKeys = [
      { table: "payroll_payments", columns: ["payroll_item_id", "idempotency_key"] },
    ];
    seedDraftItem();
  });
  afterEach(() => resetPayrollStubState());

  it("RED: hoy el abono parcial reintentado paga DOS veces (2 x entrante <= saldo)", async () => {
    const first = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );
    const second = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );

    // HOY: dos filas de 30.000 (60.000 pagados de un neto de 100.000) y el
    // tope de 007 no lo ve: 2 × 30.000 ≤ 70.000 de saldo. Con la marca: UNA.
    expect(storedPayments()).toHaveLength(1);
    expect(storedPayments()[0]).toMatchObject({
      amount: 30000,
      method_code: "efectivo",
      idempotency_key: MARK,
    });
    expect(first.paid).toBe(30000);
    expect(second.paid).toBe(first.paid);
  });

  it("la repetición devuelve el MISMO resultado escribiendo nada (no-op exitoso)", async () => {
    const first = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );
    const repeat = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );

    expect(repeat.paid).toBe(first.paid);
    expect(repeat.remaining).toBe(first.remaining);
    expect(repeat.item.id).toBe(first.item.id);
    expect(repeat.payments.map((row) => row.id)).toEqual(first.payments.map((row) => row.id));
    // El reintento ni siquiera INTENTÓ escribir: lo reconoció antes.
    expect(paymentInserts()).toHaveLength(1);
    expect(storedPayments()).toHaveLength(1);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS abonos (y cada marca sigue siendo la suya)", async () => {
    // Un "un solo pago por ítem" global pasaría el caso anterior y estaría mal:
    // pagar en partes es el caso normal de PAY-04.
    const first = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );
    const second = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: OTHER_MARK, ...partial(30000) },
      ACTOR,
    );

    expect(storedPayments()).toHaveLength(2);
    expect(paymentInserts()).toHaveLength(2);
    expect(first.paid).toBe(30000);
    expect(second.paid).toBe(60000);
    // Y repetir la SEGUNDA marca devuelve la SEGUNDA operación, no la primera:
    // el reconocimiento es por (ítem, marca).
    const repeat = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: OTHER_MARK, ...partial(30000) },
      ACTOR,
    );
    expect(storedPayments()).toHaveLength(2);
    expect(repeat.paid).toBe(60000);
    // La repetición devuelve la SEGUNDA operación (su fila), no la primera: el
    // reconocimiento es por (ítem, marca).
    expect(repeat.payments[0]).toBe(storedPayments()[1]);
    expect(repeat.payments[0]).not.toBe(storedPayments()[0]);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) relee a la ganadora", async () => {
    const first = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );
    // La otra transacción se confirmó entre el lookup y el INSERT: el doble
    // saltea el lookup una vez para armar exactamente esa ventana.
    payrollPagedStub.skipMarkLookupOnce = true;

    const second = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );

    // El reintento sigue siendo un no-op: devuelve la operación de la ganadora.
    expect(second.paid).toBe(first.paid);
    expect(second.payments.map((row) => row.id)).toEqual(first.payments.map((row) => row.id));
    expect(storedPayments()).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó (dos intentos, una
    // fila). Si el lookup la hubiera visto, el camino del 23505 no existiría.
    expect(paymentInserts()).toHaveLength(2);
  });

  it("una operación de VARIAS porciones no la rechaza su propio índice único", async () => {
    // La arruga: 40% + 20% en una sola operación (una porción por método).
    const result = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      {
        idempotency_key: MARK,
        portions: [
          { method_code: "efectivo", amount: 40000 },
          { method_code: "transferencia", amount: 20000 },
        ],
      },
      ACTOR,
    );

    // UNA sentencia multi-fila (no dos inserts fila por fila): es la premisa de
    // la que depende que el 23505 aborte la operación entera.
    expect(paymentInserts()).toHaveLength(1);
    expect(storedPayments()).toHaveLength(2);
    // La marca vive SOLO en la primera porción: si estuviera en las dos, el
    // propio índice la rechazaría (y el doble, como Postgres, lo haría).
    expect(storedPayments()[0]).toMatchObject({ idempotency_key: MARK, amount: 40000 });
    expect(storedPayments()[1]).toMatchObject({ idempotency_key: null, amount: 20000 });
    expect(result.paid).toBe(60000);

    // Y repetir ESA operación también es un no-op: no escribe nada y el dinero
    // vuelve exacto (el acumulado se relee).
    const repeat = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      {
        idempotency_key: MARK,
        portions: [
          { method_code: "efectivo", amount: 40000 },
          { method_code: "transferencia", amount: 20000 },
        ],
      },
      ACTOR,
    );
    expect(storedPayments()).toHaveLength(2);
    expect(paymentInserts()).toHaveLength(1);
    expect(repeat.paid).toBe(60000);
    // COSTO DECLARADO de la forma elegida: la marca vive en la PRIMERA porción,
    // así que la repetición devuelve la fila de identidad de la operación y no
    // sus hermanas (no llevan marca y atribuirlas sería adivinar). El monto
    // (`paid`/`remaining`) sí es el real, porque se relee del acumulado.
    expect(repeat.payments).toHaveLength(1);
    expect(repeat.payments[0]).toBe(storedPayments()[0]);
  });

  it("control negativo: la marca no cambia la aritmética del dinero", async () => {
    // La primera operación entra; la segunda (marca NUEVA, o sea otro intento)
    // supera el saldo y se rechaza EXACTAMENTE como antes: con marca o sin
    // ella, el tope y el redondeo son los mismos.
    await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(30000) },
      ACTOR,
    );
    const failure: unknown = await payrollExtrasService
      .payPayrollItem(
        payrollPagedStub.SEDE_ID,
        ITEM_ID,
        { idempotency_key: OTHER_MARK, ...partial(80000) },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect(storedPayments()).toHaveLength(1);
    expect(paymentInserts()).toHaveLength(1);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    // Decisión explícita, igual que en la emisión: la marca es OBLIGATORIA. Un
    // envío sin marca no se puede reconocer como repetición, así que aceptarlo
    // es reabrir el defecto para ESE llamador —y la ruta REST es pública y es
    // justo la que reintenta sobre redes—. El rechazo es ruidoso (VALIDATION).
    const withoutMark: unknown = await payrollExtrasService
      .payPayrollItem(payrollPagedStub.SEDE_ID, ITEM_ID, partial(30000), ACTOR)
      .catch((error: unknown) => error);
    const malformed: unknown = await payrollExtrasService
      .payPayrollItem(
        payrollPagedStub.SEDE_ID,
        ITEM_ID,
        { idempotency_key: "no-es-un-uuid", ...partial(30000) },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(PayrollError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(PayrollError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de cualquier lectura de acumulado y de
    // cualquier escritura.
    expect(paymentInserts()).toHaveLength(0);
    expect(storedPayments()).toHaveLength(0);
  });

  it("la migración 042 deja la marca con un índice único PARCIAL y no reescribe filas", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "042_payment_idempotency.sql"),
      "utf8",
    );
    // La prosa explica lo que el archivo NO hace y nombra esas sentencias; las
    // aserciones de abajo miran el SQL, sin los comentarios.
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // La columna nace NULL: las filas históricas no tienen marca, sin backfill.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key");
    // Las dos puertas: nómina y cobro de factura.
    expect(sql).toContain("ALTER TABLE public.payroll_payments");
    expect(sql).toContain("ALTER TABLE public.invoice_payments");
    // La barrera final: a lo sumo UNA operación por marca y registro.
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_payments_item_idempotency_key",
    );
    expect(sql).toContain("ON public.payroll_payments (payroll_item_id, idempotency_key)");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payments_invoice_idempotency_key",
    );
    expect(sql).toContain("ON public.invoice_payments (invoice_id, idempotency_key)");
    // PARCIAL: las filas históricas (marca NULL) y las porciones hermanas de una
    // misma operación quedan fuera del índice.
    expect(sql.match(/WHERE idempotency_key IS NOT NULL/g)).toHaveLength(2);
    // No borra ni reescribe filas: no hay backfill que inventar.
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\./i);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});

// ---- CL-5: la nómina extraordinaria reintentada no paga dos veces ---

/**
 * CL-5: la puerta que NO tiene obligación contra la cual compararse. El monto
 * del pago extraordinario es a propósito SIN TOPE (036: "El monto lo escribe el
 * admin y NO se topa"), así que no hay pendiente, ni cuota, ni serie: cualquier
 * monto positivo es legítimo. Sin identidad del ENVÍO, un reintento (doble
 * clic, o el navegador reenviando tras cortarse la red) registra SIEMPRE un
 * segundo pago extraordinario: plata que sale dos veces y que la nómina no
 * recupera sola.
 *
 * LA CLAVE: (`employee_id`, `idempotency_key`). El pago extraordinario NO tiene
 * período ni ítem —esa es su razón de ser (036): existe justo para pagar días
 * que un período CERRADO ya cubrió—, así que su único registro es el EMPLEADO:
 * es a quien el pago significa ("le pagué a X") y es la dimensión del historial
 * del módulo (`idx_payroll_extras_employee_paid_at`). La sede no entra en la
 * clave porque no agrega identidad: el servicio resuelve al empleado y exige
 * que sea de la sede del actor (uno ajeno es NOT_FOUND antes del lookup), así
 * que el lookup no puede devolver el pago de otra sede. La misma marca con otro
 * empleado es OTRA operación y hay prueba.
 *
 * LA ARRUGA DE 042 NO APLICA ACÁ: este camino inserta UNA sola fila, así que la
 * marca vive en esa única fila, no hay porciones hermanas que enumerar y el
 * índice nunca puede rechazar una operación legítima.
 *
 * EL DECIDIR DEL ADMIN NO CAMBIA: el monto sigue sin tope y la guía sigue
 * siendo guía. Lo único que cambia es que el MISMO envío no entra dos veces.
 */
describe("payroll: CL-5 la nómina extraordinaria reintentada no paga dos veces", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-extras",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const EMPLOYEE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const METHOD = {
    id: "pm-efectivo-cl5",
    sede_id: payrollPagedStub.SEDE_ID,
    code: "efectivo",
    name: "Efectivo",
    is_active: true,
    arqueable: true,
    fee_percent: 0,
  };
  const MARK = "9f3b1d7c-4a86-4e02-b5c1-7d90e2f4a6b3";
  const OTHER_MARK = "d1c8e540-2f79-4a63-9b04-6e3a1c7f8d25";

  function employeeRow(id = EMPLOYEE_ID) {
    return {
      id,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: `Empleada ${id.slice(0, 4)}`,
      employee_code: null,
      document: "1000000001",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: 1_400_000,
      commission_percent: null,
      is_active: true,
    };
  }

  /** Empleada, un método de pago activo y el registro de pagos vacío. */
  function seed(salaryFixed = 1_400_000): void {
    payrollPagedStub.tables.employees = [
      { ...employeeRow(), salary_fixed: salaryFixed },
      { ...employeeRow(EMPLOYEE_2), salary_fixed: salaryFixed },
    ];
    payrollPagedStub.tables.payment_methods = [METHOD];
    payrollPagedStub.tables.payroll_extras = [];
  }

  function extraInput(overrides: Record<string, unknown> = {}) {
    return {
      idempotency_key: MARK,
      employee_id: EMPLOYEE_ID,
      amount: 1_800_000,
      method_code: "efectivo",
      reference: "Recibo 001",
      reason: "Renuncia del 2026-09-16",
      kind: "renuncia",
      days_from: "2026-09-01",
      days_to: "2026-09-16",
      ...overrides,
    };
  }

  const storedExtras = () => payrollPagedStub.tables.payroll_extras ?? [];
  const extraInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_extras");

  beforeEach(() => {
    resetPayrollStubState();
    // El índice único PARCIAL de la 044, aplicado como lo hace Postgres.
    payrollPagedStub.uniqueKeys = [
      { table: "payroll_extras", columns: ["employee_id", "idempotency_key"] },
    ];
    seed();
  });
  afterEach(() => resetPayrollStubState());

  it("RED: hoy el pago extraordinario reintentado escribe SIEMPRE un segundo pago", async () => {
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    const second = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);

    // HOY: dos filas de 1.800.000 (3.600.000 pagados). No hay tope ni
    // obligación que lo frene: el monto lo escribe el admin y no se topa.
    expect(storedExtras()).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(extraInserts()).toHaveLength(1);
  });

  it("la repetición devuelve el MISMO pago escribiendo nada (no-op exitoso)", async () => {
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    const repeat = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);

    expect(repeat).toEqual(first);
    expect(repeat.id).toBe(first.id);
    // El reintento ni siquiera INTENTÓ escribir: lo reconoció antes.
    expect(extraInserts()).toHaveLength(1);
    expect(storedExtras()).toHaveLength(1);
    // Y no deja rastro doble: una sola auditoría, la del pago que ocurrió.
    expect(payrollPagedStub.inserts.filter((entry) => entry.table === "audit_logs")).toHaveLength(1);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS pagos (el admin sigue pagando lo que decida)", async () => {
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    const second = await payrollExtrasService.payPayrollExtra(
      extraInput({ idempotency_key: OTHER_MARK }),
      ACTOR,
    );

    expect(second.id).not.toBe(first.id);
    expect(storedExtras()).toHaveLength(2);
    expect(extraInserts()).toHaveLength(2);
    // Y repetir la SEGUNDA marca devuelve la SEGUNDA operación, no la primera.
    const repeat = await payrollExtrasService.payPayrollExtra(
      extraInput({ idempotency_key: OTHER_MARK }),
      ACTOR,
    );
    expect(repeat.id).toBe(second.id);
    expect(storedExtras()).toHaveLength(2);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) relee a la ganadora", async () => {
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    // La otra transacción se confirmó entre el lookup y el INSERT: el doble
    // saltea el lookup UNA vez para armar exactamente esa ventana.
    payrollPagedStub.skipMarkLookupOnce = true;

    const second = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);

    expect(second.id).toBe(first.id);
    expect(storedExtras()).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó y el índice lo frenó
    // (dos intentos, una fila).
    expect(extraInserts()).toHaveLength(2);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    const withoutMark: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput({ idempotency_key: undefined }), ACTOR)
      .catch((error: unknown) => error);
    const malformed: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput({ idempotency_key: "no-es-un-uuid" }), ACTOR)
      .catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(PayrollError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(PayrollError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de cualquier lectura y de cualquier escritura.
    expect(extraInserts()).toHaveLength(0);
    expect(storedExtras()).toHaveLength(0);
    // La misma regla en el esquema puro (y en el CHECK de forma de la 044).
    expect(payrollExtraSchema.safeParse(extraInput({ idempotency_key: undefined })).success).toBe(false);
    expect(payrollExtraSchema.safeParse(extraInput({ idempotency_key: "x" })).success).toBe(false);
    expect(payrollExtraSchema.safeParse(extraInput()).success).toBe(true);
  });

  it("multi-identidad: la misma marca para OTRO empleado es OTRA operación", async () => {
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    const other = await payrollExtrasService.payPayrollExtra(
      extraInput({ employee_id: EMPLOYEE_2 }),
      ACTOR,
    );

    expect(other.id).not.toBe(first.id);
    expect(storedExtras()).toHaveLength(2);
    // Cada una reconoce la SUYA: la marca se resuelve dentro del empleado.
    const repeatOther = await payrollExtrasService.payPayrollExtra(
      extraInput({ employee_id: EMPLOYEE_2 }),
      ACTOR,
    );
    expect(repeatOther.id).toBe(other.id);
    expect(storedExtras()).toHaveLength(2);
  });

  it("la marca se reconoce aunque el método se haya desactivado después (el método no es la identidad)", async () => {
    // El lookup va apenas el REGISTRO (el empleado) queda validado, porque la
    // operación no se identifica por el método: un reintento que llega con el
    // método ya inactivo se reconoce —no se pierde plata ni se duplica—. Un
    // pago NUEVO con el método inactivo sigue rechazándose (METHOD_INACTIVE).
    const first = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    payrollPagedStub.tables.payment_methods = [{ ...METHOD, is_active: false }];

    const repeat = await payrollExtrasService.payPayrollExtra(extraInput(), ACTOR);
    expect(repeat.id).toBe(first.id);
    expect(storedExtras()).toHaveLength(1);

    const fresh: unknown = await payrollExtrasService
      .payPayrollExtra(extraInput({ idempotency_key: OTHER_MARK }), ACTOR)
      .catch((error: unknown) => error);
    expect(fresh).toMatchObject({ code: "METHOD_INACTIVE", status: 422 });
  });

  it("control negativo: el monto sigue SIN TOPE (la marca no es un cap)", async () => {
    // La decisión del dueño no cambia: el monto lo escribe el admin y no se
    // topa. Dos intentos DISTINTOS con montos enormes entran los dos.
    const first = await payrollExtrasService.payPayrollExtra(
      extraInput({ amount: 9_999_999, kind: "despido" }),
      ACTOR,
    );
    const second = await payrollExtrasService.payPayrollExtra(
      extraInput({ idempotency_key: OTHER_MARK, amount: 9_999_999, kind: "despido" }),
      ACTOR,
    );

    expect(first.amount).toBe(9_999_999);
    expect(second.amount).toBe(9_999_999);
    expect(storedExtras()).toHaveLength(2);
  });

  it("la migración 044 deja la marca con un índice único PARCIAL y no reescribe filas", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "044_remaining_payment_idempotency.sql"),
      "utf8",
    );
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toContain("ALTER TABLE public.payroll_extras");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_extras_employee_idempotency_key",
    );
    expect(sql).toContain("ON public.payroll_extras (employee_id, idempotency_key)");
    expect(sql).toMatch(/WHERE idempotency_key IS NOT NULL/);
    expect(sql).toContain("payroll_extras_idempotency_key_shape");
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\./i);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});

// ---- CL-5: la solicitud de vale reintentada no abre un segundo vale ---

/**
 * CL-5: la puerta de la CAJA que no tiene obligación individual. Los topes de
 * 026 (día y semana) son ACUMULADOS: una obligación TOTAL, no la identidad de un
 * envío. Mientras `2 × monto` quepa en el día y en la semana, un reintento
 * (doble clic, o el navegador reenviando tras cortarse la red) abría un SEGUNDO
 * vale: segunda salida de caja en el arqueo y segundo descuento en la nómina.
 * Se midió antes de tocar el código (dos vales APROBADOS con el mismo cuerpo) y
 * esa medición es la primera prueba de acá.
 *
 * LA CLAVE: (`employee_id`, `idempotency_key`). El vale es una OBLIGACIÓN del
 * empleado —es lo que la nómina descuenta y es la dimensión de los topes
 * acumulados de 026, `idx_voucher_requests_employee_date`—, así que el registro
 * de la operación es el empleado. El TURNO NO ENTRA, deliberadamente: el turno
 * es el dueño del EFECTIVO que sale, no lo que el vale ES, y meterlo costaría el
 * defecto mismo —un reintento que llegue después de que el turno original se
 * cerró y se abrió OTRO resolvería contra el turno nuevo, no encontraría su
 * marca ahí y abriría el segundo vale—. Sin el turno, ese reintento se reconoce.
 * La sede tampoco entra: el servicio valida que el empleado sea de la sede del
 * actor antes del lookup, así que no puede cruzar de sede. La misma marca para
 * otro empleado es OTRA operación, y hay prueba.
 *
 * LA ARRUGA DE 042 NO APLICA ACÁ: un solo vale por llamada, una sola fila.
 */
describe("payroll: CL-5 la solicitud de vale reintentada no abre un segundo vale", () => {
  const ACTOR: PayrollActor = {
    userId: "u-cajero-vale",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const EMPLOYEE_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const SHIFT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const OTHER_SHIFT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const METHOD = {
    id: "pm-efectivo-vale",
    sede_id: payrollPagedStub.SEDE_ID,
    code: "efectivo",
    name: "Efectivo",
    is_active: true,
    arqueable: true,
    fee_percent: 0,
  };
  const MARK = "4a8d2f61-9b03-4c75-8e12-5d7f0a3b6c94";
  const OTHER_MARK = "e7b1c395-36a0-4d84-a502-8c1f9e4d7b20";
  const DAY = "2026-09-30";

  function employeeRow(id: string) {
    return {
      id,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: `Empleada ${id.slice(0, 4)}`,
      employee_code: null,
      document: "1000000001",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: 1_400_000,
      commission_percent: null,
      is_active: true,
    };
  }

  /** Caja abierta del actor, dos empleadas, un método arqueable y sin vales. */
  function seed(): void {
    payrollPagedStub.tables.cash_shifts = [
      {
        id: SHIFT_ID,
        sede_id: payrollPagedStub.SEDE_ID,
        cash_register_id: null,
        opened_by: ACTOR.userId,
        closed_by: null,
        opened_at: "2026-09-30T08:00:00.000Z",
        closed_at: null,
        opening_base: 500000,
        expected_cash: null,
        counted_cash: null,
        base_left: null,
        cash_withdrawn: null,
        base_difference: null,
        status: "abierto",
        observation: null,
      },
    ];
    payrollPagedStub.tables.users = [
      { id: ACTOR.userId, full_name: "Cajera", sede_id: payrollPagedStub.SEDE_ID },
    ];
    payrollPagedStub.tables.employees = [employeeRow(EMPLOYEE_ID), employeeRow(EMPLOYEE_2)];
    payrollPagedStub.tables.payment_methods = [METHOD];
    // 072: los topes se leen de `system_settings`, una fila por ajuste.
    payrollPagedStub.tables.system_settings = voucherSettingRows({
      max_per_day: 200000,
      max_per_week: 400000,
    });
    payrollPagedStub.tables.voucher_requests = [];
    payrollPagedStub.tables.audit_logs = [];
  }

  function voucherInput(overrides: Record<string, unknown> = {}) {
    return {
      idempotency_key: MARK,
      employee_id: EMPLOYEE_ID,
      amount: 50000,
      method_code: "efectivo",
      request_date: DAY,
      ...overrides,
    };
  }

  const storedVouchers = () => payrollPagedStub.tables.voucher_requests ?? [];
  const voucherInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "voucher_requests");
  const auditInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "audit_logs");

  beforeEach(() => {
    resetPayrollStubState();
    // El índice único PARCIAL de la 044, aplicado como lo hace Postgres.
    payrollPagedStub.uniqueKeys = [
      { table: "voucher_requests", columns: ["employee_id", "idempotency_key"] },
    ];
    seed();
  });
  afterEach(() => resetPayrollStubState());

  it("RED medido: el mismo vale pedido dos veces abre DOS vales (2 × monto ≤ topes)", async () => {
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    const second = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);

    // HOY (antes de la 044): dos vales de 50.000, los DOS aprobados —el segundo
    // sale de la caja y se descuenta de la nómina igual que el primero—, y los
    // topes de 026 no lo ven: 50.000 + 50.000 ≤ 200.000 del día. Con la marca: UNO.
    expect(storedVouchers()).toHaveLength(1);
    expect(second.voucher.id).toBe(first.voucher.id);
    expect(first.auto_approved).toBe(true);
    expect(second.auto_approved).toBe(true);
    expect(storedVouchers().reduce((acc, row) => acc + Number(row.amount), 0)).toBe(50000);
  });

  it("la repetición devuelve el MISMO vale escribiendo nada (no-op exitoso)", async () => {
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    const repeat = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);

    expect(repeat.voucher.id).toBe(first.voucher.id);
    expect(repeat.voucher.status).toBe(first.voucher.status);
    expect(repeat.auto_approved).toBe(first.auto_approved);
    expect(repeat.requires_approval).toBe(first.requires_approval);
    // El reintento ni siquiera INTENTÓ escribir: lo reconoció antes.
    expect(voucherInserts()).toHaveLength(1);
    expect(storedVouchers()).toHaveLength(1);
    // Y no deja rastro doble: una sola auditoría, la del vale que ocurrió.
    expect(auditInserts()).toHaveLength(1);
  });

  it("la repetición NO vuelve a decidir la elegibilidad (los topes acumulados ya incluyen el primer vale)", async () => {
    // Si la repetición reevaluara el tope con los totales de AHORA, este envío
    // —190.000 con tope diario de 200.000— daría 190.000 + 190.000 > 200.000 y
    // respondería "pendiente, fuera de rango" sobre un vale que SÍ se abrió
    // dentro de rango. Devuelve el ESTADO REGISTRADO: aprobado y utilizable.
    const first = await payrollExtrasService.requestVoucher(
      voucherInput({ amount: 190000 }),
      ACTOR,
    );
    const repeat = await payrollExtrasService.requestVoucher(
      voucherInput({ amount: 190000 }),
      ACTOR,
    );

    expect(first.auto_approved).toBe(true);
    expect(repeat.voucher.id).toBe(first.voucher.id);
    expect(repeat.auto_approved).toBe(true);
    expect(repeat.requires_approval).toBe(false);
    expect(storedVouchers()).toHaveLength(1);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS vales", async () => {
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    const second = await payrollExtrasService.requestVoucher(
      voucherInput({ idempotency_key: OTHER_MARK }),
      ACTOR,
    );

    expect(second.voucher.id).not.toBe(first.voucher.id);
    expect(storedVouchers()).toHaveLength(2);
    expect(voucherInserts()).toHaveLength(2);
    // Y repetir la SEGUNDA marca devuelve la SEGUNDA operación, no la primera.
    const repeat = await payrollExtrasService.requestVoucher(
      voucherInput({ idempotency_key: OTHER_MARK }),
      ACTOR,
    );
    expect(repeat.voucher.id).toBe(second.voucher.id);
    expect(storedVouchers()).toHaveLength(2);
  });

  it("control negativo: los topes de 026 siguen decidiendo (fuera de rango queda PENDIENTE, no se rechaza)", async () => {
    // La marca no cambia la aritmética ni la decisión: con una marca NUEVA, un
    // vale que pasa el tope del día entra igual que antes, y entra PENDIENTE
    // (alerta para el admin). Lo único que la marca impide es repetir el MISMO
    // envío.
    await payrollExtrasService.requestVoucher(voucherInput({ amount: 190000 }), ACTOR);
    const overCap = await payrollExtrasService.requestVoucher(
      voucherInput({ idempotency_key: OTHER_MARK, amount: 50000 }),
      ACTOR,
    );

    expect(storedVouchers()).toHaveLength(2);
    expect(overCap.requires_approval).toBe(true);
    expect(overCap.auto_approved).toBe(false);
    expect(overCap.voucher.status).toBe("pendiente");
    expect(overCap.over_day).toBe(true);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) relee a la ganadora", async () => {
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    // La otra transacción se confirmó entre el lookup y el INSERT: el doble
    // saltea el lookup UNA vez para armar exactamente esa ventana.
    payrollPagedStub.skipMarkLookupOnce = true;

    const second = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);

    expect(second.voucher.id).toBe(first.voucher.id);
    expect(storedVouchers()).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó y el índice lo frenó
    // (dos intentos, una fila).
    expect(voucherInserts()).toHaveLength(2);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    const withoutMark: unknown = await payrollExtrasService
      .requestVoucher(voucherInput({ idempotency_key: undefined }), ACTOR)
      .catch((error: unknown) => error);
    const malformed: unknown = await payrollExtrasService
      .requestVoucher(voucherInput({ idempotency_key: "no-es-un-uuid" }), ACTOR)
      .catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(PayrollError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(PayrollError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de cualquier lectura y de cualquier escritura.
    expect(voucherInserts()).toHaveLength(0);
    expect(storedVouchers()).toHaveLength(0);
    // La misma regla en el esquema puro (y en el CHECK de forma de la 044).
    expect(requestVoucherSchema.safeParse(voucherInput({ idempotency_key: undefined })).success).toBe(false);
    expect(requestVoucherSchema.safeParse(voucherInput({ idempotency_key: "x" })).success).toBe(false);
    expect(requestVoucherSchema.safeParse(voucherInput()).success).toBe(true);
  });

  it("multi-identidad: la misma marca para OTRO empleado es OTRA operación", async () => {
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    const other = await payrollExtrasService.requestVoucher(
      voucherInput({ employee_id: EMPLOYEE_2 }),
      ACTOR,
    );

    expect(other.voucher.id).not.toBe(first.voucher.id);
    expect(storedVouchers()).toHaveLength(2);
    // Cada una reconoce la SUYA: la marca se resuelve dentro del empleado.
    const repeatOther = await payrollExtrasService.requestVoucher(
      voucherInput({ employee_id: EMPLOYEE_2 }),
      ACTOR,
    );
    expect(repeatOther.voucher.id).toBe(other.voucher.id);
    expect(storedVouchers()).toHaveLength(2);
  });

  it("la clave NO mira el turno: un reintento que llega con OTRO turno abierto se reconoce igual", async () => {
    // Con el turno dentro de la clave, este reintento no encontraría su marca y
    // abriría el segundo vale: justo el defecto que la 044 cierra. Por eso el
    // turno NO entra.
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    payrollPagedStub.tables.cash_shifts = [
      { ...(payrollPagedStub.tables.cash_shifts?.[0] ?? {}), id: OTHER_SHIFT_ID },
    ];

    const repeat = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);

    expect(repeat.voucher.id).toBe(first.voucher.id);
    expect(storedVouchers()).toHaveLength(1);
  });

  it("limitación declarada: un reintento que llega SIN caja abierta se rechaza, no se reconoce", async () => {
    // Misma familia que CL-3/CL-4: las guardas de la CAJA van antes del lookup
    // (deciden si esta caja puede entregar dinero). El caso real del reintento
    // ocurre segundos después, con la misma caja abierta, y ahí la marca SÍ
    // reconoce. No se pierde plata: el rechazo es ruidoso y, con la caja abierta
    // de nuevo, la misma marca sigue reconociendo.
    const first = await payrollExtrasService.requestVoucher(voucherInput(), ACTOR);
    payrollPagedStub.tables.cash_shifts = [];

    const failure: unknown = await payrollExtrasService
      .requestVoucher(voucherInput(), ACTOR)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "NO_OPEN_SHIFT", status: 409 });
    expect(storedVouchers()).toHaveLength(1);
    expect(first.voucher.id).toBe(storedVouchers()[0]?.id);
  });

  it("la migración 044 cierra la tercera puerta con su marca, su forma y su índice parcial", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "044_remaining_payment_idempotency.sql"),
      "utf8",
    );
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).toContain("ALTER TABLE public.voucher_requests");
    // Tres tablas: comisión, pago extraordinario y vale; tres columnas nullables.
    expect(sql.match(/ADD COLUMN IF NOT EXISTS idempotency_key/g)).toHaveLength(3);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key text NULL");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_requests_employee_idempotency_key",
    );
    expect(sql).toContain("ON public.voucher_requests (employee_id, idempotency_key)");
    expect(sql.match(/WHERE idempotency_key IS NOT NULL/g)).toHaveLength(3);
    expect(sql.match(/full replace/g) ?? []).toHaveLength(0);
    expect(sql).toContain("voucher_requests_idempotency_key_shape");
    // La clave NO lleva el turno: se declara y se ve en el SQL.
    expect(sql).not.toMatch(/voucher_requests \([^)]*cash_shift_id/);
    expect(raw).toContain("el TURNO NO ENTRA");
    // El costo de numeración se declara para las TRES tablas (uuid: ninguno).
    expect(raw).toContain("voucher_requests.id` también (007_payroll.sql)");
    // Ya no queda ninguna puerta declarada abierta.
    expect(raw).not.toContain("NO CIERRA LA TERCERA PUERTA");
    expect(raw).toContain("MOVIMIENTO MANUAL DE INVENTARIO");
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\./i);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});


// ---- CL-8: el cálculo de la nómina persiste ítems y vales en UNA transacción ---

/**
 * CL-8: la VENTANA MÁS CARA de las escrituras múltiples sin transacción.
 *
 * `calculatePayroll` escribía en DOS requests distintos contra PostgREST:
 * primero el upsert de `payroll_items`
 * (`src/features/payroll/service.ts:1051`) y después el `UPDATE` de
 * `voucher_requests` a `descontada` (`service.ts:1072-1075`). Un fallo entre los
 * dos —una escritura que falla, la conexión que se corta— dejaba el ítem YA
 * escrito descontando el vale del neto mientras el vale seguía
 * `pendiente`/`aprobada`:
 *
 *   * el empleado cobra CORTO y en silencio (el descuento ya está en la
 *     liquidación firmada);
 *   * el vale sigue VIGENTE, así que el cálculo siguiente lo vuelve a
 *     descontar: el mismo vale, descontado dos veces (dos escrituras de ítem
 *     confirmadas que lo incluyen);
 *   * y el estado es INVISIBLE en la pantalla, porque los dos números que se
 *     miran (el neto y el estado del vale) no están juntos en ningún lado.
 *
 * El arreglo es el de la casa (039/040/046): una FUNCIÓN SQL por `db.rpc(...)`.
 * Una función es UNA sentencia y una sentencia corre ENTERA dentro de una sola
 * transacción del servidor, así que el upsert de los ítems y el flip de los
 * vales dejan de tener "mitad del camino". La ARITMÉTICA no se mueve: el
 * servicio sigue calculando cada monto (incluido el descuento de vales) y la
 * función sólo ESCRIBE lo que recibe.
 */
describe("payroll: el cálculo persiste ítems y vales en UNA transacción (CL-8)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-cl8",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const VOUCHER_ID = "5c0e1f2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const SALARY = 1_400_000;
  const VALE = 100_000;

  function employeeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: payrollPagedStub.EMPLOYEE_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: "Empleada CL-8",
      employee_code: "E-8",
      document: "1000000008",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      salary_fixed: SALARY,
      commission_percent: null,
      is_active: true,
      ...overrides,
    };
  }

  /** Período en borrador que cubre todo enero, un vale y la planta pedida. */
  function seed(overrides: { voucherStatus?: string; vouchers?: Array<Record<string, unknown>>; employees?: Array<Record<string, unknown>> } = {}) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: ACTOR.userId,
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      employees: overrides.employees ?? [employeeRow()],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests:
        overrides.vouchers ?? [
          {
            id: VOUCHER_ID,
            sede_id: payrollPagedStub.SEDE_ID,
            employee_id: payrollPagedStub.EMPLOYEE_ID,
            amount: VALE,
            request_date: "2026-01-15",
            status: overrides.voucherStatus ?? "pendiente",
            approved_by: null,
            approval_code: null,
            observation: null,
          },
        ],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  const voucherRow = () => payrollPagedStub.tables.voucher_requests[0];
  /** Escrituras de ítem CONFIRMADAS: cada una descuenta los vales que incluye. */
  const committedDiscounts = () =>
    payrollPagedStub.itemWrites.filter((payload) =>
      payload.some((row) => Number(row.deductions_vales ?? 0) > 0),
    );
  const flippedTimes = (id: string) =>
    payrollPagedStub.voucherFlips.flat().filter((flipped) => flipped === id).length;

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // --------------------------------------------------------------- RED ---

  it("RED medido: un fallo al descontar el vale deja el ÍTEM YA ESCRITO y el vale sin marcar", async () => {
    seed();
    // La ventana: la escritura que marca el vale falla DESPUÉS del upsert.
    payrollPagedStub.failVoucherFlip = "PAYROLL_VOUCHER_CONFLICT";

    const outcome: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    // HOY: el ítem quedó escrito descontando el vale y NADA lo revierte (es otro
    // request, no hay transacción). La liquidación dice que el vale se descontó.
    expect(committedDiscounts()).toEqual([]);
    // Y el vale sigue VIGENTE: la próxima corrida lo vuelve a descontar.
    expect(voucherRow().status).toBe("pendiente");
  });

  it("RED medido: el vale que quedó sin marcar se descuenta OTRA VEZ en el cálculo siguiente", async () => {
    seed();
    payrollPagedStub.failVoucherFlip = "PAYROLL_VOUCHER_CONFLICT";
    // La corrida que falla a mitad de camino.
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR).catch(
      () => undefined,
    );
    // El reintento (la corrida siguiente).
    payrollPagedStub.failVoucherFlip = null;
    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    // El vale termina marcado, pero fue DESCONTADO DOS VECES: la primera quedó
    // escrita pese al fallo y la segunda es un descuento nuevo sobre el mismo
    // vale. Con una sola transacción, la primera no deja nada y sólo hay una.
    expect(voucherRow().status).toBe("descontada");
    expect(committedDiscounts()).toHaveLength(1);
    expect(flippedTimes(VOUCHER_ID)).toBe(1);
  });

  // ------------------------------------------------------------- GREEN ---

  it("GREEN: un cálculo exitoso escribe cada ítem y descuenta cada vale EXACTAMENTE una vez", async () => {
    seed();

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    );

    // Una sola escritura para las dos cosas: el upsert y el flip viajan juntos.
    expect(payrollPagedStub.rpcCalls.filter((call) => call.name === "payroll_apply_atomic")).toHaveLength(1);
    // El flip ya NO es un request suelto.
    expect(payrollPagedStub.updates.filter((entry) => entry.table === "voucher_requests")).toEqual([]);
    expect(committedDiscounts()).toHaveLength(1);
    expect(flippedTimes(VOUCHER_ID)).toBe(1);
    expect(voucherRow().status).toBe("descontada");
    // El resultado para quien llama NO cambia: el mismo detalle del período.
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      employee_id: payrollPagedStub.EMPLOYEE_ID,
      deductions_vales: VALE,
    });
  });

  it("la transacción ESCRIBE lo que el servicio calculó: ningún monto se recalcula en SQL", async () => {
    seed();

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    // El payload que la base guardó es el que armó la aritmética de TypeScript:
    // fijo del mes completo (1.400.000), el vale descontado (100.000) y el neto
    // ya resuelto (1.300.000). Si la función sumara o restara, estos números no
    // podrían venir dados.
    expect(payrollPagedStub.itemWrites[0][0]).toMatchObject({
      period_id: payrollPagedStub.PERIOD_ID,
      employee_id: payrollPagedStub.EMPLOYEE_ID,
      base_fixed: SALARY,
      commissions: 0,
      bonuses: 0,
      deductions_vales: VALE,
      other_discounts: 0,
      net_pay: SALARY - VALE,
    });
    const args = payrollPagedStub.rpcCalls[0].args;
    expect(args.p_period_id).toBe(payrollPagedStub.PERIOD_ID);
    expect(args.p_voucher_ids).toEqual([VOUCHER_ID]);
    expect((args.p_items as Array<Record<string, unknown>>)[0].net_pay).toBe(SALARY - VALE);
  });

  it("la CARRERA del vale se RECHAZA en vez de pisar el descuento ajeno, y no escribe nada", async () => {
    // Otro cálculo descuenta el vale ENTRE la lectura del servicio y la
    // escritura: cuando la transacción evalúa su precondición, el vale ya no
    // está pendiente. El `UPDATE` suelto afectaba CERO filas y seguía de largo
    // EN SILENCIO, dejando los ítems escritos sobre un descuento ajeno.
    seed();
    const voucher = voucherRow();
    payrollPagedStub.beforeUpdate = {
      table: "voucher_requests",
      run: () => {
        voucher.status = "descontada";
        voucher.approved_by = "u-otro-calculo";
      },
    };

    const outcome: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    // NADA escrito: el upsert viaja en la misma transacción y se revierte con ella.
    expect(payrollPagedStub.itemWrites).toEqual([]);
    expect(payrollPagedStub.tables.payroll_items).toEqual([]);
    // El descuento ajeno NO se pisa: el vale queda como lo dejó el otro cálculo.
    expect(voucher.status).toBe("descontada");
    expect(voucher.approved_by).toBe("u-otro-calculo");
  });

  it("una entrada rechazada por el servidor se rechaza con CERO escrituras", async () => {
    seed();
    // Las guardas de forma y las redes de conteo del servidor.
    payrollPagedStub.failRpcWith = "PAYROLL_INVALID";

    const outcome: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(payrollPagedStub.itemWrites).toEqual([]);
    expect(payrollPagedStub.tables.payroll_items).toEqual([]);
    expect(voucherRow().status).toBe("pendiente");
    // No es vacuidad: la transacción SÍ se intentó.
    expect(payrollPagedStub.rpcCalls).toHaveLength(1);
  });

  it("control negativo: sin vales y sin planta no se abre ninguna transacción", async () => {
    // Si la operación no tuviera nada que escribir, el "nada escrito" de los
    // tests de arriba también se cumpliría por vacuidad.
    seed({ vouchers: [], employees: [] });

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {},
      ACTOR,
    );

    expect(payrollPagedStub.rpcCalls).toEqual([]);
    expect(payrollPagedStub.itemWrites).toEqual([]);
    expect(detail.items).toEqual([]);
  });

  it("control negativo: un cálculo exitoso SÍ escribe (la transacción no es un no-op)", async () => {
    seed();

    await calculatePayroll(payrollPagedStub.SEDE_ID, payrollPagedStub.PERIOD_ID, {}, ACTOR);

    expect(payrollPagedStub.itemWrites).toHaveLength(1);
    expect(payrollPagedStub.tables.payroll_items).toHaveLength(1);
    expect(payrollPagedStub.voucherFlips).toEqual([[VOUCHER_ID]]);
  });
});

describe("migración 047_payroll_apply_atomic.sql (CL-8)", () => {
  // La lectura es por test: el RED del SERVICIO corre con el archivo todavía
  // ausente, y una lectura en el cuerpo del `describe` rompería la colección de
  // todo el archivo en vez de fallar sólo estos tests.
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "047_payroll_apply_atomic.sql"),
      "utf8",
    );
    // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("las DOS escrituras viven en UNA función: una sentencia, una transacción", () => {
    const { sql } = migration();
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.payroll_apply_atomic");
    expect(sql).toContain("INSERT INTO public.payroll_items");
    expect(sql).toContain("jsonb_array_elements(p_items)");
    // El upsert del servicio (`onConflict: "period_id,employee_id"`) traducido.
    expect(sql).toMatch(/ON CONFLICT\s*\(\s*period_id\s*,\s*employee_id\s*\)\s*DO UPDATE/i);
    // El flip del vale, con la PRECONDICIÓN de estado del UPDATE actual.
    expect(sql).toContain("UPDATE public.voucher_requests");
    expect(sql).toMatch(/status\s*=\s*'descontada'/);
    expect(sql).toMatch(/status\s*IN\s*\(\s*'pendiente'\s*,\s*'aprobada'\s*\)/);
    // Orden determinista de los locks (misma disciplina que 046): sin él, dos
    // aportes concurrentes del mismo período pueden bloquearse en ciclo.
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it("tiene las DOS redes de conteo: el flip exacto y los ítems exactos", () => {
    const { sql } = migration();
    const diagnostics = sql.match(/GET DIAGNOSTICS/g) ?? [];
    expect(diagnostics).toHaveLength(2);
    expect(sql).toContain("RAISE EXCEPTION");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL.
    expect(sql).toMatch(/coalesce\(/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    const { sql } = migration();
    // La tabla ya valida `neto = bruto − vales − otros` con su CHECK de 007
    // (validar no es calcular): esta migración no agrega una sola expresión
    // aritmética sobre las columnas de dinero.
    for (const column of [
      "base_fixed",
      "commissions",
      "bonuses",
      "deductions_vales",
      "other_discounts",
      "net_pay",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(sql).not.toContain("CHECK");
    expect(sql).not.toMatch(/sum\s*\(/i);
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    const { sql } = migration();
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.payroll_apply_atomic");
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public");
  });

  it("no borra ni reescribe datos: sólo la función y sus permisos", () => {
    const { sql } = migration();
    expect(sql).not.toMatch(/^\s*DELETE/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("explica el motivo, el acoplamiento de despliegue y el costo de numeración", () => {
    const { raw } = migration();
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    // El número libre siguiente y el archivo hermano (046) que se espeja.
    expect(raw).toContain("047");
    expect(raw).toContain("046");
  });
});

// ------------------- NV-01: vales reales y deuda del sobrante de vales ---
//
// La columna de vales mostraba el descuento RECORTADO al bruto (para sostener
// la igualdad del CHECK sin neto negativo) y el sobrante se perdía. Ahora el
// total REAL vive aparte (`voucher_total`, fuera de la igualdad), el sobrante
// queda como DEUDA del empleado (`payroll_discount_carries`) y se descuenta en
// el período siguiente dentro de `other_discounts`, marcado en la MISMA
// transacción que lo descuenta (062).
describe("payroll: los vales son vales y el sobrante es deuda del empleado (NV-01)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const EARLIER_PERIOD_ID = "33333333-3333-4333-8333-333333333333";
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const SERVICE_ID = payrollPagedStub.SERVICE_ID;
  const CARRY_ID = "44444444-4444-4444-8444-444444444444";

  function employeeRow() {
    return {
      id: EMPLOYEE_ID,
      sede_id: payrollPagedStub.SEDE_ID,
      user_id: null,
      full_name: "Empleada de vales",
      employee_code: "E-7",
      document: "1000000007",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      // Porcentaje sin bonos: el bruto ES la comisión, el caso que el dueño
      // midió (el vale recortado se veía idéntico a la comisión).
      pay_type: "porcentaje",
      salary_fixed: null,
      commission_percent: 10,
      is_active: true,
    };
  }

  /**
   * Un período ANTERIOR cerrado y el período en borrador, una factura Pagada
   * del 10% para la comisión, el vale del rango y las deudas sembradas.
   */
  function seed(
    args: {
      /** Subtotal de la factura pagada: la comisión del empleado es el 10%. */
      invoiceSubtotal?: number;
      /** Vale del período (pendiente en el rango). */
      voucherAmount?: number;
      /** Deudas ya existentes en `payroll_discount_carries`. */
      carries?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const invoiceSubtotal = args.invoiceSubtotal ?? 400_000;
    const vouchers =
      (args.voucherAmount ?? 0) > 0
        ? [
            {
              id: "vale-1",
              sede_id: payrollPagedStub.SEDE_ID,
              employee_id: EMPLOYEE_ID,
              amount: args.voucherAmount,
              request_date: "2026-02-15",
              status: "pendiente",
              approved_by: null,
              approval_code: null,
              observation: null,
            },
          ]
        : [];
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: EARLIER_PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "cerrado",
          created_by: "u-admin-1",
          closed_at: "2026-02-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-02-01",
          end_date: "2026-02-28",
          status: "borrador",
          created_by: "u-admin-1",
          closed_at: null,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ],
      employees: [employeeRow()],
      invoices: [
        {
          id: "factura-1",
          consecutive_number: 1,
          sede_id: payrollPagedStub.SEDE_ID,
          status: "Pagada",
          created_at: "2026-02-15T12:00:00.000Z",
        },
      ],
      invoice_items: [
        {
          id: "linea-1",
          invoice_id: "factura-1",
          item_type: "servicio",
          employee_id: EMPLOYEE_ID,
          qty: 1,
          unit_price: invoiceSubtotal,
          subtotal: invoiceSubtotal,
          no_commission: false,
          commission_value: null,
          commission_percent_override: null,
          product_id: null,
          service_id: SERVICE_ID,
        },
      ],
      commission_rules: [],
      voucher_requests: vouchers,
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      payroll_discount_carries: args.carries ?? [],
      audit_logs: [],
    };
  }

  /** La fila de nómina que quedó persistida (lo que la base recibió). */
  const persistedItem = () => payrollPagedStub.tables.payroll_items[0];
  const carryRows = () => payrollPagedStub.tables.payroll_discount_carries ?? [];

  /** La identidad del CHECK de `payroll_items` (tolerancia de un centavo). */
  function expectIdentity(item: Record<string, unknown>) {
    const identity =
      Number(item.base_fixed) +
      Number(item.commissions) +
      Number(item.bonuses) -
      Number(item.deductions_vales) -
      Number(item.other_discounts);
    expect(Math.abs(Number(item.net_pay) - identity)).toBeLessThan(0.01);
    expect(Number(item.net_pay)).toBeGreaterThanOrEqual(0);
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("el total real es la SUMA de los vales aunque el tope recorte el descuento aplicado", async () => {
    // Bruto = comisiones = 1.000 (porcentaje, sin bonos) y vale de 50.000: el
    // caso del dueño, donde la celda de vales valía exactamente la comisión.
    seed({ invoiceSubtotal: 10_000, voucherAmount: 50_000 });

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      {},
      ACTOR,
    );

    const item = detail.items[0];
    expect(item.commissions).toBe(1_000);
    // El descuento APLICADO sigue topeado (la identidad y el signo no cambian).
    expect(item.deductions_vales).toBe(1_000);
    // El total REAL es lo que el empleado gastó en vales.
    expect(item.voucher_total).toBe(50_000);
    expect(item.net_pay).toBe(0);
    expectIdentity(item as unknown as Record<string, unknown>);

    // El sobrante quedó como deuda PENDIENTE de este período.
    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      amount: 49_000,
      origin_period_id: PERIOD_ID,
      applied_period_id: null,
    });
    // Y la pantalla lo puede leer aparte del neto.
    expect(item.pending_debt).toBe(49_000);
  });

  it("voucher_excess es el remanente que el tope no aplicó y es 0 cuando no hubo recorte", async () => {
    seed({ invoiceSubtotal: 10_000, voucherAmount: 50_000 });
    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    expect(persistedItem().voucher_excess).toBe(49_000);

    // Control negativo: el vale entra completo en el bruto y no genera deuda.
    resetPayrollStubState();
    seed({ invoiceSubtotal: 10_000, voucherAmount: 500 });
    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    expect(persistedItem().voucher_excess).toBe(0);
    expect(persistedItem().voucher_total).toBe(500);
    expect(persistedItem().deductions_vales).toBe(500);
    expect(carryRows()).toHaveLength(0);
  });

  it("una deuda pendiente de un período anterior se aplica una vez, cae en other_discounts y queda marcada", async () => {
    seed({
      invoiceSubtotal: 400_000, // comisión 40.000: alcanza para la deuda
      voucherAmount: 0,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 30_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      {},
      ACTOR,
    );

    const item = detail.items[0];
    // Para el empleado es "otros descuentos": la identidad no se toca.
    expect(item.commissions).toBe(40_000);
    expect(item.other_discounts).toBe(30_000);
    expect(item.net_pay).toBe(10_000);
    expect(item.deductions_vales).toBe(0);
    expectIdentity(item as unknown as Record<string, unknown>);

    // La deuda quedó consumida por ESTE período y viajó en la transacción.
    expect(carryRows()[0].applied_period_id).toBe(PERIOD_ID);
    const args = payrollPagedStub.rpcCalls[0].args;
    expect(args.p_carry_ids).toEqual([CARRY_ID]);
    // Ya no está pendiente: no hay deuda nueva que mostrar.
    expect(item.pending_debt).toBe(0);
  });

  it("una deuda totalmente absorbida no deja remanente pendiente", async () => {
    // Comisión 40.000 y deuda de 30.000: el bruto alcanza y el tope la aplica
    // completa, así que no hay sobrante que re-registrar.
    seed({
      invoiceSubtotal: 400_000,
      voucherAmount: 0,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 30_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);

    expect(persistedItem().other_discounts).toBe(30_000);
    expect(persistedItem().debt_remainder).toBe(0);
    // Una sola fila: la deuda consumida, sin remanente nuevo.
    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0].applied_period_id).toBe(PERIOD_ID);
    expect(carryRows().some((row) => row.origin_kind === "carry_remainder")).toBe(false);
  });

  it("la deuda se consume SOLO por lo que el tope aplicó y el resto queda PENDIENTE", async () => {
    // Bruto = comisiones = 10.000 (porcentaje, sin bonos), vale de 2.000 y deuda
    // entrante de 30.000: el tope deja 8.000 para la deuda y los 22.000 que no
    // entraron NO se perdonan, se re-registran como deuda pendiente.
    seed({
      invoiceSubtotal: 100_000,
      voucherAmount: 2_000,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 30_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    const detail = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    const item = detail.items[0];

    // El descuento aplicado: el vale completo y 8.000 de la deuda (lo que el
    // tope alcanzó). El neto no es negativo y la igualdad se sostiene.
    expect(item.deductions_vales).toBe(2_000);
    expect(item.other_discounts).toBe(8_000);
    expect(item.net_pay).toBe(0);
    expect(Number(item.net_pay)).toBeGreaterThanOrEqual(0);
    expectIdentity(item as unknown as Record<string, unknown>);

    // La deuda consumida queda marcada y el sobrante queda PENDIENTE con este
    // período como origen: lo aplicará un período POSTERIOR, no éste.
    expect(carryRows()).toHaveLength(2);
    expect(carryRows()[0]).toMatchObject({
      id: CARRY_ID,
      applied_period_id: PERIOD_ID,
    });
    expect(carryRows()[1]).toMatchObject({
      amount: 22_000,
      origin_period_id: PERIOD_ID,
      applied_period_id: null,
      origin_kind: "carry_remainder",
    });
    expect(payrollPagedStub.rpcCalls[0].args.p_carry_ids).toEqual([CARRY_ID]);
    // La columna de deuda pendiente muestra el remanente.
    expect(item.pending_debt).toBe(22_000);
  });

  it("recalcular no duplica el remanente de una deuda parcialmente absorbida", async () => {
    seed({
      invoiceSubtotal: 100_000,
      voucherAmount: 2_000,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 30_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    const first = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    expect(first.items[0].other_discounts).toBe(8_000);

    const second = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    // El recálculo sigue descontando lo mismo (la deuda consumida se relee
    // porque quedó marcada con ESTE período) y NO vuelve a aplicar el remanente:
    // su origen es este mismo período, así que no es anterior a sí mismo.
    expect(second.items[0].other_discounts).toBe(8_000);
    expect(second.items[0].net_pay).toBe(0);
    expectIdentity(second.items[0] as unknown as Record<string, unknown>);

    // Sigue habiendo DOS filas y UNA sola de remanente: el recálculo no duplica.
    expect(carryRows()).toHaveLength(2);
    const remainders = carryRows().filter((row) => row.origin_kind === "carry_remainder");
    expect(remainders).toHaveLength(1);
    expect(remainders[0]).toMatchObject({ amount: 22_000, applied_period_id: null });
    expect(carryRows()[0].applied_period_id).toBe(PERIOD_ID);
    expect(payrollPagedStub.rpcCalls[1].args.p_carry_ids).toEqual([]);
  });

  it("el caso del dueño: porcentaje sin bonos, bruto = comisión, con vale y deuda entrante", async () => {
    // Comisión = bruto = 2.000; vale de 1.000 y deuda entrante de 5.000. El tope
    // aplica el vale completo y 1.000 de la deuda; el neto queda en 0 y los
    // 4.000 restantes siguen siendo deuda, no un perdón silencioso.
    seed({
      invoiceSubtotal: 20_000,
      voucherAmount: 1_000,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 5_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    const detail = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    const item = detail.items[0];

    expect(item.commissions).toBe(2_000);
    expect(item.bonuses).toBe(0);
    expect(item.voucher_total).toBe(1_000);
    expect(item.deductions_vales).toBe(1_000);
    expect(item.other_discounts).toBe(1_000);
    expect(item.net_pay).toBe(0);
    expectIdentity(item as unknown as Record<string, unknown>);
    // La deuda pendiente de ESTE período es el remanente (4.000), visible
    // aparte del neto.
    expect(item.pending_debt).toBe(4_000);

    expect(carryRows()).toHaveLength(2);
    expect(carryRows()[0].applied_period_id).toBe(PERIOD_ID);
    expect(carryRows()[1]).toMatchObject({
      amount: 4_000,
      origin_period_id: PERIOD_ID,
      origin_kind: "carry_remainder",
      applied_period_id: null,
    });
  });

  it("una deuda generada por el período que se calcula NO se aplica a sí misma", async () => {
    // El período ya trae su propio sobrante pendiente (de un cálculo previo).
    seed({
      invoiceSubtotal: 10_000,
      voucherAmount: 50_000,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 49_000,
          origin_period_id: PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-02-28T23:59:59.000Z",
        },
      ],
    });

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      {},
      ACTOR,
    );

    // Su propia deuda NO entra al descuento del período.
    expect(detail.items[0].other_discounts).toBe(0);
    expect(detail.items[0].deductions_vales).toBe(1_000);
    expect(detail.items[0].voucher_total).toBe(50_000);
    expectIdentity(detail.items[0] as unknown as Record<string, unknown>);
    // Sigue PENDIENTE y no se duplicó (la guarda NOT EXISTS de 061).
    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0].applied_period_id).toBeNull();
  });

  it("recalcular no duplica la deuda del sobrante (guarda NOT EXISTS)", async () => {
    seed({ invoiceSubtotal: 10_000, voucherAmount: 50_000 });
    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);

    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0]).toMatchObject({
      amount: 49_000,
      origin_period_id: PERIOD_ID,
      applied_period_id: null,
    });
  });

  it("recalcular no vuelve a aplicar una deuda consumida y conserva el descuento", async () => {
    seed({
      invoiceSubtotal: 400_000,
      voucherAmount: 0,
      carries: [
        {
          id: CARRY_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 30_000,
          origin_period_id: EARLIER_PERIOD_ID,
          applied_period_id: null,
          created_at: "2026-01-31T23:59:59.000Z",
        },
      ],
    });

    const first = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    expect(first.items[0].other_discounts).toBe(30_000);
    expect(first.items[0].net_pay).toBe(10_000);

    const second = await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);
    // El recálculo sigue descontando la deuda que ESTE período consumió: el
    // neto no cambia y la deuda no se pierde.
    expect(second.items[0].other_discounts).toBe(30_000);
    expect(second.items[0].net_pay).toBe(10_000);
    expectIdentity(second.items[0] as unknown as Record<string, unknown>);
    // No se vuelve a marcar y no se duplica.
    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0].applied_period_id).toBe(PERIOD_ID);
    expect(payrollPagedStub.rpcCalls[1].args.p_carry_ids).toEqual([]);
  });

  it("la deuda pendiente se lee aparte y no cruza empleados", async () => {
    seed({ invoiceSubtotal: 10_000, voucherAmount: 50_000 });
    await calculatePayroll(payrollPagedStub.SEDE_ID, PERIOD_ID, {}, ACTOR);

    // Deuda ajena con el MISMO período de origen: la de OTRO empleado no
    // puede aparecer en la fila de ÉSTE.
    payrollPagedStub.tables.payroll_discount_carries = [
      ...carryRows(),
      {
        id: "deuda-otro-empleado",
        sede_id: payrollPagedStub.SEDE_ID,
        employee_id: "99999999-9999-4999-8999-999999999999",
        amount: 999,
        origin_period_id: PERIOD_ID,
        applied_period_id: null,
      },
    ];

    const detail = await getPeriodDetail(payrollPagedStub.SEDE_ID, PERIOD_ID);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].pending_debt).toBe(49_000);
  });
});

// --------------------------------------------------------------------- CL-9 ---
//
// El barrido de atomicidad encontró DOS ventanas más en nómina, de la MISMA
// clase que CL-7 y CL-8: dos escrituras seguidas que tienen que ser una sola.
//
//   * `deletePayrollPeriod` (service.ts): revierte los vales a `aprobada` y a
//     `pendiente` y DESPUÉS borra el período. Un fallo entre las dos deja los
//     vales revertidos y el borrador EN PIE: los vales ya dicen una cosa
//     (`aprobada`/`pendiente`) que ningún borrador explica, y el borrador sigue
//     ahí con su liquidación.
//   * `correctPayrollPeriod` (service.ts): inserta la cabecera de la corrección
//     y DESPUÉS sus filas por empleado. Un fallo entre las dos deja la
//     corrección FIRMADA sin sus filas; y como hay UNA corrección por período
//     (índice único de 037), el reintento se rechaza con ALREADY_CORRECTED: un
//     callejón sin salida. Es la familia "firmado sin su prueba", la peor
//     estructuralmente.
//
// Los dos pares pasan a ser UNA función SQL por par (048), igual que 046 y 047:
// el servicio COMPUTA (`restoreVoucherStatus`, `computePayrollLines`, la vista
// de la corrección) y la función SÓLO ESCRIBE lo que recibe.

describe("payroll: el borrado de un borrador revierte los vales y lo borra en UNA transacción (CL-9)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const VOUCHER_APPROVED = "d1111111-1111-4111-8111-111111111111";
  const VOUCHER_PENDING = "d2222222-2222-4222-8222-222222222222";
  const ITEM_ID = "item-nomina-borrador";
  const PAYMENT_ID = "pago-borrador";

  /**
   * El escenario: un borrador de enero con su ítem liquidado y su pago, y dos
   * vales que el cálculo marcó `descontada` en el rango. Uno tenía aprobador
   * (vuelve a `aprobada`) y el otro no (vuelve a `pendiente`).
   */
  function seedDraft(overrides: { overlapping?: Array<Record<string, unknown>> } = {}) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: "u-admin-1",
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        ...(overrides.overlapping ?? []),
      ],
      payroll_items: [
        {
          id: ITEM_ID,
          period_id: PERIOD_ID,
          employee_id: EMPLOYEE_ID,
          base_fixed: 200_000,
          commissions: 0,
          bonuses: 0,
          deductions_vales: 200_000,
          other_discounts: 0,
          net_pay: 0,
          detail_json: [],
          created_at: "2026-01-31T00:00:00.000Z",
        },
      ],
      payroll_payments: [
        {
          id: PAYMENT_ID,
          payroll_item_id: ITEM_ID,
          method_id: null,
          method_code: "efectivo",
          amount: 1000,
          paid_at: "2026-01-31T23:00:00.000Z",
          paid_by: "u-admin-1",
          reference: null,
        },
      ],
      voucher_requests: [
        {
          id: VOUCHER_APPROVED,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 100_000,
          request_date: "2026-01-10",
          status: "descontada",
          approved_by: "u-admin-1",
          created_by: null,
          method_code: null,
          cash_shift_id: null,
          approval_code: null,
          observation: null,
        },
        {
          id: VOUCHER_PENDING,
          sede_id: payrollPagedStub.SEDE_ID,
          employee_id: EMPLOYEE_ID,
          amount: 100_000,
          request_date: "2026-01-20",
          status: "descontada",
          approved_by: null,
          created_by: null,
          method_code: null,
          cash_shift_id: null,
          approval_code: null,
          observation: null,
        },
      ],
      employees: [],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      commission_payouts: [],
      audit_logs: [],
    };
  }

  const voucherRow = (id: string) =>
    (payrollPagedStub.tables.voucher_requests ?? []).find((row) => row.id === id);
  const voucherStatus = (id: string) => voucherRow(id)?.status;
  const periodStillThere = () =>
    (payrollPagedStub.tables.payroll_periods ?? []).some((row) => row.id === PERIOD_ID);
  const deleteCalls = () =>
    payrollPagedStub.rpcCalls.filter((call) => call.name === "payroll_delete_period_atomic");
  const looseVoucherUpdates = () =>
    payrollPagedStub.updates.filter((entry) => entry.table === "voucher_requests");
  const carryRows = () => payrollPagedStub.tables.payroll_discount_carries ?? [];

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // --------------------------------------------------------------- RED ---

  it("un fallo en la transacción no deja NADA a medias (RED medido: hoy deja los vales revertidos y el borrador en pie)", async () => {
    seedDraft();
    // El fallo semántico "no se pudo borrar el período": en el camino viejo
    // falla el `.delete()` suelto, DESPUÉS de que los dos `UPDATE` de reversión
    // ya quedaron confirmados (son otros requests).
    payrollPagedStub.failDeletePeriod = "PAYROLL_DELETE_FAILED";

    const outcome: unknown = await payrollExtrasService
      .deletePayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, ACTOR)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    // HOY: los vales quedaron revertidos y el borrador sigue en pie: lo que los
    // vales dicen ya no lo explica ninguna nómina.
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("descontada");
    expect(voucherStatus(VOUCHER_PENDING)).toBe("descontada");
    expect(periodStillThere()).toBe(true);
    // Nada escrito: la transacción se intentó y se revirtió ENTERA.
    expect(payrollPagedStub.deletes).toEqual([]);
    expect(deleteCalls()).toHaveLength(1);
  });

  // ------------------------------------------------------------- GREEN ---

  it("GREEN: un borrado exitoso revierte cada vale a SU estado previo y borra el período con sus hijos", async () => {
    seedDraft();

    const result = await payrollExtrasService.deletePayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      ACTOR,
    );

    // El shape del resultado no cambia.
    expect(result).toEqual({ id: PERIOD_ID });
    // UNA sola escritura para las dos cosas: la reversión y el borrado viajan
    // juntos.
    expect(deleteCalls()).toHaveLength(1);
    // La reversión ya NO es un `UPDATE` suelto del cliente.
    expect(looseVoucherUpdates()).toEqual([]);
    // La reversión es INDIVIDUAL: aprobado → aprobada, sin aprobador →
    // pendiente (`restoreVoucherStatus`, la misma regla de siempre).
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("aprobada");
    expect(voucherStatus(VOUCHER_PENDING)).toBe("pendiente");
    expect(deleteCalls()[0].args.p_to_approved).toEqual([VOUCHER_APPROVED]);
    expect(deleteCalls()[0].args.p_to_pending).toEqual([VOUCHER_PENDING]);
    // El período y sus hijos caen juntos (FK ON DELETE CASCADE de 007).
    expect(periodStillThere()).toBe(false);
    expect(payrollPagedStub.tables.payroll_items).toEqual([]);
    expect(payrollPagedStub.tables.payroll_payments).toEqual([]);
    expect(payrollPagedStub.deletes).toEqual([{ table: "payroll_periods", count: 1 }]);
    // La auditoría sigue contando lo revertido.
    const audit = payrollPagedStub.inserts.find((entry) => entry.table === "audit_logs");
    expect(audit?.payload).toMatchObject({
      action: AUDIT_ACTIONS.PAYROLL_DELETED,
      entity_id: PERIOD_ID,
      metadata: { vales_revertidos: 2 },
    });
    expect(audit?.payload).not.toHaveProperty("sede_id");
  });

  it("la precondición de estado no se salta: si el período dejó de ser BORRADOR, se rechaza y no se revierte nada", async () => {
    seedDraft();
    // La carrera real: otro admin CIERRA el borrador entre la lectura del
    // servicio y la transacción. El `UPDATE`/`DELETE` sueltos no miraban cuántas
    // filas tocaban; la precondición dentro de la transacción sí.
    payrollPagedStub.beforeRpc = {
      run: () => {
        (payrollPagedStub.tables.payroll_periods ?? [])[0].status = "cerrado";
      },
    };

    const outcome: unknown = await payrollExtrasService
      .deletePayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, ACTOR)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "PERIOD_DELETE_CONFLICT", status: 409 });
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("descontada");
    expect(voucherStatus(VOUCHER_PENDING)).toBe("descontada");
    expect(periodStillThere()).toBe(true);
    expect(payrollPagedStub.deletes).toEqual([]);
  });

  it("la CARRERA de los vales se RECHAZA en vez de borrar el período con vales que ya no son suyos", async () => {
    seedDraft();
    // Otro borrado (el de un borrador que solapa el rango) revirtió el vale
    // aprobado entre la lectura del servicio y la transacción.
    payrollPagedStub.beforeRpc = {
      run: () => {
        const row = voucherRow(VOUCHER_APPROVED);
        if (row) row.status = "aprobada";
      },
    };

    const outcome: unknown = await payrollExtrasService
      .deletePayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, ACTOR)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "PERIOD_DELETE_CONFLICT", status: 409 });
    // NADA se aplicó: el vale que SÍ era nuestro sigue `descontada` (no se
    // revirtió a medias) y el borrador sigue en pie.
    expect(voucherStatus(VOUCHER_PENDING)).toBe("descontada");
    expect(periodStillThere()).toBe(true);
    // El estado que dejó el otro camino no se pisa.
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("aprobada");
  });

  it("la CARRERA del solapamiento se RECHAZA: cerrar un período que solapa durante el borrado no pasa", async () => {
    seedDraft({
      overlapping: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-15",
          end_date: "2026-02-15",
          status: "borrador",
          created_by: "u-admin-1",
          closed_at: null,
          created_at: "2026-01-15T00:00:00.000Z",
        },
      ],
    });
    // El solapado era un BORRADOR cuando el servicio leyó (no bloquea: no hay
    // plata pagada) y se CIERRA antes de la transacción. Revertir esos vales
    // destruiría nómina ya pagada: la misma regla, re-evaluada adentro.
    payrollPagedStub.beforeRpc = {
      run: () => {
        (payrollPagedStub.tables.payroll_periods ?? [])[1].status = "cerrado";
      },
    };

    const outcome: unknown = await payrollExtrasService
      .deletePayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, ACTOR)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "PERIOD_OVERLAP_AMBIGUOUS", status: 409 });
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("descontada");
    expect(voucherStatus(VOUCHER_PENDING)).toBe("descontada");
    expect(periodStillThere()).toBe(true);
  });

  it("precondición rechazada: un período ya CERRADO no se borra y no se toca ninguna tabla", async () => {
    seedDraft();
    (payrollPagedStub.tables.payroll_periods ?? [])[0].status = "cerrado";

    const outcome: unknown = await payrollExtrasService
      .deletePayrollPeriod(payrollPagedStub.SEDE_ID, PERIOD_ID, ACTOR)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "PERIOD_NOT_DRAFT", status: 409 });
    // Ni siquiera se abrió una transacción: la precondición frena antes.
    expect(deleteCalls()).toEqual([]);
    expect(payrollPagedStub.deletes).toEqual([]);
    expect(voucherStatus(VOUCHER_APPROVED)).toBe("descontada");
  });

  it("control negativo: sin vales que revertir el borrado borra el período igual (no es un no-op)", async () => {
    seedDraft();
    payrollPagedStub.tables.voucher_requests = [];

    const result = await payrollExtrasService.deletePayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      ACTOR,
    );

    // La transacción corre igual (hay un borrado que hacer) y con los dos
    // arreglos VACÍOS: la red de conteo de la reversión no puede confundir
    // "cero vales pedidos" con "cero vales revertidos de los que pedí".
    expect(result).toEqual({ id: PERIOD_ID });
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0].args.p_to_approved).toEqual([]);
    expect(deleteCalls()[0].args.p_to_pending).toEqual([]);
    expect(periodStillThere()).toBe(false);
  });

  // ------------------------------------------ deuda y borrado (066) ---

  it("PAY-01 (066): borrar un borrador que PRODUJO una deuda la borra CON él (CASCADE)", async () => {
    seedDraft();
    // El sobrante de un vale mayor que el bruto del período (061): una deuda
    // PENDIENTE cuyo origen es ESTE borrador. Antes de la 066 esta fila
    // bloqueaba el `DELETE` del período con un 23503 y el borrado moría con
    // `INTERNAL: Error interno.`.
    payrollPagedStub.tables.payroll_discount_carries = [
      {
        id: "deuda-producida",
        sede_id: payrollPagedStub.SEDE_ID,
        employee_id: EMPLOYEE_ID,
        amount: 30_000,
        origin_period_id: PERIOD_ID,
        applied_period_id: null,
        origin_kind: "voucher_excess",
      },
    ];

    const result = await payrollExtrasService.deletePayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      ACTOR,
    );

    // El borrado se completa y la deuda que el borrador generó se va con él:
    // la misma transacción revirtió los vales que la causaron, así que ya no
    // tiene causa. Conservarla sería una deuda sin vale que la explique.
    expect(result).toEqual({ id: PERIOD_ID });
    expect(periodStillThere()).toBe(false);
    expect(carryRows()).toEqual([]);
  });

  it("PAY-01 (066): borrar un borrador que CONSUMIÓ una deuda la devuelve a PENDIENTE (SET NULL)", async () => {
    seedDraft();
    // Una deuda de un período ANTERIOR que ESTE borrador absorbió dentro de
    // `other_discounts` (062): `applied_period_id` apunta a este borrador. Al
    // borrarlo, borrar sus ítems deshace la absorción y la deuda debe volver a
    // estar pendiente, porque su período de ORIGEN sigue existiendo.
    payrollPagedStub.tables.payroll_discount_carries = [
      {
        id: "deuda-consumida",
        sede_id: payrollPagedStub.SEDE_ID,
        employee_id: EMPLOYEE_ID,
        amount: 15_000,
        origin_period_id: "11111111-1111-4111-8111-111111111111",
        applied_period_id: PERIOD_ID,
        origin_kind: "voucher_excess",
      },
    ];

    await payrollExtrasService.deletePayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      ACTOR,
    );

    // La fila NO se pierde: se posterga. El origen queda intacto (es la
    // trazabilidad) y el borrador consumidor desaparece de `applied_period_id`.
    expect(carryRows()).toHaveLength(1);
    expect(carryRows()[0]).toMatchObject({
      id: "deuda-consumida",
      amount: 15_000,
      origin_period_id: "11111111-1111-4111-8111-111111111111",
      applied_period_id: null,
    });
  });

  it("PAY-01 (066): borrar un borrador sin deuda no toca la deuda de otros períodos", async () => {
    seedDraft();
    // Una deuda ajena: ni su origen ni su aplicación son este borrador. El
    // CASCADE y el SET NULL están acotados a las filas que referencian el
    // período borrado; las demás quedan EXACTAMENTE igual.
    const ajena = {
      id: "deuda-de-otro-periodo",
      sede_id: payrollPagedStub.SEDE_ID,
      employee_id: EMPLOYEE_ID,
      amount: 7_000,
      origin_period_id: "11111111-1111-4111-8111-111111111111",
      applied_period_id: "33333333-3333-4333-8333-333333333333",
      origin_kind: "carry_remainder",
    };
    payrollPagedStub.tables.payroll_discount_carries = [ajena];

    const result = await payrollExtrasService.deletePayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      ACTOR,
    );

    expect(result).toEqual({ id: PERIOD_ID });
    expect(periodStillThere()).toBe(false);
    // La fila ajena conserva su `applied_period_id`: no se confunde "el
    // período que borré" con "un período cualquiera".
    expect(carryRows()).toEqual([ajena]);
  });
});

describe("payroll: la corrección de un período cerrado escribe cabecera y filas en UNA transacción (CL-9)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const EMPLOYEE_ID = payrollPagedStub.EMPLOYEE_ID;
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const ITEM_ID = "item-nomina-corregible";
  const WEEK = { start: "2026-09-01", end: "2026-09-07" };
  /** Sueldo MENSUAL: 7 de 30 días son 326.667 (la versión CORRECTA). */
  const SALARY = 1_400_000;
  const PRORATED = 326_667;
  const REASON = "El fijo se pagó completo y correspondía la parte de los días.";

  /** El período semanal cerrado que liquidó el sueldo mensual completo. */
  function seedClosed() {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: WEEK.start,
          end_date: WEEK.end,
          status: "cerrado",
          created_by: "u-admin-1",
          closed_at: "2026-09-07T23:00:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      employees: [
        {
          id: EMPLOYEE_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          user_id: null,
          full_name: "Empleada fija",
          employee_code: "E-001",
          document: "1000000001",
          phone: null,
          position: null,
          payout_mode: "normal",
          email: null,
          birth_date: null,
          pay_type: "fijo",
          salary_fixed: SALARY,
          commission_percent: null,
          is_active: true,
        },
      ],
      payroll_items: [
        {
          id: ITEM_ID,
          period_id: PERIOD_ID,
          employee_id: EMPLOYEE_ID,
          base_fixed: SALARY,
          commissions: 0,
          bonuses: 0,
          deductions_vales: 0,
          other_discounts: 0,
          net_pay: SALARY,
          detail_json: [],
          created_at: "2026-09-07T23:00:00.000Z",
        },
      ],
      payroll_payments: [
        {
          id: "pago-corregible",
          payroll_item_id: ITEM_ID,
          method_id: null,
          method_code: "efectivo",
          amount: SALARY,
          paid_at: "2026-09-07T23:30:00.000Z",
          paid_by: "u-admin-1",
          reference: null,
        },
      ],
      payroll_period_corrections: [],
      payroll_period_correction_items: [],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      audit_logs: [],
    };
  }

  const correctionRows = () => payrollPagedStub.tables.payroll_period_corrections ?? [];
  const correctionItemRows = () => payrollPagedStub.tables.payroll_period_correction_items ?? [];
  const correctCalls = () =>
    payrollPagedStub.rpcCalls.filter((call) => call.name === "payroll_correct_period_atomic");
  const correct = (reason = REASON) =>
    payrollExtrasService.correctPayrollPeriod(
      payrollPagedStub.SEDE_ID,
      PERIOD_ID,
      { reason },
      ACTOR,
    );

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // --------------------------------------------------------------- RED ---

  it("un fallo al escribir las filas no deja NADA escrito (RED medido: hoy deja la cabecera FIRMADA sin sus filas)", async () => {
    seedClosed();
    // El fallo semántico "no se pudieron escribir las filas de la corrección":
    // en el camino viejo falla el INSERT suelto de las filas, DESPUÉS de que la
    // cabecera ya quedó confirmada (son otros requests).
    payrollPagedStub.failCorrectionLines = "PAYROLL_CORRECTION_MISMATCH";

    const outcome: unknown = await correct().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "INTERNAL", status: 500 });
    // HOY: la cabecera quedó firmada y las filas no existen; el reintento se
    // rechaza con ALREADY_CORRECTED, así que la corrección nunca se completa.
    expect(correctionRows()).toEqual([]);
    expect(correctionItemRows()).toEqual([]);
    // No es vacuidad: la transacción SÍ se intentó.
    expect(correctCalls()).toHaveLength(1);
  });

  it("el callejón sin salida se cierra: tras un fallo, el reintento completa la corrección (RED medido: hoy se rechaza)", async () => {
    seedClosed();
    payrollPagedStub.failCorrectionLines = "PAYROLL_CORRECTION_MISMATCH";
    // La corrida que falla a mitad de camino.
    await correct().catch(() => undefined);
    // El reintento legítimo, sin fallo inyectado.
    payrollPagedStub.failCorrectionLines = null;

    const retry: unknown = await correct().catch((error: unknown) => error);

    // HOY: el reintento choca con el índice único y responde ALREADY_CORRECTED:
    // la corrección queda firmada sin filas para siempre.
    expect(retry).not.toBeInstanceOf(PayrollError);
    expect(correctionRows()).toHaveLength(1);
    expect(correctionItemRows()).toHaveLength(1);
  });

  // ------------------------------------------------------------- GREEN ---

  it("GREEN: escribe la cabecera y sus filas juntas, con los montos EXACTOS que calculó el servicio", async () => {
    seedClosed();

    const result = await correct();

    expect(correctCalls()).toHaveLength(1);
    // El shape del resultado no cambia: el período, la corrección y la vista.
    expect(result.correction).toMatchObject({
      period_id: PERIOD_ID,
      previous_net_total: SALARY,
      previous_paid_total: SALARY,
      corrected_net_total: PRORATED,
      previous_item_count: 1,
      corrected_item_count: 1,
      reason: REASON,
      corrected_by: ACTOR.userId,
    });
    expect(result.view.differenceTotal).toBe(SALARY - PRORATED);
    // DATA-IN/DATA-OUT: los montos que viajan en la escritura son los que
    // resolvió la aritmética de TypeScript —la prorata de 7/30 días de
    // 1.400.000— y lo que quedó escrito es EXACTAMENTE ese payload.
    const args = correctCalls()[0].args;
    const header = args.p_correction as Record<string, unknown>;
    const lines = args.p_items as Array<Record<string, unknown>>;
    expect(header).toMatchObject({
      period_id: PERIOD_ID,
      previous_net_total: SALARY,
      previous_paid_total: SALARY,
      corrected_net_total: PRORATED,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      previous_net_pay: SALARY,
      previous_paid: SALARY,
      corrected_net_pay: PRORATED,
    });
    expect(
      payrollPagedStub.inserts.find((entry) => entry.table === "payroll_period_corrections")?.payload,
    ).toEqual(header);
    expect(
      payrollPagedStub.inserts.find(
        (entry) => entry.table === "payroll_period_correction_items",
      )?.payload,
    ).toEqual(lines);
    // Y quedó escrito: una cabecera y una fila, con los mismos números.
    expect(correctionRows()).toHaveLength(1);
    expect(correctionItemRows()).toHaveLength(1);
    expect(correctionItemRows()[0]).toMatchObject({
      employee_id: EMPLOYEE_ID,
      previous_net_pay: SALARY,
      corrected_net_pay: PRORATED,
    });
    // La versión firmada del período no se toca: la corrección sólo escribe.
    expect(payrollPagedStub.updates).toEqual([]);
    expect(payrollPagedStub.tables.payroll_items[0].net_pay).toBe(SALARY);
  });

  it("precondición rechazada: un período ya corregido se rechaza y no escribe una segunda corrección", async () => {
    seedClosed();
    await correct();

    const outcome: unknown = await correct("Segunda corrección.").catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "ALREADY_CORRECTED", status: 409 });
    // UNA cabecera y UN juego de filas: la corrección también queda firmada.
    expect(correctionRows()).toHaveLength(1);
    expect(correctionItemRows()).toHaveLength(1);
    // La segunda ni siquiera abrió una transacción.
    expect(correctCalls()).toHaveLength(1);
  });

  it("la CARRERA de la corrección se RECHAZA (ALREADY_CORRECTED) y no escribe nada de la perdedora", async () => {
    seedClosed();
    // Otra corrección del MISMO período se confirma entre el chequeo del
    // servicio y la transacción: el índice único de 037 la protege dentro.
    payrollPagedStub.beforeRpc = {
      run: () => {
        payrollPagedStub.tables.payroll_period_corrections = [
          {
            id: "correccion-ajena",
            period_id: PERIOD_ID,
            reason: "Otra corrección.",
            corrected_by: "u-otro-admin",
            corrected_at: "2026-09-08T10:00:00.000Z",
          },
        ];
      },
    };

    const outcome: unknown = await correct().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "ALREADY_CORRECTED", status: 409 });
    // La ajena queda intacta y de la nuestra no queda NADA.
    expect(correctionRows()).toHaveLength(1);
    expect(correctionRows()[0].id).toBe("correccion-ajena");
    expect(correctionItemRows()).toEqual([]);
  });

  it("la precondición del cierre no se salta: si el período dejó de estar CERRADO, se rechaza sin escribir", async () => {
    seedClosed();
    payrollPagedStub.beforeRpc = {
      run: () => {
        (payrollPagedStub.tables.payroll_periods ?? [])[0].status = "borrador";
      },
    };

    const outcome: unknown = await correct().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "PERIOD_NOT_CLOSED", status: 409 });
    expect(correctionRows()).toEqual([]);
    expect(correctionItemRows()).toEqual([]);
  });

  it("control negativo: una corrección exitosa SÍ escribe y no mueve plata", async () => {
    // Si los "nada escrito" de arriba fueran vacuidad, este control lo dice.
    seedClosed();

    await correct();

    expect(correctionRows()).toHaveLength(1);
    expect(correctionItemRows()).toHaveLength(1);
    expect(
      payrollPagedStub.inserts.filter(
        (entry) =>
          entry.table === "payroll_payments" || entry.table === "payroll_extras",
      ),
    ).toEqual([]);
    expect(payrollPagedStub.tables.voucher_requests).toEqual([]);
  });
});

describe("migración 048_payroll_admin_atomic.sql (CL-9)", () => {
  // La lectura es por test: el RED del SERVICIO corre con el archivo todavía
  // ausente, y una lectura en el cuerpo del `describe` rompería la colección de
  // todo el archivo en vez de fallar sólo estos tests.
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "048_payroll_admin_atomic.sql"),
      "utf8",
    );
    // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("los DOS pares viven cada uno en UNA función: una sentencia, una transacción", () => {
    const { sql } = migration();
    // Par 1: la reversión de los vales y el borrado del período.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.payroll_delete_period_atomic");
    expect(sql).toMatch(/UPDATE public\.voucher_requests/);
    expect(sql).toMatch(/status\s*=\s*'descontada'/);
    expect(sql).toMatch(/DELETE FROM public\.payroll_periods/);
    // Par 2: la cabecera de la corrección y sus filas.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.payroll_correct_period_atomic");
    expect(sql).toMatch(/INSERT INTO public\.payroll_period_corrections/);
    expect(sql).toMatch(/INSERT INTO public\.payroll_period_correction_items/);
    expect(sql).toContain("jsonb_array_elements(p_items)");
    // Orden determinista de los locks (misma disciplina que 046 y 047): sin él,
    // dos operaciones concurrentes sobre los mismos vales pueden bloquearse en
    // ciclo.
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it("conserva las precondiciones de estado que el servicio ya tenía", () => {
    const { sql } = migration();
    // El borrado exige el borrador, igual que `assertDeletablePeriod`.
    expect(sql).toMatch(/status\s*=\s*'borrador'/);
    // La corrección exige el período cerrado, igual que `assertCorrectablePeriod`.
    expect(sql).toMatch(/status\s*<>\s*'cerrado'/);
    expect(sql).toContain("PERIOD_NOT_CLOSED");
    // Y el guardia de solapamiento contra un período CERRADO, con su código.
    expect(sql).toContain("PERIOD_OVERLAP_AMBIGUOUS");
    expect(sql).toMatch(/o\.status\s*=\s*'cerrado'/);
  });

  it("tiene una red de conteo por grupo de escritura, con rollback", () => {
    const { sql } = migration();
    // Dos por función: la reversión y el borrado; la cabecera y las filas.
    const diagnostics = sql.match(/GET DIAGNOSTICS/g) ?? [];
    expect(diagnostics).toHaveLength(4);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("PAYROLL_VOUCHER_CONFLICT");
    expect(sql).toContain("PAYROLL_PERIOD_CONFLICT");
    expect(sql).toContain("PAYROLL_CORRECTION_MISMATCH");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL.
    expect(sql).toMatch(/coalesce\(/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    const { sql } = migration();
    // Las tablas ya validan sus montos con los CHECK de 007 y 037 (validar no
    // es calcular): esta migración no agrega una sola expresión aritmética
    // sobre las columnas de dinero. Escribir = convertir la representación
    // (jsonb → la columna), no operar.
    for (const column of [
      "previous_net_total",
      "previous_paid_total",
      "corrected_net_total",
      "previous_base_fixed",
      "previous_commissions",
      "previous_bonuses",
      "previous_deductions_vales",
      "previous_other_discounts",
      "previous_net_pay",
      "previous_paid",
      "corrected_base_fixed",
      "corrected_commissions",
      "corrected_bonuses",
      "corrected_deductions_vales",
      "corrected_other_discounts",
      "corrected_net_pay",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(sql).not.toContain("CHECK");
    expect(sql).not.toMatch(/sum\s*\(/i);
  });

  it("cierra el permiso: sólo service_role puede ejecutarlas", () => {
    const { sql } = migration();
    for (const signature of [
      "public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[])",
      "public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb)",
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

  it("no borra ni reescribe datos fuera de lo que la operación ya borraba", () => {
    const { sql } = migration();
    // El ÚNICO borrado es el del período, y con su precondición: la operación
    // ya lo hacía, y los vales NUNCA se borran (se revierten de estado).
    const deletes = sql.match(/DELETE FROM/g) ?? [];
    expect(deletes).toHaveLength(1);
    expect(sql).not.toMatch(/DELETE FROM public\.voucher_requests/);
    expect(sql).not.toMatch(/DELETE FROM public\.payroll_items/);
    expect(sql).not.toMatch(/UPDATE public\.payroll_items/);
    expect(sql).not.toMatch(/UPDATE public\.payroll_period_corrections/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("explica el motivo, el acoplamiento de despliegue y el costo de numeración", () => {
    const { raw } = migration();
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    // El número libre siguiente y el archivo hermano (047) que se espeja.
    expect(raw).toContain("048");
    expect(raw).toContain("047");
  });
});

describe("migración 066_payroll_carry_delete_fks.sql (PAY-01)", () => {
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "066_payroll_carry_delete_fks.sql"),
      "utf8",
    );
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("re-declara las DOS FK con su ON DELETE y con el nombre por defecto de Postgres", () => {
    const { sql } = migration();
    // Los nombres que Postgres asignó a las declaraciones en línea de 061; se
    // vuelven a usar en el ADD para que un re-run no acumule restricciones.
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS payroll_discount_carries_origin_period_id_fkey",
    );
    expect(sql).toContain(
      "DROP CONSTRAINT IF EXISTS payroll_discount_carries_applied_period_id_fkey",
    );
    expect(sql).toContain(
      "ADD CONSTRAINT payroll_discount_carries_origin_period_id_fkey",
    );
    expect(sql).toContain(
      "ADD CONSTRAINT payroll_discount_carries_applied_period_id_fkey",
    );
    // El origen cae con el borrador; la aplicación vuelve a PENDIENTE.
    expect(sql).toMatch(
      /FOREIGN KEY \(origin_period_id\) REFERENCES public\.payroll_periods \(id\)\s*ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(applied_period_id\) REFERENCES public\.payroll_periods \(id\)\s*ON DELETE SET NULL/,
    );
    // `origin_period_id` es NOT NULL: `SET NULL` no es una opción para él.
    expect(sql).not.toMatch(/FOREIGN KEY \(origin_period_id\)[^;]*ON DELETE SET NULL/);
  });

  it("sólo toca las dos FK: ni datos, ni otra tabla, ni otra columna", () => {
    const { sql } = migration();
    // Cuatro sentencias: dos DROP y dos ADD, todas sobre la misma tabla.
    expect(sql.match(/ALTER TABLE/g) ?? []).toHaveLength(4);
    expect(sql.match(/DROP CONSTRAINT IF EXISTS/g) ?? []).toHaveLength(2);
    expect(sql.match(/ADD CONSTRAINT/g) ?? []).toHaveLength(2);
    const tables = new Set(
      (sql.match(/ALTER TABLE public\.\w+/g) ?? []).map((entry) => entry.split(".")[1]),
    );
    expect([...tables]).toEqual(["payroll_discount_carries"]);
    // Ninguna migración de datos ni cambio de columna/índice/RLS.
    expect(sql).not.toMatch(/INSERT INTO/i);
    expect(sql).not.toMatch(/UPDATE public\./i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/CREATE INDEX/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });

  it("explica por qué el NO ACTION de 061 era incorrecto y el costo de numeración", () => {
    const { raw } = migration();
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    // El motivo: el borrador SÍ se borra y la deuda lo bloqueaba con un 23503.
    expect(raw).toContain("payroll_delete_period_atomic");
    expect(raw).toContain("23503");
    expect(raw).toContain("origin_period_id");
    expect(raw).toContain("applied_period_id");
    // El número libre siguiente y el archivo hermano que se espeja.
    expect(raw).toContain("066");
    expect(raw).toContain("065");
  });
});

// ---- CL-16: el tope del pago de nómina bloquea la fila del PADRE -------
//
// El hueco: `check_payroll_payments_cap` (007_payroll.sql) sumaba los pagos del
// ítem y rechazaba si el total pasaba el neto, pero NO bloqueaba la fila padre.
// Sus dos hermanos sí: `check_invoice_payments_cap` (031) bloquea la fila de
// `invoices` y `check_commission_payouts_cap` (034) también, y el comentario de
// la 034 dice por qué —"sin el lock, dos INSERT concurrentes leerían la misma
// suma y los dos entrarían: el lock ES la barrera"—.
//
// La consecuencia: dos `payPayrollItem` concurrentes con marcas DISTINTAS (dos
// requests, dos admins, dos pestañas) leen el mismo acumulado, los dos pasan su
// validación y los dos insertan. El ítem queda pagado DOS veces. La marca de la
// 042 protege el REINTENTO (mismo envío), no la CONCURRENCIA (envíos distintos).
//
// El doble de este bloque modela la BASE, no el test: el tope corre como un
// trigger `BEFORE INSERT` de verdad y la presencia del lock se DERIVA del SQL
// desplegado (`deployedPayrollCapBody`). Quitar el lock de la migración devuelve
// la conducta vulnerable y este bloque lo ve, sin que ningún test afirme una
// bandera que él mismo eligió.

describe("payroll: el tope de pagos de nómina bloquea la fila padre (CL-16)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-cl16",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const ITEM_ID = "item-cl16";
  const PERIOD_ID = "periodo-cl16";
  const NET = 100000;
  const MARK = "0a11ce55-1111-4111-8111-111111111111";
  const OTHER_MARK = "0a11ce55-2222-4222-8222-222222222222";

  /** Período en BORRADOR con su ítem (neto `netPay`) y un método activo. */
  function seedDraftItem(netPay = NET): void {
    payrollPagedStub.tables.payroll_periods = [
      {
        id: PERIOD_ID,
        sede_id: payrollPagedStub.SEDE_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-15",
        status: "borrador",
        created_by: ACTOR.userId,
        closed_at: null,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    payrollPagedStub.tables.payroll_items = [
      {
        id: ITEM_ID,
        period_id: PERIOD_ID,
        employee_id: payrollPagedStub.EMPLOYEE_ID,
        base_fixed: netPay,
        commissions: 0,
        bonuses: 0,
        deductions_vales: 0,
        other_discounts: 0,
        net_pay: netPay,
        detail_json: [],
        created_at: "2026-09-30T23:59:59.000Z",
      },
    ];
    payrollPagedStub.tables.payroll_payments = [];
    payrollPagedStub.tables.payment_methods = [
      {
        id: "met-efectivo",
        sede_id: payrollPagedStub.SEDE_ID,
        code: "efectivo",
        name: "Efectivo",
        is_active: true,
        arqueable: true,
        fee_percent: 0,
      },
    ];
  }

  const storedPayments = () => payrollPagedStub.tables.payroll_payments ?? [];
  const partial = (amount: number) => ({
    portions: [{ method_code: "efectivo", amount }],
  });

  beforeEach(() => {
    resetPayrollStubState();
    // El tope de la base, modelado de verdad en este bloque.
    payrollPagedStub.capEnabled = true;
    seedDraftItem();
  });
  afterEach(() => resetPayrollStubState());

  it("la carrera de dos pagos distintos: el lock hace que el 2º lo rechace el TOPE", async () => {
    // La otra transacción pagó 60.000 y confirmó entre la lectura del acumulado
    // de ÉSTA y su INSERT. Con el lock desplegado, el SUM del trigger corre
    // después de ese commit: ve 60.000, le suma los 60.000 entrantes y rechaza
    // (120.000 > 100.000). Sin el lock, su foto es anterior al commit: no ve
    // nada, pasa, y las dos filas de 60.000 entran —el ítem pagado dos veces—.
    payrollPagedStub.capRace = { itemId: ITEM_ID, amount: 60000, method_code: "efectivo" };
    const failure: unknown = await payrollExtrasService
      .payPayrollItem(
        payrollPagedStub.SEDE_ID,
        ITEM_ID,
        { idempotency_key: MARK, ...partial(60000) },
        ACTOR,
      )
      .catch((error: unknown) => error);

    // No vacuidad: el tope corrió y vio la fila de la otra transacción.
    expect(payrollPagedStub.capChecks.at(-1)).toMatchObject({
      itemId: ITEM_ID,
      sum: 60000,
      incoming: 60000,
      net: NET,
      sawConcurrent: true,
    });
    // El rechazo sale por el P0001 del tope, que el servicio traduce a OVERPAID.
    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    // Sólo quedó la fila de la otra transacción: la sentencia de ésta abortó
    // ENTERA y no dejó ninguna porción.
    expect(storedPayments()).toHaveLength(1);
    expect(storedPayments()[0]).toMatchObject({ amount: 60000, paid_by: "u-otra-transaccion" });
  });

  it("control: un segundo abono legítimo dentro del saldo (secuencial) sigue pasando", async () => {
    // Sin carrera y con el tope activo: pagar en partes es el caso normal de
    // PAY-04. Dos abonos con marcas DISTINTAS, que suman exactamente el neto, no
    // son una repetición y el tope no tiene por qué rechazarlos.
    const first = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: MARK, ...partial(60000) },
      ACTOR,
    );
    const second = await payrollExtrasService.payPayrollItem(
      payrollPagedStub.SEDE_ID,
      ITEM_ID,
      { idempotency_key: OTHER_MARK, ...partial(40000) },
      ACTOR,
    );

    expect(first.paid).toBe(60000);
    expect(second.paid).toBe(NET);
    expect(second.remaining).toBe(0);
    expect(storedPayments()).toHaveLength(2);
    // El tope se evaluó en las dos y vio el acumulado REAL de cada momento.
    expect(payrollPagedStub.capChecks).toEqual([
      { itemId: ITEM_ID, sum: 0, incoming: 60000, net: NET, sawConcurrent: false },
      { itemId: ITEM_ID, sum: 60000, incoming: 40000, net: NET, sawConcurrent: false },
    ]);
  });

  it("control del control: sin carrera, el tope SÍ rechaza el exceso (no es un adorno)", async () => {
    // El tope no es un bloque que siempre dice que sí: con el acumulado real ya
    // escrito, el exceso se rechaza por la misma tolerancia de centavo.
    payrollPagedStub.tables.payroll_payments = [
      {
        id: "pago-previo",
        payroll_item_id: ITEM_ID,
        method_id: null,
        method_code: "efectivo",
        amount: 90000,
        paid_at: "2026-09-10T12:00:00.000Z",
        paid_by: ACTOR.userId,
        reference: null,
        idempotency_key: null,
        created_at: "2026-09-10T12:00:00.000Z",
      },
    ];
    const failure: unknown = await payrollExtrasService
      .payPayrollItem(
        payrollPagedStub.SEDE_ID,
        ITEM_ID,
        { idempotency_key: MARK, ...partial(20000) },
        ACTOR,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect(storedPayments()).toHaveLength(1);
  });
});

describe("migración 055_payroll_payments_cap_lock.sql (CL-16)", () => {
  // La lectura es por test: el RED corre con el archivo todavía ausente, así que
  // una lectura en el cuerpo del `describe` rompería la colección de todo el
  // archivo en vez de fallar sólo estos tests (mismo patrón que 048).
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "055_payroll_payments_cap_lock.sql"),
      "utf8",
    );
    // El SQL sin comentarios: las aserciones miran las SENTENCIAS, no la prosa
    // que explica qué no hace el archivo.
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("reescribe la MISMA función y le agrega el lock de la fila PADRE", () => {
    const { sql } = migration();
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.check_payroll_payments_cap()");
    expect(sql).toContain("RETURNS trigger");
    // El lock de la fila PADRE: `payroll_items`, el ítem que tiene el neto (el
    // tope). Es la misma fila que en 031/034 es `invoices`.
    expect(sql).toMatch(/FROM public\.payroll_items\b[\s\S]*?FOR UPDATE/);
    // Y va ANTES del SUM: primero se ordena la lectura del acumulado, después
    // se lee y recién después se decide.
    const lock = sql.indexOf("FOR UPDATE");
    const sum = sql.indexOf("coalesce(sum(amount), 0)");
    expect(lock, "falta el lock de la fila del padre").toBeGreaterThan(-1);
    expect(sum).toBeGreaterThan(lock);
  });

  it("no toca el trigger: con CREATE OR REPLACE el vínculo no se rompe", () => {
    const { sql } = migration();
    // El trigger `trg_payroll_payments_cap` apunta a la función por su OID;
    // `CREATE OR REPLACE` con la misma firma lo conserva, así que no hay que
    // recrear el trigger, ni dropearlo, ni dropear la función.
    expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(sql).not.toMatch(/DROP\s+TRIGGER/i);
    expect(sql).not.toMatch(/DROP\s+FUNCTION/i);

    // El trigger sigue siendo el de la 007, apuntando a la misma función.
    const original = readFileSync(
      join(process.cwd(), "supabase", "migrations", "007_payroll.sql"),
      "utf8",
    );
    expect(original).toContain("CREATE TRIGGER trg_payroll_payments_cap");
    expect(original).toContain("BEFORE INSERT ON public.payroll_payments");
    expect(original).toContain("FOR EACH ROW EXECUTE FUNCTION public.check_payroll_payments_cap()");
  });

  it("conserva la aritmética, la tolerancia de centavo y el RAISE plano (P0001)", () => {
    const { sql } = migration();
    // Lo ÚNICO que esta migración cambia del cuerpo es el lock: la comparación
    // y el mensaje quedan idénticos a la 007.
    expect(sql).toContain("v_paid + NEW.amount - v_net > 0.009");
    expect(sql).toContain("El pago supera el neto del ítem (neto %, pagado %, nuevo %)");
    expect(sql).toContain("Ítem de nómina inexistente (%)");
    // Plano = sin ERRCODE: el SQLSTATE sigue siendo P0001, el que el servicio
    // traduce a OVERPAID (422). Un ERRCODE propio rompería esa traducción.
    expect(sql).not.toMatch(/ERRCODE/i);
    expect(sql).not.toMatch(/[A-Z_]{4,}\s+USING/i);
  });

  it("es idempotente y no borra ni reescribe filas de datos existentes", () => {
    const { sql } = migration();
    // `CREATE OR REPLACE FUNCTION` y `COMMENT ON FUNCTION` se pueden correr las
    // veces que haga falta: no fallan si ya están.
    expect(sql).toContain("COMMENT ON FUNCTION public.check_payroll_payments_cap()");
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\./i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\./i);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });

  it("declara el hueco, el orden de locks, la ventana residual y el acoplamiento", () => {
    const { raw } = migration();
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    // El orden de los locks y la ausencia de ciclo entre los tres topes.
    expect(raw).toContain("ORDEN DE LOS LOCKS");
    // La ventana que el lock NO cierra, dicha y no escondida.
    expect(raw).toContain("QUÉ CIERRA Y QUÉ NO");
    // Por qué alcanza un CREATE OR REPLACE (el OID conserva el trigger).
    expect(raw).toContain("CREATE OR REPLACE");
  });

  it("declara el costo de numeración y el archivo hermano que espeja", () => {
    const { raw } = migration();
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("055");
    expect(raw).toContain("052");
    expect(raw).toContain("054");
    // Los hermanos de la barrera, que son el modelo del lock de acá.
    expect(raw).toContain("031");
    expect(raw).toContain("034");
  });

  it("el doble deriva el lock del ARTEFACTO (es lo que hace pasar la carrera)", () => {
    // No es una aserción sobre una bandera del test: es el vínculo entre la
    // migración y el comportamiento. Si la 055 no existiera (o perdiera el
    // lock), esto sería `false` y el test de la carrera pagaría dos veces.
    expect(payrollCapLocksParent()).toBe(true);
    expect(deployedPayrollCapBody()).toContain("FOR UPDATE");
  });
});

/* ==========================================================================
   Nómina: los montos sólo aceptan dígitos con formato de dinero (guarda)

   `inputMode="numeric"` no impide teclear una letra. Los cuatro campos de
   MONTO de `payroll-client.tsx` —bonos, otros descuentos, monto de la porción
   y monto extra— se guardan como dígitos con `stripMoneyInput` y se muestran
   con `formatMoneyInput`, igual que el dinero del resto de la app. Esta guarda
   falla si alguien vuelve a leer el valor crudo.
   ========================================================================== */
describe("payroll-client: los campos de monto pasan por la máscara de dinero (guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
    "utf8",
  );

  /** Bloque `onChange={...}` cuyo cuerpo contiene `anchor` ("" si no existe). */
  function onChangeBlock(text: string, anchor: string): string {
    const at = text.indexOf(anchor);
    if (at === -1) return "";
    const start = text.lastIndexOf("onChange={", at);
    if (start === -1) return "";
    let depth = 0;
    for (let i = start + "onChange={".length; i < text.length; i += 1) {
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
  function assertMasked(block: string, raw: string): void {
    expect(block).not.toBe("");
    expect(block).toContain("stripMoneyInput(event.target.value)");
    expect(block).not.toContain(raw);
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source).toContain("stripMoneyInput");
  });

  it("los bonos del empleado usan la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(source, 'onAdjustmentChange(row.employeeId, "bonuses"'),
      'onAdjustmentChange(row.employeeId, "bonuses", event.target.value)',
    );
    expect(source).toContain('value={formatMoneyInput(adjustmentValue(row.employeeId, "bonuses"))}');
  });

  it("los otros descuentos usan la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(source, 'onAdjustmentChange(row.employeeId, "others"'),
      'onAdjustmentChange(row.employeeId, "others", event.target.value)',
    );
    expect(source).toContain('value={formatMoneyInput(adjustmentValue(row.employeeId, "others"))}');
  });

  it("el monto de la porción usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(source, "onPortionChange(portion.key, { amount:"),
      "onPortionChange(portion.key, { amount: event.target.value })",
    );
    expect(source).toContain("value={formatMoneyInput(portion.amount)}");
  });

  it("el monto extra de nómina usa la máscara de dinero", () => {
    assertMasked(
      onChangeBlock(source, "setExtraAmount(stripMoneyInput"),
      "setExtraAmount(event.target.value)",
    );
    expect(source).toContain("value={formatMoneyInput(extraAmount)}");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake = `<input onChange={(event) => setExtraAmount(event.target.value)} />`;
    const block = onChangeBlock(fake, "setExtraAmount(");
    expect(block).not.toBe("");
    // Sin el cable a la máscara, la misma guarda falla.
    expect(block).not.toContain("stripMoneyInput(event.target.value)");
    expect(block).toContain("setExtraAmount(event.target.value)");
    // Sin el ancla no hay bloque: la guarda falla en vez de pasar sola.
    expect(onChangeBlock(fake, "no-existe:")).toBe("");
  });
});

/* ==========================================================================
   NV-01 + regla del dueño (2026-10-01): «vales es solo vales y punto».

   El defecto que midió el dueño: un vale de 50.000 sobre un bruto de 7.000 se
   mostraba como la comisión del período —`capPayrollDiscounts` recortaba el
   descuento al bruto y ese recorte era lo que la celda mostraba—. La primera
   corrección (NV-01) puso el TOTAL REAL en la celda, pero dejó al lado dos
   líneas secundarias, `aplicado $ X` y `deuda pendiente $ Y`; en el caso del
   dueño el `aplicado` volvía a igualar la comisión, así que la columna seguía
   nombrando la comisión bajo otra etiqueta.

   Ahora las DOS tablas de liquidación (la cerrada `PeriodDetailTable` y el
   borrador `DraftPayrollTable`) muestran ÚNICAMENTE `voucher_total` —la suma
   REAL del período— con el signo de descuento. La conciliación (cuánto
   descontó el neto y cuánta deuda quedó) se movió al modal "Facturas y vales
   de <empleado>", donde el lector va a reconciliar, y cada cifra aparece SOLO
   cuando aplica. Guarda de fuente: sin DOM, sobre el texto real del cliente.
   ========================================================================== */
describe("payroll-client: la columna de vales muestra solo el total real (regla del dueño, guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
    "utf8",
  );

  /** Cuántas veces aparece un fragmento literal en un texto. */
  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  /** Cableado: la condición introduce la rama que contiene al texto. */
  function wired(text: string, condition: string, needle: string): number {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `${escape(condition)}(?: &&| \\?) \\([\\s\\S]{0,240}${escape(needle)}`,
      "g",
    );
    return [...text.matchAll(pattern)].length;
  }

  /**
   * Los bloques `<td>` de la columna de vales, uno por tabla: desde su apertura
   * (el `title` la identifica) hasta su cierre. Ese bloque es el que NO puede
   * volver a tener líneas secundarias.
   */
  function voucherCells(text: string): string[] {
    const openings = [
      "<td className={tableCellClass} title={voucherCellTitle(item)}>",
      "<td className={tableCellClass} title={item ? voucherCellTitle(item) : undefined}>",
    ];
    const cells: string[] = [];
    for (const opening of openings) {
      const start = text.indexOf(opening);
      if (start === -1) continue;
      const end = text.indexOf("</td>", start);
      if (end === -1) continue;
      cells.push(text.slice(start, end + "</td>".length));
    }
    return cells;
  }

  /**
   * El bloque del modal "Facturas y vales": de las props del panel (donde vive
   * el ítem que trae las cifras) al componente que lo usa.
   */
  function sourcesPanel(text: string): string {
    const start = text.indexOf("interface SettlementSourcesPanelProps {");
    const end = text.indexOf("export function PayrollClient(", start);
    return start === -1 || end === -1 ? "" : text.slice(start, end);
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source).toContain("export function PayrollClient");
    expect(voucherCells(source)).toHaveLength(2);
    expect(sourcesPanel(source).length).toBeGreaterThan(1_000);
  });

  it("las DOS celdas de vales muestran solo el total real, sin `aplicado` ni `deuda pendiente`", () => {
    // Una ocurrencia por tabla: `PeriodDetailTable` y `DraftPayrollTable`.
    expect(count(source, "-${formatMoney(item.voucher_total)}")).toBe(2);
    // El descuento APLICADO no es el valor de la celda, ni antes ni ahora.
    expect(count(source, "-${formatMoney(item.deductions_vales)}")).toBe(0);
    // Y las dos líneas secundarias que el dueño rechazó se fueron del archivo:
    // su texto no sobrevive en ninguna otra celda ni en el `title`.
    expect(count(source, "aplicado ${formatMoney(item.deductions_vales)}")).toBe(0);
    expect(count(source, "deuda pendiente ${formatMoney(item.pending_debt)}")).toBe(0);
    for (const cell of voucherCells(source)) {
      expect(count(cell, "-${formatMoney(item.voucher_total)}")).toBe(1);
      expect(count(cell, "item.deductions_vales")).toBe(0);
      expect(count(cell, "item.pending_debt")).toBe(0);
      // El `title` accesible sigue: no es clutter visible ni un monto suelto.
      expect(cell).toContain("voucherCellTitle(");
    }
  });

  it("el modal de facturas y vales es donde ahora se concilian el monto aplicado y la deuda", () => {
    const panel = sourcesPanel(source);
    // El monto aplicado se explica SOLO cuando difiere del total: si coinciden,
    // repetirlo sería nombrar de nuevo el total del período (la queja del dueño).
    expect(count(panel, "item.deductions_vales < item.voucher_total")).toBe(1);
    expect(wired(panel, "item.deductions_vales < item.voucher_total", "formatMoney(item.deductions_vales)")).toBe(1);
    // La deuda, SOLO cuando existe.
    expect(count(panel, "item.pending_debt > 0")).toBe(1);
    expect(wired(panel, "item.pending_debt > 0", "formatMoney(item.pending_debt)")).toBe(1);
    // El panel recibe el ítem del empleado y el modal lo resuelve desde el
    // detalle ya leído: sin ítem no hay cifras que conciliar.
    expect(panel).toContain("item: DetailItem | null");
    expect(count(source, "item={itemByEmployee.get(sourcesTarget.employeeId) ?? null}")).toBe(1);
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    // El marcado que el dueño rechazó: el total en la celda MÁS las dos líneas
    // secundarias. Si alguien las re-agrega, la guarda de la celda las ve.
    const viejo =
      '<td className={tableCellClass} title={voucherCellTitle(item)}>\n' +
      '  <span className="block">{`-${formatMoney(item.voucher_total)}`}</span>\n' +
      '  {item.deductions_vales < item.voucher_total && (\n' +
      '    <span className="block text-xs text-text-tertiary">\n' +
      '      {`aplicado ${formatMoney(item.deductions_vales)}`}\n' +
      '    </span>\n' +
      '  )}\n' +
      '  {item.pending_debt > 0 && (\n' +
      '    <span className="block text-xs text-text-tertiary">\n' +
      '      {`deuda pendiente ${formatMoney(item.pending_debt)}`}\n' +
      '    </span>\n' +
      '  )}\n' +
      '</td>';
    expect(voucherCells(viejo)).toHaveLength(1);
    const cell = voucherCells(viejo)[0];
    // El total sigue ahí: lo que delata la regresión es lo secundario.
    expect(count(cell, "-${formatMoney(item.voucher_total)}")).toBe(1);
    expect(count(cell, "-${formatMoney(item.deductions_vales)}")).toBe(0);
    expect(count(cell, "item.deductions_vales")).toBeGreaterThan(0);
    expect(count(cell, "item.pending_debt")).toBeGreaterThan(0);
    // El cableado del modal sí se lee sobre la rama: la misma deuda bien
    // escrita cuenta, y suelta (sin condición) no.
    expect(wired(viejo, "item.pending_debt > 0", "formatMoney(item.pending_debt)")).toBe(1);
    const suelta = "{`Queda una deuda de ${formatMoney(item.pending_debt)}`}";
    expect(wired(suelta, "item.pending_debt > 0", "formatMoney(item.pending_debt)")).toBe(0);
  });
});

/* ==========================================================================
   F6: las fuentes de la liquidación (facturas, ajuste del mixto y vales).

   El modal del dueño ("Ver facturas y vales") se alimenta de UNA lectura nueva
   y ACOTADA: las facturas salen de `detail_json` (la liquidación ya es la dueña
   del detalle, sin consultar `invoices`) y los vales de la MISMA forma que el
   cálculo (sede + rango `request_date` + alcance de estados), por empleado. Sin
   ítem no hay liquidación y el read devuelve vacío: no inventa una relación que
   el cálculo no creó.
   ========================================================================== */
describe("payroll: las fuentes de la liquidación (F6)", () => {
  const SEDE = payrollPagedStub.SEDE_ID;
  const PERIOD_ID = payrollPagedStub.PERIOD_ID;
  const EMPLEADO = payrollPagedStub.EMPLOYEE_ID;
  const OTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function detailLine(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      employee_id: EMPLEADO,
      invoice_id: "factura-1",
      consecutive_number: 1,
      item_id: "linea-1",
      item_type: "servicio",
      qty: 1,
      unit_price: 100,
      line_subtotal: 100,
      commission: 0,
      commission_value: null,
      ...overrides,
    };
  }

  function seed(data: {
    items?: Array<Record<string, unknown>>;
    vouchers?: Array<Record<string, unknown>>;
  }) {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: PERIOD_ID,
          sede_id: SEDE,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          frequency: null,
          status: "cerrado",
          created_by: "u-1",
          closed_at: "2026-02-01T00:00:00.000Z",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      payroll_items: data.items ?? [],
      voucher_requests: data.vouchers ?? [],
    };
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("agrupa las líneas por factura y suma su comisión en una sola fila", async () => {
    seed({
      items: [
        {
          id: "item-nomina-1",
          period_id: PERIOD_ID,
          employee_id: EMPLEADO,
          detail_json: [
            detailLine({ invoice_id: "factura-1", consecutive_number: 7, item_id: "l1", commission: 1000 }),
            detailLine({ invoice_id: "factura-1", consecutive_number: 7, item_id: "l2", commission: 2500 }),
            detailLine({ invoice_id: "factura-2", consecutive_number: 8, item_id: "l3", commission: 400 }),
          ],
        },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    // Dos líneas de la MISMA factura son UNA fila; la comisión se suma.
    expect(sources.invoices).toEqual([
      { invoice_id: "factura-1", consecutive_number: 7, commission: 3500 },
      { invoice_id: "factura-2", consecutive_number: 8, commission: 400 },
    ]);
    expect(sources.adjustment).toBeNull();
    expect(sources.vouchers).toEqual([]);
  });

  it("devuelve SOLO las fuentes de este empleado (ni otro legajo)", async () => {
    seed({
      items: [
        {
          id: "item-mio",
          period_id: PERIOD_ID,
          employee_id: EMPLEADO,
          detail_json: [detailLine({ invoice_id: "factura-mia", consecutive_number: 1, commission: 900 })],
        },
        {
          id: "item-ajeno",
          period_id: PERIOD_ID,
          employee_id: OTRO,
          detail_json: [
            detailLine({ employee_id: OTRO, invoice_id: "factura-ajena", consecutive_number: 2, commission: 5000 }),
          ],
        },
      ],
      vouchers: [
        { id: "vale-mio", sede_id: SEDE, employee_id: EMPLEADO, amount: 10000, request_date: "2026-01-10", status: "descontada" },
        { id: "vale-ajeno", sede_id: SEDE, employee_id: OTRO, amount: 99999, request_date: "2026-01-10", status: "descontada" },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    expect(sources.invoices.map((row) => row.invoice_id)).toEqual(["factura-mia"]);
    expect(sources.vouchers.map((row) => row.id)).toEqual(["vale-mio"]);
  });

  it("sin fuentes no inventa datos: un vale fuera del rango no es de la liquidación", async () => {
    seed({
      items: [{ id: "item-vacio", period_id: PERIOD_ID, employee_id: EMPLEADO, detail_json: [] }],
      vouchers: [
        { id: "vale-fuera", sede_id: SEDE, employee_id: EMPLEADO, amount: 5000, request_date: "2025-12-31", status: "pendiente" },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    expect(sources).toEqual({ invoices: [], adjustment: null, vouchers: [] });
  });

  it("sin ítem para el empleado el período no tiene liquidación: todo vacío", async () => {
    seed({
      items: [],
      vouchers: [
        { id: "vale-suelto", sede_id: SEDE, employee_id: EMPLEADO, amount: 5000, request_date: "2026-01-10", status: "pendiente" },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    expect(sources).toEqual({ invoices: [], adjustment: null, vouchers: [] });
  });

  it("el ajuste del mixto se separa de las facturas, con su monto en negativo", async () => {
    seed({
      items: [
        {
          id: "item-mixto",
          period_id: PERIOD_ID,
          employee_id: EMPLEADO,
          detail_json: [
            detailLine({ invoice_id: "factura-1", consecutive_number: 3, item_id: "l1", commission: 400000 }),
            mixedAbsorbedDetailLine({ employeeId: EMPLEADO, absorbed: 300000 }),
          ],
        },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    expect(sources.invoices).toEqual([
      { invoice_id: "factura-1", consecutive_number: 3, commission: 400000 },
    ]);
    expect(sources.adjustment).toEqual({ commission: -300000 });
    // El marcador del ajuste NO se cuela como una factura abrible.
    expect(sources.invoices.some((row) => row.invoice_id === MIXED_ABSORBED_ITEM_TYPE)).toBe(false);
  });

  it("solo los vales del alcance del cálculo entran (rechazado queda afuera)", async () => {
    seed({
      items: [{ id: "item-v", period_id: PERIOD_ID, employee_id: EMPLEADO, detail_json: [] }],
      vouchers: [
        { id: "vale-pendiente", sede_id: SEDE, employee_id: EMPLEADO, amount: 1000, request_date: "2026-01-05", status: "pendiente" },
        { id: "vale-aprobada", sede_id: SEDE, employee_id: EMPLEADO, amount: 2000, request_date: "2026-01-06", status: "aprobada" },
        { id: "vale-descontada", sede_id: SEDE, employee_id: EMPLEADO, amount: 3000, request_date: "2026-01-07", status: "descontada" },
        { id: "vale-rechazada", sede_id: SEDE, employee_id: EMPLEADO, amount: 4000, request_date: "2026-01-08", status: "rechazada" },
      ],
    });

    const sources = await getPayrollSettlementSources(SEDE, PERIOD_ID, EMPLEADO);

    expect(sources.vouchers.map((row) => row.id)).toEqual([
      "vale-aprobada",
      "vale-descontada",
      "vale-pendiente",
    ]);
    expect(sources.vouchers[0].request_date).toBe("2026-01-06");
  });

  it("la agrupación es pura y redondea como el módulo (función pura)", () => {
    const grouped = groupSettlementInvoices([
      detailLine({ invoice_id: "a", consecutive_number: 1, item_id: "x1", commission: 1000.4 }) as never,
      detailLine({ invoice_id: "a", consecutive_number: 1, item_id: "x2", commission: 1000.4 }) as never,
      // Sin `invoice_id` no hay factura que abrir: no inventa una fila.
      detailLine({ invoice_id: "", consecutive_number: null, item_id: "suelto", commission: 5000 }) as never,
    ]);
    expect(grouped.invoices).toEqual([{ invoice_id: "a", consecutive_number: 1, commission: 2000 }]);
    expect(grouped.adjustment).toBeNull();
  });

  it("el empleado logueado no puede leer las fuentes de otro legajo (action)", async () => {
    const MIO = "eeeeeeee-eeee-4eee-8eee-eeeeeeee5555";
    const MI_USER = "u-empleado-55";
    seed({
      items: [
        {
          id: "item-mio",
          period_id: PERIOD_ID,
          employee_id: MIO,
          detail_json: [detailLine({ employee_id: MIO, invoice_id: "factura-mia", commission: 900 })],
        },
        {
          id: "item-ajeno",
          period_id: PERIOD_ID,
          employee_id: OTRO,
          detail_json: [
            detailLine({ employee_id: OTRO, invoice_id: "factura-ajena", commission: 5000 }),
          ],
        },
      ],
    });
    // La planta va DESPUÉS de sembrar: el mock de `listAllEmployees` lee esta
    // tabla cuando existe y es la que ubica al empleado logueado.
    payrollPagedStub.tables.employees = [
      {
        id: MIO,
        sede_id: SEDE,
        user_id: MI_USER,
        full_name: "Empleada propia",
        employee_code: null,
        document: null,
        phone: null,
        position: null,
        payout_mode: "normal",
        email: null,
        birth_date: null,
        pay_type: "porcentaje",
        pay_frequency: null,
        salary_fixed: null,
        commission_percent: 10,
        is_active: true,
      },
    ];
    payrollPagedStub.session = { userId: MI_USER, sedeId: SEDE, roles: ["empleado"] };

    // El empleado PIDE el legajo ajeno; la action resuelve el suyo y lo ignora.
    const result = await getPayrollSettlementSourcesAction(PERIOD_ID, OTRO);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.invoices.map((row) => row.invoice_id)).toEqual(["factura-mia"]);
  });
});

/* ==========================================================================
   F6: el cableado del modal "Ver facturas y vales" (guarda de fuente).

   Sin DOM y sobre el texto real del cliente: el botón que abre el modal, las
   dos listas, el botón de detalle de cada fila (con la lectura EXISTENTE de
   facturación y de vales) y el ajuste del mixto renderizado como ajuste.
   ========================================================================== */
describe("payroll-client: el modal de facturas y vales (F6, guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
    "utf8",
  );

  /** Cuántas veces aparece un fragmento literal en el fuente. */
  function count(needle: string): number {
    return source.split(needle).length - 1;
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source).toContain("export function PayrollClient");
  });

  it("el botón 'Ver facturas y vales' existe en las dos tablas y abre el modal", () => {
    // Una línea de botón por tabla de liquidación: la cerrada y el borrador.
    // (El conteo por línea exacta no confunde el texto del botón con la
    // `aria-label` ni con los comentarios que lo mencionan.)
    const botones = source
      .split("\n")
      .filter((line) => line.trim() === "Ver facturas y vales");
    expect(botones).toHaveLength(2);
    expect(count("onViewSources(item)")).toBe(2);
    // El cableado resuelve el período vigente y el empleado de la fila.
    expect(count("void openSettlementSources(selected.id, item.employee_id)")).toBe(3);
    expect(count("getPayrollSettlementSourcesAction(")).toBe(1);
  });

  it("las dos listas existen, rotuladas y alimentadas por la lectura nueva", () => {
    expect(source).toContain("Facturas de la liquidación");
    expect(source).toContain("Vales de la liquidación");
    expect(source).toContain("(sources?.invoices ?? []).map");
    expect(source).toContain("(sources?.vouchers ?? []).map");
  });

  it("cada fila abre su detalle con la lectura EXISTENTE", () => {
    // Factura: la lectura de facturación; vale: la lectura de vales.
    expect(source).toContain("await getInvoiceAction(invoiceId)");
    expect(source).toContain("await listVouchersAction({");
    expect(source).toContain("onViewInvoice(invoice.invoice_id)");
    expect(source).toContain("onViewVoucher(voucher)");
    // Un botón "Ver detalle" por lista (factura y vale).
    const botones = source.split("\n").filter((line) => line.trim() === "Ver detalle");
    expect(botones).toHaveLength(2);
    expect(source).toContain("Ver el detalle de la factura");
    expect(source).toContain("Ver el detalle del vale del");
  });

  it("el ajuste del mixto se muestra como ajuste y NO como factura", () => {
    expect(source).toContain("Ajuste del mixto");
    expect(source).toContain("sources?.adjustment");
    expect(source).toContain("El básico absorbió");
    // Se pinta aparte: no se recorre `invoices` para el ajuste ni se rotula
    // como consecutivo.
    expect(source).not.toContain("Factura #ajuste_mixto");
    expect(source).toContain("{formatMoney(sources.adjustment.commission)}");
  });

  it("los vacíos son honestos y en texto plano (no un aviso)", () => {
    expect(source).toContain("La liquidación no tiene facturas");
    expect(source).toContain("La liquidación no tiene vales");
    // El vacío no se envuelve en `Alert` (agregaría un anuncio que no existe).
    const lineas = source
      .split("\n")
      .filter((line) => line.includes("La liquidación no tiene facturas"));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).not.toContain("Alert");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    // El marcado VIEJO: una sola celda "Ver" sin modal de fuentes.
    const viejo = "<td>Ver</td>";
    expect(viejo.split("Ver facturas y vales").length - 1).toBe(0);
    expect(viejo.includes("Ajuste del mixto")).toBe(false);
    expect(viejo.includes("onViewInvoice(")).toBe(false);
    expect(viejo.includes("onViewVoucher(")).toBe(false);
    // Sin `onViewSources` el botón no estaría cableado al modal.
    expect(viejo.split("onViewSources(item)").length - 1).toBe(0);
  });
});

/* ==========================================================================
   F8 (decisión del dueño, 2026-10-01): TODO ajuste manual lleva su motivo.

   El defecto: el admin escribe bonos y otros descuentos por empleado sin
   justificación; la diferencia de una liquidación sólo la podía explicar la
   memoria de quien la cargó. El motivo es obligatorio y viaja en la MISMA fila
   que el monto (misma transacción): no puede quedar el ajuste aplicado y su
   explicación ausente, ni al revés.
   ========================================================================== */
describe("payroll: TODO ajuste manual lleva su motivo (F8)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-admin-f8",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const EMPLOYEE_NAME = "Empleada F8";
  /** Motivo real, con espacios a los lados para probar el recorte. */
  const REASON = "Bono por cierre de inventario de enero";
  const SALARY = 1_400_000;

  function seed() {
    payrollPagedStub.tables = {
      payroll_periods: [
        {
          id: payrollPagedStub.PERIOD_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          status: "borrador",
          created_by: ACTOR.userId,
          closed_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      employees: [
        {
          id: payrollPagedStub.EMPLOYEE_ID,
          sede_id: payrollPagedStub.SEDE_ID,
          user_id: null,
          full_name: EMPLOYEE_NAME,
          employee_code: "E-F8",
          document: "1000000008",
          phone: null,
          position: null,
          payout_mode: "normal",
          email: null,
          birth_date: null,
          pay_type: "fijo",
          pay_frequency: null,
          salary_fixed: SALARY,
          commission_percent: null,
          is_active: true,
        },
      ],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      payroll_discount_carries: [],
      audit_logs: [],
    };
  }

  const persistedItem = () => payrollPagedStub.tables.payroll_items[0];
  const itemPayload = (): Record<string, unknown> =>
    (payrollPagedStub.rpcCalls[0]?.args.p_items as Array<Record<string, unknown>>)?.[0] ?? {};

  /** La identidad del CHECK de `payroll_items` (tolerancia de un centavo). */
  function expectIdentity(item: Record<string, unknown>) {
    const identity =
      Number(item.base_fixed) +
      Number(item.commissions) +
      Number(item.bonuses) -
      Number(item.deductions_vales) -
      Number(item.other_discounts);
    expect(Math.abs(Number(item.net_pay) - identity)).toBeLessThan(0.01);
    expect(Number(item.net_pay)).toBeGreaterThanOrEqual(0);
  }

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  // ------------------------------------------------------------------- RED ---

  it("RED: un ajuste sin motivo se rechaza (VALIDATION) y el mensaje nombra al empleado", async () => {
    seed();

    const outcome: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      { adjustments: [{ employee_id: payrollPagedStub.EMPLOYEE_ID, bonuses: 50_000 }] },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(PayrollError);
    expect(outcome).toMatchObject({ code: "VALIDATION", status: 400 });
    // El mensaje NOMBRA al empleado y dice qué falta: no es un error genérico.
    expect((outcome as Error).message).toContain(EMPLOYEE_NAME);
    expect((outcome as Error).message.toLowerCase()).toContain("motivo");
    // Nada escrito: el rechazo ocurre ANTES de la transacción.
    expect(payrollPagedStub.rpcCalls).toEqual([]);
    expect(payrollPagedStub.itemWrites).toEqual([]);
    expect(payrollPagedStub.tables.payroll_items).toEqual([]);
  });

  it("el descuento manual también exige motivo, y un motivo en blanco cuenta como ausente", async () => {
    seed();

    const withoutReason: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      { adjustments: [{ employee_id: payrollPagedStub.EMPLOYEE_ID, other_discounts: 10_000 }] },
      ACTOR,
    ).catch((error: unknown) => error);
    expect(withoutReason).toMatchObject({ code: "VALIDATION", status: 400 });

    // Un motivo que sólo tiene espacios no justifica nada.
    const blank: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          { employee_id: payrollPagedStub.EMPLOYEE_ID, bonuses: 1_000, adjustment_reason: "   " },
        ],
      },
      ACTOR,
    ).catch((error: unknown) => error);
    expect(blank).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(payrollPagedStub.rpcCalls).toEqual([]);
  });

  it("un motivo de más de 200 caracteres se rechaza antes de escribir", async () => {
    seed();

    const outcome: unknown = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          {
            employee_id: payrollPagedStub.EMPLOYEE_ID,
            bonuses: 1_000,
            adjustment_reason: "x".repeat(201),
          },
        ],
      },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: "VALIDATION", status: 400 });
    expect((outcome as Error).message).toContain("200");
    expect(payrollPagedStub.rpcCalls).toEqual([]);
  });

  // ---------------------------------------------------------------- GREEN ---

  it("GREEN: con motivo el ajuste se persiste, se lee de vuelta y viaja en el payload", async () => {
    seed();

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          {
            employee_id: payrollPagedStub.EMPLOYEE_ID,
            bonuses: 50_000,
            adjustment_reason: `  ${REASON}  `,
          },
        ],
      },
      ACTOR,
    );

    // El motivo se recorta y viaja tal cual en el ítem que se escribe.
    expect(detail.items[0].adjustment_reason).toBe(REASON);
    expect(persistedItem().adjustment_reason).toBe(REASON);
    expect(itemPayload().adjustment_reason).toBe(REASON);
    expect(payrollPagedStub.itemWrites[0][0].adjustment_reason).toBe(REASON);
    // El monto y su motivo entran en la MISMA fila.
    expect(detail.items[0].bonuses).toBe(50_000);
    expectIdentity(persistedItem());
  });

  it("sin ajuste no se exige motivo y la columna queda NULL (el payload igual lleva la clave)", async () => {
    seed();

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          { employee_id: payrollPagedStub.EMPLOYEE_ID, bonuses: 0, other_discounts: 0 },
        ],
      },
      ACTOR,
    );

    expect(detail.items[0].adjustment_reason).toBeNull();
    expect(persistedItem().adjustment_reason).toBeNull();
    // La clave SIEMPRE viaja en el payload, con null cuando no hay ajuste.
    expect("adjustment_reason" in itemPayload()).toBe(true);
    expect(itemPayload().adjustment_reason).toBeNull();
    expectIdentity(persistedItem());
  });

  it("un motivo sin ajuste se DESCARTA: nunca queda una justificación huérfana", async () => {
    seed();

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          {
            employee_id: payrollPagedStub.EMPLOYEE_ID,
            bonuses: 0,
            other_discounts: 0,
            adjustment_reason: "un motivo que no justifica ningún monto",
          },
        ],
      },
      ACTOR,
    );

    expect(detail.items[0].adjustment_reason).toBeNull();
    expect(persistedItem().adjustment_reason).toBeNull();
    expectIdentity(persistedItem());
  });

  it("la identidad del neto no cambia: el motivo no entra en la aritmética", async () => {
    seed();

    const detail = await calculatePayroll(
      payrollPagedStub.SEDE_ID,
      payrollPagedStub.PERIOD_ID,
      {
        adjustments: [
          {
            employee_id: payrollPagedStub.EMPLOYEE_ID,
            bonuses: 50_000,
            other_discounts: 10_000,
            adjustment_reason: REASON,
          },
        ],
      },
      ACTOR,
    );

    const item = detail.items[0];
    expect(item.bonuses).toBe(50_000);
    expect(item.other_discounts).toBe(10_000);
    expectIdentity(persistedItem());
    expectIdentity(item as unknown as Record<string, unknown>);
  });
});

/* ==========================================================================
   F8: la migración 067 declaró la columna del motivo y conservó la firma de
   `payroll_apply_atomic` (cuatro parámetros, el cuarto con DEFAULT).
   ========================================================================== */
describe("migración 067_payroll_adjustment_reason.sql (F8)", () => {
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "067_payroll_adjustment_reason.sql"),
      "utf8",
    );
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("agrega la columna con su COMMENT y dice qué significa NULL", () => {
    const { raw, sql } = migration();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS adjustment_reason text NULL");
    expect(raw).toContain("COMMENT ON COLUMN public.payroll_items.adjustment_reason IS");
    expect(raw).toContain("NULL = sin ajuste manual");
    // La numeración estaba libre y el archivo la justifica.
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("mantiene la firma de CUATRO parámetros y no crea una sobrecarga", () => {
    const { sql } = migration();
    expect(sql.match(/CREATE OR REPLACE FUNCTION public\.payroll_apply_atomic/g)).toHaveLength(1);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.payroll_apply_atomic\(\s*p_period_id uuid,\s*p_items jsonb,\s*p_voucher_ids uuid\[\],\s*p_carry_ids uuid\[\] DEFAULT '\{\}'\s*\)/,
    );
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    // El ALTER/ACL/COMMENT se re-emiten con la MISMA firma.
    expect(sql).toContain("ALTER FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) SET search_path = public;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) FROM PUBLIC;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.payroll_apply_atomic(uuid, jsonb, uuid[], uuid[]) TO service_role;");
  });

  it("escribe el motivo en el INSERT y en el ON CONFLICT DO UPDATE", () => {
    const { sql } = migration();
    expect(sql).toContain("adjustment_reason)");
    expect(sql).toContain("(item ->> 'adjustment_reason')");
    expect(sql).toContain("adjustment_reason = EXCLUDED.adjustment_reason;");
  });

  it("valida la forma del motivo: no vacío después de recortar y ≤ 200 caracteres", () => {
    const { sql } = migration();
    expect(sql).toContain("jsonb_typeof(item -> 'adjustment_reason') <> 'null'");
    expect(sql).toContain("jsonb_typeof(item -> 'adjustment_reason') <> 'string'");
    expect(sql).toContain("char_length(btrim(item ->> 'adjustment_reason')) < 1");
    expect(sql).toContain("char_length(btrim(item ->> 'adjustment_reason')) > 200");
  });
});

/* ==========================================================================
   F8: el cableado del motivo en la pantalla (guarda de fuente).

   El campo del motivo vive junto a los bonos y otros descuentos; se marca
   obligatorio cuando la fila lleva ajuste; la tabla cerrada muestra el motivo
   guardado. La guarda no agrega `<Alert>` ni `role=`: el aviso es texto plano
   (por eso `tests/feedback-batch2.test.ts` sigue verde).

   F8-visibilidad: el motivo faltante se avisa INLINE, en la MISMA celda del
   motivo, porque el error de la página queda DETRÁS del diálogo abierto y el
   admin no lo ve. El aviso nombra al empleado y desaparece apenas se escribe.
   ========================================================================== */
describe("payroll-client: el motivo del ajuste (F8, guarda de fuente)", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
    "utf8",
  );

  /**
   * El aviso INLINE del motivo faltante: un `<p>` de texto plano en la celda
   * del motivo, con la copia que nombra al empleado de la fila. No es `Alert`
   * (movería el conteo de `feedback-batch2`) ni lleva `role=` a mano.
   */
  const INLINE_REASON_NOTICE =
    /<p className="mt-1 text-xs text-error">\s*\{`Falta el motivo del ajuste de \$\{employeeName\(row\.employeeId\)\}\.`\}\s*<\/p>/;

  /**
   * El `<td>` que envuelve el input del motivo. Corta en su `</td>` desde la
   * `aria-label` del campo, así el aviso solo cuenta si está en ESA celda.
   */
  function reasonCellBody(candidate: string): string {
    const input = candidate.indexOf(
      "aria-label={`Motivo del ajuste de ${employeeName(row.employeeId)}`}",
    );
    expect(input, "input del motivo").toBeGreaterThan(-1);
    const open = candidate.lastIndexOf("<td className={tableCellClass}>", input);
    const close = candidate.indexOf("</td>", input);
    return candidate.slice(open, close + "</td>".length);
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source).toContain("adjustmentReasonValue");
  });

  it("cada fila del borrador tiene el campo de motivo, cableado al mismo registro", () => {
    expect(source).toContain("aria-label={`Motivo del ajuste de ${employeeName(row.employeeId)}`}");
    expect(source).toContain('onAdjustmentChange(row.employeeId, "reason", event.target.value)');
    expect(source).toContain('adjustment_reason: reason === "" ? null : reason,');
    expect(source).toContain("aria-required={reasonRequired}");
    expect(source).toContain("Motivo (obligatorio)");
  });

  it("el motivo faltante se avisa INLINE, junto a la fila, y nombra al empleado", () => {
    // El aviso vive en la MISMA celda del motivo, pegado al input y dentro del
    // diálogo: el error de la página queda detrás del modal abierto.
    const cell = reasonCellBody(source);
    expect(cell, "aviso inline del motivo faltante").toMatch(INLINE_REASON_NOTICE);
    // Texto plano: un `Alert` o un `role=` movería las guardas de feedback-batch2.
    expect(cell).not.toContain("<Alert");
    expect(cell).not.toMatch(/\brole\s*=/);
    // Se deriva de la MISMA condición que marca el campo obligatorio, y deja de
    // mostrarse apenas el motivo existe (`reasonValue.trim() !== ""`).
    expect(source).toContain('const reasonMissing = reasonRequired && reasonValue.trim() === "";');
    expect(source).toContain("const reasonValue = adjustmentReasonValue(row.employeeId);");
  });

  it("el detector del aviso inline no es un sello de goma (control negativo)", () => {
    // El marcado VIEJO de esta unidad: el input del motivo, sin el aviso inline
    // (la respuesta vivía solo en el error de la página). La misma guarda que
    // afirma el aviso tiene que rechazarlo.
    const viejo = [
      '<td className={tableCellClass}>',
      '  <input',
      '    aria-label={`Motivo del ajuste de ${employeeName(row.employeeId)}`}',
      '  />',
      "</td>",
    ].join("\n");
    const cell = reasonCellBody(viejo);
    expect(cell).not.toMatch(INLINE_REASON_NOTICE);
    expect(cell).not.toContain("reasonMissing");
    // Y la condición inline no estaba: el aviso es nuevo, no un falso positivo.
    expect(viejo.includes("reasonMissing")).toBe(false);
  });

  it("la tabla cerrada muestra el motivo guardado (auditoría)", () => {
    expect(source).toContain('{item.adjustment_reason ?? "—"}');
  });

  it("la nota vieja de la primera nómina se reemplazó por lo que pasa de verdad", () => {
    expect(source).not.toContain("suele ser un rango corto");
    expect(source).toContain("La primera liquidación es un ciclo completo");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    // El marcado VIEJO, sin motivo: ninguna de las señales de la guarda está.
    const viejo =
      '<td><input aria-label={`Bonos de ${employeeName(row.employeeId)}`} /></td>';
    expect(viejo.includes("adjustmentReasonValue")).toBe(false);
    expect(viejo.includes('onAdjustmentChange(row.employeeId, "reason"')).toBe(false);
    expect(viejo.includes("aria-required={reasonRequired}")).toBe(false);
    expect(viejo.includes("adjustment_reason")).toBe(false);
    // Y la copia vieja existe: el `not.toContain` de arriba no pasa solo.
    expect(
      "La primera liquidación suele ser un rango corto, desde el día en que arrancaron.".includes(
        "suele ser un rango corto",
      ),
    ).toBe(true);
  });
});

describe("payroll-client: el aviso de ciclos pendientes y la entrada DERIVADA del diálogo (F9/F10, guarda de fuente)", () => {
  const source = readFileSync(join(process.cwd(), "app", "payroll", "payroll-client.tsx"), "utf8");

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(source.length).toBeGreaterThan(20_000);
    expect(source).toContain("export function PayrollClient");
  });

  it("la lista sale de la función pura y de los datos que la pantalla YA tiene", () => {
    // Sin lectura nueva: los períodos (estado del cliente), la planta que llega
    // como prop y la fecha de arranque (prop del servidor). Un `select` por
    // cadencia sería N consultas para el mismo dato.
    expect(source).toMatch(
      /const pendingSettlements = props\.canAdmin\s*\?\s*pendingPayrollSettlements\(\{\s*periods,\s*employees: props\.initialEmployees,\s*referenceDate: bogotaDay\(\),\s*payrollStartDate,\s*\}\)/,
    );
    // Sólo el admin: el aviso nombra a la planta de la sede.
    expect(source).toContain("props.canAdmin && pendingSettlements.length > 0");
    // F10: la fecha llega leída del servidor (SSR) y es la MISMA cota del aviso.
    expect(source).toContain("props.initialPayrollStartDate");
    expect(source).toContain("payrollStartDate,\n      })");
  });

  it("el aviso nombra cadencia, ciclo y gente, dentro de un Alert de aviso sin rol a mano", () => {
    // ESTADO, no evento, y `warning` (no `destructive`): es un pendiente que exige
    // acción, no un fallo de la pantalla. El rol lo deriva la variante.
    expect(source).toContain('<Alert variant="warning" className="mt-3">');
    expect(source).toContain("Hay ciclos ya cerrados sin liquidar.");
    expect(source).toContain("{pendingSettlementText(entry)}");
    expect(source).toContain(
      "return `Falta liquidar el ciclo ${entry.frequency} ${entry.label} (${employees}: ${who}).`;",
    );
    // El conteo es el TOTAL de la cadencia y los nombres se resumen cuando no caben.
    expect(source).toContain("`${entry.employeeCount} empleados con esa cadencia`");
    expect(source).toContain("`${entry.employeeNames.join(\", \")} y ${extra} más`");
    // Ningún `role=` escrito a mano en el aviso (movería el pin de feedback-batch2).
    const notice = source.indexOf('<Alert variant="warning" className="mt-3">');
    expect(source.slice(notice, notice + 220)).not.toMatch(/\brole\s*=/);
    // F10/G3b: con la fecha sin configurar, el aviso dice quién la configura
    // (la plataforma): el control ya no vive en esta pantalla.
    expect(source).toContain("La fecha de inicio de la nómina la configura la plataforma");
    expect(source).not.toContain('id="payroll-start-date"');
  });

  it("cada pendiente abre el diálogo con SU ciclo ya elegido (F10: no se elige nada más)", () => {
    expect(source).toContain("function openPendingSettlement(entry: PendingPayrollSettlement) {");
    expect(source).toContain("setOpenTarget(entry);");
    expect(source).toContain("onClick={() => openPendingSettlement(entry)}");
    // El botón "Abrir período" nace en el más atrasado (la lista ya viene
    // ordenada así; `null` cuando no hay ninguno: el diálogo lo dice).
    expect(source).toContain("setOpenTarget(pendingSettlements[0] ?? null);");
    // El estado viejo del selector (cadencia + ciclo + ancla) YA NO EXISTE: si
    // volviera, volvería la elección arbitraria que F10 quitó.
    expect(source).not.toContain("setOpenFrequency(");
    expect(source).not.toContain("setOpenCycleEnd(");
    expect(source).not.toContain("setPinnedCycle(");
    expect(source).not.toContain("pinnedCycle");
  });

  it("el aviso y el diálogo comparten la MISMA regla de liquidación y de fecha", () => {
    // La regla de "ya liquidado" sigue siendo la misma del aviso, pero ahora
    // decide sobre el ciclo ELEGIDO (no sobre una opción de un selector).
    expect(source).toContain("isPayrollCycleSettled({");
    expect(source).toContain("frequency: openTarget.frequency,");
    expect(source).toContain("cycle: { start_date: startDate, end_date: endDate },");
    expect(source).not.toContain("frequency: openFrequency");
    // La marca del selector desapareció con el selector: no hay dos verdades
    // sobre el mismo ciclo (la del aviso y la de la opción).
    expect(source).not.toContain("cycleMarker");
    expect(source).not.toContain('? " — ya liquidado"');
    expect(source).not.toContain(': " — por liquidar"');
  });

  it("control negativo: con el marcado viejo la guarda no pasa", () => {
    // El selector VIEJO (sin marca) y el aviso inexistente: ninguna de las señales
    // que la guarda busca está ahí.
    const viejo = [
      '<select id="payroll-open-cycle">',
      '  {openCycleOptions.map((option) => (',
      '    <option key={option.end_date} value={option.end_date}>{option.label}</option>',
      '  ))}',
      "</select>",
      "{props.canAdmin && (",
      "  <p>Períodos</p>",
      ")}",
    ].join("\n");
    expect(viejo.includes("cycleMarker")).toBe(false);
    expect(viejo.includes("pendingPayrollSettlements")).toBe(false);
    expect(viejo.includes("Hay ciclos ya cerrados sin liquidar.")).toBe(false);
    expect(viejo).not.toMatch(/onClick=\{\(\) => openPendingSettlement\(entry\)\}/);
    expect(viejo).not.toContain('? " — por liquidar"');
    // El detector de la copia no es un sello de goma: la cadena que la guarda
    // exige no aparece en el marcado viejo, y sí en el actual.
    expect(
      "return `Falta liquidar el ciclo ${entry.frequency} ${entry.label} (${employees}: ${who}).`;",
    ).not.toBe(viejo);
    expect(source).not.toContain("<p>Períodos</p>");
  });
});

/* ==========================================================================
   F10: la fecha de arranque de la nómina de la sede (migración 068).

   El sistema conoce DESDE CUÁNDO opera la nómina —«la fecha de inicio de la
   implementación»— y nada anterior existe para él: el aviso de pendientes no
   ofrece ciclos anteriores, la apertura no los acepta y el PRIMER ciclo de cada
   cadencia se recorta a la fecha y se prorroga con la regla de F5. Las dos
   superficies usan la MISMA regla (`isRangeBeforePayrollStart`) y el ÚNICO
   validador de la forma del rango (`resolveOpenPayrollRange`).
   ========================================================================== */
describe("payroll: la fecha de arranque de la nómina (F10, función pura)", () => {
  /** Jueves 2026-10-01: el ciclo semanal que lo contiene cierra el sábado 3. */
  const START = "2026-10-01";

  type Period = { start_date: string; end_date: string; frequency?: string | null };

  function resolve(
    frequency: "semanal" | "quincenal" | "mensual",
    cycleEndDate: string,
    payrollStartDate: string | null = START,
    periods: Period[] = [],
  ) {
    return resolveOpenPayrollRange({ frequency, cycleEndDate, payrollStartDate, periods });
  }

  it("acepta el ciclo COMPLETO cuando empieza en la fecha o después", () => {
    // El ciclo que EMPIEZA el mismo día del arranque ya es completo: la fecha es
    // su primer día, no un recorte.
    expect(resolve("semanal", "2026-10-03", "2026-09-27")).toEqual({
      ok: true,
      start_date: "2026-09-27",
      end_date: "2026-10-03",
      trimmed: false,
    });
    // Y un ciclo posterior también.
    expect(resolve("semanal", "2026-10-10")).toEqual({
      ok: true,
      start_date: "2026-10-04",
      end_date: "2026-10-10",
      trimmed: false,
    });
  });

  it("el PRIMER ciclo —el que CONTIENE la fecha— se recorta a la fecha, en las tres cadencias", () => {
    expect(resolve("semanal", "2026-10-03")).toEqual({
      ok: true,
      start_date: "2026-10-01",
      end_date: "2026-10-03",
      trimmed: true,
    });
    expect(resolve("quincenal", "2026-10-10")).toEqual({
      ok: true,
      start_date: "2026-10-01",
      end_date: "2026-10-10",
      trimmed: true,
    });
    expect(resolve("mensual", "2026-10-24")).toEqual({
      ok: true,
      start_date: "2026-10-01",
      end_date: "2026-10-24",
      trimmed: true,
    });
  });

  it("un ciclo que CIERRA antes de la fecha se rechaza; un cierre que no es sábado no es un ciclo", () => {
    // El ciclo semanal que cierra el 26 de septiembre terminó ANTES del arranque.
    expect(resolve("semanal", "2026-09-26")).toEqual({ ok: false, reason: "before-start" });
    expect(resolve("quincenal", "2026-09-26")).toEqual({ ok: false, reason: "before-start" });
    // El sábado del cierre es parte del ciclo; el domingo no es un cierre.
    expect(resolve("semanal", "2026-10-04")).toEqual({ ok: false, reason: "not-a-cycle" });
  });

  it("el recorte SÓLO vale como PRIMERO: con historia en la MISMA cadencia se rechaza", () => {
    const semanal: Period = { start_date: "2026-11-01", end_date: "2026-11-07", frequency: "semanal" };
    expect(resolve("semanal", "2026-10-03", START, [semanal])).toEqual({
      ok: false,
      reason: "not-first-cycle",
    });
    // La historia de OTRA cadencia no tacha el primer ciclo de ésta.
    expect(
      resolve("semanal", "2026-10-03", START, [{ ...semanal, frequency: "mensual" }]),
    ).toMatchObject({ ok: true, start_date: "2026-10-01", trimmed: true });
    // Un período HEREDADO sin cadencia tampoco es historia de la cadencia.
    expect(resolve("semanal", "2026-10-03", START, [{ ...semanal, frequency: null }])).toMatchObject(
      { ok: true, trimmed: true },
    );
    // Y un ciclo COMPLETO posterior sigue siendo válido con historia.
    expect(resolve("semanal", "2026-10-10", START, [semanal])).toMatchObject({
      ok: true,
      start_date: "2026-10-04",
      trimmed: false,
    });
  });

  it("sin fecha configurada no hay cota ni recorte: la forma de hoy", () => {
    const history: Period[] = [
      { start_date: "2026-01-01", end_date: "2026-01-14", frequency: "quincenal" },
    ];
    expect(resolve("quincenal", "2026-10-10", null, history)).toEqual({
      ok: true,
      start_date: "2026-09-27",
      end_date: "2026-10-10",
      trimmed: false,
    });
    // Un ciclo ANTERIOR a cualquier fecha imaginada se sigue aceptando: sin fecha
    // declarada, la cota es la historia de la sede (comportamiento de hoy).
    expect(resolve("semanal", "2026-09-26", null)).toMatchObject({ ok: true, trimmed: false });
    expect(
      resolveOpenPayrollRange({ frequency: "semanal", cycleEndDate: "2026-09-26", periods: [] }),
    ).toMatchObject({ ok: true, start_date: "2026-09-20", end_date: "2026-09-26" });
  });

  it("`isRangeBeforePayrollStart` compara por el ÚLTIMO día del rango", () => {
    expect(
      isRangeBeforePayrollStart({
        payrollStartDate: null,
        startDate: "2020-01-01",
        endDate: "2020-01-07",
      }),
    ).toBe(false);
    expect(
      isRangeBeforePayrollStart({
        payrollStartDate: START,
        startDate: "2026-09-20",
        endDate: "2026-09-26",
      }),
    ).toBe(true);
    // El día del arranque todavía es parte de la nómina: cierra ahí, no antes.
    expect(
      isRangeBeforePayrollStart({
        payrollStartDate: START,
        startDate: "2026-09-27",
        endDate: "2026-10-01",
      }),
    ).toBe(false);
    // Un rango que CONTIENE la fecha no es anterior: es el primero, y se recorta.
    expect(
      isRangeBeforePayrollStart({
        payrollStartDate: START,
        startDate: "2026-09-27",
        endDate: "2026-10-03",
      }),
    ).toBe(false);
    // Una fecha imposible no acota (mismo criterio que el resto del módulo).
    expect(
      isRangeBeforePayrollStart({
        payrollStartDate: "2026-02-30",
        startDate: "2026-01-01",
        endDate: "2026-01-07",
      }),
    ).toBe(false);
  });

  it("la prorrata de F5 paga el primer ciclo recortado, con los números del dueño", () => {
    // Quincenal, 1.500.000: el primer ciclo va del arranque al sábado del ciclo
    // (1–10 de octubre, 10 días) y paga 1.500.000 × 1/2 × 10/15 = 500.000. Esa
    // liquidación INCLUYE la primera semana (1–3 de octubre), que no se pagó
    // aparte; el ciclo quincenal siguiente es completo y paga 750.000.
    const first = resolveOpenPayrollRange({
      frequency: "quincenal",
      cycleEndDate: "2026-10-10",
      payrollStartDate: START,
      periods: [],
    });
    expect(first).toMatchObject({ ok: true, start_date: "2026-10-01", end_date: "2026-10-10", trimmed: true });
    if (!first.ok) throw new Error("el primer ciclo tenía que resolverse");
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "quincenal",
        periodFrequency: "quincenal",
        startDate: first.start_date,
        endDate: first.end_date,
      }),
    ).toEqual({ amount: 500_000, basis: "cadence", fraction: 1 / 2 });
    // El ciclo completo (el que la nómina hubiera pagado sin la fecha) son
    // 750.000: el recorte es su parte, no una cifra nueva.
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "quincenal",
        periodFrequency: "quincenal",
        startDate: "2026-09-27",
        endDate: "2026-10-10",
      }).amount,
    ).toBe(750_000);
    // El siguiente ciclo es COMPLETO: vuelve a la fracción entera.
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "quincenal",
        periodFrequency: "quincenal",
        startDate: "2026-10-11",
        endDate: "2026-10-24",
      }).amount,
    ).toBe(750_000);
    // Semanal: 1.500.000 × 1/4 × 3/7 = 160.714,29 → 160.714.
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "semanal",
        periodFrequency: "semanal",
        startDate: "2026-10-01",
        endDate: "2026-10-03",
      }).amount,
    ).toBe(160_714);
    // Mensual: 1.500.000 × 1 × 24/30 = 1.200.000.
    expect(
      resolveFixedSalaryForPeriod({
        salaryFixed: 1_500_000,
        employeeFrequency: "mensual",
        periodFrequency: "mensual",
        startDate: "2026-10-01",
        endDate: "2026-10-24",
      }).amount,
    ).toBe(1_200_000);
  });
});

describe("payroll: los ciclos pendientes con la fecha de arranque (F10, función pura)", () => {
  /** Domingo 2026-10-04: el último ciclo CERRADO es el sábado 2026-10-03. */
  const REFERENCE = "2026-10-04";
  const EMPLOYEE = { full_name: "Ana", pay_frequency: "semanal", is_active: true };

  function period(start: string, end: string, frequency: string | null = "semanal") {
    return { start_date: start, end_date: end, frequency };
  }

  it("un ciclo que cierra ANTES de la fecha no es pendiente; el que la contiene sale RECORTADO", () => {
    const periods = [period("2026-08-09", "2026-08-15")];
    // Sin fecha: la cota es la historia de la sede (el comportamiento de hoy) y
    // el ciclo del 20 al 26 de septiembre SÍ se reporta.
    const legacy = pendingPayrollSettlements({
      periods,
      employees: [EMPLOYEE],
      referenceDate: REFERENCE,
      limit: 20,
    }).map((row) => `${row.start_date}..${row.end_date}`);
    expect(legacy).toContain("2026-09-20..2026-09-26");
    // Con fecha (lunes 28 de septiembre): nada ANTERIOR a esa fecha, y el ciclo
    // que la contiene se reporta recortado — el rango que se va a abrir.
    const bounded = pendingPayrollSettlements({
      periods,
      employees: [EMPLOYEE],
      referenceDate: REFERENCE,
      limit: 20,
      payrollStartDate: "2026-09-28",
    });
    expect(bounded.map((row) => `${row.start_date}..${row.end_date}`)).toEqual([
      "2026-09-28..2026-10-03",
    ]);
    expect(bounded[0]).toMatchObject({ label: "28 sep – 3 oct 2026" });
  });

  it("con la fecha configurada y SIN períodos, el aviso reporta el primer ciclo", () => {
    // La sede nueva: todavía no liquidó nada. El primer ciclo es justamente lo
    // que falta, y la fecha de arranque es su piso.
    expect(
      pendingPayrollSettlements({
        periods: [],
        employees: [EMPLOYEE],
        referenceDate: REFERENCE,
        payrollStartDate: "2026-09-28",
      }),
    ).toEqual([
      {
        frequency: "semanal",
        start_date: "2026-09-28",
        end_date: "2026-10-03",
        label: "28 sep – 3 oct 2026",
        employeeCount: 1,
        employeeNames: ["Ana"],
      },
    ]);
    // Sin fecha no hay historia que reportar: el comportamiento de hoy no cambia.
    expect(
      pendingPayrollSettlements({ periods: [], employees: [EMPLOYEE], referenceDate: REFERENCE }),
    ).toEqual([]);
  });

  it("una fecha FUTURA no reporta nada hasta que cierre el ciclo que la contiene", () => {
    const quincenal = { full_name: "Ana", pay_frequency: "quincenal", is_active: true };
    // El lunes 5 de octubre cae en el ciclo quincenal que cierra el sábado 10. El
    // domingo 4, el último ciclo cerrado (el 3) es ANTERIOR a la fecha.
    expect(
      pendingPayrollSettlements({
        periods: [],
        employees: [quincenal],
        referenceDate: "2026-10-04",
        payrollStartDate: "2026-10-05",
      }),
    ).toEqual([]);
    // El domingo siguiente ese ciclo ya cerró: se reporta recortado a la fecha.
    expect(
      pendingPayrollSettlements({
        periods: [],
        employees: [quincenal],
        referenceDate: "2026-10-11",
        payrollStartDate: "2026-10-05",
      })[0],
    ).toMatchObject({
      start_date: "2026-10-05",
      end_date: "2026-10-10",
      label: "5 – 10 oct 2026",
    });
  });

  it("el aviso y el servicio dicen lo MISMO: cada entrada se resuelve al rango que reporta", () => {
    const startDate = "2026-08-10";
    const entries = pendingPayrollSettlements({
      periods: [],
      employees: [EMPLOYEE],
      referenceDate: REFERENCE,
      payrollStartDate: startDate,
      limit: 20,
    });
    // Ocho ciclos semanales: siete completos y el primero recortado al arranque.
    expect(entries).toHaveLength(8);
    expect(entries).toContainEqual(
      expect.objectContaining({ start_date: "2026-08-10", end_date: "2026-08-15" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ start_date: "2026-09-27", end_date: "2026-10-03" }),
    );
    for (const entry of entries) {
      expect(
        resolveOpenPayrollRange({
          frequency: entry.frequency,
          cycleEndDate: entry.end_date,
          payrollStartDate: startDate,
          periods: [],
        }),
        entry.label,
      ).toMatchObject({
        ok: true,
        start_date: entry.start_date,
        end_date: entry.end_date,
      });
    }
  });
});

describe("payroll: la fecha de arranque de la nómina de la sede (F10, servicio)", () => {
  const SEDE = payrollPagedStub.SEDE_ID;
  const ACTOR: PayrollActor = { userId: "u-1", sedeId: SEDE, roles: ["admin"] };

  function seed(args: { periods?: Array<Record<string, unknown>>; startDate?: string | null } = {}) {
    payrollPagedStub.tables = {
      sedes: [{ id: SEDE, name: "Sede principal", payroll_start_date: args.startDate ?? null }],
      payroll_periods: args.periods ?? [],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
  }

  function periodRow(
    id: string,
    start: string,
    end: string,
    frequency: string | null = "semanal",
  ) {
    return {
      id,
      sede_id: SEDE,
      start_date: start,
      end_date: end,
      frequency,
      status: "borrador",
      created_by: "u-1",
      closed_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
  }

  function employeeRow() {
    return {
      id: "emp-1",
      sede_id: SEDE,
      user_id: null,
      full_name: "Ana López",
      employee_code: "E-01",
      document: "1000",
      phone: null,
      position: null,
      payout_mode: "normal",
      email: null,
      birth_date: null,
      pay_type: "fijo",
      pay_frequency: "semanal",
      salary_fixed: 1500000,
      commission_percent: null,
      is_active: true,
    };
  }

  const periodInserts = () =>
    payrollPagedStub.inserts.filter((entry) => entry.table === "payroll_periods");

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  it("sin la migración 068 la lectura no configura y no se vuelve error interno", async () => {
    seed({ startDate: null });
    // 42703 = undefined_column: la columna todavía no existe en la base. La
    // degradación es de la LECTURA; la escritura ya no está en este módulo (la
    // resuelve la superficie de plataforma, que responde con su propio mensaje).
    payrollPagedStub.failOn = { table: "sedes", filter: "id", code: "42703" };
    expect(await getPayrollStartDate(SEDE)).toBeNull();
    // Con la columna presente, la lectura devuelve lo que la sede tenga: la
    // fecha es de la plataforma, pero el módulo la sigue leyendo.
    payrollPagedStub.failOn = null;
    seed({ startDate: "2026-10-05" });
    expect(await getPayrollStartDate(SEDE)).toBe("2026-10-05");
  });

  it("rechaza abrir un período anterior a la fecha, nombrando la fecha", async () => {
    seed({ startDate: "2026-10-01" });
    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-09-26" },
      ACTOR,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect((failure as PayrollError).message).toContain("2026-10-01");
    expect((failure as PayrollError).message).toContain("antes");
    // La guarda corre ANTES del INSERT: nada se escribió.
    expect(periodInserts()).toHaveLength(0);
  });

  it("el PRIMER ciclo de la cadencia se abre RECORTADO a la fecha", async () => {
    seed({ startDate: "2026-10-01" });
    const row = await openPayrollPeriod(
      { frequency: "quincenal", cycle_end_date: "2026-10-10" },
      ACTOR,
    );
    expect(row).toMatchObject({
      start_date: "2026-10-01",
      end_date: "2026-10-10",
      frequency: "quincenal",
      status: "borrador",
    });
    expect(periodInserts()).toHaveLength(1);
    expect(periodInserts()[0].payload).toMatchObject({
      start_date: "2026-10-01",
      end_date: "2026-10-10",
      frequency: "quincenal",
    });
  });

  it("un ciclo que necesitaría recorte cuando la cadencia ya tiene períodos se rechaza", async () => {
    // El ciclo del 27 sep al 3 oct contiene la fecha, pero la cadencia semanal
    // ya tiene su período: el recorte ya no sería «el primero».
    seed({
      startDate: "2026-10-01",
      periods: [periodRow("p-1", "2026-11-01", "2026-11-07")],
    });
    const failure: unknown = await openPayrollPeriod(
      { frequency: "semanal", cycle_end_date: "2026-10-03" },
      ACTOR,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "VALIDATION", status: 400 });
    expect((failure as PayrollError).message).toContain("2026-10-01");
    expect(periodInserts()).toHaveLength(0);
  });

  it("un ciclo COMPLETO sigue abriéndose en las tres cadencias con la fecha configurada", async () => {
    const cases = [
      { frequency: "semanal", cycle_end_date: "2026-10-10", start: "2026-10-04", end: "2026-10-10" },
      { frequency: "quincenal", cycle_end_date: "2026-10-10", start: "2026-09-27", end: "2026-10-10" },
      { frequency: "mensual", cycle_end_date: "2026-10-24", start: "2026-09-27", end: "2026-10-24" },
    ] as const;
    for (const item of cases) {
      seed({ startDate: "2026-09-01" });
      const row = await openPayrollPeriod(
        { frequency: item.frequency, cycle_end_date: item.cycle_end_date },
        ACTOR,
      );
      expect(row, item.frequency).toMatchObject({
        start_date: item.start,
        end_date: item.end,
        frequency: item.frequency,
      });
    }
  });

  it("sin fecha (o sin la columna) se conserva el comportamiento de hoy", async () => {
    // Ni siquiera hay fila de sede: la lectura devuelve null y el período se abre
    // como siempre (la cota sigue siendo la historia de la sede).
    payrollPagedStub.tables = {
      payroll_periods: [],
      invoices: [],
      invoice_items: [],
      commission_rules: [],
      voucher_requests: [],
      commission_payouts: [],
      payroll_items: [],
      payroll_payments: [],
      audit_logs: [],
    };
    expect(await getPayrollStartDate(SEDE)).toBeNull();
    expect(
      await openPayrollPeriod({ frequency: "semanal", cycle_end_date: "2026-09-05" }, ACTOR),
    ).toMatchObject({ start_date: "2026-08-30", end_date: "2026-09-05" });
    // Con la fecha en NULL tampoco hay cota: un ciclo muy anterior se abre igual.
    seed({ startDate: null });
    expect(
      await openPayrollPeriod({ frequency: "semanal", cycle_end_date: "2026-09-05" }, ACTOR),
    ).toMatchObject({ start_date: "2026-08-30", end_date: "2026-09-05" });
  });

  it("el resumen de la sede acota el aviso y reporta el primer ciclo de una sede sin historia", async () => {
    // Reloj congelado en el domingo 2026-10-04 (Bogotá), la misma convención de
    // las pruebas de F9: el último ciclo cerrado es el sábado 2026-10-03.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T15:00:00.000Z"));
    try {
      seed({ startDate: "2026-09-28" });
      payrollPagedStub.tables.employees = [employeeRow()];
      const overview = await listPayrollOverview(SEDE);
      expect(overview.pendingSettlements).toEqual([
        {
          frequency: "semanal",
          start_date: "2026-09-28",
          end_date: "2026-10-03",
          label: "28 sep – 3 oct 2026",
          employeeCount: 1,
          employeeNames: ["Ana López"],
        },
      ]);
      // Sin fecha configurada, la MISMA sede sin períodos no reporta nada.
      seed({ startDate: null });
      payrollPagedStub.tables.employees = [employeeRow()];
      const legacy = await listPayrollOverview(SEDE);
      expect(legacy.pendingSettlements).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("la LECTURA va a la columna de la 068 y la escritura NO quedó en este módulo (guarda de fuente)", () => {
    const service = readFileSync(
      join(process.cwd(), "src", "features", "payroll", "service.ts"),
      "utf8",
    );
    expect(service).toContain('.from("sedes")');
    expect(service).toContain('.select("id, payroll_start_date")');
    // G3b: la escritura de la fecha es de la plataforma. Si volviera a haber un
    // `UPDATE` de la columna acá, el módulo tendría una segunda puerta para
    // cambiar de qué fecha arranca la nómina de la sede.
    expect(service).not.toContain("setPayrollStartDate");
    expect(service).not.toMatch(/update\(\{\s*payroll_start_date/);
  });
});

describe("payroll: la fecha de arranque de la nómina (F10/G3b): la escritura salió a la plataforma", () => {
  const SEDE = payrollPagedStub.SEDE_ID;

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  function seedSede(startDate: string | null = null) {
    payrollPagedStub.tables = {
      sedes: [{ id: SEDE, name: "Sede principal", payroll_start_date: startDate }],
    };
  }

  it("nómina ya no expone la escritura: la action no existe y la pantalla no la pide", () => {
    const actions = readFileSync(
      join(process.cwd(), "src", "features", "payroll", "actions.ts"),
      "utf8",
    );
    const client = readFileSync(
      join(process.cwd(), "app", "payroll", "payroll-client.tsx"),
      "utf8",
    );
    const schemas = readFileSync(
      join(process.cwd(), "src", "features", "payroll", "schemas.ts"),
      "utf8",
    );
    // Control positivo: el módulo sigue exportando la LECTURA.
    expect(actions).toContain("export async function getPayrollStartDateAction");
    // G3b: la ESCRITURA salió. Ni la action, ni el formulario, ni su campo.
    expect(actions).not.toContain("setPayrollStartDateAction");
    expect(client).not.toContain("setPayrollStartDateAction");
    expect(client).not.toContain('id="payroll-start-date"');
    // Y el CUERPO de la escritura se fue con ella: un validador sin puerta que
    // lo use es la forma que esta guarda quiere impedir.
    expect(schemas).not.toContain("setPayrollStartDateSchema");
    expect(schemas).not.toContain("SetPayrollStartDateInput");
    // Control positivo del símbolo que la plataforma SÍ valida: `payrollStart-
    // DateSchema` es otro símbolo (el que usa `setPlatformPayrollStartDate`) y
    // quitarlo rompería la escritura que acaba de mudarse.
    expect(schemas).toContain("export const payrollStartDateSchema");
    // La forma del módulo: una acción borrada no puede quedar accesible.
    expect(payrollActions).not.toHaveProperty("setPayrollStartDateAction");
  });

  it("un admin de sede ya no puede cambiarla por nómina y NADA se escribe", async () => {
    seedSede("2026-01-01");
    payrollPagedStub.session = { userId: "u-admin", sedeId: SEDE, roles: ["admin"] };
    // No hay action de escritura que invocar: el módulo de nómina no la expone.
    expect(payrollActions).not.toHaveProperty("setPayrollStartDateAction");
    // Y la fecha sigue siendo la que dejó la plataforma: nadie la tocó.
    expect(await getPayrollStartDate(SEDE)).toBe("2026-01-01");
  });

  it("la LECTURA sigue alimentando el aviso y el diálogo (la conserva nómina)", async () => {
    seedSede("2026-10-05");
    // El admin la lee: es la cota que usan el aviso de pendientes y el diálogo.
    payrollPagedStub.session = { userId: "u-admin", sedeId: SEDE, roles: ["admin"] };
    expect(await getPayrollStartDateAction()).toEqual({ success: true, data: "2026-10-05" });
    // La caja abre vales, no lee la configuración de nómina.
    payrollPagedStub.session = { userId: "u-caja", sedeId: SEDE, roles: ["caja"] };
    expect(await getPayrollStartDateAction()).toMatchObject({ success: false, code: "FORBIDDEN" });
    // Y el empleado tampoco la lee: es configuración de la sede.
    payrollPagedStub.session = { userId: "u-emp", sedeId: SEDE, roles: ["empleado"] };
    expect(await getPayrollStartDateAction()).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("la página la lee con el servicio y la pasa como valor inicial (SSR)", () => {
    const page = readFileSync(join(process.cwd(), "app", "payroll", "page.tsx"), "utf8");
    // Sólo el admin: al empleado se le manda su recibo, no la configuración de
    // la sede (la action de lectura también rechaza a cualquier otro rol).
    expect(page).toContain("canAdmin ? getPayrollStartDate(sedeId) : null");
    expect(page).toContain("initialPayrollStartDate={payrollStartDate ?? null}");
    // Control negativo: la lectura NO se hizo para todos los roles.
    expect(page).not.toContain("getPayrollStartDate(sedeId),\n  ]);");
  });
});

describe("migración 068_payroll_start_date.sql (F10)", () => {
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "068_payroll_start_date.sql"),
      "utf8",
    );
    return {
      raw,
      sql: raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    };
  };

  it("agrega la columna con su COMMENT y explica qué significa NULL", () => {
    const { raw, sql } = migration();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS payroll_start_date date NULL");
    expect(raw).toContain("COMMENT ON COLUMN public.sedes.payroll_start_date IS");
    expect(raw).toContain("NULL = todavía NO configurada");
    expect(raw).toContain("Nada ANTERIOR a esta fecha existe para el sistema");
    // La numeración estaba libre y el archivo la justifica.
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("es idempotente, no migra datos y no inventa una fecha", () => {
    const { sql } = migration();
    expect(sql.match(/ALTER TABLE public\.sedes/g)).toHaveLength(1);
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/NOT NULL/);
    // Sin DEFAULT: ninguna sede queda con una fecha que el dueño no eligió.
    expect(sql).not.toMatch(/DEFAULT/i);
  });
});

// ---------------------------------------------------------------------------
// 071_rpc_single_sede.sql: la nómina re-emite sus dos funciones de administración
// SIN el parámetro de sede.
//
// LO QUE ESTA SUITE FIJA (y antes fijaba mal): 048 declaraba las dos funciones
// con `p_sede_id` al principio de la firma y filtraba por `sede_id` en el
// período, en los vales y en el empleado. Con la instalación de una sola sede,
// ese parámetro es una segunda frontera dentro de una base que ya tiene una, y
// la firma que declara la base tiene que ser EXACTAMENTE la que manda el
// servidor: si queda un `p_sede_id` de más, el llamador nuevo falla ruidoso; si
// queda una sobrecarga viva de la vieja, el llamador viejo sigue pasando sin
// que nadie lo note. Por eso el archivo dropea la firma vieja ANTES de crear la
// nueva.
// ---------------------------------------------------------------------------

describe("migración 071_rpc_single_sede.sql (nómina)", () => {
  const path = join(process.cwd(), "supabase", "migrations", "071_rpc_single_sede.sql");
  const raw = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("las DOS funciones de administración se crean SIN el parámetro de sede", () => {
    // La firma es lo que se afirma: `p_period_id` al principio y NADA de sede.
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.payroll_delete_period_atomic\(\s*p_period_id uuid,\s*p_to_approved uuid\[\],\s*p_to_pending uuid\[\]\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.payroll_correct_period_atomic\(\s*p_period_id uuid,\s*p_correction jsonb,\s*p_items jsonb\s*\)/,
    );
    // Y el predicado de sede NO está: si volviera, la firma y el cuerpo
    // dejarían de contar la misma historia.
    expect(sql).not.toMatch(/payroll_(?:delete|correct)_period_atomic\(\s*p_sede_id/);
    expect(sql).not.toContain("p_sede_id IS NULL");
    expect(sql).not.toMatch(/\bsede_id\s*=\s*p_sede_id/);
    expect(sql).not.toContain("p_sede_id");
  });

  it("dropea la firma VIEJA antes de crear la nueva: sin la sobrecarga no hay dos funciones", () => {
    // El orden importa: un `CREATE OR REPLACE` con otra lista de parámetros no
    // reemplaza nada, deja la vieja viva al lado de la nueva.
    const dropDelete = sql.indexOf(
      "DROP FUNCTION IF EXISTS public.payroll_delete_period_atomic(uuid, uuid, uuid[], uuid[])",
    );
    const dropCorrect = sql.indexOf(
      "DROP FUNCTION IF EXISTS public.payroll_correct_period_atomic(uuid, uuid, jsonb, jsonb)",
    );
    const createDelete = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.payroll_delete_period_atomic",
    );
    const createCorrect = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.payroll_correct_period_atomic",
    );
    expect(dropDelete).toBeGreaterThan(-1);
    expect(dropCorrect).toBeGreaterThan(-1);
    expect(dropDelete).toBeLessThan(createDelete);
    expect(dropCorrect).toBeLessThan(createCorrect);
  });

  it("el permiso y el search_path viajan con la firma NUEVA, y el comentario también", () => {
    for (const signature of [
      "payroll_delete_period_atomic(uuid, uuid[], uuid[])",
      "payroll_correct_period_atomic(uuid, jsonb, jsonb)",
    ]) {
      const name = signature.slice(0, signature.indexOf("("));
      // Un ACL sobre la firma vieja no alcanzaría a la función nueva: el
      // permiso se concede por firma y por eso tiene que repetirse.
      expect(sql).toContain(`ALTER FUNCTION public.${signature} SET search_path = public;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon;`);
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${signature} FROM authenticated;`,
      );
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
      // Y cada una conserva SUS redes de conteo, DICHA en su propio comentario:
      // el cambio es de firma, no de comportamiento. El texto del COMMENT viaja
      // como string en la línea siguiente, así que se lee con la suya.
      const commentLines = sql.split("\n");
      const commentAt = commentLines.findIndex((line) =>
        line.startsWith(`COMMENT ON FUNCTION public.${name}(`),
      );
      const comment = commentLines.slice(commentAt, commentAt + 2).join("\n");
      expect(commentAt).toBeGreaterThan(-1);
      expect(comment).toContain("CL-9:");
      if (name === "payroll_delete_period_atomic") {
        expect(comment).toContain("PAYROLL_VOUCHER_CONFLICT");
        expect(comment).toContain("PAYROLL_PERIOD_CONFLICT");
        expect(comment).toContain("PERIOD_OVERLAP_AMBIGUOUS");
      } else {
        expect(comment).toContain("PAYROLL_CORRECTION_MISMATCH");
        expect(comment).toContain("PERIOD_NOT_CLOSED");
      }
    }
  });

  it("NO borra la columna ni toca las políticas: ése es el paso irreversible de otra unidad", () => {
    // El archivo va ANTES del borrado a propósito: mientras la columna existe,
    // quitarle el parámetro deja honestos los puntos de llamada, y el
    // `DROP COLUMN` queda como el último paso, sin vuelta atrás.
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/\bPOLICY\b/i);
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    // Y lo dice, para que el orden de la serie no dependa de la memoria.
    expect(raw).toContain("POR QUÉ ESTE ARCHIVO CORRE ANTES DEL BORRADO DE LA COLUMNA");
    expect(raw).toContain("resolveSede");
  });

  it("no toca la cadena de la LIQUIDACIÓN: payroll_apply_atomic nunca llevaba p_sede_id", () => {
    // `payroll_apply_atomic` (047, y sus versiones de 061/062/064/067) toma la
    // sede del PERÍODO que bloquea: no hay parámetro que quitarle y este
    // archivo no lo re-emite.
    expect(sql).not.toContain("payroll_apply_atomic");
  });
});

// ===================================================================== ===
// M3b: el consecutivo y los topes de vales son AJUSTES DE LA INSTALACIÓN
// (072_system_settings.sql)
// ========================================================================
//
// Con la instalación de una sola sede, `invoice_sequences` y `voucher_settings`
// se quedan sin clave natural (su clave primaria era `sede_id`) y el dueño
// decidió reemplazarlas por UNA tabla de `clave`/`valor`:
// `public.system_settings`.
//
// Lo que se prueba acá, en dos niveles:
//
//   * COMPORTAMIENTO, contra el doble de la base: el contador avanza de a uno y
//     no devuelve un número repetido —la fila que se bloquea es la fila de la
//     clave— y los topes se leen y se escriben por sus cuatro claves, con el
//     valor por omisión del módulo cuando una clave no está.
//   * ARTEFACTO, contra el texto de la migración: que la tabla sea la que se
//     documentó, que el movimiento de datos sea idempotente y que el archivo NO
//     borre todavía las dos tablas viejas (el borrado es de la unidad que quita
//     `sede_id`).
//
// El doble del contador NO recibe del test si la fila se bloquea: lo lee del
// archivo desplegado (como `payrollCapLocksParent` con el tope de nómina), así
// que quitarle el `FOR UPDATE` a la 072 hace caer estas pruebas por sí solas.

/** El texto de la 072, sin prosa: la detección mira sentencias y nombres. */
const M3B_MIGRATION = "072_system_settings.sql";

describe("M3b: los ajustes de la instalación viven en system_settings (072)", () => {
  const ACTOR: PayrollActor = {
    userId: "u-1",
    sedeId: payrollPagedStub.SEDE_ID,
    roles: ["admin"],
  };
  const raw072 = (): string => readFileSync(join(MIGRATIONS_DIR, M3B_MIGRATION), "utf8");
  const sql072 = (): string =>
    raw072()
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
  /** Las filas de `system_settings` que quedaron escritas, por clave. */
  const settingRows = (): Array<Record<string, unknown>> =>
    payrollPagedStub.tables.system_settings ?? [];
  const settingValue = (key: string): unknown =>
    settingRows().find((row) => row.key === key)?.value;

  beforeEach(() => resetPayrollStubState());
  afterEach(() => resetPayrollStubState());

  describe("el consecutivo: la fila de la clave es la que se bloquea", () => {
    it("avanza de a uno desde el valor que quedó migrado, y la fila lo acumula", () => {
      // Lo que deja la migración cuando `invoice_sequences` tenía 41 emitidos.
      payrollPagedStub.tables.system_settings = [
        { key: "invoice_sequence", value: { last_number: 41 }, updated_at: "2026-01-31T00:00:00.000Z" },
      ];

      const emitidos = [
        reserveInvoiceSequence(),
        reserveInvoiceSequence(),
        reserveInvoiceSequence(),
      ];

      expect(emitidos).toEqual([42, 43, 44]);
      // Y el sobre de la fila es el contador: no queda en 41 (el de la tabla
      // vieja) ni en un número de más.
      expect(settingValue("invoice_sequence")).toEqual({ last_number: 44 });
      expect(storedInvoiceSequence()).toBe(44);
    });

    it("sin fila previa, la crea y el primer número es el 1", () => {
      // El `INSERT … ON CONFLICT DO NOTHING` de la función: una instalación que
      // nunca emitió no tiene fila, y eso no es un error.
      expect(settingRows()).toEqual([]);

      expect(reserveInvoiceSequence()).toBe(1);
      expect(reserveInvoiceSequence()).toBe(2);
      expect(settingValue("invoice_sequence")).toEqual({ last_number: 2 });
    });

    it("la fila del contador no tiene forma de sede (la instalación es de una)", () => {
      reserveInvoiceSequence();
      reserveInvoiceSequence();

      const fila = settingRows().find((row) => row.key === "invoice_sequence")!;
      expect(Object.keys(fila).sort()).toEqual(["key", "updated_at", "value"]);
      expect(fila).not.toHaveProperty("sede_id");
      expect(fila).not.toHaveProperty("last_number");
    });

    it("DOS emisores concurrentes NO se llevan el mismo número: el lock es lo que lo evita", () => {
      // La otra transacción reservó y CONFIRMÓ su número mientras ésta esperaba
      // en el lock de la fila.
      expect(reserveInvoiceSequence()).toBe(1);
      expect(storedInvoiceSequence()).toBe(1);

      const emitido = reserveInvoiceSequence({ before: 1, emitted: 2 });

      // Con el `FOR UPDATE` desplegado, esta lectura vio el 2 que dejó la otra y
      // se llevó el 3. Sin ver la fila rival habría emitido el 2 también: el
      // duplicado que la serie no puede tener (FAC-05).
      expect(emitido).toBe(3);
      expect(storedInvoiceSequence()).toBe(3);
      expect(payrollPagedStub.sequenceChecks.at(-1)).toEqual({ sawRival: true, emitida: 3 });
    });

    it("control negativo del guardián: SIN el FOR UPDATE desplegado el doble repite el número", () => {
      // El mismo escenario con el lock apagado, para probar que la prueba
      // anterior no es vacuidad: sin bloquear la fila, el emisor que llegó
      // segundo lee una foto anterior al commit rival y devuelve el MISMO
      // número (y el contador tampoco avanza: su escritura se pierde).
      payrollPagedStub.sequenceLockOverride = false;
      reserveInvoiceSequence();
      const emitido = reserveInvoiceSequence({ before: 1, emitted: 2 });

      expect(emitido).toBe(2);
      expect(storedInvoiceSequence()).toBe(2);
      expect(payrollPagedStub.sequenceChecks.at(-1)).toEqual({ sawRival: false, emitida: 2 });
    });

    it("el lock y la firma salen del ARTEFACTO, no de una bandera del test", () => {
      // La firma NO cambia: es la de 005, con la sede como parámetro, y el
      // parámetro deja de seleccionar la fila (su retiro es de la unidad que
      // borra `sede_id`).
      const body = deployedNextInvoiceNumberBody();
      expect(body).toContain("CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)");
      expect(body).toContain("FOR UPDATE");
      expect(body).not.toContain("invoice_sequences");
      // La fila que se bloquea es la clave del contador, y el incremento ocurre
      // en la misma función (o sea, dentro de la transacción del llamador).
      expect(body).toContain("'invoice_sequence'");
      expect(body).toContain("jsonb_set(value, '{last_number}'");
      // Y el parámetro sigue declarado aunque el cuerpo no lo use.
      expect(body).toContain("p_sede_id uuid");
    });
  });

  describe("los topes se leen y se escriben por sus cuatro claves", () => {
    it("cada ajuste se lee de SU fila, con el sobre que su clave declara", async () => {
      payrollPagedStub.tables.system_settings = [
        { key: "voucher_max_per_day", value: { amount: 200000 } },
        { key: "voucher_max_per_week", value: { amount: 400000 } },
        { key: "voucher_per_day_limits", value: { limits: { "3": 50000 } } },
        { key: "voucher_allowed_days", value: { days: [1, 2, 3, 4, 5] } },
      ];

      const settings = await getVoucherSettings();

      expect(settings).toEqual({
        max_per_day: 200000,
        max_per_week: 400000,
        per_day_limits: { "3": 50000 },
        allowed_days: [1, 2, 3, 4, 5],
      });
      // Una sola lectura, y de la tabla nueva.
      expect(payrollPagedStub.windows.filter((w) => w.table === "system_settings")).toHaveLength(1);
      expect(payrollPagedStub.inFilters).toContainEqual({
        table: "system_settings",
        column: "key",
        count: 4,
      });
    });

    it("una clave ausente se lee con el valor por omisión del módulo, no con un error", async () => {
      // Sólo existe el tope diario: los otros tres ajustes son los de omisión
      // (sin tope, sin topes por día, todos los días).
      payrollPagedStub.tables.system_settings = [
        { key: "voucher_max_per_day", value: { amount: 200000 } },
      ];

      const settings = await getVoucherSettings();

      expect(settings).toEqual({
        max_per_day: 200000,
        max_per_week: null,
        per_day_limits: null,
        allowed_days: null,
      });
      // Días `null` = TODOS: pedir un vale un domingo no exige revisión, igual
      // que cuando `allowed_days` venía nulo.
      expect(isVoucherDayAllowed("2026-01-18", settings.allowed_days)).toBe(true);
    });

    it("una tabla VACÍA da los cuatro valores por omisión: es la instalación sin configurar", async () => {
      const settings = await getVoucherSettings();

      expect(settings).toEqual({
        max_per_day: null,
        max_per_week: null,
        per_day_limits: null,
        allowed_days: null,
      });
      // Sin topes, ningún vale exige aprobación por monto.
      expect(
        requiresVoucherApproval(
          checkVoucherCaps({
            dayTotal: 9_000_000,
            weekTotal: 9_000_000,
            requested: 1_000_000,
            maxPerDay: settings.max_per_day,
            maxPerWeek: settings.max_per_week,
          }),
        ),
      ).toBe(false);
    });

    it("un sobre que no es el declarado se lee con el valor por omisión (no rompe la pantalla)", async () => {
      payrollPagedStub.tables.system_settings = [
        { key: "voucher_max_per_day", value: { monto: 200000 } },
        { key: "voucher_max_per_week", value: "no-sobre" },
        { key: "voucher_per_day_limits", value: { limits: { "0": 1, "9": 2, x: 3 } } },
        { key: "voucher_allowed_days", value: { days: "lunes" } },
      ];

      const settings = await getVoucherSettings();

      expect(settings.max_per_day).toBeNull();
      expect(settings.max_per_week).toBeNull();
      expect(settings.per_day_limits).toBeNull();
      expect(settings.allowed_days).toBeNull();
    });

    it("guardar topes escribe UNA fila por clave, con el destino de conflicto `key`", async () => {
      payrollPagedStub.tables.system_settings = voucherSettingRows({
        max_per_day: 200000,
        allowed_days: [1, 2, 3, 4, 5],
      });

      const guardado = await setVoucherLimits(
        {
          max_per_day: 50000,
          max_per_week: 0,
          per_day_limits: [{ day: 3, amount: 50000 }],
        },
        ACTOR,
      );

      // Las cuatro claves siguen existiendo (una fila por ajuste) y cada una con
      // el sobre de su ajuste.
      expect(settingRows().map((row) => row.key)).toEqual([
        "voucher_max_per_day",
        "voucher_max_per_week",
        "voucher_per_day_limits",
        "voucher_allowed_days",
      ]);
      expect(settingValue("voucher_max_per_day")).toEqual({ amount: 50000 });
      // 0 = sin tope, y se guarda como null (026): es lo que ya hacía el
      // servicio antes de escribir la fila de la sede.
      expect(settingValue("voucher_max_per_week")).toEqual({ amount: null });
      expect(settingValue("voucher_per_day_limits")).toEqual({ limits: { "3": 50000 } });
      // Sin días en el POST se conserva la configuración vigente: la clave que
      // no se manda no se toca (era el upsert de la fila única).
      expect(settingValue("voucher_allowed_days")).toEqual({ days: [1, 2, 3, 4, 5] });
      // Y lo que devuelve es lo que la base confirmó, leído por las mismas
      // funciones puras que arman el sobre.
      expect(guardado).toEqual({
        max_per_day: 50000,
        max_per_week: null,
        per_day_limits: { "3": 50000 },
        allowed_days: [1, 2, 3, 4, 5],
      });
    });

    it("guardar sin nada configurado escribe los valores por omisión, no deja claves ausentes", async () => {
      payrollPagedStub.tables.system_settings = [];

      const guardado = await setVoucherLimits({ max_per_day: 0, max_per_week: 0 }, ACTOR);

      expect(settingValue("voucher_max_per_day")).toEqual({ amount: null });
      expect(settingValue("voucher_max_per_week")).toEqual({ amount: null });
      expect(settingValue("voucher_per_day_limits")).toEqual({ limits: null });
      // Los días que no se eligen se escriben como los siete: es el valor por
      // omisión de 024 y lo que escribía la columna cuando venían nulos.
      expect(settingValue("voucher_allowed_days")).toEqual({ days: [1, 2, 3, 4, 5, 6, 7] });
      expect(guardado.allowed_days).toEqual([1, 2, 3, 4, 5, 6, 7]);
      // Y el valor nuevo se lee igual por la puerta de lectura.
      expect(await getVoucherSettings()).toEqual(guardado);
    });

    it("guardar dos veces REEMPLAZA la fila de la clave, no la duplica", async () => {
      payrollPagedStub.tables.system_settings = voucherSettingRows({ max_per_day: 200000 });

      await setVoucherLimits({ max_per_day: 50000 }, ACTOR);
      await setVoucherLimits({ max_per_day: 90000 }, ACTOR);

      const filasTope = settingRows().filter((row) => row.key === "voucher_max_per_day");
      expect(filasTope).toHaveLength(1);
      expect(filasTope[0].value).toEqual({ amount: 90000 });
      expect((await getVoucherSettings()).max_per_day).toBe(90000);
    });

    it("guardar topes deja AUDITORÍA con el actor y los dos valores (el anterior y el nuevo)", async () => {
      // Los topes deciden qué vale sale solo de caja y cuál espera aprobación:
      // cambiarlos con la pantalla abierta es una decisión que tiene que quedar
      // escrita, y hasta ahora no dejaba ninguna.
      payrollPagedStub.tables.system_settings = voucherSettingRows({
        max_per_day: 200000,
        max_per_week: 400000,
        per_day_limits: { "3": 50000 },
        allowed_days: [1, 2, 3, 4, 5],
      });

      await setVoucherLimits({ max_per_day: 50000, allowed_days: [1, 3] }, ACTOR);

      const audit = payrollPagedStub.inserts.find((entry) => entry.table === "audit_logs");
      expect(audit?.payload).toMatchObject({
        action: "voucher.limits_set",
        entity: "system_settings",
        // La escritura toca las CUATRO claves: lo que hace ubicable el cambio
        // en la historia de la sede es la SEDE nombrada, y lo hace `entity_id`,
        // no una clave del módulo.
        entity_id: ACTOR.sedeId,
        user_id: ACTOR.userId,
        metadata: {
          previous_max_per_day: 200000,
          new_max_per_day: 50000,
          // Lo que NO se manda conserva lo vigente, y eso es lo que la escritura
          // dejó y lo que un auditor tiene que poder leer.
          previous_max_per_week: 400000,
          new_max_per_week: 400000,
          previous_per_day_limits: { "3": 50000 },
          new_per_day_limits: { "3": 50000 },
          previous_allowed_days: [1, 2, 3, 4, 5],
          new_allowed_days: [1, 3],
        },
      });
      expect(audit?.payload).not.toHaveProperty("sede_id");
      // Y lo que la auditoría llama «nuevo» es lo que quedó ESCRITO de verdad:
      // el tope que se pidió, la semana que no se tocó conservada y los días
      // elegidos, leídos otra vez por la puerta de lectura. Sin esto, un
      // `new_*` inventado por el servicio pasaría la aserción de arriba.
      expect(settingValue("voucher_max_per_day")).toEqual({ amount: 50000 });
      expect(settingValue("voucher_max_per_week")).toEqual({ amount: 400000 });
      expect(settingValue("voucher_per_day_limits")).toEqual({ limits: { "3": 50000 } });
      expect(settingValue("voucher_allowed_days")).toEqual({ days: [1, 3] });
      expect(await getVoucherSettings()).toEqual({
        max_per_day: 50000,
        max_per_week: 400000,
        per_day_limits: { "3": 50000 },
        allowed_days: [1, 3],
      });
    });

    it("configurar por primera vez audit con el anterior en los DEFAULT del módulo", async () => {
      // Una instalación que nunca configuró topes: lo anterior NO es «cero» ni
      // una cadena vacía, es el valor por omisión del módulo (sin tope, todos
      // los días), que es como se leía antes de que existiera la fila.
      payrollPagedStub.tables.system_settings = [];

      await setVoucherLimits({ max_per_day: 50000 }, ACTOR);

      const audit = payrollPagedStub.inserts.find((entry) => entry.table === "audit_logs");
      expect(audit?.payload).toMatchObject({
        action: "voucher.limits_set",
        user_id: ACTOR.userId,
        metadata: {
          previous_max_per_day: null,
          new_max_per_day: 50000,
          previous_max_per_week: null,
          new_max_per_week: null,
          previous_per_day_limits: null,
          new_per_day_limits: null,
          previous_allowed_days: null,
          // Sin días elegidos se escriben los siete: es lo que quedó valiendo.
          new_allowed_days: [1, 2, 3, 4, 5, 6, 7],
        },
      });
    });

    it("un guardado RECHAZADO no deja auditoría: no se registró un cambio que no ocurrió", async () => {
      payrollPagedStub.tables.system_settings = voucherSettingRows({ max_per_day: 200000 });
      payrollPagedStub.insertError = { table: "system_settings", message: "boom" };

      const failure: unknown = await setVoucherLimits({ max_per_day: 50000 }, ACTOR).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(PayrollError);
      expect(payrollPagedStub.inserts.filter((entry) => entry.table === "audit_logs")).toHaveLength(0);
    });

    it("la acción sale del vocabulario cerrado y NO entra a ningún catálogo de alertas", () => {
      expect(AUDIT_ACTIONS.VOUCHER_LIMITS_SET).toBe("voucher.limits_set");
      // No es ninguna de las tres acciones del ciclo de un vale
      // (pedido/aprobado/rechazado), que es lo que la bandeja de alertas mira:
      // cambiar la política es configuración, no un desvío que alguien deba
      // autorizar o rechazar.
      expect(AUDIT_ACTIONS.VOUCHER_LIMITS_SET).not.toBe(AUDIT_ACTIONS.VOUCHER_REQUESTED);
      expect(AUDIT_ACTIONS.VOUCHER_LIMITS_SET).not.toBe(AUDIT_ACTIONS.VOUCHER_APPROVED);
      expect(AUDIT_ACTIONS.VOUCHER_LIMITS_SET).not.toBe(AUDIT_ACTIONS.VOUCHER_REJECTED);
      // Y el catálogo de la bandeja se lee de la fuente REAL del módulo de
      // alertas (es una lista literal, no algo que este archivo controle), con
      // el control de que sí filtra la alerta de vale: si el catálogo saliera
      // vacío, la ausencia de más abajo no probaría nada.
      const alertas = readFileSync(join(process.cwd(), "src/features/alerts/schemas.ts"), "utf8");
      const catalogo = /export const ALERT_ACTIONS = \[([\s\S]*?)\] as const;/.exec(alertas)?.[1] ?? "";
      const alertados = [...catalogo.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      expect(alertados).toContain(AUDIT_ACTIONS.VOUCHER_REQUESTED);
      expect(alertados).not.toContain(AUDIT_ACTIONS.VOUCHER_LIMITS_SET);
      // Lo mismo por la puerta que la bandeja USA de verdad al filtrar: la
      // acción de `voucherAlertFilter`, que es la que approve/reject cierra.
      const filtro = /VOUCHER_ALERT_ACTION = "([^"]+)"/.exec(alertas)?.[1];
      expect(filtro).toBe(AUDIT_ACTIONS.VOUCHER_REQUESTED);
      expect(filtro).not.toBe(AUDIT_ACTIONS.VOUCHER_LIMITS_SET);
      for (const archivo of ["src/features/alerts/service.ts", "src/features/alerts/schemas.ts"]) {
        const fuente = readFileSync(join(process.cwd(), archivo), "utf8");
        expect(fuente, `${archivo} menciona la acción`).not.toContain("VOUCHER_LIMITS_SET");
        expect(fuente, `${archivo} menciona el código`).not.toContain("voucher.limits_set");
      }
      // Y el servicio NO re-declara el código a mano: lo toma del vocabulario
      // compartido, para que no se desincronicen.
      const fuente = readFileSync(join(process.cwd(), "src/features/payroll/service.ts"), "utf8");
      expect(fuente).toContain("AUDIT_ACTIONS.VOUCHER_LIMITS_SET");
      expect(fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")).not.toContain(
        '"voucher.limits_set"',
      );
    });

    it("el top guardado manda: un vale por encima del tope diario queda pendiente", async () => {
      // El efecto de negocio de la fila nueva, no sólo su forma: el mismo
      // control de 006/026 que antes leía `voucher_settings`.
      payrollPagedStub.tables.system_settings = voucherSettingRows({ max_per_day: 50000 });

      const settings = await getVoucherSettings();
      const caps = checkVoucherEligibility({
        dayTotal: 40000,
        weekTotal: 40000,
        requested: 20000,
        maxPerDay: settings.max_per_day,
        maxPerWeek: settings.max_per_week,
        requestDate: "2026-01-15",
        allowedDays: settings.allowed_days,
        perDayLimits: settings.per_day_limits,
      });

      expect(caps.overDay).toBe(true);
      expect(caps.overWeek).toBe(false);
      expect(caps.dayNotAllowed).toBe(false);
      expect(requiresVoucherApproval(caps)).toBe(true);
    });

    it("los días permitidos de la clave siguen mandando sobre la elegibilidad", async () => {
      payrollPagedStub.tables.system_settings = voucherSettingRows({ allowed_days: [1, 2, 3, 4, 5] });
      const settings = await getVoucherSettings();

      // Sábado 2026-01-17 y domingo 2026-01-18: fuera de los días configurados.
      expect(isVoucherDayAllowed("2026-01-17", settings.allowed_days)).toBe(false);
      expect(isVoucherDayAllowed("2026-01-18", settings.allowed_days)).toBe(false);
      //structureEl jueves sí, y un día no permitido exige revisión aunque no haya
      //tope configurado.
      expect(isVoucherDayAllowed("2026-01-15", settings.allowed_days)).toBe(true);
      expect(
        checkVoucherEligibility({
          dayTotal: 0,
          weekTotal: 0,
          requested: 1000,
          maxPerDay: settings.max_per_day,
          maxPerWeek: settings.max_per_week,
          requestDate: "2026-01-17",
          allowedDays: settings.allowed_days,
          perDayLimits: settings.per_day_limits,
        }).dayNotAllowed,
      ).toBe(true);
    });

    it("el tope propio por día sigue REEMPLAZANDO al general en su día (026)", () => {
      // Misma regla de siempre, ahora leída de dos claves distintas.
      payrollPagedStub.tables.system_settings = voucherSettingRows({
        max_per_day: 100000,
        per_day_limits: { "4": 20000 },
      });
      const limits = readVoucherPerDaySetting(settingValue("voucher_per_day_limits"));

      // 2026-01-15 es jueves (4) y 2026-01-22 también: rige el tope propio.
      expect(resolveVoucherDayCap(100000, limits, "2026-01-15")).toBe(20000);
      expect(resolveVoucherDayCap(100000, limits, "2026-01-22")).toBe(20000);
      // Cualquier otro día, el general.
      expect(resolveVoucherDayCap(100000, limits, "2026-01-16")).toBe(100000);
    });
  });

  describe("el sobre de cada clave tiene un solo lector y un solo escritor", () => {
    it("leer y escribir son inversos (lo guardado es lo que se vuelve a leer)", () => {
      expect(readVoucherCapSetting(voucherCapSettingValue(50000))).toBe(50000);
      expect(readVoucherCapSetting(voucherCapSettingValue(null))).toBeNull();
      expect(readVoucherDaysSetting(voucherDaysSettingValue([3, 1, 1]))).toEqual([1, 3]);
      expect(readVoucherDaysSetting(voucherDaysSettingValue(null))).toBeNull();
      expect(readVoucherPerDaySetting(voucherPerDaySettingValue({ "3": 50000 }))).toEqual({ "3": 50000 });
      expect(readVoucherPerDaySetting(voucherPerDaySettingValue(null))).toBeNull();
    });

    it("un tope negativo o no numérico se lee como valor por omisión, no como un tope raro", () => {
      // El Zod ya no puede colarlos por la puerta de la escritura; un sobre
      // corrupto en la base tampoco puede convertirse en un tope de −5 ni en un
      // NaN que rompa las comparaciones de `checkVoucherCaps`.
      expect(readVoucherCapSetting({ amount: -5 })).toBeNull();
      expect(readVoucherCapSetting({ amount: "mucho" })).toBeNull();
      expect(readVoucherCapSetting({ amount: 0 })).toBe(0);
      expect(readVoucherCapSetting(undefined)).toBeNull();
      expect(readVoucherCapSetting(null)).toBeNull();
    });
  });

  describe("la 072 es idempotente y todavía no borra nada", () => {
    it("deja el mismo esquema en cada corrida", () => {
      const sql = sql072();
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.system_settings");
      expect(sql).toContain("key text PRIMARY KEY");
      expect(sql).toContain("value jsonb NOT NULL DEFAULT '{}'::jsonb");
      expect(sql).toContain("updated_at timestamptz NOT NULL DEFAULT now()");
      // El trigger y la política se re-emiten con su `IF EXISTS`, que es lo que
      // los deja idénticos: sin eso, la segunda corrida fallaría.
      expect(sql).toContain("DROP TRIGGER IF EXISTS trg_system_settings_updated_at");
      expect(sql).toContain("EXECUTE FUNCTION public.set_updated_at()");
      expect(sql).toContain("DROP POLICY IF EXISTS pol_system_settings_sede_isolation");
      expect(sql).toContain("CREATE OR REPLACE FUNCTION public.next_invoice_number(p_sede_id uuid)");
    });

    it("mueve los datos adelante SIN pisar lo que ya está vigente", () => {
      const sql = sql072();
      // Los dos movimientos de datos (contador y topes) son `DO NOTHING`: una
      // segunda corrida NO puede rebajar el contador ni pisar una configuración
      // que el admin cambió después de aplicada la migración.
      const movimientos =
        sql.match(/INSERT INTO public\.system_settings[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/g) ?? [];
      // TRES: los dos movimientos de datos (contador y topes) y el
      // `INSERT … DO NOTHING` de la función, que por lo mismo no puede rebajar
      // un contador que ya avanzó.
      expect(movimientos).toHaveLength(3);
      expect(sql).not.toMatch(/ON CONFLICT \(key\) DO UPDATE/);
      // Y la copia nunca ESCRIBE en las tablas viejas.
      expect(sql).not.toMatch(/UPDATE\s+public\.invoice_sequences/i);
      expect(sql).not.toMatch(/UPDATE\s+public\.voucher_settings/i);
      expect(sql).not.toMatch(/DELETE\s+FROM/i);
    });

    it("NO borra las dos tablas viejas ni la columna: es la unidad que quita sede_id", () => {
      const sql = sql072();
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/DROP COLUMN/i);
      expect(sql).not.toMatch(/ALTER TABLE public\.(invoice_sequences|voucher_settings)/i);
      // Y el archivo lo dice, para que el orden de la serie no dependa de la
      // memoria de quien lo lea.
      expect(raw072()).toContain("NO borra `invoice_sequences` ni `voucher_settings`");
      expect(raw072()).toContain("POR QUÉ `next_invoice_number` CONSERVA SU PARÁMETRO");
    });

    it("documenta las cinco claves y el valor por omisión de cada una, con su origen", () => {
      const raw = raw072();
      for (const clave of [
        "invoice_sequence",
        "voucher_max_per_day",
        "voucher_max_per_week",
        "voucher_per_day_limits",
        "voucher_allowed_days",
      ]) {
        expect(sql072()).toContain(`'${clave}'`);
        expect(raw).toContain(`'${clave}'`);
      }
      // Los cuatro valores por omisión de la sección 3 son los de las columnas
      // que cada ajuste reemplaza, no una decisión nueva de la migración.
      expect(raw).toContain('{"last_number": 0}');
      expect(raw).toContain('{"amount": null}');
      expect(raw).toContain('{"limits": {}}');
      expect(raw).toContain('{"days": [1..7]}');
      // Y el motivo de la forma: una fila por ajuste, no una fila por sede.
      expect(raw).toContain("POR QUÉ CLAVE / VALOR Y NO UNA TABLA POR AJUSTE");
    });
  });
});
