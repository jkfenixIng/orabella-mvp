import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  payCommissionNow,
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
    join(process.cwd(), "supabase", "migrations", "034_commission_payout_cap.sql"),
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
    sede_id: payoutStub.SEDE_ID,
    employee_id: payoutStub.EMPLOYEE_ID,
    invoice_id: payoutStub.INVOICE_ID,
    amount,
    earned_immediate: earned,
  });
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
    const eqFilters: Record<string, unknown> = {};

    const resolve = async (): Promise<{ data: unknown; error: unknown }> => {
      if (op === "insert") {
        if (table === "audit_logs") {
          payoutStub.audits.push(payload);
          return { data: null, error: null };
        }
        if (table !== "commission_payouts") {
          payoutStub.unexpectedQueries.push(`${table}.insert`);
          return { data: null, error: { message: `stub sin respuesta para ${table}.insert` } };
        }
        const earned = payload.earned_immediate;
        // Contrato de 034: el tope compara contra el ganado que la APP entrega.
        // Sin ese número la base no tiene contra qué comparar (el estado de
        // hoy: la columna no existe) y el INSERT entra.
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
          return {
            data: {
              id: payoutStub.SHIFT_ID,
              cash_register_id: null,
              sede_id: payoutStub.SEDE_ID,
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
        case "invoices":
          return { data: { id: payoutStub.INVOICE_ID, status: "Emitida" }, error: null };
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
      sede_id: payoutStub.SEDE_ID,
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
  const actor = { userId: "u-cajero", sedeId: payoutStub.SEDE_ID };
  // Digital a propósito: aísla el tope de la COMISIÓN del tope de salidas en
  // efectivo del turno, que ya tiene su propia prueba (cash.test.ts). El tope
  // de la comisión no depende del método de pago.
  const input = {
    invoice_id: payoutStub.INVOICE_ID,
    employee_id: payoutStub.EMPLOYEE_ID,
    method_code: payoutStub.METHOD_CODE,
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
   */
  async function paySamePendingTwice(amount: number): Promise<PromiseSettledResult<unknown>[]> {
    armPayoutGate();
    const parked = payCommissionNow({ ...input, amount }, actor);
    await payoutStub.gate?.firstArrival;
    const later = payCommissionNow({ ...input, amount }, actor);
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
