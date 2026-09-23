import { z } from "zod";
import { moneyEquals, roundMoney } from "@/src/features/billing/schemas";

export { moneyEquals, roundMoney };

/** Diferencia por método entre lo declarado y lo esperado (arqueo). */
export interface MethodDifference {
  method_code: string;
  expected: number;
  declared: number;
  difference: number;
}

/**
 * CAJ-03/04: total digital esperado al cierre = saldo de apertura del turno
 * más lo cobrado en el turno menos lo pagado inmediato (el "total en la
 * aplicación"). Puro para probarlo sin base de datos.
 */
export function expectedDigitalTotal(openAmount: number, paidAmount: number, paidOut = 0): number {
  return roundMoney(roundMoney(openAmount) + roundMoney(paidAmount) - roundMoney(paidOut));
}

/** Vale tal como lo lee el arqueo para descontarlo de la caja. */
export interface VoucherCashOutInput {
  /** Quién autorizó: null = nunca aprobado (pendiente/rechazada). */
  approved_by: string | null;
  /** Método arqueable por el que salió el dinero; null = histórico sin método. */
  method_code: string | null;
  amount: number | string;
}

/**
 * Regla de dinero del vale: un vale SOLO toca caja cuando fue aprobado
 * (approved_by no nulo) y tiene método arqueable. Un vale pendiente o
 * rechazado NUNCA afecta el arqueo; uno aprobado sí, aunque después pase a
 * descontada en nómina (el efectivo ya salió del cajón). Puro para probarlo.
 */
export function isVoucherCashOut(row: VoucherCashOutInput): boolean {
  return row.approved_by !== null && row.method_code !== null;
}

/**
 * Salida de caja por vales aprobados, agrupada por método. Se usa como
 * `paidOut` del arqueo (resta del esperado), igual que los pagos inmediatos
 * de comisión. Puro para probarlo sin base de datos.
 */
export function voucherOutByMethod(rows: VoucherCashOutInput[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!isVoucherCashOut(row)) continue;
    out.set(row.method_code as string, roundMoney((out.get(row.method_code as string) ?? 0) + Number(row.amount)));
  }
  return out;
}

/**
 * Suma mapas de salida por método (p. ej. comisiones + vales). Los mapas
 * ausentes se ignoran. Puro para probarlo sin base de datos.
 */
export function sumMethodMaps(
  ...maps: Array<Map<string, number> | null | undefined>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const map of maps) {
    if (!map) continue;
    for (const [code, amount] of map) {
      out.set(code, roundMoney((out.get(code) ?? 0) + amount));
    }
  }
  return out;
}

export interface ShiftCountMaps {
  paid: Map<string, number>;
  open: Map<string, number>;
  /** Pagado inmediato por método (descuenta del esperado). */
  paidOut?: Map<string, number>;
  /** Null cuando el turno sigue abierto (aún no hay conteo de cierre). */
  closed: Map<string, number> | null;
}

/**
 * Totales por método para las vistas (día/historial): cobrado, declarado
 * (cierre si está cerrado, apertura si no) y diferencias del cierre contra
 * apertura + cobrado. Puro para probarlo sin base de datos.
 */
export function buildMethodViews(maps: ShiftCountMaps): {
  metodos: Array<{ method_code: string; amount: number }>;
  declarados: Array<{ method_code: string; amount: number }>;
  diferencias: MethodDifference[];
} {
  const metodos = [...maps.paid.entries()].map(([method_code, amount]) => ({
    method_code,
    amount: roundMoney(amount),
  }));
  const source = maps.closed ?? maps.open;
  const declarados = [...source.entries()]
    .filter(([method_code]) => method_code !== "efectivo")
    .map(([method_code, amount]) => ({ method_code, amount: roundMoney(amount) }));
  const diferencias: MethodDifference[] = [];
  if (maps.closed) {
    const codes = new Set([...maps.closed.keys(), ...maps.open.keys(), ...maps.paid.keys(), ...(maps.paidOut?.keys() ?? [])]);
    codes.delete("efectivo");
    for (const code of codes) {
      const expected = expectedDigitalTotal(
        maps.open.get(code) ?? 0,
        maps.paid.get(code) ?? 0,
        maps.paidOut?.get(code) ?? 0,
      );
      const declared = roundMoney(maps.closed.get(code) ?? 0);
      if (!moneyEquals(declared, expected)) {
        diferencias.push({ method_code: code, expected, declared, difference: roundMoney(declared - expected) });
      }
    }
  }
  return { metodos, declarados, diferencias };
}

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
 * CAJ-03/CAJ-04: cierre con arqueo. Solo conteo y confirmación; la base del
 * próximo turno la calcula el servidor (resolveClosingBase) y nunca se pide
 * ni se justifica en el cierre (método de arqueo escondido).
 */
