import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  closeShift,
  getDayView,
  getHistory,
  invoiceCollectionsSummary,
  mergeShiftMoney,
  openShift,
  recountClosedShift,
  registerPayment,
  sumShiftMoneyByMethod,
} from "@/src/features/cash/service";
import {
  invoiceNetBalance,
  splitGrossCardFee,
} from "@/src/features/billing/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import { IN_FILTER_CHUNK_SIZE } from "@/src/shared/lib/paged";

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
 * Cuerpo de la primera rama que empieza con `marker` (p. ej. `if (!result?.payment) {`),
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

// ------- CL-14: el cobro escribe por UNA transacción (053) -------

/**
 * CL-14: la forma del cobro de una factura, medida SOBRE EL CÓDIGO. Este bloque
 * reemplaza al de "el espejo va antes que la fila de cajón" (T0-a, Defecto 2):
 * ese orden y su reversa verificada existían para que ninguna falla dejara un
 * `payments` con `invoice_id` sin su espejo, y para compensar el par
 * espejo+cajón cuando el segundo fallaba. Con la 053 las TRES escrituras son UNA
 * transacción, así que el orden dejó de ser una guarda y la compensación dejó de
 * existir: lo que se pincha ahora es que la transacción SEA la escritura (y que
 * no haya quedado ninguna escritura suelta ni ningún DELETE de dinero), no una
 * secuencia de dos requests que hay que ordenar.
 */
describe("cash: CL-14 el cobro de una factura escribe por UNA transacción (053)", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );
  const start = service.indexOf("export async function registerPayment");
  const body = service.slice(start, service.indexOf("export async function", start + 10));

  it("el cobro CON factura escribe con UNA `rpc`, y ninguna de sus tres filas por su cuenta", () => {
    // La transacción de la 053: el espejo, el libro de cajón y el estado de la
    // factura, en UNA sentencia (una sentencia corre entera o no corre).
    expect(body).toContain('db.rpc("cash_invoice_payment_atomic"');
    // Ninguna escritura suelta del cliente sobre las dos tablas del dinero ni
    // sobre el estado de la factura: si alguna volviera, volvería también la
    // ventana entre ella y las otras dos.
    const writes = ["invoice_payments", "payments", "invoices"].flatMap((table) =>
      body
        .split(`.from("${table}")`)
        .slice(1)
        .map((chunk) => {
          const end = chunk.indexOf(".from(");
          return (end === -1 ? chunk : chunk.slice(0, end)).trimStart();
        }),
    );
    const loose = writes.filter(
      (chain) => chain.startsWith(".insert(") || chain.startsWith(".update("),
    );
    // La única escritura suelta que queda es el pago SIN factura (CL-4), cuya
    // fila ES la operación entera.
    expect(loose).toHaveLength(1);
    expect(loose[0]).toContain("idempotency_key: mark");
  });

  it("ya no hay compensación del par: NINGÚN DELETE de dinero en el camino del cobro", () => {
    // La reversa del espejo —el DELETE por id y su aviso PAYMENT_ROLLBACK_FAILED—
    // era la compensación del par espejo+cajón. Con los tres grupos en UNA
    // transacción no hay nada que compensar: el rollback es del servidor. La
    // negación se mide sobre el código SIN comentarios (la prosa del bloque
    // explica la compensación retirada y nombra su código).
    const code = blankStringsAndComments(body);
    expect(code).not.toContain(".delete()");
    expect(body).not.toContain('"PAYMENT_ROLLBACK_FAILED"');
    expect(body).not.toContain("mirrorId");
    // Lo que SÍ queda es el código del estado heredado: el reintento que
    // reconoce un cobro a medias de ANTES (espejo sin cajón) tiene que seguir
    // diciendo la verdad sobre esa avería (vive en `repeatedCollectionResult`).
    expect(service).toContain('"PAYMENT_ROLLBACK_FAILED"');
    expect(service).toContain("async function repeatedCollectionResult");
  });

  it("las dos barreras del INSERT se siguen atendiendo igual (P0001 del tope y 23505 de la marca)", () => {
    expect(body).toContain('const code = (payError as { code?: string } | null)?.code;');
    expect(body).toContain('if (code === "23505" || code === "P0001") {');
    expect(body).toContain('throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);');
    expect(body).toContain("findInvoicePaymentsByIdempotencyKey(db, input.invoice_id, mark)");
  });

  it("el catch externo no puede tragarse el error gritado", () => {
    // toCashError devuelve el CashError tal cual: el código llega al caller.
    expect(service).toContain("if (error instanceof CashError) return error;");
    expect(body).toContain("throw toCashError(error);");
  });

  it("las precondiciones de la transacción se traducen por MENSAJE antes que por código", () => {
    // La función revalida adentro y sus `RAISE EXCEPTION` salen con el MISMO
    // SQLSTATE del tope de 031 (P0001), así que el mensaje se mira ANTES: si no,
    // un cobro sobre una factura anulada se leería como "se pasó del tope".
    const messageCheck = body.indexOf('message.includes("ANNUL_INVALID")');
    const codeCheck = body.indexOf('if (code === "23505" || code === "P0001")');
    expect(messageCheck).toBeGreaterThan(-1);
    expect(codeCheck).toBeGreaterThan(messageCheck);
    expect(body).toContain('throw new CashError("ANNUL_INVALID", "No se puede cobrar una factura anulada.", 409);');
    expect(body).toContain('throw new CashError("INVOICE_NOT_FOUND", "Factura no encontrada.", 404);');
  });
});

// ------- T0-a (Defecto 1/2): recargo derivado del bruto y saldo NETO -------

/**
 * CL-14: la aritmética del cobro sigue siendo del SERVICIO. El bloque cambia de
 * dónde LEE su evidencia (antes: el `.insert` del espejo; ahora: el objeto
 * `p_collection` que viaja a la transacción de la 053), no lo que exige: el
 * reparto del recargo, el bruto redondeado una sola vez y el cierre por NETO
 * siguen computados en TypeScript y escritos verbatim por la base.
 */
describe("cash: T0-a (Defecto 1/2) el cobro de caja deriva el recargo del BRUTO", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );
  const start = service.indexOf("export async function registerPayment");
  const body = service.slice(start, service.indexOf("export async function", start + 10));
  /** El objeto que viaja como DATO a `cash_invoice_payment_atomic` (053). */
  const collection = body.slice(
    body.indexOf("p_collection: {"),
    body.indexOf("if (payError)"),
  );

  it("el cobro lleva el recargo y el porcentaje, no el DEFAULT 0", () => {
    expect(collection).toContain("fee_percent: feePercent");
    expect(collection).toContain("fee_amount: cardFee.fee");
    // El porcentaje sale del método cobrado (payment_methods.fee_percent: el
    // mismo snapshot que escribe billing al emitir; 019).
    expect(body).toContain("Math.max(0, Number(method.fee_percent) || 0)");
  });

  it("el bruto se redondea una sola vez y es el que va a las dos filas", () => {
    expect(body).toContain("const gross = roundMoney(input.amount);");
    expect(body).toContain("splitGrossCardFee(gross, feePercent)");
    expect(collection).toContain("amount: gross");
    // El INSERT crudo (sin centavos normalizados) no puede volver: la fila
    // espejo y la de cajón tienen que guardar el mismo monto.
    expect(body).not.toContain("amount: input.amount");
  });

  it("la factura se marca Pagada por NETO, no por bruto contra total", () => {
    expect(body).toContain("invoiceNetBalance({");
    expect(body).toContain(
      "invoiceBalance.netCollected + cardFee.net - invoiceBalance.netBilled > 0.009",
    );
    // La DECISIÓN se toma acá y viaja como booleano: la función no compara el
    // cobrado contra el facturado ni una vez.
    expect(body).toContain(
      "moneyEquals(roundMoney(invoiceBalance.netCollected + cardFee.net), invoiceBalance.netBilled)",
    );
    expect(body).toContain("p_mark_paid: markPaid");
    expect(body).toContain("p_set_shift: setShift");
    // Los dos chequeos viejos (bruto de caja contra el total) no pueden volver.
    expect(body).not.toContain("roundMoney(invoicePaid + input.amount)");
    expect(body).not.toContain("moneyEquals(paid, invoiceTotal)");
  });

  it("la marca del intento viaja como DATO, en la ÚNICA fila espejo (042)", () => {
    expect(collection).toContain("idempotency_key: mark");
    expect(collection).toContain("method_code: method.code");
    expect(collection).toContain("method_id: method.id");
  });

  it("sin compensación por id: el espejo nace con el DEFAULT de su columna", () => {
    // El id del espejo se generaba ANTES del INSERT para que la compensación
    // fuera exacta por id (nunca por factura+turno+método+monto, que podría
    // borrar un cobro legítimo anterior). Con la transacción no hay compensación
    // y no hay id que adelantar: la columna de 005 lo resuelve.
    expect(body).not.toContain("randomUUID");
    expect(collection).not.toMatch(/^\s*id:/m);
  });

  it("la transacción sin confirmación se grita con su código propio, sin compensar", () => {
    const branch = extractBranch(body, "if (!result?.payment) {");
    expect(branch).toContain("console.error(");
    expect(branch).toContain('"MIRROR_UNCONFIRMED"');
    expect(branch).not.toContain(".delete()");
    expect(branch).not.toContain('"PAYMENT_ROLLBACK_FAILED"');
    // Nada quedó escrito y se dice con un código propio (no genérico).
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

  it("la transacción escribe el turno que COBRA en las dos filas del dinero", () => {
    // El turno viaja como PARÁMETRO de la operación (`p_shift_id`) y la función
    // lo escribe tanto en el espejo (`invoice_payments.cash_shift_id`, el que
    // suma el arqueo) como en el libro de cajón y en el enlace de la factura.
    // Antes esto se medía en el `.insert` del espejo; ahora donde está.
    expect(service.slice(service.indexOf("export async function registerPayment"))).toContain(
      "p_shift_id: shift.id",
    );
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "053_cash_payment_state_atomic.sql"),
      "utf8",
    );
    expect(migration).toMatch(/cash_shift_id/,);
    expect(migration).toContain("p_shift_id");
  });

  it("el cierre solo pisa un turno abierto (ni doble cierre ni conteos dobles)", () => {
    const start = service.indexOf("export async function closeShift");
    const close = service.slice(start, service.indexOf("export async function", start + 10));
    // CL-10: el compare-and-swap `status = 'abierto'` dejó de ser un UPDATE
    // suelto del cliente. Vive DENTRO de la transacción de
    // `cash_close_shift_atomic` (migración 049), que lo conserva en su propio
    // WHERE y lo respalda con su red de conteo —el UPDATE afecta 0 filas y la
    // transacción se revierte ENTERA—, y el servicio traduce el rechazo al
    // MISMO error de negocio. Lo que se comprueba acá es lo que el servicio
    // tiene que seguir cumpliendo: que el cierre NO escriba el turno por su
    // cuenta ni deje los conteos fuera de la transacción.
    const updates = dbChains(close, "cash_shifts").filter((chain) =>
      chain.trimStart().startsWith(".update("),
    );
    expect(updates).toEqual([]);
    expect(close).toContain('db.rpc("cash_close_shift_atomic"');
    expect(close).toContain('"SHIFT_ALREADY_CLOSED"');
  });

  it("traduce P0001 del tope de factura a OVERPAID (C2)", () => {
    // CL-14: el INSERT del espejo ya no es una sentencia del cliente: viaja
    // DENTRO de `cash_invoice_payment_atomic`, cuya red deja pasar el SQLSTATE
    // de la base. Lo que se exige es lo mismo de siempre, en su hogar nuevo: el
    // P0001 del tope (031) y el 23505 de la marca (042) se reconocen igual, y
    // sin ganadora con esa marca el rechazo es OVERPAID.
    const start = service.indexOf("export async function registerPayment");
    const body = service.slice(start, service.indexOf("export async function", start + 10));
    expect(body).toContain('const code = (payError as { code?: string } | null)?.code;');
    expect(body).toContain('if (code === "23505" || code === "P0001") {');
    expect(body).toContain(
      'throw new CashError("OVERPAID", "El pago supera el saldo pendiente de la factura.", 422);',
    );
  });

  it("la rama sin turno sigue viva solo por filas NULL (no solapa)", () => {
    const fetcher = service.slice(service.indexOf("async function fetchInvoicePaymentsByShift"));
    expect(fetcher).toContain('.is("cash_shift_id", null)');
    // 414: el filtro por turno sigue siendo el mismo; lo que cambió es que la
    // lista viaja TROCEADA (`chunk` de `readAllSourceInChunks`) y su origen
    // sigue siendo `shiftIds`.
    expect(fetcher).toContain("readAllSourceInChunks");
    expect(fetcher).toContain("values: shiftIds");
    expect(fetcher).toContain('.in("cash_shift_id", chunk)');
  });
});

describe("billing: T0-a (C2) tope de cobro en BD traducido a OVERPAID", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "billing", "service.ts"),
    "utf8",
  );

  it("las dos puertas de invoice_payments traducen el tope de 031 a OVERPAID (transacción de emisión y RPC de cobro)", () => {
    // CL-11 (050) + CL-13 (052): NINGUNA de las dos puertas escribe
    // `invoice_payments` con un `.insert` del cliente — la emisión escribe por
    // `invoice_create_atomic` y el cobro por `invoice_split_payment_atomic`—,
    // así que el conteo baja de 1 a 0. NO se afloja nada: se cambia DÓNDE se
    // pincha, no QUÉ se exige. El tope de 031 (P0001) se sigue traduciendo al
    // MISMO OVERPAID en las dos puertas, y cada una queda pinchada en su hogar
    // nuevo; las dos están además cubiertas EN RUNTIME (tests/billing.test.ts).
    const inserts = service
      .split('.from("invoice_payments")')
      .slice(1)
      .map((chunk) => {
        const end = chunk.indexOf(".from(");
        return end === -1 ? chunk : chunk.slice(0, end);
      })
      .filter((chain) => chain.trimStart().startsWith(".insert("));
    expect(inserts).toHaveLength(0); // las DOS puertas escriben por transacción

    // La PRIMERA puerta, en su hogar nuevo: la emisión escribe por
    // `invoice_create_atomic` y traduce el MISMO tope de 031 a OVERPAID.
    const create = service.slice(service.indexOf("function toRpcCreateError"));
    expect(create).toContain('if (message.includes("El cobro supera")) {');
    expect(create).toContain(
      'return new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);',
    );

    // La SEGUNDA puerta, en su hogar nuevo: el cobro dividido escribe por la
    // transacción de la 050 y traduce el MISMO P0001 del tope a OVERPAID.
    const split = service.slice(service.indexOf("export async function splitPayment"));
    expect(split).toContain('db.rpc("invoice_split_payment_atomic"');
    expect(split).toContain('if (code === "23505" || code === "P0001") {');
    expect(split).toContain(
      'throw new BillingError("OVERPAID", "Las porciones superan el saldo pendiente.", 422);',
    );
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
  /**
   * CL-14: la falla del TERCER grupo de escritura del cobro —el UPDATE de la
   * factura, que la enlaza al turno o la pasa a Pagada—, consumida UNA vez. Es
   * la falla que el defecto no compensaba: el espejo y el libro de cajón ya
   * estaban escritos y el dinero quedaba cobrado con la factura abierta. En el
   * camino viejo el doble la devuelve desde el UPDATE suelto; en la
   * transacción, desde `cash_invoice_payment_atomic` —las dos veces sin tocar
   * el estado, porque un UPDATE fallido no escribe—.
   */
  failInvoiceCloseOnce: false,
  /**
   * CL-14: una ANULACIÓN que gana la carrera entre la lectura del servicio y la
   * transacción. El doble pisa el estado de la factura justo antes de que la
   * transacción lea su fila bloqueada: es la precondición de estado que la
   * función revalida adentro.
   */
  raceAnnulOnce: false,
  /**
   * CL-14: la transacción no CONFIRMA (devuelve sin fila y sin error). No es un
   * desenlace del SQL —la función siempre devuelve su jsonb o revienta—, es el
   * piso de la rama defensiva del servicio: un cobro que no se puede confirmar
   * no puede reportarse como exitoso.
   */
  noConfirmOnce: false,
  /** Transacciones de cobro pedidas, en orden. */
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /**
   * CL-17: el estado del turno. La transacción de la 056 lo bloquea con
   * `FOR SHARE` y lo revalida: si está `cerrado`, el cobro rechaza con
   * `SHIFT_CLOSED` en vez de escribir su dinero en un turno cerrado.
   */
  shiftStatus: "abierto",
  /**
   * CL-17: un `closeShift` que gana la carrera entre la lectura del servicio y
   * la transacción. El doble cierra el turno antes de revalidarlo, que es la
   * ventana (b) de CL-17.
   */
  closeShiftBeforeCommit: false,
  /** CL-17: los DATOS DE CIERRE que la factura quedó con, si se cerró. */
  invoiceClosedBy: null as string | null,
  invoiceClosedAt: null as string | null,
}));

/** Las columnas de `PAYMENT_SELECT` (service.ts): el shape que el servicio lee. */
const PAYMENT_COLUMNS = [
  "id",
  "cash_shift_id",
  "invoice_id",
  "method_id",
  "method_code",
  "amount",
  "user_id",
  "created_at",
];

/**
 * Cliente Supabase falso y encadenable del camino de `registerPayment`.
 * Responde lo que ese camino consulta de verdad (`cash_shifts`,
 * `invoice_payments`, `payments`, `invoices`); cualquier otra consulta se
 * registra en `unexpectedQueries` y vuelve como error, para que el test falle a
 * la vista en vez de en silencio.
 *
 * CL-14: el doble mantiene el ESTADO que decide el defecto —las filas cobradas
 * y el libro de cajón— y aplica las DOS barreras de la base con sus códigos
 * reales: el tope de 031 (P0001) y el índice único parcial de 042 (23505). La
 * aritmética NO se sustituye: `invoiceNetBalance` y `splitGrossCardFee` son los
 * de producción y corren de verdad contra este doble.
 *
 * Las ESCRITURAS sueltas de `invoice_payments` ya no las pide el servicio (el
 * cobro entero va por `cash_invoice_payment_atomic`), pero el doble las sigue
 * emulando —con sus dos barreras— porque es su modelo de la tabla: la
 * compensación por DELETE que las acompañaba es la que se retiró.
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
          status: paymentStub.shiftStatus,
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
    /**
     * CL-14: las columnas pedidas en el `.select(...)`. PostgREST devuelve SÓLO
     * esas columnas y el doble ahora lo respeta: es lo que hace comparable la
     * fila que devuelve la transacción (que arma su jsonb con las columnas de
     * PAYMENT_SELECT) con la que devuelve un `select(PAYMENT_SELECT)` posterior.
     * Sin esto, la comparación de una repetición contra su intento original
     * mediría una diferencia que sólo existe en el doble.
     */
    let columns: string[] | null = null;

    const matching = (): Array<Record<string, unknown>> =>
      rowsOf(table).filter((row) => filters.every(([column, value]) => row[column] === value));

    /** Proyecta a las columnas pedidas: el shape que el servicio lee de verdad. */
    const shape = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      columns === null ? rows : rows.map((row) => project(row, columns as string[]));

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
        if (table === "invoices" && paymentStub.failInvoiceCloseOnce) {
          // CL-14: el tercer grupo de escritura falla (camino viejo: el UPDATE
          // suelto). Nada cambia de estado: un UPDATE que falla no escribe.
          paymentStub.failInvoiceCloseOnce = false;
          return {
            data: null,
            error: { code: "23514", message: "el cierre de la factura falló" },
          };
        }
        if (table === "invoices" && typeof written.status === "string") {
          paymentStub.invoiceStatus = written.status;
        }
        const matched = shape(matching());
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op === "insert") {
        paymentStub.inserts[table] = (paymentStub.inserts[table] ?? 0) + 1;
        if (table === "invoice_payments") {
          if (paymentStub.mirrorError) {
            return { data: paymentStub.mirrorData, error: paymentStub.mirrorError };
          }
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
          const rows = shape([persisted]);
          return { data: single ? rows[0] : rows, error: null };
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
          const rows = shape([persisted]);
          return { data: single ? rows[0] : rows, error: null };
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
      const matched = shape(matching());
      return { data: single ? matched[0] ?? null : matched, error: null };
    };

    const query: Record<string, unknown> = {
      select: (value?: unknown) => {
        if (typeof value === "string" && value.trim() !== "*") {
          columns = value.split(",").map((column) => column.trim());
        }
        return query;
      },
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

  /**
   * CL-14: `cash_invoice_payment_atomic`. El doble modela la TRANSACCIÓN: lee la
   * fila de la factura bloqueada y revalida su precondición (una factura
   * Anulada no admite cobros), evalúa las DOS barreras reales del INSERT del
   * espejo —el tope de 031 (P0001) y el índice único parcial de la 042 (23505)—
   * y aplica sus TRES grupos —el espejo, el libro de cajón y el cierre/enlace de
   * la factura— o NINGUNO. Nada se escribe hasta el COMMIT: si algo falla, el
   * doble no deja ni una fila, como la transacción del servidor.
   *
   * El doble NO reimplementa las guardas de FORMA del SQL (regex de uuids y
   * montos, `coalesce`, `jsonb_typeof`): ésas viven en la función y se prueban
   * sobre el archivo. Lo que emula es lo que estos tests necesitan observar: la
   * indivisibilidad, la precondición de estado DENTRO de la transacción y las
   * dos barreras de la base con sus códigos reales.
   */
  const rpc = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ data: unknown; error: unknown }> => {
    if (name !== "cash_invoice_payment_atomic") {
      paymentStub.unexpectedQueries.push(`rpc.${name}`);
      return { data: null, error: { message: `doble sin respuesta para el rpc ${name}` } };
    }
    paymentStub.rpcCalls.push({ name, args });
    // CL-17: el TURNO se bloquea (`FOR SHARE`) ANTES de la factura (orden global
    // `cash_shifts > invoices`). El cierre concurrente se dispara acá: lo que la
    // otra transacción confirmó es parte del estado que esta transacción va a
    // leer bajo el lock.
    if (paymentStub.closeShiftBeforeCommit) {
      paymentStub.closeShiftBeforeCommit = false;
      paymentStub.shiftStatus = "cerrado";
    }
    if (args.p_shift_id !== paymentStub.SHIFT_ID) {
      return { data: null, error: { code: "P0001", message: "SHIFT_NOT_FOUND" } };
    }
    if (paymentStub.shiftStatus !== "abierto") {
      // El turno que se cerró a mitad del cobro: la transacción lo revalida
      // sobre la fila bloqueada y rechaza SIN escribir nada.
      return { data: null, error: { code: "P0001", message: "SHIFT_CLOSED" } };
    }
    // La carrera por el ESTADO se dispara antes del lock: lo que la otra
    // transacción confirmó es parte del estado que esta transacción va a leer.
    if (paymentStub.raceAnnulOnce) {
      paymentStub.raceAnnulOnce = false;
      paymentStub.invoiceStatus = "Anulada";
    }

    // 1) La fila de la factura, bloqueada, y su precondición releída DE LA FILA.
    if (paymentStub.invoiceStatus === "Anulada") {
      return { data: null, error: { code: "P0001", message: "ANNUL_INVALID" } };
    }

    // 1.b) La transacción no CONFIRMA ni escribe: es el único desenlace en el
    //      que lo que el servicio afirma en esa rama —nada quedó escrito— es
    //      cierto (una función que devuelve NULL antes de escribir).
    if (paymentStub.noConfirmOnce) {
      paymentStub.noConfirmOnce = false;
      return { data: null, error: null };
    }

    const collection = (args.p_collection ?? {}) as Record<string, unknown>;

    // 2) El grupo 1: el ESPEJO (`invoice_payments`), con la marca de la 042. El
    //    contador cuenta la escritura PEDIDA, como contaba el `.insert` suelto:
    //    la sentencia corre y es la transacción la que la revierte. El tope de
    //    031 (BEFORE INSERT → P0001) y el índice de la 042 (23505) corren
    //    ADENTRO, con el SQLSTATE real que el servicio ya traducía.
    paymentStub.inserts.invoice_payments = (paymentStub.inserts.invoice_payments ?? 0) + 1;
    if (paymentStub.mirrorError) {
      return { data: paymentStub.mirrorData, error: paymentStub.mirrorError };
    }
    const mirrorRow: Record<string, unknown> = {
      id: `espejo-${paymentStub.ledger.length + 1}`,
      invoice_id: args.p_invoice_id,
      method_id: collection.method_id ?? null,
      method_code: collection.method_code,
      amount: collection.amount,
      fee_percent: collection.fee_percent,
      fee_amount: collection.fee_amount,
      cash_shift_id: args.p_shift_id,
      created_at: "2026-09-30T00:00:00.000Z",
      idempotency_key: collection.idempotency_key ?? null,
    };
    const paidNet = paymentStub.ledger
      .filter((candidate) => candidate.invoice_id === mirrorRow.invoice_id)
      .reduce(
        (acc, candidate) =>
          acc + (Number(candidate.amount) - Number(candidate.fee_amount ?? 0)),
        0,
      );
    const newNet = Number(mirrorRow.amount) - Number(mirrorRow.fee_amount ?? 0);
    const cap = Math.round(paymentStub.INVOICE_TOTAL - paymentStub.INVOICE_SURCHARGE);
    if (paidNet + newNet - cap > 0.009) {
      return {
        data: null,
        error: { code: "P0001", message: "El cobro supera el neto facturado de la factura" },
      };
    }
    const mark = mirrorRow.idempotency_key;
    if (mark !== null && mark !== undefined) {
      const clashes = paymentStub.ledger.some(
        (other) => other.invoice_id === mirrorRow.invoice_id && other.idempotency_key === mark,
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

    // 3) El grupo 2: el LIBRO DE CAJÓN (`payments`), SIN marca a propósito (043:
    //    la identidad de este camino vive en la fila espejo).
    paymentStub.inserts.payments = (paymentStub.inserts.payments ?? 0) + 1;
    if (paymentStub.drawerError) {
      return { data: null, error: paymentStub.drawerError };
    }
    const drawerRow: Record<string, unknown> = {
      id: `caja-${paymentStub.drawer.length + 1}`,
      // La fila del cajón toma la SEDE DEL TURNO que la función bloquea (la
      // instalación es de una sola sede, 071): ya no llega en la llamada.
      sede_id: paymentStub.SEDE_ID,
      cash_shift_id: args.p_shift_id,
      invoice_id: args.p_invoice_id,
      method_id: collection.method_id ?? null,
      method_code: collection.method_code,
      amount: collection.amount,
      user_id: args.p_user_id,
      created_at: "2026-09-30T00:00:00.000Z",
      idempotency_key: null,
    };

    // 4) El grupo 3: el cierre/enlace de la factura, SÓLO si el servicio lo
    //    decidió (`p_set_shift` / `p_mark_paid`). Si el grupo no corre, no hay
    //    nada que pueda fallar ahí —y por eso un cobro PARCIAL no tiene esta
    //    ventana—.
    if (args.p_set_shift === true || args.p_mark_paid === true) {
      if (paymentStub.failInvoiceCloseOnce) {
        paymentStub.failInvoiceCloseOnce = false;
        return { data: null, error: { code: "23514", message: "el cierre de la factura falló" } };
      }
    }

    // 5) COMMIT: los tres grupos.
    paymentStub.ledger.push(mirrorRow);
    paymentStub.drawer.push(drawerRow);
    if (args.p_mark_paid === true) {
      paymentStub.invoiceStatus = "Pagada";
      // CL-17: el cierre ESCRITO con sus datos —el usuario que cobra y el
      // instante que mandó el servicio—, que es lo que la factura Pagada tiene
      // que dejar. El doble los toma del DATO, como la función de la 056: si el
      // servicio no los manda, siguen en NULL (el defecto).
      paymentStub.invoiceClosedBy = (args.p_user_id ?? null) as string | null;
      paymentStub.invoiceClosedAt = (args.p_closed_at ?? null) as string | null;
    }
    return {
      data: {
        payment: project(drawerRow, PAYMENT_COLUMNS),
        invoice: { id: args.p_invoice_id, status: paymentStub.invoiceStatus },
      },
      error: null,
    };
  };

  return { from, rpc };
}

// ------- CL-10: el CICLO DEL TURNO (apertura, cierre y reconteo) -------

/**
 * Estado del doble del CICLO DEL TURNO. Es un doble APARTE del de
 * `registerPayment`: el ciclo del turno lee y escribe otro conjunto de tablas,
 * y separarlos evita que una prueba del cobro empiece a depender de una tabla
 * que no consulta (y al revés). Se elige con `shiftStub.lifecycle`.
 */
const shiftStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  REGISTER_ID: "99999999-9999-4999-8999-999999999999",
  SHIFT_ID: "22222222-2222-4222-8222-222222222222",
  USER_ID: "u-1",
  BASE_CONFIGURADA: 200000,
  /** Con `true` el cliente falso es el del ciclo del turno, no el del cobro. */
  lifecycle: false,
  /** Tablas en memoria: lo que el turno tiene escrito. */
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Transacciones pedidas, en orden: la prueba de que las dos escrituras viajan juntas. */
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /**
   * Escrituras SUELTAS del camino viejo (un request por escritura). Después de
   * CL-10 no debería quedar ninguna fuera de la auditoría, que es un INSERT
   * aparte a propósito.
   */
  looseWrites: [] as Array<{ table: string; op: string }>,
  /** Filas que la TRANSACCIÓN confirmó, por tabla (el `inserts` del camino viejo). */
  inserts: [] as Array<{ table: string; payload: unknown }>,
  /** Filas que la TRANSACCIÓN confirmó por UPDATE (el `updates` del camino viejo). */
  updates: [] as Array<{ table: string; payload: unknown }>,
  /**
   * CL-10: falla el GRUPO de las líneas de conteo. Es el MISMO error en los dos
   * mundos: contra el código viejo, el doble hace fallar el INSERT suelto en
   * `cash_shift_counts` —la SEGUNDA escritura, la que dejaba el estado
   * parcial—; contra el código nuevo, falla la red de conteo DENTRO de la
   * transacción emulada, que revierte todo.
   */
  failCounts: null as string | null,
  /**
   * La CARRERA: otra transacción escribe justo antes de que esta evalúe su
   * precondición (la fila cambió entre la lectura del servicio y la escritura).
   */
  beforeRpc: null as null | (() => void),
  /** SELECTs sobre tablas que el doble no conoce (debería quedar siempre vacío). */
  unknownSelects: [] as string[],
  /**
   * CL-21: el techo de filas por REQUEST del Data API (`max-rows`: 1000 por
   * defecto). Es lo que convierte un `select` sin paginar en una lectura
   * RECORTADA y silenciosa, y es el defecto que este bloque mide.
   */
  rowCap: 1000,
  /**
   * CL-21: las VENTANAS pedidas, en orden (`range`/`limit`), con el `order()`
   * que las acompaña. Es la prueba observable de que una lectura va por páginas
   * y en un orden determinista, no de que el test espere un texto.
   */
  windows: [] as Array<{
    table: string;
    from: number;
    to: number;
    order: string[];
    filters: string[];
  }>,
  /** Consultas pedidas por tabla: permite inyectar el fallo de UNA página. */
  requests: {} as Record<string, number>,
  /** Fallo inyectado en la consulta N de una tabla (`failAt.payments = [2]`). */
  failAt: {} as Record<string, number[]>,
  /** Fallo inyectado en una lectura concreta (tabla + columna filtrada). */
  failSelects: [] as Array<{ table: string; filter: string; message: string }>,
  /**
   * 414: el TAMAÑO de cada `.in(...)`, por request (tabla + columna filtrada).
   * Es la prueba observable de que ninguna lista de ids viaja en una sola URL:
   * con `chunkIds`, ningún lote supera `IN_FILTER_CHUNK_SIZE`.
   */
  inSizes: [] as Array<{ table: string; column: string; size: number }>,
  rowSeq: 0,
}));

