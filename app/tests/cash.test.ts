import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accumulateDayTotals,
  assertCloseInput,
  assertNoOpenShift,
  assertShiftCloser,
  bogotaDay,
  buildMethodViews,
  buildRecountRecord,
  CASH_OUT_LIMIT_CODE,
  CASH_OUT_LIMIT_RATIO,
  cashOutLimitState,
  cashOutLimitViolation,
  closeAmountsFromCount,
  closeShiftSchema,
  computeCashClose,
  dayBounds,
  dayViewSchema,
  exceedsCashOutLimit,
  expectedDigitalTotal,
  governingClose,
  HISTORY_PAGE_SIZE,
  historySchema,
  isVoucherCashOut,
  openShiftSchema,
  recountShiftSchema,
  registerPaymentSchema,
  resolveClosingBase,
  resolveOpeningBase,
  roundMoney,
  sumMethodMaps,
  sumMethodTotal,
  voucherOutByMethod,
} from "@/src/features/cash/schemas";
import {
  CashError,
  invoiceCollectionsSummary,
  mergeShiftMoney,
  registerPayment,
  sumShiftMoneyByMethod,
} from "@/src/features/cash/service";
import {
  invoiceNetBalance,
  splitGrossCardFee,
} from "@/src/features/billing/service";

// ------------------------------------------------------ helpers de recorte ---

/**
 * Copia de `source` con el contenido de strings, template literals y
 * comentarios reemplazado por espacios (misma longitud). Solo se usa para
 * contar llaves: así una llave dentro de un literal no descuadra el conteo.
 */
function blankStringsAndComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === char) break;
        j += 1;
      }
      blank(i + 1, Math.min(j, source.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Cuerpo de la primera rama que empieza con `marker` (p. ej. `if (mirrorError) {`),
 * delimitado por llaves balanceadas.
 *
 * T0-b: reemplaza al recorte con `indexOf`/`slice`, que degradaba a `""` (o a un
 * tramo invertido) sin avisar. Un `expect("").not.toContain(...)` pasa siempre:
 * la guarda se perdía en silencio. Acá el marcador tiene que existir y el bloque
 * tiene que cerrar, o el test falla con un mensaje explícito.
 */
function extractBranch(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `no se encontró la rama \`${marker}\``).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  expect(open, `\`${marker}\` no abre un bloque`).toBeGreaterThan(-1);
  const scan = blankStringsAndComments(source);
  let depth = 0;
  for (let i = open; i < scan.length; i += 1) {
    if (scan[i] === "{") {
      depth += 1;
    } else if (scan[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`la rama \`${marker}\` no cierra sus llaves`);
}

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
    // CL-4: la marca del intento es obligatoria en los DOS caminos (con y sin
    // factura): sin ella un reintento no se puede reconocer.
    expect(
      registerPaymentSchema.safeParse({
        method_code: "efectivo",
        amount: 50000,
        idempotency_key: "1f2e3d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
      }).success,
    ).toBe(true);
    expect(
      registerPaymentSchema.safeParse({
        method_code: "nequi",
        amount: 25000,
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        // CL-3: cobrar una factura exige la marca del intento (ver el bloque
        // CL-3 de abajo para la contractura completa).
        idempotency_key: "1f2e3d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
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

  it("suma en pesos enteros (sin ruido de punto flotante)", () => {
    // CAMBIÓ con la regla del peso entero: antes sumaba 0.1 + 0.2 → 0.3.
    expect(sumMethodTotal(new Map([["nequi", 100], ["efectivo", 200]]))).toBe(300);
    // Un monto sub-peso no existe como dinero: lo que se normaliza es el
    // TOTAL (100.4 + 200.4 = 300.8 → 301), igual que antes se normalizaba al
    // centavo.
    expect(sumMethodTotal(new Map([["nequi", 100.4], ["efectivo", 200.4]]))).toBe(301);
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
    // Un PESO por encima ya se rechaza (CAMBIÓ: antes era un centavo). Un
    // monto con centavos no existe como dinero: se normaliza al peso.
    expect(exceedsCashOutLimit(cashOutLimitState(base, 60000), 40000.01)).toBe(false);
    expect(exceedsCashOutLimit(cashOutLimitState(base, 60000), 40001)).toBe(true);
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

// ------------------------------ T0-a (C1): dos ledgers, cada peso una vez ---

describe("cash: T0-a (C1) el arqueo suma cada cobro UNA vez", () => {
  it("une movimientos de cajón y cobros de factura del turno", () => {
    const rows = mergeShiftMoney(
      [{ amount: 30000, method_code: "efectivo" }],
      [
        { amount: 70000, method_code: "efectivo" },
        { amount: 20000, method_code: "nequi" },
      ],
    );
    expect(rows).toHaveLength(3);
    expect([...sumShiftMoneyByMethod(rows)]).toEqual([
      ["efectivo", 100000],
      ["nequi", 20000],
    ]);
  });

  it("normaliza montos string y los lleva a peso entero por método", () => {
    // CAMBIÓ con la regla del peso entero: antes 1000.555 → 1000.56.
    const rows = mergeShiftMoney(
      [{ amount: "1000.555", method_code: "efectivo" }],
      null,
    );
    expect(sumShiftMoneyByMethod(rows).get("efectivo")).toBe(1001);
  });

  it("degrada a vacío cuando el turno no tiene cobros", () => {
    expect(mergeShiftMoney(null, undefined)).toEqual([]);
    expect(sumShiftMoneyByMethod([])).toEqual(new Map());
    expect(sumShiftMoneyByMethod(mergeShiftMoney([], [])).size).toBe(0);
  });
});

// ------------- T0-a (Defecto 1): el tope descuenta el recargo emitido ---

describe("cash: T0-a (Defecto 1) el tope de cobro descuenta el recargo emitido", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "031_cash_invoice_payment_integrity.sql"),
    "utf8",
  );

  /**
   * Réplica pura de la condición del trigger 031
   * (`check_invoice_payments_cap`), para fijar la aritmética sin base de
   * datos. El tope es el neto facturado COBRABLE —redondeado a peso entero,
   * porque el datafono no acepta centavos— y la tolerancia sigue en 0.009.
   * Si alguien edita el trigger, el test estructural de abajo falla.
   */
  function capRejects(args: {
    total: number;
    surcharge: number;
    paidNet: number;
    newNet: number;
  }): boolean {
    return args.paidNet + args.newNet - roundMoney(args.total - args.surcharge) > 0.009;
  }

  it("la condición del trigger usa el NETO FACTURADO COBRABLE (round(total − surcharge))", () => {
    const body = sql.slice(sql.indexOf("check_invoice_payments_cap()"));
    expect(body).toContain("SELECT total, surcharge INTO v_total, v_surcharge");
    expect(body).toContain(
      "v_paid_net + v_new_net - round(v_total - coalesce(v_surcharge, 0)) > 0.009",
    );
    // La versión con hueco (neto contra `total`) no puede volver.
    expect(body).not.toContain("v_paid_net + v_new_net - v_total > 0.009");
    // Ni la que no redondeaba: rechazaba la liquidación entera de una factura
    // legacy con centavos (9999,99 → el cobro exacto de 10000 sobraba 0,01).
    expect(body).not.toContain(
      "v_paid_net + v_new_net - (v_total - coalesce(v_surcharge, 0)) > 0.009",
    );
  });

  it("rechaza el contraejemplo del verificador (sobrecobro del tamaño del recargo)", () => {
    // Factura 100000 con porción de tarjeta de neto 96000 (fee 4800):
    // surcharge 4800, total 104800, saldo 4000.
    const invoice = { total: 104800, surcharge: 4800 };
    expect(invoice.total - invoice.surcharge).toBe(100000);
    // 1er splitPayment {efectivo, 4000}: completa el neto facturado → pasa.
    expect(capRejects({ ...invoice, paidNet: 96000, newNet: 4000 })).toBe(false);
    // 2do splitPayment concurrente con la misma lectura vieja del saldo
    // (4000): Σnet 104000 > 100000 → RECHAZADO (antes pasaba: 104000 ≤ 104800).
    expect(capRejects({ ...invoice, paidNet: 100000, newNet: 4000 })).toBe(true);
    // El bruto que habría quedado sin el tope: 108800 > 104800.
    expect(96000 + 4800 + 4000 + 4000).toBe(108800);
    expect(108800).toBeGreaterThan(invoice.total);
  });

  it("todos los flujos legítimos siguen pasando (neto cobrado ≤ neto facturado)", () => {
    // [total, surcharge, paidNet, newNet, etiqueta]
    const legit: Array<[number, number, number, number, string]> = [
      [100000, 0, 0, 100000, "emitir con efectivo"],
      [105000, 5000, 0, 100000, "emitir con tarjeta (neto 100000, fee 5000)"],
      [103000, 3000, 0, 40000, "emitir mixto, porción 1 (efectivo 40000)"],
      [103000, 3000, 0, 60000, "emitir mixto, porción 2 (tarjeta 60000)"],
      [100000, 0, 0, 100000, "pagar después en efectivo"],
      [100000, 0, 0, 100000, "pagar después con tarjeta (bruto 105000 > total)"],
      [100000, 0, 40000, 60000, "parcial de caja + resto"],
      [100000, 0, 0, 60000, "carrera: primero de dos parciales de 60000"],
      [104800, 4800, 96000, 4000, "cobro del saldo con recargo emitido"],
    ];
    const rejected = legit
      .map(([total, surcharge, paidNet, newNet, label]) => ({
        label,
        rejected: capRejects({ total, surcharge, paidNet, newNet }),
      }))
      .filter((row) => row.rejected);
    expect(rejected).toEqual([]);
  });

  it("sigue rechazando las carreras sin recargo (no hay regresión del tope)", () => {
    // Dos cobros completos concurrentes de 100000 sobre una factura de 100000.
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 0, newNet: 100000 })).toBe(false);
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 100000, newNet: 100000 })).toBe(true);
    // Dos parciales de 60000: el segundo ya supera el neto facturado.
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 60000, newNet: 60000 })).toBe(true);
  });
});

// ------- T0-a (Defecto 2): el espejo primero, reversa verificada ---

