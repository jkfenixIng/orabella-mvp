import { z } from "zod";
import { moneyEquals, roundMoney } from "@/src/features/billing/schemas";

export { moneyEquals, roundMoney };

const uuidSchema = z.uuid("Identificador inválido.");

/** Acuerdo de comisión por (ítem × empleado): % y/o fijo por unidad. */
export const commissionRuleSchema = z
  .object({
    id: uuidSchema.optional(),
    item_type: z.enum(["producto", "servicio"]),
    item_id: uuidSchema,
    employee_id: uuidSchema,
    percent: z.coerce.number().min(0, "El porcentaje mínimo es 0.").max(100, "El máximo es 100.").nullish(),
    amount: z.coerce.number().nonnegative("El valor no puede ser negativo.").nullish(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.percent == null && value.amount == null) {
      context.addIssue({ code: "custom", message: "Indique porcentaje o valor fijo." });
    }
  });
export type CommissionRuleInput = z.infer<typeof commissionRuleSchema>;

export interface CommissionRuleRow {
  id: string;
  sede_id: string;
  item_type: "producto" | "servicio";
  item_id: string;
  employee_id: string;
  percent: number | null;
  amount: number | null;
  is_active: boolean;
}

/** Pago inmediato de comisión desde la caja del turno. */
export const commissionPayoutSchema = z.object({
  invoice_id: uuidSchema,
  employee_id: uuidSchema,
  amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
  method_code: z.string().trim().min(1, "Método requerido.").max(40, "Método muy largo.").default("efectivo"),
});
export type CommissionPayoutInput = z.infer<typeof commissionPayoutSchema>;

export interface CommissionPayoutRow {
  id: string;
  sede_id: string;
  employee_id: string;
  invoice_id: string;
  cash_shift_id: string;
  method_code: string;
  base_subtotal: number;
  percent_applied: number | null;
  fixed_applied: number | null;
  amount: number;
  paid_by: string | null;
  paid_at: string;
}

export interface RuleRate {
  percent: number | null;
  amount: number | null;
}

/**
 * Comisión de una línea con regla (gana a la tasa plana): % sobre el
 * subtotal + fijo por unidad. Sin regla rige la tasa plana del empleado
 * (null = 0). Puro para probarlo sin base de datos.
 */
export function resolveLineCommission(args: {
  subtotal: number;
  qty: number;
  rule?: RuleRate | null;
  flatPercent?: number | null;
}): number {
  if (args.rule) {
    const pct =
      args.rule.percent != null ? roundMoney((roundMoney(args.subtotal) * args.rule.percent) / 100) : 0;
    const fixed = args.rule.amount != null ? roundMoney(args.rule.amount * args.qty) : 0;
    return roundMoney(pct + fixed);
  }
  if (args.flatPercent == null) return 0;
  return roundMoney((roundMoney(args.subtotal) * args.flatPercent) / 100);
}

/** Clave de una regla ítem×empleado en el mapa: `${item_type}:${item_id}`. */
export function commissionRuleKey(itemType: string, itemId: string): string {
  return `${itemType}:${itemId}`;
}

/**
 * true cuando la comisión de la línea es por VALOR FIJO del ítem: productos y
 * personalizados con `commission_value` (> 0). El 0 no es comisión fija: la
 * nómina y el detalle normalizan `commission_value ? … : null`.
 * Puro para probarlo sin base de datos.
 */
export function hasFixedItemCommission(
  itemType: string,
  commissionValue: number | null | undefined,
): boolean {
  return (
    (itemType === "producto" || itemType === "custom") &&
    commissionValue != null &&
    commissionValue > 0
  );
}

/**
 * ¿La línea entra al detalle de comisión del empleado? Compartido por la nómina
 * (`buildEmployeeCommissionDetail`) y el detalle de factura
 * (`computeInvoiceItemCommission`) para que coincidan línea a línea:
 *  - `producto`: valor fijo del ítem o regla ítem×empleado activa. El
 *    porcentaje plano del empleado NUNCA comisiona un producto.
 *  - `custom`: valor fijo del ítem, o porcentaje plano si la línea no trae valor
 *    (un `custom` no tiene ítem de catálogo y por tanto no tiene regla).
 *  - `servicio`: porcentaje plano o regla ítem×empleado activa.
 * Puro para probarlo sin base de datos.
 */
