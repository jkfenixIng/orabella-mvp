import { describe, expect, it } from "vitest";
import {
  commissionPayoutSchema,
  commissionRuleKey,
  commissionRuleSchema,
  employeeLineCommissionOrigin,
  pendingCommission,
  resolveEmployeeLineCommission,
  resolveLineCommission,
  roundMoney,
  type RuleRate,
} from "@/src/features/commissions/schemas";
import {
  buildEmployeeCommissionDetail,
  buildEmployeeDetail,
} from "@/src/features/payroll/schemas";

describe("commissions: reglas exigen % o fijo", () => {
  const base = {
    item_type: "producto",
    item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  } as const;

  it("acepta porcentaje, fijo o ambos; rechaza ninguno", () => {
    expect(commissionRuleSchema.safeParse({ ...base, percent: 10 }).success).toBe(true);
    expect(commissionRuleSchema.safeParse({ ...base, amount: 5000 }).success).toBe(true);
    expect(commissionRuleSchema.safeParse({ ...base, percent: 10, amount: 5000 }).success).toBe(true);
    expect(commissionRuleSchema.safeParse({ ...base }).success).toBe(false);
    expect(commissionRuleSchema.safeParse({ ...base, percent: 101 }).success).toBe(false);
    expect(commissionRuleSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
  });

  it("pago exige monto positivo y método", () => {
    expect(
      commissionPayoutSchema.safeParse({
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 20000,
      }).success,
    ).toBe(true);
    expect(
      commissionPayoutSchema.safeParse({
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("commissions: cálculo puro", () => {
  it("regla gana a la tasa plana (% sobre subtotal + fijo por unidad)", () => {
    expect(
      resolveLineCommission({
        subtotal: 100000,
        qty: 2,
        rule: { percent: 10, amount: 5000 },
        flatPercent: 30,
      }),
    ).toBe(20000);
    expect(
      resolveLineCommission({ subtotal: 100000, qty: 1, rule: null, flatPercent: 10 }),
    ).toBe(10000);
    expect(
      resolveLineCommission({ subtotal: 100000, qty: 1, rule: null, flatPercent: null }),
    ).toBe(0);
  });

  it("pendiente nunca negativo (tope contra doble pago)", () => {
    expect(pendingCommission(20000, 5000)).toBe(15000);
    expect(pendingCommission(20000, 20000)).toBe(0);
    expect(pendingCommission(20000, 25000)).toBe(0);
  });
});

describe("commissions: resolución compartida por línea (pago inmediato ≡ nómina)", () => {
  it("regla ítem×empleado gana sobre el porcentaje plano (servicio)", () => {
    const rules = new Map<string, RuleRate>([
      [commissionRuleKey("servicio", "svc-1"), { percent: 10, amount: null }],
    ]);
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 100000,
        qty: 1,
        rules,
        flatPercent: 30,
      }),
    ).toBe(10000);
  });

  it("sin regla rige el porcentaje plano; null = 0 (servicio)", () => {
    const rules = new Map<string, RuleRate>();
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 100000,
        qty: 1,
        rules,
        flatPercent: 10,
      }),
    ).toBe(10000);
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 100000,
        qty: 1,
        rules,
        flatPercent: null,
      }),
    ).toBe(0);
  });

  it("regla con fijo por unidad multiplica por la cantidad", () => {
    const rules = new Map<string, RuleRate>([
      [commissionRuleKey("servicio", "svc-1"), { percent: null, amount: 5000 }],
    ]);
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 90000,
        qty: 3,
        rules,
        flatPercent: null,
      }),
    ).toBe(15000);
  });

  it("ítem custom con valor fijo: manda el valor del ítem × cantidad", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 50000,
        qty: 2,
        commissionValue: 12000,
        rules: new Map(),
        flatPercent: 20,
      }),
    ).toBe(24000);
  });

  it("paridad: la resolución compartida usa la misma fórmula del pago inmediato", () => {
    // El pago inmediato usa `resolveLineCommission`; la resolución compartida
    // debe dar idéntico resultado para la misma línea y contexto.
    const args = { subtotal: 250000, qty: 2, rule: { percent: 8, amount: 1000 }, flatPercent: 25 };
    const shared = resolveEmployeeLineCommission({
      itemType: "producto",
      itemRefId: "prod-1",
      subtotal: args.subtotal,
      qty: args.qty,
      rules: new Map([[commissionRuleKey("producto", "prod-1"), args.rule]]),
      flatPercent: args.flatPercent,
    });
    expect(shared).toBe(resolveLineCommission(args));
    // 250000 × 8% = 20000 + 1000 × 2 = 22000.
    expect(shared).toBe(22000);
  });
});