describe("cash: T0-a (Defecto 2) el espejo va antes que la fila de cajón", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );
  const start = service.indexOf("export async function registerPayment");
  const body = service.slice(start, service.indexOf("export async function", start + 10));

  it("escribe invoice_payments antes de payments (no puede dejar un huérfano invisible)", () => {
    const mirror = body.indexOf('.from("invoice_payments")');
    const drawer = body.indexOf('.from("payments")');
    expect(mirror).toBeGreaterThan(-1);
    expect(drawer).toBeGreaterThan(mirror);
    // La fila de cajón con factura solo existe si el espejo ya existe.
    expect(body.slice(drawer)).toContain("invoice_id: input.invoice_id ?? null");
  });

  it("la reversa del espejo verifica el error del DELETE y grita la falla", () => {
    expect(body).toMatch(
      /const \{ error: rollbackError \} = await db\s*\.from\("invoice_payments"\)\s*\.delete\(\)\s*\.eq\("id", mirrorId\)/,
    );
    expect(body).toContain("if (rollbackError) {");
    expect(body).toContain('"PAYMENT_ROLLBACK_FAILED"');
    expect(body).toContain("console.error(");
    // Ninguna reversa sobre `payments` queda sin comprobar (la del defecto).
    expect(body).not.toContain('db.from("payments").delete()');
  });

  it("el catch externo no puede tragarse el error gritado", () => {
    // toCashError devuelve el CashError tal cual: el código llega al caller.
    expect(service).toContain("if (error instanceof CashError) return error;");
    expect(body).toContain("throw toCashError(error);");
  });

  it("el espejo fallido no deja nada que revertir (P0001 → OVERPAID)", () => {
    const mirrorBlock = body.slice(
      body.indexOf('.from("invoice_payments")'),
      body.indexOf('.from("payments")'),
    );
    expect(mirrorBlock).toContain('const code = (mirrorError as { code?: string } | null)?.code;');
    // CL-3: la misma rama reconoce TAMBIÉN el 23505 del índice único de
    // identidad (042): las dos barreras del INSERT se atienden igual.
    expect(mirrorBlock).toContain('if (code === "23505" || code === "P0001") {');
    expect(mirrorBlock).toContain('throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);');
    // El recorte es la rama del INSERT fallido, que es la que no tiene fila que
    // borrar. La rama del insert SIN fila confirmada sí compensa (Defecto 3,
    // asertado aparte): su `.delete()` vive después de este recorte.
    //
    // T0-b: antes este tramo salía de `slice(indexOf("if (mirrorError) {"),
    // indexOf("if (!mirror) {"))`. Con esos dos índices invertidos (o en -1) el
    // recorte quedaba vacío y la negación de abajo pasaba sin mirar nada. Ahora
    // cada rama se extrae por llaves balanceadas (falla si no existe o no
    // cierra) y el orden se asevera de forma explícita.
    const mirrorErrorStart = body.indexOf("if (mirrorError) {");
    const notMirrorStart = body.indexOf("if (!mirror) {");
    expect(mirrorErrorStart, "la rama del INSERT fallido debe existir").toBeGreaterThan(-1);
    expect(notMirrorStart, "la rama sin fila confirmada debe existir").toBeGreaterThan(-1);
    expect(notMirrorStart, "`!mirror` va después de `mirrorError`").toBeGreaterThan(
      mirrorErrorStart,
    );
    const mirrorErrorBranch = extractBranch(body, "if (mirrorError) {");
    const notMirrorBranch = extractBranch(body, "if (!mirror) {");
    // Positivas de contenido: si el recorte se rompiera, estas dos fallan.
    expect(mirrorErrorBranch).toContain('"OVERPAID"');
    expect(notMirrorBranch).toContain('.eq("id", mirrorIdCandidate)');
    // Y solo entonces la negación, sobre un bloque que existe de verdad.
    expect(mirrorErrorBranch).not.toContain(".delete()");
  });
});

// ------- T0-a (Defecto 1/2): recargo derivado del bruto y saldo NETO -------

describe("cash: T0-a (Defecto 1/2) el cobro de caja deriva el recargo del BRUTO", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );
  const start = service.indexOf("export async function registerPayment");
  const body = service.slice(start, service.indexOf("export async function", start + 10));
  const mirror = body.slice(
    body.indexOf('.from("invoice_payments")'),
    body.indexOf('.from("payments")'),
  );

  it("la fila espejo lleva el recargo y el porcentaje, no el DEFAULT 0", () => {
    expect(mirror).toContain("fee_percent: feePercent");
    expect(mirror).toContain("fee_amount: cardFee.fee");
    // El porcentaje sale del método cobrado (payment_methods.fee_percent: el
    // mismo snapshot que escribe billing al emitir; 019).
    expect(body).toContain("Math.max(0, Number(method.fee_percent) || 0)");
  });

  it("el bruto se redondea una sola vez y es el que va a las dos filas", () => {
    expect(body).toContain("const gross = roundMoney(input.amount);");
    expect(body).toContain("splitGrossCardFee(gross, feePercent)");
    expect(body).toContain("amount: gross");
    // El INSERT crudo (sin centavos normalizados) no puede volver: la fila
    // espejo y la de cajón tienen que guardar el mismo monto.
    expect(body).not.toContain("amount: input.amount");
  });

  it("la factura se marca Pagada por NETO, no por bruto contra total", () => {
    expect(body).toContain("invoiceNetBalance({");
    expect(body).toContain(
      "invoiceBalance.netCollected + cardFee.net - invoiceBalance.netBilled > 0.009",
    );
    expect(body).toContain(
      "moneyEquals(roundMoney(invoiceBalance.netCollected + cardFee.net), invoiceBalance.netBilled)",
    );
    // Los dos chequeos viejos (bruto de caja contra el total) no pueden volver.
    expect(body).not.toContain("roundMoney(invoicePaid + input.amount)");
    expect(body).not.toContain("moneyEquals(paid, invoiceTotal)");
  });

  it("el id del espejo se conoce ANTES del INSERT (compensación exacta)", () => {
    const declared = body.indexOf("const mirrorIdCandidate = randomUUID();");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(body.indexOf('.from("invoice_payments")'));
    expect(mirror).toContain("id: mirrorIdCandidate,");
  });

  it("Defecto 3: la rama sin fila confirmada compensa por id y grita", () => {
    const branch = body.slice(
      body.indexOf("if (!mirror)"),
      body.indexOf("mirrorId = mirrorIdCandidate"),
    );
    expect(branch).toContain("console.error(");
    expect(branch).toContain('.eq("id", mirrorIdCandidate)');
    // Compensación fallida: mismo desenlace ya conocido para el operador.
    expect(branch).toContain('"PAYMENT_ROLLBACK_FAILED"');
    // Compensada: nada quedó escrito y se dice con código propio (no genérico).
    expect(branch).toContain('"MIRROR_UNCONFIRMED"');
    expect(branch).not.toContain('"INTERNAL"');
  });
});

