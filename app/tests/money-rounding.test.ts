import { describe, expect, it } from "vitest";
import {
  MONEY_EPSILON,
  applyPaymentSplit,
  computeCardFees,
  computeInvoiceTotals,
  computeLineSubtotal,
  moneyEquals,
  portionsMatchBalance,
  roundMoney,
  snapshotInvoiceTaxes,
} from "@/src/features/billing/schemas";
import { invoiceNetBalance, splitGrossCardFee } from "@/src/features/billing/service";
import { computeLineCommission, computeNetPay } from "@/src/features/payroll/schemas";
import {
  pendingCommission,
  resolveLineCommission,
} from "@/src/features/commissions/schemas";
import {
  cashOutLimitState,
  expectedDigitalTotal,
  sumMethodTotal,
} from "@/src/features/cash/schemas";

/**
 * REGLA DEL PESO ENTERO (032).
 *
 * Regla de negocio: el datafono NO acepta centavos; el recargo de la tarjeta
 * se le pasa al cliente y el total que el cliente paga EN EL DATAFONO es un
 * peso entero. Por eso todo el dinero que la app CALCULA es un entero de
 * pesos: lo que el sistema registra tiene que ser lo mismo que el datafono
 * cobra. Antes la app redondeaba a centavos y podía guardar $1.666,65 mientras
 * el datafono cobraba $1.667: un peso de descuadre por cobro con tarjeta.
 *
 * Este archivo fija la regla en la aritmética, no en un comentario: cada
 * bloque incluye un CONTROL NEGATIVO contra el redondeo al centavo anterior,
 * para que el test no pueda pasar en vacío si alguien revierte `roundMoney`
 * (o si un valor esperado coincide por casualidad con el viejo).
 */

/** El redondeo al centavo ANTERIOR: el control negativo de todo el archivo. */
const centRounding = (value: number): number => Math.round(value * 100) / 100;

const TARJETA = 5;

// ------------------------------------------------ el redondeo de la app ---

describe("dinero: roundMoney redondea a PESO ENTERO (032)", () => {
  it("half-up: el medio peso sube, como el total del datafono", () => {
    expect(roundMoney(0.5)).toBe(1);
    expect(roundMoney(1.5)).toBe(2);
    expect(roundMoney(10.5)).toBe(11);
    expect(roundMoney(100000.5)).toBe(100001);
    expect(roundMoney(0.4)).toBe(0);
    expect(roundMoney(10.4999)).toBe(10);
  });

  it("el caso del brief: $1.666,65 se registra como $1.667", () => {
    // Con centavos, la app guardaba 1666.65 y el datafono cobraba 1667.
    expect(roundMoney(1666.65)).toBe(1667);
    expect(roundMoney(999.99)).toBe(1000);
    expect(roundMoney(1234567.89)).toBe(1234568);
  });

  it("CONTROL NEGATIVO: no es (ni puede volver a ser) el redondeo al centavo", () => {
    const valores = [0.5, 1.5, 10.005, 999.99, 1666.65, 1234567.89];
    for (const valor of valores) {
      expect(roundMoney(valor)).not.toBe(centRounding(valor));
      expect(Number.isInteger(roundMoney(valor))).toBe(true);
    }
    // El contrato viejo era `Math.round(v * 100) / 100`; ese valor ya no sale.
    expect(roundMoney(10.005)).not.toBe(10.01);
    expect(roundMoney(10.005)).toBe(10);
  });

  it("la tolerancia de centavo sigue viva para reconciliar lo ya guardado", () => {
    expect(MONEY_EPSILON).toBe(0.01);
    expect(moneyEquals(100000, 100000)).toBe(true);
    expect(moneyEquals(100000, 100000.5)).toBe(false);
  });
});

// -------------------------------------------- subtotales, impuestos, total ---

