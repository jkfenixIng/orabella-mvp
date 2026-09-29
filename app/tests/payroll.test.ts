import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveVoucherSchema,
  assertDeletablePeriod,
  assertDraftPeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeCommissionDetail,
  buildEmployeeDetail,
  calculatePayrollSchema,
  canDiscountVoucher,
  canReviewVoucher,
  capPayrollDiscounts,
  checkVoucherCaps,
  checkVoucherEligibility,
  computeLineCommission,
  computeNetPay,
  isVoucherDayAllowed,
  normalizeAllowedDays,
  normalizePerDayLimits,
  openPeriodSchema,
  overlapBlocksDeletion,
  payPayrollItemSchema,
  rejectVoucherSchema,
  requestVoucherSchema,
  requiresVoucherApproval,
  resolveVoucherDayCap,
  resolveVoucherInitialStatus,
  restoreVoucherStatus,
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
  getPeriodDetail,
  PayrollError,
  type PayrollActor,
} from "@/src/features/payroll/service";
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

  it("el esquema exige porciones con método y monto > 0", () => {
    expect(
      payPayrollItemSchema.safeParse({ portions: [{ method_code: "efectivo", amount: 100000 }] }).success,
    ).toBe(true);
    expect(payPayrollItemSchema.safeParse({ portions: [] }).success).toBe(false);
    expect(
      payPayrollItemSchema.safeParse({ portions: [{ method_code: "efectivo", amount: 0 }] }).success,
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
  /** Payload de cada INSERT (auditoría y demás): qué se registró de verdad. */
  inserts: [] as Array<{ table: string; payload: unknown }>,
  /** Payload de cada UPDATE, por tabla: si la escritura ocurrió o no. */
  updates: [] as Array<{ table: string; payload: unknown }>,
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

    const rows = (): Array<Record<string, unknown>> => payrollPagedStub.tables[table] ?? [];

    const select = (single: boolean): { data: unknown; error: unknown } => {
      if (op === "update") {
        // PostgREST devuelve las filas que el UPDATE afectó, con el payload ya
        // aplicado: la aprobación del vale necesita esa fila de vuelta.
        const matched = rows().filter((row) => filters.every((matches) => matches(row)));
        for (const row of matched) Object.assign(row, updatePayload ?? {});
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op !== "select") return { data: null, error: null };
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
  payrollPagedStub.inserts.length = 0;
  payrollPagedStub.updates.length = 0;
}

// Los catálogos de admin/cash son `unstable_cache` (caché de Next). Fuera de un
// request de Next no hay caché incremental: se usa la función tal cual, así la
// lectura corre de verdad contra el doble de PostgREST que arma cada test.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
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
