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

/**
 * Pendiente = ganado − pagado inmediato (nunca negativo: tope acumulado
 * contra el doble pago). Puro para probarlo sin base de datos.
 */
export function pendingCommission(earned: number, paidImmediate: number): number {
  return roundMoney(Math.max(0, roundMoney(earned) - roundMoney(paidImmediate)));
}
