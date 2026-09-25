import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  assertShiftCloser,
  bogotaDay,
  buildMethodViews,
  CASH_OUT_LIMIT_CODE,
  CASH_OUT_LIMIT_RATIO,
  cashOutLimitState,
  cashOutLimitViolation,
  closeShiftSchema,
  computeCashClose,
  dayBounds,
  dayViewSchema,
  exceedsCashOutLimit,
  expectedDigitalTotal,
  HISTORY_PAGE_SIZE,
  historySchema,
  isVoucherCashOut,
  openShiftSchema,
  registerPaymentSchema,
  resolveClosingBase,
  resolveOpeningBase,
  sumMethodMaps,
  sumMethodTotal,
  voucherOutByMethod,
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

describe("cash: filtros por día usan hora de Bogotá (CAJ-05/06)", () => {
  it("dayBounds cubre el día calendario de Bogotá con offset -05:00", () => {
    expect(dayBounds("2026-09-22")).toEqual({
      from: "2026-09-22T00:00:00-05:00",
      to: "2026-09-22T23:59:59.999-05:00",
    });
  });

  it("bogotaDay resuelve la fecha en America/Bogota, no en UTC del servidor", () => {
    // 02:00 UTC = 21:00 del día anterior en Bogotá.
    expect(bogotaDay(0, new Date("2026-01-01T02:00:00Z"))).toBe("2025-12-31");
    expect(bogotaDay(0, new Date("2026-01-01T06:00:00Z"))).toBe("2026-01-01");
    expect(bogotaDay(1, new Date("2026-01-01T12:00:00Z"))).toBe("2026-01-02");
  });
});

describe("cash: esperado digital = apertura + cobrado (CAJ-03)", () => {
  it("suma saldo de apertura y pagos del turno", () => {
    expect(expectedDigitalTotal(1000000, 0)).toBe(1000000);
    expect(expectedDigitalTotal(1000000, 200000)).toBe(1200000);
    expect(expectedDigitalTotal(0, 0)).toBe(0);
  });

  it("vistas: metodos con lo cobrado y diferencias solo en cerrados", () => {
    const paid = new Map([["nequi", 200000]]);
    const open = new Map([["nequi", 1000000]]);
    const closedOk = new Map([["nequi", 1200000]]);
    expect(
      buildMethodViews({ paid, open, closed: closedOk }),
    ).toEqual({
      metodos: [{ method_code: "nequi", amount: 200000 }],
      declarados: [{ method_code: "nequi", amount: 1200000 }],
      diferencias: [],
    });
    const closedShort = new Map([["nequi", 1000000]]);
    expect(
      buildMethodViews({ paid, open, closed: closedShort }).diferencias,
    ).toEqual([{ method_code: "nequi", expected: 1200000, declared: 1000000, difference: -200000 }]);
    expect(buildMethodViews({ paid, open, closed: null }).diferencias).toEqual([]);
  });
});

describe("cash: solo quien abrió cierra, admin como válvula (CAJ-03)", () => {
  it("el que abrió cierra sin override", () => {
    expect(
      assertShiftCloser({ openedBy: "u-a", actorUserId: "u-a", isAdmin: false }),
    ).toEqual({ isOverride: false });
  });

  it("otro caja no puede cerrar (SHIFT_NOT_OWNER)", () => {
    expect(() =>
      assertShiftCloser({ openedBy: "u-a", actorUserId: "u-b", isAdmin: false }),
    ).toThrowError("SHIFT_NOT_OWNER");
  });

  it("admin cierra el ajeno con override auditado", () => {
    expect(
      assertShiftCloser({ openedBy: "u-a", actorUserId: "u-admin", isAdmin: true }),
    ).toEqual({ isOverride: true });
  });
});