describe("cash: T0-a (Defecto 1/2) aritmética del recargo y del saldo (puro)", () => {
  const TARJETA = 5;
  const tarjeta = (code: string): number => (code === "tarjeta" ? TARJETA : 0);
  const round2 = (value: number): number => Math.round(value * 100) / 100;

  /**
   * Réplica pura del tope de 031 (`trg_invoice_payments_cap`; ver el test
   * estructural de la migración más abajo y el bloque de Defecto 1): el neto
   * cobrado nunca excede el neto facturado COBRABLE —redondeado a peso entero
   * (`roundMoney`), porque el datafono no acepta centavos—. Tolerancia de
   * centavo (0.009).
   */
  function capRejects(args: {
    total: number;
    surcharge: number;
    paidNet: number;
    newNet: number;
  }): boolean {
    return args.paidNet + args.newNet - roundMoney(args.total - args.surcharge) > 0.009;
  }

  it("deriva el recargo del BRUTO entregado: inversa de computeCardFees", () => {
    expect(splitGrossCardFee(105000, TARJETA)).toEqual({ net: 100000, fee: 5000 });
    expect(splitGrossCardFee(52500, TARJETA)).toEqual({ net: 50000, fee: 2500 });
    expect(splitGrossCardFee(4200, TARJETA)).toEqual({ net: 4000, fee: 200 });
    // Sin recargo el neto es el bruto (efectivo/nequi).
    expect(splitGrossCardFee(100000, 0)).toEqual({ net: 100000, fee: 0 });
    // Invariante de la fila: `amount − fee_amount` es el neto, y volver a
    // derivar del bruto reconstruye el mismo par. Peso entero: el bruto se
    // normaliza al peso (lo que el datafono cobra), así que `net + fee` es el
    // bruto ENTERO y no el bruto crudo de entrada. CAMBIÓ: antes `net + fee`
    // cuadraba al centavo contra el bruto crudo de entrada.
    for (const gross of [0.16, 1, 999.99, 4200, 105000, 1234567.89]) {
      const whole = roundMoney(gross);
      const { net, fee } = splitGrossCardFee(gross, TARJETA);
      expect(net + fee).toBe(whole);
      expect(splitGrossCardFee(net + fee, TARJETA)).toEqual({ net, fee });
    }
    // Borde del medio peso: sube (half-up), como el total del datafono.
    expect(splitGrossCardFee(1.5, 0)).toEqual({ net: 2, fee: 0 });
  });

  it("el saldo neto descuenta el recargo emitido y los recargos cobrados", () => {
    // Factura de neto 100000 emitida con una porción de tarjeta de neto 96000:
    // surcharge 4800, total 104800; la porción guarda bruto 100800 + fee 4800.
    expect(
      invoiceNetBalance({
        total: 104800,
        surcharge: 4800,
        payments: [{ amount: 100800, fee_amount: 4800 }],
      }),
    ).toEqual({ netBilled: 100000, netCollected: 96000, netRemaining: 4000 });
    // Sin cobros el saldo es el neto facturado (el recargo emitido no es saldo).
    expect(invoiceNetBalance({ total: 104800, surcharge: 4800, payments: [] }).netRemaining).toBe(
      100000,
    );
    // Normaliza numeric que llega como string (mismo criterio que el resto).
    expect(
      invoiceNetBalance({
        total: "104800.00",
        surcharge: "4800.00",
        payments: [{ amount: "100800.00", fee_amount: "4800.00" }],
      }).netRemaining,
    ).toBe(4000);
  });

  /** Un intento de cobro del módulo de caja, resuelto como lo hace el servicio. */
  function replayCash(args: {
    total: number;
    surcharge: number;
    rows: Array<{ amount: number; fee_amount: number }>;
    collections: Array<{ method_code: string; gross: number }>;
  }): { verdicts: string[]; rows: Array<{ amount: number; fee_amount: number }> } {
    const rows = args.rows.map((row) => ({ ...row }));
    const verdicts: string[] = [];
    for (const collection of args.collections) {
      const gross = round2(collection.gross);
      const { net, fee } = splitGrossCardFee(gross, tarjeta(collection.method_code));
      const balance = invoiceNetBalance({
        total: args.total,
        surcharge: args.surcharge,
        payments: rows,
      });
      // 1) Chequeo del servicio: mismo tope y misma tolerancia que el trigger.
      const serviceBlocks = balance.netCollected + net - balance.netBilled > 0.009;
      // 2) Lo que evalúa `trg_invoice_payments_cap` con lo YA escrito.
      const capBlocks = capRejects({
        total: args.total,
        surcharge: args.surcharge,
        paidNet: balance.netCollected,
        newNet: net,
      });
      // Nunca pueden discrepar: si el servicio acepta, la fila entra con ese
      // neto, así que el tope de la base tiene que aceptarla también.
      expect(capBlocks).toBe(serviceBlocks);
      verdicts.push(serviceBlocks ? "OVERPAID" : "ACCEPT");
      if (!serviceBlocks) rows.push({ amount: gross, fee_amount: fee });
    }
    return { verdicts, rows };
  }

  it("ningún flujo legítimo es rechazado (ni por el servicio ni por el tope)", () => {
    const flows: Array<{
      label: string;
      total: number;
      surcharge: number;
      rows: Array<{ amount: number; fee_amount: number }>;
      collections: Array<{ method_code: string; gross: number }>;
      expect: string[];
    }> = [
      {
        label: "contado: la factura se cobra completa en efectivo",
        total: 100000,
        surcharge: 0,
        rows: [],
        collections: [{ method_code: "efectivo", gross: 100000 }],
        expect: ["ACCEPT"],
      },
      {
        label: "tarjeta: bruto 105000 sobre una factura de 100000 sin cobro emitido",
        total: 100000,
        surcharge: 0,
        rows: [],
        collections: [{ method_code: "tarjeta", gross: 105000 }],
        expect: ["ACCEPT"],
      },
      {
        label: "mixto: efectivo 40000 + tarjeta 63000 (netos 40000 + 60000)",
        total: 100000,
        surcharge: 0,
        rows: [],
        collections: [
          { method_code: "efectivo", gross: 40000 },
          { method_code: "tarjeta", gross: 63000 },
        ],
        expect: ["ACCEPT", "ACCEPT"],
      },
      {
        label: "parcial: dos porciones de tarjeta (30000 + 70000 de neto)",
        total: 100000,
        surcharge: 0,
        rows: [],
        collections: [
          { method_code: "tarjeta", gross: 31500 },
          { method_code: "tarjeta", gross: 73500 },
        ],
        expect: ["ACCEPT", "ACCEPT"],
      },
      {
        label: "saldo de una factura con recargo emitido (caso de 031)",
        total: 104800,
        surcharge: 4800,
        rows: [{ amount: 100800, fee_amount: 4800 }],
        collections: [{ method_code: "tarjeta", gross: 4200 }],
        expect: ["ACCEPT"],
      },
      {
        label: "instalment sobre una factura ya cobrada por tarjeta desde billing",
        total: 100000,
        surcharge: 0,
        rows: [{ amount: 105000, fee_amount: 5000 }],
        collections: [{ method_code: "tarjeta", gross: 105000 }],
        expect: ["OVERPAID"],
      },
      {
        // U1-fix: factura emitida antes de la regla del peso entero, con
        // centavos en su neto facturado (9999,99). El datafono no acepta
        // centavos, así que el cliente entregó 10000: el cobro entero la
        // cierra. Antes el servicio veía 10000 − 9999,99 = 0,01 > 0,009 y la
        // marcaba OVERPAID (y el mismo tope la habría rechazado en la BD).
        label: "legacy con centavos: el cobro entero de 10000 la cierra",
        total: 9999.99,
        surcharge: 0,
        rows: [],
        collections: [{ method_code: "efectivo", gross: 10000 }],
        expect: ["ACCEPT"],
      },
      {
        // El sobrecobro GENUINO de la misma factura legacy sigue rechazándose:
        // 10001 supera el neto cobrable (10000) en un peso entero.
        label: "legacy con centavos: un peso de más sigue siendo sobrecobro",
        total: 9999.99,
        surcharge: 0,
        rows: [],
        collections: [{ method_code: "efectivo", gross: 10001 }],
        expect: ["OVERPAID"],
      },
    ];
    for (const flow of flows) {
      const { verdicts } = replayCash(flow);
      expect({ label: flow.label, verdicts }).toEqual({ label: flow.label, verdicts: flow.expect });
    }
  });

  it("el cobro con tarjeta de una factura sin cobro ya no es un sobrepago falso", () => {
    const { net, fee } = splitGrossCardFee(105000, TARJETA);
    const balance = invoiceNetBalance({ total: 100000, surcharge: 0, payments: [] });
    expect(net).toBe(balance.netRemaining);
    expect(fee).toBe(5000);
    // Antes: el servicio comparaba el BRUTO contra el total (105000 − 100000 =
    // 5000 > 0.009 → OVERPAID) y, sin fee en la fila, el tope veía 105000.
    expect(round2(105000) - 100000).toBeGreaterThan(0.009);
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 0, newNet: 105000 })).toBe(true);
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 0, newNet: net })).toBe(false);
  });

  it("el recargo cobrado queda registrado en la fila (reconciliación del surcharge)", () => {
    // Emitida sin recargo (surcharge 0) y cobrada con tarjeta: la fila guarda su
    // fee (antes tomaba el DEFAULT 0 y el recargo era irrecuperable).
    const { net, fee } = splitGrossCardFee(105000, TARJETA);
    expect(fee).toBe(5000);
    expect(net).toBe(100000);
    // Factura con recargo emitido: la porción emitida reconcilia el snapshot y
    // la porción posterior suma su propio fee (019: el recargo de un cobro
    // posterior no se agrega al total, pero sí se cobra y se registra).
    const emitted = { amount: 100800, fee_amount: 4800 };
    const later = { amount: 4200, fee_amount: 200 };
    const invoice = { total: 104800, surcharge: 4800 };
    expect(emitted.fee_amount).toBe(invoice.surcharge);
    const closed = invoiceNetBalance({
      total: invoice.total,
      surcharge: invoice.surcharge,
      payments: [emitted, later],
    });
    expect(closed.netCollected).toBe(closed.netBilled);
    expect(closed.netRemaining).toBe(0);
    expect([emitted, later].reduce((acc, row) => acc + row.fee_amount, 0)).toBe(5000);
  });

  it("un cobro posterior de billing exige el NETO pendiente, no `total − Σbruto`", () => {
    // Caja cobró un parcial con tarjeta: bruto 52500, neto 50000, fee 2500.
    const previous = [{ amount: 52500, fee_amount: 2500 }];
    const balance = invoiceNetBalance({ total: 100000, surcharge: 0, payments: previous });
    expect(balance.netRemaining).toBe(50000);
    // La fórmula anterior (`total − detail.paid`, bruto) daba 47500: rechazaba
    // una porción legítima de neto 50000 (OVERPAID) y con 47500 dejaba 2500 sin
    // cobrar marcando la factura Pagada.
    const grossPaid = previous.reduce((acc, row) => acc + row.amount, 0);
    expect(round2(100000 - grossPaid)).toBe(47500);
    const portion = splitGrossCardFee(52500, TARJETA);
    expect(portion.net).toBe(balance.netRemaining);
    expect(
      capRejects({ total: 100000, surcharge: 0, paidNet: balance.netCollected, newNet: portion.net }),
    ).toBe(false);
  });
});

describe("billing: T0-a (Defecto 2) el cobro posterior exige el saldo NETO", () => {
  const billing = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  );
  const split = billing.slice(billing.indexOf("export async function splitPayment"));

  it("splitPayment compara las porciones contra invoiceNetBalance", () => {
    expect(split).toContain("invoiceNetBalance({");
    expect(split).toContain("netSum - balance.netRemaining");
    expect(split).toContain("balance.netCollected + netSum - balance.netBilled");
    // El bruto contra total (el saldo corto) no puede volver al código: la
    // mención en el comentario no cuenta como uso.
    expect(split).not.toMatch(/round2\(Number\(detail\.invoice\.total\) - detail\.paid\)/);
  });

  it("el Saldo que ve la UI es el mismo que exige el cobro", () => {
    expect(billing).toContain("remaining: round2(Math.max(0, balance.netRemaining))");
    expect(billing).not.toContain("remaining: round2(Math.max(0, Number(invoice.total) - paid))");
  });
});

// ------------- T0-a: total y número de facturas cobradas (puro) ---

describe("cash: total y número de facturas cobradas del turno (puro)", () => {
  it("suma los cobros y cuenta facturas distintas (varias porciones = una)", () => {
    expect(
      invoiceCollectionsSummary([
        { invoice_id: "f1", amount: 60000 },
        { invoice_id: "f1", amount: 40000 },
        { invoice_id: "f2", amount: 25000 },
      ]),
    ).toEqual({ total: 125000, count: 2 });
  });

  it("normaliza montos string a peso entero y degrada a cero sin cobros", () => {
    // CAMBIÓ con la regla del peso entero: antes 1000.555 → 1000.56.
    expect(invoiceCollectionsSummary([{ invoice_id: "f1", amount: "1000.555" }])).toEqual({
      total: 1001,
      count: 1,
    });
    expect(invoiceCollectionsSummary([])).toEqual({ total: 0, count: 0 });
  });
});

describe("cash: T0-a (C1) los lectores ya no unen el ledger completo", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );

  /**
   * Cadena desde cada `.from("<tabla>")` hasta el siguiente `.from(`: cubre la
   * consulta y su manejo de error inmediato.
   */
  function dbChains(source: string, table: string): string[] {
    return source
      .split(`.from("${table}")`)
      .slice(1)
      .map((chunk) => {
        const end = chunk.indexOf(".from(");
        return end === -1 ? chunk : chunk.slice(0, end);
      });
  }

  it("los tres lectores de payments filtran invoice_id IS NULL", () => {
    const selects = dbChains(service, "payments").filter((chain) =>
      chain.trimStart().startsWith(".select("),
    );
    // Los tres LECTORES del arqueo (cierre, vista del día, historial) excluyen
    // los pagos con factura: ese dinero ya vive en `invoice_payments` y sumarlo
    // acá lo contaría dos veces.
    const readers = selects.filter((chain) => chain.includes('.is("invoice_id", null)'));
    expect(readers).toHaveLength(3);
    for (const chain of readers) {
      expect(chain).toContain('.is("invoice_id", null)');
    }
    // CL-3: la CUARTA cadena de `payments` es otra cosa —la búsqueda de la fila
    // de cajón del intento GANADOR, para devolverla en una repetición— y filtra
    // por factura EXACTA, no por ausencia de factura. Se pincha para que el
    // conjunto de arriba no pueda crecer en silencio.
    const repeatLookups = selects.filter((chain) =>
      chain.includes('.eq("invoice_id", winner.invoice_id)'),
    );
    expect(repeatLookups).toHaveLength(1);
    // CL-4: la QUINTA cadena de `payments` es el lookup por MARCA del libro de
    // cajón (el pago SIN factura, cuya identidad es esa fila), que filtra por
    // TURNO y marca, no por factura. Se pincha por la misma razón que la
    // anterior: que el conjunto no pueda crecer en silencio, porque ninguna de
    // estas cadenas es un lector del arqueo.
    const markLookups = selects.filter((chain) =>
      chain.includes('.eq("idempotency_key", idempotencyKey)'),
    );
    expect(markLookups).toHaveLength(1);
    expect(selects).toHaveLength(5);
  });

  it("la fila espejo de invoice_payments lleva el turno que cobra", () => {
    const mirror = dbChains(service, "invoice_payments").find((chain) =>
      chain.trimStart().startsWith(".insert("),
    );
    expect(mirror).toBeDefined();
    expect(mirror).toContain("cash_shift_id: shift.id");
  });

  it("el cierre solo pisa un turno abierto (ni doble cierre ni conteos dobles)", () => {
    const start = service.indexOf("export async function closeShift");
    const close = service.slice(start, service.indexOf("export async function", start + 10));
    const updates = dbChains(close, "cash_shifts").filter((chain) =>
      chain.trimStart().startsWith(".update("),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('.eq("status", "abierto")');
    expect(close).toContain('"SHIFT_ALREADY_CLOSED"');
  });

  it("traduce P0001 del tope de factura a OVERPAID (C2)", () => {
    expect(service).toContain('const code = (mirrorError as { code?: string } | null)?.code;');
    expect(service).toContain('if (code === "23505" || code === "P0001") {');
    expect(service).toContain(
      'throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);',
    );
  });

  it("la rama sin turno sigue viva solo por filas NULL (no solapa)", () => {
    const fetcher = service.slice(service.indexOf("async function fetchInvoicePaymentsByShift"));
    expect(fetcher).toContain('.is("cash_shift_id", null)');
    expect(fetcher).toContain('.in("cash_shift_id", shiftIds)');
  });
});

