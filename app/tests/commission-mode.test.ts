import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commissionModeSchema,
  deriveCommissionMode,
  invoiceItemSchema,
  normalizeCommissionFields,
} from "@/src/features/billing/schemas";
import { computeInvoiceItemCommission } from "@/src/features/billing/commission";
import {
  commissionRuleKey,
  employeeLineCommissionOrigin,
  lineHasCommissionBasis,
  resolveEmployeeLineCommission,
  type RuleRate,
} from "@/src/features/commissions/schemas";
import { buildEmployeeCommissionDetail } from "@/src/features/payroll/schemas";

const EMPLOYEE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NO_RULES = new Map<string, RuleRate>();

/** Línea personalizada válida de base; se sobreescribe por caso. */
function customItem(overrides: Record<string, unknown> = {}) {
  return {
    item_type: "custom",
    custom_name: "Peinado novia",
    employee_id: EMPLOYEE_ID,
    qty: 1,
    unit_price: 100000,
    discount: 0,
    ...overrides,
  };
}

// ------------------------------------------------- migración 030 ---

describe("migración 030: modo de comisión explícito por ítem", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "migrations", "030_invoice_item_commission_mode.sql"),
    "utf8",
  );

  it("agrega commission_mode y commission_percent_override nullable y re-ejecutable", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS commission_mode text NULL");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS commission_percent_override numeric(5, 2) NULL");
    expect(sql).toContain("chk_invoice_items_commission_mode");
    expect(sql).toContain("commission_mode IN ('comision', 'porcentaje', 'ninguna')");
    expect(sql).toContain("chk_invoice_items_commission_percent_override");
  });

  it("no borra ni altera las columnas vivas no_commission ni commission_value", () => {
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("ALTER COLUMN");
    expect(sql).not.toContain("DROP CONSTRAINT");
  });

  it("backfill preserva la semántica histórica de cada tipo de línea", () => {
    expect(sql).toContain("WHEN no_commission THEN 'ninguna'");
    expect(sql).toContain("WHEN commission_value > 0 THEN 'comision'");
    expect(sql).toContain("WHEN item_type = 'producto' THEN 'comision'");
    expect(sql).toContain("ELSE 'porcentaje'");
    expect(sql).toContain("WHERE commission_mode IS NULL");
  });

  it("documenta las dos columnas nuevas y que el porcentaje explícito nunca es inmediato", () => {
    expect(sql).toContain("COMMENT ON COLUMN public.invoice_items.commission_mode");
    expect(sql).toContain("COMMENT ON COLUMN public.invoice_items.commission_percent_override");
    expect(sql).toContain("nunca de inmediato");
  });
});

// ------------------------------------------------- schemas ---