export const closeShiftSchema = z.object({
  counted_cash: z.coerce.number({ error: "El conteo de efectivo es obligatorio." }).nonnegative("El conteo no puede ser negativo."),
  base_left: z.coerce.number().nonnegative("La base no puede ser negativa.").optional(),
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
export const HISTORY_PAGE_SIZE = 10;

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
    page: z.coerce.number().int().min(1).default(1),
  })
  .superRefine((value, context) => {
    if (value.desde > value.hasta) {
      context.addIssue({ code: "custom", message: "El rango de fechas es inválido." });
    }
  });
export type HistoryInput = z.infer<typeof historySchema>;

// ------------------------------------------------------------ cálculos puros ---

/**
 * Business timezone. Colombia has no daylight saving time, so America/Bogota
 * is a fixed UTC-05:00 year-round. Timestamps are timestamptz (UTC); date
 * filters must carry the offset or shifts opened after 19:00 COT land on
 * the next UTC day and vanish from "today".
 */
export const BOGOTA_TZ_OFFSET = "-05:00";

/** Calendar day (yyyy-mm-dd) in America/Bogota for the given instant. */
export function bogotaDay(offsetDays = 0, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Exact timestamptz bounds of a Bogota calendar day (inclusive). */
export function dayBounds(fecha: string): { from: string; to: string } {
  return { from: `${fecha}T00:00:00${BOGOTA_TZ_OFFSET}`, to: `${fecha}T23:59:59.999${BOGOTA_TZ_OFFSET}` };
}

/** Exact bounds of an inclusive Bogota date range. */
export function rangeBounds(desde: string, hasta: string): { from: string; to: string } {
  return { from: dayBounds(desde).from, to: dayBounds(hasta).to };
}

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

/**
 * CAJ-04: base automática del cierre. Nunca se pregunta: si el contado
 * cubre la base configurada, la base queda nivelada en la configurada;
 * si no la cubre, queda en lo contado hasta nivelarse en otro cierre.
 * Pura para probarla sin base de datos.
 */
export function resolveClosingBase(countedCash: number, baseConfigurada: number): number {
  return roundMoney(Math.min(roundMoney(countedCash), roundMoney(baseConfigurada)));
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

/**
 * CAJ-03: valida el cierre a nivel negocio. Solo exige el conteo; la base
 * es automática y jamás se pide justificación (arqueo escondido).
 * Pura para probarla sin base de datos.
 */
export function assertCloseInput(args: {
  countedCash: number | null | undefined;
}): void {
  if (args.countedCash === null || args.countedCash === undefined) {
    throw new Error("COUNT_REQUIRED");
  }
}

/**
 * CAJ-03: solo quien abrió el turno puede cerrarlo. El admin puede cerrar
 * el de otro (queda auditado como override) para que la caja nunca quede
 * bloqueada si el encargado falta. Puro para probarlo sin base de datos.
 */
export function assertShiftCloser(args: {
  openedBy: string;
  actorUserId: string;
  isAdmin: boolean;
}): { isOverride: boolean } {
  if (args.openedBy === args.actorUserId) return { isOverride: false };
  if (args.isAdmin) return { isOverride: true };
  throw new Error("SHIFT_NOT_OWNER");
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

export interface DayShiftSummary {  expectedCash: number;
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
