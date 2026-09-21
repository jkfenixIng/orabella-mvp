import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDraftPeriod,
  assertNoOverpay,
  assertPortionsMatchNet,
  buildEmployeeDetail,
  calculatePayrollSchema,
  canDiscountVoucher,
  canReviewVoucher,
  checkVoucherCaps,
  computeLineCommission,
  computeNetPay,
  generateApprovalCode,
  isApprovalCodeValid,
  openPeriodSchema,
  payPayrollItemSchema,
  rejectVoucherSchema,
  requestVoucherSchema,
  requiresVoucherApproval,
  voucherLimitsSchema,
  weekStartOf,
} from "@/src/features/payroll/schemas";

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

  it("el código de aprobación es de 6 dígitos", () => {
    const code = generateApprovalCode();
    expect(isApprovalCodeValid(code)).toBe(true);
    expect(isApprovalCodeValid("12345")).toBe(false);
    expect(isApprovalCodeValid(null)).toBe(false);
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
      }).success,
    ).toBe(true);
    expect(
      requestVoucherSchema.safeParse({
        employee_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        amount: 0,
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