describe("billing schemas: commission_mode coherente (030)", () => {
  it("acepta los tres modos y rechaza cualquier otro", () => {
    expect(commissionModeSchema.safeParse("comision").success).toBe(true);
    expect(commissionModeSchema.safeParse("porcentaje").success).toBe(true);
    expect(commissionModeSchema.safeParse("ninguna").success).toBe(true);
    expect(commissionModeSchema.safeParse("otro").success).toBe(false);
  });

  it("comision exige valor y no aplica a servicio", () => {
    expect(
      invoiceItemSchema.safeParse(customItem({ commission_mode: "comision", commission_value: 1000 })).success,
    ).toBe(true);
    expect(invoiceItemSchema.safeParse(customItem({ commission_mode: "comision" })).success).toBe(false);
    expect(
      invoiceItemSchema.safeParse({
        item_type: "servicio",
        service_id: SERVICE_ID,
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 50000,
        discount: 0,
        commission_mode: "comision",
        commission_value: 1000,
      }).success,
    ).toBe(false);
  });

  it("comision en producto admite valor nulo (cae a la regla ítem×empleado)", () => {
    expect(
      invoiceItemSchema.safeParse({
        item_type: "producto",
        product_id: PRODUCT_ID,
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 100000,
        discount: 0,
        commission_mode: "comision",
      }).success,
    ).toBe(true);
  });

  it("porcentaje no lleva valor de comisión", () => {
    expect(invoiceItemSchema.safeParse(customItem({ commission_mode: "porcentaje" })).success).toBe(true);
    expect(
      invoiceItemSchema.safeParse(customItem({ commission_mode: "porcentaje", commission_value: 1000 })).success,
    ).toBe(false);
  });

  it("ninguna no lleva valor de comisión", () => {
    expect(invoiceItemSchema.safeParse(customItem({ commission_mode: "ninguna" })).success).toBe(true);
    expect(
      invoiceItemSchema.safeParse(customItem({ commission_mode: "ninguna", commission_value: 1000 })).success,
    ).toBe(false);
  });

  it("el porcentaje explícito solo aplica a personalizado por porcentaje", () => {
    expect(
      invoiceItemSchema.safeParse(
        customItem({ commission_mode: "porcentaje", commission_percent_override: 15 }),
      ).success,
    ).toBe(true);
    expect(
      invoiceItemSchema.safeParse(
        customItem({ commission_mode: "comision", commission_value: 1000, commission_percent_override: 15 }),
      ).success,
    ).toBe(false);
    expect(
      invoiceItemSchema.safeParse({
        item_type: "servicio",
        service_id: SERVICE_ID,
        employee_id: EMPLOYEE_ID,
        qty: 1,
        unit_price: 50000,
        discount: 0,
        commission_mode: "porcentaje",
        commission_percent_override: 15,
      }).success,
    ).toBe(false);
    expect(
      invoiceItemSchema.safeParse(
        customItem({ commission_mode: "porcentaje", commission_percent_override: 101 }),
      ).success,
    ).toBe(false);
  });
});

// ------------------------------------------------- retrocompatibilidad ---

describe("retrocompatibilidad: sin commission_mode se deriva de los campos viejos", () => {
  it("deriveCommissionMode reproduce la semántica previa", () => {
    expect(deriveCommissionMode("producto", false, 1000)).toBe("comision");
    expect(deriveCommissionMode("producto", false, null)).toBe("comision");
    expect(deriveCommissionMode("custom", false, 5000)).toBe("comision");
    expect(deriveCommissionMode("custom", false, null)).toBe("porcentaje");
    expect(deriveCommissionMode("servicio", false, null)).toBe("porcentaje");
    expect(deriveCommissionMode("servicio", true, null)).toBe("ninguna");
    expect(deriveCommissionMode("custom", true, 5000)).toBe("ninguna");
  });

  it("un payload viejo sin commission_mode sigue validando igual", () => {
    expect(invoiceItemSchema.safeParse(customItem({ commission_value: 5000 })).success).toBe(true);
    expect(invoiceItemSchema.safeParse(customItem({})).success).toBe(true);
    expect(invoiceItemSchema.safeParse(customItem({ no_commission: true })).success).toBe(true);
    expect(
      invoiceItemSchema.safeParse(customItem({ no_commission: true, commission_value: 5000 })).success,
    ).toBe(false);
  });

  it("normalizeCommissionFields deriva el modo y conserva los campos viejos", () => {
    const producto = normalizeCommissionFields({
      item_type: "producto",
      no_commission: false,
      commission_value: null,
      commission_mode: undefined,
      commission_percent_override: undefined,
    });
    expect(producto.commission_mode).toBe("comision");
    expect(producto.commission_value).toBe(null);

    const servicio = normalizeCommissionFields({
      item_type: "servicio",
      no_commission: false,
      commission_value: null,
      commission_mode: undefined,
      commission_percent_override: undefined,
    });
    expect(servicio.commission_mode).toBe("porcentaje");
    expect(servicio.commission_value).toBe(null);

    const ninguna = normalizeCommissionFields({
      item_type: "custom",
      no_commission: true,
      commission_value: null,
      commission_mode: undefined,
      commission_percent_override: undefined,
    });
    expect(ninguna.commission_mode).toBe("ninguna");
    expect(ninguna.no_commission).toBe(true);
  });

  it("normalizeCommissionFields con modo explícito mantiene la coherencia", () => {
    const comision = normalizeCommissionFields({
      item_type: "custom",
      no_commission: false,
      commission_value: 1000,
      commission_mode: "comision",
      commission_percent_override: undefined,
    });
    expect(comision.commission_value).toBe(1000);
    expect(comision.no_commission).toBe(false);

    const porcentaje = normalizeCommissionFields({
      item_type: "custom",
      no_commission: false,
      commission_value: null,
      commission_mode: "porcentaje",
      commission_percent_override: 15,
    });
    expect(porcentaje.commission_value).toBe(null);
    expect(porcentaje.commission_percent_override).toBe(15);

    const ninguna = normalizeCommissionFields({
      item_type: "custom",
      no_commission: false,
      commission_value: null,
      commission_mode: "ninguna",
      commission_percent_override: undefined,
    });
    expect(ninguna.no_commission).toBe(true);
    expect(ninguna.commission_value).toBe(null);
  });
});

