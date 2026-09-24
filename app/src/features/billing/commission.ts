import {
  commissionRuleKey,
  resolveEmployeeLineCommission,
  type RuleRate,
} from "@/src/features/commissions/schemas";

/**
 * Comisión de una línea de factura para el detalle de solo lectura.
 *
 * Delega en la resolución compartida (`resolveEmployeeLineCommission`,
 * commissions/schemas): la MISMA fuente de verdad que usan la nómina
 * (payroll/schemas, `buildEmployeeCommissionDetail`) y el pago inmediato
 * (commissions/service, `earnedCommissionFor`). Si la regla cambia, cambia en
 * un solo lugar y este detalle la refleja.
 *
 * Guards propios de la línea (no viven en la resolución compartida):
 *  1. Sin datos de empleado → null (no calculable).
 *  2. `no_commission` → 0 (nómina excluye la línea antes de comisionar).
 *  3. `payout_mode === "no_aplica"` → 0 (nómina no arma detalle).
 *  4. La línea solo entra al detalle si el empleado tiene porcentaje plano
 *     (pay_type "porcentaje"/"mixto") o una regla ítem×empleado activa. Sin
 *     ninguno de los dos → 0. Replica el filtro de
 *     `buildEmployeeCommissionDetail` y evita que un ítem `custom` con
 *     `commission_value` comisione en un empleado sin porcentaje ni regla
 *     (nómina lo descarta).
 *
 * La resolución compartida aplica, en este orden: valor fijo del ítem `custom`
 * (si lo trae), regla ítem×empleado (gana al porcentaje plano) o porcentaje
 * plano del empleado.
 */
export interface InvoiceItemCommissionInput {
  itemType: string;
  /** product_id o service_id de la línea (null en ítems `custom`). */
  itemRefId: string | null;
  subtotal: number;
  qty: number;
  commissionValue: number | null;
  noCommission: boolean;
  /** Reglas ítem×empleado activas del empleado (vacío si no tiene). */
  rules: Map<string, RuleRate>;
  employee:
    | {
        payoutMode?: string | null;
        payType?: string | null;
        commissionPercent?: number | null;
      }
    | null
    | undefined;
}

export function computeInvoiceItemCommission(
  input: InvoiceItemCommissionInput,
): number | null {
  const employee = input.employee;
  // Sin empleado no hay pay_type ni porcentaje con qué calcular.
  if (!employee) return null;

  // Nómina descarta la línea antes de comisionar.
  if (input.noCommission) return 0;

  if (employee.payoutMode === "no_aplica") return 0;

  const flatPercent =
    employee.payType === "porcentaje" || employee.payType === "mixto"
      ? Number(employee.commissionPercent ?? 0)
      : null;
  const hasRule =
    input.itemRefId != null &&
    input.rules.has(commissionRuleKey(input.itemType, input.itemRefId));
  // Sin porcentaje plano ni regla la línea no entra al detalle de nómina: 0.
  if (flatPercent === null && !hasRule) return 0;

  return resolveEmployeeLineCommission({
    itemType: input.itemType,
    itemRefId: input.itemRefId,
    subtotal: input.subtotal,
    qty: input.qty,
    // Nómina normaliza `commission_value` con chequeo de veracidad (payroll/
    // service.ts: `row.commission_value ? Number(...) : null`): un 0 no es
    // valor fijo y cae al porcentaje/regla. Se replica el mismo criterio.
    commissionValue: input.commissionValue ? Number(input.commissionValue) : null,
    rules: input.rules,
    flatPercent,
  });
}
