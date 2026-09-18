import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  closeShiftSchema,
  computeCashClose,
  dayViewSchema,
  historySchema,
  openShiftSchema,
  registerPaymentSchema,
  requiresCloseObservation,
  resolveOpeningBase,
} from "@/src/features/cash/schemas";

// ------------------------------------------------- base encadenada (CAJ-01) ---

describe("cash: apertura hereda la base del último cierre (CAJ-01)", () => {
  it("el primer turno abre con base_configurada (default 200000)", () => {
    expect(resolveOpeningBase(null, 200000)).toBe(200000);
    expect(resolveOpeningBase(undefined, 300000)).toBe(300000);
  });

  it("el turno N+1 abre con base_left del cierre N", () => {
    expect(resolveOpeningBase(200000, 200000)).toBe(200000);
    // Caso 300/150 del dueño: la próxima apertura es 150000.
    expect(resolveOpeningBase(150000, 300000)).toBe(150000);
  });
});

describe("cash: rechazo de doble apertura (CAJ-01, sin solape)", () => {
  it("con un turno abierto la apertura se rechaza (SHIFT_ALREADY_OPEN)", () => {
    expect(() => assertNoOpenShift(true)).toThrowError("SHIFT_ALREADY_OPEN");
  });

  it("sin turno abierto la apertura procede", () => {
    expect(() => assertNoOpenShift(false)).not.toThrow();
  });

  it("apertura acepta caja opcional (Caja única por defecto)", () => {
    expect(openShiftSchema.safeParse({}).success).toBe(true);
    expect(
      openShiftSchema.safeParse({ cash_register_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
        .success,
    ).toBe(true);
    expect(openShiftSchema.safeParse({ cash_register_id: "no-uuid" }).success).toBe(false);
  });
});

// ------------------------------------------------- cierre con arqueo (CAJ-03/04) ---

describe("cash: cierre exige conteo de efectivo (CAJ-03)", () => {
  it("sin conteo el cierre se bloquea (COUNT_REQUIRED)", () => {
    expect(() =>
      assertCloseInput({ countedCash: null, baseLeft: 200000, baseConfigurada: 200000, observation: null }),
    ).toThrowError("COUNT_REQUIRED");
    expect(() =>
      assertCloseInput({ countedCash: undefined, baseLeft: 200000, baseConfigurada: 200000, observation: null }),
    ).toThrowError("COUNT_REQUIRED");
  });

  it("el esquema exige conteo y base dejada", () => {
    expect(closeShiftSchema.safeParse({ counted_cash: 400000, base_left: 200000 }).success).toBe(true);
    expect(closeShiftSchema.safeParse({ base_left: 200000 }).success).toBe(false);
    expect(closeShiftSchema.safeParse({ counted_cash: 400000 }).success).toBe(false);
    expect(closeShiftSchema.safeParse({ counted_cash: -1, base_left: 200000 }).success).toBe(false);
  });
});

describe("cash: casos del dueño 400/200 y 300/150 (CAJ-04)", () => {
  it("400/200: hay 400000 y la base es 200000 → quedan 200000 y se recogen 200000", () => {
    expect(
      computeCashClose({ countedCash: 400000, baseLeft: 200000, baseConfigurada: 200000 }),
    ).toEqual({ cashWithdrawn: 200000, baseDifference: 0, incomplete: false });
  });

  it("300/150: base 300000 pero solo hay 150000 → próxima base 150000, faltante 150000", () => {
    expect(
      computeCashClose({ countedCash: 150000, baseLeft: 150000, baseConfigurada: 300000 }),
    ).toEqual({ cashWithdrawn: 0, baseDifference: -150000, incomplete: true });
  });

  it("sobrante queda registrado con diferencia positiva", () => {
    expect(
      computeCashClose({ countedCash: 500000, baseLeft: 350000, baseConfigurada: 300000 }),
    ).toEqual({ cashWithdrawn: 150000, baseDifference: 50000, incomplete: false });
  });
});

describe("cash: base incompleta exige observación (CAJ-04)", () => {
  it("base_left < base_configurada marca incompleta", () => {
    expect(requiresCloseObservation(150000, 300000)).toBe(true);
    expect(requiresCloseObservation(300000, 300000)).toBe(false);
    expect(requiresCloseObservation(350000, 300000)).toBe(false);
  });

  it("incompleta sin observación se rechaza (OBSERVATION_REQUIRED)", () => {
    expect(() =>
      assertCloseInput({ countedCash: 150000, baseLeft: 150000, baseConfigurada: 300000, observation: null }),
    ).toThrowError("OBSERVATION_REQUIRED");
    expect(() =>
      assertCloseInput({ countedCash: 150000, baseLeft: 150000, baseConfigurada: 300000, observation: "   " }),
    ).toThrowError("OBSERVATION_REQUIRED");
  });

  it("incompleta con observación y completa sin observación proceden", () => {
    expect(() =>
      assertCloseInput({ countedCash: 150000, baseLeft: 150000, baseConfigurada: 300000, observation: "Faltante de 150000" }),
    ).not.toThrow();
    expect(() =>
      assertCloseInput({ countedCash: 400000, baseLeft: 200000, baseConfigurada: 200000, observation: null }),
    ).not.toThrow();
  });
});

// ------------------------------------------------- pagos (CAJ-02) ---

describe("cash: pagos contra el turno con método activo y monto > 0 (CAJ-02)", () => {
  it("acepta pago con método y monto válido, factura opcional", () => {
    expect(
      registerPaymentSchema.safeParse({ method_code: "efectivo", amount: 50000 }).success,
    ).toBe(true);
    expect(
      registerPaymentSchema.safeParse({
        method_code: "nequi",
        amount: 25000,
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(true);
  });

  it("rechaza monto 0/negativo y método vacío", () => {
    expect(registerPaymentSchema.safeParse({ method_code: "efectivo", amount: 0 }).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ method_code: "efectivo", amount: -100 }).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ method_code: "  ", amount: 1000 }).success).toBe(false);
  });
});

// ------------------------------------------------- día y acumulado (CAJ-05) ---

describe("cash: vista del día valida la fecha (CAJ-05)", () => {
  it("acepta yyyy-mm-dd y rechaza otros formatos", () => {
    expect(dayViewSchema.safeParse({ fecha: "2026-09-18" }).success).toBe(true);
    expect(dayViewSchema.safeParse({ fecha: "18/09/2026" }).success).toBe(false);
    expect(dayViewSchema.safeParse({}).success).toBe(false);
  });

  it("historial exige rango válido (CAJ-06)", () => {
    expect(
      historySchema.safeParse({ desde: "2026-09-01", hasta: "2026-09-18" }).success,
    ).toBe(true);
    expect(
      historySchema.safeParse({ desde: "2026-09-18", hasta: "2026-09-01" }).success,
    ).toBe(false);
    expect(historySchema.safeParse({ desde: "ayer", hasta: "2026-09-18" }).success).toBe(false);
  });
});

describe("cash: acumulado del día = suma de turnos (CAJ-05)", () => {
  it("dos turnos con responsables distintos cuadran en el acumulado", () => {
    // Turno 1: ventas 400000 (300000 efectivo + 100000 nequi), contado 400000, base 200000.
    // Turno 2: ventas 150000 en efectivo, contado 150000, base 150000 (caso 300/150).
    const totals = accumulateDayTotals([
      {
        expectedCash: 300000,
        countedCash: 400000,
        baseLeft: 200000,
        cashWithdrawn: 200000,
        baseDifference: 0,
        ventas: 400000,
      },
      {
        expectedCash: 150000,
        countedCash: 150000,
        baseLeft: 150000,
        cashWithdrawn: 0,
        baseDifference: -150000,
        ventas: 150000,
      },
    ]);
    expect(totals).toEqual({
      turnos: 2,
      ventas: 550000,
      esperado: 450000,
      contado: 550000,
      baseDejada: 350000,
      recogido: 200000,
      diferencias: -150000,
    });
  });

  it("turno abierto (sin conteo) aporta ventas pero no contado", () => {
    const totals = accumulateDayTotals([
      {
        expectedCash: 50000,
        countedCash: null,
        baseLeft: null,
        cashWithdrawn: null,
        baseDifference: null,
        ventas: 80000,
      },
    ]);
    expect(totals.ventas).toBe(80000);
    expect(totals.contado).toBe(0);
    expect(totals.turnos).toBe(1);
  });

  it("día sin turnos acumula en cero", () => {
    expect(accumulateDayTotals([])).toEqual({
      turnos: 0,
      ventas: 0,
      esperado: 0,
      contado: 0,
      baseDejada: 0,
      recogido: 0,
      diferencias: 0,
    });
  });
});

// ------------------------------------------------- migración 006 ---

describe("migración 006_cash.sql (T6)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "006_cash.sql"), "utf8");

  it("crea cash_registers, cash_shifts y payments con base 200000", () => {
    expect(sql).toContain("CREATE TABLE public.cash_registers");
    expect(sql).toContain("CREATE TABLE public.cash_shifts");
    expect(sql).toContain("CREATE TABLE public.payments");
    expect(sql).toContain("base_configurada numeric(12, 2) NOT NULL DEFAULT 200000");
    expect(sql).toContain("'Caja única'");
  });

  it("un solo turno abierto por caja con índice único parcial", () => {
    expect(sql).toContain("uq_cash_shifts_open_per_register");
    expect(sql).toContain("WHERE status = 'abierto'");
  });

  it("cierre exige conteo y vincula invoices.cash_shift_id con FK", () => {
    expect(sql).toContain("CHECK (status IN ('abierto', 'cerrado'))");
    expect(sql).toContain("OR counted_cash IS NOT NULL");
    expect(sql).toContain("fk_invoices_cash_shift");
    expect(sql).toContain("REFERENCES public.cash_shifts");
  });

  it("pagos con monto > 0 e índices por turno y factura", () => {
    expect(sql).toContain("CHECK (amount > 0)");
    expect(sql).toContain("idx_payments_cash_shift_id");
    expect(sql).toContain("idx_payments_invoice_id");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("CREATE POLICY pol_cash_registers_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_cash_shifts_sede_isolation");
    expect(sql).toContain("CREATE POLICY pol_payments_sede_isolation");
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("documenta CAJ-01…06, base encadenada y consolidación con T5", () => {
    expect(sql).toContain("CAJ-04");
    expect(sql).toContain("invoice_payments");
    expect(sql).toContain("400");
  });
});
