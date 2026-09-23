import { z } from "zod";
import { moneyEquals, roundMoney } from "@/src/features/billing/schemas";

export { moneyEquals, roundMoney };

/** PAY-01: estados del periodo (borrador = editable, cerrado = inmutable y terminal). */
export const payrollStatusSchema = z.enum(["borrador", "cerrado"]);
export type PayrollStatus = z.infer<typeof payrollStatusSchema>;

/** PAY-06: estados del vale (descontada y rechazada son terminales). */
export const voucherStatusSchema = z.enum(["pendiente", "aprobada", "rechazada", "descontada"]);
export type VoucherStatus = z.infer<typeof voucherStatusSchema>;

const uuidSchema = z.uuid("Identificador inválido.");
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (use yyyy-mm-dd).");

/** PAY-01: apertura de un periodo borrador por sede y rango. */
export const openPeriodSchema = z
  .object({
    start_date: dateSchema,
    end_date: dateSchema,
  })
  .superRefine((value, context) => {
    if (value.end_date < value.start_date) {
      context.addIssue({
        code: "custom",
        message: "La fecha final no puede ser anterior a la inicial.",
      });
    }
  });
export type OpenPeriodInput = z.infer<typeof openPeriodSchema>;

/** PAY-02: ajustes manuales por empleado al calcular (bonos y otros descuentos). */
export const employeeAdjustmentSchema = z.object({
  employee_id: uuidSchema,
  bonuses: z.coerce.number().nonnegative("Los bonos no pueden ser negativos.").default(0),
  other_discounts: z.coerce.number().nonnegative("Los descuentos no pueden ser negativos.").default(0),
});
export type EmployeeAdjustment = z.infer<typeof employeeAdjustmentSchema>;

/** PAY-02: cálculo del periodo con ajustes opcionales por empleado. */
export const calculatePayrollSchema = z.object({
  adjustments: z.array(employeeAdjustmentSchema).default([]),
});
export type CalculatePayrollInput = z.infer<typeof calculatePayrollSchema>;

/** PAY-04: porción del pago del ítem con su método (monto > 0). */
export const payrollPortionSchema = z.object({
  method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
  amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
  reference: z.string().trim().max(120, "Referencia muy larga.").nullish(),
});
export type PayrollPortionInput = z.infer<typeof payrollPortionSchema>;

/** PAY-04: pago del ítem en porciones (deben sumar el neto exacto). */
export const payPayrollItemSchema = z.object({
  portions: z.array(payrollPortionSchema).min(1, "Indique al menos una porción de pago."),
});
export type PayPayrollItemInput = z.infer<typeof payPayrollItemSchema>;

/** PAY-05: topes de vales por sede (día/semana opcionales) + días permitidos ISO + tope por día. */
export const voucherLimitsSchema = z.object({
  max_per_day: z.coerce.number().nonnegative("El tope diario no puede ser negativo.").nullish(),
  max_per_week: z.coerce.number().nonnegative("El tope semanal no puede ser negativo.").nullish(),
  allowed_days: z
    .array(z.coerce.number().int().min(1, "Día inválido (1=lunes…7=domingo).").max(7, "Día inválido (1=lunes…7=domingo)."))
    .min(1, "Elija al menos un día permitido.")
    .max(7, "Máximo 7 días.")
    .optional(),
  /** V2: tope propio por día ISO; reemplaza al tope diario general ese día. */
  per_day_limits: z
    .array(
      z.object({
        day: z.coerce.number().int().min(1, "Día inválido (1=lunes…7=domingo).").max(7, "Día inválido (1=lunes…7=domingo)."),
        amount: z.coerce.number().nonnegative("El tope del día no puede ser negativo."),
      }),
    )
    .max(7, "Máximo 7 días.")
    .optional(),
});
export type VoucherLimitsInput = z.infer<typeof voucherLimitsSchema>;