describe("commissions: comisión y porcentaje son excluyentes (producto = valor del ítem)", () => {
  const rules = new Map<string, RuleRate>();

  it("producto con commission_value usa el valor del ítem, no el % del empleado", () => {
    // Caso del bug reportado: Tinte rubio commission_value=1000, empleado 35%,
    // subtotal 42.000. Antes mostraba el 35% (~14.700); debe ser 1.000.
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-tinte",
        subtotal: 42000,
        qty: 1,
        commissionValue: 1000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(1000);
  });

  it("producto sin commission_value (null o 0) no cae al porcentaje: 0", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        rules,
        flatPercent: 35,
      }),
    ).toBe(0);
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: 100000,
        qty: 1,
        commissionValue: 0,
        rules,
        flatPercent: 35,
      }),
    ).toBe(0);
  });

  it("producto sin valor con regla ítem×empleado: la regla aplica (nunca el % plano)", () => {
    const withRule = new Map<string, RuleRate>([
      [commissionRuleKey("producto", "prod-1"), { percent: 10, amount: null }],
    ]);
    // Sin valor del ítem cae a la regla (otra capa), no al 35% del empleado.
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        rules: withRule,
        flatPercent: 35,
      }),
    ).toBe(10000);
    // Con valor del ítem, el valor manda sobre la regla.
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: 100000,
        qty: 1,
        commissionValue: 1000,
        rules: withRule,
        flatPercent: 35,
      }),
    ).toBe(1000);
  });

  it("servicio sigue el % del empleado sobre el subtotal", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 42000,
        qty: 1,
        rules,
        flatPercent: 35,
      }),
    ).toBe(14700);
  });

  it("custom: con valor fijo manda el ítem; sin valor rige el % del empleado", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 42000,
        qty: 1,
        commissionValue: 12000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(12000);
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 42000,
        qty: 1,
        commissionValue: null,
        rules,
        flatPercent: 35,
      }),
    ).toBe(14700);
  });
});

describe("commissions: el valor fijo es por unidad y se multiplica por la cantidad", () => {
  const rules = new Map<string, RuleRate>();

  it("producto commission_value=1000 con qty=3 paga 3000", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-tinte",
        subtotal: 126000,
        qty: 3,
        commissionValue: 1000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(3000);
  });

  it("custom commission_value=5000 con qty=2 paga 10000 (cambio de gasto)", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 2,
        commissionValue: 5000,
        rules,
        flatPercent: 20,
      }),
    ).toBe(10000);
  });

  it("no hay doble multiplicación: el fijo ignora el subtotal (que ya trae la cantidad)", () => {
    // subtotal = unit_price × qty; el fijo se multiplica por qty una sola vez.
    const qty = 3;
    const unitPrice = 42000;
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: unitPrice * qty,
        qty,
        commissionValue: 1000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(3000);
  });

  it("qty=1 conserva el valor del ítem (no rompe lo que ya funcionaba)", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: "prod-1",
        subtotal: 42000,
        qty: 1,
        commissionValue: 1000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(1000);
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 42000,
        qty: 1,
        commissionValue: 5000,
        rules,
        flatPercent: 35,
      }),
    ).toBe(5000);
  });

  it("servicio con subtotal 100000 y empleado 10% paga 10000", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: "svc-1",
        subtotal: 100000,
        qty: 1,
        rules,
        flatPercent: 10,
      }),
    ).toBe(10000);
  });
});

