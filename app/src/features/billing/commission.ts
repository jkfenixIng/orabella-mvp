import {
  lineHasCommissionBasis,
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
 *  4. La línea solo entra al detalle si tiene base de comisión (ver
 *     `lineHasCommissionBasis`): valor fijo del ítem, porcentaje (el del
 *     empleado o el explícito de la línea) o regla ítem×empleado activa. Sin
 *     ninguna → 0. Replica el filtro de `buildEmployeeCommissionDetail`.
 *
 * La resolución compartida aplica, en este orden: comisión por VALOR FIJO del
 * ítem (productos siempre; personalizados con valor), regla ítem×empleado o
 * porcentaje (el del empleado y, para personalizados de pago fijo, el
 * porcentaje explícito de la línea).
 */
export interface InvoiceItemCommissionInput {
  itemType: string;
  /** product_id o service_id de la línea (null en ítems `custom`). */
  itemRefId: string | null;
  subtotal: number;
  qty: number;
  commissionValue: number | null;
  /**
   * Porcentaje explícito de la línea (personalizado por porcentaje con empleado
   * de pago fijo). Solo aplica si el empleado no tiene porcentaje propio.
   */
  commissionPercentOverride?: number | null;
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
  // Nómina normaliza `commission_value` con chequeo de veracidad (payroll/
  // service.ts: `row.commission_value ? Number(...) : null`): un 0 no es valor
  // fijo. Se replica el mismo criterio.
  const commissionValue = input.commissionValue ? Number(input.commissionValue) : null;
  // Sin base de comisión (valor fijo del ítem, porcentaje plano o regla) la
  // línea no entra al detalle de nómina: 0.
  if (
    !lineHasCommissionBasis({
      itemType: input.itemType,
      itemRefId: input.itemRefId,
      commissionValue,
      commissionPercentOverride: input.commissionPercentOverride ?? null,
      rules: input.rules,
      flatPercent,
    })
  ) {
    return 0;
  }

  return resolveEmployeeLineCommission({
    itemType: input.itemType,
    itemRefId: input.itemRefId,
    subtotal: input.subtotal,
    qty: input.qty,
    commissionValue,
    commissionPercentOverride: input.commissionPercentOverride ?? null,
    rules: input.rules,
    flatPercent,
  });
}