/** Tablas que el ciclo del turno consulta de verdad. */
const SHIFT_TABLES = new Set([
  "audit_logs",
  "cash_denominations",
  "cash_registers",
  "cash_shift_counts",
  "cash_shift_recounts",
  "cash_shifts",
  "commission_payouts",
  "invoice_payments",
  "invoices",
  "payments",
  "users",
  "voucher_requests",
]);

/** Las columnas de `SHIFT_SELECT` (service.ts): el shape que el servicio leía. */
const SHIFT_COLUMNS = [
  "id",
  "cash_register_id",
  "opened_by",
  "closed_by",
  "opened_at",
  "closed_at",
  "opening_base",
  "expected_cash",
  "counted_cash",
  "base_left",
  "cash_withdrawn",
  "base_difference",
  "status",
  "observation",
];

/** Las columnas de `RECOUNT_SELECT` (service.ts). */
const RECOUNT_COLUMNS = [
  "id",
  "shift_id",
  "previous_counted_cash",
  "previous_base_left",
  "previous_cash_withdrawn",
  "previous_base_difference",
  "counted_cash",
  "base_left",
  "cash_withdrawn",
  "base_difference",
  "reason",
  "recounted_by",
  "recounted_at",
];

/** Proyecta una fila a las columnas que el `jsonb_build_object` del RPC devuelve. */
function project(
  row: Record<string, unknown>,
  columns: string[],
): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

/**
 * Cliente Supabase falso del ciclo del turno. Mantiene en memoria las tablas que
 * las tres operaciones leen y escriben, y emula las DOS formas de escribir:
 *
 *   * el camino VIEJO, con escrituras sueltas (un request por escritura), que es
 *     contra el que corre el RED: ahí el fallo de la segunda escritura deja la
 *     primera confirmada;
 *   * el camino NUEVO, con `rpc(...)`: una transacción del servidor, que toma las
 *     tablas ANTES de escribir y las restaura si algo falla. La red de conteo
 *     también es del doble: si el grupo de las líneas no escribe exactamente lo
 *     recibido, la transacción se revierte entera.
 *
 * El doble NO reimplementa las guardas de FORMA del SQL (regex de uuids y montos,
 * `coalesce`, `jsonb_typeof`): ésas viven en la función y se prueban sobre el
 * archivo. Lo que emula es lo que estos tests necesitan observar: la
 * indivisibilidad, las PRECONDICIONES de estado dentro de la transacción, las
 * redes de conteo y el CHECK de 006 sobre `expected_cash`, que es una regla de
 * negocio que el servicio traduce.
 */
function createShiftStubSupabaseClient(): unknown {
  const rowsOf = (table: string): Array<Record<string, unknown>> => shiftStub.tables[table] ?? [];

  const from = (table: string) => {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let single = false;
    let payload: unknown;
    /**
     * CL-21: la ventana PEDIDA, con el techo por request de `shiftStub.rowCap`
     * que modela el `max-rows` del Data API. Un `select` sin `range`/`limit` pide
     * la ventana por defecto (0..rowCap-1) y el servidor devuelve a lo sumo
     * `rowCap` filas: sin esto la truncación no existiría en el doble y el test
     * no probaría nada.
     */
    let rangeFrom = 0;
    let rangeTo = shiftStub.rowCap - 1;
    /** El `order()` pedido: el doble ORDENA de verdad (la paginación lo exige). */
    const orderKeys: Array<{ column: string; ascending: boolean }> = [];
    /** Columnas filtradas, en orden: identifica QUÉ lectura se está pidiendo. */
    const filterColumns: string[] = [];
    let countMode: "exact" | null = null;
    let headOnly = false;
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];

    const matching = (): Array<Record<string, unknown>> =>
      rowsOf(table).filter((row) => filters.every((fn) => fn(row)));

    const respond = (): { data: unknown; error: unknown; count?: number | null } => {
      if (op === "select") {
        if (!SHIFT_TABLES.has(table)) shiftStub.unknownSelects.push(table);
        // CL-21: el fallo de una LECTURA concreta (tabla + columna filtrada) y
        // el de una PÁGINA concreta (la consulta N de la tabla). Los dos son
        // fallos de TRANSPORTE: el doble no devuelve filas, devuelve el error.
        const failure = shiftStub.failSelects.find(
          (entry) => entry.table === table && filterColumns.includes(entry.filter),
        );
        if (failure) {
          return { data: null, error: { code: "P0001", message: failure.message } };
        }
        const request = (shiftStub.requests[table] = (shiftStub.requests[table] ?? 0) + 1);
        if ((shiftStub.failAt[table] ?? []).includes(request)) {
          return {
            data: null,
            error: {
              code: "P0001",
              message: `doble: fallo inyectado en ${table} (consulta ${request})`,
            },
          };
        }
        const to = Math.min(rangeTo, rangeFrom + shiftStub.rowCap - 1);
        shiftStub.windows.push({
          table,
          from: rangeFrom,
          to,
          order: orderKeys.map((key) => key.column),
          filters: [...filterColumns],
        });
        const filtered = matching();
        for (const key of [...orderKeys].reverse()) {
          filtered.sort((left, right) => {
            const a = String(left[key.column] ?? "");
            const b = String(right[key.column] ?? "");
            if (a === b) return 0;
            return (a < b ? -1 : 1) * (key.ascending ? 1 : -1);
          });
        }
        const window = filtered.slice(rangeFrom, to + 1);
        return {
          data: headOnly ? null : single ? (window[0] ?? null) : window,
          count: countMode === "exact" ? filtered.length : null,
          error: null,
        };
      }
      shiftStub.looseWrites.push({ table, op });
      if (op === "insert") {
        if (table === "cash_shift_counts" && shiftStub.failCounts) {
          return { data: null, error: { code: "P0001", message: shiftStub.failCounts } };
        }
        const rows = (Array.isArray(payload) ? payload : [payload]) as Array<
          Record<string, unknown>
        >;
        // CL-10: el índice único PARCIAL de 006, aplicado de verdad. Es la
        // barrera que hace sonora la carrera de la apertura también en el
        // camino viejo.
        if (table === "cash_shifts") {
          for (const row of rows) {
            const clash =
              row.status === "abierto" &&
              rowsOf(table).some(
                (other) =>
                  other.cash_register_id === row.cash_register_id && other.status === "abierto",
              );
            if (clash) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "uq_cash_shifts_open_per_register"',
                },
              };
            }
          }
        }
        const persisted = rows.map((row) => ({
          id: `${table}-${(shiftStub.rowSeq += 1)}`,
          ...row,
        }));
        shiftStub.tables[table] = [...rowsOf(table), ...persisted];
        shiftStub.inserts.push({ table, payload });
        return { data: single ? (persisted[0] ?? null) : persisted, error: null };
      }
      if (op === "delete") {
        return { data: null, error: null };
      }
      const changes = (payload ?? {}) as Record<string, unknown>;
      // El CHECK de 006 sobre `expected_cash`, aplicado también en el camino
      // viejo: es la regla de negocio que el servicio traduce a
      // CASH_OUT_EXCEEDS_COLLECTED, y la prueba de que sigue viva no puede
      // depender de en qué mundo corre.
      if (table === "cash_shifts" && Number(changes.expected_cash) < 0) {
        return {
          data: null,
          error: {
            code: "23514",
            message:
              'new row for relation "cash_shifts" violates check constraint "cash_shifts_expected_cash_check"',
          },
        };
      }
      const targets = matching();
      if (targets.length === 0) {
        // El `.single()` sin filas del cliente real (PGRST116): es lo que en el
        // camino viejo detectaba la carrera perdida del cierre.
        return {
          data: null,
          error: { code: "PGRST116", message: "no rows returned by the update" },
        };
      }
      for (const row of targets) {
        shiftStub.tables[table] = rowsOf(table).map((other) =>
          other === row ? { ...other, ...changes } : other,
        );
      }
      shiftStub.updates.push({ table, payload });
      const updated = targets.map((row) => ({ ...row, ...changes }));
      return { data: single ? updated[0] : updated, error: null };
    };

    const query: Record<string, unknown> = {
      select: (_columns?: unknown, options?: { count?: string; head?: boolean }) => {
        if (options?.count === "exact") countMode = "exact";
        if (options?.head) headOnly = true;
        return query;
      },
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
        filters.push((row) => row[column] === value);
        return query;
      },
      in: (column: string, values: readonly unknown[]) => {
        filterColumns.push(column);
        shiftStub.inSizes.push({ table, column, size: values.length });
        const set = new Set(values);
        filters.push((row) => set.has(row[column]));
        return query;
      },
      is: (column: string, value: unknown) => {
        filterColumns.push(column);
        filters.push((row) =>
          value === null ? row[column] === null || row[column] === undefined : row[column] === value,
        );
        return query;
      },
      // CL-21: los filtros de rango de las vistas (día e historial). El doble
      // compara como strings, igual que el Data API compara ISO-8601.
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
      single: () => {
        single = true;
        return Promise.resolve(respond());
      },
      maybeSingle: () => {
        single = true;
        return Promise.resolve(respond());
      },
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(respond()).then(onFulfilled, onRejected),
    };
    return query;
  };

  /**
   * Una transacción del servidor, por operación. Devuelve lo que la función
   * devuelve: el turno escrito, el reconteo escrito, o el error con su código.
   */
  const rpc = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ data: unknown; error: unknown }> => {
    shiftStub.rpcCalls.push({ name, args });
    // La carrera se dispara ANTES de la foto: lo que la otra transacción
    // confirmó es parte del estado previo, no algo que esta escribió.
    const race = shiftStub.beforeRpc;
    if (race) {
      shiftStub.beforeRpc = null;
      race();
    }
    const shiftSnapshot = [...(shiftStub.tables.cash_shifts ?? [])];
    const countSnapshot = [...(shiftStub.tables.cash_shift_counts ?? [])];
    const recountSnapshot = [...(shiftStub.tables.cash_shift_recounts ?? [])];
    const rollback = (message: string, code = "P0001") => {
      shiftStub.tables.cash_shifts = shiftSnapshot;
      shiftStub.tables.cash_shift_counts = countSnapshot;
      shiftStub.tables.cash_shift_recounts = recountSnapshot;
      return { data: null, error: { code, message } };
    };
    const lineRows = (
      shiftId: unknown,
      phase: string,
      lines: Array<Record<string, unknown>>,
    ): Array<Record<string, unknown>> =>
      lines.map((line) => ({
        id: `conteo-${(shiftStub.rowSeq += 1)}`,
        shift_id: shiftId,
        phase,
        ...line,
      }));

    if (name === "cash_open_shift_atomic") {
      // La caja YA NO se filtra por la sede del llamador (071): la función la
      // bloquea por id y de esa misma fila toma la sede que escribe el turno.
      const register = (shiftStub.tables.cash_registers ?? []).find(
        (row) => row.id === args.p_register_id,
      );
      if (!register) return rollback("SHIFT_REGISTER_NOT_FOUND");
      const alreadyOpen = (shiftStub.tables.cash_shifts ?? []).some(
        (row) => row.cash_register_id === args.p_register_id && row.status === "abierto",
      );
      if (alreadyOpen) return rollback("SHIFT_ALREADY_OPEN");
      const created: Record<string, unknown> = {
        id: `turno-${(shiftStub.rowSeq += 1)}`,
        cash_register_id: args.p_register_id,
        sede_id: register.sede_id,
        opened_by: args.p_opened_by,
        closed_by: null,
        opened_at: "2026-09-30T12:00:00.000Z",
        closed_at: null,
        opening_base: args.p_opening_base,
        expected_cash: 0,
        counted_cash: null,
        base_left: null,
        cash_withdrawn: null,
        base_difference: null,
        status: "abierto",
        observation: null,
      };
      shiftStub.tables.cash_shifts = [...(shiftStub.tables.cash_shifts ?? []), created];
      const lines = (args.p_counts ?? []) as Array<Record<string, unknown>>;
      // La red de conteo del SQL: si el grupo de las líneas no escribe
      // EXACTAMENTE lo recibido, la transacción se revierte ENTERA, el turno
      // incluido.
      if (shiftStub.failCounts) return rollback(shiftStub.failCounts);
      shiftStub.tables.cash_shift_counts = [
        ...(shiftStub.tables.cash_shift_counts ?? []),
        ...lineRows(created.id, "apertura", lines),
      ];
      shiftStub.inserts.push({ table: "cash_shift_counts", payload: lines });
      return { data: project(created, SHIFT_COLUMNS), error: null };
    }

    if (name === "cash_close_shift_atomic") {
      const shift = (shiftStub.tables.cash_shifts ?? []).find(
        (row) => row.id === args.p_shift_id,
      );
      if (!shift) return rollback("SHIFT_NOT_FOUND");
      // La precondición de estado, leída de la fila BLOQUEADA: otro cierre ganó.
      if (shift.status !== "abierto") return rollback("SHIFT_ALREADY_CLOSED");
      // CL-19: la PRECONDICIÓN del conjunto de cobros, evaluada BAJO el lock del
      // turno (esto es lo que la función de la migración 058 hace entre su 2.2 y
      // su 2.3). El doble RE-CUENTA las MISMAS dos fuentes que el servicio sumó
      // —`payments` del turno sin factura y las `invoice_payments` atribuidas al
      // turno, la unión de las directas y las históricas sin turno cuya factura
      // pertenece al turno— y rechaza si alguno de los dos conteo difiere del
      // token que el llamador mandó. No suma ningún monto: cuenta filas.
      //
      // CL-20: la MISMA precondición cubre las DOS SALIDAS que el arqueo resta
      // —`commission_payouts` del turno y los vales APROBADOS con método del
      // turno (`approved_by` y `method_code` no nulos, la misma regla de
      // `isVoucherCashOut`)—, porque un pago o una aprobación confirmados en el
      // medio también dejan el arqueo firmado corto. Cuatro conteo, ninguna
      // suma.
      const token = (args.p_collection_counts ?? {}) as Record<string, unknown>;
      const invoicesOfShift = new Set(
        (shiftStub.tables.invoices ?? [])
          .filter((row) => row.cash_shift_id === args.p_shift_id)
          .map((row) => row.id),
      );
      const countedPayments = (shiftStub.tables.payments ?? []).filter(
        (row) => row.cash_shift_id === args.p_shift_id && (row.invoice_id ?? null) === null,
      ).length;
      const countedInvoicePayments = (shiftStub.tables.invoice_payments ?? []).filter(
        (row) =>
          row.cash_shift_id === args.p_shift_id ||
          ((row.cash_shift_id ?? null) === null && invoicesOfShift.has(row.invoice_id)),
      ).length;
      const countedCommissionPayouts = (shiftStub.tables.commission_payouts ?? []).filter(
        (row) => row.cash_shift_id === args.p_shift_id,
      ).length;
      const countedVoucherRequests = (shiftStub.tables.voucher_requests ?? []).filter(
        (row) =>
          row.cash_shift_id === args.p_shift_id &&
          (row.approved_by ?? null) !== null &&
          (row.method_code ?? null) !== null,
      ).length;
      if (
        countedPayments !== Number(token.payments) ||
        countedInvoicePayments !== Number(token.invoice_payments) ||
        countedCommissionPayouts !== Number(token.commission_payouts) ||
        countedVoucherRequests !== Number(token.voucher_requests)
      ) {
        return rollback("ARQUEO_STALE");
      }
      const close = (args.p_close ?? {}) as Record<string, unknown>;
      // El CHECK de 006 dentro de la transacción: la regla de negocio que el
      // servicio traduce a CASH_OUT_EXCEEDS_COLLECTED no se movió ni se
      // adelantó; la función la deja hablar.
      if (Number(close.expected_cash) < 0) {
        return rollback(
          'new row for relation "cash_shifts" violates check constraint "cash_shifts_expected_cash_check"',
          "23514",
        );
      }
      const changes: Record<string, unknown> = {
        expected_cash: close.expected_cash,
        counted_cash: close.counted_cash,
        base_left: close.base_left,
        cash_withdrawn: close.cash_withdrawn,
        base_difference: close.base_difference,
        observation: close.observation ?? null,
        status: "cerrado",
        closed_at: args.p_closed_at,
        closed_by: args.p_closed_by,
      };
      shiftStub.tables.cash_shifts = (shiftStub.tables.cash_shifts ?? []).map((row) =>
        row === shift ? { ...row, ...changes } : row,
      );
      shiftStub.updates.push({ table: "cash_shifts", payload: changes });
      const closed = { ...shift, ...changes };
      const lines = (args.p_counts ?? []) as Array<Record<string, unknown>>;
      if (shiftStub.failCounts) return rollback(shiftStub.failCounts);
      shiftStub.tables.cash_shift_counts = [
        ...(shiftStub.tables.cash_shift_counts ?? []),
        ...lineRows(shift.id, "cierre", lines),
      ];
      shiftStub.inserts.push({ table: "cash_shift_counts", payload: lines });
      return { data: project(closed, SHIFT_COLUMNS), error: null };
    }

    if (name === "cash_recount_shift_atomic") {
      const shift = (shiftStub.tables.cash_shifts ?? []).find(
        (row) => row.id === args.p_shift_id,
      );
      if (!shift) return rollback("SHIFT_NOT_FOUND");
      if (shift.status !== "cerrado") return rollback("SHIFT_NOT_CLOSED");
      // El índice único por turno de 033, aplicado de verdad: un segundo
      // reconteo choca contra él dentro de la transacción.
      if (
        (shiftStub.tables.cash_shift_recounts ?? []).some(
          (row) => row.shift_id === args.p_shift_id,
        )
      ) {
        return rollback(
          'duplicate key value violates unique constraint "uq_cash_shift_recounts_shift"',
          "23505",
        );
      }
      const recount: Record<string, unknown> = {
        id: `reconteo-${(shiftStub.rowSeq += 1)}`,
        shift_id: args.p_shift_id,
        ...((args.p_recount ?? {}) as Record<string, unknown>),
        recounted_by: args.p_recounted_by,
        recounted_at: "2026-09-30T15:00:00.000Z",
      };
      shiftStub.tables.cash_shift_recounts = [
        ...(shiftStub.tables.cash_shift_recounts ?? []),
        recount,
      ];
      shiftStub.inserts.push({ table: "cash_shift_recounts", payload: args.p_recount });
      const lines = (args.p_counts ?? []) as Array<Record<string, unknown>>;
      if (shiftStub.failCounts) return rollback(shiftStub.failCounts);
      shiftStub.tables.cash_shift_counts = [
        ...(shiftStub.tables.cash_shift_counts ?? []),
        ...lineRows(args.p_shift_id, "reconteo", lines),
      ];
      shiftStub.inserts.push({ table: "cash_shift_counts", payload: lines });
      return { data: project(recount, RECOUNT_COLUMNS), error: null };
    }

    return { data: null, error: { message: `doble sin respuesta para el rpc ${name}` } };
  };

  return { from, rpc };
}

/** Devuelve el doble del turno a su estado inicial entre pruebas. */
function resetShiftStub(): void {
  shiftStub.lifecycle = false;
  shiftStub.tables = {};
  shiftStub.rpcCalls.length = 0;
  shiftStub.looseWrites.length = 0;
  shiftStub.inserts.length = 0;
  shiftStub.updates.length = 0;
  shiftStub.failCounts = null;
  shiftStub.beforeRpc = null;
  shiftStub.unknownSelects.length = 0;
  shiftStub.rowCap = 1000;
  shiftStub.windows.length = 0;
  shiftStub.requests = {};
  shiftStub.failAt = {};
  shiftStub.failSelects.length = 0;
  shiftStub.inSizes.length = 0;
  shiftStub.rowSeq = 0;
}