/**
 * PAY-06: solicitud de vale (monto > 0, método arqueable obligatorio, fecha
 * opcional, observación opcional). El método se elige AL CREAR el vale (la
 * caja lo sabe antes de aprobar): es el medio por el que saldrá el dinero.
 */
export const requestVoucherSchema = z.object({
  employee_id: uuidSchema,
  amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
  method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
  request_date: dateSchema.optional(),
  observation: z.string().trim().max(500, "Observación muy larga.").nullish(),
});
export type RequestVoucherInput = z.infer<typeof requestVoucherSchema>;

/**
 * PAY-06: aprobación con observación opcional. Sin código de aprobación: la
 * autorización queda en `approved_by` + la observación.
 */
export const approveVoucherSchema = z.object({
  observation: z.string().trim().max(500, "Observación muy larga.").nullish(),
});
export type ApproveVoucherInput = z.infer<typeof approveVoucherSchema>;

/** PAY-06: rechazo con motivo obligatorio (queda auditado en observation). */
export const rejectVoucherSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo del rechazo es requerido.").max(500, "Motivo muy largo."),
});
export type RejectVoucherInput = z.infer<typeof rejectVoucherSchema>;

// ------------------------------------------------------------ cálculos puros ---

export interface CommissionLine {
  invoice_id: string;
  consecutive_number: number | null;
  item_id: string;
  item_type: string;
  qty: number;
  unit_price: number;
  line_subtotal: number;
  commission: number;
  commission_value: number | null;
}

export interface DetailLine extends CommissionLine {
  employee_id: string;
  commission_value: number | null;
}

/**
 * PAY-02: neto = base fija + comisiones + bonos − vales − otros.
 * Puro para probarlo sin base de datos (incluye el caso mixto del PRD).
 */
export function computeNetPay(args: {
  baseFixed: number;
  commissions: number;
  bonuses?: number;
  vales?: number;
  otherDiscounts?: number;
}): number {
  const base = roundMoney(args.baseFixed);
  const commissions = roundMoney(args.commissions);
  const bonuses = roundMoney(args.bonuses ?? 0);
  const vales = roundMoney(args.vales ?? 0);
  const others = roundMoney(args.otherDiscounts ?? 0);
  return roundMoney(Math.max(0, base + commissions + bonuses - vales - others));
}

/**
 * PAY-02/PAY-03: comisión de una línea = subtotal × porcentaje / 100.
 * Solo aplica a porcentaje/mixto; el fijo la ignora (comisión 0).
 */
export function computeLineCommission(lineSubtotal: number, commissionPercent: number | null): number {
  if (commissionPercent === null || commissionPercent === undefined) return 0;
  return roundMoney((roundMoney(lineSubtotal) * commissionPercent) / 100);
}

/**
 * PAY-03: agrega las líneas de un empleado en su detail_json y suma las
 * comisiones. Reproducible: recalcular con las mismas líneas da el mismo
 * neto (PAY-02 medible).
 */
export function buildEmployeeDetail(lines: DetailLine[]): { detail: DetailLine[]; commissions: number } {
  const detail = [...lines].sort((a, b) => {
    const byInvoice = String(a.consecutive_number ?? a.invoice_id).localeCompare(
      String(b.consecutive_number ?? b.invoice_id),
    );
    if (byInvoice !== 0) return byInvoice;
    return a.item_id.localeCompare(b.item_id);
  });
  const commissions = roundMoney(detail.reduce((acc, line) => acc + line.commission, 0));
  return { detail, commissions };
}

/**
 * PAY-01: rechaza cualquier escritura sobre un periodo cerrado (cerrado =
 * inmutable). El estado llega como string de BD.
 */
export function assertDraftPeriod(status: string): void {
  if (status === "cerrado") {
    throw new Error("PERIOD_CLOSED");
  }
}

