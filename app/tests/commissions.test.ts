import { describe, expect, it } from "vitest";
import {
  commissionPayoutSchema,
  commissionRuleKey,
  commissionRuleSchema,
  pendingCommission,
  resolveEmployeeLineCommission,
  resolveLineCommission,
  type RuleRate,
} from "@/src/features/commissions/schemas";

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