describe("dinero: línea, impuestos y total en pesos enteros", () => {
  it("el subtotal de línea es entero aunque el precio traiga centavos", () => {
    // 3 × 3333.33 = 9999.99 → 10000 (antes quedaba en 9999.99).
    expect(computeLineSubtotal({ qty: 3, unit_price: 3333.33, discount: 0 })).toEqual({
      gross: 10000,
      discount: 0,
      subtotal: 10000,
    });
    // Descuento de medio peso: sube a 1, el subtotal sigue entero.
    expect(computeLineSubtotal({ qty: 1, unit_price: 100.5, discount: 0.5 })).toEqual({
      gross: 101,
      discount: 1,
      subtotal: 100,
    });
    // La aritmética histórica (todo entero) no cambia.
    expect(computeLineSubtotal({ qty: 2, unit_price: 35000, discount: 5000 })).toEqual({
      gross: 70000,
      discount: 5000,
      subtotal: 65000,
    });
  });

  it("el impuesto snapshot es entero (19% de 33333)", () => {
    // 33333 × 19 / 100 = 6333.27 → 6333.
    expect(snapshotInvoiceTaxes([{ code: "IVA", name: "IVA", percent: 19 }], 33333)).toEqual([
      { tax_code: "IVA", tax_name: "IVA", percent: 19, amount: 6333 },
    ]);
  });

  it("el total cierra exacto: base + impuestos + recargo, todo entero", () => {
    const totals = computeInvoiceTotals({
      items: [{ qty: 3, unit_price: 3333.33, discount: 0 }],
      discount: 0,
      activeTaxes: [{ code: "IVA", name: "IVA", percent: 19 }],
      surcharge: 0,
    });
    expect(totals).toMatchObject({
      subtotal: 10000,
      discount: 0,
      base: 10000,
      tax: 1900,
      surcharge: 0,
      total: 11900,
    });
    // La identidad que exige el CHECK de `invoices` cierra exacta (antes hacía
    // falta la tolerancia de centavo).
    expect(totals.total).toBe(totals.base + totals.tax + totals.surcharge);
  });

  it("CONTROL NEGATIVO: ningún monto calculado conserva centavos", () => {
    const totals = computeInvoiceTotals({
      items: [
        { qty: 3, unit_price: 3333.33, discount: 0.5 },
        { qty: 7, unit_price: 14.5, discount: 0 },
      ],
      discount: 250.75,
      activeTaxes: [{ code: "IVA", name: "IVA", percent: 19 }],
      surcharge: 1666.65,
    });
    for (const monto of [
      totals.subtotal,
      totals.discount,
      totals.base,
      totals.tax,
      totals.surcharge,
      totals.total,
      ...totals.taxes.map((tax) => tax.amount),
    ]) {
      expect(Number.isInteger(monto)).toBe(true);
    }
    expect(totals.subtotal).not.toBe(centRounding(totals.subtotal + 0.4));
  });
});

// ------------------------------------------- recargo de tarjeta (019/032) ---