/**
 * PAY-04: las porciones deben sumar exactamente el neto (tolerancia de
 * centavo). Lanza SUM_MISMATCH si no cuadran, OVERPAID si lo superan.
 * Puro para probarlo sin base de datos.
 */
export function assertPortionsMatchNet(portions: Array<{ amount: number }>, netPay: number): void {
  const sum = roundMoney(portions.reduce((acc, row) => acc + Number(row.amount), 0));
  const net = roundMoney(netPay);
  if (!moneyEquals(sum, net)) {
    throw new Error(sum - net > 0 ? "OVERPAID" : "SUM_MISMATCH");
  }
}

/**
 * PAY-04: con pagos previos, el acumulado + lo nuevo no puede exceder el
 * neto. Puro para probarlo sin base de datos.
 */
export function assertNoOverpay(args: { alreadyPaid: number; newAmount: number; netPay: number }): void {
  if (roundMoney(args.alreadyPaid + args.newAmount) - roundMoney(args.netPay) > 0.009) {
    throw new Error("OVERPAID");
  }
}

/** Lunes (inicio de semana ISO) de una fecha yyyy-mm-dd. */
export function weekStartOf(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7; // lunes = 0
  date.setUTCDate(date.getUTCDate() - weekday);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface VoucherCapCheck {
  /** Acumulado vigente del día + lo solicitado vs tope diario. */
  overDay: boolean;
  /** Acumulado vigente de la semana + lo solicitado vs tope semanal. */
  overWeek: boolean;
}

/**
 * PAY-05/PAY-06: true cuando el vale supera algún tope y por tanto exige
 * aprobación del admin (el servicio lo marca pendiente con requires_approval).
 * Topes en 0 o nulos = sin tope (ilimitado).
 * Puro para probarlo sin base de datos.
 */
export function checkVoucherCaps(args: {
  dayTotal: number;
  weekTotal: number;
  requested: number;
  maxPerDay: number | null;
  maxPerWeek: number | null;
}): VoucherCapCheck {
  const requested = roundMoney(args.requested);
  const overDay =
    args.maxPerDay !== null &&
    args.maxPerDay !== undefined &&
    roundMoney(args.maxPerDay) > 0 &&
    roundMoney(args.dayTotal + requested) - roundMoney(args.maxPerDay) > 0.009;
  const overWeek =
    args.maxPerWeek !== null &&
    args.maxPerWeek !== undefined &&
    roundMoney(args.maxPerWeek) > 0 &&
    roundMoney(args.weekTotal + requested) - roundMoney(args.maxPerWeek) > 0.009;
  return { overDay, overWeek };
}

/** PAY-06: el vale exige revisión del admin cuando supera algún tope. */
export function requiresVoucherApproval(caps: VoucherCapCheck): boolean {
  return caps.overDay || caps.overWeek;
}

/**
 * Item 5: día ISO de la semana (1=lunes…7=domingo) de una fecha yyyy-mm-dd.
 * Puro para probarlo sin base de datos.
 */
export function weekdayIso(dateIso: string): number {
  const [year, month, day] = dateIso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * Item 5: normaliza los días permitidos (únicos, ordenados). null/undefined
 * o vacío = sin restricción (todos los días, comportamiento previo).
 * Puro para probarlo sin base de datos.
 */
export function normalizeAllowedDays(days: Array<number | string> | null | undefined): number[] | null {
  if (!days || days.length === 0) return null;
  const unique = [...new Set(days.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))];
  if (unique.length === 0) return null;
  return unique.sort((a, b) => a - b);
}

/**
 * Item 5: true cuando la fecha cae en un día permitido (null = todos).
 * Puro para probarlo sin base de datos.
 */
export function isVoucherDayAllowed(
  requestDate: string,
  allowedDays: Array<number | string> | null | undefined,
): boolean {
  const normalized = normalizeAllowedDays(allowedDays);
  if (!normalized) return true;
  return normalized.includes(weekdayIso(requestDate));
}

export interface VoucherEligibility extends VoucherCapCheck {
  /** La fecha cae fuera de los días permitidos (también exige revisión). */
  dayNotAllowed: boolean;
}

/**
 * V2: normaliza los topes por día a un mapa { "1": 50000 }. Entradas
 * repetidas: gana la última. Vacío o inválido = null (sin topes por día).
 * Puro para probarlo sin base de datos.
 */
export function normalizePerDayLimits(
  entries: Array<{ day: number | string; amount: number | string }> | null | undefined,
): Record<string, number> | null {
  if (!entries || entries.length === 0) return null;
  const map: Record<string, number> = {};
  for (const entry of entries) {
    const day = Number(entry.day);
    const amount = Number(entry.amount);
    if (!Number.isInteger(day) || day < 1 || day > 7) continue;
    if (!Number.isFinite(amount) || amount < 0) continue;
    map[String(day)] = roundMoney(amount);
  }
  return Object.keys(map).length === 0 ? null : map;
}

/**
 * V2: tope diario aplicable a una fecha. El tope propio del día REEMPLAZA al
 * tope diario general; sin tope propio rige el general. Puro.
 */
export function resolveVoucherDayCap(
  maxPerDay: number | null,
  perDayLimits: Record<string, number | string> | null | undefined,
  requestDate: string,
): number | null {
  const specific = perDayLimits?.[String(weekdayIso(requestDate))];
  if (specific !== undefined && specific !== null) return Number(specific);
  return maxPerDay;
}

/**
 * Item 5: elegibilidad completa del vale (topes + día permitido). Pedir
 * fuera de día permitido NO bloquea: exige revisión del admin igual que
 * superar topes. Puro para probarlo sin base de datos.
 */
export function checkVoucherEligibility(args: {
  dayTotal: number;
  weekTotal: number;
  requested: number;
  maxPerDay: number | null;
  maxPerWeek: number | null;
  requestDate: string;
  allowedDays: Array<number | string> | null | undefined;
  /** V2: topes propios por día; reemplazan al general en su día. */
  perDayLimits?: Record<string, number | string> | null;
}): VoucherEligibility {
  const caps = checkVoucherCaps({
    dayTotal: args.dayTotal,
    weekTotal: args.weekTotal,
    requested: args.requested,
    maxPerDay: resolveVoucherDayCap(args.maxPerDay, args.perDayLimits, args.requestDate),
    maxPerWeek: args.maxPerWeek,
  });
  return { ...caps, dayNotAllowed: !isVoucherDayAllowed(args.requestDate, args.allowedDays) };
}

/**
 * Item 5: el vale exige revisión del admin (topes o día no permitido).
 */
export function voucherRequiresReview(eligibility: VoucherEligibility): boolean {
  return eligibility.overDay || eligibility.overWeek || eligibility.dayNotAllowed;
}

/**
 * Nuevo flujo: estado con el que nace el vale. Dentro de rango (días
 * permitidos + topes) se genera directo (aprobada, utilizable de una); fuera
 * de rango queda pendiente para que el admin lo autorice o rechace.
 * Puro para probarlo sin base de datos.
 */
export function resolveVoucherInitialStatus(
  eligibility: VoucherEligibility,
): "aprobada" | "pendiente" {
  return voucherRequiresReview(eligibility) ? "pendiente" : "aprobada";
}

/**
 * PAY-07: transición válida del vale al liquidar (pendiente/aprobada →
 * descontada). Descontada y rechazada son terminales (doble descuento
 * imposible). Puro para probarlo sin base de datos.
 */
export function canDiscountVoucher(status: string): boolean {
  return status === "pendiente" || status === "aprobada";
}

/**
 * PAY-06: transición válida al aprobar/rechazar (solo desde pendiente).
 * Puro para probarlo sin base de datos.
 */
export function canReviewVoucher(status: string): boolean {
  return status === "pendiente";
}