describe("billing: T0-a (C2) tope de cobro en BD traducido a OVERPAID", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  );

  it("los dos INSERT de invoice_payments traducen P0001 a OVERPAID", () => {
    const inserts = service
      .split('.from("invoice_payments")')
      .slice(1)
      .map((chunk) => {
        const end = chunk.indexOf(".from(");
        return end === -1 ? chunk : chunk.slice(0, end);
      })
      .filter((chain) => chain.trimStart().startsWith(".insert("));
    expect(inserts).toHaveLength(2); // emitir con pago / cobrar después
    for (const chain of inserts) {
      expect(chain).toContain('"P0001"');
      expect(chain).toContain('"OVERPAID"');
    }
  });
});

describe("migración 031_cash_invoice_payment_integrity.sql (T0-a)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "031_cash_invoice_payment_integrity.sql"),
    "utf8",
  );

  it("backfillea solo filas con cash_shift_id NULL y nunca borra", () => {
    expect(sql).toContain("UPDATE public.invoice_payments");
    expect(sql.match(/pay\.cash_shift_id IS NULL/g)).toHaveLength(2);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it("atribuye primero al turno que cobró y cae al turno de emisión", () => {
    expect(sql).toContain("FROM public.payments");
    expect(sql).toContain("HAVING count(DISTINCT cash_shift_id) = 1");
    expect(sql).toContain("SET cash_shift_id = inv.cash_shift_id");
    expect(sql).toContain("FROM public.invoices AS inv");
  });

  it("el backfill corre antes de crear el trigger (orden deliberado)", () => {
    expect(sql.indexOf("UPDATE public.invoice_payments")).toBeLessThan(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.check_invoice_payments_cap"),
    );
  });

  it("el trigger replica trg_payroll_payments_cap y bloquea el padre", () => {
    expect(sql).toContain("BEFORE INSERT ON public.invoice_payments");
    expect(sql).toContain("FOR EACH ROW EXECUTE FUNCTION public.check_invoice_payments_cap()");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("DROP TRIGGER IF EXISTS trg_invoice_payments_cap");
    expect(sql).toContain("CREATE TRIGGER trg_invoice_payments_cap");
    expect(sql).toContain("SET search_path = public");
  });

  it("el tope usa la porción NETA (el recargo no es saldo facturado)", () => {
    const body = sql.slice(sql.indexOf("check_invoice_payments_cap()"));
    expect(body).toContain("coalesce(NEW.amount, 0) - coalesce(NEW.fee_amount, 0)");
    expect(body).toContain("sum(amount - fee_amount)");
    expect(body).toContain("> 0.009");
    // RAISE EXCEPTION plano = P0001, el mismo código que nómina.
    expect(body).toContain("RAISE EXCEPTION");
    expect(body).not.toMatch(/errcode\s*=/);
  });

  it("no crea el índice único (shift_id, phase) incompatible con los conteos", () => {
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[\s\S]{0,200}?cash_shift_counts/);
    // La razón y la clave correcta por línea quedan documentadas en el archivo.
    expect(sql).toContain("cash_shift_counts (shift_id, phase, method_code");
  });

  it("documenta la re-atribución histórica y cómo listar los turnos afectados", () => {
    // El backfill re-atribuye cobros históricos: turnos cerrados perderán
    // dinero en su recálculo, sin asiento compensatorio (expected_cash es
    // snapshot). Quien aplique el archivo debe poder listarlos.
    expect(sql).toContain("RE-ATRIBUYE");
    expect(sql).toContain("SIN asiento compensatorio");
    expect(sql).toContain("expected_cash");
    expect(sql).toContain("turno_emisor");
    expect(sql).toContain("turno_cobrador");
  });
});

// ------- T0-b: el INSERT fallido del espejo no emite NINGÚN DELETE -------

/**
 * Estado del doble de Supabase. `vi.hoisted` lo iza junto con los `vi.mock`,
 * que en Vitest se ejecutan antes de los imports estáticos del archivo.
 */
const paymentStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  SHIFT_ID: "22222222-2222-4222-8222-222222222222",
  INVOICE_ID: "33333333-3333-4333-8333-333333333333",
  METHOD_ID: "55555555-5555-4555-8555-555555555555",
  /**
   * CL-3: el tope de 031 que replica el doble. La factura del test es la misma
   * que sirve el detalle (100000, sin recargo), así que el tope usa su
   * aritmética REAL: neto cobrado + neto nuevo ≤ round(total − recargo), con la
   * misma tolerancia de centavo que el trigger.
   */
  INVOICE_TOTAL: 100000,
  INVOICE_SURCHARGE: 0,
  /** Tablas borradas, en orden: el registro que hace observable el DELETE. */
  deleteCalls: [] as string[],
  /** Consultas que el doble no sabe responder (debería quedar siempre vacío). */
  unexpectedQueries: [] as string[],
  mirrorError: null as { code?: string; message?: string } | null,
  mirrorData: null as { id: string } | null,
  rollbackError: null as { message?: string } | null,
  /**
   * CL-3: modo TABLA EN MEMORIA. Con `true` el doble mantiene las filas REALES
   * de `invoice_payments` (el dinero cobrado de la factura) y de `payments` (el
   * libro de cajón) y aplica las DOS barreras de la base con sus códigos
   * reales: el tope de 031 (P0001, trigger BEFORE INSERT) y el índice único
   * parcial de 042 (23505). Apagado (el valor por defecto), se comporta como
   * antes de CL-3: responde `mirrorError`/`mirrorData`, que es lo que necesitan
   * los tests del espejo fallido (T0-b) para forzar cada falla del INSERT.
   */
  ledgerMode: false,
  /** Filas REALES de `invoice_payments` (lo que suma el arqueo). */
  ledger: [] as Array<Record<string, unknown>>,
  /** Filas REALES de `payments` (el libro de cajón del turno). */
  drawer: [] as Array<Record<string, unknown>>,
  /** Estado REAL de la factura: el cobro que la completa la pasa a Pagada. */
  invoiceStatus: "Emitida",
  /** Escrituras PEDIDAS por tabla (un intento cuenta aunque choque). */
  inserts: {} as Record<string, number>,
  /** Saltea el próximo lookup por marca: arma la ventana de la carrera. */
  skipMarkLookupOnce: false,
  /**
   * CL-4: saltea el próximo lookup por marca del LIBRO DE CAJÓN (`payments`).
   * Es la misma ventana que `skipMarkLookupOnce`, pero de la otra puerta: el
   * camino sin factura resuelve su turno ANTES del lookup, así que el flag del
   * espejo no sirve para armarla.
   */
  skipDrawerMarkLookupOnce: false,
  /** Error forzado del INSERT en `payments` (control negativo del 23505). */
  drawerError: null as { code?: string; message?: string } | null,
  /** Turnos ADICIONALES de la sede, para el escenario multi-turno de CL-4. */
  extraShifts: [] as Array<Record<string, unknown>>,
  /**
   * Snapshot viejo de `invoice_payments` que el detalle sirve UNA sola vez: es
   * la lectura desactualizada del saldo con la que la carrera pasa la
   * comprobación del servicio y llega hasta el INSERT, donde el tope SÍ ve la
   * fila confirmada. El intercalado se arma, no se inventa el desenlace.
   */
  stalePaymentsOnce: null as Array<Record<string, unknown>> | null,
}));

/**
 * Cliente Supabase falso y encadenable del camino de `registerPayment`.
 * Responde lo que ese camino consulta de verdad (`cash_shifts`,
 * `invoice_payments`, `payments`, `invoices`); cualquier otra consulta se
 * registra en `unexpectedQueries` y vuelve como error, para que el test falle a
 * la vista en vez de en silencio.
 *
 * CL-3: en `ledgerMode` mantiene el ESTADO que decide el defecto —las filas
 * cobradas y el libro de cajón— y las dos barreras de la base. La aritmética NO
 * se sustituye: `invoiceNetBalance` y `splitGrossCardFee` son los de producción
 * y corren de verdad contra este doble.
 */
