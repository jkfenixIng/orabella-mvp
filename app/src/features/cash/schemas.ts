import { z } from "zod";
import { moneyEquals, roundMoney } from "@/src/features/billing/schemas";

export { moneyEquals, roundMoney };

/** CAJ-01/CAJ-04: estados del turno (abierto = en operación, cerrado = terminal). */
export const shiftStatusSchema = z.enum(["abierto", "cerrado"]);
export type ShiftStatus = z.infer<typeof shiftStatusSchema>;

const uuidSchema = z.uuid("Identificador inválido.");

/**
 * CASH: línea de conteo de apertura/cierre. Efectivo por denominación
 * (cantidad de billetes/monedas); digitales con denomination null,
 * quantity 1 y el total declarado en amount.
 */
export const shiftCountSchema = z.object({
  method_code: z.string().trim().min(1, "Método requerido.").max(40, "Método muy largo."),
  denomination: z.coerce.number().positive("Denominación inválida.").nullish(),
  quantity: z.coerce.number().int().nonnegative("Cantidad inválida."),
  amount: z.coerce.number().nonnegative("Monto inválido."),
});
export type ShiftCountInput = z.infer<typeof shiftCountSchema>;

/** CAJ-01: apertura (la caja se resuelve a la "Caja única" de la sede si se omite). */
export const openShiftSchema = z.object({
  cash_register_id: uuidSchema.optional(),
  counts: z.array(shiftCountSchema).min(1, "El pre-arqueo es obligatorio para abrir."),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

/** CAJ-02: pago contra el turno (factura opcional; método del catálogo, monto > 0). */
export const registerPaymentSchema = z.object({
  cash_shift_id: uuidSchema.optional(),
  invoice_id: uuidSchema.nullish(),
  method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
  amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
});
export type RegisterPaymentInput = z.infer<typeof registerPaymentSchema>;

/**
 * CAJ-03/CAJ-04: cierre con arqueo. conteo y base dejada obligatorios;
 * la observación se exige en el servicio cuando la base queda incompleta
 * (base_left < base_configurada), no en el esquema.
 */
export const closeShiftSchema = z.object({
  counted_cash: z.coerce.number({ error: "El conteo de efectivo es obligatorio." }).nonnegative("El conteo no puede ser negativo."),
  base_left: z.coerce.number({ error: "La base dejada es obligatoria." }).nonnegative("La base no puede ser negativa."),
  observation: z.string().trim().max(500, "Observación muy larga.").nullish(),
  counts: z.array(shiftCountSchema).min(1, "El detalle del conteo es obligatorio para cerrar."),
  confirmed: z.boolean().refine((value) => value === true, "Confirme el cierre: después no se puede modificar."),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

/** CAJ-05: vista del día (fecha calendario yyyy-mm-dd). */
export const dayViewSchema = z.object({
  fecha: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (use yyyy-mm-dd)."),
});
export type DayViewInput = z.infer<typeof dayViewSchema>;

/** CAJ-06: historial filtrable por rango de fechas (inclusive). */
export const historySchema = z
  .object({
    desde: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inicial inválida (use yyyy-mm-dd)."),
    hasta: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha final inválida (use yyyy-mm-dd)."),
  })
  .superRefine((value, context) => {
    if (value.desde > value.hasta) {
      context.addIssue({ code: "custom", message: "El rango de fechas es inválido." });
    }
  });
export type HistoryInput = z.infer<typeof historySchema>;

// ------------------------------------------------------------ cálculos puros ---

/**
 * CAJ-01: base con la que abre el turno. Hereda base_left del último
 * cierre; el primer turno (sin cierre anterior) usa base_configurada.
 * Puro para probarlo sin base de datos.
 */
export function resolveOpeningBase(
  lastBaseLeft: number | null | undefined,
  baseConfigurada: number,
): number {
  if (lastBaseLeft === null || lastBaseLeft === undefined) return roundMoney(baseConfigurada);
  return roundMoney(lastBaseLeft);
}

export interface CashCloseResult {
  cashWithdrawn: number;
  baseDifference: number;
  incomplete: boolean;
}

/**
 * CAJ-04: derivados del cierre. cash_withdrawn = contado − base dejada
 * (recogido); base_difference = base dejada − base configurada
 * (negativo = faltante, positivo = sobrante). Caso 400/200: contado
 * 400 000, base 200 000 → recogido 200 000, diferencia 0. Caso 300/150:
 * base configurada 300 000, contado 150 000, base dejada 150 000 →
 * recogido 0, diferencia −150 000 (base incompleta). Puro para probarlo.
 */
export function computeCashClose(args: {
  countedCash: number;
  baseLeft: number;
  baseConfigurada: number;
}): CashCloseResult {
  const countedCash = roundMoney(args.countedCash);
  const baseLeft = roundMoney(args.baseLeft);
  const baseConfigurada = roundMoney(args.baseConfigurada);
  return {
    cashWithdrawn: roundMoney(countedCash - baseLeft),
    baseDifference: roundMoney(baseLeft - baseConfigurada),
    incomplete: baseLeft < baseConfigurada,
  };
}

/** CAJ-04: true cuando la base queda incompleta y exige observación. */
export function requiresCloseObservation(baseLeft: number, baseConfigurada: number): boolean {
  return roundMoney(baseLeft) < roundMoney(baseConfigurada);
}

/**
 * CAJ-01: rechaza la apertura cuando ya hay un turno abierto en la caja
 * (sin solape). El índice parcial uq_cash_shifts_open_per_register es la
 * barrera final en BD; esto devuelve el mensaje de negocio antes.
 */
export function assertNoOpenShift(hasOpenShift: boolean): void {
  if (hasOpenShift) {
    throw new Error("SHIFT_ALREADY_OPEN");
  }
}

/**
 * CAJ-03/CAJ-04: valida el cierre a nivel negocio. Lanza COUNT_REQUIRED
 * sin conteo y OBSERVATION_REQUIRED cuando la base queda incompleta sin
 * observación. Puro para probarlo sin base de datos.
 */
export function assertCloseInput(args: {
  countedCash: number | null | undefined;
  baseLeft: number;
  baseConfigurada: number;
  observation: string | null | undefined;
}): void {
  if (args.countedCash === null || args.countedCash === undefined) {
    throw new Error("COUNT_REQUIRED");
  }
  if (requiresCloseObservation(args.baseLeft, args.baseConfigurada)) {
    if (!args.observation || args.observation.trim() === "") {
      throw new Error("OBSERVATION_REQUIRED");
    }
  }
}

export interface DayShiftSummary {
  expectedCash: number;
  countedCash: number | null;
  baseLeft: number | null;
  cashWithdrawn: number | null;
  baseDifference: number | null;
  ventas: number;
}

export interface DayTotals {
  turnos: number;
  ventas: number;
  esperado: number;
  contado: number;
  baseDejada: number;
  recogido: number;
  diferencias: number;
}

/**
 * CAJ-05: acumulado del día = suma de sus turnos. El contado suma solo
 * turnos cerrados (los abiertos aún no tienen conteo). Puro para probarlo.
 */
export function accumulateDayTotals(shifts: DayShiftSummary[]): DayTotals {
  return {
    turnos: shifts.length,
    ventas: roundMoney(shifts.reduce((acc, row) => acc + row.ventas, 0)),
    esperado: roundMoney(shifts.reduce((acc, row) => acc + row.expectedCash, 0)),
    contado: roundMoney(shifts.reduce((acc, row) => acc + (row.countedCash ?? 0), 0)),
    baseDejada: roundMoney(shifts.reduce((acc, row) => acc + (row.baseLeft ?? 0), 0)),
    recogido: roundMoney(shifts.reduce((acc, row) => acc + (row.cashWithdrawn ?? 0), 0)),
    diferencias: roundMoney(shifts.reduce((acc, row) => acc + (row.baseDifference ?? 0), 0)),
  };
}