describe("dinero: recargo de tarjeta en pesos enteros con la identidad bruto−fee=neto", () => {
  const feeOf = (code: string): number => (code === "tarjeta" ? TARJETA : 0);

  it("fee que divide exacto", () => {
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 100000 }], feeOf);
    expect(fee).toEqual({
      method_code: "tarjeta",
      net: 100000,
      feePercent: TARJETA,
      fee: 5000,
      gross: 105000,
    });
    expect(fee.gross - fee.fee).toBe(fee.net);
  });

  it("fee que NO divide exacto (5% de 9999 = 499.95 → 500)", () => {
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 9999 }], feeOf);
    expect(fee).toEqual({
      method_code: "tarjeta",
      net: 9999,
      feePercent: TARJETA,
      fee: 500,
      gross: 10499,
    });
    // El bruto sigue siendo neto + fee EXACTO (sin residuo de redondeo).
    expect(fee.gross - fee.fee).toBe(fee.net);
  });

  it("fee que cae en el medio peso (5% de 9990 = 499.5 → 500, medio arriba)", () => {
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 9990 }], feeOf);
    expect(fee.fee).toBe(500);
    expect(fee.gross).toBe(10490);
    expect(fee.gross - fee.fee).toBe(fee.net);
  });

  it("sin recargo el bruto es el neto", () => {
    const [fee] = computeCardFees([{ method_code: "efectivo", amount: 50000 }], feeOf);
    expect(fee.fee).toBe(0);
    expect(fee.gross).toBe(50000);
  });

  it("la inversa del BRUTO devuelve el mismo par (neto, fee)", () => {
    // Bruto 105000 → neto 100000, fee 5000.
    expect(splitGrossCardFee(105000, TARJETA)).toEqual({ net: 100000, fee: 5000 });
    // Bruto que no divide: 9999 → neto 9523, fee 476 (9523 + 476 = 9999).
    expect(splitGrossCardFee(9999, TARJETA)).toEqual({ net: 9523, fee: 476 });
    // Medio peso en el bruto: 1.5 → 2 (lo que el datafono cobra), sin fee.
    expect(splitGrossCardFee(1.5, 5)).toEqual({ net: 2, fee: 0 });
    // Sub-peso: no existe como dinero, se normaliza a 0.
    expect(splitGrossCardFee(0.4, TARJETA)).toEqual({ net: 0, fee: 0 });
    // Sin recargo el neto es el bruto.
    expect(splitGrossCardFee(100000, 0)).toEqual({ net: 100000, fee: 0 });
  });

  it("el caso del brief: 5% sobre un bruto con centavos no deja centavos", () => {
    // El datafono cobra 1667 (1666.65 → 1667). El registro tiene que decir lo
    // mismo: neto + fee = 1667, los dos enteros.
    const { net, fee } = splitGrossCardFee(1666.65, TARJETA);
    expect({ net, fee }).toEqual({ net: 1588, fee: 79 });
    expect(net + fee).toBe(1667);
    expect(Number.isInteger(net)).toBe(true);
    expect(Number.isInteger(fee)).toBe(true);
  });

  it("ida y vuelta: computeCardFees → splitGrossCardFee reconstruye el par", () => {
    for (const percent of [0, 5, 13, 19, 100]) {
      const feeOfPercent = (): number => percent;
      for (let net = 1; net <= 200; net += 1) {
        const [fee] = computeCardFees([{ method_code: "tarjeta", amount: net }], feeOfPercent);
        expect(fee.gross - fee.fee).toBe(net);
        expect(splitGrossCardFee(fee.gross, percent)).toEqual({ net, fee: fee.fee });
      }
      for (const net of [3333, 9999, 33333, 100000, 1234567]) {
        const [fee] = computeCardFees([{ method_code: "tarjeta", amount: net }], feeOfPercent);
        expect(splitGrossCardFee(fee.gross, percent)).toEqual({ net, fee: fee.fee });
      }
    }
  });

  it("CONTROL NEGATIVO: el reparto al centavo ya no puede ocurrir", () => {
    // El reparto viejo (redondeo del bruto, del neto y del fee a 2 decimales).
    const centsSplit = (gross: number, percent: number): { net: number; fee: number } => {
      const rounded = centRounding(gross);
      const net = centRounding(rounded / (1 + percent / 100));
      return { net, fee: centRounding(rounded - net) };
    };
    for (const gross of [1666.65, 999.99, 100.5, 1234567.89]) {
      const ahora = splitGrossCardFee(gross, TARJETA);
      expect(Number.isInteger(ahora.net)).toBe(true);
      expect(Number.isInteger(ahora.fee)).toBe(true);
      expect(ahora).not.toEqual(centsSplit(gross, TARJETA));
    }
  });
});

// ----------------------------------------------------- cobro y tope (031) ---