// ------------------------------------------------- cálculo por modo ---

describe("comisión por línea según el modo (030)", () => {
  it("comision: valor fijo × cantidad = 3000 y origen commission", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 126000,
        qty: 3,
        commissionValue: 1000,
        rules: NO_RULES,
        flatPercent: 35,
      }),
    ).toBe(3000);
    expect(
      employeeLineCommissionOrigin({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        commissionValue: 1000,
        rules: NO_RULES,
        flatPercent: 35,
      }),
    ).toBe("commission");
    // El personalizado con comisión también es valor fijo por unidad.
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 300000,
        qty: 3,
        commissionValue: 1000,
        rules: NO_RULES,
        flatPercent: 35,
      }),
    ).toBe(3000);
  });

  it("porcentaje: % × subtotal y origen percent", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        rules: NO_RULES,
        flatPercent: 10,
      }),
    ).toBe(10000);
    expect(
      employeeLineCommissionOrigin({
        itemType: "custom",
        itemRefId: null,
        commissionValue: null,
        rules: NO_RULES,
        flatPercent: 10,
      }),
    ).toBe("percent");
  });

  it("producto comision sin valor: cae a la regla ítem×empleado (no al %)", () => {
    const rules = new Map<string, RuleRate>([
      [commissionRuleKey("producto", PRODUCT_ID), { percent: 10, amount: null }],
    ]);
    expect(
      resolveEmployeeLineCommission({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        rules,
        flatPercent: 35,
      }),
    ).toBe(10000);
    expect(
      employeeLineCommissionOrigin({
        itemType: "producto",
        itemRefId: PRODUCT_ID,
        commissionValue: null,
        rules,
        flatPercent: 35,
      }),
    ).toBe("commission");
  });

  it("ninguna: la línea no comisiona (0) aunque el empleado tenga porcentaje", () => {
    const fields = normalizeCommissionFields({
      item_type: "custom",
      no_commission: false,
      commission_value: null,
      commission_mode: "ninguna",
      commission_percent_override: undefined,
    });
    expect(fields.no_commission).toBe(true);
    expect(
      computeInvoiceItemCommission({
        itemType: "custom",
        itemRefId: null,
        subtotal: 100000,
        qty: 1,
        commissionValue: fields.commission_value,
        noCommission: fields.no_commission,
        rules: NO_RULES,
        employee: { payoutMode: "nomina", payType: "porcentaje", commissionPercent: 10 },
      }),
    ).toBe(0);
  });
});

// ------------------------- caso nuevo: personalizado % con pago fijo ---