function createStubSupabaseClient(): unknown {
  const rowsOf = (table: string): Array<Record<string, unknown>> => {
    if (table === "invoice_payments") return paymentStub.ledger;
    if (table === "payments") return paymentStub.drawer;
    if (table === "cash_shifts") {
      return [
        {
          id: paymentStub.SHIFT_ID,
          cash_register_id: "reg-1",
          sede_id: paymentStub.SEDE_ID,
          opened_by: "u-1",
          closed_by: null,
          opened_at: "2026-09-30T00:00:00.000Z",
          closed_at: null,
          opening_base: 0,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: null,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
        ...paymentStub.extraShifts,
      ];
    }
    if (table === "invoices") {
      return [
        {
          id: paymentStub.INVOICE_ID,
          sede_id: paymentStub.SEDE_ID,
          status: paymentStub.invoiceStatus,
          total: paymentStub.INVOICE_TOTAL,
          surcharge: paymentStub.INVOICE_SURCHARGE,
          cash_shift_id: paymentStub.SHIFT_ID,
        },
      ];
    }
    paymentStub.unexpectedQueries.push(`${table}.select`);
    return [];
  };

  const from = (table: string) => {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let single = false;
    let payload: unknown;
    const filterColumns: string[] = [];
    const filters: Array<[string, unknown]> = [];

    const matching = (): Array<Record<string, unknown>> =>
      rowsOf(table).filter((row) => filters.every(([column, value]) => row[column] === value));

    const respond = (): { data: unknown; error: unknown } => {
      if (table === "invoice_payments" && op === "delete") {
        paymentStub.deleteCalls.push(table);
        for (const row of matching()) {
          const at = paymentStub.ledger.indexOf(row);
          if (at >= 0) paymentStub.ledger.splice(at, 1);
        }
        return { data: null, error: paymentStub.rollbackError };
      }
      if (op === "update") {
        // El cobro que completa la factura la pasa a Pagada: el doble lo escribe
        // de verdad, para que la lectura siguiente lo vea.
        const written = (payload ?? {}) as Record<string, unknown>;
        if (table === "invoices" && typeof written.status === "string") {
          paymentStub.invoiceStatus = written.status;
        }
        const matched = matching();
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op === "insert") {
        paymentStub.inserts[table] = (paymentStub.inserts[table] ?? 0) + 1;
        if (table === "invoice_payments") {
          if (paymentStub.mirrorError) {
            return { data: paymentStub.mirrorData, error: paymentStub.mirrorError };
          }
          if (!paymentStub.ledgerMode) return { data: paymentStub.mirrorData, error: null };
          const row = (payload ?? {}) as Record<string, unknown>;
          // 1) El tope de cobro (031) es un trigger BEFORE INSERT: corre ANTES
          //    de que la fila entre al índice.
          const paidNet = paymentStub.ledger
            .filter((candidate) => candidate.invoice_id === row.invoice_id)
            .reduce(
              (acc, candidate) =>
                acc + (Number(candidate.amount) - Number(candidate.fee_amount ?? 0)),
              0,
            );
          const newNet = Number(row.amount) - Number(row.fee_amount ?? 0);
          const cap = Math.round(paymentStub.INVOICE_TOTAL - paymentStub.INVOICE_SURCHARGE);
          if (paidNet + newNet - cap > 0.009) {
            return {
              data: null,
              error: { code: "P0001", message: "El cobro supera el neto facturado de la factura" },
            };
          }
          // 2) El índice único PARCIAL (042): la marca no nula choca contra lo
          //    confirmado y aborta la sentencia entera.
          const mark = row.idempotency_key;
          if (mark !== null && mark !== undefined) {
            const clashes = paymentStub.ledger.some(
              (other) => other.invoice_id === row.invoice_id && other.idempotency_key === mark,
            );
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
          }
          const persisted = {
            id: `espejo-${paymentStub.ledger.length + 1}`,
            created_at: "2026-09-30T00:00:00.000Z",
            ...row,
          };
          paymentStub.ledger.push(persisted);
          return { data: single ? persisted : [persisted], error: null };
        }
        if (table === "payments") {
          if (paymentStub.drawerError) {
            return { data: null, error: paymentStub.drawerError };
          }
          const row = (payload ?? {}) as Record<string, unknown>;
          // CL-4: el índice único PARCIAL de 043 —a lo sumo una operación por
          // marca y turno—. La marca NULL (las filas del camino con factura y
          // las históricas) queda FUERA del índice, igual que en el real.
          const mark = row.idempotency_key;
          if (mark !== null && mark !== undefined) {
            const clashes = paymentStub.drawer.some(
              (other) =>
                other.cash_shift_id === row.cash_shift_id && other.idempotency_key === mark,
            );
            if (clashes) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "uq_payments_shift_idempotency_key"',
                },
              };
            }
          }
          const persisted = {
            id: `caja-${paymentStub.drawer.length + 1}`,
            created_at: "2026-09-30T00:00:00.000Z",
            ...row,
          };
          paymentStub.drawer.push(persisted);
          return { data: single ? persisted : [persisted], error: null };
        }
        return { data: null, error: { message: `doble sin respuesta para el insert en ${table}` } };
      }
      // SELECT. `skipMarkLookupOnce` saltea el próximo lookup POR MARCA: es la
      // ventana en la que la ganadora confirmó después de esta lectura.
      // CL-4: el libro de cajón tiene su propio flag, porque su lookup filtra
      // las MISMAS dos columnas (`cash_shift_id`, `idempotency_key`) pero vive
      // en otra tabla.
      if (
        table === "payments" &&
        filterColumns.includes("idempotency_key") &&
        paymentStub.skipDrawerMarkLookupOnce
      ) {
        paymentStub.skipDrawerMarkLookupOnce = false;
        return { data: single ? null : [], error: null };
      }
      if (filterColumns.includes("idempotency_key") && paymentStub.skipMarkLookupOnce) {
        paymentStub.skipMarkLookupOnce = false;
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
        return query;
      },
      update: (value?: unknown) => {
        op = "update";
        payload = value;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      eq: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push([column, value]);
        return query;
      },
      order: () => query,
      limit: () => query,
      single: () => {
        single = true;
        return Promise.resolve(respond());
      },
      maybeSingle: () => {
        single = true;
        return Promise.resolve(respond());
      },
      // `await` directo sobre la cadena (p. ej. `delete().eq(...)`) resuelve al
      // objeto de respuesta, igual que el PostgREST real.
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(respond()).then(onFulfilled, onRejected),
    };
    return query;
  };

  return { from };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createStubSupabaseClient(),
}));

vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  const methods = [
    {
      id: paymentStub.METHOD_ID,
      sede_id: paymentStub.SEDE_ID,
      code: "efectivo",
      name: "Efectivo",
      is_active: true,
      arqueable: true,
      fee_percent: 0,
    },
  ] as Awaited<ReturnType<typeof actual.listPaymentMethods>>;
  return { ...actual, listPaymentMethods: async () => methods };
});

vi.mock("@/src/features/billing/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/billing/service")>();
  // Solo se sustituye la lectura del detalle: `invoiceNetBalance` y
  // `splitGrossCardFee` siguen siendo los reales (vienen del spread).
  //
  // CL-3: el detalle se arma con el ESTADO del doble —las filas ya cobradas y el
  // estado real de la factura—, así que la aritmética del saldo que decide corre
  // de verdad contra lo que el intento anterior escribió. Sin eso, un test
  // podría afirmar un reintento mientras el saldo no ve nada.
  const detail = async () => {
    const payments = paymentStub.stalePaymentsOnce ?? paymentStub.ledger;
    paymentStub.stalePaymentsOnce = null;
    return {
      invoice: {
        id: paymentStub.INVOICE_ID,
        sede_id: paymentStub.SEDE_ID,
        status: paymentStub.invoiceStatus,
        total: paymentStub.INVOICE_TOTAL,
        surcharge: paymentStub.INVOICE_SURCHARGE,
        cash_shift_id: paymentStub.SHIFT_ID,
      },
      payments,
    } as unknown as Awaited<ReturnType<typeof actual.getInvoiceDetail>>;
  };
  return { ...actual, getInvoiceDetail: detail };
});