// Los catálogos de cash son `unstable_cache` (caché de Next). Fuera de un
// request de Next no hay caché incremental —la función lanza "Invariant:
// incrementalCache missing"—, así que se usa la función tal cual: la lectura
// corre de verdad contra el doble de PostgREST de cada test.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
}));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () =>
    shiftStub.lifecycle ? createShiftStubSupabaseClient() : createStubSupabaseClient(),
}));

vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  const methods = [
    {
      id: paymentStub.METHOD_ID,
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

/**
 * CL-14: la falla del cobro ya no deja nada que compensar. Este bloque
 * reemplaza al de "el INSERT fallido del espejo no emite ningún DELETE" (T0-b),
 * que medía la CONTRAPARTIDA de aquella compensación: que un INSERT fallido del
 * espejo no disparara el DELETE. La compensación entera se retiró (el rollback
 * es del servidor), así que lo que se pincha ahora es que NINGUNA falla deje
 * nada escrito y que NINGUNA emita un DELETE de dinero.
 */
describe("cash: CL-14 una falla del cobro no deja nada escrito (sin compensación)", () => {
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
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.stalePaymentsOnce = null;
    paymentStub.noConfirmOnce = false;
    paymentStub.failInvoiceCloseOnce = false;
    paymentStub.rpcCalls.length = 0;
  });

  it("P0001 del tope: rechaza OVERPAID y no deja nada escrito", async () => {
    paymentStub.mirrorError = { code: "P0001", message: "cap" };
    const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "OVERPAID", status: 422 });
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("error genérico de la transacción: rechaza INTERNAL y no deja nada escrito", async () => {
    paymentStub.mirrorError = { code: "23514", message: "check_violation" };
    const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("la rama sin confirmación existe y grita (control positivo del código propio)", async () => {
    // Sin esta positiva, la negación de abajo podría estar pasando sobre una
    // rama muerta: acá el doble devuelve la transacción SIN fila y el servicio
    // tiene que decir exactamente eso —nada escrito, reintentable—, con su
    // propio código y no con un INTERNAL genérico.
    paymentStub.noConfirmOnce = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure: unknown = await registerPayment(input, actor).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "MIRROR_UNCONFIRMED", status: 500 });
      expect(errorSpy).toHaveBeenCalled();
      expect(paymentStub.ledger).toEqual([]);
      expect(paymentStub.drawer).toEqual([]);
      expect(paymentStub.deleteCalls).toEqual([]);
      expect(paymentStub.unexpectedQueries).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("control positivo del OBSERVADOR: un DELETE del cliente sí se registra (la negación no es vacía)", async () => {
    // La compensación se retiró: el cobro no emite NINGÚN DELETE. Para que
    // `deleteCalls == []` signifique algo, el observador tiene que estar vivo:
    // un DELETE emitido contra el doble se registra. Es la positiva que reemplaza
    // a la del DELETE de compensación (que ya no existe como código).
    const client = createStubSupabaseClient() as unknown as {
      from: (table: string) => { delete: () => { eq: (c: string, v: unknown) => Promise<unknown> } };
    };
    await client.from("invoice_payments").delete().eq("id", "espejo-1");
    expect(paymentStub.deleteCalls).toEqual(["invoice_payments"]);
  });
});

// ---- CL-14: el cobro de una factura (espejo + cajón + estado) es UNA transacción ----

/**
 * CL-14: la ÚLTIMA ventana de caja, y la peor de todas: un cobro cuyo asiento
 * de dinero queda escrito pero cuyo estado nunca llega.
 *
 * EL DEFECTO, medido en `registerPayment` (service.ts): el cobro escribía, en
 * orden, la fila espejo de la factura (`invoice_payments`, el dinero que suma el
 * arqueo), la fila del libro de cajón (`payments`) y —TERCERO— el estado de la
 * factura (`invoices`: el enlace al turno y el paso a `Pagada`). El PAR
 * espejo+cajón sí estaba compensado y lo gritaba (`PAYMENT_ROLLBACK_FAILED`),
 * pero el UPDATE del estado NO tenía compensación ninguna: una falla ahí dejaba
 * el dinero COBRADO —las dos filas escritas, el arqueo sumándolo— con la factura
 * `Emitida` para siempre. Y no se arregla solo: el saldo cobrable quedó en CERO
 * (la fila espejo está escrita), así que ningún cobro posterior puede cerrarla —
 * `invoiceNetBalance` da saldo 0 y una porción nueva se rechaza con OVERPAID—, y
 * el reintento del MISMO envío, con la marca de la 042, es un no-op que devuelve
 * la factura ABIERTA. La caja cobró y el sistema no lo registra como cobrado.
 *
 * EL MECANISMO es el de la casa: una FUNCIÓN SQL es UNA sentencia, y una
 * sentencia corre ENTERA dentro de una sola transacción del servidor
 * (PostgREST no ofrece multi-statement por request). `cash_invoice_payment_atomic`
 * escribe los TRES grupos —el espejo, el cajón y el estado— o NINGUNO. La
 * compensación del par deja de existir porque deja de hacer falta: ya no hay
 * una mitad del camino donde fallar.
 *
 * LA ARITMÉTICA NO SE MUEVE: el bruto (`roundMoney`), el reparto del recargo
 * (`splitGrossCardFee`), el saldo (`invoiceNetBalance`), el tope del 031, la
 * decisión `Pagada` (`moneyEquals`) y el look-up de la marca siguen en
 * TypeScript. La función sólo ESCRIBE lo que recibe.
 */
describe("cash: CL-14 el cobro de una factura es UNA transacción", () => {
  const ACTOR = { userId: "u-1", sedeId: paymentStub.SEDE_ID };
  const MARK = "4d5e6f70-8a9b-4c1d-9e2f-3a4b5c6d7e8f";
  /** Cobro que COMPLETA el saldo (100000 de 100000): es el que cierra la factura. */
  const collection = (mark = MARK, amount = 100000) => ({
    cash_shift_id: paymentStub.SHIFT_ID,
    invoice_id: paymentStub.INVOICE_ID,
    method_code: "efectivo",
    amount,
    idempotency_key: mark,
  });

  const mirrorInserts = () => paymentStub.inserts.invoice_payments ?? 0;
  const drawerInserts = () => paymentStub.inserts.payments ?? 0;

  beforeEach(() => {
    paymentStub.deleteCalls.length = 0;
    paymentStub.unexpectedQueries.length = 0;
    paymentStub.mirrorError = null;
    paymentStub.mirrorData = null;
    paymentStub.rollbackError = null;
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.skipDrawerMarkLookupOnce = false;
    paymentStub.stalePaymentsOnce = null;
    paymentStub.drawerError = null;
    paymentStub.failInvoiceCloseOnce = false;
    paymentStub.raceAnnulOnce = false;
    paymentStub.noConfirmOnce = false;
    paymentStub.rpcCalls.length = 0;
    // CL-17: el turno abierto y la factura aún sin cierre; el cierre concurrente
    // se arma por prueba.
    paymentStub.shiftStatus = "abierto";
    paymentStub.closeShiftBeforeCommit = false;
    paymentStub.invoiceClosedBy = null;
    paymentStub.invoiceClosedAt = null;
  });

  it("el éxito escribe el espejo, el cajón y el cierre, con el MISMO contenido de siempre", async () => {
    const result = await registerPayment(collection(), ACTOR);

    // UNA transacción para el cobro: ni una escritura suelta del cliente.
    expect(paymentStub.rpcCalls.map((call) => call.name)).toEqual([
      "cash_invoice_payment_atomic",
    ]);
    // El espejo, columna por columna: el dinero, el turno que cobra y la marca
    // del intento (042). El id lo pone la columna (gen_random_uuid): la
    // compensación por id ya no existe.
    expect(paymentStub.ledger).toEqual([
      {
        id: "espejo-1",
        invoice_id: paymentStub.INVOICE_ID,
        method_id: paymentStub.METHOD_ID,
        method_code: "efectivo",
        amount: 100000,
        fee_percent: 0,
        fee_amount: 0,
        cash_shift_id: paymentStub.SHIFT_ID,
        created_at: "2026-09-30T00:00:00.000Z",
        idempotency_key: MARK,
      },
    ]);
    // El libro de cajón, con el usuario que cobró y SIN marca (043: la
    // identidad de este camino vive en la fila espejo).
    expect(paymentStub.drawer).toEqual([
      {
        id: "caja-1",
        sede_id: paymentStub.SEDE_ID,
        cash_shift_id: paymentStub.SHIFT_ID,
        invoice_id: paymentStub.INVOICE_ID,
        method_id: paymentStub.METHOD_ID,
        method_code: "efectivo",
        amount: 100000,
        user_id: "u-1",
        created_at: "2026-09-30T00:00:00.000Z",
        idempotency_key: null,
      },
    ]);
    // Y el estado, dentro de la MISMA transacción.
    expect(paymentStub.invoiceStatus).toBe("Pagada");
    expect(result).toMatchObject({
      invoice_id: paymentStub.INVOICE_ID,
      invoice_status: "Pagada",
    });
    expect(result.payment).toMatchObject({ id: "caja-1", amount: 100000 });
    expect(result.shift.id).toBe(paymentStub.SHIFT_ID);
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("la aritmética viaja como DATO: la función no recalcula el recargo ni el cierre", async () => {
    await registerPayment(collection(), ACTOR);

    const args = paymentStub.rpcCalls[0].args;
    // El reparto entero, computado por `splitGrossCardFee` en el servicio y
    // escrito verbatim por la función: acá no hay una sola suma de dinero.
    expect(args.p_collection).toEqual({
      method_id: paymentStub.METHOD_ID,
      method_code: "efectivo",
      amount: 100000,
      fee_percent: 0,
      fee_amount: 0,
      idempotency_key: MARK,
    });
    // La DECISIÓN de cerrar la factura es del servicio (invoiceNetBalance +
    // moneyEquals) y viaja como booleano; el enlace al turno, ídem.
    expect(args.p_mark_paid).toBe(true);
    expect(args.p_set_shift).toBe(false);
    expect(args.p_shift_id).toBe(paymentStub.SHIFT_ID);
    expect(args.p_invoice_id).toBe(paymentStub.INVOICE_ID);
    // La SEDE NO viaja: es la de la instalación (071) y la función la toma del
    // turno que bloquea. Mandarla sería una segunda frontera por RPC.
    expect(args).not.toHaveProperty("p_sede_id");
    expect(args.p_user_id).toBe("u-1");
  });

  it("una falla al CERRAR la factura no deja el dinero cobrado (nada escrito)", async () => {
    paymentStub.failInvoiceCloseOnce = true;

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    // MEDIDO ANTES DEL ARREGLO (verbatim, con el código previo a la 053): acá el
    // espejo y el cajón YA ESTABAN escritos (el dinero cobrado, el arqueo
    // sumándolo) y la factura seguía Emitida —con su saldo en cero, cerrable
    // nunca—:
    //   expected [ { …(10) } ] to have a length of 0 but got 1   (ledger)
    //   expected 'Emitida' to be 'Pagada'                        (reintento)
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    expect(paymentStub.invoiceStatus).toBe("Emitida");
    // Las sentencias CORRIERON dentro de la transacción y la transacción las
    // revirtió: no es que no se haya intentado escribir.
    expect(mirrorInserts()).toBe(1);
    expect(drawerInserts()).toBe(1);
    // Y no hay ninguna compensación: no hay nada que compensar.
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("el REINTENTO del mismo envío COMPLETA el cobro (la factura queda Pagada)", async () => {
    paymentStub.failInvoiceCloseOnce = true;
    await registerPayment(collection(), ACTOR).catch((error: unknown) => error);

    const retry = await registerPayment(collection(), ACTOR);

    // El intento fallido no dejó marca (la transacción la revirtió con el
    // resto), así que el reintento es una operación NUEVA que termina el cobro
    // en vez de un no-op sobre una factura abierta para siempre.
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.ledger[0]).toMatchObject({ amount: 100000, idempotency_key: MARK });
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.invoiceStatus).toBe("Pagada");
    expect(retry).toMatchObject({
      invoice_id: paymentStub.INVOICE_ID,
      invoice_status: "Pagada",
    });
    expect(retry.payment).toMatchObject({ id: "caja-1", amount: 100000 });
    // Dos intentos de escritura (el revertido y el que quedó), una sola fila.
    expect(mirrorInserts()).toBe(2);
    expect(paymentStub.deleteCalls).toEqual([]);
  });

  it("una falla del libro de cajón revierte TAMBIÉN el espejo y no cierra la factura", async () => {
    paymentStub.drawerError = { code: "23514", message: "el libro de cajón rechazó la fila" };

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    // Antes esto lo resolvía un DELETE de compensación del espejo; ahora lo
    // resuelve la transacción, y el desenlace observable es el mismo: NADA.
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    expect(paymentStub.invoiceStatus).toBe("Emitida");
    expect(paymentStub.deleteCalls).toEqual([]);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("la anulación que gana la carrera rechaza el cobro y no escribe NADA", async () => {
    // La factura se anula entre la lectura del servicio y la transacción: la
    // fila bloqueada ya ve `Anulada`, así que el cobro se rechaza adentro.
    paymentStub.raceAnnulOnce = true;

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "ANNUL_INVALID", status: 409 });
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    // No vacuidad: la transacción SÍ se intentó (el rechazo es de adentro).
    expect(paymentStub.rpcCalls).toHaveLength(1);
    expect(mirrorInserts()).toBe(0);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: después del cobro completo, la MISMA marca sigue siendo un no-op", async () => {
    const first = await registerPayment(collection(), ACTOR);
    const repeat = await registerPayment(collection(), ACTOR);

    // El arreglo no puede convertir una repetición legítima en un segundo
    // cobro: la marca de la 042 se sigue mirando ANTES de cualquier escritura.
    expect(repeat).toEqual(first);
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.drawer).toHaveLength(1);
    expect(mirrorInserts()).toBe(1);
    expect(drawerInserts()).toBe(1);
    // El segundo envío ni siquiera llegó a la transacción.
    expect(paymentStub.rpcCalls).toHaveLength(1);
    expect(repeat.invoice_status).toBe("Pagada");
  });

  it("una repetición sobre un cobro a medias de ANTES (espejo sin cajón) se sigue reportando", async () => {
    // Estado heredado de la ventana ya cerrada: la fila espejo sin su fila de
    // cajón. Es el único desenlace que le queda a PAYMENT_ROLLBACK_FAILED: la
    // transacción no puede VOLVER a producirlo, pero la observación de lo ya
    // escrito (el reintento reconoce por marca) tiene que seguir diciendo la
    // verdad sobre esa avería.
    paymentStub.ledger.push({
      id: "espejo-heredado",
      invoice_id: paymentStub.INVOICE_ID,
      method_id: paymentStub.METHOD_ID,
      method_code: "efectivo",
      amount: 100000,
      fee_percent: 0,
      fee_amount: 0,
      cash_shift_id: paymentStub.SHIFT_ID,
      created_at: "2026-09-30T00:00:00.000Z",
      idempotency_key: MARK,
    });

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "PAYMENT_ROLLBACK_FAILED", status: 500 });
    expect(drawerInserts()).toBe(0);
  });
});

// ------- CL-17: la factura se cierra CON sus datos y el turno no se cierra a mitad -------

/**
 * CL-17: los dos huecos que le quedaban al cobro de caja.
 *
 * HUECO (a): la transacción de la 053 escribía los MISMOS campos que el UPDATE
 * suelto —`cash_shift_id` y `status`— y NO escribía `closed_by`/`closed_at`. Una
 * factura cobrada completa por caja quedaba `Pagada` con `closed_at` NULL, contra
 * el contrato que la columna tiene escrito en el esquema (025) y contra lo que el
 * mismo cobro dividido SÍ escribe (050). MEDIDO ANTES DEL ARREGLO (verbatim):
 *
 *     expected null to deeply equal Any<String>   (invoices.closed_at)
 *
 * HUECO (b): el turno se leía en el SERVICIO y la transacción no lo miraba. Un
 * `closeShift` (049) entre esa lectura y el commit dejaba la fila de cajón
 * escrita en un turno YA cerrado —la FK toma `FOR KEY SHARE`, que no compite con
 * el `FOR NO KEY UPDATE` del cierre—. MEDIDO ANTES DEL ARREGLO (verbatim), con el
 * doble sirviendo el turno como la función previa (sin lock):
 *
 *     expected [ { id: 'caja-1', …(9) } ] to deeply equal []   (payments)
 *     expected { …(4) } to be an instance of CashError
 *     expected CashError { code: 'OVERPAID', status: 422 } to match object
 *       { code: 'SHIFT_CLOSED', status: 409 }
 *
 * El doble modela el contrato de la función de la 056: el turno se bloquea
 * (`FOR SHARE`) y se revalida ANTES de la factura, y el cierre se escribe con el
 * `p_closed_at`/`p_user_id` que manda el servicio. La migración se verifica
 * aparte, sobre el archivo.
 */
describe("cash: CL-17 el cobro cierra la factura con sus datos y no cae en un turno cerrado", () => {
  const ACTOR = { userId: "u-1", sedeId: paymentStub.SEDE_ID };
  const MARK = "7e6d5c4b-3a29-4180-9f6e-5d4c3b2a1908";
  const collection = (mark = MARK, amount = 100000) => ({
    cash_shift_id: paymentStub.SHIFT_ID,
    invoice_id: paymentStub.INVOICE_ID,
    method_code: "efectivo",
    amount,
    idempotency_key: mark,
  });

  beforeEach(() => {
    paymentStub.unexpectedQueries.length = 0;
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.rpcCalls.length = 0;
    paymentStub.shiftStatus = "abierto";
    paymentStub.closeShiftBeforeCommit = false;
    paymentStub.invoiceClosedBy = null;
    paymentStub.invoiceClosedAt = null;
  });

  it("Gap 1: la factura se cierra CON responsable e instante, no con `closed_at` NULL", async () => {
    const result = await registerPayment(collection(), ACTOR);

    expect(paymentStub.invoiceStatus).toBe("Pagada");
    // El DATO que la función de la 056 escribe: el usuario que cobra y el
    // instante que resolvió el SERVICIO (mismo reloj que 049 y 050).
    expect(paymentStub.invoiceClosedBy).toBe("u-1");
    expect(paymentStub.invoiceClosedAt).toEqual(expect.any(String));
    expect(paymentStub.invoiceClosedAt).not.toBe("");
    expect(result.invoice_status).toBe("Pagada");
    // El cierre viaja en la MISMA transacción que el dinero: no hay ventana.
    expect(paymentStub.rpcCalls).toHaveLength(1);
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("un cobro PARCIAL no escribe datos de cierre: la factura sigue Emitida", async () => {
    await registerPayment(collection(MARK, 50000), ACTOR);

    // El cierre se escribe SÓLO cuando el servicio decidió cerrar (`p_mark_paid`):
    // un parcial deja la factura Emitida con su saldo, sin `closed_by`/`closed_at`.
    expect(paymentStub.invoiceStatus).toBe("Emitida");
    expect(paymentStub.invoiceClosedBy).toBeNull();
    expect(paymentStub.invoiceClosedAt).toBeNull();
  });

  it("Gap 2: el turno que se cierra a mitad del cobro lo RECHAZA, sin escribir nada", async () => {
    // El cierre concurrente gana la carrera entre la lectura del servicio y el
    // commit: la transacción lo revalida sobre la fila bloqueada.
    paymentStub.closeShiftBeforeCommit = true;

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "SHIFT_CLOSED", status: 409 });
    // Nada escrito: ni el espejo, ni el libro de cajón, ni el cierre.
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
    expect(paymentStub.invoiceStatus).toBe("Emitida");
    expect(paymentStub.invoiceClosedAt).toBeNull();
    expect(paymentStub.deleteCalls).toEqual([]);
    // No vacuidad: la transacción SÍ se intentó y el rechazo es de ADENTRO.
    expect(paymentStub.rpcCalls).toHaveLength(1);
    expect(paymentStub.unexpectedQueries).toEqual([]);
  });

  it("el reintento del MISMO intento COMPLETA el cobro cuando el turno vuelve a estar abierto", async () => {
    paymentStub.closeShiftBeforeCommit = true;
    await registerPayment(collection(), ACTOR).catch((error: unknown) => error);
    expect(paymentStub.ledger).toEqual([]);

    // La transacción rechazada no dejó marca (se revirtió entera), así que el
    // reintento, con el turno abierto, es una operación NUEVA que termina el
    // cobro en vez de un no-op sobre una factura abierta para siempre.
    paymentStub.shiftStatus = "abierto";
    const retry = await registerPayment(collection(), ACTOR);

    expect(retry.invoice_status).toBe("Pagada");
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.invoiceClosedAt).toEqual(expect.any(String));
    expect(paymentStub.invoiceClosedBy).toBe("u-1");
  });

  it("la repetición sigue siendo un no-op: no vuelve a escribir ni a cerrar", async () => {
    const first = await registerPayment(collection(), ACTOR);
    const closedAt = paymentStub.invoiceClosedAt;
    const repeat = await registerPayment(collection(), ACTOR);

    // La marca de la 042 se sigue mirando ANTES de cualquier escritura: el
    // arreglo no puede convertir una repetición en un segundo cobro.
    expect(repeat).toEqual(first);
    expect(paymentStub.ledger).toHaveLength(1);
    expect(paymentStub.drawer).toHaveLength(1);
    expect(paymentStub.rpcCalls).toHaveLength(1);
    expect(paymentStub.invoiceClosedAt).toBe(closedAt);
  });

  it("control negativo: el turno ya cerrado se rechaza en el servicio, sin llamar al RPC", async () => {
    // La precondición de LECTURA sigue viva (y sigue siendo la primera puerta):
    // un turno ya cerrado no llega ni a la transacción.
    paymentStub.shiftStatus = "cerrado";

    const failure: unknown = await registerPayment(collection(), ACTOR).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CashError);
    expect(failure).toMatchObject({ code: "SHIFT_CLOSED", status: 409 });
    expect(paymentStub.rpcCalls).toHaveLength(0);
    expect(paymentStub.ledger).toEqual([]);
    expect(paymentStub.drawer).toEqual([]);
  });

  it("el servicio manda el instante del cierre como DATO (no lo inventa la función)", async () => {
    await registerPayment(collection(), ACTOR);

    const args = paymentStub.rpcCalls[0].args;
    expect(typeof args.p_closed_at).toBe("string");
    expect(args.p_user_id).toBe("u-1");
    expect(args.p_shift_id).toBe(paymentStub.SHIFT_ID);
    expect(args.p_mark_paid).toBe(true);
  });
});

// ------- CL-17: la migración 056 -------

