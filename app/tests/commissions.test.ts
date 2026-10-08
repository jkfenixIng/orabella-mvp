import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  CommissionError,
  canPayCommissionImmediately,
  payCommissionNow,
  upsertCommissionRule,
} from "@/src/features/commissions/service";
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
    // CL-5: la marca del intento es obligatoria (la misma definición para las
    // cinco puertas del dinero). El cuerpo válido la lleva; el cuerpo sin ella
    // —o con una que no es uuid— se rechaza con CERO escrituras.
    const idempotency_key = "0c4f7a21-5e93-4b16-8d72-6a1f3c9e5b07";
    expect(
      commissionPayoutSchema.safeParse({
        idempotency_key,
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 20000,
      }).success,
    ).toBe(true);
    expect(
      commissionPayoutSchema.safeParse({
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 20000,
      }).success,
    ).toBe(false);
    expect(
      commissionPayoutSchema.safeParse({
        idempotency_key: "no-es-un-uuid",
        invoice_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        employee_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        amount: 20000,
      }).success,
    ).toBe(false);
    expect(
      commissionPayoutSchema.safeParse({
        idempotency_key,
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

  it("una regla por ítem SOLO porcentual no es inmediata: el origen es `percent`, no `commission`", () => {
    // `percent > 0` con `amount` vacío es puramente porcentual: antes se
    // clasificaba como fija por existir la fila de la regla y entraba al pago
    // inmediato; ahora el origen y el monto salen de la MISMA resolución.
    const percentRule = new Map<string, RuleRate>([
      [commissionRuleKey("producto", "prod-tinte"), { percent: 20, amount: null }],
    ]);
    const origin = employeeLineCommissionOrigin({
      itemType: "producto",
      itemRefId: "prod-tinte",
      commissionValue: null,
      rules: percentRule,
      flatPercent,
    });
    expect(origin).toBe("percent");

    // El ganado se calcula igual (100.000 × 20%) pero NO engrosa el pendiente
    // inmediato: el porcentaje se acumula y se paga en nómina.
    const earned = resolveEmployeeLineCommission({
      itemType: "producto",
      itemRefId: "prod-tinte",
      subtotal: 100000,
      qty: 1,
      rules: percentRule,
      flatPercent,
    });
    expect(earned).toBe(20000);
    expect(origin === "commission" ? earned : 0).toBe(0);
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

// ===================================================================== ---
// 034 — el tope del pago inmediato vive en la base
// ===================================================================== ---
//
// Hallazgo de la auditoría cruzada (sección 4): `payCommissionNow` lee lo ya
// pagado del par (factura, empleado) en `immediatePaidTotal`
// (commissions/service.ts:304, llamada en :387) e inserta después (:426). Es
// una lectura-y-escritura sin lock, y `commission_payouts` no tenía NINGUNA
// barrera en la base, a diferencia de sus hermanas `payroll_payments`
// (trg_payroll_payments_cap, 007_payroll.sql) e `invoice_payments`
// (trg_invoice_payments_cap, 031): dos pagos concurrentes del mismo par leen
// el mismo pendiente y cada uno inserta el total → el empleado cobra dos veces
// y el arqueo registra las dos filas, así que el descuadre cae en el cajón.
//
// La 034 no reimplementa la regla de comisión en SQL (una segunda versión de
// una regla de dinero, en otro lenguaje, es en sí un defecto): la aplicación
// ENTREGA el ganado inmediato que ya calcula (`earned.immediateEarned`, el
// mismo número con el que valida el pendiente) en la fila, y la base solo
// COMPARA `Σamount + nuevo` contra ese número — exactamente la división que la
// nómina usa entre `payroll_items.net_pay` (app) y `trg_payroll_payments_cap`
// (base).
//
// El doble de PostgREST de abajo emula ESE contrato: sin el ganado en la fila
// la base no tiene contra qué comparar (es el estado de hoy, antes de 034, y
// el INSERT entra); con él, el tope frena el segundo pago concurrente. La
// emulación es del CONTRATO de la base (la comparación), nunca del cálculo: el
// número lo sigue produciendo el servicio.
// ===================================================================== ---

describe("migración 034: tope del pago inmediato de comisión", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "034_commission_payout_cap.sql"),
    "utf8",
  );
  /** Cuerpo del trigger: lo EJECUTABLE, sin el encabezado que lo explica. */
  const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("$$;"));

  it("el archivo existe y trae DDL real (piso anti-vacío)", () => {
    expect(sql.length).toBeGreaterThan(1500);
    expect(sql).toContain("ALTER TABLE public.commission_payouts");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.check_commission_payouts_cap");
    expect(sql).toContain("CREATE TRIGGER trg_commission_payouts_cap");
  });

  it("agrega earned_immediate nullable, sin DEFAULT y sin backfill", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS earned_immediate numeric(12, 2) NULL");
    expect(sql).toContain("COMMENT ON COLUMN public.commission_payouts.earned_immediate");
    // Un NOT NULL obligaría a backfillear filas cuyo ganado no se conoce.
    expect(sql).not.toContain("ALTER COLUMN");
  });

  it("la base NO reimplementa la regla: el trigger no lee líneas ni reglas ni porcentajes", () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain("invoice_items");
    expect(body).not.toContain("commission_rules");
    expect(body).not.toContain("percent");
    expect(body).not.toContain("commission_value");
    // El tope es el número que la aplicación entrega en la fila.
    expect(body).toContain("NEW.earned_immediate");
  });

  it("serializa la carrera con el lock de la factura (el lock ES la barrera)", () => {
    expect(body).toContain("FOR UPDATE");
    expect(body).toContain("FROM public.invoices");
    expect(body).toContain("Factura inexistente");
  });

  it("compara Σamount + nuevo contra el ganado con la MISMA tolerancia del servicio (0,009)", () => {
    expect(body).toContain("coalesce(sum(amount), 0)");
    expect(body).toContain("WHERE invoice_id = NEW.invoice_id");
    expect(body).toContain("employee_id = NEW.employee_id");
    expect(body).toContain("- v_earned > 0.009");
    expect(body).toContain("RAISE EXCEPTION");
  });

  it("rechaza la fila que no trae el ganado: sin número no hay tope", () => {
    expect(body).toContain("IF v_earned IS NULL THEN");
  });

  it("BEFORE INSERT y una sola vez, y los pagos PARCIALES siguen siendo legales", () => {
    expect(sql).toContain("DROP TRIGGER IF EXISTS trg_commission_payouts_cap ON public.commission_payouts");
    expect(sql).toContain("BEFORE INSERT ON public.commission_payouts");
    expect(sql).toContain("FOR EACH ROW EXECUTE FUNCTION public.check_commission_payouts_cap()");
    expect(sql).not.toContain("BEFORE UPDATE");
    // El tope es acumulado, no una fila única: nada de UNIQUE(factura, empleado).
    expect(sql).not.toMatch(/^\s*CREATE UNIQUE INDEX/im);
    expect(sql).not.toMatch(/^\s*UNIQUE\s*\(/im);
    expect(sql).toContain("PARCIAL");
  });

  it("es idempotente y NUNCA borra, ni reescribe, ni crea algo que falle por filas viejas", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("DROP TRIGGER IF EXISTS");
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/^\s*TRUNCATE/m);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|SCHEMA)/im);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(sql).not.toMatch(/^\s*ALTER COLUMN/im);
  });

  it("explica el orden de los statements y por qué, y no se ejecutó", () => {
    expect(sql).toContain("ORDEN DE LOS STATEMENTS");
    const column = sql.indexOf("ADD COLUMN IF NOT EXISTS earned_immediate");
    const fn = sql.indexOf("CREATE OR REPLACE FUNCTION public.check_commission_payouts_cap");
    const trigger = sql.indexOf("CREATE TRIGGER trg_commission_payouts_cap");
    expect(column).toBeGreaterThan(-1);
    expect(column).toBeLessThan(fn);
    expect(fn).toBeLessThan(trigger);
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

/**
 * Estado del doble de Supabase. `vi.hoisted` lo iza junto con los `vi.mock`,
 * que en Vitest se ejecutan antes de los imports estáticos del archivo.
 */
const payoutStub = vi.hoisted(() => ({
  SEDE_ID: "11111111-1111-4111-8111-111111111111",
  EMPLOYEE_ID: "22222222-2222-4222-8222-222222222222",
  INVOICE_ID: "33333333-3333-4333-8333-333333333333",
  PRODUCT_ID: "44444444-4444-4444-8444-444444444444",
  SHIFT_ID: "55555555-5555-4555-8555-555555555555",
  METHOD_ID: "66666666-6666-4666-8666-666666666666",
  METHOD_CODE: "transferencia",
  /** Comisión fija del producto: el ganado inmediato que calcula el servicio. */
  COMMISSION_VALUE: 20000,
  /** Filas de `commission_payouts` (el estado que el doble suma de verdad). */
  payouts: [] as Array<Record<string, unknown>>,
  /** Payloads insertados: prueba que la app ENTREGA el ganado a la base. */
  inserts: [] as Array<Record<string, unknown>>,
  /** Auditorías escritas (solo el pago que quedó). */
  audits: [] as Array<Record<string, unknown>>,
  /** Consultas que el doble no sabe responder (debe quedar siempre vacío). */
  unexpectedQueries: [] as string[],
  /** Rechazos del tope emulado (control de que la guarda disparó). */
  capRejections: 0,
  /** Emulación del contrato de 034 (solo el control negativo la apaga). */
  enforceCap: true,
  /**
   * CL-5: emulación del índice único PARCIAL de 044
   * (`(invoice_id, employee_id, idempotency_key) WHERE idempotency_key IS NOT
   * NULL`). Un INSERT que lo repita responde 23505 y NO persiste la fila, que
   * es lo que hace Postgres cuando dos transacciones con la misma marca se
   * solapan entre el lookup y el INSERT.
   */
  enforceMarkIndex: true,
  /**
   * CL-5: saltea UNA vez el lookup por marca: arma la ventana de la carrera (la
   * otra transacción se confirmó entre el lookup y el INSERT).
   */
  skipMarkLookupOnce: false,
  /** Choques contra el índice único parcial de 044 (prueba de que el camino corre). */
  markClashes: 0,
  /** INSERT de `commission_payouts` INTENTADOS (sin marca de éxito): no vacuidad. */
  insertAttempts: 0,
  /** Filas de `commission_rules`: el estado que el `upsert` de reglas escribe. */
  rules: [] as Array<Record<string, unknown>>,
  /**
   * Cada `upsert` de `commission_rules` con el objetivo de conflicto que
   * mandó el servicio. Es la prueba de que el código infiere contra el índice
   * que existe, y el doble usa la lista para decidir si hay índice.
   */
  ruleUpserts: [] as Array<{ payload: Record<string, unknown>; onConflict: string }>,
  /**
   * Índices únicos REALES de `commission_rules`, como los que el catálogo los
   * tendría. Es la emulación de la INFERENCIA de `ON CONFLICT`: si el conjunto
   * de columnas del `onConflict` no coincide EXACTAMENTE con uno de ellos,
   * PostgreSQL responde 42P10 y no escribe. Los dos conviven entre la 075 y
   * la migración final: el de 016 (con sede) y el de la 075 (sin sede).
   */
  ruleIndexes: [
    "sede_id,item_type,item_id,employee_id",
    "item_type,item_id,employee_id",
  ] as string[],
  /** 42P10 emulados: el objetivo no lo satisface ningún índice (prueba de que se dispara). */
  ruleInferenceFailures: 0,
  /** 23505 emulados: el `id` enviado choca con otra fila y NO está en el objetivo. */
  ruleIdClashes: 0,
  /** `false` = el `onConflict` se pasa al objetivo viejo a propósito (control negativo). */
  forceOldConflictTarget: false,
  /** `false` = no hay turno abierto (la guarda que corre ANTES del lookup). */
  shiftOpen: true,
  /**
   * Estado de la factura que el doble devuelve. Regla del dueño: solo `Pagada`
   * habilita el pago inmediato, así que el camino del dinero usa `Pagada` (el
   * fixture anterior devolvía `Emitida` y ocultaba el hueco).
   */
  invoiceStatus: "Pagada" as string,
  /**
   * Estado que la factura pasa a tener DESPUÉS de la primera lectura: emula el
   * cambio de estado en vuelo entre la carga y la relectura previa al INSERT.
   * `null` = el estado no cambia.
   */
  invoiceStatusAfterFirstRead: null as string | null,
  /** Lecturas de `invoices` (prueba de la relectura previa al INSERT). */
  invoiceReads: 0,
  /**
   * CL-5: el TURNO que el doble devuelve. Existe para poder cambiar de turno
   * entre el intento y su reintento (la ventana que la 044 declara sin cerrar).
   */
  shiftId: "55555555-5555-4555-8555-555555555555",
  nextId: 0,
  /**
   * Barrera de lectura: cuando está armada, la consulta del pendiente no
   * resuelve hasta que lleguen `expected` lectores, y todos reciben la misma
   * foto tomada antes de liberar. Es lo que hace la base real: dos
   * transacciones que leen el mismo pendiente antes de que ninguna escriba.
   */
  gate: null as null | {
    arrived: number;
    snapshot: number;
    resolve: () => void;
    promise: Promise<void>;
    /** Se resuelve cuando la PRIMERA lectura congela la foto del pendiente. */
    firstArrival: Promise<void>;
    markFirst: () => void;
  },
}));

function resetPayoutStub(): void {
  payoutStub.payouts.length = 0;
  payoutStub.inserts.length = 0;
  payoutStub.audits.length = 0;
  payoutStub.unexpectedQueries.length = 0;
  payoutStub.capRejections = 0;
  payoutStub.enforceCap = true;
  payoutStub.enforceMarkIndex = true;
  payoutStub.skipMarkLookupOnce = false;
  payoutStub.markClashes = 0;
  payoutStub.insertAttempts = 0;
  payoutStub.rules.length = 0;
  payoutStub.ruleUpserts.length = 0;
  payoutStub.ruleIndexes = [
    "sede_id,item_type,item_id,employee_id",
    "item_type,item_id,employee_id",
  ];
  payoutStub.ruleInferenceFailures = 0;
  payoutStub.ruleIdClashes = 0;
  payoutStub.forceOldConflictTarget = false;
  payoutStub.shiftOpen = true;
  payoutStub.shiftId = "55555555-5555-4555-8555-555555555555";
  payoutStub.invoiceStatus = "Pagada";
  payoutStub.invoiceStatusAfterFirstRead = null;
  payoutStub.invoiceReads = 0;
  payoutStub.nextId = 0;
  payoutStub.gate = null;
}

/**
 * Barrera de lectura: la PRIMERA lectura del pendiente congela la foto y se
 * queda PARQUEADA ahí; las siguientes reciben ESA MISMA foto sin esperar. El
 * test libera a la primera cuando la segunda ya escribió: es la ventana
 * lectura-y-escritura del servicio (las dos decisiones sobre el mismo
 * pendiente) en el orden en que produce el defecto.
 */
function armPayoutGate(): void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markFirst = () => {};
  const firstArrival = new Promise<void>((resolve) => {
    markFirst = resolve;
  });
  payoutStub.gate = {
    arrived: 0,
    snapshot: 0,
    resolve: release,
    promise,
    firstArrival,
    markFirst,
  };
}

/** Libera la primera lectura: continúa con el pendiente que ya leyó. */
function releasePayoutGate(): void {
  payoutStub.gate?.resolve();
}

/** Fila del par (factura, empleado) ya pagada. `earned` = ganado de esa fila. */
function seedPayout(amount: number, earned: number | null = payoutStub.COMMISSION_VALUE): void {
  payoutStub.payouts.push({
    id: `seed-${(payoutStub.nextId += 1)}`,
    employee_id: payoutStub.EMPLOYEE_ID,
    invoice_id: payoutStub.INVOICE_ID,
    amount,
    earned_immediate: earned,
  });
}

/** Id con forma de uuid, para que el esquema del servicio lo acepte. */
function idRegla(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * Cliente Supabase falso y encadenable. Responde lo que el camino de
 * `payCommissionNow` consulta de verdad y emula el contrato de 034 en el
 * INSERT. Cualquier consulta que no sepa responder vuelve como error y se
 * registra en `unexpectedQueries`, para que el test falle a la vista en vez de
 * en silencio.
 */
function createPayoutStubClient(): unknown {
  const sumPair = (invoiceId: unknown, employeeId: unknown): number =>
    payoutStub.payouts
      .filter((row) => row.invoice_id === invoiceId && row.employee_id === employeeId)
      .reduce((acc, row) => acc + Number(row.amount), 0);

  const from = (table: string) => {
    let op = "select";
    let cols = "";
    let payload: Record<string, unknown> = {};
    let onConflict: string | undefined;
    const eqFilters: Record<string, unknown> = {};

    /**
     * ¿La fila dada tiene los MISMOS valores que la carga en el objetivo?
     *
     * Con la semántica de NULL de un índice UNIQUE: comparar una columna que
     * falta con otra que también falta da UNKNOWN, no TRUE, así que la fila NO
     * coincide. Es lo que hace que un objetivo que incluya una columna que la
     * escritura ya no manda deje de encontrar la fila anterior —el riesgo que
     * la 074 documenta para todos los índices que empezaban por `sede_id`—, y
     * es lo que este doble tiene que reproducir para que el control negativo de
     * abajo signifique algo.
     */
    const mismaPareja = (
      fila: Record<string, unknown>,
      objetivo: string,
      carga: Record<string, unknown>,
    ): boolean =>
      objetivo.split(",").every((columna) => {
        if (carga[columna] === undefined || fila[columna] === undefined) return false;
        return fila[columna] === carga[columna];
      });

    const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
      if (op === "upsert") {
        if (table !== "commission_rules") {
          payoutStub.unexpectedQueries.push(`${table}.upsert`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.upsert` } };
        }
        // El `onConflict` que manda el servicio, verbatim.
        const declarado = String(onConflict ?? "");
        const objetivo = payoutStub.forceOldConflictTarget
          ? "sede_id,item_type,item_id,employee_id"
          : declarado;
        payoutStub.ruleUpserts.push({ payload, onConflict: declarado });

        // (a) 42P10: la inferencia exige coincidencia EXACTA con un índice
        //     único. Sin esta rama el doble aceptaría cualquier conjunto de
        //     columnas y la prueba del `onConflict` no probaría nada.
        if (!payoutStub.ruleIndexes.includes(objetivo)) {
          payoutStub.ruleInferenceFailures += 1;
          return {
            data: null,
            error: {
              code: "42P10",
              message:
                "there is no unique or exclusion constraint matching the ON CONFLICT specification",
            },
          };
        }

        // (b) 23505 por la clave primaria `id`: el `ON CONFLICT` sólo resuelve
        //     los choques de SUS índices, así que un `id` que ya existe en otra
        //     fila (otra pareja ítem×empleado) no lo cubre y Postgres lo
        //     rechaza. Es el rechazo real que el servicio traduce a
        //     RULE_CONFLICT con el objetivo nuevo.
        const id = payload.id;
        if (
          id !== undefined &&
          payoutStub.rules.some(
            (row) => row.id === id && !mismaPareja(row, objetivo, payload),
          )
        ) {
          payoutStub.ruleIdClashes += 1;
          return {
            data: null,
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint commission_rules_pkey",
            },
          };
        }

        // (c) El objetivo decide cuál fila se actualiza: la que coincide en
        //     ESAS columnas. Es lo que hace que guardar dos veces la misma
        //     regla no cree una segunda fila.
        const existente = payoutStub.rules.find((row) => mismaPareja(row, objetivo, payload));
        if (existente) {
          Object.assign(existente, payload);
          return { data: { ...existente }, error: null };
        }
        const creada = {
          // Con FORMA de uuid: `commissionRuleSchema` valida el `id` que le
          // llega al servicio, así que un id de juguete haría fallar la
          // validación antes de llegar al `upsert`.
          id: idRegla(payoutStub.nextId += 1),
          is_active: true,
          ...payload,
        };
        payoutStub.rules.push(creada);
        return { data: { ...creada }, error: null };
      }
      if (op === "insert") {
        if (table === "audit_logs") {
          payoutStub.audits.push(payload);
          return { data: null, error: null };
        }
        if (table !== "commission_payouts") {
          payoutStub.unexpectedQueries.push(`${table}.insert`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.insert` } };
        }
        payoutStub.insertAttempts += 1;
        const earned = payload.earned_immediate;
        // Contrato de 034: el tope compara contra el ganado que la APP entrega.
        // Sin ese número la base no tiene contra qué comparar (el estado de
        // hoy: la columna no existe) y el INSERT entra.
        //
        // El orden importa: en Postgres el BEFORE ROW trigger del tope corre
        // ANTES de la comprobación del índice único, así que una carrera de dos
        // envíos con la misma marca que además se pasa del ganado muere con
        // P0001 (COMMISSION_OVERPAID) y no con 23505. El doble lo respeta.
        if (payoutStub.enforceCap && earned !== undefined && earned !== null) {
          if (
            sumPair(payload.invoice_id, payload.employee_id) +
              Number(payload.amount) -
              Number(earned) >
            0.009
          ) {
            payoutStub.capRejections += 1;
            return {
              data: null,
              error: {
                code: "P0001",
                message: "El pago supera la comisión ganada del par (factura, empleado)",
              },
            };
          }
        }
        // CL-5: el índice único PARCIAL de 044, aplicado como Postgres: una
        // fila con la MISMA marca en el MISMO par no entra, y el choque es
        // 23505 (la marca del servicio para releer a la ganadora). Las filas
        // históricas y las de marca NULL quedan fuera del índice.
        const mark = payload.idempotency_key;
        if (payoutStub.enforceMarkIndex && mark !== null && mark !== undefined) {
          const clash = payoutStub.payouts.some(
            (row) =>
              row.invoice_id === payload.invoice_id &&
              row.employee_id === payload.employee_id &&
              row.idempotency_key === mark,
          );
          if (clash) {
            payoutStub.markClashes += 1;
            return {
              data: null,
              error: {
                code: "23505",
                message:
                  "doble: índice único (invoice_id, employee_id, idempotency_key) violado en commission_payouts",
              },
            };
          }
        }
        payoutStub.inserts.push(payload);
        const inserted = {
          id: `payout-${(payoutStub.nextId += 1)}`,
          paid_at: "2026-01-01T00:00:00.000Z",
          ...payload,
        };
        payoutStub.payouts.push(inserted);
        return { data: inserted, error: null };
      }

      switch (table) {
        case "cash_shifts":
          // CL-5: la guarda de turno corre ANTES del lookup de la marca, así que
          // el doble tiene que poder decir "no hay turno abierto".
          if (!payoutStub.shiftOpen) return { data: null, error: null };
          return {
            data: {
              id: payoutStub.shiftId,
              cash_register_id: null,
              opened_by: "u-cajero",
              closed_by: null,
              opened_at: "2026-01-01T08:00:00.000Z",
              closed_at: null,
              opening_base: 500000,
              expected_cash: null,
              counted_cash: null,
              base_left: null,
              cash_withdrawn: null,
              base_difference: null,
              status: "abierto",
              observation: null,
            },
            error: null,
          };
        case "employees":
          return {
            data: cols.includes("payout_mode")
              ? { payout_mode: "normal" }
              : { pay_type: "fijo", commission_percent: null },
            error: null,
          };
        // El camino de `upsertCommissionRule` valida que el ítem exista ANTES de
        // escribir: eco del id consultado, como hace la base.
        case "products":
        case "services":
          return { data: { id: (eqFilters.id as string) ?? null }, error: null };
        case "invoices": {
          // Eco del id consultado. La prueba de multi-identidad usa una SEGUNDA
          // factura y el doble tiene que comportarse como la base (la fila que
          // el filtro pidió), no devolver siempre la primera. El estado es el
          // que la factura tiene de verdad: `Pagada` habilita el pago (regla
          // del dueño); `invoiceStatusAfterFirstRead` emula un cambio de estado
          // entre la carga y la relectura previa al INSERT.
          payoutStub.invoiceReads += 1;
          const status =
            payoutStub.invoiceStatusAfterFirstRead !== null && payoutStub.invoiceReads > 1
              ? payoutStub.invoiceStatusAfterFirstRead
              : payoutStub.invoiceStatus;
          return {
            data: { id: (eqFilters.id as string) ?? payoutStub.INVOICE_ID, status },
            error: null,
          };
        }
        case "invoice_items":
          return {
            data: [
              {
                item_type: "producto",
                product_id: payoutStub.PRODUCT_ID,
                service_id: null,
                qty: 1,
                unit_price: payoutStub.COMMISSION_VALUE,
                subtotal: payoutStub.COMMISSION_VALUE,
                no_commission: false,
                commission_value: payoutStub.COMMISSION_VALUE,
                commission_percent_override: null,
              },
            ],
            error: null,
          };
        case "commission_rules":
          return { data: [], error: null };
        case "commission_payouts": {
          // CL-5: el lookup por MARCA (el que la 044 hace posible). Se reconoce
          // por su filtro; devuelve la fila que la marca identifica dentro del
          // par, o nada. La ventana de la carrera se arma salteándolo UNA vez.
          if (eqFilters.idempotency_key !== undefined) {
            if (payoutStub.skipMarkLookupOnce) {
              payoutStub.skipMarkLookupOnce = false;
              return { data: null, error: null };
            }
            const winner = payoutStub.payouts.find(
              (row) =>
                row.invoice_id === eqFilters.invoice_id &&
                row.employee_id === eqFilters.employee_id &&
                row.idempotency_key === eqFilters.idempotency_key,
            );
            return { data: winner ?? null, error: null };
          }
          const gate = payoutStub.gate;
          if (!gate) {
            return {
              data: [{ amount: sumPair(eqFilters.invoice_id, eqFilters.employee_id) }],
              error: null,
            };
          }
          gate.arrived += 1;
          if (gate.arrived === 1) {
            // Foto CONGELADA antes de parquearse: es el valor con el que este
            // pago decide. La segunda lectura recibe la misma foto.
            gate.snapshot = sumPair(eqFilters.invoice_id, eqFilters.employee_id);
            gate.markFirst();
            await gate.promise;
          }
          return { data: [{ amount: gate.snapshot }], error: null };
        }
        default:
          payoutStub.unexpectedQueries.push(`${table}.${op}`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.${op}` } };
      }
    };

    const query: Record<string, unknown> = {
      select: (value?: string) => {
        cols = String(value ?? "");
        return query;
      },
      insert: (value: Record<string, unknown>) => {
        op = "insert";
        payload = value;
        return query;
      },
      upsert: (value: Record<string, unknown>, options?: { onConflict?: string }) => {
        op = "upsert";
        payload = value;
        onConflict = options?.onConflict;
        return query;
      },
      eq: (column: string, value: unknown) => {
        eqFilters[column] = value;
        return query;
      },
      order: () => query,
      limit: () => query,
      single: () => resolve(),
      maybeSingle: () => resolve(),
      // `await` directo sobre la cadena resuelve al objeto de respuesta, igual
      // que el PostgREST real.
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        resolve().then(onFulfilled, onRejected),
    };
    return query;
  };

  return { from };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createPayoutStubClient(),
}));

vi.mock("@/src/features/admin/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/admin/service")>();
  const methods = [
    {
      id: payoutStub.METHOD_ID,
      code: payoutStub.METHOD_CODE,
      name: "Transferencia",
      is_active: true,
      arqueable: true,
      fee_percent: 0,
    },
  ] as Awaited<ReturnType<typeof actual.listPaymentMethods>>;
  return { ...actual, listPaymentMethods: async () => methods };
});

describe("commissions: el pago inmediato no se puede pagar dos veces (034)", () => {
  const actor = { userId: "u-cajero" };
  // CL-5: marca del INTENTO del primer envío. Desde la 044 es obligatoria, así
  // que TODA llamada de esta prueba la lleva; la segunda llamada de
  // `paySamePendingTwice` acuña la SUYA, porque dos envíos con la MISMA marca
  // son, por definición, UNA sola operación (ese es el punto de la 044) y estas
  // pruebas hablan de DOS pagos.
  const MARK = "1e5b7c4a-8d29-4f36-a0b1-c7d3e9f2a5b8";
  const SECOND_MARK = "c6f2a809-3b14-4e57-92d8-0a4b7c1e6f93";
  // Digital a propósito: aísla el tope de la COMISIÓN del tope de salidas en
  // efectivo del turno, que ya tiene su propia prueba (cash.test.ts). El tope
  // de la comisión no depende del método de pago.
  const input = {
    invoice_id: payoutStub.INVOICE_ID,
    employee_id: payoutStub.EMPLOYEE_ID,
    method_code: payoutStub.METHOD_CODE,
    idempotency_key: MARK,
  };

  beforeEach(() => {
    resetPayoutStub();
  });

  /**
   * Dos pagos del mismo par con la ventana de carrera REAL del servicio: la
   * primera lectura del pendiente queda congelada (y parqueada ahí), la segunda
   * lectura ve ESA MISMA foto y escribe, y recién entonces la primera continúa
   * y escribe con su decisión vieja. Es exactamente la lectura-y-escritura sin
   * lock del hallazgo: dos transacciones decidieron sobre el mismo pendiente.
   *
   * La segunda llamada arranca después de la primera a propósito: en
   * producción las dos llegan en el mismo instante (lo que importa es que las
   * dos LECTURAS precedan a las dos ESCRITURAS, y acá queda garantizado). Una
   * prueba de vitest no puede emular dos conexiones simultáneas de Postgres, y
   * el empate real de dos `import()` dinámicos del servicio en el mismo tick
   * no es estable en este entorno.
   *
   * CL-5: la segunda llamada lleva OTRA marca, porque la marca identifica el
   * INTENTO y esta prueba trata de dos pagos distintos que decidieron sobre el
   * mismo pendiente. Con la misma marca, la segunda sería la repetición de la
   * primera (una sola operación) y la prueba dejaría de hablar de lo que dice
   * hablar. Las aserciones de los tres casos que la usan no cambiaron.
   */
  async function paySamePendingTwice(
    amount: number,
    secondMark = SECOND_MARK,
  ): Promise<PromiseSettledResult<unknown>[]> {
    armPayoutGate();
    const parked = payCommissionNow({ ...input, amount }, actor);
    await payoutStub.gate?.firstArrival;
    const later = payCommissionNow(
      { ...input, idempotency_key: secondMark, amount },
      actor,
    );
    // La segunda se completa (escribe) ANTES de liberar a la primera.
    await later.catch(() => undefined);
    releasePayoutGate();
    return Promise.allSettled([parked, later]);
  }

  it("dos pagos que decidieron sobre el mismo pendiente: la base rechaza el segundo", async () => {
    const settled = await paySamePendingTwice(payoutStub.COMMISSION_VALUE);
    const ok = settled.filter((entry) => entry.status === "fulfilled");
    const failed = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(payoutStub.unexpectedQueries).toEqual([]);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(CommissionError);
    // COMMISSION_OVERPAID y no NOTHING_PENDING: la app leyó un pendiente
    // COMPLETO (su lectura quedó vieja, por eso pasó su propio chequeo) y fue
    // la base la que frenó. Con las lecturas serializadas el código sería otro.
    expect(failed[0]?.reason).toMatchObject({ code: "COMMISSION_OVERPAID", status: 422 });
    // Una sola fila: el par pagó 20000 de 20000, nunca 40000.
    expect(payoutStub.payouts).toHaveLength(1);
    expect(Number(payoutStub.payouts[0]?.amount)).toBe(payoutStub.COMMISSION_VALUE);
    expect(payoutStub.capRejections).toBe(1);
    expect(payoutStub.inserts).toHaveLength(1);
    expect(payoutStub.audits).toHaveLength(1);
  });

  it("la app ENTREGA el ganado en la fila: sin ese número la base no puede aplicar el tope", async () => {
    await payCommissionNow({ ...input, amount: 5000 }, actor);

    expect(payoutStub.inserts).toHaveLength(1);
    expect(payoutStub.inserts[0]).toMatchObject({
      earned_immediate: payoutStub.COMMISSION_VALUE,
      amount: 5000,
      invoice_id: payoutStub.INVOICE_ID,
      employee_id: payoutStub.EMPLOYEE_ID,
    });
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("un pago PARCIAL sigue funcionando (el tope es acumulado, no una fila única)", async () => {
    seedPayout(5000);
    const row = await payCommissionNow({ ...input, amount: 8000 }, actor);

    expect(row.amount).toBe(8000);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.payouts).toHaveLength(2);
    // 5000 + 8000 = 13000 ≤ 20000 ganados.
    expect(payoutStub.payouts.reduce((acc, entry) => acc + Number(entry.amount), 0)).toBe(13000);
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("un pago IGUAL al pendiente entra exacto (borde, sin rechazo por un centavo)", async () => {
    seedPayout(5000);
    const row = await payCommissionNow({ ...input, amount: 15000 }, actor);

    expect(row.amount).toBe(15000);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.payouts.reduce((acc, entry) => acc + Number(entry.amount), 0)).toBe(
      payoutStub.COMMISSION_VALUE,
    );
  });

  it("un pago genuinamente mayor al pendiente se rechaza con el código específico y sin escribir", async () => {
    seedPayout(5000);
    const failure: unknown = await payCommissionNow({ ...input, amount: 16000 }, actor).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "COMMISSION_OVERPAID", status: 422 });
    // Rechazado ANTES de tocar la base: no hay fila nueva ni rechazo del tope.
    expect(payoutStub.inserts).toEqual([]);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.payouts).toHaveLength(1);
  });

  it("control negativo: dos parciales sobre el mismo pendiente SÍ entran (el tope no frena lo legal)", async () => {
    const settled = await paySamePendingTwice(5000);

    // Si el tope fuera "rechazar el segundo INSERT", esta prueba falla: el
    // tope es acumulado y 5000 + 5000 ≤ 20000 es legal.
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.payouts).toHaveLength(2);
    expect(payoutStub.payouts.reduce((acc, entry) => acc + Number(entry.amount), 0)).toBe(10000);
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("control negativo: con el tope apagado el mismo par se paga DOS veces (el tope es lo que frena)", async () => {
    // Emula la base de hoy (sin la columna y sin trigger): es la foto del
    // hallazgo, y la prueba de que la aserción de arriba es sensible a la
    // guarda y no a otra cosa.
    payoutStub.enforceCap = false;
    const settled = await paySamePendingTwice(payoutStub.COMMISSION_VALUE);

    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.payouts).toHaveLength(2);
    expect(payoutStub.payouts.reduce((acc, entry) => acc + Number(entry.amount), 0)).toBe(
      payoutStub.COMMISSION_VALUE * 2,
    );
  });
});

// ---- CL-5: el pago inmediato de comisión repetido no paga la comisión dos veces ---

/**
 * CL-5: la puerta que la 034 NO cierra, y la CUARTA de la misma familia (041
 * emisión, 042 abono y cobro dividido, 043 caja). El pago PARCIAL es legal y
 * deliberado (016/034: nada de UNIQUE(factura, empleado), el tope es
 * ACUMULADO), y el tope de la base usa la MISMA aritmética que la validación
 * del servicio (`Σ + nuevo − ganado > 0,009`), así que con `2 × monto ≤
 * pendiente` las dos barreras pasan y un reintento paga la comisión DOS veces,
 * sin que nada lo recupere después: el tope sólo acota la suma al ganado, no
 * distingue "el mismo envío" de "un segundo pago".
 *
 * Es la única de las tres de esta unidad alcanzable desde una pantalla: el
 * modal de pago inmediato al cobrar la factura (`invoices-client.tsx`).
 *
 * LA CLAVE: (`invoice_id`, `employee_id`, `idempotency_key`). El registro de
 * esta operación es el PAR (factura, empleado): es lo que el modal identifica
 * (paga la comisión de un empleado en UNA factura), es la clave del tope de 034
 * (`Σ amount` por factura y empleado) y es la clave de `immediatePaidTotal`. La
 * sede no entra en la clave porque no agrega identidad: la factura pertenece a
 * una sola sede y el servicio la resuelve dentro de la del actor (una factura
 * ajena es NOT_FOUND antes del lookup), así que el lookup no puede devolver el
 * pago de otra sede. La misma marca con otra factura —o con otro empleado— es
 * OTRA operación, y hay una prueba por cada eje.
 *
 * LA ARRUGA DE 042 ("la marca en la primera porción") NO APLICA ACÁ: este
 * camino inserta UNA sola fila (una sentencia de un objeto), así que la marca
 * vive en esa única fila, no hay porciones hermanas que enumerar y el índice
 * nunca puede rechazar una operación legítima.
 */
describe("commissions: CL-5 el pago inmediato reintentado no paga la comisión dos veces", () => {
  const actor = { userId: "u-cajero" };
  const MARK = "7c9e1f6a-2b48-4d13-9a75-3e6b0d8c4a21";
  const OTHER_MARK = "b4a0d3e7-5f62-4c18-8d90-2a7e6f1b3c58";
  const INVOICE_2 = "77777777-7777-4777-8777-777777777777";
  const EMPLOYEE_2 = "88888888-8888-4888-8888-888888888888";
  const input = {
    invoice_id: payoutStub.INVOICE_ID,
    employee_id: payoutStub.EMPLOYEE_ID,
    method_code: payoutStub.METHOD_CODE,
    idempotency_key: MARK,
  };
  const totalPending = (invoiceId: string, employeeId: string): number =>
    payoutStub.payouts
      .filter((row) => row.invoice_id === invoiceId && row.employee_id === employeeId)
      .reduce((acc, row) => acc + Number(row.amount), 0);

  beforeEach(() => {
    resetPayoutStub();
  });
  afterEach(() => {
    resetPayoutStub();
  });

  it("RED: hoy el mismo envío pagado dos veces paga la comisión DOS veces (2 × monto ≤ pendiente)", async () => {
    const first = await payCommissionNow({ ...input, amount: 5000 }, actor);
    const second = await payCommissionNow({ ...input, amount: 5000 }, actor);

    // HOY: DOS filas de 5.000 (10.000 pagados de una comisión de 20.000) y el
    // tope de 034 no lo ve: 5.000 + 5.000 ≤ 20.000. Con la marca de 044: UNA.
    expect(payoutStub.payouts).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(payoutStub.payouts.reduce((acc, row) => acc + Number(row.amount), 0)).toBe(5000);
    expect(payoutStub.capRejections).toBe(0);
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("la repetición devuelve el MISMO resultado escribiendo nada (no-op exitoso)", async () => {
    const first = await payCommissionNow({ ...input, amount: 8000 }, actor);
    const repeat = await payCommissionNow({ ...input, amount: 8000 }, actor);

    expect(repeat.id).toBe(first.id);
    expect(repeat).toEqual(first);
    // El reintento ni siquiera INTENTÓ escribir: lo reconoció antes.
    expect(payoutStub.insertAttempts).toBe(1);
    expect(payoutStub.inserts).toHaveLength(1);
    expect(payoutStub.payouts).toHaveLength(1);
    // Y no deja rastro doble: una sola auditoría, la del pago que ocurrió.
    expect(payoutStub.audits).toHaveLength(1);
    expect(payoutStub.markClashes).toBe(0);
  });

  it("la repetición de un pago que AGOTÓ el pendiente se reconoce (no muere con NOTHING_PENDING)", async () => {
    // Por qué el lookup va ANTES de la aritmética del pendiente: el tope del
    // servicio y el de la base son la MISMA aritmética, así que un envío que
    // llenó el pendiente y se reintenta encontraba "ya fue pagada" —un error
    // por una operación que SÍ se registró— en vez de su propio resultado.
    const first = await payCommissionNow(
      { ...input, amount: payoutStub.COMMISSION_VALUE },
      actor,
    );
    const repeat = await payCommissionNow(
      { ...input, amount: payoutStub.COMMISSION_VALUE },
      actor,
    );

    expect(repeat.id).toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(1);
    expect(payoutStub.insertAttempts).toBe(1);
    expect(totalPending(input.invoice_id, input.employee_id)).toBe(payoutStub.COMMISSION_VALUE);
  });

  it("control de no-extralimitación: dos marcas distintas son DOS pagos (el pago parcial sigue siendo legal)", async () => {
    // Un "un solo pago por par" global pasaría la prueba de arriba y estaría
    // mal: pagar en partes es el caso normal y deliberado de 016/034.
    const first = await payCommissionNow({ ...input, amount: 5000 }, actor);
    const second = await payCommissionNow(
      { ...input, idempotency_key: OTHER_MARK, amount: 5000 },
      actor,
    );

    expect(second.id).not.toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(2);
    expect(totalPending(input.invoice_id, input.employee_id)).toBe(10000);
    expect(payoutStub.capRejections).toBe(0);
    // Y repetir la SEGUNDA marca devuelve la SEGUNDA operación, no la primera.
    const repeat = await payCommissionNow(
      { ...input, idempotency_key: OTHER_MARK, amount: 5000 },
      actor,
    );
    expect(repeat.id).toBe(second.id);
    expect(payoutStub.payouts).toHaveLength(2);
  });

  it("la carrera (misma marca entre el lookup y el INSERT) relee a la ganadora", async () => {
    const first = await payCommissionNow({ ...input, amount: 5000 }, actor);
    // La otra transacción se confirmó entre el lookup y el INSERT: el doble
    // saltea el lookup UNA vez para armar exactamente esa ventana.
    payoutStub.skipMarkLookupOnce = true;

    const second = await payCommissionNow({ ...input, amount: 5000 }, actor);

    // El reintento sigue siendo un no-op: devuelve el pago de la ganadora.
    expect(second.id).toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(1);
    // No vacuidad: el INSERT de la segunda SÍ se intentó y el índice lo frenó
    // (dos intentos, un choque, una fila). Si el lookup la hubiera visto, el
    // camino del 23505 no existiría.
    expect(payoutStub.insertAttempts).toBe(2);
    expect(payoutStub.markClashes).toBe(1);
    expect(payoutStub.inserts).toHaveLength(1);
  });

  it("una marca faltante o mal formada se rechaza con CERO escrituras", async () => {
    // Decisión explícita, igual que en las otras cuatro puertas del dinero: la
    // marca es OBLIGATORIA. Un envío sin marca no se puede reconocer como
    // repetición, así que aceptarlo es reabrir el defecto para ESE llamador. El
    // rechazo es ruidoso (VALIDATION) y no escribe nada.
    const withoutMark: unknown = await payCommissionNow(
      {
        invoice_id: input.invoice_id,
        employee_id: input.employee_id,
        method_code: input.method_code,
        amount: 5000,
      },
      actor,
    ).catch((error: unknown) => error);
    const malformed: unknown = await payCommissionNow(
      { ...input, idempotency_key: "no-es-un-uuid", amount: 5000 },
      actor,
    ).catch((error: unknown) => error);

    expect(withoutMark).toBeInstanceOf(CommissionError);
    expect(withoutMark).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(malformed).toBeInstanceOf(CommissionError);
    expect(malformed).toMatchObject({ code: "VALIDATION", status: 400 });
    // La validación corre ANTES de cualquier lectura y de cualquier escritura.
    expect(payoutStub.insertAttempts).toBe(0);
    expect(payoutStub.payouts).toHaveLength(0);
    expect(payoutStub.unexpectedQueries).toEqual([]);
    // La misma regla en el esquema puro (y en el CHECK de forma de la 044): las
    // dos puertas del dinero validan con `idempotencyKeySchema`.
    expect(
      commissionPayoutSchema.safeParse({
        invoice_id: input.invoice_id,
        employee_id: input.employee_id,
        amount: 5000,
      }).success,
    ).toBe(false);
    expect(
      commissionPayoutSchema.safeParse({ ...input, idempotency_key: "x", amount: 5000 }).success,
    ).toBe(false);
    expect(commissionPayoutSchema.safeParse({ ...input, amount: 5000 }).success).toBe(true);
  });

  it("multi-identidad: la misma marca en OTRA factura es OTRA operación", async () => {
    const first = await payCommissionNow({ ...input, amount: 4000 }, actor);
    const other = await payCommissionNow({ ...input, invoice_id: INVOICE_2, amount: 4000 }, actor);

    expect(other.id).not.toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(2);
    // Cada una reconoce la SUYA: la marca se resuelve dentro del par.
    const repeatSecond = await payCommissionNow(
      { ...input, invoice_id: INVOICE_2, amount: 4000 },
      actor,
    );
    expect(repeatSecond.id).toBe(other.id);
    expect(payoutStub.payouts).toHaveLength(2);
    expect(totalPending(INVOICE_2, input.employee_id)).toBe(4000);
  });

  it("multi-identidad: la misma marca para OTRO empleado es OTRA operación", async () => {
    const first = await payCommissionNow({ ...input, amount: 4000 }, actor);
    const other = await payCommissionNow({ ...input, employee_id: EMPLOYEE_2, amount: 4000 }, actor);

    expect(other.id).not.toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(2);
    const repeatOther = await payCommissionNow(
      { ...input, employee_id: EMPLOYEE_2, amount: 4000 },
      actor,
    );
    expect(repeatOther.id).toBe(other.id);
    expect(payoutStub.payouts).toHaveLength(2);
    expect(totalPending(input.invoice_id, EMPLOYEE_2)).toBe(4000);
  });

  it("la clave NO mira el turno: un reintento que llega con OTRO turno abierto se reconoce igual", async () => {
    // La ventana que la 043 sí declara (su clave incluye el turno) acá no
    // existe: la operación sale de la CAJA pero su identidad es el par, así que
    // cambiar de turno entre el intento y su reintento no la vuelve invisible.
    const first = await payCommissionNow({ ...input, amount: 3000 }, actor);
    payoutStub.shiftId = "99999999-9999-4999-8999-999999999999";

    const repeat = await payCommissionNow({ ...input, amount: 3000 }, actor);

    expect(repeat.id).toBe(first.id);
    expect(payoutStub.payouts).toHaveLength(1);
  });

  it("limitación declarada: un reintento que llega SIN turno abierto se rechaza, no se reconoce", async () => {
    // Misma familia que la limitación de CL-3/CL-4: las guardas de estado
    // corren ANTES del lookup (para que una factura anulada, un turno cerrado o
    // un método inactivo se reporten como tales, repetido o no). El caso real
    // del reintento —doble clic, o el navegador tras cortarse la red— ocurre
    // segundos después, con el mismo turno abierto y el mismo método activo, y
    // ahí la marca SÍ reconoce. No se pierde plata: el reintento se rechaza
    // ruidosamente y, con el turno reabierto, la misma marca sigue reconociendo.
    const first = await payCommissionNow({ ...input, amount: 3000 }, actor);
    payoutStub.shiftOpen = false;

    const failure: unknown = await payCommissionNow({ ...input, amount: 3000 }, actor).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "NO_OPEN_SHIFT", status: 409 });
    expect(payoutStub.payouts).toHaveLength(1);
    expect(first.id).toBe(payoutStub.payouts[0]?.id);
  });

  it("control negativo: la marca no cambia la aritmética del dinero", async () => {
    // La primera operación entra; la segunda (marca NUEVA: otro intento) supera
    // el pendiente y se rechaza EXACTAMENTE como antes. Con marca o sin ella,
    // el redondeo a peso entero y el tope son los mismos.
    seedPayout(5000);
    const failure: unknown = await payCommissionNow(
      { ...input, idempotency_key: OTHER_MARK, amount: 16000 },
      actor,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "COMMISSION_OVERPAID", status: 422 });
    expect(payoutStub.payouts).toHaveLength(1);
    expect(payoutStub.insertAttempts).toBe(0);
  });

  it("la migración 044 deja la marca con un índice único PARCIAL y no reescribe filas", () => {
    const raw = readFileSync(
      join(process.cwd(), "supabase", "schema-history", "044_remaining_payment_idempotency.sql"),
      "utf8",
    );
    // La prosa explica lo que el archivo NO hace y nombra esas sentencias; las
    // aserciones de abajo miran el SQL, sin los comentarios.
    const sql = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    // La columna nace NULL: las filas históricas no tienen marca, sin backfill.
    expect(sql).toContain("ALTER TABLE public.commission_payouts");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS idempotency_key");
    // La barrera final: a lo sumo UNA operación por marca y PAR (factura, empleado).
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_payouts_pair_idempotency_key",
    );
    expect(sql).toContain(
      "ON public.commission_payouts (invoice_id, employee_id, idempotency_key)",
    );
    // PARCIAL: las filas históricas (marca NULL) quedan fuera del índice.
    expect(sql).toMatch(/WHERE idempotency_key IS NOT NULL/);
    // La guarda de forma (el patrón de 038/041/042/043).
    expect(sql).toContain("commission_payouts_idempotency_key_shape");
    // No borra ni reescribe filas: no hay backfill que inventar.
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/UPDATE\s+public\./i);
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
  });
});

// ------------- pago inmediato solo de facturas PAGADAS (regla del dueño) ---
//
// Decisión del dueño (2026-10-01): la comisión de una factura existe cuando la
// factura está Pagada. Pagada, el destino de la comisión ya quedó definido —se
// pagó de inmediato, o se dejó para la nómina—; con una factura Emitida todavía
// no hay comisión en juego. La UI ya gatea el modal, pero la autoridad es el
// SERVIDOR: `Emitida` se rechaza aunque se llame a la acción/servicio directo, y
// Anulada se sigue rechazando. Antes el doble devolvía `Emitida` y las pruebas
// del pago pasaban: esa era la prueba de que el servidor no exigía el estado.
describe("commissions: el pago inmediato exige factura Pagada (regla del dueño)", () => {
  const actor = { userId: "u-cajero" };
  const MARK = "3d7f0a52-9c14-4e68-b2f1-8a5c6e0d7b43";
  const input = {
    invoice_id: payoutStub.INVOICE_ID,
    employee_id: payoutStub.EMPLOYEE_ID,
    method_code: payoutStub.METHOD_CODE,
    idempotency_key: MARK,
  };

  beforeEach(() => {
    resetPayoutStub();
  });
  afterEach(() => {
    resetPayoutStub();
  });

  it("una factura Pagada paga (el fixture del camino del dinero es un pago real)", async () => {
    // El fixture anterior era `Emitida`; este es el estado que producción
    // permite pagar, así que las pruebas de dinero corren sobre un pago válido.
    expect(payoutStub.invoiceStatus).toBe("Pagada");
    const row = await payCommissionNow({ ...input, amount: 5000 }, actor);

    expect(row.amount).toBe(5000);
    expect(payoutStub.payouts).toHaveLength(1);
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("el rastro del pago dice QUÉ se pagó, sobre QUÉ fila y POR QUIÉ (sin sede)", async () => {
    const row = await payCommissionNow({ ...input, amount: 5000 }, actor);

    // El pago es plata que sale de la sede: el rastro tiene que poder leerse
    // después sin depender de la fila, así que nombra acción, entidad, la fila
    // y el responsable.
    expect(payoutStub.audits).toHaveLength(1);
    expect(payoutStub.audits[0]).toMatchObject({
      user_id: actor.userId,
      action: "payroll.commission_paid",
      entity: "commission_payouts",
      entity_id: row.id,
      metadata: {
        employee_id: payoutStub.EMPLOYEE_ID,
        invoice_id: payoutStub.INVOICE_ID,
        cash_shift_id: payoutStub.SHIFT_ID,
        method_code: payoutStub.METHOD_CODE,
        amount: 5000,
        earned_immediate: payoutStub.COMMISSION_VALUE,
      },
    });
    // La instalación es una: la sede ya no viaja como columna del rastro.
    expect(payoutStub.audits[0]).not.toHaveProperty("sede_id");
  });

  it("una factura `Emitida` se rechaza y NO inserta ninguna fila", async () => {
    payoutStub.invoiceStatus = "Emitida";
    const failure: unknown = await payCommissionNow({ ...input, amount: 5000 }, actor).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({
      code: "INVOICE_NOT_PAID",
      message: "La factura debe estar Pagada para pagar la comisión.",
      status: 422,
    });
    // La guarda corre ANTES de cualquier escritura: ni fila, ni intento, ni traza.
    expect(payoutStub.insertAttempts).toBe(0);
    expect(payoutStub.payouts).toHaveLength(0);
    expect(payoutStub.audits).toHaveLength(0);
    expect(payoutStub.unexpectedQueries).toEqual([]);
  });

  it("una factura anulada se sigue rechazando con su código propio", async () => {
    payoutStub.invoiceStatus = "Anulada";
    const failure: unknown = await payCommissionNow({ ...input, amount: 5000 }, actor).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "INVOICE_ANNULLED", status: 422 });
    expect(payoutStub.insertAttempts).toBe(0);
    expect(payoutStub.payouts).toHaveLength(0);
  });

  it("defensa en profundidad: si el estado deja de ser Pagada entre la carga y el INSERT, no hay pago", async () => {
    // La relectura previa al INSERT es una SEGUNDA barrera independiente de la
    // carga: emula la anulación en vuelo entre las dos lecturas (la ventana que
    // una sola lectura no cubre). El pago NO entra.
    payoutStub.invoiceStatusAfterFirstRead = "Anulada";
    const failure: unknown = await payCommissionNow({ ...input, amount: 5000 }, actor).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "INVOICE_ANNULLED", status: 422 });
    // Dos lecturas de la factura: la carga y la relectura; cero escrituras.
    expect(payoutStub.invoiceReads).toBe(2);
    expect(payoutStub.insertAttempts).toBe(0);
    expect(payoutStub.payouts).toHaveLength(0);
  });

  it("control negativo: la guarda NO es `≠ Anulada`, exige `Pagada` (el defecto no vuelve)", async () => {
    // La versión defectuosa aceptaba cualquier estado distinto de Anulada, así
    // que `Emitida` pasaba. Se emula esa función y se exige que la guarda real
    // discrepe: si alguien la relaja a `!== "Anulada"`, esta prueba se cae.
    const defectuosa = (status: string): boolean => status !== "Anulada";
    expect(defectuosa("Emitida")).toBe(true);
    expect(canPayCommissionImmediately("Emitida")).toBe(false);
    expect(canPayCommissionImmediately("Pagada")).toBe(true);
    expect(() =>
      expect(canPayCommissionImmediately("Emitida")).toBe(defectuosa("Emitida")),
    ).toThrow();

    // Y la conducta completa: `Emitida` no entra, `Pagada` sí.
    payoutStub.invoiceStatus = "Emitida";
    const refused: unknown = await payCommissionNow({ ...input, amount: 5000 }, actor).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CommissionError);
    expect(payoutStub.payouts).toHaveLength(0);

    payoutStub.invoiceStatus = "Pagada";
    await payCommissionNow({ ...input, amount: 5000 }, actor);
    expect(payoutStub.payouts).toHaveLength(1);
  });
});

// ===================================================================== ---
// 075 — la clave de la regla de comisión pasa a ser de INSTALACIÓN
// ===================================================================== ---
//
// La 016 dejó `uq_commission_rule (sede_id, item_type, item_id, employee_id)` y
// la 074 explica por qué no lo pudo quitar: el `upsert` del servicio infiere su
// `ON CONFLICT` contra ese conjunto y la inferencia exige coincidencia EXACTA
// con las columnas de un índice único. Por eso el orden de esta serie es índice
// primero y código después, y la 075 hace la primera mitad (el índice nuevo, sin
// quitar el viejo) y esta unidad la segunda (el `onConflict` nuevo).
//
// El doble emula el CONTRATO de la base en el `upsert`, que es lo que hace que
// estas pruebas no sean de texto: si el objetivo no lo satisface ningún índice
// devuelve 42P10 sin escribir, y el choque de la clave primaria `id` —que el
// `ON CONFLICT` NO cubre porque no está en sus columnas— devuelve 23505, que es
// el rechazo que el servicio traduce a RULE_CONFLICT.

describe("commissions: el upsert de reglas infiere contra el índice de la instalación (075)", () => {
  const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const base = {
    item_type: "producto",
    item_id: ITEM_A,
    employee_id: payoutStub.EMPLOYEE_ID,
    percent: 10,
  } as const;

  beforeEach(() => {
    resetPayoutStub();
  });

  it("el objetivo de conflicto es el NUEVO (sin sede) y la escritura entra", async () => {
    const regla = await upsertCommissionRule({ ...base });

    // Lo que el servicio MANDÓ, verbatim: el conjunto de tres columnas que
    // infiere `uq_commission_rule_install_key` (075).
    expect(payoutStub.ruleUpserts).toHaveLength(1);
    expect(payoutStub.ruleUpserts[0].onConflict).toBe("item_type,item_id,employee_id");
    // Y el doble no encontró índice que lo satisfaciera: el 42P10 no se
    // disparó, o sea que la inferencia se resolvió contra un índice real.
    expect(payoutStub.ruleInferenceFailures).toBe(0);
    expect(regla).toMatchObject({
      item_type: "producto",
      item_id: ITEM_A,
      employee_id: payoutStub.EMPLOYEE_ID,
      percent: 10,
    });
    // Y la escritura NO manda la columna: es lo que hace que el conjunto de
    // tres columnas baste para decidir el conflicto.
    expect(payoutStub.ruleUpserts[0].payload).not.toHaveProperty("sede_id");
    expect(payoutStub.rules).toHaveLength(1);
  });

  it("el mismo (ítem × empleado) dos veces NO crea una segunda fila", async () => {
    const primera = await upsertCommissionRule({ ...base });
    const segunda = await upsertCommissionRule({ ...base, percent: 25 });

    // El `ON CONFLICT` del objetivo nuevo resuelve la segunda contra la primera:
    // misma fila, id estable, porcentaje actualizado.
    expect(segunda.id).toBe(primera.id);
    expect(segunda.percent).toBe(25);
    expect(payoutStub.rules).toHaveLength(1);
    expect(payoutStub.rules[0].percent).toBe(25);
  });

  it("la sede ya NO es parte de la clave NI de la escritura: la misma pareja es SIEMPRE la misma regla", async () => {
    const primera = await upsertCommissionRule({ ...base });
    const segunda = await upsertCommissionRule({ ...base, amount: 5000, percent: null });

    expect(segunda.id).toBe(primera.id);
    expect(payoutStub.rules).toHaveLength(1);
    // Ni el actor ni el cuerpo nombran ya la sede: no hay segunda fila posible.
    expect(payoutStub.ruleUpserts.every((entrada) => !("sede_id" in entrada.payload))).toBe(true);
  });

  it("control negativo: con el objetivo VIEJO la misma pareja serían DOS filas", async () => {
    // El doble NO es un archivador: decide por el objetivo. Con el conjunto de
    // cuatro columnas (el de 016) la fila no coincide y entra como una regla
    // más. Si esta prueba pasara con una sola fila, el doble no distinguiría los
    // objetivos y las pruebas de arriba no probarían nada.
    payoutStub.forceOldConflictTarget = true;
    await upsertCommissionRule({ ...base });
    await upsertCommissionRule({ ...base, amount: 5000, percent: null });

    expect(payoutStub.rules).toHaveLength(2);
    expect(payoutStub.ruleInferenceFailures).toBe(0);
  });

  it("el esquema sin el índice de la 075 NO acepta el objetivo nuevo: 42P10 y cero filas", async () => {
    // El orden de la serie, comprobado por el otro lado: una base en estado 074
    // (con el índice viejo y sin el nuevo) NO tiene contra qué inferir el
    // conjunto de tres columnas. Por eso el índice va antes que el código.
    payoutStub.ruleIndexes = ["sede_id,item_type,item_id,employee_id"];
    const failure: unknown = await upsertCommissionRule({ ...base }).catch(
      (error: unknown) => error,
    );

    expect(payoutStub.ruleInferenceFailures).toBe(1);
    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(payoutStub.rules).toHaveLength(0);
  });

  it("un DUPLICADO real se sigue rechazando con el objetivo nuevo: el `id` de otra regla da 23505", async () => {
    // Con el objetivo de tres columnas, `ON CONFLICT` sólo resuelve los choques
    // de SUS columnas. Un `id` que ya existe en la fila de OTRA pareja
    // (ítem×empleado) choca contra la clave primaria, que no está en el
    // objetivo, y PostgreSQL responde 23505: cambiar el conjunto del `onConflict`
    // no debilitó la garantía de «una regla por ítem×empleado».
    const existente = await upsertCommissionRule({ ...base, percent: 10 });
    const failure: unknown = await upsertCommissionRule({
      ...base,
      item_id: ITEM_B,
      id: existente.id,
    }).catch((error: unknown) => error);

    expect(payoutStub.ruleIdClashes).toBe(1);
    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "RULE_CONFLICT", status: 409 });
    // La fila que chocó no se tocó y la pareja nueva no se creó a escondidas.
    expect(payoutStub.rules).toHaveLength(1);
    expect(payoutStub.rules[0].item_id).toBe(ITEM_A);
    expect(payoutStub.rules[0].percent).toBe(10);
  });

  it("control de no-extralimitación: la MISMA carga sin `id` NO se rechaza (el rechazo lo causó el `id`)", async () => {
    const existente = await upsertCommissionRule({ ...base, percent: 10 });
    const otra = await upsertCommissionRule({ ...base, item_id: ITEM_B, percent: 30 });

    expect(payoutStub.ruleIdClashes).toBe(0);
    expect(otra.id).not.toBe(existente.id);
    expect(payoutStub.rules).toHaveLength(2);
  });
});

// ===================================================================== ---
// 075 — el archivo de migración y el `onConflict` del servicio
// ===================================================================== ---
//
// La guardia del texto de la migración tiene un motor (una función que devuelve
// las FALTAS de un archivo) y los controles negativos le inyectan recortes
// sintéticos del mismo archivo: un motor que no atrapa un 075 que borra el
// índice viejo no está guardando nada.

/**
 * Lo que la base EJECUTA de verdad: el SQL sin los comentarios de línea y sin
 * los literales de texto. Un texto entre comillas simples es un argumento, no
 * una sentencia: el `COMMENT ON INDEX` de la 075 cita el `DROP` del índice viejo
 * como prosa del catálogo y ese `DROP` no se ejecuta, así que contarlo sería un
 * positivo falso.
 */
function sqlSinComentarios(fuente: string): string {
  return fuente
    .split("\n")
    .map((linea) => linea.split("--")[0])
    .join("\n")
    .replaceAll(/'[^']*'/g, "''");
}

/** La prosa con los espacios de línea colapsados, para frases multilínea. */
function prosa(fuente: string): string {
  return fuente.replace(/\s+/g, " ");
}

/** FALTAS de un archivo 075 (array vacío = cumple). */
function revisar075(fuente: string): string[] {
  const sql = sqlSinComentarios(fuente);
  const falta: string[] = [];

  // (1) El índice nuevo, con las TRES columnas y en ese orden.
  const declarado =
    /CREATE UNIQUE INDEX\s+(?:IF NOT EXISTS\s+)?([a-z0-9_]+)\s+ON\s+public\.commission_rules\s*\(([^)]*)\)/i.exec(
      sql,
    );
  if (!declarado) {
    falta.push("no declara el índice único de commission_rules");
  } else {
    const columnas = declarado[2]
      .split(",")
      .map((columna) => columna.trim())
      .filter(Boolean);
    if (columnas.join(",") !== "item_type,item_id,employee_id") {
      falta.push(`uq_commission_rule_install_key: columnas ${columnas.join(",")}`);
    }
    if (declarado[1] === "uq_commission_rule") {
      falta.push("el índice nuevo no puede llamarse como el de 016");
    }
  }

  // (2) El índice de 016 SIGUE en pie: ningún `DROP` lo toca.
  if (/\bDROP\s+INDEX\s+(?:IF EXISTS\s+)?(?:public\.)?uq_commission_rule\s*;/i.test(sql)) {
    falta.push("borra uq_commission_rule");
  }

  // (3) El pre-vuelo va antes del `CREATE` y aborta nombrando las filas.
  const preVuelo = sql.indexOf("DO $$");
  const creacion = sql.indexOf("CREATE UNIQUE INDEX");
  if (preVuelo < 0) falta.push("sin pre-vuelo");
  else if (creacion >= 0 && preVuelo > creacion) falta.push("el pre-vuelo va después del índice");

  // (4) Idempotente: suelta el índice POR SU NOMBRE y lo vuelve a declarar.
  if (!/\bDROP\s+INDEX\s+IF EXISTS\s+public\.uq_commission_rule_install_key\s*;/i.test(sql)) {
    falta.push("no suelta el índice por su nombre (no es re-ejecutable)");
  }
  return falta;
}

describe("migración 075: la clave de la regla de comisión es de instalación", () => {
  const raw = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "075_commission_rule_install_key.sql"),
    "utf8",
  );
  const sql = sqlSinComentarios(raw);
  const texto = prosa(raw);

  it("el archivo existe y agrega el índice nuevo, con su COMMENT", () => {
    // Piso anti-vacío: el archivo tiene el DDL real y no una prosa.
    expect(raw.length).toBeGreaterThan(3000);
    expect(prosa(sql)).toContain(
      "CREATE UNIQUE INDEX uq_commission_rule_install_key ON public.commission_rules (item_type, item_id, employee_id);",
    );
    expect(sql).toContain("COMMENT ON INDEX public.uq_commission_rule_install_key IS");
    // Y el nombre NO es el de 016: los dos objetos conviven y tienen que poder
    // distinguirse en el catálogo.
    expect(sql).not.toContain("CREATE UNIQUE INDEX uq_commission_rule\n");
    expect(sql).not.toContain("CREATE UNIQUE INDEX uq_commission_rule ");
  });

  it("cumple su propia guarda (motor compartido con los controles negativos)", () => {
    expect(revisar075(raw)).toEqual([]);
  });

  it("NO borra el índice de 016 ni ninguna fila, y deja escrito el DROP pendiente", () => {
    // Nada de lo que este archivo hace puede quitarle la garantía al código que
    // hoy infiere contra `uq_commission_rule`.
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+POLICY\b/i);
    expect(sql).not.toMatch(/\bDROP\s+INDEX\b[^;]*uq_commission_rule\s*;/i);
    // El único `DROP INDEX` del archivo es el del nombre nuevo (idempotencia).
    const caidos = [...sql.matchAll(/\bDROP\s+INDEX\b[^;]*;/gi)].map((caida) => caida[0]);
    expect(caidos).toHaveLength(1);
    expect(caidos[0]).toContain("uq_commission_rule_install_key");

    // Y el DROP que falta queda ESCRITO, con la sentencia exacta y el lugar
    // donde se hace: es lo que impide que se pierda en la unidad final.
    expect(texto).toContain("DROP INDEX IF EXISTS public.uq_commission_rule;");
    expect(texto).toContain("M3c");
    expect(texto).toContain("074_sede_less_constraints.sql");
    expect(texto).toContain("src/features/commissions/service.ts");
  });

  it("el pre-vuelo existe, va primero y aborta nombrando las filas", () => {
    const preVuelo = sql.indexOf("DO $$");
    const creacion = sql.indexOf("CREATE UNIQUE INDEX");
    expect(preVuelo).toBeGreaterThan(-1);
    expect(preVuelo).toBeLessThan(creacion);

    // Aborta en vez de borrar, y el mensaje dice qué hacer.
    expect(raw).toContain("RAISE EXCEPTION");
    expect(raw).toContain("ABORTADA");
    expect(raw).toContain("No se borró, no se fusionó y no se reescribió ninguna fila");
    expect(raw).toContain("vuelva a correr el archivo completo");
    // Y chequea la clave del índice NUEVO (sin sede), que es la que no se
    // puede escribir si los datos ya la violan.
    expect(raw).toContain("GROUP BY item_type, item_id, employee_id");
    expect(raw).toContain("HAVING count(*) > 1");
    expect(raw).toContain("23505");
  });

  it("es idempotente y re-ejecutable: suelta el índice por su nombre y lo vuelve a declarar", () => {
    const suelta = sql.indexOf("DROP INDEX IF EXISTS public.uq_commission_rule_install_key;");
    const declara = sql.indexOf("CREATE UNIQUE INDEX uq_commission_rule_install_key");
    expect(suelta).toBeGreaterThan(-1);
    expect(suelta).toBeLessThan(declara);
    // Una sola declaración (contada sobre el SQL SIN comentarios: la sección de
    // reversión repite el nombre como texto comentado).
    expect([...sql.matchAll(/CREATE UNIQUE INDEX/g)].length).toBe(1);
    expect(texto).toContain("ADITIVO, IDEMPOTENTE Y RE-EJECUTABLE");
    expect(texto).toContain("NUMERACIÓN: 075 es el siguiente libre");
  });

  it("declara el orden (índice primero, código después), el 42P10 y que no se ejecutó", () => {
    expect(texto).toContain("PRIMERO, CÓDIGO DESPUÉS");
    expect(texto).toContain("42P10");
    expect(texto).toContain("onConflict");
    expect(texto).toContain("item_type,item_id");
    expect(raw).toContain("NO ejecutado por el agente: requiere base de datos.");
    // Consultas de sólo lectura para verificar.
    expect(raw).toContain("pg_indexes");
    expect(raw).toContain("obj_description");
  });

  it("control negativo: una 075 que borra el índice de 016 queda señalada", () => {
    // Mismo motor, archivo sintético: el `DROP` del viejo cuelga del índice
    // nuevo y el motor lo ve en el SQL ejecutable (la prosa que lo anuncia no
    // cuenta, porque va comentada).
    const defectuosa = raw.replace(
      "CREATE UNIQUE INDEX uq_commission_rule_install_key",
      "DROP INDEX IF EXISTS public.uq_commission_rule;\n\nCREATE UNIQUE INDEX uq_commission_rule_install_key",
    );
    expect(defectuosa).not.toBe(raw);
    expect(revisar075(defectuosa)).toContain("borra uq_commission_rule");
    // Y el archivo real, con esa misma línea comentada en la prosa, NO se
    // marca: el motor mira sentencias, no comentarios.
    expect(revisar075(raw)).toEqual([]);
  });

  it("control negativo: un índice con `sede_id`, sin pre-vuelo o sin soltar el nombre queda señalado", () => {
    const conSede = raw.replace(
      "ON public.commission_rules (item_type, item_id, employee_id);",
      "ON public.commission_rules (sede_id, item_type, item_id, employee_id);",
    );
    expect(conSede).not.toBe(raw);
    expect(revisar075(conSede).some((falta) => falta.includes("columnas sede_id"))).toBe(true);

    const sinPreVuelo = sql.replace(/DO \$\$[\s\S]*?END \$\$;?/, "");
    expect(revisar075(sinPreVuelo)).toContain("sin pre-vuelo");

    const sinSoltar = sql.replace("DROP INDEX IF EXISTS public.uq_commission_rule_install_key;", "");
    expect(revisar075(sinSoltar)).toContain(
      "no suelta el índice por su nombre (no es re-ejecutable)",
    );
  });
});

describe("commissions: el servicio infiere contra el índice que existe (075)", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "features", "commissions", "service.ts"),
    "utf8",
  );

  it("el `onConflict` del upsert es el conjunto NUEVO y el viejo desapareció", () => {
    // El texto Y el comportamiento: las pruebas del doble de arriba exigen que
    // el servicio mande estas tres columnas, y esto impide que las vuelva a
    // mandar por debajo.
    expect(source).toContain('onConflict: "item_type,item_id,employee_id"');
    expect(source).not.toContain('onConflict: "sede_id,item_type,item_id,employee_id"');
  });

  it("el comentario declara el orden y que el índice viejo sigue vivo hasta la unidad final", () => {
    const encabezado = prosa(source.slice(0, source.indexOf("export async function upsertCommissionRule")));
    expect(encabezado).toContain("uq_commission_rule_install_key");
    expect(encabezado).toContain("PRIMERO");
    expect(encabezado).toContain("DESPUÉS");
    expect(encabezado).toContain("42P10");
    expect(encabezado).toContain("M3c");
    expect(encabezado).toContain("uq_commission_rule (sede_id, item_type, item_id, employee_id)");
    expect(encabezado).toContain("075_commission_rule_install_key.sql");
  });
});

describe("commissions: el método de pago se lee del catálogo GLOBAL y el texto lo dice así (U15)", () => {
  const actor = { userId: "u-cajero" };
  const MARCA = "5f1c0a7e-3d24-4b6a-9e11-0c8b2d4f6a90";

  beforeEach(() => {
    resetPayoutStub();
  });

  it("un método que no está en el catálogo nombra la INSTALACIÓN, no «esta sede»", async () => {
    // `listPaymentMethods` lee el catálogo ENTERO y sin predicado de sede (074
    // dejó la restricción en `UNIQUE (code)`; 077 dropeó la columna), así que el
    // rechazo no puede afirmar un alcance por sede. La condición —el método tiene
    // que estar activo— sí es real: sólo cambia la palabra que nombra el alcance.
    const failure: unknown = await payCommissionNow(
      {
        invoice_id: payoutStub.INVOICE_ID,
        employee_id: payoutStub.EMPLOYEE_ID,
        amount: 3000,
        method_code: "tarjeta_inexistente",
        idempotency_key: MARCA,
      },
      actor,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommissionError);
    expect(failure).toMatchObject({ code: "METHOD_INACTIVE", status: 422 });
    expect((failure as CommissionError).message).toBe(
      "El método de pago tarjeta_inexistente no está activo en la instalación.",
    );
    expect((failure as CommissionError).message).not.toContain("sede");
    // Y no se pagó nada: la guarda corre antes de leer el pendiente y de escribir.
    expect(payoutStub.inserts).toEqual([]);
    expect(payoutStub.payouts).toEqual([]);
    expect(payoutStub.audits).toEqual([]);
  });
});