export function lineHasCommissionBasis(args: {
  itemType: string;
  itemRefId: string | null;
  commissionValue: number | null | undefined;
  rules: Map<string, RuleRate>;
  flatPercent: number | null;
}): boolean {
  if (args.itemType === "producto") {
    return (
      hasFixedItemCommission("producto", args.commissionValue) ||
      (args.itemRefId != null && args.rules.has(commissionRuleKey("producto", args.itemRefId)))
    );
  }
  if (args.itemType === "custom") {
    return hasFixedItemCommission("custom", args.commissionValue) || args.flatPercent !== null;
  }
  return (
    args.flatPercent !== null ||
    (args.itemRefId != null && args.rules.has(commissionRuleKey(args.itemType, args.itemRefId)))
  );
}

/**
 * Resolución POR LÍNEA compartida por el pago inmediato, la nómina y el detalle
 * de factura (una sola fuente de verdad). Comisión y porcentaje son conceptos
 * mutuamente excluyentes:
 *  - `producto`: comisión = VALOR FIJO del ítem (`commission_value`) × cantidad.
 *    El valor del ítem manda; sin valor aplica una regla ítem×empleado activa;
 *    NUNCA el porcentaje plano del empleado.
 *  - `custom` con `commission_value`: comisión = valor fijo del ítem × cantidad.
 *  - `custom` sin `commission_value` y `servicio`: porcentaje del empleado; una
 *    regla ítem×empleado activa gana sobre el porcentaje plano (% sobre el
 *    subtotal + fijo por unidad).
 * El valor fijo es POR UNIDAD: se multiplica por `qty` (igual que el fijo de una
 * regla). El subtotal ya trae la cantidad y no se usa en esta rama, así que no
 * hay doble multiplicación.
 * Puro para probarlo sin base de datos.
 */
export function resolveEmployeeLineCommission(args: {
  itemType: string;
  /** product_id o service_id de la línea (null en ítems `custom`). */
  itemRefId: string | null;
  subtotal: number;
  qty: number;
  /** Valor fijo de comisión del ítem (producto o `custom`), si la línea lo trae. */
  commissionValue?: number | null;
  rules: Map<string, RuleRate>;
  flatPercent: number | null;
}): number {
  const rule =
    args.itemRefId != null
      ? args.rules.get(commissionRuleKey(args.itemType, args.itemRefId)) ?? null
      : null;

  // Producto: comisión por valor fijo del ítem × cantidad. El valor del ítem
  // manda; sin valor cae a la regla ítem×empleado (nunca al porcentaje plano).
  if (args.itemType === "producto") {
    if (args.commissionValue) return roundMoney(args.commissionValue * Math.floor(args.qty));
    return rule
      ? resolveLineCommission({
          subtotal: args.subtotal,
          qty: Math.floor(args.qty),
          rule,
          flatPercent: null,
        })
      : 0;
  }
  // Personalizado con valor fijo: manda el valor del ítem × cantidad.
  if (args.itemType === "custom" && args.commissionValue) {
    return roundMoney(args.commissionValue * Math.floor(args.qty));
  }
  // Servicio y personalizado sin valor: porcentaje del empleado (la regla gana).
  return resolveLineCommission({
    subtotal: args.subtotal,
    qty: Math.floor(args.qty),
    rule,
    flatPercent: rule ? null : args.flatPercent,
  });
}

/**
 * Pendiente = ganado − pagado inmediato (nunca negativo: tope acumulado
 * contra el doble pago). Puro para probarlo sin base de datos.
 */
export function pendingCommission(earned: number, paidImmediate: number): number {
  return roundMoney(Math.max(0, roundMoney(earned) - roundMoney(paidImmediate)));
}