describe("dinero: los invariantes del cobro siguen en pie con pesos enteros", () => {
  it("las porciones cuadran el saldo (suma exacta, sin centavos)", () => {
    expect(portionsMatchBalance([{ amount: 40000 }, { amount: 60000 }], 100000)).toBe(true);
    expect(portionsMatchBalance([{ amount: 40001 }, { amount: 60000 }], 100000)).toBe(false);
    // Un monto con centavos no existe como dinero: se normaliza al peso.
    expect(portionsMatchBalance([{ amount: 100000.4 }], 100000)).toBe(true);
    expect(portionsMatchBalance([{ amount: 100000.6 }], 100000)).toBe(false);
  });

  it("applyPaymentSplit cierra en el total y rechaza el sobrepago", () => {
    expect(applyPaymentSplit({ paidSoFar: 95000, portions: [{ amount: 5000 }], total: 100000 })).toEqual({
      paid: 100000,
      remaining: 0,
      fullyPaid: true,
    });
    expect(
      () => applyPaymentSplit({ paidSoFar: 95000, portions: [{ amount: 5001 }], total: 100000 }),
    ).toThrowError("SOBREPAGO");
    expect(applyPaymentSplit({ paidSoFar: 0, portions: [{ amount: 60000 }], total: 100000 })).toEqual({
      paid: 60000,
      remaining: 40000,
      fullyPaid: false,
    });
  });

  it("el tope de 031 no rechaza el cobro legítimo con tarjeta y sí frena la carrera", () => {
    // Réplica de la condición del trigger (031): `sum(amount − fee_amount)`
    // nunca excede el neto facturado COBRABLE, redondeado a peso entero
    // (`round()` en SQL). Tolerancia de centavo, como el SQL.
    const capRejects = (args: {
      total: number;
      surcharge: number;
      paidNet: number;
      newNet: number;
    }): boolean => args.paidNet + args.newNet - roundMoney(args.total - args.surcharge) > 0.009;

    // Factura Emitida de 100000 sin cobro: el cliente paga con tarjeta. El
    // input son NETOS (crear/pagar en billing), el bruto es 105000.
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 100000 }], () => TARJETA);
    const balance = invoiceNetBalance({ total: 100000, surcharge: 0, payments: [] });
    expect(fee.net).toBe(balance.netRemaining);
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 0, newNet: fee.net })).toBe(false);
    // Lo que escribe (bruto + fee) deja el neto cobrado EXACTO.
    const cerrada = invoiceNetBalance({
      total: 100000,
      surcharge: 0,
      payments: [{ amount: fee.gross, fee_amount: fee.fee }],
    });
    expect(cerrada).toEqual({ netBilled: 100000, netCollected: 100000, netRemaining: 0 });
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: cerrada.netCollected, newNet: 0 })).toBe(
      false,
    );
    // Un peso más de neto ya es sobrecobro (carrera).
    expect(capRejects({ total: 100000, surcharge: 0, paidNet: 100000, newNet: 1 })).toBe(true);
  });

  it("el tope sigue descontando el recargo EMITIDO (factura de 104800)", () => {
    // Neto 100000 emitida con porción de tarjeta de neto 96000: surcharge
    // 4800, total 104800; la fila guarda bruto 100800 + fee 4800.
    const balance = invoiceNetBalance({
      total: 104800,
      surcharge: 4800,
      payments: [{ amount: 100800, fee_amount: 4800 }],
    });
    expect(balance).toEqual({ netBilled: 100000, netCollected: 96000, netRemaining: 4000 });
    // El saldo se cobra con el neto exacto; derivado del bruto, el fee cuadra.
    expect(splitGrossCardFee(4200, TARJETA)).toEqual({ net: 4000, fee: 200 });
    expect(balance.netCollected + 4000 - balance.netBilled).toBe(0);
  });

  it("CONTROL NEGATIVO: la aritmética NO se apoya en la tolerancia de centavo", () => {
    // Con pesos enteros los dos lados son enteros: si alguno tuviera centavos,
    // estas igualdades exactas fallarían (es justo lo que la regla elimina).
    const [fee] = computeCardFees([{ method_code: "tarjeta", amount: 9999 }], () => TARJETA);
    expect(fee.gross - fee.fee).toBe(fee.net);
    expect(Number.isInteger(fee.net + fee.fee)).toBe(true);
    // Y el valor con centavos del redondeo viejo NO es el que se produce.
    expect(fee.fee).not.toBe(centRounding(9999 * 0.05));
  });
});