describe("commissions: el pago inmediato solo ofrece comisiones (no el % del empleado)", () => {
  const employeeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rules = new Map<string, RuleRate>();
  // Empleado con payout_mode "inmediato" y pay_type "porcentaje" (35%).
  const flatPercent = 35;

  interface TestLine {
    itemType: string;
    itemRefId: string | null;
    subtotal: number;
    qty: number;
    commissionValue: number | null;
  }

  // Servicio: comisiona por el % del empleado. Producto con valor fijo: comisión.
  const serviceLine: TestLine = {
    itemType: "servicio",
    itemRefId: "svc-1",
    subtotal: 42000,
    qty: 1,
    commissionValue: null,
  };
  const productLine: TestLine = {
    itemType: "producto",
    itemRefId: "prod-tinte",
    subtotal: 42000,
    qty: 1,
    commissionValue: 1000,
  };

  /** Mismo reparto que `earnedCommissionFor`: total de la línea y su parte inmediata. */
  function split(line: TestLine): { earned: number; immediate: number } {
    const earned = resolveEmployeeLineCommission({
      itemType: line.itemType,
      itemRefId: line.itemRefId,
      subtotal: line.subtotal,
      qty: line.qty,
      commissionValue: line.commissionValue,
      rules,
      flatPercent,
    });
    const immediate =
      employeeLineCommissionOrigin({
        itemType: line.itemType,
        itemRefId: line.itemRefId,
        commissionValue: line.commissionValue,
        rules,
        flatPercent,
      }) === "commission"
        ? earned
        : 0;
    return { earned, immediate };
  }

  it("clasifica el origen: servicio = percent, producto con valor = commission, sin base = none", () => {
    expect(
      employeeLineCommissionOrigin({
        itemType: "servicio",
        itemRefId: "svc-1",
        commissionValue: null,
        rules,
        flatPercent,
      }),
    ).toBe("percent");
    expect(
      employeeLineCommissionOrigin({
        itemType: "producto",
        itemRefId: "prod-tinte",
        commissionValue: 1000,
        rules,
        flatPercent,
      }),
    ).toBe("commission");
    expect(
      employeeLineCommissionOrigin({
        itemType: "producto",
        itemRefId: "prod-1",
        commissionValue: null,
        rules,
        flatPercent,
      }),
    ).toBe("none");
  });

  it("el pendiente inmediato incluye SOLO el producto (1000), nunca el % del servicio (14700)", () => {
    const service = split(serviceLine);
    const product = split(productLine);
    const earned = roundMoney(service.earned + product.earned);
    const immediateEarned = roundMoney(service.immediate + product.immediate);

    expect(service.earned).toBe(14700); // 42000 × 35%
    expect(product.earned).toBe(1000); // valor fijo del ítem × 1
    expect(earned).toBe(15700); // total ganado
    expect(immediateEarned).toBe(1000); // solo comisión por ítem
    expect(pendingCommission(immediateEarned, 0)).toBe(1000);
  });

  it("la nómina incluye ambos: el % del servicio y la comisión del producto", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId,
      payoutMode: "inmediato",
      payType: "porcentaje",
      commissionPercent: flatPercent,
      lines: [
        {
          invoice_id: "inv-1",
          consecutive_number: 1,
          item_id: "svc-1",
          item_type: "servicio",
          qty: 1,
          unit_price: 42000,
          line_subtotal: 42000,
          commission_value: null,
          item_ref_id: "svc-1",
        },
        {
          invoice_id: "inv-1",
          consecutive_number: 1,
          item_id: "prod-tinte",
          item_type: "producto",
          qty: 1,
          unit_price: 42000,
          line_subtotal: 42000,
          commission_value: 1000,
          item_ref_id: "prod-tinte",
        },
      ],
      rules,
    });
    const { commissions } = buildEmployeeDetail(detail);

    expect(detail).toHaveLength(2);
    expect(commissions).toBe(15700); // % del servicio (14700) + comisión (1000)
    expect(detail.find((line) => line.item_type === "servicio")?.commission).toBe(14700);
    expect(detail.find((line) => line.item_type === "producto")?.commission).toBe(1000);
  });

  it("paridad: lo pagado inmediato + lo que aporta nómina = total ganado (nada se pierde ni se duplica)", () => {
    const totalEarned = 15700;
    const paidImmediate = pendingCommission(1000, 0); // solo el producto
    // La nómina suma todo lo ganado y resta lo pagado inmediato (payroll/service).
    const payrollCommissions = roundMoney(Math.max(0, totalEarned - paidImmediate));

    expect(paidImmediate).toBe(1000);
    expect(payrollCommissions).toBe(14700); // exactamente el % del servicio
    expect(roundMoney(paidImmediate + payrollCommissions)).toBe(totalEarned);
  });
});