describe("migración 056_collection_closes_invoice.sql (CL-17)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "056_collection_closes_invoice.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // El texto de los `COMMENT ON …` es PROSA que viaja como string, no DDL.
  const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("dropea las DOS firmas viejas y crea las nuevas (una sola sentencia cada una)", () => {
    // PostgreSQL identifica la función por su firma: sin el DROP quedaría viva la
    // sobrecarga vieja, sin lock de turno y sin datos de cierre.
    //
    // HISTORIA, NO ESTADO: estas aserciones fijan el archivo 056 tal como se
    // aplicó, con su parámetro de sede. La vigente es la de 071 (que lo sacó);
    // se afirma en la suite de 071, más abajo.
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb)",
    );
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.invoice_split_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cash_invoice_payment_atomic\(\s*p_sede_id uuid,\s*p_shift_id uuid,\s*p_invoice_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.invoice_split_payment_atomic\(\s*p_sede_id uuid,\s*p_invoice_id uuid,\s*p_shift_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,/,
    );
  });

  it("bloquea el TURNO con FOR SHARE y lo revalida ANTES de la factura", () => {
    // El orden global: cash_shifts > invoices. El `FOR SHARE` del turno tiene que
    // aparecer ANTES del `FOR UPDATE` de la factura, y la revalidación después.
    expect(sql).toContain("FROM public.cash_shifts s");
    expect(sql).toContain("FOR SHARE OF s");
    expect(sql).toContain("v_turno.status <> 'abierto'");
    expect(sql).toContain("'SHIFT_CLOSED'");
    expect(sql).toContain("'SHIFT_NOT_FOUND'");
    const shiftsLock = sql.indexOf("FOR SHARE OF s");
    const invoicesLock = sql.indexOf("FOR UPDATE OF i");
    expect(shiftsLock).toBeGreaterThan(-1);
    expect(invoicesLock).toBeGreaterThan(shiftsLock);
    // El `FOR KEY SHARE` —el lock que hoy toma la FK— NO alcanza: se declara.
    expect(raw).toContain("FOR KEY SHARE");
  });

  it("Gap 1: el cierre de caja escribe closed_by y closed_at, sólo si se cierra", () => {
    const update = sql.slice(
      sql.indexOf("UPDATE public.invoices"),
      sql.indexOf("RETURNING * INTO v_factura"),
    );
    expect(update).toMatch(/status = CASE WHEN p_mark_paid THEN 'Pagada'/);
    expect(update).toMatch(/closed_by = CASE WHEN p_mark_paid THEN p_user_id/);
    expect(update).toMatch(/closed_at = CASE WHEN p_mark_paid THEN p_closed_at/);
  });

  it("el cobro dividido exige que TODAS las porciones sean del turno bloqueado", () => {
    expect(sql).toMatch(/\(item ->> 'cash_shift_id'\)::uuid <> p_shift_id/);
  });

  it("no mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    for (const column of [
      "amount",
      "fee_amount",
      "fee_percent",
      "total",
      "surcharge",
      "subtotal",
      "discount",
      "tax",
    ]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(ddl).not.toContain("CHECK");
    expect(ddl).not.toMatch(/sum\s*\(/i);
    expect(ddl).not.toMatch(/round\s*\(/i);
    expect(ddl).not.toMatch(/trg_invoice_payments_cap/);
    expect(ddl).not.toMatch(/invoices\.total/);
  });

  it("conserva las redes de conteo y las precondiciones de estado", () => {
    // Las mismas redes de 050/053: dos en el cobro dividido, tres en caja.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(5);
    expect(sql).toContain("PAYMENT_MISMATCH");
    expect(sql).toContain("PAYMENT_INVALID");
    expect(sql).toMatch(/v_factura\.status = 'Anulada'/);
    expect(sql).toContain("ANNUL_INVALID");
    expect(sql).toContain("INVOICE_NOT_FOUND");
  });

  it("cierra el permiso de las dos funciones nuevas: sólo service_role", () => {
    for (const signature of [
      "public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb)",
      "public.invoice_split_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, jsonb)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
      expect(sql).toContain(`ALTER FUNCTION ${signature} SET search_path = public`);
    }
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("SECURITY INVOKER");
  });

  it("no borra ni reescribe FILAS: sólo reemplaza funciones y ajusta permisos", () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(2);
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(2);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(2);
    // El único DROP es el de las DOS sobrecargas de función (objetos, no filas).
    expect(sql.match(/DROP FUNCTION IF EXISTS/g) ?? []).toHaveLength(2);
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*DROP TABLE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toMatch(/updated_at/);
    // Dos UPDATE EJECUTABLES: el estado de caja y el cierre del dividido.
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(2);
  });

  it("declara el orden de locks, el reloj, el acoplamiento, la numeración y las ventanas", () => {
    expect(raw).toContain("ORDEN GLOBAL DE LOCKS");
    expect(raw).toContain("QUÉ RELOJ PARA `closed_at`");
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    // El número asignado, el archivo hermano que se espeja y los números ajenos
    // que NO se tocan.
    expect(raw).toContain("056");
    expect(raw).toContain("053");
    expect(raw).toContain("055");
    expect(raw).toContain("057");
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
 * Este camino escribe UNA sola fila en `invoice_payments` (desde CL-14, por la
 * transacción de la 053, pero sigue siendo una sola), así que la marca vive en
 * esa única fila, el índice único parcial nunca puede rechazar una operación
 * legítima y no hay hermanas que enumerar.
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
    paymentStub.ledger.length = 0;
    paymentStub.drawer.length = 0;
    paymentStub.invoiceStatus = "Emitida";
    paymentStub.inserts = {};
    paymentStub.skipMarkLookupOnce = false;
    paymentStub.stalePaymentsOnce = null;
    paymentStub.shiftStatus = "abierto";
    paymentStub.closeShiftBeforeCommit = false;
    paymentStub.invoiceClosedBy = null;
    paymentStub.invoiceClosedAt = null;
    paymentStub.rpcCalls.length = 0;
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
    // ...y las líneas por denominación, en la MISMA tabla del arqueo, fase
    // reconteo. CL-10: viajan como DATO con la fila del reconteo —el `shift_id`
    // y la fase los pone la transacción, no el llamador— y las escribe la MISMA
    // sentencia que firma el reconteo, así que la evidencia por denominación no
    // puede quedar atrás.
    expect(body).toContain("p_counts: countLines(parsed.data.counts)");
    expect(body).not.toContain("insertCounts");
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

// -------------------------------------------------------------------- CL-10 ---
//
// El barrido de atomicidad encontró TRES ventanas de estado parcial en el ciclo
// del turno de caja, de la MISMA clase que CL-7 (046), CL-8 (047) y CL-9 (048):
// dos escrituras seguidas que tienen que ser una sola. Las tres son de la
// familia "FIRMADO SIN SU EVIDENCIA", y dos de ellas son CALLEJONES SIN SALIDA:
// el reintento queda bloqueado por la misma barrera que protege la firma.
//
//   * `openShift` (service.ts): inserta el turno ABIERTO y DESPUÉS su conteo de
//     apertura. Un fallo entre las dos deja un turno abierto sin arqueo: la base
//     con la que abrió el cajón sin respaldo por denominación y el esperado
//     digital del cierre sin su punto de partida. El reintento no abre: el
//     índice parcial de 006 (`uq_cash_shifts_open_per_register`) ya ve un turno
//     abierto.
//   * `closeShift` (service.ts): pisa el turno a `cerrado` con un
//     compare-and-swap y DESPUÉS inserta el conteo del cierre. Un fallo entre
//     las dos deja el cierre FIRMADO sin su evidencia —el turno con su total, su
//     base dejada, su recogido y su sobre, y ninguna línea que diga qué billetes
//     había— y el CAS hace que el reintento responda SHIFT_ALREADY_CLOSED: el
//     conteo por denominación, que es lo que hace real a un arqueo, no se puede
//     volver a escribir. Es la peor de las tres.
//   * `recountClosedShift` (service.ts): inserta la fila del reconteo y DESPUÉS
//     sus líneas de detalle. Un fallo entre las dos deja el reconteo FIRMADO sin
//     su detalle, y el índice único por turno de 033 hace que el reintento
//     responda ALREADY_RECOUNTED. Rompe la promesa exacta que el reconteo existe
//     para cumplir: las DOS versiones, cada una con su evidencia.
//
// Las tres pasan a ser UNA función SQL por operación (migración 049): el
// servicio COMPUTA (qué se cuenta, el total por método, `resolveOpeningBase`,
// `resolveClosingBase`, `computeCashClose` y la detección de desajustes) y la
// función SÓLO ESCRIBE lo que recibe.

describe("cash: CL-10 la apertura y su arqueo de apertura son UNA transacción", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  /** El pre-arqueo: 4 × 50 000 = 200 000, la base configurada de la caja. */
  const COUNTS = [{ method_code: "efectivo", denomination: 50000, quantity: 4, amount: 200000 }];

  /** La caja con su base y las denominaciones configuradas que lee `checkCounts`. */
  function seed(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-50000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 50000,
          is_active: true,
        },
      ],
      cash_shifts: [],
      cash_shift_counts: [],
      cash_shift_recounts: [],
    };
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const counts = () => shiftStub.tables.cash_shift_counts ?? [];
  const openCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_open_shift_atomic");
  /**
   * Escrituras SUELTAS de la operación. La auditoría es un INSERT aparte a
   * propósito (`writeAudit` nunca lanza y no mueve estado), así que queda fuera.
   */
  const loose = () => shiftStub.looseWrites.filter((entry) => entry.table !== "audit_logs");
  const open = () => openShift({ counts: COUNTS }, ACTOR);

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("si el arqueo falla, la apertura no deja NADA escrito (RED medido: hoy deja el turno abierto sin su conteo)", async () => {
    seed();
    // La SEGUNDA escritura falla. En el camino viejo, la primera —el turno— ya
    // quedó confirmada: son dos requests distintos.
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";

    const outcome: unknown = await open().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    // El turno y su arqueo viajan juntos: o quedan los dos, o no queda nada.
    expect(shifts()).toEqual([]);
    expect(counts()).toEqual([]);
    // No es vacuidad del doble: la transacción SÍ se pidió.
    expect(openCalls()).toHaveLength(1);
    // Y ninguna escritura suelta: la apertura ya no escribe por su cuenta.
    expect(loose()).toEqual([]);
  });

  it("el reintento completa la apertura (RED medido: hoy responde SHIFT_ALREADY_OPEN)", async () => {
    seed();
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";
    await open().catch(() => undefined);

    // El reintento, ya sin el fallo: el turno que quedó a medias bloqueaba la
    // caja con el índice único parcial de 006, así que hoy esta llamada lanza
    // SHIFT_ALREADY_OPEN.
    shiftStub.failCounts = null;
    const result = await open();

    expect(result.shift.status).toBe("abierto");
    expect(shifts()).toHaveLength(1);
    expect(counts()).toHaveLength(1);
  });

  it("GREEN: la apertura exitosa escribe el turno y su arqueo, con las MISMAS filas de antes", async () => {
    seed();

    const result = await open();

    // UNA sola escritura para las dos cosas.
    expect(openCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
    // El turno: la fila que insertaba el camino viejo, con la base que el
    // servicio resolvió y el esperado en cero.
    expect(shifts()).toHaveLength(1);
    expect(shifts()[0]).toMatchObject({
      cash_register_id: shiftStub.REGISTER_ID,
      sede_id: shiftStub.SEDE_ID,
      opened_by: shiftStub.USER_ID,
      opening_base: 200000,
      expected_cash: 0,
      status: "abierto",
    });
    // El arqueo: la línea por denominación, con el `shift_id` del turno recién
    // escrito y los montos VERBATIM del conteo validado —las mismas columnas que
    // escribía `insertCounts`—.
    expect(counts()).toEqual([
      expect.objectContaining({
        shift_id: shifts()[0].id,
        phase: "apertura",
        method_code: "efectivo",
        denomination: 50000,
        quantity: 4,
        amount: 200000,
      }),
    ]);
    // El shape del resultado no cambia: las mismas columnas de SHIFT_SELECT.
    expect(Object.keys(result.shift).sort()).toEqual([...SHIFT_COLUMNS].sort());
    expect(result.firstOpen).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(shiftStub.unknownSelects).toEqual([]);
  });

  it("la CARRERA de la apertura se RECHAZA (SHIFT_ALREADY_OPEN) y no escribe nada", async () => {
    seed();
    // Otra apertura de la MISMA caja se confirma entre la lectura del servicio y
    // la transacción. El INSERT suelto no miraba nada: la transacción sí.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.cash_shifts = [
        {
          id: "turno-ajeno",
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: "u-otro",
          status: "abierto",
        },
      ];
    };

    const outcome: unknown = await open().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "SHIFT_ALREADY_OPEN", status: 409 });
    // El turno ajeno queda intacto y del nuestro no queda NADA.
    expect(shifts()).toHaveLength(1);
    expect(shifts()[0].id).toBe("turno-ajeno");
    expect(counts()).toEqual([]);
  });

  it("control negativo: la misma operación SIN el fallo sí escribe (los «nada escrito» no son vacuidad)", async () => {
    seed();

    await open();

    expect(shifts()).toHaveLength(1);
    expect(counts()).toHaveLength(1);
  });
});

describe("cash: CL-10 el cierre y su arqueo de cierre son UNA transacción", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  /** El cierre del caso 300/200 del dueño: 6 × 50 000 contados sobre 300 000 cobrados. */
  const CLOSE_INPUT = {
    counted_cash: 300000,
    counts: [{ method_code: "efectivo", denomination: 50000, quantity: 6, amount: 300000 }],
    confirmed: true as const,
  };

  /** Un turno abierto con 300 000 cobrados en efectivo y sin salidas. */
  function seedOpenShift(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-50000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 50000,
          is_active: true,
        },
      ],
      cash_shifts: [
        {
          id: shiftStub.SHIFT_ID,
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: shiftStub.USER_ID,
          closed_by: null,
          opened_at: "2026-09-30T12:00:00.000Z",
          closed_at: null,
          opening_base: 200000,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: null,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
      ],
      // El único movimiento del turno: un cobro de cajón SIN factura.
      payments: [
        {
          id: "pago-1",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 300000,
        },
      ],
      invoice_payments: [],
      invoices: [],
      commission_payouts: [],
      voucher_requests: [],
      cash_shift_counts: [],
      cash_shift_recounts: [],
    };
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const counts = () => shiftStub.tables.cash_shift_counts ?? [];
  const closeCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_close_shift_atomic");
  const loose = () => shiftStub.looseWrites.filter((entry) => entry.table !== "audit_logs");
  const close = (raw: unknown = CLOSE_INPUT) =>
    closeShift(shiftStub.SHIFT_ID, raw, ACTOR);

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("si el arqueo de cierre falla, el cierre no queda firmado (RED medido: hoy queda cerrado y sin conteo)", async () => {
    seedOpenShift();
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    // El turno y su evidencia viajan juntos: o queda el cierre CON su conteo, o
    // el turno sigue ABIERTO. Hoy queda `cerrado` con cero líneas: firmado sin
    // la prueba que lo hace real.
    expect(shifts()[0].status).toBe("abierto");
    expect(counts()).toEqual([]);
    expect(closeCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
  });

  it("el reintento completa el cierre: el callejón sin salida queda cerrado (RED medido: hoy responde SHIFT_ALREADY_CLOSED)", async () => {
    seedOpenShift();
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";
    await close().catch(() => undefined);

    // El reintento, ya sin el fallo. Hoy lanza SHIFT_ALREADY_CLOSED: el CAS sólo
    // pisa un turno abierto, así que el conteo por denominación no se podía
    // volver a escribir NUNCA.
    shiftStub.failCounts = null;
    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    expect(shifts()[0].status).toBe("cerrado");
    expect(counts()).toHaveLength(1);
    expect(counts()[0]).toMatchObject({ phase: "cierre", amount: 300000 });
  });

  it("GREEN: el cierre exitoso escribe el turno y su arqueo, con las MISMAS filas de antes", async () => {
    seedOpenShift();

    const result = await close();

    expect(closeCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
    // El turno cerrado: los MISMOS montos que calculaba el servicio, escritos
    // verbatim por la transacción.
    expect(shifts()[0]).toMatchObject({
      expected_cash: 300000,
      counted_cash: 300000,
      base_left: 200000,
      cash_withdrawn: 100000,
      base_difference: 0,
      status: "cerrado",
      closed_by: shiftStub.USER_ID,
      observation: null,
    });
    expect(typeof shifts()[0].closed_at).toBe("string");
    // El arqueo: la línea por denominación, con la fase del cierre.
    expect(counts()).toEqual([
      expect.objectContaining({
        shift_id: shiftStub.SHIFT_ID,
        phase: "cierre",
        method_code: "efectivo",
        denomination: 50000,
        quantity: 6,
        amount: 300000,
      }),
    ]);
    // El shape del resultado no cambia: las mismas columnas de SHIFT_SELECT.
    expect(Object.keys(result.shift).sort()).toEqual([...SHIFT_COLUMNS].sort());
    expect(result.vales).toBe(0);
    expect(result.methodDifferences).toEqual([]);
    expect(shiftStub.unknownSelects).toEqual([]);
  });

  it("la transacción ESCRIBE lo que el servicio calculó: ningún monto se recalcula en SQL", async () => {
    seedOpenShift();

    await close();

    // El payload que la base recibió es exactamente el que armó la aritmética de
    // TypeScript: el esperado del arqueo (300 000 cobrados), la base dejada que
    // resolvió `resolveClosingBase` (el mínimo entre lo contado y la
    // configurada), y el recogido y el sobre que resolvió `computeCashClose`
    // (200 000 y 0). Si la función sumara o restara, estos números no podrían
    // venir dados.
    expect(closeCalls()[0].args.p_close).toEqual({
      expected_cash: 300000,
      counted_cash: 300000,
      base_left: 200000,
      cash_withdrawn: 100000,
      base_difference: 0,
      observation: null,
    });
    expect(closeCalls()[0].args.p_counts).toEqual([
      { method_code: "efectivo", denomination: 50000, quantity: 6, amount: 300000 },
    ]);
    expect(closeCalls()[0].args.p_shift_id).toBe(shiftStub.SHIFT_ID);
    expect(closeCalls()[0].args.p_closed_by).toBe(shiftStub.USER_ID);
    expect(typeof closeCalls()[0].args.p_closed_at).toBe("string");
    // Y la auditoría sigue contando lo mismo que antes.
    const audit = shiftStub.inserts.find((entry) => entry.table === "audit_logs");
    expect(audit?.payload).toMatchObject({
      action: AUDIT_ACTIONS.SHIFT_CLOSED,
      entity_id: shiftStub.SHIFT_ID,
      metadata: {
        expected_cash: 300000,
        counted_cash: 300000,
        base_left: 200000,
        base_difference: 0,
        base_incompleta: false,
        admin_override: false,
        payouts_out: 0,
        vouchers_out: 0,
        invoices_total: 0,
        invoices_count: 0,
        method_differences: [],
      },
    });
    expect(audit?.payload).not.toHaveProperty("sede_id");
  });

  it("la CARRERA del cierre se RECHAZA (SHIFT_ALREADY_CLOSED) y no deja los conteos de la perdedora", async () => {
    seedOpenShift();
    // Otro cierre del MISMO turno se confirma entre la lectura del servicio y la
    // transacción: el CAS de adentro ve `cerrado` y rechaza.
    shiftStub.beforeRpc = () => {
      const row = shifts()[0];
      row.status = "cerrado";
      row.counted_cash = 100000;
      row.base_left = 100000;
      row.cash_withdrawn = 0;
      row.base_difference = -100000;
      row.closed_at = "2026-09-30T13:00:00.000Z";
      row.closed_by = "u-otro";
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "SHIFT_ALREADY_CLOSED", status: 409 });
    // El cierre ajeno queda como lo dejó el otro y del nuestro no queda NADA.
    expect(shifts()[0]).toMatchObject({ counted_cash: 100000, closed_by: "u-otro" });
    expect(counts()).toEqual([]);
  });

  it("la precondición de estado no se salta: un turno YA CERRADO no se cierra otra vez", async () => {
    seedOpenShift();
    // La lectura del servicio ya ve el turno cerrado (otro cerró antes).
    Object.assign(shifts()[0], { status: "cerrado", counted_cash: 300000, base_left: 200000 });

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "SHIFT_ALREADY_CLOSED", status: 409 });
    // Ni siquiera se abrió una transacción.
    expect(closeCalls()).toHaveLength(0);
    expect(counts()).toEqual([]);
  });

  it("el CHECK de 006 sigue vivo: las salidas en efectivo no pueden superar lo cobrado", async () => {
    seedOpenShift();
    // Una comisión pagada en efectivo por más de lo cobrado: el esperado queda
    // negativo y la base lo rechaza DENTRO de la transacción. Es una regla de
    // NEGOCIO, y el servicio la sigue traduciendo al mismo código.
    shiftStub.tables.commission_payouts = [
      {
        id: "pago-comision",
        cash_shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 500000,
      },
    ];

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "CASH_OUT_EXCEEDS_COLLECTED", status: 422 });
    // Nada quedó firmado: el turno sigue abierto y sin arqueo de cierre.
    expect(shifts()[0].status).toBe("abierto");
    expect(counts()).toEqual([]);
  });

  it("control negativo: la misma operación SIN el fallo sí escribe (los «nada escrito» no son vacuidad)", async () => {
    seedOpenShift();

    await close();

    expect(shifts()[0].status).toBe("cerrado");
    expect(counts()).toHaveLength(1);
  });
});

describe("cash: CL-10 el reconteo y su detalle son UNA transacción", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  const RECOUNT_INPUT = {
    counted_cash: 400000,
    counts: [{ method_code: "efectivo", denomination: 50000, quantity: 8, amount: 400000 }],
    reason: "Faltaba un billete en el conteo.",
  };

  /** Un cierre firmado de 300 000 contados con base dejada de 200 000. */
  function seedClosedShift(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-50000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 50000,
          is_active: true,
        },
      ],
      cash_shifts: [
        {
          id: shiftStub.SHIFT_ID,
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: shiftStub.USER_ID,
          closed_by: shiftStub.USER_ID,
          opened_at: "2026-09-30T12:00:00.000Z",
          closed_at: "2026-09-30T13:00:00.000Z",
          opening_base: 200000,
          expected_cash: 300000,
          counted_cash: 300000,
          base_left: 200000,
          cash_withdrawn: 100000,
          base_difference: 0,
          status: "cerrado",
          observation: null,
        },
      ],
      cash_shift_counts: [
        {
          id: "conteo-cierre",
          shift_id: shiftStub.SHIFT_ID,
          phase: "cierre",
          method_code: "efectivo",
          denomination: 50000,
          quantity: 6,
          amount: 300000,
        },
      ],
      cash_shift_recounts: [],
      payments: [],
      invoice_payments: [],
      invoices: [],
      commission_payouts: [],
      voucher_requests: [],
    };
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const rows = () => shiftStub.tables.cash_shift_counts ?? [];
  const recounts = () => shiftStub.tables.cash_shift_recounts ?? [];
  const recountCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_recount_shift_atomic");
  const loose = () => shiftStub.looseWrites.filter((entry) => entry.table !== "audit_logs");
  const recount = (raw: unknown = RECOUNT_INPUT) =>
    recountClosedShift(shiftStub.SHIFT_ID, raw, ACTOR);

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("si el detalle falla, el reconteo no queda firmado (RED medido: hoy queda firmado sin sus líneas)", async () => {
    seedClosedShift();
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";

    const outcome: unknown = await recount().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    // La fila del reconteo y su detalle viajan juntos: o quedan los dos, o no
    // queda nada. Hoy queda la fila con las dos versiones y CERO líneas: la
    // corrección firmada sin la prueba que la respalda.
    expect(recounts()).toEqual([]);
    expect(rows().filter((row) => row.phase === "reconteo")).toEqual([]);
    expect(recountCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
  });

  it("el reintento completa el reconteo: el callejón sin salida queda cerrado (RED medido: hoy responde ALREADY_RECOUNTED)", async () => {
    seedClosedShift();
    shiftStub.failCounts = "SHIFT_COUNT_MISMATCH";
    await recount().catch(() => undefined);

    // El reintento, ya sin el fallo. Hoy lanza ALREADY_RECOUNTED: el índice único
    // por turno de 033 ve la fila que quedó firmada sin detalle, así que el
    // reconteo no se podía completar NUNCA.
    shiftStub.failCounts = null;
    const result = await recount();

    expect(result.recount.counted_cash).toBe(400000);
    expect(recounts()).toHaveLength(1);
    expect(rows().filter((row) => row.phase === "reconteo")).toHaveLength(1);
  });

  it("GREEN: el reconteo exitoso escribe su fila y su detalle, con las MISMAS filas de antes", async () => {
    seedClosedShift();

    const result = await recount();

    expect(recountCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
    // La fila del reconteo: las DOS versiones y el motivo.
    expect(recounts()).toEqual([
      expect.objectContaining({
        shift_id: shiftStub.SHIFT_ID,
        previous_counted_cash: 300000,
        previous_base_left: 200000,
        previous_cash_withdrawn: 100000,
        previous_base_difference: 0,
        counted_cash: 400000,
        base_left: 200000,
        cash_withdrawn: 200000,
        base_difference: 0,
        reason: "Faltaba un billete en el conteo.",
        recounted_by: shiftStub.USER_ID,
      }),
    ]);
    // El detalle por denominación, en la MISMA tabla del arqueo, fase reconteo.
    expect(rows().filter((row) => row.phase === "reconteo")).toEqual([
      expect.objectContaining({
        shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        denomination: 50000,
        quantity: 8,
        amount: 400000,
      }),
    ]);
    // El cierre firmado NO se toca: la versión anterior se lee de la tabla vieja
    // y sigue intacta.
    expect(shifts()[0]).toMatchObject({ counted_cash: 300000, status: "cerrado" });
    expect(shiftStub.updates.filter((entry) => entry.table === "cash_shifts")).toEqual([]);
    // El shape del resultado no cambia: las mismas columnas de RECOUNT_SELECT.
    expect(Object.keys(result.recount).sort()).toEqual([...RECOUNT_COLUMNS].sort());
    expect(shiftStub.unknownSelects).toEqual([]);
  });

  it("la transacción ESCRIBE lo que el servicio calculó: ninguna versión se recalcula en SQL", async () => {
    seedClosedShift();

    await recount();

    // La versión anterior congelada y la corregida son las que armó
    // `buildRecountRecord` con la MISMA maquinaria del cierre
    // (`resolveClosingBase` + `computeCashClose`): mínimo entre lo contado y la
    // base configurada, y el recogido y el sobre derivados. Nada de esto se
    // recalcula en SQL.
    expect(recountCalls()[0].args.p_recount).toEqual({
      previous_counted_cash: 300000,
      previous_base_left: 200000,
      previous_cash_withdrawn: 100000,
      previous_base_difference: 0,
      counted_cash: 400000,
      base_left: 200000,
      cash_withdrawn: 200000,
      base_difference: 0,
      reason: "Faltaba un billete en el conteo.",
    });
    expect(recountCalls()[0].args.p_counts).toEqual([
      { method_code: "efectivo", denomination: 50000, quantity: 8, amount: 400000 },
    ]);
    expect(recountCalls()[0].args.p_shift_id).toBe(shiftStub.SHIFT_ID);
    expect(recountCalls()[0].args.p_recounted_by).toBe(shiftStub.USER_ID);
    // La auditoría conserva las dos versiones y el motivo.
    const audit = shiftStub.inserts.find((entry) => entry.table === "audit_logs");
    expect(audit?.payload).toMatchObject({
      action: AUDIT_ACTIONS.SHIFT_RECOUNTED,
      entity_id: shiftStub.SHIFT_ID,
      metadata: {
        reason: "Faltaba un billete en el conteo.",
        previous: { counted_cash: 300000, base_left: 200000 },
        corrected: { counted_cash: 400000, base_left: 200000 },
      },
    });
    expect(audit?.payload).not.toHaveProperty("sede_id");
  });

  it("la CARRERA del reconteo se RECHAZA (ALREADY_RECOUNTED) y no deja nada de la perdedora", async () => {
    seedClosedShift();
    // Otro reconteo del MISMO cierre se confirma entre el chequeo del servicio y
    // la transacción: el índice único por turno de 033 lo protege adentro.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.cash_shift_recounts = [
        {
          id: "reconteo-ajeno",
          shift_id: shiftStub.SHIFT_ID,
          reason: "Otro reconteo.",
          counted_cash: 123,
          recounted_by: "u-otro",
        },
      ];
    };

    const outcome: unknown = await recount().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ALREADY_RECOUNTED", status: 409 });
    // El ajeno queda intacto y de nuestra corrección no queda NADA.
    expect(recounts()).toHaveLength(1);
    expect(recounts()[0].id).toBe("reconteo-ajeno");
    expect(rows().filter((row) => row.phase === "reconteo")).toEqual([]);
  });

  it("la precondición de estado no se salta: un turno ABIERTO no se recontá", async () => {
    seedClosedShift();
    shifts()[0].status = "abierto";

    const outcome: unknown = await recount().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "VALIDATION", status: 400 });
    // Ni siquiera se abrió una transacción.
    expect(recountCalls()).toHaveLength(0);
    expect(recounts()).toEqual([]);
  });

  it("control negativo: la misma operación SIN el fallo sí escribe (los «nada escrito» no son vacuidad)", async () => {
    seedClosedShift();

    await recount();

    expect(recounts()).toHaveLength(1);
    expect(rows().filter((row) => row.phase === "reconteo")).toHaveLength(1);
  });
});