// ------------------------------- el resto de las features de dinero (032) ---

describe("dinero: nómina, comisiones y caja siguen la misma regla", () => {
  it("comisión de línea entera (5% de 3333.33)", () => {
    // 3333.33 × 5 / 100 = 166.6665 → 167.
    expect(computeLineCommission(3333.33, 5)).toBe(167);
    expect(Number.isInteger(computeLineCommission(9999, 3))).toBe(true);
    expect(computeLineCommission(9999, 3)).toBe(300);
    // Regla ítem×empleado: mismo camino, mismo peso entero.
    expect(resolveLineCommission({ subtotal: 9999, qty: 1, rule: { percent: 3, amount: null } })).toBe(
      300,
    );
    expect(resolveLineCommission({ subtotal: 9999, qty: 3, rule: { percent: null, amount: 100.5 } })).toBe(
      302,
    );
  });

  it("el neto de nómina es entero (y el descuento tampoco mete centavos)", () => {
    // 1000000 + 166.67 + 0.5 − 50000 − 0.25 → entero.
    const net = computeNetPay({
      baseFixed: 1000000,
      commissions: 166.67,
      bonuses: 0.5,
      vales: 50000,
      otherDiscounts: 0.25,
    });
    expect(Number.isInteger(net)).toBe(true);
    expect(net).toBe(950168);
  });

  it("el pendiente de comisión es entero y nunca negativo", () => {
    // 166.67 − 100 → 67.
    expect(pendingCommission(166.67, 100)).toBe(67);
    expect(pendingCommission(100, 250)).toBe(0);
  });

  it("el tope de salida en efectivo y el total digital son enteros", () => {
    // 50% de 200001 = 100000.5 → 100001 (medio arriba).
    expect(cashOutLimitState(200001, 0).limit).toBe(100001);
    expect(cashOutLimitState(200000, 0)).toEqual({
      base: 200000,
      limit: 100000,
      used: 0,
      available: 100000,
    });
    // Apertura + cobrado − pagado, todo normalizado al peso.
    expect(expectedDigitalTotal(100.5, 0.5)).toBe(102);
    expect(sumMethodTotal(new Map([["nequi", 1234.4], ["tarjeta", 5678.6]]))).toBe(6913);
  });

  it("CONTROL NEGATIVO: ninguna salida de estas features conserva centavos", () => {
    const salidas = [
      computeLineCommission(3333.33, 5),
      resolveLineCommission({ subtotal: 9999, qty: 1, rule: { percent: 3, amount: null } }),
      pendingCommission(166.67, 100),
      computeNetPay({ baseFixed: 1000.5, commissions: 0.5, bonuses: 0.5, vales: 0.5 }),
      cashOutLimitState(200001, 0).limit,
      expectedDigitalTotal(100.5, 0.5),
      sumMethodTotal(new Map([["nequi", 1234.4]])),
    ];
    for (const salida of salidas) {
      expect(Number.isInteger(salida)).toBe(true);
    }
    // El valor del redondeo viejo no está en ninguna salida.
    expect(salidas).not.toContain(centRounding(3333.33 * 0.05));
  });
});

// --------------------- la factura con centavos legacy (U1-fix, 032) ---