describe("personalizado por porcentaje con empleado de pago fijo (030)", () => {
  const baseLine = {
    invoice_id: "inv-1",
    consecutive_number: 1,
    item_id: "line-1",
    item_type: "custom",
    qty: 1,
    unit_price: 200000,
    line_subtotal: 200000,
    commission_value: null,
    item_ref_id: null,
    commission_percent_override: 15,
  };

  it("usa el porcentaje explícito cuando el empleado no tiene commission_percent", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [baseLine],
      rules: NO_RULES,
    });
    expect(detail).toHaveLength(1);
    expect(detail[0].commission).toBe(30000); // 200000 × 15%
  });

  it("el porcentaje del empleado gana sobre el explícito", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: "nomina",
      payType: "porcentaje",
      commissionPercent: 10,
      lines: [baseLine],
      rules: NO_RULES,
    });
    expect(detail[0].commission).toBe(20000); // 200000 × 10%, no 15%
  });

  it("el origen sigue siendo percent: nunca se paga de inmediato", () => {
    expect(
      employeeLineCommissionOrigin({
        itemType: "custom",
        itemRefId: null,
        commissionValue: null,
        commissionPercentOverride: 15,
        rules: NO_RULES,
        flatPercent: null,
      }),
    ).toBe("percent");
    expect(
      lineHasCommissionBasis({
        itemType: "custom",
        itemRefId: null,
        commissionValue: null,
        commissionPercentOverride: 15,
        rules: NO_RULES,
        flatPercent: null,
      }),
    ).toBe(true);
  });

  it("sin porcentaje explícito, un empleado fijo no comisiona (comportamiento previo)", () => {
    const detail = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [{ ...baseLine, commission_percent_override: null }],
      rules: NO_RULES,
    });
    expect(detail).toHaveLength(0);
  });

  it("el servicio ignora el porcentaje explícito y usa el del empleado", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        commissionPercentOverride: 15,
        rules: NO_RULES,
        flatPercent: null,
      }),
    ).toBe(0);
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 100000,
        qty: 1,
        commissionValue: null,
        commissionPercentOverride: 15,
        rules: NO_RULES,
        flatPercent: 10,
      }),
    ).toBe(10000);
  });
});

// ------------------------------------------------- servicio sin cambios ---

describe("servicio: sigue con el porcentaje del empleado (sin cambios)", () => {
  it("porcentaje del empleado sobre el subtotal y origen percent", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 42000,
        qty: 1,
        rules: NO_RULES,
        flatPercent: 35,
      }),
    ).toBe(14700);
    expect(
      employeeLineCommissionOrigin({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        commissionValue: null,
        rules: NO_RULES,
        flatPercent: 35,
      }),
    ).toBe("percent");
  });

  it("un servicio de empleado fijo sin porcentaje no comisiona", () => {
    expect(
      resolveEmployeeLineCommission({
        itemType: "servicio",
        itemRefId: SERVICE_ID,
        subtotal: 42000,
        qty: 1,
        rules: NO_RULES,
        flatPercent: null,
      }),
    ).toBe(0);
  });
});

// ------------------------------------------------- paridad de los tres caminos ---

describe("paridad: inmediato ≡ nómina ≡ detalle (porcentaje explícito)", () => {
  it("los tres caminos calculan el mismo porcentaje explícito", () => {
    const subtotal = 200000;
    const inmediato = resolveEmployeeLineCommission({
      itemType: "custom",
      itemRefId: null,
      subtotal,
      qty: 1,
      commissionValue: null,
      commissionPercentOverride: 15,
      rules: NO_RULES,
      flatPercent: null,
    });
    const nomina = buildEmployeeCommissionDetail({
      employeeId: EMPLOYEE_ID,
      payoutMode: "nomina",
      payType: "fijo",
      commissionPercent: null,
      lines: [
        {
          invoice_id: "inv-1",
          consecutive_number: 1,
          item_id: "line-1",
          item_type: "custom",
          qty: 1,
          unit_price: subtotal,
          line_subtotal: subtotal,
          commission_value: null,
          item_ref_id: null,
          commission_percent_override: 15,
        },
      ],
      rules: NO_RULES,
    }).reduce((acc, row) => acc + row.commission, 0);
    const detalle = computeInvoiceItemCommission({
      itemType: "custom",
      itemRefId: null,
      subtotal,
      qty: 1,
      commissionValue: null,
      commissionPercentOverride: 15,
      noCommission: false,
      rules: NO_RULES,
      employee: { payoutMode: "nomina", payType: "fijo", commissionPercent: null },
    });
    expect(inmediato).toBe(30000);
    expect(nomina).toBe(30000);
    expect(detalle).toBe(30000);
    // Origen percent: el pago inmediato no lo ofrece (solo nómina).
    expect(
      employeeLineCommissionOrigin({
        itemType: "custom",
        itemRefId: null,
        commissionValue: null,
        commissionPercentOverride: 15,
        rules: NO_RULES,
        flatPercent: null,
      }),
    ).toBe("percent");
  });
});
