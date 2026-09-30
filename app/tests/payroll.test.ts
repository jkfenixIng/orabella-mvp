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
  canDiscountVoucher,
  canReviewVoucher,
  capPayrollDiscounts,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeLineCommission,
  computeNetPay,
  correctPayrollPeriodSchema,
  daysInMonthWithinRange,
  groupPayrollPeriodsByMonth,
  isVoucherDayAllowed,
  normalizeAllowedDays,
  normalizePerDayLimits,
  openPeriodSchema,
  overlapBlocksDeletion,
  payPayrollItemSchema,
  payrollEmployeeName,
  payrollExtraGuide,
  payrollExtraKindSchema,
  payrollExtraSchema,
  payrollMonthLabel,
  payrollPeriodCountLabel,
  prorateFixedSalary,
  rangesOverlap,
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
  voucherLimitsSchema,
  voucherRequiresReview,
  weekdayIso,
  weekStartOf,
  type PayrollCommissionLine,
} from "@/src/features/payroll/schemas";
import {
  commissionRuleKey,
  resolveEmployeeLineCommission,
} from "@/src/features/commissions/schemas";
import {
  approveVoucher,
  calculatePayroll,
  getPayrollPeriodCorrection,
  getPeriodDetail,
  listPayrollOverview,
  listPeriods,
  openPayrollPeriod,
  PayrollError,
  rejectVoucher,
  type PayrollActor,
} from "@/src/features/payroll/service";
import { listAllEmployees, listEmployees } from "@/src/features/admin/service";
import * as payrollExtrasService from "@/src/features/payroll/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import {
  getPeriodDetailAction,
  listVouchersAction,
} from "@/src/features/payroll/actions";
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

  it("apertura exige fin >= inicio", () => {
    expect(openPeriodSchema.safeParse({ start_date: "2026-09-01", end_date: "2026-09-15" }).success).toBe(
      true,
    );
    expect(openPeriodSchema.safeParse({ start_date: "2026-09-15", end_date: "2026-09-01" }).success).toBe(
      false,
    );
    expect(openPeriodSchema.safeParse({ start_date: "01/09/2026", end_date: "2026-09-15" }).success).toBe(
      false,
    );
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
    expect(
      requestVoucherSchema.safeParse({
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
        method_code: "efectivo",
      }).success,
    ).toBe(true);
    // El método arqueable se elige AL CREAR el vale: es obligatorio.
    expect(
      requestVoucherSchema.safeParse({
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 50000,
      }).success,
    ).toBe(false);
    expect(
      requestVoucherSchema.safeParse({
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
  /** Falla el select de `table` cuando entre sus filtros está `filter`. */
  failOn: null as { table: string; filter: string } | null,
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
   * PR1: falla el INSERT de `table` con este código. El doble tiene que poder
   * responder como la BASE (una restricción violada, `23P01`), no sólo como un
   * cliente feliz: si no, la carrera contra la restricción de exclusión no se
   * podría probar.
   */
  insertError: null as { table: string; code: string } | null,
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
}));

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
        // PostgREST devuelve las filas que el UPDATE afectó, con el payload ya
        // aplicado: la aprobación del vale necesita esa fila de vuelta.
        const matched = rows().filter((row) => filters.every((matches) => matches(row)));
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
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op !== "select") {
        // INSERT: PostgREST devuelve las filas insertadas y las deja en la
        // tabla (el upsert ya persistía: `getPeriodDetail` lee después esas
        // filas). Hacía falta acá para `openPayrollPeriod`, que necesita la
        // fila de vuelta; y para poder inyectar el fallo de la BASE.
        const failure = payrollPagedStub.insertError;
        if (failure && failure.table === table) {
          return {
            data: null,
            error: { code: failure.code, message: `doble: ${failure.code} inyectado en el INSERT de ${table}` },
          };
        }
        const values = (Array.isArray(insertPayload) ? insertPayload : [insertPayload]) as Array<
          Record<string, unknown>
        >;
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
        const persisted = values.map((row, index) => ({
          id: `fila-insertada-${index + 1}`,
          created_at: "2026-01-31T23:59:59.000Z",
          closed_at: null,
          ...row,
        }));
        payrollPagedStub.tables[table] = [...rows(), ...persisted];
        return { data: single ? persisted[0] ?? null : persisted, error: null };
      }
      const failOn = payrollPagedStub.failOn;
      if (failOn && failOn.table === table && filterColumns.includes(failOn.filter)) {
        return {
          data: null,
          error: { message: `doble: fallo inyectado en ${table} (filtro ${failOn.filter})` },
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
      upsert: (value?: unknown) => {
        op = "upsert";
        // El upsert persiste de verdad: `getPeriodDetail` lee después estas filas.
        const persisted = (Array.isArray(value) ? value : [value]).map((row, index) => ({
          ...(row as Record<string, unknown>),
          id: `item-nomina-${index + 1}`,
          created_at: "2026-01-31T23:59:59.000Z",
        }));
        payrollPagedStub.itemsUpsert = persisted;
        payrollPagedStub.tables.payroll_items = [...rows(), ...persisted];
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
  return { from };
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
  payrollPagedStub.insertError = null;
  payrollPagedStub.updates.length = 0;
  payrollPagedStub.uniqueKeys.length = 0;
  payrollPagedStub.skipMarkLookupOnce = false;
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
    listEmployees: async (sedeId: string, limit?: number) =>
      payrollPagedStub.tables.employees
        ? actual.listEmployees(sedeId, limit)
        : ([employee] as Awaited<ReturnType<typeof actual.listEmployees>>),
    listAllEmployees: async (sedeId: string) =>
      payrollPagedStub.tables.employees
        ? actual.listAllEmployees(sedeId)
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
        status: "Emitida",
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
        status: "Emitida",
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
      voucher_settings: [
        {
          sede_id: payrollPagedStub.SEDE_ID,
          max_per_day: maxPerDay,
          max_per_week: null,
          allowed_days: null,
          per_day_limits: null,
        },
      ],
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
  });

  it("control: sobre el tope la marca sigue siendo `true`", async () => {
    seedPendingVoucher(150000, 100000);

    const approved = await approveVoucher(payrollPagedStub.SEDE_ID, VOUCHER_ID, {}, ACTOR);

    expect(approved.status).toBe("aprobada");
    expect((approvalAudit()?.metadata as { over_tope?: unknown }).over_tope).toBe(true);
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
      voucher_settings: [
        {
          sede_id: payrollPagedStub.SEDE_ID,
          max_per_day: 200000,
          max_per_week: null,
          allowed_days: null,
          per_day_limits: null,
        },
      ],
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
          status: "Emitida",
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

  function periodRow(id: string, start: string, end: string, status = "borrador", sedeId = payrollPagedStub.SEDE_ID) {
    return {
      id,
      sede_id: sedeId,
      start_date: start,
      end_date: end,
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

  it("rechaza abrir un período que comparte días con otro de la sede", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-01", "2026-09-07")]);

    const failure: unknown = await openPayrollPeriod(
      { start_date: "2026-09-05", end_date: "2026-09-12" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    // El mensaje nombra los DOS rangos: el pedido y el que estorba.
    const message = (failure as PayrollError).message;
    expect(message).toContain("2026-09-05 a 2026-09-12");
    expect(message).toContain("2026-09-01 a 2026-09-07");
    // Nada se escribió: la guarda corre ANTES del INSERT.
    expect(periodInserts()).toHaveLength(0);
  });

  it("compartir UN solo día ya bloquea", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-01", "2026-09-07")]);

    const failure: unknown = await openPayrollPeriod(
      { start_date: "2026-09-07", end_date: "2026-09-14" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP" });
  });

  it("también bloquea contra un período CERRADO: esos días ya se pagaron", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-01", "2026-09-07", "cerrado")]);

    const failure: unknown = await openPayrollPeriod(
      { start_date: "2026-08-28", end_date: "2026-09-02" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    expect((failure as PayrollError).message).toContain("2026-09-01 a 2026-09-07");
  });

  it("control negativo: el rango ADYACENTE (empieza el día siguiente) se abre", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-01", "2026-09-07")]);

    const created = await openPayrollPeriod(
      { start_date: "2026-09-08", end_date: "2026-09-14" },
      ACTOR,
    );

    expect(created).toMatchObject({
      start_date: "2026-09-08",
      end_date: "2026-09-14",
      status: "borrador",
      sede_id: payrollPagedStub.SEDE_ID,
    });
    expect(periodInserts()).toHaveLength(1);
  });

  it("control negativo: el solape es por SEDE (otra sede no bloquea)", async () => {
    seedPeriods([periodRow("periodo-otra", "2026-09-01", "2026-09-07", "borrador", OTHER_SEDE)]);

    const created = await openPayrollPeriod(
      { start_date: "2026-09-01", end_date: "2026-09-07" },
      ACTOR,
    );

    expect(created).toMatchObject({ start_date: "2026-09-01", end_date: "2026-09-07" });
  });

  it("una carrera perdida (23P01 de la restricción) es el MISMO error de negocio", async () => {
    seedPeriods([]);
    // La otra transacción ganó entre la lectura y el INSERT: la base responde
    // como responde una restricción de exclusión violada.
    payrollPagedStub.insertError = { table: "payroll_periods", code: "23P01" };

    const failure: unknown = await openPayrollPeriod(
      { start_date: "2026-09-08", end_date: "2026-09-14" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PayrollError);
    expect(failure).toMatchObject({ code: "PERIOD_OVERLAP", status: 409 });
    // No es un fallo interno disfrazado: la carrera tiene su propio mensaje.
    expect((failure as PayrollError).code).not.toBe("INTERNAL");
  });

  it("si la lectura de períodos no se completa, ABRIR se detiene (no decide con menos)", async () => {
    seedPeriods([periodRow("periodo-1", "2026-09-01", "2026-09-07")]);
    // La primera página de la lectura de períodos falla: con el conjunto
    // recortado la guarda podría no ver el período que estorba.
    payrollPagedStub.failAt = { payroll_periods: [1] };

    const failure: unknown = await openPayrollPeriod(
      { start_date: "2026-09-08", end_date: "2026-09-14" },
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
      sede_id: payrollPagedStub.SEDE_ID,
      metadata: {
        employee_id: EMPLOYEE_ID,
        amount: 1_800_000,
        kind: "renuncia",
        reason: "Renuncia del 2026-09-16",
        method_code: "efectivo",
      },
    });
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
    const listed = await payrollExtrasService.listPayrollExtras(payrollPagedStub.SEDE_ID);
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

    const rows = await listPeriods(SEDE);

    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.id)).toContain("periodo-00001");
  });

  it("la lista pide el conjunto entero, en páginas y en orden determinista", async () => {
    seedConsecutivePeriods(1200);

    const rows = await listPeriods(SEDE);

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

    const rows = await listPeriods(SEDE);

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
    const browsing = await listEmployees(SEDE);
    expect(browsing).toHaveLength(50);

    const all = await listAllEmployees(SEDE);
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

  it("el mes a la fecha por empleado: lo pagado y contra qué períodos", async () => {
    seedLegibilityFixture();

    const { months } = await listPayrollOverview(SEDE);

    expect(months.map((row) => `${row.month}/${row.employeeId}`)).toEqual([
      "2026-10/emp-01",
      "2026-09/emp-01",
      "2026-09/emp-02",
    ]);
    const september = months[1];
    expect(september).toMatchObject({
      netTotal: 1900000,
      paidTotal: 1300000,
      remainingTotal: 600000,
      fixedTotal: 1600000,
      days: 30,
    });
    // Contra qué períodos: los dos de septiembre, en orden de fecha.
    expect(september.periods.map((row) => row.periodId)).toEqual([P1, P2]);
    expect(september.periods[0]).toMatchObject({
      status: "borrador",
      net: 1000000,
      paid: 400000,
      remaining: 600000,
      fixed: 800000,
      days: 15,
    });
  });

  it("control negativo: una fila con más pagado que neto no resta del saldo", async () => {
    seedLegibilityFixture();
    // Con la base actual no puede pasar (`assertNoOverpay`), pero la vista no
    // puede inventar un saldo negativo si el dato llegara así igual.
    payrollPagedStub.tables.payroll_payments.push(paymentFixture("pay-5", "i-2", 700000));

    const overview = await listPayrollOverview(SEDE);

    const p1 = overview.summaries.find((row) => row.period.id === P1);
    expect(p1).toMatchObject({ paidTotal: 1100000, remainingTotal: 600000 });
  });

  it("control negativo: un mes sin períodos no aparece en la vista", async () => {
    seedLegibilityFixture();

    const { months } = await listPayrollOverview(SEDE);

    expect(months.map((row) => row.month)).not.toContain("2026-11");
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
      sede_id: payrollPagedStub.SEDE_ID,
      metadata: {
        correction_id: result.correction.id,
        reason: "El fijo se pagó completo y correspondía la parte de los días.",
        previous_net_total: SALARY,
        corrected_net_total: PRORATED,
        previous_paid_total: SALARY,
        difference_total: 1_073_333,
      },
    });
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
