import { computeLineCommission } from "@/src/features/payroll/schemas";
import { roundMoney } from "./schemas";

/**
 * Comisión de una línea de factura para el detalle de solo lectura.
 *
 * Es la MISMA regla que aplica nómina al armar las líneas de comisión en
 * app/src/features/payroll/service.ts (calculatePayroll, ~L516-546), que es la
 * fuente de verdad. El cálculo de porcentaje se delega en
 * `computeLineCommission` (payroll/schemas) para no duplicar la fórmula. Si la
 * regla de nómina cambia, esta función debe cambiar igual.
 *
 * Orden de guards replicados de nómina:
 *  1. Sin datos de empleado → null (no calculable).
 *  2. `no_commission` → 0 (nómina excluye la línea: service.ts L446).
 *  3. `payout_mode === "no_aplica"` → 0 (service.ts L517).
 *  4. `percent` solo si `pay_type` es "porcentaje" o "mixto"; si no, sin
 *     comisión (service.ts L519-522). Sin porcentaje nómina no arma líneas de
 *     comisión (service.ts L528-530).
 *  5. Ítem `custom` con `commission_value` → valor fijo del ítem (L542-543).
 *  6. Resto → porcentaje sobre el subtotal (L544).
 */
export interface InvoiceItemCommissionInput {
  itemType: string;
  subtotal: number;
  commissionValue: number | null;
  noCommission: boolean;
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

  const percent =
    employee.payType !== "porcentaje" && employee.payType !== "mixto"
      ? null
      : Number(employee.commissionPercent ?? 0);
  if (percent === null) return 0;

  // Para item_type "custom" la comisión es un VALOR fijo del ítem; para
  // productos/servicios, el porcentaje del empleado.
  // OJO con el 0: nómina normaliza `commission_value` con un chequeo de
  // veracidad (payroll/service.ts L456: `row.commission_value ? Number(...) :
  // null`), así que un 0 NO se trata como valor fijo y cae al porcentaje del
  // empleado. Acá se replica ese mismo criterio a propósito: usar `!== null`
  // habría mostrado $0 donde nómina cobra el porcentaje.
  if (input.itemType === "custom" && input.commissionValue) {
    return roundMoney(input.commissionValue);
  }
  return computeLineCommission(input.subtotal, percent);
}