/**
 * El cambio al peso entero dejó INTOCABLE la única comparación de cobro: la
 * `invoiceNetBalance` seguía redondeando al centavo `total − surcharge`. En
 * una factura emitida ANTES del cambio —que conserva centavos en su neto
 * facturado— eso vuelve el cobro INSATISFACIBLE: ningún peso entero (lo único
 * que el datafono cobra) cae dentro de `MONEY_EPSILON`. Este bloque fija ese
 * defecto y su cierre.
 *
 * Regla del dueño (no deducida del código): el datafono no acepta centavos, así
 * que el monto cobrable de una factura es su neto redondeado a PESO ENTERO. Si
 * la factura legacy dice 9999,99, el cliente entregó 10000 en el terminal: los
 * centavos guardados son la ficción, no el pago.
 */
describe("dinero: la factura con centavos legacy se cierra en pesos enteros", () => {
  /** Factura Emitida antes del cambio: neto facturado 9999,99 y sin cobros. */
  const legacy = {
    total: 9999.99,
    surcharge: 0,
    payments: [] as Array<{ amount: number; fee_amount: number }>,
  };

  it("el saldo cobrable es el PESO ENTERO (antes ninguna porción entera lo cubría)", () => {
    const balance = invoiceNetBalance(legacy);
    // El defecto: con el saldo al centavo, 9999 deja 0,99 y 10000 deja 0,01;
    // los dos caen FUERA de MONEY_EPSILON (0.01 estricto), así que
    // `splitPayment` no podía aceptar ninguna porción de peso entero.
    expect(balance.netBilled).toBe(10000);
    expect(balance.netRemaining).toBe(10000);
    expect(moneyEquals(10000, balance.netRemaining)).toBe(true);
    expect(moneyEquals(9999, balance.netRemaining)).toBe(false);
  });

  it("la caja acepta el pago exacto y la factura queda Pagada", () => {
    const balance = invoiceNetBalance(legacy);
    const { net } = splitGrossCardFee(10000, 0);
    // Tope del servicio de caja (cash/service.ts): 0.009, como el trigger 031.
    expect(balance.netCollected + net - balance.netBilled > 0.009).toBe(false);
    // Cierre: Emitida → Pagada cuando el neto cobrado cubre el neto facturado.
    expect(moneyEquals(balance.netCollected + net, balance.netBilled)).toBe(true);
    // Misma condición de `fullyPaid` en billing.splitPayment (`> -MONEY_EPSILON`).
    expect(balance.netCollected + net - balance.netBilled > -MONEY_EPSILON).toBe(true);
  });

  it("el tope de 031 acepta la liquidación entera y sigue frenando el sobrecobro", () => {
    // Réplica de la condición del trigger con el neto facturado redondeado a
    // peso entero (`round()` en SQL).
    const capRejects = (paidNet: number, newNet: number): boolean =>
      paidNet + newNet - roundMoney(legacy.total - legacy.surcharge) > 0.009;
    expect(capRejects(0, 10000)).toBe(false);
    expect(capRejects(10000, 1)).toBe(true);
  });

  it("para un neto YA entero no cambia nada: idéntico al redondeo al centavo anterior", () => {
    // No-op exacto: con neto entero `roundMoney` es la identidad, así que la
    // aritmética vieja (redondeo al centavo) da byte a byte lo mismo.
    const antes = (args: {
      total: number;
      surcharge: number;
      payments: Array<{ amount: number; fee_amount: number }>;
    }) => {
      const netBilled = centRounding(args.total - args.surcharge);
      const netCollected = centRounding(
        args.payments.reduce((acc, row) => acc + (row.amount - row.fee_amount), 0),
      );
      return { netBilled, netCollected, netRemaining: centRounding(netBilled - netCollected) };
    };
    const enteros = [
      { total: 104800, surcharge: 4800, payments: [{ amount: 100800, fee_amount: 4800 }] },
      { total: 100000, surcharge: 0, payments: [] },
      { total: 105000, surcharge: 5000, payments: [] },
      {
        total: 100000,
        surcharge: 0,
        payments: [{ amount: 40000, fee_amount: 0 }, { amount: 63000, fee_amount: 3000 }],
      },
    ];
    for (const input of enteros) {
      expect(invoiceNetBalance(input)).toEqual(antes(input));
    }
  });
});