describe("cash: CL-10 el diff del servicio vive en el bloque de persistencia", () => {
  const service = readFileSync(
    join(process.cwd(), "src", "features", "cash", "service.ts"),
    "utf8",
  );

  /** Cuerpo del `export async function <name>`. */
  function bodyOf(name: string): string {
    const start = service.indexOf(`export async function ${name}`);
    expect(start, `existe ${name}`).toBeGreaterThan(-1);
    const end = service.indexOf("export async function", start + 10);
    return service.slice(start, end === -1 ? service.length : end);
  }

  /** Cadena desde cada `.from("<tabla>")` hasta el siguiente `.from(`. */
  function chains(source: string, table: string): string[] {
    return source
      .split(`.from("${table}")`)
      .slice(1)
      .map((chunk) => {
        const end = chunk.indexOf(".from(");
        return end === -1 ? chunk : chunk.slice(0, end);
      });
  }

  it("las TRES operaciones escriben por RPC y ninguna abre una escritura suelta", () => {
    const cases = [
      { name: "openShift", rpc: "cash_open_shift_atomic", table: "cash_shifts" },
      { name: "closeShift", rpc: "cash_close_shift_atomic", table: "cash_shifts" },
      {
        name: "recountClosedShift",
        rpc: "cash_recount_shift_atomic",
        table: "cash_shift_recounts",
      },
    ] as const;

    for (const item of cases) {
      const body = bodyOf(item.name);
      // UNA transacción por operación: ni dos `rpc` por un descuido, ni uno de
      // menos.
      expect(body.match(/db\.rpc\(/g) ?? [], item.name).toHaveLength(1);
      expect(body, item.name).toContain(`db.rpc("${item.rpc}"`);
      // El turno (o el reconteo) ya no se escribe con un INSERT/UPDATE suelto.
      const writes = chains(body, item.table).filter(
        (chain) =>
          chain.trimStart().startsWith(".insert(") || chain.trimStart().startsWith(".update("),
      );
      expect(writes, item.name).toEqual([]);
      // Las líneas de conteo ya no se insertan desde el cliente: viajan como
      // DATO con la operación y las escribe su transacción.
      expect(body, item.name).not.toContain('.from("cash_shift_counts")');
      expect(body, item.name).not.toContain("insertCounts");
      expect(body, item.name).toContain("p_counts: countLines(");
    }
  });

  it("la aritmética del arqueo se queda en TypeScript: viaja como DATO, no como SQL", () => {
    // Los cuatro puntos que el servicio COMPUTA y que la función escribe
    // verbatim. Si alguno se hubiera movido al RPC, no estaría acá.
    expect(bodyOf("openShift")).toContain("resolveOpeningBase(");
    expect(bodyOf("closeShift")).toContain("resolveClosingBase(");
    expect(bodyOf("closeShift")).toContain("computeCashClose({");
    expect(bodyOf("recountClosedShift")).toContain("buildRecountRecord({");
    // El detalle por denominación sale de `checkCounts` (métodos arqueables y
    // denominaciones configuradas), no de una lectura del RPC.
    for (const name of ["openShift", "closeShift", "recountClosedShift"]) {
      expect(bodyOf(name), name).toContain("checkCounts(");
      expect(bodyOf(name), name).toContain("countLines(");
    }
    // Y la detección de desajustes del cierre sigue siendo del servicio.
    expect(bodyOf("closeShift")).toContain("expectedDigitalTotal(");
    expect(bodyOf("closeShift")).toContain("methodDifferences");
  });

  it("el shape devuelto es el MISMO que el servicio leía (SHIFT_SELECT / RECOUNT_SELECT)", () => {
    // Las dos listas de columnas del test no son una transcripción a mano: se
    // comparan contra los `select(...)` con los que el servicio leía esas filas
    // antes de CL-10, y son también las que el `jsonb_build_object` del RPC
    // devuelve (ver el bloque de la migración 049).
    const columnsOf = (name: string): string[] => {
      const match = new RegExp(`const ${name} =\\s*"([^"]+)"`).exec(service);
      expect(match, name).not.toBeNull();
      return (match as RegExpExecArray)[1].split(",").map((column) => column.trim());
    };

    expect(columnsOf("SHIFT_SELECT")).toEqual(SHIFT_COLUMNS);
    expect(columnsOf("RECOUNT_SELECT")).toEqual(RECOUNT_COLUMNS);
  });
});

// -------------------------------------------------------------------- CL-19 ---
//
// El cierre computa el arqueo en el SERVICIO, ANTES de su transacción:
// `closeShift` lee los dos ledgers del turno —`payments` sin factura y las
// `invoice_payments` atribuidas al turno— y de ahí sale `expected_cash`. La
// transacción del cierre (049) bloquea la fila del turno DESPUÉS, y el cobro
// (056) toma `FOR SHARE` sobre esa MISMA fila: los dos se serializan, pero el
// arqueo ya estaba computado cuando el lock se tomó. Un cobro que se confirma
// entre la lectura y el lock queda FUERA del arqueo firmado, y el cierre firma
// un `expected_cash` corto por dinero que sí entró al turno.
//
// CL-19 cierra esa ventana con una PRECONDICIÓN (CAS), no con un recálculo: el
// servicio manda, junto con el arqueo, el TOKEN del conjunto de cobros que leyó
// —los CONTEO de filas de las dos fuentes, no sus sumas: sumar dinero en SQL
// está prohibido en este proyecto— y la transacción, BAJO EL LOCK DEL TURNO,
// vuelve a contar esas filas y RECHAZA el cierre si alguna cambió.
describe("cash: CL-19 el cierre no firma un arqueo que ya no corresponde", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  /** El cierre del caso 300/200 del dueño: 6 × 50 000 contados sobre 300 000 cobrados. */
  const CLOSE_INPUT = {
    counted_cash: 300000,
    counts: [{ method_code: "efectivo", denomination: 50000, quantity: 6, amount: 300000 }],
    confirmed: true as const,
  };

  /** Un turno abierto con 300 000 cobrados en efectivo y sin salidas. */
  function seedOpenShift(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-50000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 50000,
          is_active: true,
        },
      ],
      cash_shifts: [
        {
          id: shiftStub.SHIFT_ID,
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: shiftStub.USER_ID,
          closed_by: null,
          opened_at: "2026-09-30T12:00:00.000Z",
          closed_at: null,
          opening_base: 200000,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: null,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
      ],
      // El único movimiento del turno: un cobro de cajón SIN factura.
      payments: [
        {
          id: "pago-1",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 300000,
        },
      ],
      invoice_payments: [],
      invoices: [],
      commission_payouts: [],
      voucher_requests: [],
      cash_shift_counts: [],
      cash_shift_recounts: [],
    };
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const counts = () => shiftStub.tables.cash_shift_counts ?? [];
  const closeCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_close_shift_atomic");
  const loose = () => shiftStub.looseWrites.filter((entry) => entry.table !== "audit_logs");
  const close = (raw: unknown = CLOSE_INPUT) =>
    closeShift(shiftStub.SHIFT_ID, raw, ACTOR);
  /** El efectivo que REALMENTE entró al turno, leído del ledger. */
  const collectedCash = (): number =>
    (shiftStub.tables.payments ?? [])
      .filter((row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.invoice_id == null)
      .reduce((acc, row) => acc + Number(row.amount), 0);
  /** El mismo turno, ya CERRADO con su arqueo: el punto de partida del reconteo. */
  function seedClosedShift(): void {
    seedOpenShift();
    Object.assign(shifts()[0], {
      status: "cerrado",
      closed_by: shiftStub.USER_ID,
      closed_at: "2026-09-30T13:00:00.000Z",
      expected_cash: 300000,
      counted_cash: 300000,
      base_left: 200000,
      cash_withdrawn: 100000,
      base_difference: 0,
    });
    shiftStub.tables.cash_shift_counts = [
      {
        id: "conteo-cierre",
        shift_id: shiftStub.SHIFT_ID,
        phase: "cierre",
        method_code: "efectivo",
        denomination: 50000,
        quantity: 6,
        amount: 300000,
      },
    ];
  }

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("un cobro que se confirma entre la lectura del arqueo y el lock hace que el cierre RECHAZE (ARQUEO_STALE) y no escriba NADA", async () => {
    seedOpenShift();
    // El cobro que entra en el medio: 100 000 en efectivo, al MISMO turno.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.payments = [
        ...(shiftStub.tables.payments ?? []),
        {
          id: "pago-2",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    // Es un rechazo de CONTRATO con su código propio y su mensaje accionable,
    // no un fallo interno.
    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect((outcome as CashError).message).toBe(
      "Las colecciones del turno cambiaron mientras se cerraba: vuelva a intentar.",
    );
    // Y no quedó NADA escrito: el turno sigue ABIERTO y sin arqueo de cierre
    // —ni siquiera la fila de auditoría, que el servicio escribe después—.
    expect(shifts()[0]).toMatchObject({ status: "abierto", expected_cash: 0 });
    expect(counts()).toEqual([]);
    expect(shiftStub.tables.cash_shift_recounts ?? []).toEqual([]);
    expect(shiftStub.inserts.filter((entry) => entry.table === "audit_logs")).toEqual([]);
    // No es vacuidad del doble: la transacción SÍ se pidió y ninguna escritura
    // suelta salió de la operación.
    expect(closeCalls()).toHaveLength(1);
    expect(loose()).toEqual([]);
  });

  it("el reintento con un arqueo FRESCO cierra, y ahora el arqueo SÍ cuenta el cobro", async () => {
    seedOpenShift();
    shiftStub.beforeRpc = () => {
      shiftStub.tables.payments = [
        ...(shiftStub.tables.payments ?? []),
        {
          id: "pago-2",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };
    await close().catch(() => undefined);

    // El reintento: el servicio vuelve a leer los ledgers (ahora sí ve el cobro),
    // computa el arqueo con él y manda un token que coincide con la base.
    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    // El arqueo firmado es el del dinero que REALMENTE entró: 400 000, no 300 000.
    expect(collectedCash()).toBe(400000);
    expect(shifts()[0]).toMatchObject({
      status: "cerrado",
      expected_cash: 400000,
      counted_cash: 300000,
    });
    // Y el cierre quedó firmado CON su evidencia.
    expect(counts()).toHaveLength(1);
    expect(counts()[0]).toMatchObject({ phase: "cierre", amount: 300000 });
  });

  it("un cobro de FACTURA que entra en el medio también se rechaza: el token cubre las dos fuentes", async () => {
    seedOpenShift();
    // El segundo ledger del arqueo: una porción de `invoice_payments` atribuida al
    // turno que se confirma entre la lectura y el lock. La primera fuente del
    // token no cambia; la segunda sí.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.invoice_payments = [
        ...(shiftStub.tables.invoice_payments ?? []),
        {
          id: "cobro-1",
          invoice_id: "factura-1",
          cash_shift_id: shiftStub.SHIFT_ID,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect(shifts()[0].status).toBe("abierto");
    expect(counts()).toEqual([]);
  });

  it("las filas HISTÓRICAS sin turno también cuentan en el token (la unión de `fetchInvoicePaymentsByShift`)", async () => {
    seedOpenShift();
    // Una fila histórica del ledger de factura: su cobro no lleva turno, y el
    // arqueo la atribuye a la factura, que sí pertenece a este turno. El token
    // tiene que contarla IGUAL que el conteo de la transacción; si no, el cierre
    // se rechazaría contra una base que no cambió.
    shiftStub.tables.invoices = [
      { id: "factura-1", sede_id: shiftStub.SEDE_ID, cash_shift_id: shiftStub.SHIFT_ID },
    ];
    shiftStub.tables.invoice_payments = [
      {
        id: "cobro-historico",
        invoice_id: "factura-1",
        cash_shift_id: null,
        method_code: "efectivo",
        amount: 50000,
      },
    ];

    // Control positivo: con la fila histórica quieta, el cierre pasa —el token la
    // cuenta de las dos puntas—.
    const result = await close();
    expect(result.shift.status).toBe("cerrado");

    // Y una SEGUNDA fila histórica que entra en el medio se rechaza.
    seedOpenShift();
    shiftStub.tables.invoices = [
      { id: "factura-1", sede_id: shiftStub.SEDE_ID, cash_shift_id: shiftStub.SHIFT_ID },
    ];
    shiftStub.tables.invoice_payments = [
      {
        id: "cobro-historico",
        invoice_id: "factura-1",
        cash_shift_id: null,
        method_code: "efectivo",
        amount: 50000,
      },
    ];
    shiftStub.beforeRpc = () => {
      shiftStub.tables.invoice_payments = [
        ...(shiftStub.tables.invoice_payments ?? []),
        {
          id: "cobro-historico-2",
          invoice_id: "factura-1",
          cash_shift_id: null,
          method_code: "efectivo",
          amount: 50000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect(shifts()[0].status).toBe("abierto");
    expect(counts()).toEqual([]);
  });

  it("el token viaja como DATO: los CONTEO de las dos fuentes que el arqueo sumó", async () => {
    seedOpenShift();
    // Una segunda fuente real: dos porciones del ledger de factura del turno.
    shiftStub.tables.invoice_payments = [
      {
        id: "cobro-1",
        invoice_id: "factura-1",
        cash_shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 100000,
      },
      {
        id: "cobro-2",
        invoice_id: "factura-1",
        cash_shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 50000,
      },
    ];

    await close();

    // Un cobro de cajón sin factura y dos porciones de factura: 1 y 2, contados
    // —NO sumados—. Si el token fuera una suma, estos números serían 300 000 y
    // 150 000. CL-20: el mismo objeto lleva los DOS conteo de las salidas que el
    // arqueo resta, en cero porque este turno no tiene ninguna.
    expect(closeCalls()[0].args.p_collection_counts).toEqual({
      payments: 1,
      invoice_payments: 2,
      commission_payouts: 0,
      voucher_requests: 0,
    });
  });

  it("el RECONTEO no lleva token: corregir un cierre firmado es otra operación", async () => {
    seedClosedShift();

    const result = await recountClosedShift(
      shiftStub.SHIFT_ID,
      {
        counted_cash: 400000,
        counts: [{ method_code: "efectivo", denomination: 50000, quantity: 8, amount: 400000 }],
        reason: "Faltaba un billete en el conteo.",
      },
      ACTOR,
    );

    const recountCalls = shiftStub.rpcCalls.filter(
      (call) => call.name === "cash_recount_shift_atomic",
    );
    expect(recountCalls).toHaveLength(1);
    expect(recountCalls[0].args).not.toHaveProperty("p_collection_counts");
    expect(result.recount.counted_cash).toBe(400000);
  });

  it("control negativo: la misma operación SIN el cobro en el medio sí cierra (los «no escribió» no son vacuidad)", async () => {
    seedOpenShift();

    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    // Y el arqueo firmado es exactamente el dinero del ledger: no es que el
    // cierre firme cualquier cosa cuando nadie cambió el conjunto.
    expect(collectedCash()).toBe(shifts()[0].expected_cash);
    expect(counts()).toHaveLength(1);
  });

  it("un turno SIN cobros cierra igual: un token en CERO es un token válido", async () => {
    seedOpenShift();
    // La otra punta del contrato: un ledger VACÍO no puede quedar sin poder
    // cerrarse por una precondición que confunda «cero» con «no vino».
    shiftStub.tables.payments = [];

    await close();

    expect(closeCalls()[0].args.p_collection_counts).toEqual({
      payments: 0,
      invoice_payments: 0,
      commission_payouts: 0,
      voucher_requests: 0,
    });
    expect(shifts()[0]).toMatchObject({ status: "cerrado", expected_cash: 0 });
  });

  it("el servicio arma el token con las MISMAS filas que suman y restan el arqueo y traduce el rechazo", () => {
    const service = readFileSync(
      join(process.cwd(), "src", "features", "cash", "service.ts"),
      "utf8",
    );
    const start = service.indexOf("export async function closeShift");
    const close = service.slice(start, service.indexOf("export async function", start + 10));
    // El token sale de las CUATRO listas que el arqueo usa —las dos que une y las
    // dos que resta—, contadas —no sumadas—, y viaja como DATO en la llamada al
    // RPC. El conteo de vales sale de la MISMA lista que el arqueo descuenta
    // (`fetchVoucherOutRows`), no de una lectura aparte.
    expect(close).toContain("const collectionCounts = {");
    expect(close).toContain("payments: shiftPayments.length");
    expect(close).toContain("invoice_payments: invoicePays.length");
    expect(close).toContain("commission_payouts: payoutRows.length");
    expect(close).toContain("voucher_requests: voucherRows.length");
    // CL-21: las dos listas que lee el propio cierre salen de la lectura
    // EXHAUSTIVA (y el conteo es el `length` de ESA lista, no el de una lectura
    // aparte): el token y el arqueo no pueden mirar conjuntos distintos.
    expect(close.match(/readAllSource</g) ?? []).toHaveLength(2);
    expect(close).toContain('table: "payments"');
    expect(close).toContain('table: "commission_payouts"');
    expect(close).toContain("const voucherRows = voucherRowsByShift.get(shift.id) ?? []");
    expect(close).toContain("voucherOutByMethod(voucherRows)");
    expect(close).toContain("p_collection_counts: collectionCounts");
    // Y el rechazo de la transacción se traduce a su código propio.
    expect(close).toContain('errorMessage.includes("ARQUEO_STALE")');
    expect(close).toContain('"ARQUEO_STALE",');
    expect(close).toContain(
      '"Las colecciones del turno cambiaron mientras se cerraba: vuelva a intentar.",',
    );
    // La aritmética del arqueo no se movió: se sigue computando en TypeScript.
    expect(close).toContain("computeCashClose({");
    expect(close).toContain("expectedDigitalTotal(");
  });
});

// -------------------------------------------------------------------- CL-21 ---
//
// Las CUATRO lecturas que alimentan el arqueo del cierre —`payments` del turno
// sin factura y las `invoice_payments` atribuidas al turno (las que SUMA), más
// los `commission_payouts` del turno y los vales APROBADOS (las que RESTA)— no
// estaban paginadas, y dos de sus fetchers son COMPARTIDOS con la vista del día
// y el historial. El Data API de Supabase sirve, por request, a lo sumo
// `max-rows` filas (1000 por defecto): un turno con más movimiento que ese techo
// se leía RECORTADO y en silencio.
//
// Desde 058/059 el recorte ya no firma un arqueo corto —el TOKEN sale de la
// MISMA lectura recortada y la transacción RECHAZA con ARQUEO_STALE— , pero el
// resultado era un CALLEJÓN SIN SALIDA: ese turno no se podía cerrar nunca, y el
// operador no tenía salida.
//
// El arreglo no toca la aritmética, ni el token, ni la precondición: las mismas
// cuatro fuentes se leen EXHAUSTIVAS con el helper de la casa (`readAllPaged`),
// en un orden determinista (el `id` de la tabla, el orden de la PAGINACIÓN), y
// una lectura que no se complete falla A LA VISTA. El doble ya modela el techo
// por request del Data API (`shiftStub.rowCap`), así que la truncación existe en
// el test y no hace falta afirmar sobre el texto del servicio.
describe("cash: CL-21 el arqueo lee sus CUATRO fuentes de forma exhaustiva", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  /** Más filas que el techo por request del Data API: el turno «ocupado». */
  const BUSY = 1200;
  /** El conteo declarado: el efectivo real en «billetes» de 1 000. */
  const COUNTED = 2162000;
  const CLOSE_INPUT = {
    counted_cash: COUNTED,
    counts: [{ method_code: "efectivo", denomination: 1000, quantity: 2162, amount: COUNTED }],
    confirmed: true as const,
  };

  /**
   * Un turno ABIERTO de la fecha del día con MÁS filas que el techo en las cuatro
   * fuentes: 1 200 cobros de cajón, 1 200 cobros de factura (+ 2 históricos sin
   * turno), 1 200 comisiones pagadas y 1 200 vales aprobados (más uno pendiente,
   * que NO toca caja). Todo en efectivo, para que el arqueo sea legible.
   */
  function seedBusyShift(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-1000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 1000,
          is_active: true,
        },
      ],
      users: [{ id: shiftStub.USER_ID, full_name: "Cajero de prueba" }],
      cash_shifts: [
        {
          id: shiftStub.SHIFT_ID,
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: shiftStub.USER_ID,
          closed_by: null,
          // La hora de Bogotá, como la escriben las vistas: así los filtros de
          // rango de `getDayView`/`getHistory` comparan de verdad.
          opened_at: "2026-09-30T13:00:00-05:00",
          closed_at: null,
          opening_base: shiftStub.BASE_CONFIGURADA,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: null,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
      ],
      payments: Array.from({ length: BUSY }, (_, index) => ({
        id: `pago-${String(index).padStart(4, "0")}`,
        sede_id: shiftStub.SEDE_ID,
        cash_shift_id: shiftStub.SHIFT_ID,
        invoice_id: null,
        method_code: "efectivo",
        amount: 1000,
      })),
      invoices: [
        { id: "factura-1", sede_id: shiftStub.SEDE_ID, cash_shift_id: shiftStub.SHIFT_ID },
      ],
      invoice_payments: [
        ...Array.from({ length: BUSY }, (_, index) => ({
          id: `cobro-${String(index).padStart(4, "0")}`,
          invoice_id: `factura-${String(index).padStart(4, "0")}`,
          cash_shift_id: shiftStub.SHIFT_ID,
          method_code: "efectivo",
          amount: 1000,
        })),
        // Las dos HISTÓRICAS sin turno: la unión que describe
        // `fetchInvoicePaymentsByShift` (su factura sí pertenece al turno).
        { id: "cobro-h1", invoice_id: "factura-1", cash_shift_id: null, method_code: "efectivo", amount: 1000 },
        { id: "cobro-h2", invoice_id: "factura-1", cash_shift_id: null, method_code: "efectivo", amount: 1000 },
      ],
      commission_payouts: Array.from({ length: BUSY }, (_, index) => ({
        id: `comision-${String(index).padStart(4, "0")}`,
        cash_shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 100,
      })),
      voucher_requests: [
        ...Array.from({ length: BUSY }, (_, index) => ({
          id: `vale-${String(index).padStart(4, "0")}`,
          cash_shift_id: shiftStub.SHIFT_ID,
          approved_by: shiftStub.USER_ID,
          method_code: "efectivo",
          amount: 100,
        })),
        // Un vale PENDIENTE: no toca caja y no entra ni al arqueo ni al token.
        {
          id: "vale-pendiente",
          cash_shift_id: shiftStub.SHIFT_ID,
          approved_by: null,
          method_code: "efectivo",
          amount: 100,
        },
      ],
      cash_shift_counts: [],
      cash_shift_recounts: [],
      audit_logs: [],
    };
  }

  /** Un turno abierto con DOS cobros: el control negativo, por debajo del techo. */
  function seedSmallShift(): void {
    seedBusyShift();
    shiftStub.tables.payments = (shiftStub.tables.payments ?? []).slice(0, 2);
    shiftStub.tables.invoice_payments = [];
    shiftStub.tables.invoices = [];
    shiftStub.tables.commission_payouts = [];
    shiftStub.tables.voucher_requests = [];
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const counts = () => shiftStub.tables.cash_shift_counts ?? [];
  const closeCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_close_shift_atomic");
  const close = (raw: unknown = CLOSE_INPUT) =>
    closeShift(shiftStub.SHIFT_ID, raw, ACTOR);
  /** El efectivo que REALMENTE entró al turno, leído de las dos fuentes que SUMA. */
  const collectedCash = (): number => {
    const drawer = (shiftStub.tables.payments ?? []).filter(
      (row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.invoice_id == null,
    );
    const invoiceIds = new Set(
      (shiftStub.tables.invoices ?? [])
        .filter((row) => row.cash_shift_id === shiftStub.SHIFT_ID)
        .map((row) => row.id),
    );
    const invoiced = (shiftStub.tables.invoice_payments ?? []).filter(
      (row) =>
        row.cash_shift_id === shiftStub.SHIFT_ID ||
        (row.cash_shift_id == null && invoiceIds.has(row.invoice_id)),
    );
    return [...drawer, ...invoiced].reduce((acc, row) => acc + Number(row.amount), 0);
  };
  /** El efectivo que REALMENTE salió: comisiones pagadas + vales aprobados con método. */
  const paidOutCash = (): number => {
    const payouts = (shiftStub.tables.commission_payouts ?? []).filter(
      (row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.method_code === "efectivo",
    );
    const vouchers = (shiftStub.tables.voucher_requests ?? []).filter(
      (row) =>
        row.cash_shift_id === shiftStub.SHIFT_ID &&
        isVoucherCashOut({
          approved_by: (row.approved_by ?? null) as string | null,
          method_code: (row.method_code ?? null) as string | null,
          amount: row.amount as number,
        }) &&
        row.method_code === "efectivo",
    );
    return [...payouts, ...vouchers].reduce((acc, row) => acc + Number(row.amount), 0);
  };
  /** El TOKEN completo, contado sobre las CUATRO fuentes del doble. */
  const fullToken = () => {
    const invoiceIds = new Set(
      (shiftStub.tables.invoices ?? [])
        .filter((row) => row.cash_shift_id === shiftStub.SHIFT_ID)
        .map((row) => row.id),
    );
    return {
      payments: (shiftStub.tables.payments ?? []).filter(
        (row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.invoice_id == null,
      ).length,
      invoice_payments: (shiftStub.tables.invoice_payments ?? []).filter(
        (row) =>
          row.cash_shift_id === shiftStub.SHIFT_ID ||
          (row.cash_shift_id == null && invoiceIds.has(row.invoice_id)),
      ).length,
      commission_payouts: (shiftStub.tables.commission_payouts ?? []).filter(
        (row) => row.cash_shift_id === shiftStub.SHIFT_ID,
      ).length,
      voucher_requests: (shiftStub.tables.voucher_requests ?? []).filter(
        (row) =>
          row.cash_shift_id === shiftStub.SHIFT_ID &&
          row.approved_by != null &&
          row.method_code != null,
      ).length,
    };
  };
  /**
   * Las ventanas de las lecturas del ARQUEO (tabla + `filters` con
   * `cash_shift_id`), sin la sonda de columnas de vales —que es un `limit(1)`
   * aparte y no pagina—.
   */
  const arqueoWindows = (table: string) =>
    shiftStub.windows.filter(
      (window) => window.table === table && window.filters.includes("cash_shift_id"),
    );

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("GREEN: un turno con más filas que el techo del Data API se cierra con el arqueo COMPLETO", async () => {
    seedBusyShift();
    // No es vacuidad del fixture: las cuatro fuentes superan el techo por request.
    expect(BUSY).toBeGreaterThan(shiftStub.rowCap);

    const result = await close();

    // El cierre FIRMA (antes del arreglo rechazaba con ARQUEO_STALE para siempre).
    expect(result.shift.status).toBe("cerrado");
    // Y firma el número del conjunto COMPLETO: lo cobrado real menos lo pagado real.
    expect(shifts()[0].expected_cash).toBe(collectedCash() - paidOutCash());
    expect(shifts()[0].expected_cash).toBe(2162000);
    // La evidencia del cierre también quedó escrita.
    expect(counts()).toHaveLength(1);
    expect(counts()[0]).toMatchObject({ phase: "cierre", amount: COUNTED });
  });

  it("el TOKEN y el arqueo salen de la MISMA lectura: el token es el conteo del conjunto completo", async () => {
    seedBusyShift();

    await close();

    // El token que viajó en el RPC es el conteo de las CUATRO fuentes COMPLETAS,
    // leídas de las mismas listas que el arqueo sumó/restó. Si el arqueo se
    // paginara y el token no (o al revés), acá faltaría dinero o el conteo
    // quedaría corto, y la transacción rechazaría con ARQUEO_STALE.
    expect(closeCalls()).toHaveLength(1);
    expect(closeCalls()[0].args.p_collection_counts).toEqual(fullToken());
    expect(closeCalls()[0].args.p_collection_counts).toEqual({
      payments: BUSY,
      invoice_payments: BUSY + 2,
      commission_payouts: BUSY,
      voucher_requests: BUSY,
    });
    // Y el arqueo se computó sobre esas MISMAS filas: el esperado es
    // `collectedCash() - paidOutCash()` (arriba), no sobre una ventana.
    expect(shifts()[0].expected_cash).toBe(collectedCash() - paidOutCash());
  });

  it("las CUATRO fuentes se leen por PÁGINAS y con un orden determinista", async () => {
    seedBusyShift();

    await close();

    for (const table of ["payments", "invoice_payments", "commission_payouts", "voucher_requests"]) {
      const windows = arqueoWindows(table);
      // Más de una página: el conjunto no entró en una sola ventana.
      expect(windows.length, table).toBeGreaterThan(1);
      // La primera ventana es la del techo por request, y NINGUNA lectura va sin
      // `order()`: sin orden, dos páginas pueden repetir o perder filas.
      expect(windows[0], table).toMatchObject({ from: 0, to: shiftStub.rowCap - 1, order: ["id"] });
      for (const window of windows) expect(window.order, table).toEqual(["id"]);
      // Y las páginas de CADA lectura avanzan sin huecos ni solapes. Se agrupan
      // por los filtros, que es lo que identifica la consulta: una fuente con
      // dos consultas (la unión de `invoice_payments`: directas + históricas)
      // tiene dos lecturas, y cada una empieza en 0.
      const byRead = new Map<string, Array<(typeof shiftStub.windows)[number]>>();
      for (const window of windows) {
        const key = window.filters.join(",");
        byRead.set(key, [...(byRead.get(key) ?? []), window]);
      }
      for (const [key, group] of byRead) {
        expect(group.map((window) => window.from), `${table} (${key})`).toEqual(
          Array.from({ length: group.length }, (_, index) => index * shiftStub.rowCap),
        );
        for (const window of group) {
          expect(window.to, `${table} (${key})`).toBe(window.from + shiftStub.rowCap - 1);
        }
      }
    }
  });

  it("una lectura que NO se completa falla A LA VISTA: READ_INCOMPLETE, sin firmar NADA", async () => {
    seedBusyShift();
    // La SEGUNDA página de los cobros del turno no llega: el doble devuelve el
    // error de transporte, no un conjunto recortado.
    shiftStub.failAt = { payments: [2] };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "READ_INCOMPLETE", status: 500 });
    // El mensaje dice QUÉ no se pudo leer y DÓNDE se cortó: es accionable.
    expect((outcome as CashError).message).toContain("los cobros del turno");
    expect((outcome as CashError).message).toContain("fila 1000");
    // Y no quedó NADA: el turno sigue abierto, sin arqueo de cierre, sin
    // escritura suelta y sin haber llamado siquiera a la transacción.
    expect(shifts()[0]).toMatchObject({ status: "abierto", expected_cash: 0 });
    expect(counts()).toEqual([]);
    expect(shiftStub.looseWrites.filter((entry) => entry.table !== "audit_logs")).toEqual([]);
    expect(closeCalls()).toEqual([]);
  });

  it("control negativo: por debajo del techo se lee en UNA página y el cierre sale igual", async () => {
    seedSmallShift();
    const small = {
      counted_cash: 2000,
      counts: [{ method_code: "efectivo", denomination: 1000, quantity: 2, amount: 2000 }],
      confirmed: true as const,
    };

    const result = await close(small);

    expect(result.shift.status).toBe("cerrado");
    // Las cuatro fuentes entran en una sola página (no hay paginación espuria)…
    for (const table of ["payments", "invoice_payments", "commission_payouts", "voucher_requests"]) {
      for (const window of arqueoWindows(table)) {
        expect(window, table).toMatchObject({ from: 0, to: shiftStub.rowCap - 1, order: ["id"] });
      }
    }
    expect(arqueoWindows("payments")).toHaveLength(1);
    expect(arqueoWindows("commission_payouts")).toHaveLength(1);
    expect(arqueoWindows("voucher_requests")).toHaveLength(1);
    // …y el arqueo es el de TODAS las filas, no el de una ventana vacía.
    expect(collectedCash()).toBe(2000);
    expect(shifts()[0].expected_cash).toBe(2000);
    expect(closeCalls()[0].args.p_collection_counts).toEqual({
      payments: 2,
      invoice_payments: 0,
      commission_payouts: 0,
      voucher_requests: 0,
    });
  });

  it("la vista del DÍA ve el conjunto completo (ventas y vales del turno ocupado)", async () => {
    seedBusyShift();

    const day = await getDayView({ fecha: "2026-09-30" });

    expect(day.shifts).toHaveLength(1);
    // La venta del día es la de TODAS las filas (dos fuentes > techo), en pesos.
    expect(day.shifts[0].ventas).toBe(collectedCash());
    expect(day.shifts[0].ventas).toBe(2402000);
    expect(day.shifts[0].efectivo).toBe(2402000);
    // Los vales por turno también salen de una lectura exhaustiva.
    expect(day.shifts[0].vales).toBe(120000);
    // Y el acumulado del día cuadra con la suma de turnos.
    expect(day.totals.ventas).toBe(2402000);
    // La lectura del día va por páginas y ordenada, igual que la del cierre.
    const windows = arqueoWindows("payments");
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) expect(window.order).toEqual(["id"]);
  });

  it("el HISTORIAL ve el conjunto completo de la misma fuente", async () => {
    seedBusyShift();

    const history = await getHistory({
      desde: "2026-09-01",
      hasta: "2026-09-30",
    });

    expect(history.total).toBe(1);
    expect(history.shifts).toHaveLength(1);
    expect(history.shifts[0].ventas).toBe(collectedCash());
    expect(history.shifts[0].ventas).toBe(2402000);
    expect(history.shifts[0].vales).toBe(120000);
    expect(arqueoWindows("commission_payouts").length).toBeGreaterThan(1);
  });

  it("la vista del día falla A LA VISTA si una de sus lecturas no se completa", async () => {
    seedBusyShift();
    shiftStub.failAt = { payments: [2] };

    const outcome: unknown = await getDayView({ fecha: "2026-09-30" }).catch(
      (error: unknown) => error,
    );

    // No hay una vista con la venta recortada: hay un error de negocio.
    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "READ_INCOMPLETE", status: 500 });
  });

  it("la PRECONDICIÓN sigue viva: un cobro confirmado en el medio RECHAZA aunque el conjunto se lea entero", async () => {
    seedBusyShift();
    // La otra transacción confirma UN cobro más entre la lectura y el lock. Con
    // las cuatro fuentes completas, el token sigue siendo el de la lectura: el
    // conteo de la base pasa a 1 201 y la transacción rechaza.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.payments = [
        ...(shiftStub.tables.payments ?? []),
        {
          id: "pago-nuevo",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 1000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect(shifts()[0]).toMatchObject({ status: "abierto", expected_cash: 0 });
    expect(counts()).toEqual([]);
  });

  it("el reintento con el arqueo fresco cierra y cuenta el cobro que llegó", async () => {
    seedBusyShift();
    shiftStub.beforeRpc = () => {
      shiftStub.tables.payments = [
        ...(shiftStub.tables.payments ?? []),
        {
          id: "pago-nuevo",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 1000,
        },
      ];
      shiftStub.beforeRpc = null;
    };
    await close().catch(() => undefined);

    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    // El arqueo firmado ahora SÍ cuenta el cobro que se confirmó en el medio.
    expect(shifts()[0].expected_cash).toBe(collectedCash() - paidOutCash());
    expect(shifts()[0].expected_cash).toBe(2163000);
  });
});

// ---------------------------------------------------------------- CL-20 ---
//
// El arqueo no SÓLO suma cobros: también RESTA dos salidas de caja —los pagos
// inmediatos de comisión (`commission_payouts` del turno) y los vales APROBADOS
// del turno (`voucher_requests` con `approved_by` y `method_code` no nulos)—. El
// token de CL-19 (058) cuenta las dos fuentes que el arqueo SUMA y no estas dos,
// así que un pago de comisión o la aprobación de un vale confirmados entre la
// lectura del servicio y el lock del turno dejan el MISMO cierre firmado que la
// 058 vino a eliminar: un `expected_cash` corto, con los dos conteo de 058
// intactos —así que su precondición no dispara—.
//
// CL-20 extiende la MISMA precondición con el MISMO mecanismo: dos CONTEO de
// filas más en el token, recontados por la transacción BAJO EL LOCK DEL TURNO.
describe("cash: CL-20 el cierre tampoco firma un arqueo al que le faltan las SALIDAS", () => {
  const ACTOR = { userId: shiftStub.USER_ID, sedeId: shiftStub.SEDE_ID };
  /** El cierre del caso 300/200 del dueño: 6 × 50 000 contados sobre 300 000 cobrados. */
  const CLOSE_INPUT = {
    counted_cash: 300000,
    counts: [{ method_code: "efectivo", denomination: 50000, quantity: 6, amount: 300000 }],
    confirmed: true as const,
  };

  /** Un turno abierto con 300 000 cobrados en efectivo y ninguna salida. */
  function seedOpenShift(): void {
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      cash_denominations: [
        {
          id: "den-50000",
          sede_id: shiftStub.SEDE_ID,
          kind: "billete",
          value: 50000,
          is_active: true,
        },
      ],
      cash_shifts: [
        {
          id: shiftStub.SHIFT_ID,
          cash_register_id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          opened_by: shiftStub.USER_ID,
          closed_by: null,
          opened_at: "2026-09-30T12:00:00.000Z",
          closed_at: null,
          opening_base: 200000,
          expected_cash: 0,
          counted_cash: null,
          base_left: null,
          cash_withdrawn: null,
          base_difference: null,
          status: "abierto",
          observation: null,
        },
      ],
      // El único movimiento del turno: un cobro de cajón SIN factura.
      payments: [
        {
          id: "pago-1",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 300000,
        },
      ],
      invoice_payments: [],
      invoices: [],
      commission_payouts: [],
      voucher_requests: [],
      cash_shift_counts: [],
      cash_shift_recounts: [],
    };
  }

  const shifts = () => shiftStub.tables.cash_shifts ?? [];
  const counts = () => shiftStub.tables.cash_shift_counts ?? [];
  const closeCalls = () =>
    shiftStub.rpcCalls.filter((call) => call.name === "cash_close_shift_atomic");
  const close = (raw: unknown = CLOSE_INPUT) =>
    closeShift(shiftStub.SHIFT_ID, raw, ACTOR);
  /** El efectivo que REALMENTE entró al turno, leído del ledger de cobros. */
  const collectedCash = (): number =>
    (shiftStub.tables.payments ?? [])
      .filter((row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.invoice_id == null)
      .reduce((acc, row) => acc + Number(row.amount), 0);
  /**
   * El efectivo que REALMENTE salió del cajón del turno, leído de los DOS
   * ledgers de salida: las comisiones pagadas y los vales APROBADOS (la MISMA
   * regla de `isVoucherCashOut` que aplica el arqueo).
   */
  const paidOutCash = (): number => {
    const payouts = (shiftStub.tables.commission_payouts ?? []).filter(
      (row) => row.cash_shift_id === shiftStub.SHIFT_ID && row.method_code === "efectivo",
    );
    const vouchers = (shiftStub.tables.voucher_requests ?? []).filter(
      (row) =>
        row.cash_shift_id === shiftStub.SHIFT_ID &&
        row.method_code === "efectivo" &&
        isVoucherCashOut({
          approved_by: (row.approved_by ?? null) as string | null,
          method_code: (row.method_code ?? null) as string | null,
          amount: row.amount as number,
        }),
    );
    return [...payouts, ...vouchers].reduce((acc, row) => acc + Number(row.amount), 0);
  };

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("un pago de comisión que se confirma entre la lectura del arqueo y el lock hace RECHAZAR el cierre (ARQUEO_STALE) y no escribe NADA", async () => {
    seedOpenShift();
    // La salida que entra en el medio: una comisión pagada en EFECTIVO al MISMO
    // turno. Las dos fuentes del token de 058 no cambian —por eso su precondición
    // no la ve—; el token de CL-20 sí.
    shiftStub.beforeRpc = () => {
      shiftStub.tables.commission_payouts = [
        ...(shiftStub.tables.commission_payouts ?? []),
        {
          id: "comision-1",
          cash_shift_id: shiftStub.SHIFT_ID,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    // Es un rechazo de CONTRATO con el MISMO código y el MISMO mensaje que el de
    // la 058: es la misma precondición, extendida.
    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect((outcome as CashError).message).toBe(
      "Las colecciones del turno cambiaron mientras se cerraba: vuelva a intentar.",
    );
    // Y no quedó NADA escrito: el turno sigue ABIERTO y sin arqueo de cierre
    // —ni siquiera la fila de auditoría, que el servicio escribe después—.
    expect(shifts()[0]).toMatchObject({ status: "abierto", expected_cash: 0 });
    expect(counts()).toEqual([]);
    expect(shiftStub.tables.cash_shift_recounts ?? []).toEqual([]);
    expect(shiftStub.inserts.filter((entry) => entry.table === "audit_logs")).toEqual([]);
    // No es vacuidad del doble: la transacción SÍ se pidió.
    expect(closeCalls()).toHaveLength(1);
  });

  it("un vale APROBADO que se confirma entre la lectura del arqueo y el lock también hace RECHAZAR el cierre", async () => {
    seedOpenShift();
    shiftStub.beforeRpc = () => {
      shiftStub.tables.voucher_requests = [
        ...(shiftStub.tables.voucher_requests ?? []),
        {
          id: "vale-1",
          cash_shift_id: shiftStub.SHIFT_ID,
          approved_by: shiftStub.USER_ID,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect(shifts()[0].status).toBe("abierto");
    expect(counts()).toEqual([]);
  });

  it("el reintento con un arqueo FRESCO cierra, y ahora el arqueo SÍ RESTA la salida", async () => {
    seedOpenShift();
    shiftStub.beforeRpc = () => {
      shiftStub.tables.commission_payouts = [
        ...(shiftStub.tables.commission_payouts ?? []),
        {
          id: "comision-1",
          cash_shift_id: shiftStub.SHIFT_ID,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };
    await close().catch(() => undefined);

    // El reintento: el servicio vuelve a leer los cuatro conjuntos (ahora sí ve
    // la salida), computa el arqueo con ella y manda un token que coincide.
    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    // El arqueo firmado es el del dinero que REALMENTE quedó: el efectivo cobrado
    // menos la salida en efectivo. Ésta es la aserción que mide el defecto: con el
    // código previo a este archivo el cierre quedaba firmado con 300 000 (el
    // `expected 300000 to be 200000` del RED).
    expect(shifts()[0].expected_cash).toBe(collectedCash() - paidOutCash());
    expect(shifts()[0].expected_cash).toBe(200000);
    expect(counts()).toHaveLength(1);
  });

  it("las DOS fuentes de 058 siguen cubiertas: un cobro de cajón en el medio se rechaza igual", async () => {
    seedOpenShift();
    shiftStub.beforeRpc = () => {
      shiftStub.tables.payments = [
        ...(shiftStub.tables.payments ?? []),
        {
          id: "pago-2",
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftStub.SHIFT_ID,
          invoice_id: null,
          method_code: "efectivo",
          amount: 100000,
        },
      ];
    };

    const outcome: unknown = await close().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "ARQUEO_STALE", status: 409 });
    expect(shifts()[0].status).toBe("abierto");
  });

  it("un vale PENDIENTE o SIN MÉTODO no se cuenta: no toca el arqueo y no rechaza un cierre legítimo", async () => {
    seedOpenShift();
    // Las dos formas de un vale que el arqueo NO resta (`isVoucherCashOut`):
    // pendiente (sin `approved_by`) y sin método (histórico). Contar TODAS las
    // filas del turno sería un token más grueso que el arqueo, y este cierre —que
    // no cambia el número firmado— se rechazaría sin motivo.
    shiftStub.tables.voucher_requests = [
      {
        id: "vale-pendiente",
        cash_shift_id: shiftStub.SHIFT_ID,
        approved_by: null,
        method_code: "efectivo",
        amount: 50000,
      },
      {
        id: "vale-sin-metodo",
        cash_shift_id: shiftStub.SHIFT_ID,
        approved_by: shiftStub.USER_ID,
        method_code: null,
        amount: 50000,
      },
    ];

    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    // El arqueo no restó ninguno de los dos y el token tampoco los contó.
    expect(shifts()[0].expected_cash).toBe(collectedCash());
    expect(closeCalls()[0].args.p_collection_counts).toMatchObject({ voucher_requests: 0 });
  });

  it("el token viaja como DATO: los CONTEO de las CUATRO entradas del arqueo (nunca sus sumas)", async () => {
    seedOpenShift();
    // Dos salidas reales del turno, una por cada fuente nueva: una comisión
    // pagada y un vale aprobado. Los montos son 100 000 y 50 000: si el token
    // fuera una suma, esos números aparecerían acá.
    shiftStub.tables.commission_payouts = [
      {
        id: "comision-1",
        cash_shift_id: shiftStub.SHIFT_ID,
        method_code: "efectivo",
        amount: 100000,
      },
    ];
    shiftStub.tables.voucher_requests = [
      {
        id: "vale-1",
        cash_shift_id: shiftStub.SHIFT_ID,
        approved_by: shiftStub.USER_ID,
        method_code: "efectivo",
        amount: 50000,
      },
    ];

    await close();

    expect(closeCalls()[0].args.p_collection_counts).toEqual({
      payments: 1,
      invoice_payments: 0,
      commission_payouts: 1,
      voucher_requests: 1,
    });
    // Y el arqueo firmado es el efectivo cobrado menos las dos salidas.
    expect(shifts()[0].expected_cash).toBe(300000 - 150000);
  });

  it("control negativo: la misma operación SIN movimiento en el medio sí cierra (los «no escribió» no son vacuidad)", async () => {
    seedOpenShift();

    const result = await close();

    expect(result.shift.status).toBe("cerrado");
    expect(shifts()[0].expected_cash).toBe(collectedCash());
    expect(counts()).toHaveLength(1);
  });
});

describe("migración 049_cash_shift_atomic.sql (CL-10)", () => {
  const migration = (): { raw: string; sql: string } => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "migrations", "049_cash_shift_atomic.sql"),
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

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    const { raw } = migration();
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("las TRES operaciones viven cada una en UNA función: una sentencia, una transacción", () => {
    const { sql } = migration();
    // La apertura: el turno y su arqueo de apertura.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_open_shift_atomic");
    expect(sql).toMatch(/INSERT INTO public\.cash_shifts/);
    // El cierre: el CAS del turno y su arqueo de cierre.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic");
    expect(sql).toMatch(/UPDATE public\.cash_shifts/);
    // El reconteo: la fila del reconteo y sus líneas.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_recount_shift_atomic");
    expect(sql).toMatch(/INSERT INTO public\.cash_shift_recounts/);
    // Las LÍNEAS del arqueo, en las TRES: es la evidencia que viaja con la firma.
    expect(sql.match(/INSERT INTO public\.cash_shift_counts/g) ?? []).toHaveLength(3);
    // `jsonb_array_elements(p_counts)` aparece SIETE veces: el INSERT de cada
    // función, la guarda de FORMA de cada función y el chequeo del efectivo del
    // reconteo. Es la prueba de que las líneas se leen como ARREGLO en todas y
    // no de una sola fila por request.
    expect(sql.match(/jsonb_array_elements\(p_counts\)/g) ?? []).toHaveLength(7);
    // La fase de cada grupo la declara la transacción (es constante, no dato).
    expect(sql).toContain("'apertura'");
    expect(sql).toContain("'cierre'");
    expect(sql).toContain("'reconteo'");
    // Orden determinista de los locks y de las líneas (misma disciplina que
    // 046, 047 y 048): sin él, dos operaciones concurrentes sobre la misma caja
    // pueden bloquearse en ciclo.
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY/);
  });

  it("conserva las precondiciones de estado que el servicio ya tenía", () => {
    const { sql } = migration();
    // El CAS del cierre, ahora DENTRO de la transacción: el estado leído de la
    // fila bloqueada y el mismo `status = 'abierto'` en el WHERE del UPDATE.
    expect(sql).toMatch(/v_turno\.status <> 'abierto'/);
    expect(sql).toMatch(/AND s\.status = 'abierto'/);
    expect(sql).toContain("SHIFT_ALREADY_CLOSED");
    // Un turno abierto por caja (006), con la caja bloqueada primero.
    expect(sql).toMatch(/FROM public\.cash_registers r/);
    expect(sql).toMatch(/s\.cash_register_id = p_register_id/);
    expect(sql).toMatch(/s\.status = 'abierto'/);
    expect(sql).toContain("SHIFT_ALREADY_OPEN");
    // El reconteo "uno por turno" (033) y su precondición de estado.
    expect(sql).toMatch(/FROM public\.cash_shift_recounts r/);
    expect(sql).toMatch(/r\.shift_id = p_shift_id/);
    expect(sql).toContain("ALREADY_RECOUNTED");
    expect(sql).toMatch(/v_turno\.status <> 'cerrado'/);
    expect(sql).toContain("SHIFT_NOT_CLOSED");
    // El conteo COMPLETO: no puede venir vacío y tiene que traer el efectivo.
    expect(sql).toContain("jsonb_array_length(p_counts) = 0");
    expect(sql).toMatch(/item ->> 'method_code' = 'efectivo'/);
  });

  it("tiene DOS redes de conteo por función, con rollback", () => {
    const { sql } = migration();
    // Seis: el turno y sus líneas, en cada una de las tres operaciones.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(6);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("SHIFT_COUNT_MISMATCH");
    expect(sql).toContain("SHIFT_WRITE_MISMATCH");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL
    // (la misma trampa que 046 documenta para `qty`).
    expect(sql).toMatch(/coalesce\(/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    const { sql } = migration();
    // Las tablas ya validan sus montos con los CHECK de 006 y 009 (validar no es
    // calcular): esta migración no agrega una sola expresión aritmética sobre
    // las columnas de dinero. Escribir = convertir la representación
    // (jsonb → la columna), no operar.
    for (const column of [
      "opening_base",
      "expected_cash",
      "counted_cash",
      "base_left",
      "cash_withdrawn",
      "base_difference",
      "previous_counted_cash",
      "previous_base_left",
      "previous_cash_withdrawn",
      "previous_base_difference",
      "amount",
      "denomination",
      "quantity",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(sql).not.toContain("CHECK");
    expect(sql).not.toMatch(/sum\s*\(/i);
  });

  it("devuelve EXACTAMENTE las columnas que el servicio leía (mismo shape)", () => {
    const { sql } = migration();
    // Tres devoluciones: el turno escrito (apertura y cierre) y el reconteo
    // escrito. Cada una lista sus columnas, sin `to_jsonb` de la fila entera
    // (que agregaría `created_at`/`updated_at`, que el servicio nunca leyó).
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(3);
    for (const column of SHIFT_COLUMNS) expect(sql, column).toContain(`'${column}'`);
    for (const column of RECOUNT_COLUMNS) expect(sql, column).toContain(`'${column}'`);
  });

  it("cierra el permiso: sólo service_role puede ejecutarlas", () => {
    const { sql } = migration();
    for (const signature of [
      "public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb)",
      "public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb)",
      "public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb)",
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
    const { sql } = migration();
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(3);
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(3);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(3);
    // Ningún borrado, y un solo UPDATE EJECUTABLE: el del turno al cerrarse, que
    // es el que el servicio ya hacía.
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.cash_shift_counts/);
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
    expect(raw).toContain("VENTANAS DECLARADAS");
    // El número libre siguiente y el archivo hermano (048) que se espeja.
    expect(raw).toContain("049");
    expect(raw).toContain("048");
  });
});

// ---------------- CL-14: la migración 053 ----------------

describe("migración 053_cash_payment_state_atomic.sql (CL-14)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "053_cash_payment_state_atomic.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // El texto de los `COMMENT ON …` es PROSA que viaja como string, no DDL.
  const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("la operación vive en UNA función: una sentencia, una transacción", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic");
    // Los TRES grupos de escritura del cobro, en la misma función: el espejo de
    // la factura, el libro de cajón del turno y el estado de la factura.
    expect(sql).toMatch(/INSERT INTO public\.invoice_payments/);
    expect(sql).toMatch(/INSERT INTO public\.payments/);
    expect(sql).toMatch(/UPDATE public\.invoices/);
    // El lock de la fila de la factura: el punto de serialización de su dinero
    // (el mismo que toma el tope de 031 y la anulación de la 050).
    expect(sql).toMatch(/FOR UPDATE OF i/);
  });

  it("conserva las precondiciones de estado que el servicio ya tenía", () => {
    // La factura anulada no admite cobros, releído de la fila bloqueada.
    expect(sql).toMatch(/v_factura\.status = 'Anulada'/);
    expect(sql).toContain("ANNUL_INVALID");
    expect(sql).toContain("INVOICE_NOT_FOUND");
    // Y la marca del intento (042/043) es obligatoria: este camino escribe UNA
    // sola fila en `invoice_payments`, y esa fila es la operación.
    expect(sql).toMatch(/coalesce\(p_collection ->> 'idempotency_key', ''\)/);
    expect(sql).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(raw).toContain("MARCA NO ES OPCIONAL acá");
  });

  it("tiene UNA red de conteo por grupo de escritura, con rollback", () => {
    // Tres: el espejo, el libro de cajón y el estado de la factura.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(3);
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("PAYMENT_MISMATCH");
    // La guarda de forma no puede caer en un NULL silencioso: el `coalesce` es
    // lo que hace que una clave AUSENTE falle en vez de comparar contra NULL
    // (la misma trampa que 046–050 documentan).
    expect(sql).toMatch(/coalesce\(/);
  });

  it("NO mueve aritmética de dinero a SQL: ningún monto se recalcula", () => {
    // Los montos ya se validan con los CHECK de 005/006/019 (validar no es
    // calcular): esta migración no agrega una sola expresión aritmética sobre
    // las columnas de dinero. Escribir = convertir la representación
    // (jsonb → la columna), no operar.
    for (const column of [
      "amount",
      "fee_amount",
      "fee_percent",
      "total",
      "surcharge",
      "subtotal",
      "discount",
      "tax",
    ]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
    expect(ddl).not.toContain("CHECK");
    expect(ddl).not.toMatch(/sum\s*\(/i);
    expect(ddl).not.toMatch(/round\s*\(/i);
    expect(ddl).not.toMatch(/trg_invoice_payments_cap/);
    expect(ddl).not.toMatch(/invoices\.total/);
  });

  it("la decisión `Pagada` y el enlace al turno viajan como DATO (no se recalculan)", () => {
    // El grupo 3 escribe el estado DECIDIDO por el servicio: dos booleanos
    // (`p_set_shift`, `p_mark_paid`) y ningún cálculo de saldo. Si la decisión
    // se hubiera movido a SQL, acá habría una comparación del cobrado contra el
    // facturado (`moneyEquals`, `netCollected`, `netBilled`).
    expect(sql).toMatch(/IF p_set_shift OR p_mark_paid THEN/);
    expect(sql).toMatch(/CASE WHEN p_mark_paid THEN 'Pagada'/);
    expect(sql).toMatch(/CASE WHEN p_set_shift THEN p_shift_id/);
    expect(ddl).not.toContain("netCollected");
    expect(ddl).not.toContain("netBilled");
    expect(ddl).not.toContain("moneyEquals");
  });

  it("escribe los MISMOS campos del estado que el servicio, y ni uno más", () => {
    // El UPDATE del grupo 3: el turno que cobra y el estado. `closed_by` y
    // `closed_at` NO se escriben, porque el camino de caja tampoco los escribía
    // (asimetría declarada frente a la 050, conservada a propósito).
    const update = sql.slice(
      sql.indexOf("UPDATE public.invoices"),
      sql.indexOf("RETURNING * INTO v_factura"),
    );
    expect(update).toMatch(/cash_shift_id/);
    expect(update).toMatch(/status/);
    expect(update).not.toMatch(/closed_at/);
    expect(update).not.toMatch(/closed_by/);
    expect(raw).toContain("LA ASIMETRÍA QUE SE CONSERVA");
  });

  it("devuelve la fila del libro de cajón con las columnas que el servicio lee", () => {
    // Dos `jsonb_build_object` anidados: el cobro escrito y el estado de la
    // factura. Las columnas son las de PAYMENT_SELECT, sin `to_jsonb` de la fila
    // entera (que agregaría `idempotency_key`, que el servicio nunca leyó).
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(3);
    for (const column of PAYMENT_COLUMNS) expect(sql, column).toContain(`'${column}',`);
    expect(sql).toContain("'status', v_factura.status");
    expect(sql).not.toContain("to_jsonb");
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    const signature =
      "public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, boolean, boolean, jsonb)";
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    expect(sql).toContain("FROM PUBLIC");
    expect(sql).toContain("FROM anon");
    expect(sql).toContain("FROM authenticated");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = public");
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(1);
  });

  it("no borra ni reescribe datos: sólo la función y sus permisos", () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    // Un solo UPDATE EJECUTABLE: el del estado de la factura, el MISMO que el
    // servicio ya hacía.
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.invoice_payments/);
    expect(sql).not.toMatch(/UPDATE public\.payments/);
    // `updated_at` lo sigue escribiendo el trigger de 005/006, no esta migración.
    expect(sql).not.toMatch(/updated_at/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("declara el acoplamiento, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    // El número asignado, el archivo hermano (050) que se espeja y el número de
    // otra unidad en vuelo que NO se toca.
    expect(raw).toContain("053");
    expect(raw).toContain("050");
    expect(raw).toContain("052");
  });

  it("declara la ventana del turno que este archivo NO cierra", () => {
    // El estado del turno se resuelve en el servicio: un turno puede cerrarse
    // entre esa lectura y el commit. Se declara (con su costo) en vez de
    // esconderse: cerrarlo exigiría un segundo punto de serialización por cobro.
    expect(raw).toContain("EL ESTADO DEL TURNO se lee en el SERVICIO");
    expect(raw).toContain("un SEGUNDO punto de serialización en");
  });
});

// ---------------- CL-19: la migración 058 ----------------

describe("migración 058_close_arqueo_consistency.sql (CL-19)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "058_close_arqueo_consistency.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // Y sin el texto de los `COMMENT ON …`, que es prosa que viaja como string.
  const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");
  const signature =
    "public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb)";

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("reemplaza la firma de SEIS argumentos por la de SIETE (la precondición es obligatoria)", () => {
    // Sin el DROP, `CREATE OR REPLACE` dejaría viva la versión de 049 —la que
    // cierra firmando el arqueo sin comprobar el conjunto de cobros—: un bypass
    // silencioso de la precondición que este archivo agrega.
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb);",
    );
    // El `DROP` va PRIMERO, y no borra la firma nueva (que todavía no existe).
    expect(sql.trimStart().startsWith("DROP FUNCTION IF EXISTS")).toBe(true);
    expect(sql).not.toContain(`DROP FUNCTION IF EXISTS ${signature}`);
    // Y la firma nueva es la que se crea, con el token como séptimo argumento.
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic");
    expect(sql).toContain("p_collection_counts jsonb\n)");
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
  });

  it("evalúa la precondición BAJO el lock del turno, entre el estado y la escritura", () => {
    const lock = sql.indexOf("FOR UPDATE OF s");
    const state = sql.indexOf("v_turno.status <> 'abierto'");
    const forma = sql.indexOf("p_collection_counts IS NULL");
    const conteoPayments = sql.indexOf("SELECT count(*) INTO v_payments");
    const conteoInvoice = sql.indexOf("SELECT count(*) INTO v_invoice_payments");
    const stale = sql.indexOf("ARQUEO_STALE");
    const update = sql.indexOf("UPDATE public.cash_shifts");
    expect(forma).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    // La FORMA del token se valida antes de tocar la fila; el CONTEO va después
    // del lock (si no, la precondición no valdría nada) y antes de escribir.
    expect(forma).toBeLessThan(lock);
    expect(state).toBeGreaterThan(lock);
    expect(lock).toBeLessThan(conteoPayments);
    expect(conteoPayments).toBeLessThan(conteoInvoice);
    expect(conteoInvoice).toBeLessThan(stale);
    expect(stale).toBeLessThan(update);
  });

  it("el token es OBLIGATORIO: su ausencia es SHIFT_INVALID, jamás «no compares»", () => {
    // La misma regla que 057 dejó escrita: una firma mal llamada no puede
    // degradar al comportamiento sin la precondición.
    expect(ddl).toContain("p_collection_counts IS NULL");
    expect(ddl).toContain("jsonb_typeof(p_collection_counts) <> 'object'");
    expect(ddl).toContain("coalesce(p_collection_counts ->> 'payments', '')");
    expect(ddl).toContain("coalesce(p_collection_counts ->> 'invoice_payments', '')");
    expect(ddl).toMatch(/RAISE EXCEPTION 'SHIFT_INVALID'/);
  });

  it("RECUENTA las dos fuentes del arqueo —y la unión de la segunda—, sin sumar un peso", () => {
    // Fuente 1: el libro de cajón del turno, SIN factura (el mismo predicado que
    // la lectura del servicio).
    expect(ddl).toMatch(/SELECT count\(\*\) INTO v_payments[\s\S]*?FROM public\.payments p/);
    expect(ddl).toMatch(/p\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/p\.invoice_id IS NULL/);
    // Fuente 2: las porciones atribuidas al turno, la UNIÓN que describe
    // `fetchInvoicePaymentsByShift`: las directas más las históricas sin turno
    // cuya factura pertenece al turno.
    expect(ddl).toMatch(
      /SELECT count\(\*\) INTO v_invoice_payments[\s\S]*?FROM public\.invoice_payments ip/,
    );
    expect(ddl).toMatch(/ip\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/ip\.cash_shift_id IS NULL/);
    expect(ddl).toMatch(/i\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/FROM public\.invoices i/);
    // Y la comparación contra el token, con el rechazo propio.
    expect(ddl).toMatch(
      /IF v_payments <> \(p_collection_counts ->> 'payments'\)::bigint[\s\S]*?OR v_invoice_payments <> \(p_collection_counts ->> 'invoice_payments'\)::bigint/,
    );
    expect(ddl).toContain("RAISE EXCEPTION 'ARQUEO_STALE'");
    // La otra punta del acoplamiento: el fetcher del servicio describe los MISMOS
    // tres predicados. Si alguien cambia una regla de atribución, este test cae.
    const service = readFileSync(
      join(process.cwd(), "src", "features", "cash", "service.ts"),
      "utf8",
    );
    const fetcher = service.slice(
      service.indexOf("async function fetchInvoicePaymentsByShift"),
    );
    // Los MISMOS tres predicados; el filtro viaja TROCEADO con `chunkIds` (el
    // origen de cada lista sigue fijado en `values`).
    expect(fetcher).toContain("readAllSourceInChunks");
    expect(fetcher).toContain("values: shiftIds");
    expect(fetcher).toContain('.in("cash_shift_id", chunk)');
    expect(fetcher).toContain("values: [...shiftByInvoice.keys()]");
    expect(fetcher).toContain('.in("invoice_id", chunk)');
    expect(fetcher).toContain('.is("cash_shift_id", null)');
    // F1: trocar los DOS `values` (darle a la directa `[...shiftByInvoice.keys()]` y a la histórica `shiftIds`, dejando los `.in(..., chunk)`) pasa todos los tokens sueltos de arriba, deja las dos consultas vacías y borra del arqueo toda colección de factura; por eso la lista y su columna se afirman POR BLOQUE.
    const bloqueDirecto = fetcher.slice(
      fetcher.indexOf('what: "los cobros de factura del turno"'),
      fetcher.indexOf('what: "las facturas del turno"'),
    );
    const bloqueHistorico = fetcher.slice(
      fetcher.indexOf('what: "los cobros de factura históricos del turno"'),
      fetcher.indexOf("for (const row of nullShiftRows)"),
    );
    expect(bloqueDirecto).toContain("values: shiftIds");
    expect(bloqueDirecto).toContain('.in("cash_shift_id", chunk)');
    expect(bloqueDirecto).not.toContain("values: [...shiftByInvoice.keys()]");
    expect(bloqueDirecto).not.toContain('.in("invoice_id"');
    expect(bloqueDirecto.indexOf("values:")).toBeLessThan(
      bloqueDirecto.indexOf('.in("cash_shift_id", chunk)'),
    );
    expect(bloqueHistorico).toContain("values: [...shiftByInvoice.keys()]");
    expect(bloqueHistorico).toContain('.in("invoice_id", chunk)');
    expect(bloqueHistorico).toContain('.is("cash_shift_id", null)');
    expect(bloqueHistorico).not.toContain("values: shiftIds");
    expect(bloqueHistorico.indexOf("values: [...shiftByInvoice.keys()]")).toBeLessThan(
      bloqueHistorico.indexOf('.in("invoice_id", chunk)'),
    );
    expect(bloqueHistorico.indexOf('.in("invoice_id", chunk)')).toBeLessThan(
      bloqueHistorico.indexOf('.is("cash_shift_id", null)'),
    );
  });

  it("NO mueve aritmética de dinero a SQL: los dos conteo son `count(*)`, no `sum(...)`", () => {
    // Contar filas no es operar sobre dinero: es lo ÚNICO que la función agrega.
    // Un `sum(amount)` sería exactamente la aritmética que este proyecto prohíbe
    // mover (005, 031, 049, 050, 053), y un `count(amount)` contaría un monto en
    // vez de una fila.
    expect(ddl.match(/count\(\*\)/g) ?? []).toHaveLength(2);
    expect(ddl.match(/count\s*\(/gi) ?? []).toHaveLength(2);
    expect(ddl).not.toMatch(/sum\s*\(/i);
    expect(ddl).not.toMatch(/avg\s*\(/i);
    expect(ddl).not.toMatch(/round\s*\(/i);
    expect(ddl).not.toContain("CHECK");
    // Ninguna columna de dinero entra en una operación. Escribir = convertir la
    // representación (jsonb → la columna), no calcular.
    for (const column of [
      "opening_base",
      "expected_cash",
      "counted_cash",
      "base_left",
      "cash_withdrawn",
      "base_difference",
      "amount",
      "denomination",
      "quantity",
    ]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
  });

  it("conserva TODAS las precondiciones y las DOS redes de conteo de 049", () => {
    // El CAS del cierre, el estado leído de la fila bloqueada y el mismo
    // `status = 'abierto'` en el WHERE del UPDATE.
    expect(sql).toMatch(/v_turno\.status <> 'abierto'/);
    expect(sql).toMatch(/AND s\.status = 'abierto'/);
    expect(sql).toContain("SHIFT_ALREADY_CLOSED");
    expect(sql).toContain("SHIFT_NOT_FOUND");
    // Las dos redes: el turno actualizado y las líneas escritas.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(2);
    expect(sql).toContain("SHIFT_COUNT_MISMATCH");
    // El conteo COMPLETO y las guardas de FORMA (la misma trampa del `coalesce`).
    expect(sql).toContain("jsonb_array_length(p_counts) = 0");
    expect(sql).toMatch(/coalesce\(item ->> 'amount', ''\)/);
    expect(sql).toContain("jsonb_build_object(");
  });

  it("devuelve EXACTAMENTE las columnas que el servicio leía (el shape no cambia)", () => {
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(1);
    for (const column of SHIFT_COLUMNS) expect(sql, column).toContain(`'${column}'`);
    expect(sql).not.toContain("to_jsonb");
  });

  it("cierra el permiso de la firma nueva: sólo service_role puede ejecutarla", () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(1);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(1);
  });

  it("no toca los otros dos caminos de 049 ni borra datos: sólo la función del cierre", () => {
    // La apertura y el reconteo no tienen esta ventana y no se reescriben.
    expect(sql).not.toContain("cash_open_shift_atomic");
    expect(sql).not.toContain("cash_recount_shift_atomic");
    // Ningún borrado de datos, y un solo UPDATE EJECUTABLE: el del turno.
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.cash_shift_counts/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("declara el motivo, el acoplamiento de despliegue, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    // El número asignado, el archivo hermano (049) que se espeja y el DROP que
    // copia de 057.
    expect(raw).toContain("058");
    expect(raw).toContain("049");
    expect(raw).toContain("057");
    // Y el techo duro del proyecto, escrito en el archivo.
    expect(raw).toContain("sumar dinero en SQL está prohibido");
  });

  it("declara las ventanas que el token NO cubre, con su propuesta", () => {
    // El arqueo también RESTA salidas (comisiones y vales aprobados) y el token
    // no las cuenta: se declara en vez de esconderse, con la extensión concreta
    // —más CONTEO, nunca sumas— que la cerraría.
    expect(raw).toContain("commission_payouts");
    expect(raw).toContain("voucher_requests");
    expect(raw).toContain("comisión o la aprobación de un vale");
    // Y el techo de filas por request del Data API, que el token hereda de las
    // MISMAS lecturas: fallo CERRADO y ruidoso, con su propuesta de paginado.
    expect(raw).toContain("max-rows");
    expect(raw).toContain("readAllPaged");
    // Y la ventana que NINGÚN conteo puede cerrar: el método de una porción que
    // la edición de factura (051) cambia sin cambiar una fila.
    expect(raw).toContain("051");
    expect(raw).toContain("method_code");
  });

  it("explica por qué el token son CONTEO y no sumas, y por qué hacía falta el DROP", () => {
    expect(raw).toContain("DROP FUNCTION");
    expect(raw).toContain("sobrecarga");
    expect(raw).toContain("aritmética de dinero");
    expect(raw).toContain("ARQUEO_STALE");
  });
});


// ---------------- CL-20: la migración 059 ----------------

describe("migración 059_close_arqueo_outflows.sql (CL-20)", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "migrations", "059_close_arqueo_outflows.sql"),
    "utf8",
  );
  // El SQL sin comentarios: las aserciones miran las sentencias, no la prosa.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // Y sin el texto de los `COMMENT ON …`, que es prosa que viaja como string.
  const ddl = sql.replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");
  const signature =
    "public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb)";

  it("piso anti-vacío: el archivo existe y trae DDL real", () => {
    expect(raw.length).toBeGreaterThan(15000);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });

  it("la firma NO cambia: la extensión entra en el jsonb, así que no hay DROP", () => {
    // La firma es la MISMA de 058 (siete argumentos, el token como objeto jsonb):
    // con `CREATE OR REPLACE` la función se REEMPLAZA en vez de crear una
    // sobrecarga, y no puede quedar viva ninguna versión sin la precondición
    // extendida. Por eso NO hace falta —ni se hace— un `DROP FUNCTION`.
    expect(sql).not.toContain("DROP FUNCTION");
    expect(sql).not.toContain("DROP");
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).toHaveLength(1);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.cash_close_shift_atomic");
    expect(sql).toContain("p_collection_counts jsonb\n)");
    // El resto de los statements nombran la MISMA firma: si alguien la cambiara,
    // el ALTER/REVOKE/GRANT apuntarían a una función distinta de la creada.
    for (const statement of ["ALTER FUNCTION", "REVOKE ALL ON FUNCTION", "GRANT EXECUTE ON FUNCTION", "COMMENT ON FUNCTION"]) {
      expect(sql, statement).toContain(`${statement} ${signature}`);
    }
  });

  it("evalúa la precondición BAJO el lock del turno, entre el estado y la escritura", () => {
    const lock = sql.indexOf("FOR UPDATE OF s");
    const state = sql.indexOf("v_turno.status <> 'abierto'");
    const forma = sql.indexOf("p_collection_counts IS NULL");
    const conteoPayments = sql.indexOf("SELECT count(*) INTO v_payments");
    const conteoInvoice = sql.indexOf("SELECT count(*) INTO v_invoice_payments");
    const conteoPayouts = sql.indexOf("SELECT count(*) INTO v_commission_payouts");
    const conteoVouchers = sql.indexOf("SELECT count(*) INTO v_voucher_requests");
    const stale = sql.indexOf("ARQUEO_STALE");
    const update = sql.indexOf("UPDATE public.cash_shifts");
    // La FORMA del token se valida antes de tocar la fila; los CUATRO CONTEO van
    // después del lock (si no, la precondición no valdría nada) y antes de
    // escribir.
    expect(forma).toBeGreaterThan(-1);
    expect(forma).toBeLessThan(lock);
    expect(state).toBeGreaterThan(lock);
    expect(lock).toBeLessThan(conteoPayments);
    expect(conteoPayments).toBeLessThan(conteoInvoice);
    expect(conteoInvoice).toBeLessThan(conteoPayouts);
    expect(conteoPayouts).toBeLessThan(conteoVouchers);
    expect(conteoVouchers).toBeLessThan(stale);
    expect(stale).toBeLessThan(update);
  });

  it("el token es OBLIGATORIO: las CUATRO claves se exigen por forma, su ausencia es SHIFT_INVALID", () => {
    // La misma regla que 057 y 058 dejaron escrita: una firma mal llamada no
    // puede degradar al comportamiento sin la precondición. Y acá el llamador que
    // mande SOLO las dos claves de 058 recibe SHIFT_INVALID: la migración no es
    // compatible hacia atrás con la app vieja, a propósito.
    expect(ddl).toContain("p_collection_counts IS NULL");
    expect(ddl).toContain("jsonb_typeof(p_collection_counts) <> 'object'");
    for (const key of ["payments", "invoice_payments", "commission_payouts", "voucher_requests"]) {
      expect(ddl, key).toContain(`coalesce(p_collection_counts ->> '${key}', '')`);
    }
    expect(ddl.match(/coalesce\(p_collection_counts ->>/g) ?? []).toHaveLength(4);
    expect(ddl).toMatch(/RAISE EXCEPTION 'SHIFT_INVALID'/);
  });

  it("RECUENTA las CUATRO entradas del arqueo —y la unión de la segunda—, sin sumar un peso", () => {
    // Fuente 1: el libro de cajón del turno, SIN factura (el mismo predicado que
    // la lectura del servicio).
    expect(ddl).toMatch(/SELECT count\(\*\) INTO v_payments[\s\S]*?FROM public\.payments p/);
    expect(ddl).toMatch(/p\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/p\.invoice_id IS NULL/);
    // Fuente 2: las porciones atribuidas al turno, la UNIÓN que describe
    // `fetchInvoicePaymentsByShift`: las directas más las históricas sin turno
    // cuya factura pertenece al turno.
    expect(ddl).toMatch(
      /SELECT count\(\*\) INTO v_invoice_payments[\s\S]*?FROM public\.invoice_payments ip/,
    );
    expect(ddl).toMatch(/ip\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/ip\.cash_shift_id IS NULL/);
    expect(ddl).toMatch(/i\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/FROM public\.invoices i/);
    // Fuente 3 (CL-20): los pagos inmediatos de comisión del turno, TODOS.
    expect(ddl).toMatch(
      /SELECT count\(\*\) INTO v_commission_payouts[\s\S]*?FROM public\.commission_payouts cp/,
    );
    expect(ddl).toMatch(/cp\.cash_shift_id = p_shift_id/);
    // Fuente 4 (CL-20): los vales del turno que el arqueo RESTA, con el predicado
    // de `isVoucherCashOut` (aprobado Y con método). La otra punta del
    // acoplamiento: el fetcher del servicio entrega ya filtradas esas mismas filas.
    expect(ddl).toMatch(
      /SELECT count\(\*\) INTO v_voucher_requests[\s\S]*?FROM public\.voucher_requests vr/,
    );
    expect(ddl).toMatch(/vr\.cash_shift_id = p_shift_id/);
    expect(ddl).toMatch(/vr\.approved_by IS NOT NULL/);
    expect(ddl).toMatch(/vr\.method_code IS NOT NULL/);
    const service = readFileSync(
      join(process.cwd(), "src", "features", "cash", "service.ts"),
      "utf8",
    );
    const fetcher = service.slice(service.indexOf("async function fetchVoucherOutRows"));
    // 414: mismo filtro, lista troceada; el origen sigue fijado en `values`.
    expect(fetcher).toContain("readAllSourceInChunks");
    expect(fetcher).toContain("values: shiftIds");
    expect(fetcher).toContain('.in("cash_shift_id", chunk)');
    expect(fetcher).toContain("rows.filter(isVoucherCashOut)");
    // Y la comparación de los CUATRO contra el token, con el MISMO rechazo de 058.
    expect(ddl).toMatch(
      /IF v_payments <> \(p_collection_counts ->> 'payments'\)::bigint[\s\S]*?OR v_invoice_payments <> \(p_collection_counts ->> 'invoice_payments'\)::bigint[\s\S]*?OR v_commission_payouts <> \(p_collection_counts ->> 'commission_payouts'\)::bigint[\s\S]*?OR v_voucher_requests <> \(p_collection_counts ->> 'voucher_requests'\)::bigint/,
    );
    expect(ddl).toContain("RAISE EXCEPTION 'ARQUEO_STALE'");
  });

  it("NO mueve aritmética de dinero a SQL: los CUATRO conteo son `count(*)`, no `sum(...)`", () => {
    // Contar filas no es operar sobre dinero: es lo ÚNICO que la función agrega
    // (dos `count(*)` más que 058, los mismos que ya tenía). Un `sum(amount)`
    // sería exactamente la aritmética que este proyecto prohíbe mover (005, 031,
    // 049, 050, 053), y un `count(amount)` contaría un monto en vez de una fila.
    expect(ddl.match(/count\(\*\)/g) ?? []).toHaveLength(4);
    expect(ddl.match(/count\s*\(/gi) ?? []).toHaveLength(4);
    expect(ddl).not.toMatch(/sum\s*\(/i);
    expect(ddl).not.toMatch(/avg\s*\(/i);
    expect(ddl).not.toMatch(/round\s*\(/i);
    expect(ddl).not.toContain("CHECK");
    // Ninguna columna de dinero entra en una operación. Escribir = convertir la
    // representación (jsonb → la columna), no calcular.
    for (const column of [
      "opening_base",
      "expected_cash",
      "counted_cash",
      "base_left",
      "cash_withdrawn",
      "base_difference",
      "amount",
      "denomination",
      "quantity",
    ]) {
      expect(ddl, column).not.toMatch(new RegExp(`${column}\\s*[+\\-*/]`));
    }
  });

  it("conserva TODAS las precondiciones, el CAS y las DOS redes de conteo de 049/058", () => {
    expect(sql).toMatch(/v_turno\.status <> 'abierto'/);
    expect(sql).toMatch(/AND s\.status = 'abierto'/);
    expect(sql).toContain("SHIFT_ALREADY_CLOSED");
    expect(sql).toContain("SHIFT_NOT_FOUND");
    // Las dos redes: el turno actualizado y las líneas escritas.
    expect(sql.match(/GET DIAGNOSTICS/g) ?? []).toHaveLength(2);
    expect(sql).toContain("SHIFT_COUNT_MISMATCH");
    // El conteo COMPLETO y las guardas de FORMA (la misma trampa del `coalesce`).
    expect(sql).toContain("jsonb_array_length(p_counts) = 0");
    expect(sql).toMatch(/coalesce\(item ->> 'amount', ''\)/);
    expect(sql).toContain("jsonb_build_object(");
  });

  it("devuelve EXACTAMENTE las columnas que el servicio leía (el shape no cambia)", () => {
    expect(sql.match(/jsonb_build_object\(/g) ?? []).toHaveLength(1);
    for (const column of SHIFT_COLUMNS) expect(sql, column).toContain(`'${column}'`);
    expect(sql).not.toContain("to_jsonb");
  });

  it("cierra el permiso: sólo service_role puede ejecutarla", () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
    expect(sql.match(/^ALTER FUNCTION/gm) ?? []).toHaveLength(1);
    expect(sql.match(/^COMMENT ON FUNCTION/gm) ?? []).toHaveLength(1);
  });

  it("no toca los otros dos caminos de 049 ni borra datos: sólo la función del cierre", () => {
    expect(sql).not.toContain("cash_open_shift_atomic");
    expect(sql).not.toContain("cash_recount_shift_atomic");
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    // Un solo UPDATE EJECUTABLE: el del turno, el MISMO que el servicio ya hacía.
    expect(sql.match(/UPDATE public\./g) ?? []).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.cash_shift_counts/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*CREATE INDEX/im);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain("DROP TRIGGER");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("declara el motivo, el acoplamiento, el costo de numeración y las ventanas", () => {
    expect(raw).toContain("ACOPLAMIENTO DE DESPLIEGUE");
    expect(raw).toContain("COSTO DE NUMERACIÓN");
    expect(raw).toContain("VENTANAS DECLARADAS");
    // El número asignado y los archivos hermanos: la 058 que extiende y la 049
    // que reescribe.
    expect(raw).toContain("059");
    expect(raw).toContain("058");
    expect(raw).toContain("049");
    // El techo duro del proyecto, escrito en el archivo.
    expect(raw).toContain("sumar dinero en SQL está prohibido");
    // Por qué NO hay DROP (la firma no cambia) — la decisión contraria a la 058.
    expect(raw).toContain("POR QUÉ NO HAY `DROP FUNCTION`");
    expect(raw).toContain("sobrecarga");
  });

  it("reporta las DOS ventanas que declaró 058 y qué hace esta unidad con cada una", () => {
    // (a) El MÉTODO de una porción que la edición de factura (051) cambia sin
    // cambiar una fila: es la ventana que ningún conteo cierra. Se reporta —con
    // su costo— y NO se arregla acá.
    expect(raw).toContain("051");
    expect(raw).toContain("EL MÉTODO DE UNA PORCIÓN");
    expect(raw).toContain("method_code");
    // (b) El techo de filas por request del Data API (`max-rows`): el token lo
    // hereda de las CUATRO lecturas y esta unidad AMPLÍA su superficie. Fallo
    // CERRADO y ruidoso, con su propuesta de paginado, reportado y no arreglado.
    expect(raw).toContain("max-rows");
    expect(raw).toContain("readAllPaged");
    expect(raw).toContain("CUATRO lecturas");
    // Y la ventana nueva que esta unidad sí introduce: el CONTENIDO de un vale
    // re-aprobado, sin escritor conocido.
    expect(raw).toContain("approveVoucher");
  });

  it("declara el acoplamiento de despliegue en las DOS direcciones", () => {
    // App nueva + archivo sin aplicar: las claves de más se ignoran y el cierre
    // FUNCIONA (degradación silenciosa, por eso van juntos). Archivo aplicado +
    // app vieja: SHIFT_INVALID y nada escrito (falla CERRADO).
    expect(raw).toContain("degradación SILENCIOSA");
    expect(raw).toContain("SHIFT_INVALID");
    expect(raw).toContain("028");
  });
});

// -------------------------------------------------------------------- 414 ---
//
// Los filtros de PostgREST viajan en la URL. Toda lista `.in(...)` que crece con
// el volumen —turnos, o las facturas y los usuarios de esos turnos— termina en
// 414 (URI Too Long) y la lectura NO ocurre. El arqueo, la vista del día y el
// historial comparten fetchers, así que el mismo `.in` sin tope dejaba sin salida
// a las tres pantallas. El arreglo no toca la aritmética: deduplica, trocea con
// `chunkIds` (100 uuids por URL) y pagina CADA lote con el contrato de CL-21.
//
// La vista del día acota a 50 turnos y el historial a `HISTORY_PAGE_SIZE` por
// página, así que la lista de ids de TURNO no puede pasar de 100 en esos caminos;
// las listas que SÍ crecen SIN tope son la de `invoice_id` (muchas facturas por
// turno) y la de usuarios distintos (`userNames`). El bloque mide las dos cosas:
// ningún lote supera el tope de la URL y el conjunto leído es el COMPLETO.
describe("cash: 414 los filtros .in(...) de caja van troceados", () => {
  /** Turnos del «día ancho»: la vista del día los acota a 50. */
  const SHIFTS = 50;
  /** Facturas por turno: 12 × 50 = 600 ids, muy por encima del tope de la URL. */
  const INVOICES_PER_SHIFT = 12;
  /** Líneas de conteo por turno: 21 × 50 = 1050, por encima del `max-rows`. */
  const COUNTS_PER_SHIFT = 21;
  const PAYMENTS_PER_SHIFT = 3;
  const DIRECT_INVOICE_PAYMENTS_PER_SHIFT = 2;
  const VOUCHERS_PER_SHIFT = 2;
  /** La venta de UN turno: cajón (3 × 1000) + cobros de factura (2 × 500). */
  const SHIFT_SALES = PAYMENTS_PER_SHIFT * 1000 + DIRECT_INVOICE_PAYMENTS_PER_SHIFT * 500;

  const pad = (value: number) => String(value).padStart(2, "0");
  const shiftId = (shift: number) => `turno-${pad(shift)}`;
  const invoiceId = (shift: number, index: number) => `factura-${pad(shift)}-${pad(index)}`;
  const openedAt = (shift: number) => `2026-09-30T08:${pad(shift)}:00-05:00`;

  /**
   * Un día con 50 turnos CERRADOS. Cada uno fue abierto y cerrado por usuarios
   * DISTINTOS (100 ids) y el primero tiene además un reconteo por un usuario más
   * (101): así `userNames` recibe más ids que los que aguanta una URL. Cada turno
   * trae facturas, cobros, comisiones, vales y líneas de conteo.
   */
  function seedWideDay(): void {
    const users: Array<Record<string, unknown>> = [];
    for (let shift = 0; shift < SHIFTS; shift += 1) {
      users.push({ id: `u-open-${pad(shift)}`, full_name: `Abre ${shift}` });
      users.push({ id: `u-close-${pad(shift)}`, full_name: `Cierra ${shift}` });
    }
    users.push({ id: "u-recount", full_name: "Recontó" });
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      users,
      cash_shifts: Array.from({ length: SHIFTS }, (_, shift) => ({
        id: shiftId(shift),
        cash_register_id: shiftStub.REGISTER_ID,
        sede_id: shiftStub.SEDE_ID,
        opened_by: `u-open-${pad(shift)}`,
        closed_by: `u-close-${pad(shift)}`,
        opened_at: openedAt(shift),
        closed_at: `2026-09-30T09:${pad(shift)}:00-05:00`,
        opening_base: 0,
        expected_cash: 0,
        counted_cash: 0,
        base_left: 0,
        cash_withdrawn: 0,
        base_difference: 0,
        status: "cerrado",
        observation: null,
      })),
      payments: Array.from({ length: SHIFTS }).flatMap((_, shift) =>
        Array.from({ length: PAYMENTS_PER_SHIFT }, (_, index) => ({
          id: `pago-${pad(shift)}-${index}`,
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftId(shift),
          invoice_id: null,
          method_code: "efectivo",
          amount: 1000,
        })),
      ),
      invoices: Array.from({ length: SHIFTS }).flatMap((_, shift) =>
        Array.from({ length: INVOICES_PER_SHIFT }, (_, index) => ({
          id: invoiceId(shift, index),
          sede_id: shiftStub.SEDE_ID,
          cash_shift_id: shiftId(shift),
        })),
      ),
      // Cobros de factura DIRECTOS (con turno): los históricos sin turno no se
      // siembran, así que la unión no puede solapar ni contar dos veces.
      invoice_payments: Array.from({ length: SHIFTS }).flatMap((_, shift) =>
        Array.from({ length: DIRECT_INVOICE_PAYMENTS_PER_SHIFT }, (_, index) => ({
          id: `cobro-${pad(shift)}-${index}`,
          invoice_id: invoiceId(shift, index),
          cash_shift_id: shiftId(shift),
          method_code: "efectivo",
          amount: 500,
        })),
      ),
      commission_payouts: Array.from({ length: SHIFTS }).flatMap((_, shift) =>
        Array.from({ length: 2 }, (_, index) => ({
          id: `comision-${pad(shift)}-${index}`,
          cash_shift_id: shiftId(shift),
          method_code: "efectivo",
          amount: 50,
        })),
      ),
      voucher_requests: Array.from({ length: SHIFTS }).flatMap((_, shift) => [
        ...Array.from({ length: VOUCHERS_PER_SHIFT }, (_, index) => ({
          id: `vale-${pad(shift)}-${index}`,
          cash_shift_id: shiftId(shift),
          approved_by: shiftStub.USER_ID,
          method_code: "efectivo",
          amount: 100,
        })),
        // Un vale PENDIENTE: no toca caja (misma regla de `isVoucherCashOut`).
        {
          id: `vale-pendiente-${pad(shift)}`,
          cash_shift_id: shiftId(shift),
          approved_by: null,
          method_code: "efectivo",
          amount: 100,
        },
      ]),
      // Líneas de conteo en la fase del CIERRE y en un método DIGITAL (así
      // aparecen en `declarados`): 1050 filas superan el `max-rows` por request.
      cash_shift_counts: Array.from({ length: SHIFTS }).flatMap((_, shift) =>
        Array.from({ length: COUNTS_PER_SHIFT }, (_, line) => ({
          id: `conteo-${pad(shift)}-${pad(line)}`,
          shift_id: shiftId(shift),
          phase: "cierre",
          method_code: "tarjeta",
          denomination: null,
          quantity: 1,
          amount: 100,
        })),
      ),
      // Un reconteo del PRIMER turno, por un usuario DISTINTO de los 100: es el
      // id 101 de `userNames`. No toca la venta, que es lo que el test afirma.
      cash_shift_recounts: [
        {
          id: "reconteo-01",
          shift_id: shiftId(0),
          previous_counted_cash: 0,
          previous_base_left: 0,
          previous_cash_withdrawn: 0,
          previous_base_difference: 0,
          counted_cash: 0,
          base_left: 0,
          cash_withdrawn: 0,
          base_difference: 0,
          reason: "Conteo corregido.",
          recounted_by: "u-recount",
          recounted_at: "2026-09-30T10:00:00-05:00",
        },
      ],
      audit_logs: [],
    };
  }

  const inChunks = (table: string, column: string) =>
    shiftStub.inSizes.filter((entry) => entry.table === table && entry.column === column);
  const sizeSum = (entries: Array<{ size: number }>) =>
    entries.reduce((acc, entry) => acc + entry.size, 0);

  beforeEach(() => {
    resetShiftStub();
    shiftStub.lifecycle = true;
  });
  afterEach(() => resetShiftStub());

  it("la vista del día trocea TODO filtro .in(...) y ve el conjunto COMPLETO", async () => {
    seedWideDay();

    const day = await getDayView({ fecha: "2026-09-30" });

    // Ninguna lista de ids viajó en una sola URL: el tope es el de la casa.
    expect(shiftStub.inSizes.length).toBeGreaterThan(0);
    for (const entry of shiftStub.inSizes) {
      expect(entry.size, `${entry.table}.${entry.column}`).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
    }
    // La lista de facturas (600 ids) SÍ excede la URL: va en seis lotes de 100.
    const invoiceChunks = inChunks("invoice_payments", "invoice_id");
    expect(invoiceChunks.map((entry) => entry.size)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(sizeSum(invoiceChunks)).toBe(SHIFTS * INVOICES_PER_SHIFT);
    // Los usuarios distintos (101: 50 aperturas + 50 cierres + 1 reconteo).
    const userChunks = inChunks("users", "id");
    expect(userChunks).toHaveLength(2);
    expect(Math.max(...userChunks.map((entry) => entry.size))).toBe(IN_FILTER_CHUNK_SIZE);
    expect(sizeSum(userChunks)).toBe(101);
    // La venta del día es la del conjunto COMPLETO: ni recorte ni doble conteo.
    expect(day.totals.turnos).toBe(SHIFTS);
    expect(day.totals.ventas).toBe(SHIFTS * SHIFT_SALES);
    for (const view of day.shifts) expect(view.ventas).toBe(SHIFT_SALES);
    // Y los conteos —1050 filas, por encima del techo por request— se leen
    // enteros: el ÚLTIMO turno declara el total de sus 21 líneas, que solo
    // existen en la SEGUNDA página.
    expect(shiftStub.requests.cash_shift_counts).toBe(2);
    expect(day.shifts[SHIFTS - 1].declarados).toEqual([
      { method_code: "tarjeta", amount: COUNTS_PER_SHIFT * 100 },
    ]);
    // Los vales APROBADOS del último turno (el pendiente no toca caja).
    expect(day.shifts[SHIFTS - 1].vales).toBe(VOUCHERS_PER_SHIFT * 100);
  });

  it("el historial trocea sus filtros y ve la página COMPLETA", async () => {
    seedWideDay();

    const history = await getHistory({
      desde: "2026-09-01",
      hasta: "2026-09-30",
    });

    // La página son 10 turnos (el tope del historial) y cada uno viene ENTERO.
    expect(history.total).toBe(SHIFTS);
    expect(history.shifts).toHaveLength(HISTORY_PAGE_SIZE);
    for (const view of history.shifts) expect(view.ventas).toBe(SHIFT_SALES);
    for (const entry of shiftStub.inSizes) {
      expect(entry.size, `${entry.table}.${entry.column}`).toBeLessThanOrEqual(IN_FILTER_CHUNK_SIZE);
    }
    // 10 turnos × 12 facturas = 120 ids: la lista viaja en DOS lotes.
    const invoiceChunks = inChunks("invoice_payments", "invoice_id");
    expect(invoiceChunks.map((entry) => entry.size)).toEqual([100, 20]);
    expect(sizeSum(invoiceChunks)).toBe(HISTORY_PAGE_SIZE * INVOICES_PER_SHIFT);
  });

  it("un lote POSTERIOR que falla se ve A LA VISTA: READ_INCOMPLETE, jamás un total corto", async () => {
    seedWideDay();
    // El SEGUNDO lote de facturas no llega. Las consultas a `invoice_payments`
    // son: (1) la lectura directa por turno, (2) el primer lote de históricos y
    // (3) el segundo, que es el que falla.
    shiftStub.failAt = { invoice_payments: [3] };

    const outcome: unknown = await getDayView({ fecha: "2026-09-30" }).catch(
      (error: unknown) => error,
    );

    // No hay una vista con la venta recortada: hay un error de negocio.
    expect(outcome).toBeInstanceOf(CashError);
    expect(outcome).toMatchObject({ code: "READ_INCOMPLETE", status: 500 });
    expect((outcome as CashError).message).toContain("los cobros de factura históricos del turno");
  });

  it("una lista vacía corta el circuito: no se emite NINGUNA consulta .in(...)", async () => {
    // Sin turnos en la fecha, todas las listas de ids están vacías.
    const day = await getDayView({ fecha: "2026-09-30" });

    expect(day.shifts).toEqual([]);
    expect(shiftStub.inSizes).toEqual([]);
    for (const table of [
      "payments",
      "invoice_payments",
      "invoices",
      "cash_shift_counts",
      "cash_shift_recounts",
      "commission_payouts",
      "voucher_requests",
      "users",
    ]) {
      expect(shiftStub.requests[table] ?? 0, table).toBe(0);
    }
  });

  it("un usuario repetido va UNA sola vez: la lista de usuarios se deduplica antes de trocear", async () => {
    // Cinco turnos abiertos y cerrados por el MISMO usuario: la lista cruda trae
    // el id diez veces y el dedupe lo deja una sola.
    shiftStub.tables = {
      cash_registers: [
        {
          id: shiftStub.REGISTER_ID,
          sede_id: shiftStub.SEDE_ID,
          name: "Caja única",
          base_configurada: shiftStub.BASE_CONFIGURADA,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      users: [{ id: shiftStub.USER_ID, full_name: "Cajero de prueba" }],
      cash_shifts: Array.from({ length: 5 }, (_, index) => ({
        id: `turno-dedupe-${index}`,
        cash_register_id: shiftStub.REGISTER_ID,
        sede_id: shiftStub.SEDE_ID,
        opened_by: shiftStub.USER_ID,
        closed_by: shiftStub.USER_ID,
        opened_at: `2026-09-30T1${index}:00:00-05:00`,
        closed_at: `2026-09-30T1${index}:30:00-05:00`,
        opening_base: 0,
        expected_cash: 0,
        counted_cash: 0,
        base_left: 0,
        cash_withdrawn: 0,
        base_difference: 0,
        status: "cerrado",
        observation: null,
      })),
      audit_logs: [],
    };

    const day = await getDayView({ fecha: "2026-09-30" });

    expect(day.shifts).toHaveLength(5);
    // Diez ids crudos (abrió y cerró) y UNA sola consulta, con un solo id.
    expect(inChunks("users", "id")).toEqual([{ table: "users", column: "id", size: 1 }]);
    expect(day.shifts[0].abierto_por).toBe("Cajero de prueba");
    expect(day.shifts[0].cerrado_por).toBe("Cajero de prueba");
  });
});

// ---------------------------------------------------------------------------
// 071_rpc_single_sede.sql: la caja re-emite sus CUATRO funciones sin el
// parámetro de sede.
//
// LO QUE ESTA SUITE FIJA (y antes fijaba contra la firma vieja): 049, 058, 059 y
// 056 declaraban `p_sede_id` al principio de la firma y filtraban por `sede_id`
// en el turno y en la factura. Con una sola sede, ese parámetro es una frontera
// más dentro de una base que ya tiene una, y la firma que declara la base tiene
// que ser EXACTAMENTE la que manda el servidor: un `p_sede_id` de sobra hace
// fallar al llamador nuevo, y una sobrecarga vieja viva deja pasar al viejo sin
// que nadie lo note. El orden es DROP y después CREATE, por eso.
// ---------------------------------------------------------------------------

describe("migración 071_rpc_single_sede.sql (caja)", () => {
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

  it("las CUATRO funciones de caja se crean SIN el parámetro de sede", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cash_open_shift_atomic\(\s*p_register_id uuid,\s*p_opened_by uuid,\s*p_opening_base numeric,\s*p_counts jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cash_close_shift_atomic\(\s*p_shift_id uuid,\s*p_closed_by uuid,\s*p_closed_at timestamptz,\s*p_close jsonb,\s*p_counts jsonb,\s*p_collection_counts jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cash_recount_shift_atomic\(\s*p_shift_id uuid,\s*p_recounted_by uuid,\s*p_recount jsonb,\s*p_counts jsonb\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.cash_invoice_payment_atomic\(\s*p_shift_id uuid,\s*p_invoice_id uuid,\s*p_user_id uuid,\s*p_closed_at timestamptz,\s*p_set_shift boolean,\s*p_mark_paid boolean,\s*p_collection jsonb\s*\)/,
    );
    expect(sql).not.toMatch(/\bsede_id\s*=\s*p_sede_id/);
    expect(sql).not.toContain("p_sede_id IS NULL");
    expect(sql).not.toContain("p_sede_id");
  });

  it("dropea la firma VIEJA de las CUATRO antes de crear la nueva", () => {
    const drops = [
      "DROP FUNCTION IF EXISTS public.cash_open_shift_atomic(uuid, uuid, uuid, numeric, jsonb)",
      "DROP FUNCTION IF EXISTS public.cash_close_shift_atomic(uuid, uuid, uuid, timestamptz, jsonb, jsonb, jsonb)",
      "DROP FUNCTION IF EXISTS public.cash_recount_shift_atomic(uuid, uuid, uuid, jsonb, jsonb)",
      "DROP FUNCTION IF EXISTS public.cash_invoice_payment_atomic(uuid, uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb)",
    ];
    for (const statement of drops) {
      expect(sql).toContain(statement);
      const name = statement.slice(statement.indexOf("public.") + 7, statement.indexOf("("));
      expect(sql.indexOf(statement)).toBeLessThan(
        sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`),
      );
    }
  });

  it("la SEDE que se ESCRIBE sale de la fila bloqueada: la CAJA al abrir, el TURNO al cobrar", () => {
    // Abrir un turno: la caja bloqueada pasa a `SELECT r.sede_id … FOR UPDATE`
    // y su sede es la que escribe el turno. Cobrar: la fila del libro de cajón
    // toma la del turno que ya está bloqueado con `FOR SHARE`.
    expect(sql).toMatch(
      /SELECT r\.sede_id\s*\n\s*INTO v_sede\s*\n\s*FROM public\.cash_registers r\s*\n\s*WHERE r\.id = p_register_id\s*\n\s*FOR UPDATE OF r;/,
    );
    expect(sql).toContain("(p_register_id, v_sede, p_opened_by, p_opening_base, 0, 'abierto')");
    expect(sql).toContain("(v_turno.sede_id,");
  });

  it("el permiso y el search_path viajan con la firma NUEVA, y el comentario también", () => {
    for (const signature of [
      "cash_open_shift_atomic(uuid, uuid, numeric, jsonb)",
      "cash_close_shift_atomic(uuid, uuid, timestamptz, jsonb, jsonb, jsonb)",
      "cash_recount_shift_atomic(uuid, uuid, jsonb, jsonb)",
      "cash_invoice_payment_atomic(uuid, uuid, uuid, timestamptz, boolean, boolean, jsonb)",
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

  it("conserva los locks, su ORDEN y las precondiciones: el cambio es de firma", () => {
    // El cierre y el reconteo siguen bloqueando el turno con `FOR UPDATE`; el
    // cobro sigue bloqueándolo con `FOR SHARE` ANTES de la factura. El orden se
    // mira DENTRO del cuerpo del cobro, que es donde el orden global importa.
    expect(sql).toContain("FOR UPDATE OF s");
    expect(sql).toContain("FOR SHARE OF s");
    const cobro = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic"),
      sql.indexOf("$$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.cash_invoice_payment_atomic")),
    );
    expect(cobro.indexOf("FOR SHARE OF s")).toBeGreaterThan(-1);
    expect(cobro.indexOf("FOR SHARE OF s")).toBeLessThan(cobro.indexOf("FOR UPDATE OF i"));
    // El token de las CUATRO entradas del arqueo (CL-19/CL-20) sigue siendo
    // obligatorio, con su rechazo.
    expect(sql).toContain("ARQUEO_STALE");
    for (const code of [
      "SHIFT_INVALID",
      "SHIFT_REGISTER_NOT_FOUND",
      "SHIFT_ALREADY_OPEN",
      "SHIFT_NOT_FOUND",
      "SHIFT_ALREADY_CLOSED",
      "SHIFT_NOT_CLOSED",
      "SHIFT_COUNT_MISMATCH",
      "SHIFT_WRITE_MISMATCH",
      "ALREADY_RECOUNTED",
      "SHIFT_CLOSED",
      "PAYMENT_INVALID",
      "PAYMENT_MISMATCH",
      "ANNUL_INVALID",
    ]) {
      expect(sql).toContain(`RAISE EXCEPTION '${code}'`);
    }
  });

  it("NO borra la columna ni toca las políticas: ése es el paso irreversible de otra unidad", () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/\bPOLICY\b/i);
    expect(raw).toContain("POR QUÉ ESTE ARCHIVO CORRE ANTES DEL BORRADO DE LA COLUMNA");
  });
});