describe("cash: T0-b el INSERT fallido del espejo no emite ningún DELETE", () => {
  /** CL-3: el cobro de una factura ahora exige la marca del intento. */
  const MARK = "7c1e5a90-3b48-4d22-9e6f-0a1b2c3d4e5f";
  const input = {
    cash_shift_id: paymentStub.SHIFT_ID,
    invoice_id: paymentStub.INVOICE_ID,
    method_code: "efectivo",
    amount: 50000,
    idempotency_key: MARK,
  };
  const actor = { userId: "u-1", sedeId: paymentStub.SEDE_ID };

  beforeEach(() => {
    paymentStub.deleteCalls.length = 0;
    paymentStub.unexpectedQueries.length = 0;
    paymentStub.mirrorError = null;
    paymentStub.mirrorData = null;
    paymentStub.rollbackError = null;
    paymentStub.ledgerMode = false;
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.stalePaymentsOnce = null;
  });

  it("P0001 del tope: rechaza OVERPAID y no emite DELETE", async () => {
    paymentStub.mirrorError = { code: "P0001", message: "cap" };
    const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("error genérico del INSERT: rechaza INTERNAL y no emite DELETE", async () => {
    paymentStub.mirrorError = { code: "23514", message: "check_violation" };
    const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("control positivo: sin fila confirmada la compensación SÍ se emite", async () => {
    // Si el doble dejara de observar el DELETE, esta positiva falla: es lo que
    // convierte a las dos negaciones de arriba en una guarda y no en un vacío.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "MIRROR_UNCONFIRMED", status: 500 });
      expect(errorSpy).toHaveBeenCalled();
      expect(paymentStub.deleteCalls).toEqual(["invoice_payments"]);
      expect(paymentStub.unexpectedQueries).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("control positivo: si la compensación también falla, se emite el DELETE y se grita", async () => {
    paymentStub.rollbackError = { message: "network" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "PAYMENT_ROLLBACK_FAILED", status: 500 });
      expect(errorSpy).toHaveBeenCalled();
      expect(paymentStub.deleteCalls).toEqual(["invoice_payments"]);
      expect(paymentStub.unexpectedQueries).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------- CL-3: el cobro de caja de una factura, repetido, no cobra dos veces ----------

/**
 * CL-3: la puerta de CAJA donde un reintento duplicaba dinero, y la única que
 * acepta montos PARCIALES.
 *
 * EL DEFECTO, medido: `registerPayment` (service.ts) escribe el espejo de la
 * factura (`invoice_payments`) SIN marca del envío y —a diferencia del cobro
 * dividido— acepta una porción MENOR que el saldo. El tope de 031 usa la misma
 * aritmética (neto cobrado + neto nuevo ≤ neto facturado), así que con
 * 2 × entrante ≤ saldo tampoco frena nada: un cobro parcial reintentado
 * insertaba el espejo DOS veces y el arqueo —que suma ese ledger— cobraba el
 * dinero dos veces. El test de abajo lo pincha con la fila espejo como unidad
 * de medida.
 *
 * LA DECISIÓN es la misma de la emisión (041), del abono de nómina y del cobro
 * dividido (042): dos envíos iguales son UNA operación, y se reconocen por la
 * MARCA del intento que manda el llamador, no por el contenido.
 *
 * LA FORMA: acá NO está la arruga de "la marca en la primera porción" de 042.
 * Este camino escribe UNA sola fila (un `insert` de un objeto, no de un
 * arreglo), así que la marca vive en esa única fila, el índice único parcial
 * nunca puede rechazar una operación legítima y no hay hermanas que enumerar.
 */
describe("cash: CL-3 el reintento de un cobro de factura no cobra dos veces", () => {
  const ACTOR = { userId: "u-1", sedeId: paymentStub.SEDE_ID };
  /** Marca del intento; la segunda existe para el control de no-sobrealcance. */
  const MARK = "6b1f9d3e-4a27-4c58-9f10-2d7e5b8c0a31";
  const OTHER_MARK = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

  /**
   * Cobro PARCIAL por defecto (50000 de 100000): deja saldo, así que el tope de
   * 031 —y la comprobación del servicio, que usan la MISMA aritmética— pasan
   * las dos veces. Es exactamente el caso del defecto.
   */
  const collection = (mark = MARK, amount = 50000) => ({
    cash_shift_id: paymentStub.SHIFT_ID,
    invoice_id: paymentStub.INVOICE_ID,
    method_code: "efectivo",
    amount,
    idempotency_key: mark,
  });

  const mirrorInserts = () => paymentStub.inserts.invoice_payments ?? 0;
  const drawerInserts = () => paymentStub.inserts.payments ?? 0;

  /**
   * La ganadora de una carrera: su fila espejo (con la marca) y su fila de
   * cajón, ya confirmadas. Se siembran para que el intento perdedor tenga
   * contra quién chocar, y para que el reconocimiento tenga algo que releer.
   */
  function seedWinner(amount: number, mark: string): void {
    paymentStub.ledger.push({
      id: "espejo-ganador",
      invoice_id: paymentStub.INVOICE_ID,
      method_id: paymentStub.METHOD_ID,
      method_code: "efectivo",
      amount,
      fee_percent: 0,
      fee_amount: 0,
      cash_shift_id: paymentStub.SHIFT_ID,
      created_at: "2026-09-30T00:00:00.000Z",
      idempotency_key: mark,
    });
    paymentStub.drawer.push({
      id: "caja-ganador",
      sede_id: paymentStub.SEDE_ID,
      cash_shift_id: paymentStub.SHIFT_ID,
      invoice_id: paymentStub.INVOICE_ID,
      method_id: paymentStub.METHOD_ID,
      method_code: "efectivo",
      amount,
      user_id: "u-1",
      created_at: "2026-09-30T00:00:00.000Z",
    });
  }

  beforeEach(() => {
    paymentStub.deleteCalls.length = 0;
    paymentStub.unexpectedQueries.length = 0;
    paymentStub.mirrorError = null;
    paymentStub.mirrorData = null;
    paymentStub.rollbackError = null;
    paymentStub.ledgerMode = true;
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.stalePaymentsOnce = null;
  });

  it("el reintento del MISMO envío escribe el espejo UNA vez (el dinero se cobra una vez)", async () => {
    const first = await registerPayment(collection(), ACTOR);
    const repeat = await registerPayment(collection(), ACTOR);

    // El dinero cobrado, medido donde el arqueo lo suma: UNA sola fila espejo.
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.ledger[0]).toMatchObject({ amount: 50000, idempotency_key: MARK });
    expect(mirrorInserts()).toBe(1);
    expect(drawerInserts()).toBe(1);
    // Y el reintento es un no-op EXITOSO: el mismo resultado, sin escribir nada.
    expect(repeat).toEqual(first);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("una marca DISTINTA sí cobra otra vez (control de no-sobrealcance)", async () => {
    await registerPayment(collection(MARK), ACTOR);
    await registerPayment(collection(OTHER_MARK), ACTOR);

    // La marca reconoce UNA operación, no encadena cobros: dos intentos
    // distintos con el mismo monto son dos cobros parciales legítimos.
    expect(paymentStub.ledger).toHaveLength(2);
    expect(paymentStub.ledger.map((row) => row.idempotency_key)).toEqual([MARK, OTHER_MARK]);
    expect(mirrorInserts()).toBe(2);
    expect(drawerInserts()).toBe(2);
    // Y con el segundo se completa el saldo: la factura queda Pagada.
    expect(paymentStub.invoiceStatus).toBe("Pagada");
  });

  it("un cobro que COMPLETA el saldo también se reconoce (la marca va antes del saldo)", async () => {
    const first = await registerPayment(collection(MARK, 100000), ACTOR);
    expect(paymentStub.invoiceStatus).toBe("Pagada");

    const repeat = await registerPayment(collection(MARK, 100000), ACTOR);

    // Sin la marca ANTES de la comprobación del saldo, este reintento moría con
    // OVERPAID (el saldo ya está en cero) por una operación que SÍ se registró:
    // es la misma historia que el cobro dividido, y acá el tope tampoco lo salva.
    expect(repeat).toEqual(first);
    expect(paymentStub.ledger).toHaveLength(1);
    expect(mirrorInserts()).toBe(1);
    expect(drawerInserts()).toBe(1);
  });

  it("la carrera por el ÍNDICE (23505) relee a la ganadora", async () => {
    seedWinner(50000, MARK);
    // La ganadora confirmó DESPUÉS de la lectura de esta petición: el lookup por
    // marca no la vio y este intento llega al INSERT, donde choca con el índice
    // único parcial de 042.
    paymentStub.skipMarkLookupOnce = true;

    const result = await registerPayment(collection(), ACTOR);

    // No vacuidad: el INSERT se intentó (si el lookup lo hubiera frenado, este
    // contador sería 0) y lo frenó el índice.
    expect(mirrorInserts()).toBe(1);
    expect(paymentStub.ledger).toHaveLength(1);
    // Y no escribió un segundo libro de cajón: devuelve el de la ganadora.
    expect(drawerInserts()).toBe(0);
    expect(result.payment).toMatchObject({ id: "caja-ganador", amount: 50000 });
    expect(result.invoice_id).toBe(paymentStub.INVOICE_ID);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("la carrera por el TOPE (P0001) relee a la ganadora", async () => {
    seedWinner(100000, MARK);
    // La lectura del saldo es vieja (no ve a la ganadora) y la marca tampoco se
    // vio: esta petición pasa la comprobación del servicio y llega al INSERT,
    // donde el trigger de 031 SÍ ve la fila confirmada y rechaza.
    paymentStub.stalePaymentsOnce = [];
    paymentStub.skipMarkLookupOnce = true;

    const result = await registerPayment(collection(MARK, 50000), ACTOR);

    expect(mirrorInserts()).toBe(1);
    expect(paymentStub.ledger).toHaveLength(1);
    expect(drawerInserts()).toBe(0);
    expect(result.payment).toMatchObject({ id: "caja-ganador", amount: 100000 });
  });

  it("control negativo: sin ganadora, un 23505 NO se disfraza de repetición", async () => {
    paymentStub.mirrorError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "uq_invoice_payments_invoice_idempotency_key"',
    };

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(paymentStub.ledger).toHaveLength(0);
    expect(drawerInserts()).toBe(0);
  });

  it("control negativo: una marca nueva no vuelve cobrable lo que el saldo rechaza", async () => {
    seedWinner(90000, OTHER_MARK);

    const failure: unknown = await registerPayment(collection(MARK, 50000), ACTOR).catch(
      (error: unknown) => error,
    );

    // La marca no relaja la aritmética: el saldo y el tope siguen mandando.
    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect(mirrorInserts()).toBe(0);
    expect(paymentStub.ledger).toHaveLength(1);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    // La marca es OBLIGATORIA para cobrar una factura: un envío sin marca no se
    // puede reconocer como repetición, y la ruta REST es justo la superficie que
    // reintenta sobre redes. El rechazo es ruidoso y no escribe nada.
    const withoutMark: unknown = await registerPayment(
      { ...collection(), idempotency_key: undefined },
      ACTOR,
    ).catch((error: unknown) => error);
    const malformed: unknown = await registerPayment(
      { ...collection(), idempotency_key: "no-es-un-uuid" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(CashError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(CashError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(mirrorInserts()).toBe(0);
    expect(drawerInserts()).toBe(0);
    expect(paymentStub.ledger).toHaveLength(0);
  });

  it("un pago SIN factura exige marca y sigue escribiendo sólo el cajón", async () => {
    const result = await registerPayment(
      {
        cash_shift_id: paymentStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 30000,
        idempotency_key: MARK,
      },
      ACTOR,
    );

    // La fila de un pago sin factura vive sólo en `payments`: la marca la lleva
    // ESA fila (columna e índice de 043, CL-4), que es la única escritura de la
    // operación. Antes de la 043 este envío no exigía marca y un reintento
    // escribía una segunda fila que el arqueo sumaba dos veces.
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.drawer[0]).toMatchObject({
      invoice_id: null,
      amount: 30000,
      idempotency_key: MARK,
    });
    expect(paymentStub.ledger).toHaveLength(0);
    expect(mirrorInserts()).toBe(0);
    expect(result.invoice_id).toBeNull();
    expect(result.invoice_status).toBeNull();
  });

  it("el esquema exige la marca para cobrar una factura (y también para un pago de cajón)", () => {
    const base = { method_code: "efectivo", amount: 50000 };
    // Pago sin factura: la marca TAMBIÉN se exige (CL-4). Su fila vive en
    // `payments`, que a partir de la 043 tiene columna de marca: sin ella el
    // reintento duplicaba el efectivo del turno.
    expect(registerPaymentSchema.safeParse(base).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ ...base, invoice_id: null }).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ ...base, idempotency_key: MARK }).success).toBe(true);
    // Cobro de factura: sin marca o con una mal formada, se rechaza.
    expect(
      registerPaymentSchema.safeParse({ ...base, invoice_id: paymentStub.INVOICE_ID }).success,
    ).toBe(false);
    expect(
      registerPaymentSchema.safeParse({
        ...base,
        invoice_id: paymentStub.INVOICE_ID,
        idempotency_key: "no-es-un-uuid",
      }).success,
    ).toBe(false);
    expect(
      registerPaymentSchema.safeParse({
        ...base,
        invoice_id: paymentStub.INVOICE_ID,
        idempotency_key: MARK,
      }).success,
    ).toBe(true);
  });
});

// ---- CL-4: el pago de cajón SIN factura, repetido, no cuenta el efectivo dos veces ----

/**
 * CL-4: la puerta contigua de CL-3, en el MISMO `registerPayment`.
 *
 * EL DEFECTO, medido: un pago SIN factura escribe UNA sola fila —la del libro
 * de cajón (`payments`), sin espejo— y esa fila no tiene marca. Un reintento del
 * MISMO envío (doble clic, o el navegador reenviando tras cortarse la red)
 * escribe una SEGUNDA fila, y los TRES lectores del arqueo suman
 * `payments WHERE invoice_id IS NULL`: el efectivo del turno se cuenta dos
 * veces. No hay tope que lo frene: este camino no tiene obligación contra la
 * cual compararse, así que la única barrera posible es la IDENTIDAD del envío.
 */
describe("cash: CL-4 el reintento de un pago de cajón sin factura no cuenta el efectivo dos veces", () => {
  const ACTOR = { userId: "u-1", sedeId: paymentStub.SEDE_ID };
  const MARK = "4f8a2c61-9d0b-4e35-b7a2-1c6f9e0d8b47";
  /** Segunda marca: control de NO sobrealcance (otra operación, no una repetición). */
  const OTHER_MARK = "9b3d7e15-6c02-4a8f-8d51-3e7a0b6c2f94";
  /** Turno B: el escenario multi-turno prueba que la clave del índice es por turno. */
  const SHIFT_B = "77777777-7777-4777-8777-777777777777";

  /** Pago de cajón sin factura: su fila vive SÓLO en `payments`. */
  const drawerPayment = (mark = MARK, amount = 30000, shiftId = paymentStub.SHIFT_ID) => ({
    cash_shift_id: shiftId,
    method_code: "efectivo",
    amount,
    idempotency_key: mark,
  });
  const drawerInserts = () => paymentStub.inserts.payments ?? 0;

  /**
   * El efectivo que el arqueo suma del turno: los tres lectores de producción
   * usan `payments WHERE cash_shift_id = <turno> AND invoice_id IS NULL`, así
   * que la medida del defecto es esta suma, no la cantidad de filas.
   */
  const shiftCash = (shiftId: string): number =>
    paymentStub.drawer
      .filter((row) => row.cash_shift_id === shiftId && row.invoice_id === null)
      .reduce((acc, row) => acc + Number(row.amount), 0);

  /** Un turno abierto más de la sede (para el escenario multi-turno). */
  function seedShift(id: string): void {
    paymentStub.extraShifts.push({
      id,
      cash_register_id: "reg-2",
      sede_id: paymentStub.SEDE_ID,
      opened_by: "u-1",
      closed_by: null,
      opened_at: "2026-09-30T01:00:00.000Z",
      closed_at: null,
      opening_base: 0,
      expected_cash: 0,
      counted_cash: null,
      base_left: null,
      cash_withdrawn: null,
      base_difference: null,
      status: "abierto",
      observation: null,
    });
  }

  /** La ganadora de una carrera en el libro de cajón, ya confirmada. */
  function seedDrawerWinner(amount: number, mark: string, shiftId = paymentStub.SHIFT_ID): void {
    paymentStub.drawer.push({
      id: "caja-ganador",
      sede_id: paymentStub.SEDE_ID,
      cash_shift_id: shiftId,
      invoice_id: null,
      method_id: paymentStub.METHOD_ID,
      method_code: "efectivo",
      amount,
      user_id: "u-1",
      created_at: "2026-09-30T00:00:00.000Z",
      idempotency_key: mark,
    });
  }

  beforeEach(() => {
    paymentStub.deleteCalls.length = 0;
    paymentStub.unexpectedQueries.length = 0;
    paymentStub.mirrorError = null;
    paymentStub.mirrorData = null;
    paymentStub.rollbackError = null;
    paymentStub.ledgerMode = true;
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.skipDrawerMarkLookupOnce = false;
    paymentStub.drawerError = null;
    paymentStub.extraShifts.length = 0;
    paymentStub.stalePaymentsOnce = null;
  });

  it("RED medido, ahora GREEN: el reintento del MISMO envío escribe el libro de cajón UNA vez (el efectivo se cuenta una vez)", async () => {
    const first = await registerPayment(drawerPayment(), ACTOR);
    const repeat = await registerPayment(drawerPayment(), ACTOR);

    // El efectivo del turno, medido donde el arqueo lo suma: una sola fila.
    expect(paymentStub.drawer).toHaveLength(1);
    expect(drawerInserts()).toBe(1);
    expect(shiftCash(paymentStub.SHIFT_ID)).toBe(30000);
    expect(paymentStub.drawer[0]).toMatchObject({
      invoice_id: null,
      amount: 30000,
      idempotency_key: MARK,
    });
    expect(paymentStub.ledger).toHaveLength(0);
    // Y el reintento es un no-op EXITOSO: el mismo resultado, sin escribir nada.
    expect(repeat).toEqual(first);
    expect(repeat.invoice_id).toBeNull();
    expect(repeat.invoice_status).toBeNull();
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("una marca DISTINTA sí registra otro pago (control de no-sobrealcance)", async () => {
    await registerPayment(drawerPayment(MARK), ACTOR);
    await registerPayment(drawerPayment(OTHER_MARK), ACTOR);

    // La marca reconoce UNA operación, no encadena pagos: dos movimientos
    // legítimos del mismo monto y método son dos operaciones.
    expect(paymentStub.drawer).toHaveLength(2);
    expect(paymentStub.drawer.map((row) => row.idempotency_key)).toEqual([MARK, OTHER_MARK]);
    expect(shiftCash(paymentStub.SHIFT_ID)).toBe(60000);
    expect(drawerInserts()).toBe(2);
  });

  it("la clave es por TURNO: la marca de un turno no choca con la de otro, y cada uno reconoce la suya", async () => {
    seedShift(SHIFT_B);
    // El turno A registró SU operación con esta marca.
    await registerPayment(drawerPayment(MARK, 30000, paymentStub.SHIFT_ID), ACTOR);
    // El turno B registra OTRA operación: la marca se resuelve DENTRO del turno
    // (`(cash_shift_id, idempotency_key)`), así que el mismo uuid en otro turno
    // no es una repetición ni choca contra el índice de la 043. La alternativa
    // —clave por sede— rechazaría esta fila con 23505.
    const other = await registerPayment(drawerPayment(MARK, 50000, SHIFT_B), ACTOR);
    expect(paymentStub.drawer).toHaveLength(2);
    expect(other.payment).toMatchObject({ cash_shift_id: SHIFT_B, amount: 50000 });
    expect(other.shift.id).toBe(SHIFT_B);
    // Y cada turno reconoce la SUYA sin tocar la del otro: el lookup no cruza
    // turnos (si cruzara, el reintento del B devolvería la fila del A).
    const repeatB = await registerPayment(drawerPayment(MARK, 50000, SHIFT_B), ACTOR);
    expect(repeatB.payment).toMatchObject({ cash_shift_id: SHIFT_B, amount: 50000 });
    expect(paymentStub.drawer).toHaveLength(2);
    expect(shiftCash(paymentStub.SHIFT_ID)).toBe(30000);
    expect(shiftCash(SHIFT_B)).toBe(50000);
  });

  it("la carrera por el ÍNDICE (23505) relee a la ganadora", async () => {
    seedDrawerWinner(30000, MARK);
    // La ganadora confirmó DESPUÉS de la lectura de esta petición: el lookup por
    // marca no la vio y este intento llega al INSERT, donde choca con el índice
    // único parcial de 043.
    paymentStub.skipDrawerMarkLookupOnce = true;

    const result = await registerPayment(drawerPayment(), ACTOR);

    // No vacuidad: el INSERT se intentó (si el lookup lo hubiera frenado, este
    // contador sería 0) y lo frenó el índice.
    expect(drawerInserts()).toBe(1);
    expect(paymentStub.drawer).toHaveLength(1);
    expect(shiftCash(paymentStub.SHIFT_ID)).toBe(30000);
    expect(result.payment).toMatchObject({ id: "caja-ganador", amount: 30000 });
    expect(result.invoice_id).toBeNull();
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: sin ganadora, un 23505 NO se disfraza de repetición", async () => {
    paymentStub.drawerError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "uq_payments_shift_idempotency_key"',
    };

    const failure: unknown = await registerPayment(drawerPayment(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(paymentStub.drawer).toHaveLength(0);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    // La marca es OBLIGATORIA también sin factura: un envío sin marca no se
    // puede reconocer como repetición, y la ruta REST es justo la superficie que
    // reintenta sobre redes. El rechazo es ruidoso y no escribe nada.
    const withoutMark: unknown = await registerPayment(
      { ...drawerPayment(), idempotency_key: undefined },
      ACTOR,
    ).catch((error: unknown) => error);
    const malformed: unknown = await registerPayment(
      { ...drawerPayment(), idempotency_key: "no-es-un-uuid" },
      ACTOR,
    ).catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(CashError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(CashError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(paymentStub.drawer).toHaveLength(0);
    expect(drawerInserts()).toBe(0);
    expect(paymentStub.ledger).toHaveLength(0);
  });

  it("el esquema exige la marca en los DOS caminos (con y sin factura)", () => {
    const base = { method_code: "efectivo", amount: 50000 };
    // Sin marca no hay reconocimiento posible: se rechaza en los dos caminos.
    expect(registerPaymentSchema.safeParse(base).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ ...base, invoice_id: null }).success).toBe(false);
    expect(registerPaymentSchema.safeParse({ ...base, idempotency_key: "no-es-un-uuid" }).success).toBe(
      false,
    );
    expect(
      registerPaymentSchema.safeParse({ ...base, invoice_id: paymentStub.INVOICE_ID }).success,
    ).toBe(false);
    // Con la marca, los dos pasan.
    expect(registerPaymentSchema.safeParse({ ...base, idempotency_key: MARK }).success).toBe(true);
    expect(
      registerPaymentSchema.safeParse({
        ...base,
        invoice_id: paymentStub.INVOICE_ID,
        idempotency_key: MARK,
      }).success,
    ).toBe(true);
  });

  it("límite: el camino CON factura deja el libro de cajón SIN marca (su identidad es el espejo)", async () => {
    // La marca de la 043 es la de ESTA puerta: las filas del cobro de factura
    // llevan la marca en la fila espejo (042) y el libro de cajón queda NULL,
    // así que un mismo uuid no puede leerse como "el pago de cajón ya está
    // registrado" cuando en realidad es otra operación.
    await registerPayment(
      {
        cash_shift_id: paymentStub.SHIFT_ID,
        invoice_id: paymentStub.INVOICE_ID,
        method_code: "efectivo",
        amount: 50000,
        idempotency_key: MARK,
      },
      ACTOR,
    );

    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.ledger[0]).toMatchObject({ idempotency_key: MARK });
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.drawer[0].idempotency_key).toBeNull();
  });

  it("la migración 043 agrega la marca con un índice único PARCIAL por turno y no reescribe filas", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "043_cash_box_payment_idempotency.sql"),
      "utf8",
    );
    // La prosa explica justamente lo que NO hace el archivo y nombra esas
    // sentencias; las aserciones de abajo miran el SQL, sin los comentarios.
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // La columna nace NULL: las filas ya registradas no tienen marca y no hay
    // backfill que inventar.
    expect(sql).toContain("ALTER TABLE public.payments");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key text NULL");
    // La guarda de forma: una marca es un uuid, no cualquier texto.
    expect(sql).toContain("payments_idempotency_key_shape");
    // La barrera final: a lo sumo una operación por marca y TURNO.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_shift_idempotency_key");
    expect(sql).toContain("ON public.payments (cash_shift_id, idempotency_key)");
    // PARCIAL: las marcas NULL (históricas y las del camino con factura) quedan
    // fuera del índice.
    expect(sql).toContain("WHERE idempotency_key IS NOT NULL");
    // No borra ni reescribe filas, y no toca el camino de factura ni el tope.
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.\w+/i);
    // El camino de factura no se toca: ninguna sentencia ejecutable apunta a
    // `invoice_payments` (la cadena aparece sólo en la prosa, explicando por qué
    // la fila del libro de esa puerta queda NULL).
    expect(sql).not.toMatch(/ALTER TABLE public\.invoice_payments/);
    expect(sql).not.toMatch(/ON public\.invoice_payments/);
    // Idempotente y declarada como NO ejecutada por el agente.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos");
    // La clave elegida y su justificación están escritas, no supuestas: las dos
    // candidatas del encargo y la razón por la que se eligió la del turno.
    expect(raw).toContain("cash_shift_id");
    expect(raw).toContain("sede_id");
    expect(raw).toContain("LIMITACIÓN DECLARADA");
    expect(raw).toContain("COSTO DECLARADO");
  });
});

// ---------- U3: el cierre firmado es inmutable y su corrección es un reconteo ----------

describe("cash: U3 un cierre firmado es inmutable y se corrige con un reconteo", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "src", "features", "cash", "actions.ts"),
    "utf8",
  );

  /**
   * Cadena desde cada `.from("<tabla>")` hasta el siguiente `.from(`, igual que
   * el helper de T0-a: sirve para exigir que el reconteo INSERte y nunca
   * UPDATEe `cash_shifts`.
   */
  function dbChains(source: string, table: string): string[] {
    return source
      .split(`.from("${table}")`)
      .slice(1)
      .map((chunk) => {
        const end = chunk.indexOf(".from(");
        return end === -1 ? chunk : chunk.slice(0, end);
      });
  }

  it("el esquema de reconteo exige conteo completo, efectivo y motivo", () => {
    // Control positivo: un reconteo completo pasa.
    const ok = recountShiftSchema.safeParse({
      counted_cash: 150000,
      counts: [
        { method_code: "efectivo", denomination: 50000, quantity: 3, amount: 150000 },
      ],
      reason: "Se contó mal el efectivo la primera vez.",
    });
    expect(ok.success).toBe(true);

    // Conteo completo obligatorio.
    expect(
      recountShiftSchema.safeParse({ counted_cash: 150000, reason: "motivo" }).success,
    ).toBe(false);
    expect(
      recountShiftSchema.safeParse({ counted_cash: 150000, counts: [], reason: "motivo" }).success,
    ).toBe(false);
    // Efectivo obligatorio.
    expect(recountShiftSchema.safeParse({ counts: [], reason: "motivo" }).success).toBe(false);
    // Motivo obligatorio, no vacío ni sólo espacios.
    expect(recountShiftSchema.safeParse({ counted_cash: 150000, counts: [] }).success).toBe(false);
    expect(
      recountShiftSchema.safeParse({ counted_cash: 150000, counts: [], reason: "   " }).success,
    ).toBe(false);
  });

  it("una corrección tecleada sin conteo es imposible (el esquema viejo ya no existe)", () => {
    // Control negativo: la forma del antiguo `updateClosedShift` (contado y
    // base a mano, sin detalle) tiene que ser RECHAZADA. Si esto pasara, el
    // defecto seguiría vivo con otro nombre.
    const tecleada = recountShiftSchema.safeParse({
      counted_cash: 150000,
      base_left: 100000,
      observation: "corrijo el número",
    });
    expect(tecleada.success).toBe(false);
    // Y no hay ninguna rama opcional que deje `counts` vacío.
    expect(recountShiftSchema.safeParse({ reason: "mas" }).success).toBe(false);
  });

  it("reutiliza la maquinaria del cierre: mismo conteo, misma base y mismo sobre", () => {
    // 400/200 y 300/150 del dueño, ahora por la vía del reconteo.
    expect(closeAmountsFromCount(400000, 200000)).toEqual({
      counted_cash: 400000,
      base_left: 200000,
      cash_withdrawn: 200000,
      base_difference: 0,
    });
    const short = closeAmountsFromCount(150000, 300000);
    // baseLeft automático = min(contado, configurada); recogido = 0; faltante 150000.
    expect(short).toEqual({
      counted_cash: 150000,
      base_left: 150000,
      cash_withdrawn: 0,
      base_difference: -150000,
    });
    // La misma aritmética que el cierre, no una paralela.
    const base = resolveClosingBase(150000, 300000);
    const close = computeCashClose({ countedCash: 150000, baseLeft: base, baseConfigurada: 300000 });
    expect(short.base_left).toBe(base);
    expect(short.cash_withdrawn).toBe(close.cashWithdrawn);
    expect(short.base_difference).toBe(close.baseDifference);
  });

  it("conserva la versión anterior y guarda la nueva: las DOS versiones", () => {
    const previous = { counted_cash: 400000, base_left: 200000, cash_withdrawn: 200000, base_difference: 0 };
    const record = buildRecountRecord({
      previous,
      countedCash: 150000,
      baseConfigurada: 200000,
      reason: "  Faltaba un billete en el conteo.  ",
    });
    // La anterior queda congelada, tal cual.
    expect(record.previous).toEqual(previous);
    // La nueva sale del conteo completo (base = min(150000, 200000)).
    expect(record.next).toEqual({
      counted_cash: 150000,
      base_left: 150000,
      cash_withdrawn: 0,
      base_difference: -50000,
    });
    // El motivo viaja sin espacios sobrantes.
    expect(record.reason).toBe("Faltaba un billete en el conteo.");
  });

  it("sin motivo no se firma un reconteo (también a nivel puro)", () => {
    const previous = { counted_cash: 400000, base_left: 200000, cash_withdrawn: 200000, base_difference: 0 };
    expect(() =>
      buildRecountRecord({ previous, countedCash: 150000, baseConfigurada: 200000, reason: "   " }),
    ).toThrow("RECOUNT_REASON_REQUIRED");
  });

  it("la versión que gobierna es el reconteo si existe; si no, el cierre firmado", () => {
    const firmado = { counted_cash: 400000, base_left: 200000, cash_withdrawn: 200000, base_difference: 0 };
    const corregido = { counted_cash: 150000, base_left: 150000, cash_withdrawn: 0, base_difference: -50000 };
    // Con reconteo, gobierna la corrección (no el cierre firmado).
    expect(governingClose(firmado, corregido)).toEqual(corregido);
    // Sin reconteo, gobierna el cierre firmado.
    expect(governingClose(firmado, null)).toEqual(firmado);
    // Control negativo: un turno abierto (montos nulos) sin reconteo no se inventa.
    const abierto = { counted_cash: null, base_left: null, cash_withdrawn: null, base_difference: null };
    expect(governingClose(abierto, null)).toEqual(abierto);
  });

  it("todo monto del reconteo queda en peso entero (roundMoney)", () => {
    // Contado con decimales de punto flotante: la base y los derivados se
    // redondean a peso entero, igual que el cierre.
    const amounts = closeAmountsFromCount(150000.4, 300000.6);
    for (const value of Object.values(amounts)) {
      expect(Number.isInteger(value), String(value)).toBe(true);
    }
    expect(amounts).toEqual({
      counted_cash: 150000,
      base_left: 150000,
      cash_withdrawn: 0,
      base_difference: -150001,
    });
  });

  it("recontar no pisa cash_shifts: sólo INSERTA el reconteo y sus líneas", () => {
    expect(service).not.toContain("export async function updateClosedShift");
    const start = service.indexOf("export async function recountClosedShift");
    expect(start, "existe recountClosedShift").toBeGreaterThan(-1);
    const end = service.indexOf("export async function", start + 10);
    const body = service.slice(start, end === -1 ? service.length : end);
    // Nunca un UPDATE sobre el turno.
    const shiftChains = dbChains(body, "cash_shifts").filter((chain) =>
      chain.trimStart().startsWith(".update("),
    );
    expect(shiftChains).toEqual([]);
    // La versión corregida entra en la tabla nueva...
    expect(body).toContain('.from("cash_shift_recounts")');
    expect(body).toContain("previous_counted_cash: record.previous.counted_cash");
    // ...y las líneas por denominación, en la MISMA tabla del arqueo, fase reconteo.
    expect(body).toContain('await insertCounts(db, shift.id, "reconteo", parsed.data.counts);');
    // Un cierre se recontá una vez (misma barrera que el índice único).
    expect(body).toContain("ALREADY_RECOUNTED");
  });

  it("el reconteo no se suma al cierre: fetchCountTotals lo agrupa aparte", () => {
    const start = service.indexOf("async function fetchCountTotals");
    const end = service.indexOf("async function", start + 10);
    const body = service.slice(start, end === -1 ? service.length : end);
    expect(body).toContain('row.phase === "reconteo"');
    expect(body).toContain("entry.recount");
    // El cierre sólo agrupa la fase cierre, no todo lo que no sea apertura.
    expect(body).not.toContain('row.phase === "apertura" ? entry.open : entry.closed');
  });

  it("las vistas prefieren la versión corregida (día e historial)", () => {
    // Los dos constructores de vista cierran con el reconteo cuando existe...
    expect([...service.matchAll(/recountRow \? counts\.recount : counts\.closed/g)]).toHaveLength(2);
    // ...y los acumulados leen la versión que gobierna, no el cierre firmado.
    expect(service).toContain("countedCash: view.vigente.counted_cash");
    expect(actions).toContain("countedCash: view.vigente.counted_cash");
    // La tabla del cliente también: no queda `view.shift.base_left` como base final.
    const client = readFileSync(join(process.cwd(), "app", "cash", "cash-client.tsx"), "utf8");
    expect(client).toContain("formatMoney(view.vigente.base_left)");
    expect(client).not.toContain("formatMoney(view.shift.base_left)");
  });

  it("la base del próximo turno hereda el reconteo, no el cierre firmado viejo", () => {
    const start = service.indexOf("async function previousCloseTotals");
    const end = service.indexOf("async function", start + 10);
    const body = service.slice(start, end === -1 ? service.length : end);
    expect(body).toContain("recountRow ? Number(recountRow.base_left)");
    expect(body).toContain('recountRow ? "reconteo" : "cierre"');
  });

  it("la autorización no cambió: el reconteo sigue siendo sólo admin", () => {
    const start = actions.indexOf("export async function recountClosedShiftAction");
    expect(start, "existe recountClosedShiftAction").toBeGreaterThan(-1);
    const end = actions.indexOf("export async function", start + 10);
    const body = actions.slice(start, end === -1 ? actions.length : end);
    expect(body).toContain("requireAdminSession");
    expect(actions).not.toContain("updateClosedShiftAction");
  });
});

describe("migración 033_closed_shift_recount.sql (U3)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "033_closed_shift_recount.sql"),
    "utf8",
  );

  it("el archivo existe y trae DDL real (piso anti-vacío)", () => {
    expect(sql.length).toBeGreaterThan(1500);
    expect(sql).toContain("ALTER TABLE public.cash_shift_counts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.cash_shift_recounts");
  });

  it("extiende el CHECK de phase con reconteo y lo deja re-ejecutable", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS cash_shift_counts_phase_check");
    expect(sql).toContain("ADD CONSTRAINT cash_shift_counts_phase_check");
    expect(sql).toContain("CHECK (phase IN ('apertura', 'cierre', 'reconteo'))");
  });

  it("la tabla guarda las DOS versiones, el motivo y el responsable", () => {
    expect(sql).toContain("previous_counted_cash");
    expect(sql).toContain("previous_base_left");
    expect(sql).toContain("previous_cash_withdrawn");
    expect(sql).toContain("previous_base_difference");
    expect(sql).toContain("counted_cash numeric(12, 2) NOT NULL CHECK (counted_cash >= 0)");
    expect(sql).toContain("reason text NOT NULL CHECK (length(btrim(reason)) > 0)");
    expect(sql).toContain("recounted_by uuid NOT NULL REFERENCES public.users (id)");
    expect(sql).toContain("recounted_at timestamptz NOT NULL DEFAULT now()");
  });

  it("a lo sumo un reconteo por cierre (barrera de la inmutabilidad)", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shift_recounts_shift");
    expect(sql).toContain("ON public.cash_shift_recounts (shift_id)");
  });

  it("es idempotente y NUNCA borra filas ni backfillea", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    // Un solo DROP EJECUTABLE (la constraint del CHECK); las menciones del
    // encabezado explican la técnica pero no son statements.
    expect(sql.match(/^\s*DROP CONSTRAINT IF EXISTS/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    // Sólo cuentan los statements ejecutables: el encabezado NOMBRA estas
    // operaciones para decir que no las hace.
    expect(sql).not.toMatch(/^\s*TRUNCATE/m);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|SCHEMA)/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
  });

  it("explica el orden de los statements y por qué, y no se ejecutó", () => {
    expect(sql).toContain("ORDEN DE LOS STATEMENTS");
    expect(sql.indexOf("DROP CONSTRAINT IF EXISTS cash_shift_counts_phase_check")).toBeLessThan(
      sql.indexOf("CREATE TABLE IF NOT EXISTS public.cash_shift_recounts"),
    );
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS public.cash_shift_recounts")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shift_recounts_shift"),
    );
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});