describe("cash: rechazo de doble apertura (CAJ-01, sin solape)", () => {  it("con un turno abierto la apertura se rechaza (SHIFT_ALREADY_OPEN)", () => {
    expect(() => assertNoOpenShift(true)).toThrowError("SHIFT_ALREADY_OPEN");
  });

  it("sin turno abierto la apertura procede", () => {
    expect(() => assertNoOpenShift(false)).not.toThrow();
  });

  it("apertura exige pre-arqueo y acepta caja opcional (Caja única por defecto)", () => {
    const counts = [{ method_code: "efectivo", denomination: 50000, quantity: 4, amount: 200000 }];
    expect(openShiftSchema.safeParse({}).success).toBe(false);
    expect(openShiftSchema.safeParse({ counts }).success).toBe(true);
    expect(
      openShiftSchema.safeParse({ cash_register_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", counts })
        .success,
    ).toBe(true);
    expect(openShiftSchema.safeParse({ cash_register_id: "no-uuid", counts }).success).toBe(false);
  });
});

// ------------------------------------------------- cierre con arqueo (CAJ-03/04) ---

describe("cash: cierre exige conteo de efectivo (CAJ-03)", () => {
  it("sin conteo el cierre se bloquea (COUNT_REQUIRED)", () => {
    expect(() =>
      assertCloseInput({ countedCash: null }),
    ).toThrowError("COUNT_REQUIRED");
    expect(() =>
      assertCloseInput({ countedCash: undefined }),
    ).toThrowError("COUNT_REQUIRED");
  });

  it("con conteo el cierre procede sin pedir base ni justificación (arqueo escondido)", () => {
    expect(() => assertCloseInput({ countedCash: 150000 })).not.toThrow();
    expect(() => assertCloseInput({ countedCash: 0 })).not.toThrow();
  });

  it("el esquema exige conteo, detalle y confirmación; la base es opcional (la calcula el servidor)", () => {
    const base = {
      counted_cash: 400000,
      counts: [{ method_code: "efectivo", denomination: 50000, quantity: 8, amount: 400000 }],
      confirmed: true,
    };
    expect(closeShiftSchema.safeParse(base).success).toBe(true);
    expect(closeShiftSchema.safeParse({}).success).toBe(false);
    expect(closeShiftSchema.safeParse({ counted_cash: -1 }).success).toBe(false);
    expect(closeShiftSchema.safeParse({ ...base, confirmed: false }).success).toBe(false);
    expect(
      closeShiftSchema.safeParse({ counted_cash: 400000, base_left: 200000 }).success,
    ).toBe(false);
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

describe("cash: base automática del cierre (CAJ-04, arqueo escondido)", () => {
  it("contado >= configurada → base nivelada en la configurada", () => {
    expect(resolveClosingBase(200000, 200000)).toBe(200000);
    expect(resolveClosingBase(300000, 200000)).toBe(200000);
  });

  it("contado < configurada → base queda en lo contado hasta nivelarse", () => {
    expect(resolveClosingBase(150000, 200000)).toBe(150000);
    expect(resolveClosingBase(150000, 300000)).toBe(150000);
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

describe("cash: vista del día valida la fecha (CAJ-05)", () => {  it("acepta yyyy-mm-dd y rechaza otros formatos", () => {
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

  it("historial pagina de a 10 con página 1 por defecto (CAJ-06)", () => {
    const parsed = historySchema.safeParse({ desde: "2026-09-01", hasta: "2026-09-18" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(HISTORY_PAGE_SIZE).toBe(10);
    }
    expect(
      historySchema.safeParse({ desde: "2026-09-01", hasta: "2026-09-18", page: 3 }).success,
    ).toBe(true);
    expect(
      historySchema.safeParse({ desde: "2026-09-01", hasta: "2026-09-18", page: 0 }).success,
    ).toBe(false);
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

// ------------------------------------------------- vales en el arqueo ---

describe("cash: vales aprobados descuentan del arqueo por su método", () => {
  it("un vale pendiente NO afecta el arqueo (nunca aprobado)", () => {
    expect(isVoucherCashOut({ approved_by: null, method_code: "efectivo", amount: 50000 })).toBe(false);
    // Histórico sin método tampoco cuenta, aunque figure aprobado.
    expect(isVoucherCashOut({ approved_by: "u1", method_code: null, amount: 50000 })).toBe(false);
    const out = voucherOutByMethod([
      { approved_by: null, method_code: "efectivo", amount: 50000 },
      { approved_by: null, method_code: "nequi", amount: 30000 },
    ]);
    expect(out.size).toBe(0);
  });

  it("un vale aprobado SÍ sale por su método (resta del esperado digital)", () => {
    const out = voucherOutByMethod([
      { approved_by: "u1", method_code: "efectivo", amount: 30000 },
      { approved_by: "u1", method_code: "nequi", amount: 20000 },
    ]);
    expect(out.get("efectivo")).toBe(30000);
    expect(out.get("nequi")).toBe(20000);
    // Esperado digital = apertura + cobrado − salida del vale.
    expect(expectedDigitalTotal(1000000, 50000, out.get("nequi") ?? 0)).toBe(1030000);
  });

  it("varios vales del mismo método acumulan y los pendientes se ignoran", () => {
    const out = voucherOutByMethod([
      { approved_by: "u1", method_code: "efectivo", amount: 10000 },
      { approved_by: "u2", method_code: "efectivo", amount: 25000 },
      { approved_by: null, method_code: "efectivo", amount: 999999 },
    ]);
    expect(out.get("efectivo")).toBe(35000);
  });

  it("sumMethodMaps combina comisiones + vales (mapas ausentes se ignoran)", () => {
    const payouts = new Map([["nequi", 100000]]);
    const vouchers = new Map([
      ["nequi", 20000],
      ["efectivo", 30000],
    ]);
    const combined = sumMethodMaps(payouts, vouchers);
    expect(combined.get("nequi")).toBe(120000);
    expect(combined.get("efectivo")).toBe(30000);
    expect(sumMethodMaps(null, undefined).size).toBe(0);
  });

  it("buildMethodViews cuadra el cierre descontando la salida por vale", () => {
    const paid = new Map([["nequi", 200000]]);
    const open = new Map([["nequi", 1000000]]);
    const out = new Map([["nequi", 50000]]);
    const closedOk = new Map([["nequi", 1150000]]);
    // 1000000 + 200000 − 50000 = 1150000 → sin diferencias.
    expect(buildMethodViews({ paid, open, paidOut: out, closed: closedOk }).diferencias).toEqual([]);
    // Sin descontar el vale el mismo conteo daría faltante.
    const closedNoOut = new Map([["nequi", 1150000]]);
    expect(
      buildMethodViews({ paid, open, paidOut: new Map(), closed: closedNoOut }).diferencias,
    ).toEqual([{ method_code: "nequi", expected: 1200000, declared: 1150000, difference: -50000 }]);
  });
});

// ------------------------------------------------- total de vales por turno ---

describe("cash: total de vales por turno (columna Vales)", () => {
  it("suma los vales del turno de todos los métodos como salida positiva", () => {
    const out = voucherOutByMethod([
      { approved_by: "u1", method_code: "efectivo", amount: 10000 },
      { approved_by: "u1", method_code: "nequi", amount: 25000 },
      { approved_by: null, method_code: "efectivo", amount: 999999 },
    ]);
    // Solo los aprobados cuentan; el pendiente se ignora.
    expect(sumMethodTotal(out)).toBe(35000);
  });

  it("degrada a 0 cuando la migración de vales no está aplicada (mapa ausente)", () => {
    // `fetchVoucherOutTotals` devuelve un mapa vacío si faltan las columnas.
    expect(sumMethodTotal(undefined)).toBe(0);
    expect(sumMethodTotal(null)).toBe(0);
    expect(sumMethodTotal(new Map())).toBe(0);
  });

  it("redondea el total a centavos", () => {
    expect(sumMethodTotal(new Map([["nequi", 0.1], ["efectivo", 0.2]]))).toBe(0.3);
  });
});

// --------------------------------- tope de salidas en efectivo (50% base) ---

describe("cash: tope de salidas en efectivo = 50% de la base del turno", () => {
  const base = 200000; // tope 100000

  it("calcula el tope como la mitad de la base de apertura", () => {
    expect(CASH_OUT_LIMIT_RATIO).toBe(0.5);
    expect(cashOutLimitState(base, 0)).toEqual({
      base: 200000,
      limit: 100000,
      used: 0,
      available: 100000,
    });
    // El disponible nunca queda negativo aunque el acumulado supere el tope.
    expect(cashOutLimitState(base, 120000).available).toBe(0);
  });

  it("un vale en efectivo por debajo del tope se permite", () => {
    const state = cashOutLimitState(base, 40000);
    expect(exceedsCashOutLimit(state, 30000)).toBe(false);
    expect(
      cashOutLimitViolation({
        methodCode: "efectivo",
        openingBase: base,
        cashOutUsed: 40000,
        amount: 30000,
      }),
    ).toBeNull();
  });

  it("un vale en efectivo exactamente en el 50% se permite (tope inclusivo)", () => {
    const state = cashOutLimitState(base, 0);
    expect(exceedsCashOutLimit(state, 100000)).toBe(false);
    expect(
      cashOutLimitViolation({
        methodCode: "efectivo",
        openingBase: base,
        cashOutUsed: 0,
        amount: 100000,
      }),
    ).toBeNull();
    // Acumulado 60000 + 40000 = 100000 = tope: también se permite.
    expect(
      cashOutLimitViolation({
        methodCode: "efectivo",
        openingBase: base,
        cashOutUsed: 60000,
        amount: 40000,
      }),
    ).toBeNull();
    // Un centavo por encima ya se rechaza.
    expect(exceedsCashOutLimit(cashOutLimitState(base, 60000), 40000.01)).toBe(true);
  });

  it("un vale en efectivo que supera el tope se rechaza con el código de negocio", () => {
    const violation = cashOutLimitViolation({
      methodCode: "efectivo",
      openingBase: base,
      cashOutUsed: 0,
      amount: 150000,
    });
    expect(violation).not.toBeNull();
    expect(violation?.code).toBe(CASH_OUT_LIMIT_CODE);
    expect(violation?.code).toBe("CASH_OUT_LIMIT_EXCEEDED");
    expect(violation?.message).toContain("150000");
    expect(violation?.message).toContain("200000");
    expect(violation?.message).toContain("100000");
  });

  it("el tope rige sobre el acumulado: 40000 ya salidos + 70000 nuevo lo supera", () => {
    // Tope 100000; 40000 + 70000 = 110000 > 100000 → rechazado.
    const violation = cashOutLimitViolation({
      methodCode: "efectivo",
      openingBase: base,
      cashOutUsed: 40000,
      amount: 70000,
    });
    expect(violation?.code).toBe(CASH_OUT_LIMIT_CODE);
    // El disponible reportado es el real: 100000 − 40000 = 60000.
    expect(violation?.message).toContain("60000");
  });

  it("las salidas por método digital se permiten aunque superen el 50%", () => {
    expect(
      cashOutLimitViolation({
        methodCode: "nequi",
        openingBase: base,
        cashOutUsed: 0,
        amount: 999999,
      }),
    ).toBeNull();
    expect(
      cashOutLimitViolation({
        methodCode: "tarjeta",
        openingBase: base,
        cashOutUsed: 90000,
        amount: 50000,
      }),
    ).toBeNull();
    // El mismo monto en efectivo sí se rechaza.
    expect(
      cashOutLimitViolation({
        methodCode: "efectivo",
        openingBase: base,
        cashOutUsed: 90000,
        amount: 50000,
      })?.code,
    ).toBe(CASH_OUT_LIMIT_CODE);
  });
});
