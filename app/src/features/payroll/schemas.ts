import { z } from "zod";
import { idempotencyKeySchema, moneyEquals, roundMoney } from "@/src/features/billing/schemas";
import { cashOutLimitViolation } from "@/src/features/cash/schemas";
import {
  employeeLineCommissionOrigin,
  employeeLineCommissionPercent,
  lineHasCommissionBasis,
  resolveEmployeeLineCommission,
  type CommissionOrigin,
  type RuleRate,
} from "@/src/features/commissions/schemas";

export { moneyEquals, roundMoney };

/** PAY-01: estados del periodo (borrador = editable, cerrado = inmutable y terminal). */
export const payrollStatusSchema = z.enum(["borrador", "cerrado"]);
export type PayrollStatus = z.infer<typeof payrollStatusSchema>;

/**
 * F3/F4: cadencia de pago. Es la MISMA lista cerrada que declara el CHECK de
 * `employees.pay_frequency` y `payroll_periods.frequency` (migración 063), la
 * que pregunta la ficha del empleado (unidad de EMPLEADOS) y la que elige el
 * diálogo de apertura del período (F4). `null` no es un valor más: es la
 * AUSENCIA de cadencia, y conserva el comportamiento de hoy.
 *
 * Vive ARRIBA, antes de `openPeriodSchema`, porque el período la valida con el
 * MISMO catálogo (una sola definición: si el enum se moviera en un lado y no en
 * el otro, la nómina aceptaría una cadencia que no sabe liquidar).
 */
export const payFrequencySchema = z.enum(["semanal", "quincenal", "mensual"]);
export type PayFrequency = z.infer<typeof payFrequencySchema>;

/** PAY-06: estados del vale (descontada y rechazada son terminales). */
export const voucherStatusSchema = z.enum(["pendiente", "aprobada", "rechazada", "descontada"]);
export type VoucherStatus = z.infer<typeof voucherStatusSchema>;

const uuidSchema = z.uuid("Identificador inválido.");
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (use yyyy-mm-dd).");

/**
 * F10 (decisión del dueño, 2026-10-01, revisada el 2026-10-04): la fecha desde
 * que la nómina OPERA. Un día en la forma canónica `yyyy-mm-dd` —la MISMA
 * convención de fechas del módulo—, no un instante.
 *
 * El 2026-10-04 dejó de ser una CONFIGURACIÓN: la primera liquidación la
 * DECLARA (`declared_start_date` de `openPeriodSchema`) y, de ahí en adelante, el
 * arranque se deriva de los períodos (`payrollHistoryFloor`). Este esquema sigue
 * vivo sólo porque otra superficie (la plataforma, que se retira en su unidad)
 * valida la columna con él: no es la puerta del módulo de nómina.
 */
export const payrollStartDateSchema = dateSchema.nullable();

/**
 * PAY-01/F7: apertura de un período borrador por sede y CICLO.
 *
 * F7 (regla del dueño, 2026-10-01): el rango NO es libre. El período se cierra
 * al ciclo de su cadencia ("último domingo a este sábado"; quincenal dos
 * semanas, mensual cuatro), así que el formulario manda la CADENCIA y el
 * CIERRE DEL CICLO (el sábado que lo cierra) y el servidor deriva
 * `start_date`/`end_date`. Elegir un lunes es imposible por construcción, no
 * "desaconsejado".
 *
 * `frequency` es OBLIGATORIA para un período NUEVO: "sin cadencia" ya no es una
 * opción del diálogo. NULL sigue siendo legal SOLO como dato heredado —los
 * períodos ya abiertos conservan su cálculo por la vía F3/F5— y no se puede
 * pedir por acá.
 *
 * `start_date`/`end_date` siguen aceptándose por compatibilidad, pero son una
 * SEGUNDA opinión: si vienen y no coinciden con el ciclo derivado, el envío se
 * rechaza. La única fuente de verdad es `frequency` + `cycle_end_date`.
 *
 * F10: la forma del rango que se persiste la resuelve `resolveOpenPayrollRange`
 * —el ÚNICO validador de las DOS formas admisibles: un ciclo COMPLETO o el
 * PRIMER ciclo recortado al arranque— porque el recorte depende de
 * la instalación (su arranque y los períodos que ya tiene) y este esquema es
 * puro. La segunda opinión de `start_date`/`end_date` sigue siendo sobre el
 * CIELO del ciclo elegido: el recorte lo agrega el servicio, no el llamador.
 *
 * `declared_start_date` es la fecha desde la que la nómina OPERA, y sólo la
 * puede mandar la PRIMERA liquidación (cuando la instalación no tiene ningún
 * período): de ahí en adelante el arranque se deriva de los períodos y nadie
 * vuelve a preguntar nada. El campo se valida SÍ o SÍ —es un día o no es nada—
 * porque la decisión de si se ACEPTA y de si es OBLIGATORIA la toma el servicio,
 * que es quien sabe si ya hay períodos.
 */
export const openPeriodSchema = z
  .object({
    frequency: payFrequencySchema,
    cycle_end_date: dateSchema,
    declared_start_date: dateSchema.nullable().optional(),
    start_date: dateSchema.optional(),
    end_date: dateSchema.optional(),
  })
  .superRefine((value, context) => {
    const cycle = payrollCycleRange({
      frequency: value.frequency,
      cycleEndDate: value.cycle_end_date,
    });
    if (cycle === null) {
      context.addIssue({
        code: "custom",
        message: "El cierre del ciclo debe ser un sábado.",
        path: ["cycle_end_date"],
      });
      return;
    }
    if (value.start_date !== undefined && value.start_date !== cycle.start_date) {
      context.addIssue({
        code: "custom",
        message: "La fecha de inicio no coincide con el ciclo de la cadencia.",
        path: ["start_date"],
      });
    }
    if (value.end_date !== undefined && value.end_date !== cycle.end_date) {
      context.addIssue({
        code: "custom",
        message: "La fecha final no coincide con el ciclo de la cadencia.",
        path: ["end_date"],
      });
    }
  });
export type OpenPeriodInput = z.infer<typeof openPeriodSchema>;

/**
 * F8 (migración 067): longitud máxima del motivo de un ajuste manual. El mismo
 * tope vive en la guarda de forma de `payroll_apply_atomic`, para que un motivo
 * desmedido se rechace en el contrato y no llegue a la columna.
 */
export const ADJUSTMENT_REASON_MAX_LENGTH = 200;

/** PAY-02: ajustes manuales por empleado al calcular (bonos y otros descuentos). */
export const employeeAdjustmentSchema = z.object({
  employee_id: uuidSchema,
  bonuses: z.coerce.number().nonnegative("Los bonos no pueden ser negativos.").default(0),
  other_discounts: z.coerce.number().nonnegative("Los descuentos no pueden ser negativos.").default(0),
  /**
   * F8: el motivo escrito del ajuste. Viaja en la MISMA fila que el monto que
   * justifica (`payroll_items.adjustment_reason`, 067) y con él se confirma o se
   * revierte. `null`/ausente = sin motivo: el servicio lo exige cuando hay un
   * bono o un descuento distinto de 0 y lo descarta cuando no hay ajuste
   * (decisión del dueño, 2026-10-01: todo ajuste manual lleva su motivo). La
   * regla cruzada vive en el servicio porque el mensaje tiene que nombrar al
   * empleado y el esquema no conoce los nombres.
   */
  adjustment_reason: z
    .string()
    .trim()
    .max(
      ADJUSTMENT_REASON_MAX_LENGTH,
      `El motivo no puede superar los ${ADJUSTMENT_REASON_MAX_LENGTH} caracteres.`,
    )
    .nullish(),
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

/**
 * PAY-04: pago del ítem en porciones (deben sumar el neto exacto).
 *
 * CL-2: la operación exige `idempotency_key`, la MARCA del intento (uuid que
 * genera la pantalla y que se reutiliza en los reintentos del MISMO intento).
 * Es la MISMA definición que usa el cobro de factura —vive en
 * `billing/schemas.ts` y las dos puertas del dinero validan igual, en vez de
 * tener dos reglas que se pueden separar—. Es OBLIGATORIA: un envío sin marca
 * no se puede reconocer como repetición, así que aceptarlo sin marca es reabrir
 * el defecto (pagar dos veces) para ESE llamador, y la ruta REST es la
 * superficie que más reintenta. El rechazo es ruidoso y no escribe nada.
 */
export const payPayrollItemSchema = z.object({
  idempotency_key: idempotencyKeySchema,
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
 *
 * CL-5: la operación exige `idempotency_key`, la MARCA del intento (uuid que
 * acuña la pantalla de vales al empezar el intento y que se reutiliza en los
 * reintentos del MISMO intento). Es la MISMA definición que usan las otras
 * puertas del dinero —vive en `billing/schemas.ts` y todas validan igual, en
 * vez de tener cinco reglas que se pueden separar—. Es OBLIGATORIA: un envío
 * sin marca no se puede reconocer como repetición, y los topes de 026 son
 * ACUMULADOS (una obligación total, no la identidad de un envío), así que
 * mientras `2 × monto` quepa en el día y en la semana el reintento abre un
 * SEGUNDO vale: segunda salida de caja en el arqueo y segundo descuento de
 * nómina. Aceptarlo sin marca es reabrir el defecto para ESE llamador; el
 * rechazo es ruidoso (VALIDATION) y no escribe nada.
 */
export const requestVoucherSchema = z.object({
  idempotency_key: idempotencyKeySchema,
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

/**
 * PA-2a: casos extraordinarios que justifican una nómina individual. Vocabulario
 * CERRADO (mismo enum en el CHECK de la migración 036): el motivo libre no
 * alcanza para contar el caso, y agregar un caso nuevo es una decisión de
 * producto, no un texto que cada sede inventa.
 */
export const payrollExtraKindSchema = z.enum(["despido", "renuncia", "emergencia", "otro"]);
export type PayrollExtraKind = z.infer<typeof payrollExtraKindSchema>;

/**
 * PA-2a: pago individual por caso extraordinario (despido, renuncia,
 * emergencia del empleado). NO es un período de nómina y no se relaciona con
 * `payroll_periods`: existe justamente para pagar días que un período CERRADO
 * ya cubrió, donde `payPayrollItem` no puede entrar (assertDraftPeriod).
 *
 * El MOTIVO es obligatorio (no vacío) y el TIPO también: un pago de dinero sin
 * explicación no es un registro, es un descuadre. `days_from`/`days_to` son
 * OPCIONALES y son los días que el pago liquida: alimentan la GUÍA (ver
 * `payrollExtraGuide`) y quedan guardados como referencia de qué se pagó. Van
 * juntos o ninguno, y el rango tiene que ser real (fin >= inicio).
 *
 * CL-5: la operación exige `idempotency_key`, la MARCA del intento (uuid que
 * acuña la pantalla al empezar el intento y que se reutiliza en los reintentos
 * del MISMO intento). Es la MISMA definición que usan las otras puertas del
 * dinero —vive en `billing/schemas.ts` y todas validan igual, en vez de tener
 * cinco reglas que se pueden separar—. Es OBLIGATORIA: un envío sin marca no se
 * puede reconocer como repetición, y acá no hay tope que lo frene (el monto lo
 * escribe el admin y NO se topa), así que aceptarlo sin marca es reabrir el
 * defecto para ESE llamador: la segunda vez escribe un segundo pago. El rechazo
 * es ruidoso (VALIDATION) y no escribe nada.
 */
export const payrollExtraSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    employee_id: uuidSchema,
    amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
    method_code: z.string().trim().min(1, "Método de pago requerido.").max(40, "Método muy largo."),
    reference: z.string().trim().max(120, "Referencia muy larga.").nullish(),
    reason: z.string().trim().min(1, "El motivo del pago es obligatorio.").max(500, "Motivo muy largo."),
    kind: payrollExtraKindSchema,
    days_from: dateSchema.nullish(),
    days_to: dateSchema.nullish(),
  })
  .superRefine((value, context) => {
    const from = value.days_from ?? null;
    const to = value.days_to ?? null;
    if (from === null && to === null) return;
    if (from === null || to === null) {
      context.addIssue({
        code: "custom",
        message: "Indique las dos fechas de los días liquidados, o ninguna.",
        path: ["days_from"],
      });
      return;
    }
    if (to < from) {
      context.addIssue({
        code: "custom",
        message: "La fecha final no puede ser anterior a la inicial.",
        path: ["days_to"],
      });
    }
  });
export type PayrollExtraInput = z.infer<typeof payrollExtraSchema>;

/**
 * PA-2b: corrección de un período CERRADO. El MOTIVO es obligatorio: una
 * corrección sin explicación es un número que cambió solo, y lo que se corrige
 * es plata ya firmada. La razón viaja a la auditoría y a la fila de la
 * corrección (misma regla en el CHECK de la migración 037).
 */
export const correctPayrollPeriodSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "El motivo de la corrección es obligatorio.")
    .max(500, "Motivo muy largo."),
});
export type CorrectPayrollPeriodInput = z.infer<typeof correctPayrollPeriodSchema>;

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
  /**
   * Origen de la comisión de la línea, con la MISMA precedencia que el monto
   * (`employeeLineCommissionOrigin`): "commission" = valor fijo del ítem o
   * regla ítem×empleado; "percent" = porcentaje del empleado o explícito de la
   * línea. Es opcional a propósito: las filas ya persistidas antes de este
   * cambio no lo traen, y el origen se DEDUCE al leerlas con
   * `detailLineCommissionOrigin` (la clasificación vieja las mostraba todas
   * como fijas).
   */
  commission_origin?: CommissionOrigin;
  /**
   * Tasa aplicada cuando el origen es "percent"; `null`/ausente en los otros.
   * Sale de la misma fuente que el monto (`employeeLineCommissionPercent`).
   */
  commission_percent?: number | null;
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
 * PAY-02: topa el descuento efectivo al bruto para que el neto persistido
 * (que nunca queda negativo) sea consistente con el CHECK de payroll_items
 * (neto = bruto − vales − otros). El exceso de descuento se absorbe, no se
 * arrastra como deuda: por eso el descuento efectivo no puede superar el
 * bruto. El recorte se aplica primero a other_discounts (descuentos manuales)
 * y solo después a vales, para priorizar la recuperación del vale ya
 * desembolsado; un vale queda parcialmente descontado únicamente cuando por
 * sí solo supera el bruto.
 */
export function capPayrollDiscounts(args: {
  gross: number;
  vales: number;
  otherDiscounts: number;
}): { vales: number; otherDiscounts: number } {
  const gross = roundMoney(Math.max(0, args.gross));
  const vales = roundMoney(Math.max(0, args.vales));
  const others = roundMoney(Math.max(0, args.otherDiscounts));
  if (roundMoney(vales + others) <= gross) {
    return { vales, otherDiscounts: others };
  }
  const valesCapped = roundMoney(Math.min(vales, gross));
  const othersCapped = roundMoney(Math.max(0, Math.min(others, roundMoney(gross - vales))));
  return { vales: valesCapped, otherDiscounts: othersCapped };
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

/** Línea de factura cruda que alimenta el detalle de comisiones de nómina. */
export interface PayrollCommissionLine {
  invoice_id: string;
  consecutive_number: number | null;
  item_id: string;
  item_type: string;
  qty: number;
  unit_price: number;
  line_subtotal: number;
  commission_value: number | null;
  /** product_id o service_id según el tipo (null en ítems `custom`). */
  item_ref_id: string | null;
  /**
   * Porcentaje explícito de la línea (personalizado por porcentaje con empleado
   * de pago fijo). Se usa solo si el empleado no tiene `commission_percent`.
   */
  commission_percent_override?: number | null;
}

/**
 * PAY-02/PAY-03: arma el detalle por línea de un empleado con la MISMA
 * resolución que el pago inmediato (`resolveEmployeeLineCommission`). Una línea
 * entra si tiene base de comisión (`lineHasCommissionBasis`): valor fijo del
 * ítem, porcentaje plano del empleado o regla ítem×empleado activa. La regla
 * gana sobre el porcentaje plano; el valor fijo del ítem manda sobre ambos.
 *
 * Preserva la semántica histórica:
 *  - `payout_mode = "no_aplica"` → sin comisión (detalle vacío).
 *  - `pay_type` fijo sin reglas ni valor fijo → sin detalle (comisión 0).
 *  - El valor fijo de ítems `custom` y `producto` es POR UNIDAD: se multiplica
 *    por la cantidad de la línea.
 * Puro para probarlo sin base de datos.
 */
export function buildEmployeeCommissionDetail(args: {
  employeeId: string;
  payoutMode?: string | null;
  payType: string;
  commissionPercent: number | null;
  lines: PayrollCommissionLine[];
  rules: Map<string, RuleRate>;
}): DetailLine[] {
  if (args.payoutMode === "no_aplica") return [];
  const flatPercent =
    args.payType === "porcentaje" || args.payType === "mixto"
      ? Number(args.commissionPercent ?? 0)
      : null;
  return args.lines
    .filter((line) =>
      lineHasCommissionBasis({
        itemType: line.item_type,
        itemRefId: line.item_ref_id,
        commissionValue: line.commission_value,
        commissionPercentOverride: line.commission_percent_override ?? null,
        rules: args.rules,
        flatPercent,
      }),
    )
    .map((line) => {
      // Origen, tasa y monto se resuelven con los MISMOS argumentos: la tasa que
      // se muestra en el detalle no puede separarse del monto que se paga.
      const resolution = {
        itemType: line.item_type,
        itemRefId: line.item_ref_id,
        commissionValue: line.commission_value,
        commissionPercentOverride: line.commission_percent_override ?? null,
        rules: args.rules,
        flatPercent,
      };
      return {
        employee_id: args.employeeId,
        invoice_id: line.invoice_id,
        consecutive_number: line.consecutive_number,
        item_id: line.item_id,
        item_type: line.item_type,
        qty: line.qty,
        unit_price: line.unit_price,
        line_subtotal: roundMoney(line.line_subtotal),
        commission: resolveEmployeeLineCommission({
          ...resolution,
          subtotal: line.line_subtotal,
          qty: line.qty,
        }),
        commission_origin: employeeLineCommissionOrigin(resolution),
        commission_percent: employeeLineCommissionPercent(resolution),
        commission_value: line.commission_value,
      };
    });
}

/**
 * Origen de la comisión de una línea del detalle cuando la fila NO lo trae.
 *
 * Las filas persistidas ANTES de que el detalle guardara `commission_origin` no
 * lo tienen, y las de un período CERRADO no se pueden recalcular
 * (`assertDraftPeriod`). Deducirlo al LEER es lo único que hace que vuelvan a
 * mostrarse bien, sin tocar la base y sin recalcular comisiones: solo se
 * clasifica lo que la propia fila ya guarda.
 *
 * Precedencia (misma idea que `employeeLineCommissionOrigin`, con lo que la
 * fila sí guarda: las reglas ítem×empleado no se persisten en el detalle):
 *  1. el origen explícito manda;
 *  2. valor fijo del ítem (producto o personalizado con `commission_value` > 0)
 *     es "commission";
 *  3. una línea sin comisión no tiene origen que mostrar ("none");
 *  4. una comisión > 0 sin subtotal no pudo salir de un porcentaje (un
 *     porcentaje de un subtotal 0 es 0): es "commission";
 *  5. el porcentaje del empleado, cuando la fila lo guarda
 *     (`commission_percent`), confirma "percent";
 *  6. si nada decidió antes, el TIPO de ítem lo hace: un servicio o un
 *     personalizado sin valor solo comisionan por porcentaje, así que van a
 *     "percent"; un producto sin valor viene de una regla ítem×empleado y se
 *     queda en "commission" (el caso histórico, que era lo único que se
 *     mostraba bien).
 * Puro para probarlo sin base de datos.
 */
export function detailLineCommissionOrigin(line: {
  commission: number;
  commission_origin?: CommissionOrigin;
  item_type?: string;
  commission_value?: number | null;
  line_subtotal?: number;
  qty?: number;
  commission_percent?: number | null;
}): CommissionOrigin {
  if (line.commission_origin) return line.commission_origin;
  if (
    (line.item_type === "producto" || line.item_type === "custom") &&
    line.commission_value != null &&
    line.commission_value > 0
  ) {
    return "commission";
  }
  if (line.commission <= 0) return "none";
  if ((line.line_subtotal ?? 0) <= 0) return "commission";
  if (line.commission_percent != null && line.commission_percent > 0) return "percent";
  if (line.item_type === "producto") return "commission";
  return "percent";
}

/**
 * Reclasificación de la comisión de un ítem en sus dos orígenes para MOSTRAR:
 * la parte fija/producto y la parte por porcentaje. El total NO cambia.
 *
 * El porcentaje es la suma de las líneas con origen "percent" (cada una ya
 * viene redondeada a peso entero por `resolveEmployeeLineCommission`) y se topa
 * al total para que la resta nunca dé negativo. La parte fija se DERIVA por resta
 * (`total − porcentaje`): así las dos columnas suman EXACTAMENTE el total
 * almacenado aunque la suma de las líneas no cierre por redondeo. Una línea
 * porcentual nunca se paga de inmediato, así que en la práctica el porcentaje
 * siempre es menor o igual al total y el tope no recorta nada.
 * Puro para probarlo sin base de datos.
 *
 * Cada línea se clasifica con `detailLineCommissionOrigin`: las filas viejas,
 * sin `commission_origin`, también entran al porcentaje que les corresponde.
 */
export function splitCommissionByOrigin(args: {
  commissions: number;
  detail: Array<
    Pick<DetailLine, "commission" | "commission_percent"> & {
      commission_origin?: CommissionOrigin;
      item_type?: string;
      commission_value?: number | null;
      line_subtotal?: number;
      qty?: number;
    }
  >;
}): { fixed: number; percent: number } {
  const total = roundMoney(args.commissions);
  const percentLines = roundMoney(
    args.detail.reduce(
      (acc, line) =>
        detailLineCommissionOrigin(line) === "percent" ? acc + line.commission : acc,
      0,
    ),
  );
  const percent = Math.min(percentLines, total);
  return { fixed: roundMoney(total - percent), percent };
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
 * PAY-01: solo un periodo en borrador puede borrarse. Un periodo cerrado
 * tiene nómina pagada y es historia: borrarlo la destruiría. Puro para
 * probarlo sin base de datos.
 */
export function assertDeletablePeriod(status: string): void {
  if (status !== "borrador") {
    throw new Error("PERIOD_NOT_DRAFT");
  }
}

/**
 * PA-2b: solo un período CERRADO se corrige. Un borrador no se corrige: se
 * recalcula (es provisional y no hay versión firmada que preservar). Un
 * período cerrado es historia y no se reabre ni se pisa: se corrige con un
 * registro propio, con el mismo criterio que el reconteo de turno (033).
 * Puro para probarlo sin base de datos.
 */
export function assertCorrectablePeriod(status: string): void {
  if (status !== "cerrado") {
    throw new Error("PERIOD_NOT_CLOSED");
  }
}

/**
 * PAY-01: un borrador solo se bloquea por solapamiento con un período
 * CERRADO (nómina ya pagada: borrar el rango revertiría vales de historia).
 * Solapar con otros borradores no bloquea: nada está pagado y el borrador
 * restante puede recalcularse. Puro para probarlo sin base de datos.
 */
export function overlapBlocksDeletion(statuses: string[]): boolean {
  return statuses.some((status) => status === "cerrado");
}

/**
 * PAY-07: estado al que vuelve un vale que había quedado `descontada` cuando
 * se borra el borrador que lo descontó. La aprobación deja `approved_by`
 * informado (el flujo automático lo setea al crear dentro de rango); un vale
 * pendiente nunca lo tiene. Por eso `approved_by` distingue el estado previo
 * sin columna adicional. Puro para probarlo sin base de datos.
 */
export function restoreVoucherStatus(approvedBy: string | null): "aprobada" | "pendiente" {
  return approvedBy ? "aprobada" : "pendiente";
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

/** Un día en milisegundos: la aritmética de fechas de acá es siempre UTC. */
const DAY_MS = 86_400_000;

/** Día UTC (ms) de una fecha yyyy-mm-dd; `null` si no es una fecha del calendario. */
function utcDayOf(dateIso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Rechaza fechas que el calendario NORMALIZA (2026-02-30 → 2026-03-02): una
  // fecha imposible no puede convertirse en una porción de sueldo.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/** Largo real del mes (28…31) de un mes del calendario. */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * PR1/PAY-02: porción del sueldo MENSUAL que corresponde a los DÍAS de un
 * rango de fechas. `salary_fixed` es un valor por MES (003_admin.sql), así que
 * pagarlo tal cual en cada período paga el mes tantas veces como períodos
 * tenga: cuatro cierres semanales de septiembre pagaban 4 × el sueldo, sin
 * error y sin aviso.
 *
 * Fórmula (la regla del dueño: "el cálculo máximo que se le paga en esos
 * días"): por cada mes del calendario que el rango toca,
 *
 *     sueldo × (días de ese mes dentro del rango) / (días de ese mes)
 *
 * se SUMAN las porciones y se redondea UNA sola vez el total (peso entero,
 * `roundMoney`), igual que el resto del módulo. Un período que cubre un mes
 * completo da EXACTAMENTE el sueldo, sea el mes de 28, 29, 30 o 31 días; un
 * rango que cruza el fin de mes prorratea en los dos meses. NO es un tope del
 * mes: no mira los otros períodos ni limita la suma de varios (el dueño
 * rechazó explícitamente un tope mensual); la suma sólo cuadra si los períodos
 * no comparten días, y de eso se ocupa la guarda de solape (007+035).
 *
 * Puro para probarlo sin base de datos. Un rango invertido o una fecha
 * imposible LANZAN: devolver 0 en silencio sería pagar de menos sin señal.
 */
export function prorateFixedSalary(args: {
  salaryFixed: number | null | undefined;
  startDate: string;
  endDate: string;
}): number {
  const salary = Number(args.salaryFixed ?? 0);
  if (!Number.isFinite(salary) || salary <= 0) return 0;
  const start = utcDayOf(args.startDate);
  const end = utcDayOf(args.endDate);
  if (start === null || end === null || end < start) {
    throw new Error("INVALID_PERIOD_RANGE");
  }
  let total = 0;
  let cursor = start;
  while (cursor <= end) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month0 = date.getUTCMonth();
    const monthEnd = Date.UTC(year, month0 + 1, 1) - DAY_MS;
    const last = Math.min(end, monthEnd);
    const days = (last - cursor) / DAY_MS + 1;
    total += (salary * days) / daysInMonth(year, month0);
    cursor = last + DAY_MS;
  }
  return roundMoney(total);
}

// ------------------------------------------------ F3: cadencia y regla mixta ---

/** F3: cadencia válida, o null cuando no viene o no es una de las tres. */
export function normalizePayFrequency(value: string | null | undefined): PayFrequency | null {
  return value === "semanal" || value === "quincenal" || value === "mensual" ? value : null;
}

/**
 * F4: el "cubo de cadencia" con el que la BASE compara dos períodos en
 * `ex_payroll_periods_no_overlap` (063): `coalesce(frequency, '')`.
 *
 * En una restricción de exclusión gist un NULL NO es igual a otro NULL, así que
 * la base convierte la ausencia de cadencia en la cadena vacía para que dos
 * períodos SIN cadencia sigan siendo mutuamente excluyentes. El servicio TIENE
 * que comparar con el MISMO cubo: comparar la columna pelada soltaría en
 * silencio los períodos heredados (todos NULL) y debilitaría la protección de
 * siempre. Puro para probarlo sin base de datos.
 */
export function periodCadenceBucket(frequency: string | null | undefined): string {
  return frequency ?? "";
}

/* ---------------------------------------------------------- F11: filtro por
   cadencia ----------------------------------------------------------- */

/**
 * F11: el cajón SIN cadencia. Es el cubo `""` de `periodCadenceBucket` —los
 * períodos HEREDADOS, de antes de que la columna existiera—, no una cuarta
 * cadencia: por eso se nombra como constante y no se escribe el `""` suelto en
 * las tablas de la vista.
 */
export const PERIOD_CADENCE_LEGACY = "";

/**
 * F11: qué se puede elegir como filtro de cadencia. `todas` es el cajón que no
 * filtra; las tres cadencias son el catálogo cerrado (`payFrequencySchema`), y
 * `PERIOD_CADENCE_LEGACY` cubre los períodos heredados.
 *
 * No lleva un `string` suelto atrás a propósito: si mañana la base acepta otra
 * cadencia, el tipo obliga a declararla en el catálogo y no a colarla en un
 * `select`.
 */
export type PeriodCadenceFilter = "todas" | PayFrequency | typeof PERIOD_CADENCE_LEGACY;

/**
 * F11: las PESTAÑAS del filtro, en orden. Sólo existe una pestaña para la
 * cadencia que REALMENTE aparece en `periods`, más el cajón heredado si algún
 * período no tiene cadencia. Una cadencia sin períodos NO recibe pestaña: es
 * exactamente el espacio visual que el dueño pidió recuperar («si aún no le
 * pagué a un quincenal y no le toca, para qué hacer que se vea ocupando espacio
 * visual»).
 *
 * El orden es el CANÓNICO del catálogo (`payFrequencySchema.options`) y el
 * heredado va al final: el juego se lee siempre igual, se agreguen las filas
 * como se agreguen.
 *
 * `periods` debe entrar SIN filtrar por estado (lo llama la vista con la lista
 * entera): si las opciones salieran de la lista ya recortada, el filtro de
 * estado podría borrar el juego de pestañas entero y dejar al usuario sin forma
 * de volver a "todas".
 *
 * Reutiliza `periodCadenceBucket` —el cubo que ya usan la restricción de
 * solape, el piso y el recorrido de pendientes— en vez de repetir la regla.
 * Puro para probarlo sin base de datos.
 */
export function periodCadenceFilterOptions(
  periods: readonly { frequency?: string | null }[],
): PeriodCadenceFilter[] {
  const seen = new Set<string>();
  for (const period of periods) {
    seen.add(periodCadenceBucket(period.frequency ?? null));
  }
  const options: PeriodCadenceFilter[] = ["todas"];
  for (const frequency of payFrequencySchema.options) {
    if (seen.has(frequency)) options.push(frequency);
  }
  if (seen.has(PERIOD_CADENCE_LEGACY)) options.push(PERIOD_CADENCE_LEGACY);
  return options;
}

/**
 * F11: los períodos de UNA cadencia. Comparte el MISMO cubo que
 * `periodCadenceFilterOptions`, así que toda pestaña derivada de las opciones
 * devuelve al menos un período: una pestaña no puede quedar vacía por
 * construcción. `todas` devuelve la lista entera (copia, no la referencia).
 *
 * Puro para probarlo sin base de datos.
 */
export function filterPeriodsByCadence<TRow extends { frequency?: string | null }>(
  periods: readonly TRow[],
  filter: PeriodCadenceFilter,
): TRow[] {
  if (filter === "todas") return [...periods];
  const bucket = periodCadenceBucket(filter);
  return periods.filter((period) => periodCadenceBucket(period.frequency ?? null) === bucket);
}

/**
 * F11: cómo se nombra la cadencia de un período en la lista. Una cadencia
 * ausente NO se dibuja como cadena vacía: «Sin cadencia» es un dato honesto
 * (es un período heredado) y un vacío sería indistinguible de un bug de
 * formato.
 *
 * Devuelve la cadencia en MAYÚSCULA INICIAL porque es la palabra con la que
 * empieza la etiqueta de la fila, igual que el estado. Puro para probarlo sin
 * base de datos.
 */
export function periodCadenceLabel(frequency: string | null | undefined): string {
  const normalized = normalizePayFrequency(frequency);
  if (normalized === null) return "Sin cadencia";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

/** F11: la etiqueta de una PESTAÑA del filtro (el «todas» va en mayúsculas). */
export function periodCadenceFilterLabel(filter: PeriodCadenceFilter): string {
  return filter === "todas" ? "Todas" : periodCadenceLabel(filter);
}

/**
 * F11: la `key` de React de una opción del filtro. El cajón heredado es la
 * cadena vacía —su VALOR lo fija `periodCadenceBucket`, y ese valor no se
 * cambia— pero como clave necesita un nombre propio: se nombra acá UNA vez en
 * vez de repetir el `""` suelto por la vista.
 */
export function periodCadenceTabKey(filter: PeriodCadenceFilter): string {
  return filter === PERIOD_CADENCE_LEGACY ? "sin-cadencia" : filter;
}

/**
 * F4: true cuando el empleado NO pertenece a este período por cadencia: las
 * DOS están definidas y DIFIEREN. La regla del dueño (2026-10-01) lo excluye
 * ENTERO del período —sin fijo y sin comisiones, con sus facturas fuera de la
 * ventana— porque lo paga su propio ciclo.
 *
 * Si CUALQUIERA de las dos cadencias faltan (NULL = "sin cadencia definida") el
 * predicado es false y rige el comportamiento de hoy: prorrateo por días más
 * comisiones. Es deliberado que la comparación use las cadencias NORMALIZADAS
 * (un valor fuera del catálogo es ausencia, no una cadencia distinta).
 *
 * Puro para probarlo sin base de datos.
 */
export function periodExcludesEmployeeByCadence(args: {
  employeeFrequency: string | null | undefined;
  periodFrequency: string | null | undefined;
}): boolean {
  const employeeFrequency = normalizePayFrequency(args.employeeFrequency);
  const periodFrequency = normalizePayFrequency(args.periodFrequency);
  return (
    employeeFrequency !== null &&
    periodFrequency !== null &&
    employeeFrequency !== periodFrequency
  );
}

/**
 * F3: fracción del sueldo MENSUAL que paga cada cadencia sobre un mes comercial
 * de 30 días (el mes se cuenta como 4 semanas): semanal = 1/4, quincenal = 1/2,
 * mensual = 1. Sin cadencia no hay fracción (`null`): el fijo se sigue
 * prorrateando por los días calendario del período (`prorateFixedSalary`).
 *
 * Consecuencia ACEPTADA por el dueño (2026-10-01), que esta función no
 * contradice ni reabre: 1/4 por semana paga ≈ 13 sueldos al año (52,14
 * semanas), no 12. El mes comercial de 30 días es justamente lo que produce esa
 * cuenta.
 *
 * Puro para probarlo sin base de datos.
 */
export function fixedFractionForFrequency(frequency: string | null | undefined): number | null {
  switch (normalizePayFrequency(frequency)) {
    case "semanal":
      return 1 / 4;
    case "quincenal":
      return 1 / 2;
    case "mensual":
      return 1;
    default:
      return null;
  }
}

/**
 * F5: días del ciclo NATURAL de cada cadencia sobre el MISMO mes comercial de
 * 30 días que ya fija `fixedFractionForFrequency`: semanal = 7, quincenal = 15,
 * mensual = 30. Es la unidad con la que se prorratea el ciclo parcial de la
 * primera nómina (`1.500.000 / 4 × 4/7 = 214.286`): la fracción del dueño paga
 * un ciclo COMPLETO, y un período más corto paga la parte proporcional de ese
 * ciclo. Sin cadencia no hay ciclo (`null`): rige el prorrateo por días de hoy.
 */
export const PAY_CYCLE_DAYS: Record<PayFrequency, number> = {
  semanal: 7,
  quincenal: 15,
  mensual: 30,
};

/** F5: días del ciclo de una cadencia, o `null` cuando no hay cadencia definida. */
export function cycleDaysForFrequency(frequency: string | null | undefined): number | null {
  const normalized = normalizePayFrequency(frequency);
  return normalized === null ? null : PAY_CYCLE_DAYS[normalized];
}

/**
 * F5: días que cubre `[startDate, endDate]` contando los DOS extremos (el mismo
 * rango inclusivo del período). Un rango imposible devuelve `null`: el llamador
 * decide, y en la ruta de cadencia eso conserva el comportamiento de hoy.
 */
export function periodRangeDays(startDate: string, endDate: string): number | null {
  const start = utcDayOf(startDate);
  const end = utcDayOf(endDate);
  if (start === null || end === null || end < start) return null;
  return (end - start) / DAY_MS + 1;
}

// -------------------------------------- F7: ciclo cerrado (domingo–sábado) ---

/**
 * F7: días de CALENDARIO del ciclo cerrado de cada cadencia: semanal = 1 semana
 * = 7 días, quincenal = 2 semanas = 14, mensual = 4 semanas = 28. Es la unidad
 * con la que la nómina se cierra al ciclo (domingo a sábado) y NO es
 * `PAY_CYCLE_DAYS` (7/15/30), que es la base COMERCIAL de 30 días con la que se
 * prorratea un rango que no llega a ser un ciclo.
 */
export const PAY_CYCLE_CALENDAR_DAYS: Record<PayFrequency, number> = {
  semanal: 7,
  quincenal: 14,
  mensual: 28,
};

/** F7: días del ciclo cerrado de una cadencia, o `null` sin cadencia definida. */
export function calendarCycleDaysForFrequency(frequency: string | null | undefined): number | null {
  const normalized = normalizePayFrequency(frequency);
  return normalized === null ? null : PAY_CYCLE_CALENDAR_DAYS[normalized];
}

/**
 * F11: el CICLO RECORTADO, detectado. El primer ciclo de cada cadencia se
 * recorta al arranque de la nómina, así que un mensual puede terminar pagando
 * 7 de sus 28 días: sin declararlo, el dueño lo lee como un error de cálculo.
 * La función devuelve las PARTES de esa frase (`days` y `cycleDays`) y no el
 * texto: la redacción es de la vista y los números salen de las MISMAS tablas
 * que usa el resto del módulo —`periodRangeDays` y
 * `calendarCycleDaysForFrequency`—, así que nadie escribe un 7 ni un 28 a mano.
 *
 * `trimmed` es `false` en los tres casos en que NO se puede afirmar el recorte:
 * ciclo completo, período heredado sin cadencia (no hay ciclo contra el cual
 * comparar) y rango ilegible. Puro para probarlo sin base de datos.
 */
export interface PayrollTrimmedCycle {
  /** El rango es MÁS CORTO que el ciclo natural de su cadencia. */
  trimmed: boolean;
  /** Días del rango (inclusivos), o `null` si el rango no se puede leer. */
  days: number | null;
  /** Días del ciclo cerrado de la cadencia, o `null` si no hay cadencia. */
  cycleDays: number | null;
}

export function payrollTrimmedCycle(args: {
  frequency: string | null | undefined;
  startDate: string;
  endDate: string;
}): PayrollTrimmedCycle {
  const days = periodRangeDays(args.startDate, args.endDate);
  const cycleDays = calendarCycleDaysForFrequency(args.frequency);
  return {
    trimmed: days !== null && cycleDays !== null && days < cycleDays,
    days,
    cycleDays,
  };
}

/** Día de la semana UTC de un día (ms): 0 = domingo … 6 = sábado. */
function utcWeekday(dayMs: number): number {
  return new Date(dayMs).getUTCDay();
}

/** Fecha yyyy-mm-dd del día UTC (ms), con la misma aritmética UTC del módulo. */
function isoDayOf(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/** Sábado en o ANTES del día dado (ms): el cierre del ciclo que lo contiene. */
function saturdayOnOrBefore(dayMs: number): number {
  return dayMs - ((utcWeekday(dayMs) + 1) % 7) * DAY_MS;
}

/** Sábado en o DESPUÉS del día dado (ms): cierra el ciclo que lo contiene. */
function saturdayOnOrAfter(dayMs: number): number {
  return dayMs + ((6 - utcWeekday(dayMs) + 7) % 7) * DAY_MS;
}

/** F7: rango inclusivo de UN ciclo cerrado (domingo a sábado). */
export interface PayrollCycleRange {
  start_date: string;
  end_date: string;
}

/**
 * F7: deriva el rango de UN ciclo cerrado de la cadencia.
 *
 *  - Con `cycleEndDate` (el sábado que cierra el ciclo), valida que sea sábado
 *    y devuelve `[end − (días−1), end]`.
 *  - Con `referenceDate`, devuelve el ciclo que CONTIENE esa fecha (su cierre es
 *    el sábado en o después de ella).
 *  - Sin cadencia, con una fecha imposible o con un cierre que no es sábado,
 *    devuelve `null`: el llamador decide, y el período NUEVO rechaza el envío.
 *
 * Puro para probarlo sin base de datos. Es la ÚNICA aritmética de ciclos: el
 * diálogo, el esquema y el servicio la comparten.
 */
export function payrollCycleRange(args: {
  frequency: string | null | undefined;
  cycleEndDate?: string | null;
  referenceDate?: string | null;
}): PayrollCycleRange | null {
  const cycleDays = calendarCycleDaysForFrequency(args.frequency);
  if (cycleDays === null) return null;
  const explicit = args.cycleEndDate ?? null;
  const reference = args.referenceDate ?? null;
  let end: number | null = null;
  if (explicit !== null) {
    const day = utcDayOf(explicit);
    if (day === null || utcWeekday(day) !== 6) return null;
    end = day;
  } else if (reference !== null) {
    const day = utcDayOf(reference);
    if (day === null) return null;
    end = saturdayOnOrAfter(day);
  }
  if (end === null) return null;
  const start = end - (cycleDays - 1) * DAY_MS;
  return { start_date: isoDayOf(start), end_date: isoDayOf(end) };
}

/**
 * F7: sábado que cierra el ÚLTIMO ciclo COMPLETADO a la fecha de referencia. Un
 * ciclo se completa cuando ya pasó su sábado, así que el cierre es el sábado
 * ANTERIOR a la referencia: el domingo se liquida la semana que terminó el día
 * anterior (el caso real del dueño).
 */
export function lastCompletedCycleEndDate(referenceDate: string): string | null {
  const day = utcDayOf(referenceDate);
  if (day === null) return null;
  return isoDayOf(saturdayOnOrBefore(day - DAY_MS));
}

/** F7: opción de ciclo para el diálogo: su rango y su etiqueta legible. */
export interface PayrollCycleOption extends PayrollCycleRange {
  label: string;
}

const MONTHS_SHORT_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Etiqueta de un rango de ciclo ("30 ago – 5 sep 2026"; "1 – 7 sep 2026"). */
function cycleRangeLabel(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const sameMonth =
    start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  const startText = sameMonth
    ? `${start.getUTCDate()}`
    : `${start.getUTCDate()} ${MONTHS_SHORT_ES[start.getUTCMonth()]}`;
  return `${startText} – ${end.getUTCDate()} ${MONTHS_SHORT_ES[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

/**
 * F7: los últimos `count` ciclos COMPLETADOS de la cadencia, el más reciente
 * primero. Es la lista que alimenta el selector del diálogo: cada opción lleva
 * su etiqueta con el rango YA calculado, así el dueño VE qué ciclo elige y las
 * fechas no se escriben a mano. El primero es el que se ofrece por defecto (la
 * liquidación del domingo cubre la semana que cerró el sábado anterior).
 *
 * Sin cadencia no hay ciclos (`[]`), igual que `payrollCycleRange` devuelve
 * `null`: la ausencia de cadencia no inventa un ciclo.
 */
export function lastCompletedPayrollCycles(args: {
  frequency: string | null | undefined;
  referenceDate: string;
  count?: number;
}): PayrollCycleOption[] {
  const cycleDays = calendarCycleDaysForFrequency(args.frequency);
  if (cycleDays === null) return [];
  const lastEnd = utcDayOf(lastCompletedCycleEndDate(args.referenceDate) ?? "");
  if (lastEnd === null) return [];
  const count = Math.max(0, Math.trunc(args.count ?? 8));
  const options: PayrollCycleOption[] = [];
  for (let index = 0; index < count; index += 1) {
    const end = lastEnd - index * cycleDays * DAY_MS;
    const start = end - (cycleDays - 1) * DAY_MS;
    options.push({
      start_date: isoDayOf(start),
      end_date: isoDayOf(end),
      label: cycleRangeLabel(start, end),
    });
  }
  return options;
}

/**
 * F7: true cuando `[startDate, endDate]` es EXACTAMENTE un ciclo cerrado de la
 * cadencia. La regla, literal: el rango empieza DOMINGO, termina SÁBADO y dura
 * 7, 14 o 28 días contando los DOS extremos. Un lunes, un rango de 8/13/29 días
 * o uno corrido un día NO son un ciclo; sin cadencia tampoco hay ciclo.
 *
 * Puro para probarlo sin base de datos. Es la misma verdad que `payrollCycleRange`
 * construye, comprobada desde el rango en vez de desde el cierre.
 */
export function isPayrollCycleRange(args: {
  frequency: string | null | undefined;
  startDate: string;
  endDate: string;
}): boolean {
  const cycleDays = calendarCycleDaysForFrequency(args.frequency);
  if (cycleDays === null) return false;
  const start = utcDayOf(args.startDate);
  const end = utcDayOf(args.endDate);
  if (start === null || end === null || end < start) return false;
  if (utcWeekday(start) !== 0) return false;
  if (utcWeekday(end) !== 6) return false;
  return (end - start) / DAY_MS + 1 === cycleDays;
}

/**
 * F5/F7: factor con el que se escala la fracción de la cadencia cuando el
 * período cubre un ciclo PARCIAL (la primera liquidación suele ser un rango
 * corto, desde el día en que arrancó el negocio).
 *
 *  - Rango que ES un ciclo cerrado de la cadencia (F7: domingo a sábado, 7/14/28
 *    días) → `1`: el ciclo paga la fracción entera aunque la base comercial de
 *    30 días sea más larga. El mensual de 4 semanas son 28 días, no 30: sin
 *    esto un cierre mensual pagaría 28/30 del sueldo y los 13 cierres del año
 *    no serían 13 sueldos (la consecuencia aceptada por el dueño).
 *  - Rango MÁS CORTO que el ciclo comercial → `días del período / días del ciclo`
 *    (semanal 4 días → `4/7`).
 *  - Rango IGUAL o MÁS LARGO → `1`: se paga el ciclo completo y NUNCA más de
 *    uno. Un período de un mes natural (28…31 días) no puede pagar 31/30 de una
 *    fracción: el tope evita que un rango que se pasa por uno o dos días pague
 *    de más. Si se quisiera pagar dos ciclos, serían dos períodos.
 *  - Sin cadencia o con un rango imposible → `1`, que deja la fracción como
 *    estaba (esa rama la gobierna `basis = "prorated"`).
 *
 * Puro para probarlo sin base de datos.
 */
export function cycleProrationFactor(args: {
  frequency: string | null | undefined;
  startDate: string;
  endDate: string;
}): number {
  const cycleDays = cycleDaysForFrequency(args.frequency);
  const rangeDays = periodRangeDays(args.startDate, args.endDate);
  if (cycleDays === null || rangeDays === null) return 1;
  // F7: un ciclo cerrado paga la fracción entera (el mensual son 28 días, no 30).
  if (
    isPayrollCycleRange({
      frequency: args.frequency,
      startDate: args.startDate,
      endDate: args.endDate,
    })
  ) {
    return 1;
  }
  // TOPE del ciclo: un rango más largo que el ciclo no paga más de la fracción.
  if (rangeDays >= cycleDays) return 1;
  return rangeDays / cycleDays;
}

// ------------- F10: el arranque de la nómina, derivado de los períodos ---

/**
 * F10 (decisión del dueño, 2026-10-04): el arranque de la nómina es un HECHO
 * derivado, no una configuración — es `min(payroll_periods.start_date)`, el día
 * del primer período que existe. Ésta es la regla 4 por evidencia que el módulo
 * ya aplicaba (`floor = fecha ?? historia`): lo que cambia es que ya no hay una
 * fecha configurada que compita con ella.
 *
 * Sin períodos NO hay arranque —y no hay historia que recorrer: eso no es un
 * vacío mudo, es lo que hace que la PRIMERA liquidación tenga que declarar la
 * fecha desde la que se opera (`resolveOpenPayrollRange`).
 *
 * Un período con `start_date` imposible no acota (mismo criterio que
 * `isRangeBeforePayrollStart`): si ninguno acota, no hay piso.
 *
 * Puro para probarlo sin base de datos. Es la derivación que usan el resumen, la
 * apertura y la pantalla: una sola definición de «desde cuándo existe la nómina».
 */
export function payrollHistoryFloor(
  periods: readonly (DateRange & { start_date?: string | null })[],
): string | null {
  let floor: number | null = null;
  for (const period of periods) {
    const start = utcDayOf(period.start_date ?? "");
    if (start === null) continue;
    if (floor === null || start < floor) floor = start;
  }
  return floor === null ? null : isoDayOf(floor);
}

/**
 * F10: el día que declara la PRIMERA liquidación cuando nadie lo escribió.
 *
 * Cuando la instalación no tiene ningún período, el ciclo que se va a liquidar
 * YA está elegido, así que su PRIMER día es la fecha desde la que opera la
 * nómina: pedir que se teclee obliga al dueño a repetir un dato que el sistema
 * ya tiene. La fecha se DERIVA del ciclo y no se pregunta; lo que se escriba la
 * pisa.
 *
 * El default es válido POR CONSTRUCCIÓN: `cycleStartDate` es exactamente el
 * `min` del campo de fecha y su `max` es `min(cierre del ciclo, hoy)` —con los
 * ciclos pendientes ya CERRADOS, el inicio nunca cae después del tope—, así que
 * el valor derivado siempre cae dentro de la ventana admisible. No es una cota
 * nueva ni relaja la declaración: es el mismo día que antes se tecleaba.
 *
 * Puro para probarlo sin base de datos y definido UNA sola vez: el campo del
 * diálogo y el cuerpo del envío lo consumen del mismo lugar.
 */
export function declaredStartForFirstLiquidation(args: {
  /** Lo que se escribió en el campo; vacío es «no se escribió nada». */
  typed: string;
  /** El primer día del ciclo ofrecido (el `min` del campo de fecha). */
  cycleStartDate: string;
}): string {
  return args.typed || args.cycleStartDate;
}

/**
 * F10: ¿este rango queda ENTERO antes del arranque de la nómina?
 *
 * LA regla del arranque, en UNA sola definición: un rango es ANTERIOR cuando su
 * ÚLTIMO día es anterior al arranque. El detector de pendientes la usa para no
 * ofrecer un ciclo anterior y el servicio la usa para rechazar la apertura de un
 * período anterior, así que el aviso y el servicio no pueden decir cosas
 * distintas del mismo ciclo.
 *
 * Un rango que CONTIENE el arranque (empieza antes y termina después) NO queda
 * antes: es el ciclo en el que arranca la nómina y se RECORTA a él (ver
 * `resolveOpenPayrollRange`) — es el PRIMER ciclo, no un ciclo anterior.
 *
 * Sin arranque (`null`) no hay cota: `false`, y el llamador conserva el
 * comportamiento del recorrido sin piso (que es ofrecer los ciclos cerrados más
 * recientes).
 */
export function isRangeBeforePayrollStart(args: {
  payrollStartDate: string | null | undefined;
  startDate: string;
  endDate: string;
}): boolean {
  const start = utcDayOf(args.payrollStartDate ?? "");
  if (start === null) return false;
  const end = utcDayOf(args.endDate);
  if (end === null) return false;
  return end < start;
}

/** F10: por qué un ciclo NO se puede abrir. */
export type OpenPayrollRangeRejection =
  | "not-a-cycle"
  | "before-start"
  | "not-first-cycle"
  /** La primera liquidación llegó sin declarar desde qué día se opera. */
  | "declared-required"
  /** La fecha declarada no cae dentro del ciclo que se quiere liquidar. */
  | "declared-outside-cycle"
  /** La fecha declarada es un día que todavía no pasó. */
  | "declared-in-the-future"
  /** Llegó una fecha declarada y ya hay períodos: el piso lo dan ellos. */
  | "declared-with-history";

/** F10: el rango que se persiste, con `trimmed` a la vista. */
export interface OpenPayrollRange extends PayrollCycleRange {
  /**
   * F10: true cuando el ciclo se RECORTÓ a la fecha de arranque. Es el PRIMER
   * ciclo de la cadencia: paga una parte del ciclo y la prorrata de F5 ya lo
   * resuelve por el rango (no hay aritmética nueva).
   */
  trimmed: boolean;
}

/** F10: el rango admisible, o el motivo del rechazo. */
export type OpenPayrollRangeResolution =
  | ({ ok: true } & OpenPayrollRange)
  | { ok: false; reason: OpenPayrollRangeRejection };

/**
 * F10: el ÚNICO validador de la forma de un período NUEVO, con el arranque de la
 * nómina y la historia de la cadencia a la vista. Acepta EXACTAMENTE dos formas
 * y rechaza todo lo demás:
 *
 *   1. Un ciclo COMPLETO de la cadencia (domingo a sábado, 7/14/28 días): la
 *      forma normal de todos los ciclos posteriores al primero.
 *   2. El PRIMER ciclo —el que CONTIENE el arranque— RECORTADO a él: empieza el
 *      día del arranque y termina el sábado del ciclo. Sólo vale como PRIMERO:
 *      con otro período de la MISMA cadencia ya registrado, el recorte dejaría
 *      de ser «el primero» y se rechaza (`not-first-cycle`), porque la única
 *      primera liquidación de la cadencia ya ocurrió.
 *
 * El arranque tiene UNA sola fuente y depende de si la instalación ya liquidó
 * (decisión del dueño, 2026-10-04):
 *
 *   - **Sin períodos**: no hay nada de dónde derivarlo, así que la PRIMERA
 *     liquidación lo DECLARA (`declaredStartDate`). Sin declaración no hay
 *     primer período (`declared-required`): el piso no puede nacer mudo. Y la
 *     declaración se valida —dentro del ciclo elegido (`declared-outside-cycle`)
 *     y no en el futuro (`declared-in-the-future`)— porque el recorte sólo
 *     existe sobre el ciclo que se liquida.
 *   - **Con períodos**: el arranque es `payrollHistoryFloor` (`payrollStartDate`)
 *     y una fecha declarada ya NO se acepta (`declared-with-history`): nadie la
 *     manda, porque el piso son los períodos.
 *
 * Un ciclo que cierra ANTES del arranque no existe para el sistema
 * (`before-start`): no se ofrece ni se liquida. Un cierre que no es sábado no es
 * un ciclo (`not-a-cycle`) — la misma verdad de `payrollCycleRange`.
 *
 * `frequency` viaja aparte (y no dentro del ciclo) porque no toda cadencia con
 * historia la tiene en sus períodos: los heredados son `NULL` y NO son historia
 * de ninguna cadencia.
 *
 * Puro para probarlo sin base de datos. Es la MISMA verdad que el detector de
 * pendientes (`isRangeBeforePayrollStart`) y la que el servicio aplica antes del
 * INSERT.
 */
export function resolveOpenPayrollRange(args: {
  frequency: PayFrequency;
  cycleEndDate: string;
  /**
   * El PISO derivado de los períodos existentes
   * (`payrollHistoryFloor`); `null` cuando todavía no hay ninguno.
   */
  payrollStartDate?: string | null;
  /** La fecha que declara la PRIMERA liquidación: sólo con cero períodos. */
  declaredStartDate?: string | null;
  periods: readonly (DateRange & { frequency?: string | null })[];
  /**
   * El día de HOY (Bogotá, la MISMA convención del módulo) para no aceptar una
   * fecha que todavía no pasó. Opcional: sin él no se comprueba esa mitad.
   */
  referenceDate?: string | null;
}): OpenPayrollRangeResolution {
  const cycle = payrollCycleRange({ frequency: args.frequency, cycleEndDate: args.cycleEndDate });
  if (cycle === null) return { ok: false, reason: "not-a-cycle" };
  const hasHistory = args.periods.length > 0;

  // La declaración se valida ANTES de ser cota: una fecha que no sirve ni para
  // recortar el ciclo elegido no puede quedarse flotando como si arrancara algo.
  // Un texto vacío es «no declarada» (el campo sin escribir), no una fecha mala.
  const declaredText = (args.declaredStartDate ?? "").trim();
  const declaredRaw = declaredText === "" ? null : declaredText;
  const declared = declaredRaw === null ? null : utcDayOf(declaredRaw);
  if (declaredRaw !== null) {
    if (hasHistory) return { ok: false, reason: "declared-with-history" };
    const cycleStart = utcDayOf(cycle.start_date);
    const cycleEnd = utcDayOf(cycle.end_date);
    // Un día IMPOSIBLE no es una fecha.
    if (declared === null || cycleStart === null || cycleEnd === null) {
      return { ok: false, reason: "declared-outside-cycle" };
    }
    // Un día que todavía no pasó no puede ser el arranque de nada.
    if (args.referenceDate != null) {
      const today = utcDayOf(args.referenceDate);
      if (today !== null && declared > today) return { ok: false, reason: "declared-in-the-future" };
    }
    // El recorte sólo existe sobre el ciclo elegido: la fecha tiene que caer
    // DENTRO de él (los dos extremos incluidos: el primer día ya es ciclo
    // completo y el cierre es el recorte más corto posible).
    if (declared < cycleStart || declared > cycleEnd) {
      return { ok: false, reason: "declared-outside-cycle" };
    }
  }

  // El PISO: la fecha declarada cuando la hay —es el primer período, y entonces
  // ES el arranque—, si no el derivado de los períodos que ya existen.
  const startBound = declared === null ? (args.payrollStartDate ?? null) : isoDayOf(declared);
  // Sin piso y sin declaración no hay primer período: el arranque se declara.
  if (startBound === null) {
    if (!hasHistory) return { ok: false, reason: "declared-required" };
    return { ok: true, ...cycle, trimmed: false };
  }
  const boundary = utcDayOf(startBound);
  const cycleStart = utcDayOf(cycle.start_date);
  if (boundary === null || cycleStart === null) return { ok: false, reason: "not-a-cycle" };
  // Un ciclo que cierra antes del arranque es ANTERIOR: la misma regla que el
  // aviso de pendientes. El arranque es el ÚLTIMO día que el período puede tocar.
  if (
    isRangeBeforePayrollStart({
      payrollStartDate: startBound,
      startDate: cycle.start_date,
      endDate: cycle.end_date,
    })
  ) {
    return { ok: false, reason: "before-start" };
  }
  // El ciclo arranca DESPUÉS del arranque: es un ciclo completo, la forma normal.
  if (cycleStart >= boundary) return { ok: true, ...cycle, trimmed: false };
  // El ciclo CONTIENE el arranque: es el PRIMER ciclo y se recorta. Su único
  // título es ser el primero: con historia en la MISMA cadencia, el recorte ya
  // no es «la primera liquidación» y se rechaza.
  const bucket = periodCadenceBucket(args.frequency);
  const hasCadenceHistory = args.periods.some(
    (period) => periodCadenceBucket(period.frequency ?? null) === bucket,
  );
  if (hasCadenceHistory) return { ok: false, reason: "not-first-cycle" };
  return { ok: true, start_date: startBound, end_date: cycle.end_date, trimmed: true };
}

/**
 * F10: el mensaje de un rechazo, en UNA sola voz para el servicio (que responde
 * a un envío) y para la pantalla (que avisa mientras se escribe). Que los dos
 * digan lo mismo no es decoración: es la misma regla contada dos veces.
 *
 * `payrollStartDate` es el PISO (derivado o declarado) y `cycle` el ciclo
 * rechazado; los dos se nombran cuando el motivo los necesita.
 */
export function openPayrollRejectionMessage(
  reason: OpenPayrollRangeRejection,
  args: { payrollStartDate?: string | null; cycle?: PayrollCycleRange | null } = {},
): string {
  const startDate = args.payrollStartDate ?? null;
  const cycle = args.cycle ?? null;
  if (reason === "not-a-cycle") return "El cierre del ciclo debe ser un sábado.";
  if (reason === "before-start") {
    return `Este ciclo cierra antes del ${startDate}, el día del primer período: la nómina de la instalación arranca ese día y nada anterior existe para el sistema.`;
  }
  if (reason === "not-first-cycle") {
    return `El ciclo ${cycle?.start_date ?? ""} a ${cycle?.end_date ?? ""} contiene el arranque de la nómina (${startDate}), pero esta cadencia ya tiene períodos: el primer ciclo recortado sólo se abre como PRIMERA liquidación de la cadencia. Elija un ciclo completo posterior.`;
  }
  if (reason === "declared-required") {
    return "La primera liquidación declara desde qué día opera la nómina: elija la fecha de inicio del ciclo que va a liquidar.";
  }
  if (reason === "declared-outside-cycle") {
    return `La fecha de inicio debe caer dentro del ciclo elegido (${cycle?.start_date ?? ""} a ${cycle?.end_date ?? ""}): ese es el único ciclo que se recorta a ese día.`;
  }
  if (reason === "declared-in-the-future") {
    return "La fecha de inicio no puede ser un día que todavía no pasó.";
  }
  return "La fecha de inicio sólo se declara en la primera liquidación: con períodos registrados, el arranque lo da el período más antiguo.";
}

// ------------------- F9: ciclos cerrados que faltan por liquidar ---

/**
 * F9 (pedido del dueño, 2026-10-02): cuántos ciclos PENDIENTES se listan por
 * cadencia. La pantalla avisa de los que faltan, no de una historia sin fin: con
 * una sede que viene atrasada hace meses, los tres ciclos más recientes de cada
 * cadencia alcanzan para que el atraso se vea, y el tope evita que el aviso
 * crezca sin control. El tope es POR CADENCIA: una cadencia muy atrasada no
 * puede tapar a las otras dos.
 */
export const PENDING_SETTLEMENT_LIMIT = 3;

/**
 * F9: cuántos NOMBRES lleva cada entrada pendiente. Los nombres ya están en
 * memoria (vienen con la planta), así que nombrar a unos pocos es gratis; el
 * tope sólo evita una entrada ilegible cuando la cadencia tiene mucha gente. El
 * `employeeCount` sigue diciendo el total.
 */
export const PENDING_SETTLEMENT_NAME_LIMIT = 3;

/** F9: un ciclo cerrado de la sede que todavía no tiene liquidación. */
export interface PendingPayrollSettlement {
  /** Cadencia del ciclo (y de los empleados que cobran por ella). */
  frequency: PayFrequency;
  start_date: string;
  end_date: string;
  /** Etiqueta legible del rango (`20 sep – 3 oct 2026`), la misma del selector. */
  label: string;
  /** Cuántos empleados ACTIVOS de la sede cobran con esa cadencia. */
  employeeCount: number;
  /** Hasta `PENDING_SETTLEMENT_NAME_LIMIT` nombres, en orden determinista. */
  employeeNames: string[];
}

/**
 * F9: true cuando la sede YA pagó los días de ese ciclo por esa cadencia. Cubre
 * por SOLAPE (`rangesOverlap`, la misma cuenta de la base y el servicio), no por
 * coincidencia exacta: un período que comparte días ya pagó esos días.
 *
 * La CADENCIA se compara con una asimetría deliberada:
 *  - Un período de la MISMA cadencia cubre: es su liquidación.
 *  - Un período de OTRA cadencia NO cubre: el semanal y el mensual comparten días
 *    A PROPÓSITO (regla del dueño), así que uno no tacha al otro.
 *  - Un período HEREDADO sin cadencia (`NULL`, de antes de F7) cubre CUALQUIER
 *    cadencia: no lo acotaba ningún ciclo, así que pagó el fijo a todo el plantel
 *    y esos días ya salieron de la nómina. Tratarlo como un cubo más —el `''` de
 *    `coalesce(frequency, '')`, que la guarda de solape sí usa— dejaría el ciclo
 *    reportándose como pendiente para siempre y el aviso gritaría de más: un
 *    aviso que grita de más deja de mirarse.
 *
 * Reutiliza `periodCadenceBucket` y `rangesOverlap` —las MISMAS reglas del
 * servicio, la guarda y la base— en vez de repetir aritmética. Puro para
 * probarlo sin base de datos: es también lo que el selector y la guarda de
 * apertura del diálogo usan para decidir si un ciclo se puede liquidar, así que
 * el aviso, las marcas del selector y el diálogo no pueden decir cosas distintas
 * del mismo ciclo.
 */
export function isPayrollCycleSettled(args: {
  periods: readonly (DateRange & { frequency?: string | null })[];
  frequency: string | null | undefined;
  cycle: DateRange;
}): boolean {
  const cadence = normalizePayFrequency(args.frequency);
  if (cadence === null) return false;
  return args.periods.some((period) => {
    if (!rangesOverlap(period, args.cycle)) return false;
    const bucket = periodCadenceBucket(period.frequency ?? null);
    // Cubo vacío = período heredado sin cadencia: le pagó a todos, así que cubre.
    return bucket === "" || bucket === cadence;
  });
}

/**
 * F9: los ciclos CERRADOS de la sede que todavía no tienen liquidación, por
 * cadencia, con lo que la pantalla necesita para decir "falta liquidar esto" y
 * para abrirlo ya posicionado en ese ciclo.
 *
 * Reglas (todas puras, sin base de datos):
 *  1. Sólo cuenta una cadencia cuando AL MENOS UN empleado ACTIVO la tiene. Sin
 *     gente de esa cadencia no hay nada que liquidar y no se reporta (un `null` o
 *     un valor fuera del catálogo es ausencia de cadencia, no una cadencia más).
 *  2. Sólo cuenta un ciclo ya CERRADO: su sábado es anterior a la fecha de
 *     referencia (`lastCompletedCycleEndDate`, la misma cuenta de F7). El ciclo en
 *     curso no se reporta: todavía no ha terminado.
 *  3. Un ciclo CUBIERTO no se reporta (`isPayrollCycleSettled`): lo cubre un
 *     período de su MISMA cadencia —el que se solapa o coincide exactamente ya se
 *     liquidó o se está liquidando en borrador— o un período HEREDADO sin
 *     cadencia, que le pagó a todo el plantel.
 *  4. No se reporta historia ANTERIOR al arranque de la nómina: el recorrido se
 *     detiene en el día del primer período (`payrollHistoryFloor`) —antes de
 *     ahí no había nada que liquidar— y un ciclo que terminó antes no aparece.
 *  5. La lista se TOPA en `limit` ciclos (3 por defecto) POR CADENCIA, tomando
 *     los más recientes, y se ordena con el más atrasado PRIMERO (por fecha de
 *     cierre) para que lo más vencido se vea arriba.
 *
 * F10 (decisión del dueño, 2026-10-04): el arranque es un HECHO DERIVADO —`min(
 * payroll_periods.start_date)`—, no una configuración, así que este recorrido no
 * recibe ninguna fecha. Y SIN períodos NO hay arranque: en vez de devolver `[]`
 * (que dejaba a la instalación nueva sin nada que liquidar y sin forma de
 * declarar su fecha) ofrece los últimos ciclos cerrados de cada cadencia, con el
 * tope de siempre como único límite. Sin piso, el tope ES el alcance del
 * recorrido: son `limit` ciclos hacia atrás y ni uno más.
 *
 * El rango que se REPORTA es el que se va a abrir: el del ciclo, recortado al
 * arranque cuando el arranque cae dentro de él (el PRIMER ciclo de la cadencia).
 *
 * `referenceDate` es un día de Bogotá (lo resuelve el llamador, `bogotaDay()`), la
 * MISMA convención de fechas del resto del módulo.
 *
 * Puro para probarlo sin base de datos.
 */
export function pendingPayrollSettlements(args: {
  periods: readonly (DateRange & { frequency?: string | null })[];
  employees: readonly {
    full_name: string;
    pay_frequency?: string | null;
    is_active?: boolean;
  }[];
  referenceDate: string;
  limit?: number;
}): PendingPayrollSettlement[] {
  const lastEnd = utcDayOf(lastCompletedCycleEndDate(args.referenceDate) ?? "");
  if (lastEnd === null) return [];

  // F10: el piso del recorrido es el primer período que existe, y sólo él. Se
  // parsea una sola vez; un período con fecha imposible no acota (el mismo
  // criterio que `isRangeBeforePayrollStart`).
  const floor = payrollHistoryFloor(args.periods);
  const floorDay = floor === null ? null : utcDayOf(floor);

  // Regla 1: la planta que importa es la ACTIVA. Un empleado dado de baja no
  // puede dejar un aviso de "falta liquidar" que nunca se pueda cerrar.
  const namesByFrequency = new Map<PayFrequency, string[]>();
  for (const employee of args.employees) {
    if (employee.is_active === false) continue;
    const frequency = normalizePayFrequency(employee.pay_frequency ?? null);
    if (frequency === null) continue;
    const bucket = namesByFrequency.get(frequency);
    if (bucket) bucket.push(employee.full_name);
    else namesByFrequency.set(frequency, [employee.full_name]);
  }

  const limit = Math.max(0, Math.trunc(args.limit ?? PENDING_SETTLEMENT_LIMIT));
  if (limit === 0) return [];

  const pending: PendingPayrollSettlement[] = [];
  // El catálogo cerrado es UNA sola definición (`payFrequencySchema.options`):
  // una cadencia nueva entra acá sin tocar este recorrido.
  for (const frequency of payFrequencySchema.options) {
    const cadenceNames = namesByFrequency.get(frequency);
    if (cadenceNames === undefined || cadenceNames.length === 0) continue;
    const cycleDays = calendarCycleDaysForFrequency(frequency);
    if (cycleDays === null) continue;

    let found = 0;
    // F10: sin piso (instalación sin períodos) el tope POR CADENCIA es el
    // alcance del recorrido: son `limit` ciclos hacia atrás y ni uno más. Con
    // piso, el recorrido se detiene ahí (nada anterior al primer período).
    const walkFloor = floorDay === null ? lastEnd - cycleDays * DAY_MS * limit : floorDay;
    // Del ciclo completado MÁS RECIENTE hacia atrás: los primeros sin cubrir son
    // los que el tope conserva.
    for (let end = lastEnd; end >= walkFloor; end -= cycleDays * DAY_MS) {
      const start = end - (cycleDays - 1) * DAY_MS;
      const cycle = { start_date: isoDayOf(start), end_date: isoDayOf(end) };
      // F10: un ciclo ANTERIOR al arranque de la nómina no existe para el
      // sistema: no se ofrece ni se liquida (la MISMA regla que el servicio).
      if (
        isRangeBeforePayrollStart({
          payrollStartDate: floor,
          startDate: cycle.start_date,
          endDate: cycle.end_date,
        })
      ) {
        break;
      }
      if (isPayrollCycleSettled({ periods: args.periods, frequency, cycle })) continue;
      // F10: el rango REPORTADO es el que se va a abrir. Cuando el arranque
      // (el día del primer período) cae DENTRO de este ciclo, es el PRIMER
      // ciclo de la cadencia y su rango se recorta a él (la MISMA forma que el
      // servicio persiste), así el aviso dice lo que se va a liquidar y no un
      // ciclo completo que la nómina nunca va a pagar como tal.
      const reportedStart = floorDay !== null && floorDay > start ? floorDay : start;
      pending.push({
        frequency,
        start_date: isoDayOf(reportedStart),
        end_date: cycle.end_date,
        label: cycleRangeLabel(reportedStart, end),
        employeeCount: cadenceNames.length,
        // Orden determinista: el mismo atraso se lee igual en cada corrida, sin
        // depender del orden en que la planta llegó del servidor.
        employeeNames: [...cadenceNames].sort().slice(0, PENDING_SETTLEMENT_NAME_LIMIT),
      });
      found += 1;
      if (found >= limit) break;
    }
  }

  // El más atrasado primero: por fecha de CIERRE (la que marca el atraso) y, a
  // igualdad, por el orden del catálogo de cadencias.
  return pending.sort((left, right) => {
    if (left.end_date !== right.end_date) return left.end_date < right.end_date ? -1 : 1;
    return (
      payFrequencySchema.options.indexOf(left.frequency) -
      payFrequencySchema.options.indexOf(right.frequency)
    );
  });
}

/**
 * F3: cómo se resolvió el fijo de un período. `basis` hace EXPLÍCITA la regla
 * aplicada en vez de dejarla deducir del monto:
 *  - "cadence": el período y el empleado comparten cadencia; el fijo es
 *    `mensual × fracción`.
 *  - "other-cadence": el empleado tiene otra cadencia; en este período cobra 0
 *    fijo porque lo paga su propio ciclo. La unidad de PERÍODOS (F4) ya deja
 *    FUERA a ese empleado antes de calcular (`periodExcludesEmployeeByCadence`),
 *    así que este valor describe la clasificación pura; ninguna línea de nómina
 *    se genera con `basis = "other-cadence"`.
 *  - "prorated": falta alguna de las dos cadencias y rige el comportamiento de
 *    hoy (prorrateo por días calendario).
 */
export interface FixedSalaryResolution {
  amount: number;
  basis: "cadence" | "other-cadence" | "prorated";
  fraction: number | null;
}

/**
 * F3: fijo del período según la cadencia (decisión del dueño, 2026-10-01).
 *
 * La cadencia del PERÍODO decide quién cobra el fijo y con qué fracción:
 *  - Si falta la cadencia del período o la del empleado (NULL en cualquiera de
 *    los dos lados), rige el comportamiento de HOY: `prorateFixedSalary` por
 *    días calendario. Ningún camino existente cambia mientras la cadencia no
 *    esté definida.
 *  - Si las dos cadencias coinciden, el fijo es `mensual × fracción` (1/4, 1/2,
 *    1) sobre el mes comercial de 30 días. Si el rango cubre un ciclo PARCIAL
 *    (F5: la primera liquidación suele ser corta), la fracción se escala por
 *    `días del período / días del ciclo`; si el rango llega al ciclo completo o
 *    lo pasa, se topa en la fracción entera y nunca paga más de un ciclo. El
 *    redondeo es UNO solo, a peso entero (`roundMoney`), igual que todo el
 *    módulo.
 *  - Si el empleado tiene OTRA cadencia, en este período cobra 0 fijo: lo paga
 *    su propio ciclo, y pagarlo acá también lo pagaría dos veces.
 *
 * Puro para probarlo sin base de datos.
 */
export function resolveFixedSalaryForPeriod(args: {
  salaryFixed: number | null | undefined;
  employeeFrequency: string | null | undefined;
  periodFrequency: string | null | undefined;
  startDate: string;
  endDate: string;
}): FixedSalaryResolution {
  const salary = Number(args.salaryFixed ?? 0);
  if (!Number.isFinite(salary) || salary <= 0) {
    return { amount: 0, basis: "prorated", fraction: null };
  }
  const periodFrequency = normalizePayFrequency(args.periodFrequency);
  const employeeFrequency = normalizePayFrequency(args.employeeFrequency);
  if (periodFrequency === null || employeeFrequency === null) {
    return {
      amount: prorateFixedSalary({
        salaryFixed: salary,
        startDate: args.startDate,
        endDate: args.endDate,
      }),
      basis: "prorated",
      fraction: null,
    };
  }
  const fraction = fixedFractionForFrequency(periodFrequency);
  if (employeeFrequency !== periodFrequency) {
    return { amount: 0, basis: "other-cadence", fraction };
  }
  // F5: la fracción paga un ciclo COMPLETO; el ciclo parcial se prorratea. El
  // `fraction` que se devuelve sigue siendo el de la cadencia (1/4, 1/2, 1) y el
  // prorrateo del rango ya viene aplicado en `amount`.
  const proration = cycleProrationFactor({
    frequency: periodFrequency,
    startDate: args.startDate,
    endDate: args.endDate,
  });
  return { amount: roundMoney(salary * (fraction ?? 0) * proration), basis: "cadence", fraction };
}

/**
 * F3: reparto del bloque fijo + porcentajes de un empleado `mixto` sobre las
 * columnas EXISTENTES de `payroll_items` (la identidad no se mueve:
 * neto = base_fixed + comisiones + bonos − vales − otros).
 *
 * Regla del dueño (2026-10-01): el mixto cobra el MAYOR entre su básico del
 * período y los porcentajes de SERVICIOS del período. La comparación es SOLO
 * contra los porcentajes de servicios: las comisiones fijas por producto NO
 * entran en el máximo y se siguen sumando como hasta hoy.
 *
 * Reparto:
 *  - `base_fixed` sigue llevando el básico del período.
 *  - la parte porcentual de `commissions` pasa a `max(0, porcentajes − básico)`.
 *  - `absorbed` = `min(básico, porcentajes)` es exactamente lo que deja de
 *    sumarse (el porcentaje que el básico absorbió).
 *  - las comisiones fijas por producto se suman aparte.
 * Con eso `base_fixed + commissions` = `max(básico, porcentajes) + fijas`.
 *
 * Puro para probarlo sin base de datos.
 */
export function resolveMixedBlock(args: {
  baseFixed: number;
  fixedCommissions: number;
  servicePercent: number;
}): { absorbed: number; commissions: number } {
  const baseFixed = roundMoney(Math.max(0, args.baseFixed));
  const fixedCommissions = roundMoney(Math.max(0, args.fixedCommissions));
  const servicePercent = roundMoney(Math.max(0, args.servicePercent));
  const absorbed = roundMoney(Math.min(baseFixed, servicePercent));
  return {
    absorbed,
    commissions: roundMoney(fixedCommissions + Math.max(0, servicePercent - baseFixed)),
  };
}

/** F3: `item_type` de la línea de ajuste que hace visible el absorbido. */
export const MIXED_ABSORBED_ITEM_TYPE = "ajuste_mixto";

/**
 * F3: línea de AJUSTE que muestra el porcentaje absorbido por el básico en el
 * detalle del mixto. Es lo necesario para que el lector no vea los porcentajes
 * desaparecer: sin ella, `detail_json` mostraría los porcentajes completos y
 * `commissions` un monto menor, sin explicación.
 *
 * Su `commission` es NEGATIVA (el absorbido que no se suma) y mantiene la
 * reproducibilidad: la suma de las líneas de `detail_json` vuelve a dar
 * exactamente `commissions`. Conserva la forma de las demás líneas; el
 * `item_type` propio la distingue de una factura real y no menciona ninguna
 * factura, así que el candado de nómina cerrada no la confunde con una.
 *
 * Puro para probarlo sin base de datos.
 */
export function mixedAbsorbedDetailLine(args: { employeeId: string; absorbed: number }): DetailLine {
  return {
    employee_id: args.employeeId,
    invoice_id: MIXED_ABSORBED_ITEM_TYPE,
    consecutive_number: null,
    item_id: MIXED_ABSORBED_ITEM_TYPE,
    item_type: MIXED_ABSORBED_ITEM_TYPE,
    qty: 1,
    unit_price: 0,
    line_subtotal: 0,
    commission: roundMoney(-Math.max(0, args.absorbed)),
    commission_origin: "none",
    commission_percent: null,
    commission_value: null,
  };
}

/** Rango de fechas inclusivo en ambos extremos (mismo contrato que el rango). */
export interface DateRange {
  start_date: string;
  end_date: string;
}

/**
 * PA-2a: la GUÍA de un pago extraordinario, no su tope.
 *
 * El dueño lo dijo explícitamente: el sueldo mensual es la BASE GUÍA de lo que
 * corresponde a los días liquidados, NO un tope. Un pago por despido incluye
 * la liquidación (prestaciones, indemnización) y no es la porción del sueldo;
 * una emergencia puede costar más que los días trabajados. Por eso acá se
 * CALCULA para MOSTRAR y nunca para bloquear: `exceedsGuide` es un aviso para
 * quien registra el pago, no una condición de rechazo (el servicio y el CHECK
 * de la base sólo exigen monto > 0 y motivo no vacío).
 *
 * Con días: la guía es la porción prorrateada del sueldo mensual de esos días
 * (reutiliza `prorateFixedSalary`, la misma fórmula del período). Sin días: la
 * guía es el sueldo mensual completo. Sin sueldo fijo configurado no hay guía
 * (`null`): inventar un número sería peor que no mostrar ninguno. Un rango
 * invertido LANZA (`INVALID_PERIOD_RANGE`), igual que la prorata.
 * Puro para probarlo sin base de datos.
 */
export interface PayrollExtraGuide {
  /** Sueldo fijo mensual del empleado (base guía); null = no configurado. */
  monthlySalary: number | null;
  /** Porción prorrateada de los días liquidados; null si no se indicaron días. */
  proratedAmount: number | null;
  /** Días del rango indicado (inclusive); null si no hay rango. */
  days: number | null;
  /** El monto SUPERA la guía. Es un aviso, NUNCA un rechazo. */
  exceedsGuide: boolean;
}

export function payrollExtraGuide(args: {
  salaryFixed: number | null | undefined;
  daysFrom?: string | null;
  daysTo?: string | null;
  amount?: number | null;
}): PayrollExtraGuide {
  const salary = Number(args.salaryFixed ?? 0);
  const monthlySalary = Number.isFinite(salary) && salary > 0 ? roundMoney(salary) : null;
  const from = args.daysFrom ?? null;
  const to = args.daysTo ?? null;

  let proratedAmount: number | null = null;
  let days: number | null = null;
  if (from !== null && to !== null) {
    // La prorata valida el rango (LANZA si es imposible): la guía no puede
    // mostrar un número calculado sobre un rango que no existe.
    const start = utcDayOf(from);
    const end = utcDayOf(to);
    if (start === null || end === null || end < start) {
      throw new Error("INVALID_PERIOD_RANGE");
    }
    days = (end - start) / DAY_MS + 1;
    if (monthlySalary !== null) {
      proratedAmount = prorateFixedSalary({ salaryFixed: monthlySalary, startDate: from, endDate: to });
    }
  }

  const guide = proratedAmount ?? monthlySalary;
  const amount = args.amount === null || args.amount === undefined ? null : roundMoney(Number(args.amount));
  const exceedsGuide =
    guide !== null && amount !== null && Number.isFinite(amount) && amount - guide > 0.009;

  return { monthlySalary, proratedAmount, days, exceedsGuide };
}

/**
 * PR1/PAY-01: true cuando dos rangos inclusivos comparten AL MENOS un día. Los
 * rangos ADYACENTES no se solapan (fin 2026-09-07 / inicio 2026-09-08): son la
 * serie semanal legal del mes y no comparten ningún día. Es la misma cuenta que
 * hace el filtro SQL (`start_date <= otro.end_date AND end_date >= otro.start_date`)
 * y la que sostiene `daterange(start_date, end_date, '[]') &&` de la migración
 * 035. Puro para probarlo sin base de datos.
 */
export function rangesOverlap(left: DateRange, right: DateRange): boolean {
  return left.start_date <= right.end_date && left.end_date >= right.start_date;
}

/**
 * PR1/PAY-01/F4 (regla del dueño, 2026-10-01): primera fecha de inicio
 * ADMISIBLE para un período NUEVO de la sede **en la MISMA cadencia** que el
 * período que se va a abrir. Es el día SIGUIENTE al fin más lejano ya
 * registrado EN ESE CICLO, sin importar el orden ni el estado. Sin períodos de
 * ese ciclo no hay piso (`null`): el primero es libre.
 *
 * El piso es POR CICLO porque la guarda de solape también lo es (063): un
 * período semanal y uno mensual pueden compartir días A PROPÓSITO, así que un
 * período de otra cadencia NO puede imponer piso. Cuando se omite la cadencia
 * el cubo es el vacío (`coalesce(frequency, '')`, el de los períodos
 * heredados): los períodos sin cadencia se siguen acotando entre sí, que es la
 * protección de siempre.
 *
 * Por qué "día siguiente" y no "ese mismo fin": el fin del período anterior ya
 * está liquidado, así que empezar ahí compartiría un día (el solape que la
 * migración 063 y el servicio rechazan). Los rangos ADYACENTES no se solapan
 * (fin 2026-12-31 → inicio 2027-01-01).
 *
 * TOTAL: no lanza con una lista vacía, tiene en cuenta el fin MÁS LEJANO
 * aunque la entrada llegue desordenada, y no muta la lista. Puro para probarlo
 * sin base de datos. Borde de año incluido: 2026-12-31 → 2027-01-01.
 */
export function nextPeriodStartDate(
  periods: readonly (DateRange & { frequency?: string | null })[],
  frequency: string | null | undefined = null,
): string | null {
  if (periods.length === 0) return null;
  const bucket = periodCadenceBucket(frequency);
  let latestEnd: number | null = null;
  for (const period of periods) {
    // F4: un período de OTRA cadencia comparte días sin conflicto, así que no
    // impone piso. Comparar sin el cubo bloquearía el solape que el dueño quiere.
    if (periodCadenceBucket(period.frequency ?? null) !== bucket) continue;
    const end = utcDayOf(period.end_date);
    if (end === null) continue;
    if (latestEnd === null || end > latestEnd) latestEnd = end;
  }
  if (latestEnd === null) return null;
  return new Date(latestEnd + DAY_MS).toISOString().slice(0, 10);
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

// ------------------------------------------------ 072: ajustes por clave ---
//
// Los topes de vales viven en `system_settings` (migración 072): UNA fila por
// ajuste, identificada por su `clave`, con el contenido del ajuste en `value`
// (jsonb). Estas funciones son el ÚNICO lugar donde se decide qué sobre se
// espera de cada clave y qué DEFAULT corresponde cuando la clave no está: son
// puras (no tocan la base) y se prueban sin dobles.
//
// Los DEFAULT son los de las columnas que cada ajuste reemplaza, no una decisión
// nueva: 0 o null en un tope = sin tope (026, y `checkVoucherCaps` los trata
// igual), `{}` en los topes por día = sin topes por día, y los siete días
// ISO = sin restricción de días (024).

/** Envoltorio de un ajuste cuyo sobre es `{"amount": <número|null>}`. */
export interface VoucherCapSettingValue {
  amount: number | null;
}

/** Envoltorio de un ajuste cuyo sobre es `{"limits": {"<día ISO>": <monto>}}`. */
export interface VoucherPerDaySettingValue {
  limits: Record<string, number> | null;
}

/** Envoltorio de un ajuste cuyo sobre es `{"days": [<días ISO>]}`. */
export interface VoucherDaysSettingValue {
  days: number[] | null;
}

/**
 * 072: lee el sobre de un TOPE (`{"amount": …}`). Una clave ausente, un sobre
 * sin el dato o un valor que no es número devuelven `null` («sin tope»), que es
 * el DEFAULT de 026 y lo que el lector devolvía cuando no había fila
 * configurada. Un 0 explícito se conserva como 0: `checkVoucherCaps` lo trata
 * como sin tope igual que `null`, y así la fila dice lo que el admin guardó.
 */
export function readVoucherCapSetting(value: unknown): number | null {
  const amount = (value as { amount?: unknown } | null)?.amount;
  if (amount === null || amount === undefined) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return roundMoney(numeric);
}

/**
 * 072: lee el sobre de los TOPES POR DÍA (`{"limits": {"3": 50000}}`) con el
 * mismo normalizador que la columna `per_day_limits` de 026, así que un sobre
 * con claves raras (`"0"`, `"8"`, un monto no numérico) se sanea igual que antes
 * y una clave ausente da `null` («sin topes por día»).
 */
export function readVoucherPerDaySetting(value: unknown): Record<string, number> | null {
  const limits = (value as { limits?: unknown } | null)?.limits;
  if (limits === null || limits === undefined || typeof limits !== "object") return null;
  const entries = Object.entries(limits as Record<string, unknown>).map(([day, amount]) => ({
    day,
    amount: amount as number,
  }));
  return normalizePerDayLimits(entries);
}

/**
 * 072: lee el sobre de los DÍAS PERMITIDOS (`{"days": [1,…,7]}`) con el mismo
 * normalizador que la columna `allowed_days` de 024. Una clave ausente da
 * `null`, que es «todos los días»: `isVoucherDayAllowed` trata `null` como sin
 * restricción, igual que antes de la 072.
 */
export function readVoucherDaysSetting(value: unknown): number[] | null {
  const days = (value as { days?: unknown } | null)?.days;
  if (days === null || days === undefined) return null;
  if (!Array.isArray(days)) return null;
  return normalizeAllowedDays(days as Array<number | string>);
}

/**
 * 072: el sobre de un ajuste tal como se ESCRIBE (`value` de la fila). Es el
 * inverso de los tres lectores de arriba y el mismo objeto que la migración deja
 * escrito de origen, así que lo que la fila guarda y lo que el lector devuelve
 * no pueden divergir por una forma escrita a mano.
 */
export function voucherCapSettingValue(amount: number | null): VoucherCapSettingValue {
  return { amount: amount === null ? null : roundMoney(Number(amount)) };
}

/** 072: sobre de los topes por día (null = sin topes por día). */
export function voucherPerDaySettingValue(
  limits: Record<string, number> | null,
): VoucherPerDaySettingValue {
  return { limits: limits ? normalizePerDayLimits(Object.entries(limits).map(([day, amount]) => ({ day, amount }))) : null };
}

/** 072: sobre de los días permitidos (null = todos los días). */
export function voucherDaysSettingValue(days: number[] | null): VoucherDaysSettingValue {
  return { days: days ? normalizeAllowedDays(days) : null };
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
 * PAY-06: valida el tope del 50% de salidas en efectivo del turno al APROBAR
 * un vale. Un vale puede nacer pendiente por debajo del límite y superarlo al
 * aprobarse (el acumulado del turno creció): la aprobación repite la misma
 * regla de la solicitud, con el acumulado YA salido del turno más este vale.
 * Solo rige para `efectivo` ligado a un turno; los digitales y los vales
 * históricos sin turno no tienen tope. Reutiliza la regla pura de caja (no la
 * reescribe). Devuelve null si el monto cabe. Puro para probarlo sin BD.
 */
export function voucherApprovalCashOutViolation(args: {
  methodCode: string | null;
  cashShiftId: string | null;
  openingBase: number | null;
  cashOutUsed: number;
  amount: number;
}): { code: string; message: string } | null {
  if (args.methodCode !== "efectivo") return null;
  if (!args.cashShiftId || args.openingBase === null || args.openingBase === undefined) return null;
  return cashOutLimitViolation({
    methodCode: args.methodCode,
    openingBase: args.openingBase,
    cashOutUsed: args.cashOutUsed,
    amount: args.amount,
  });
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

// ------------------------------- vista de la nómina (PA3) ---
//
// Con muchos pagos al mes, la pantalla de nómina tiene que poder leerse sin
// abrir cada período: cuántos empleados liquidó, cuánto neto hay, cuánto se pagó
// y cuánto queda, agrupado por mes, y qué lleva cada persona en el mes y contra
// qué períodos. Todo esto es PRESENTACIÓN: se deriva de datos ya liquidados y NO
// mueve plata (no decide montos, no topa nada, no bloquea nada). Las funciones
// de acá son puras para poder probarlas sin base de datos.
//
// Los tipos de entrada son ESTRUCTURALES a propósito: este módulo es la capa de
// reglas puras y no puede importar `service` (es el servicio el que importa
// este módulo).

/** Período, en los campos que la vista necesita para agrupar y etiquetar. */
export interface PayrollPeriodLike extends DateRange {
  id: string;
  status: string;
}

/** Ítem ya liquidado con lo pagado resuelto (el servicio lo arma al leer). */
export interface PayrollItemLike {
  id: string;
  period_id: string;
  employee_id: string;
  base_fixed: number | string;
  net_pay: number | string;
  paid: number | string;
}

/** Totales de un período: lo que se lee sin abrirlo. */
export interface PayrollItemTotals {
  /** Cuántos empleados liquidó el período (una fila por empleado). */
  employeeCount: number;
  netTotal: number;
  paidTotal: number;
  remainingTotal: number;
}

/** Un período dentro del mes de un empleado ("contra qué" se le pagó). */
export interface PayrollMonthPeriodEntry {
  periodId: string;
  start_date: string;
  end_date: string;
  status: string;
  net: number;
  paid: number;
  remaining: number;
  /** Fijo liquidado (ya prorrateado) de este empleado en este período. */
  fixed: number;
  /** Días del período que caen en ESTE mes (el numerador de la prorata). */
  days: number;
}

/**
 * PA3: lo que un empleado lleva en un mes. El mes es el de la fecha de INICIO
 * del período y los días son los de ese mes: un período que cruza el fin de mes
 * se prorratea en los dos meses (`prorateFixedSalary`), así que sus días y su
 * fijo aparecen en el mes donde empieza, que es la parte que ahí se liquida.
 */
export interface PayrollMonthEmployeeRow {
  /** Mes del calendario del período, `yyyy-mm`. */
  month: string;
  employeeId: string;
  netTotal: number;
  paidTotal: number;
  remainingTotal: number;
  /** Fijo liquidado (ya prorrateado por el servidor) de los períodos del mes. */
  fixedTotal: number;
  /** Días nominados del mes (la parte de cada período que cae en él). */
  days: number;
  periods: PayrollMonthPeriodEntry[];
}

/** Datos del empleado que la vista de nómina necesita para una fila (ADM-08). */
export interface PayrollEmployeeView {
  id: string;
  full_name: string;
  employee_code: string | null;
  document: string | null;
  /** Lo que la columna de liquidación muestra (fijo/porcentaje/mixto). */
  pay_type: string;
  commission_percent: number | null;
  /** Base mensual de la prorata: se muestra, no se aplica. */
  salary_fixed: number | null;
}

/**
 * Suma de montos para MOSTRAR: se redondea a peso entero en cada paso
 * (`roundMoney`), sin tolerancia. Una suma que no cierra al peso haría ver un
 * total distinto del que se puede pagar.
 */
export function sumMoney(values: readonly (number | string | null | undefined)[]): number {
  let total = 0;
  for (const value of values) {
    const numeric = Number(value ?? 0);
    if (Number.isFinite(numeric)) total = roundMoney(total + numeric);
  }
  return total;
}

/**
 * Totales de un período a partir de sus ítems con lo pagado resuelto.
 *
 * El saldo de cada fila es `max(0, neto − pagado)`, el MISMO criterio que
 * `getPeriodDetail` (una fila nunca muestra saldo negativo), y el total del
 * período es la suma de lo que muestran sus filas: la lista y el detalle no
 * pueden decir cosas distintas del mismo período.
 */
export function summarizePayrollItems(items: readonly PayrollItemLike[]): PayrollItemTotals {
  return {
    employeeCount: items.length,
    netTotal: sumMoney(items.map((item) => item.net_pay)),
    paidTotal: sumMoney(items.map((item) => item.paid)),
    remainingTotal: sumMoney(
      items.map((item) => Math.max(0, Number(item.net_pay) - Number(item.paid ?? 0))),
    ),
  };
}

/**
 * PA-2b: los montos de un ítem de nómina en UNA de las dos versiones de una
 * corrección (la anterior congelada o la corregida). Estructural a propósito:
 * sirve tanto para la fila de `payroll_items` (versión anterior) como para la
 * fila de la corrección.
 */
export interface PayrollCorrectionAmounts {
  base_fixed: number | string;
  commissions: number | string;
  bonuses: number | string;
  deductions_vales: number | string;
  other_discounts: number | string;
  net_pay: number | string;
}

/** Una fila de la comparación: lo que decía el período, lo corregido y lo pagado. */
export interface PayrollCorrectionRowView {
  employee_id: string;
  previous: PayrollCorrectionAmounts;
  corrected: PayrollCorrectionAmounts;
  /** Pagado a este empleado en este período (suma de `payroll_payments`). */
  paid: number;
  /**
   * Diferencia a liquidar: `pagado − neto corregido`. Positiva = se pagó más
   * de lo que la versión corregida dice que se debía (a favor de la empresa);
   * negativa = quedó plata por pagar (a favor del empleado). La corrección NO
   * la salda: la muestra para que se salde a mano.
   */
  difference: number;
}

/** Las dos versiones de un período corregido, comparadas contra lo pagado. */
export interface PayrollCorrectionView {
  rows: PayrollCorrectionRowView[];
  previousNetTotal: number;
  correctedNetTotal: number;
  paidTotal: number;
  differenceTotal: number;
}

/** Montos en cero para el empleado que sólo está en una de las dos versiones. */
const NO_CORRECTION_AMOUNTS: PayrollCorrectionAmounts = {
  base_fixed: 0,
  commissions: 0,
  bonuses: 0,
  deductions_vales: 0,
  other_discounts: 0,
  net_pay: 0,
};

/**
 * PA-2b: arma la comparación de un período corregido: por empleado y para el
 * período, lo que decía la versión anterior, lo que dice la corregida y lo
 * pagado, con la diferencia `pagado − corregido`.
 *
 * El orden de las filas es por `employee_id`: es determinista y no depende del
 * orden en que el motor devolvió las filas, así que la misma corrección se lee
 * igual siempre (la pantalla ordena por nombre del empleado para mostrar).
 * Un empleado que sólo aparezca en la corrección se agrega con la versión
 * anterior en cero, en vez de desaparecer de la vista.
 * Los totales son la SUMA de las filas (peso entero, sin tolerancia): la tabla
 * y sus totales no pueden decir cosas distintas.
 * Puro para probarlo sin base de datos.
 */
export function buildPayrollCorrectionView(args: {
  previous: ReadonlyArray<PayrollCorrectionAmounts & { employee_id: string }>;
  corrected: ReadonlyArray<PayrollCorrectionAmounts & { employee_id: string }>;
  paidByEmployee: ReadonlyMap<string, number>;
}): PayrollCorrectionView {
  const correctedByEmployee = new Map(args.corrected.map((row) => [row.employee_id, row]));
  const employeeIds = [
    ...new Set([
      ...args.previous.map((row) => row.employee_id),
      ...args.corrected.map((row) => row.employee_id),
    ]),
  ].sort();

  const rows: PayrollCorrectionRowView[] = employeeIds.map((employeeId) => {
    const previous = args.previous.find((row) => row.employee_id === employeeId) ?? NO_CORRECTION_AMOUNTS;
    const corrected = correctedByEmployee.get(employeeId) ?? NO_CORRECTION_AMOUNTS;
    const paid = roundMoney(Number(args.paidByEmployee.get(employeeId) ?? 0));
    return {
      employee_id: employeeId,
      previous,
      corrected,
      paid,
      difference: roundMoney(paid - roundMoney(Number(corrected.net_pay ?? 0))),
    };
  });

  return {
    rows,
    previousNetTotal: sumMoney(rows.map((row) => row.previous.net_pay)),
    correctedNetTotal: sumMoney(rows.map((row) => row.corrected.net_pay)),
    paidTotal: sumMoney(rows.map((row) => row.paid)),
    differenceTotal: sumMoney(rows.map((row) => row.difference)),
  };
}

/** Mes del calendario (`yyyy-mm`) de una fecha `yyyy-mm-dd`; null si no es fecha. */
export function monthKeyOf(dateIso: string): string | null {
  const day = utcDayOf(dateIso);
  if (day === null) return null;
  const date = new Date(day);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Días de `[startDate, endDate]` que caen dentro de un mes del calendario: el
 * numerador de la prorata (`prorateFixedSalary`), que se muestra para que el
 * fijo de los días nominados sea legible y no un número suelto. Una fecha
 * imposible o un mes que el rango no toca dan 0: nunca se inventan días.
 */
export function daysInMonthWithinRange(month: string, startDate: string, endDate: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!match) return 0;
  const month0 = Number(match[2]) - 1;
  if (month0 < 0 || month0 > 11) return 0;
  const start = utcDayOf(startDate);
  const end = utcDayOf(endDate);
  if (start === null || end === null || end < start) return 0;
  const monthStart = Date.UTC(Number(match[1]), month0, 1);
  const monthEnd = Date.UTC(Number(match[1]), month0 + 1, 0);
  const from = Math.max(start, monthStart);
  const to = Math.min(end, monthEnd);
  if (to < from) return 0;
  return (to - from) / DAY_MS + 1;
}

const MONTHS_LONG = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/**
 * Etiqueta legible de un mes del calendario ("septiembre 2026"). No usa el
 * locale del runtime: el nombre del mes es el mismo en el servidor y en el
 * navegador, y no depende de datos de locale que puedan faltar.
 */
export function payrollMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!match) return month;
  const month0 = Number(match[2]) - 1;
  if (month0 < 0 || month0 > 11) return month;
  return `${MONTHS_LONG[month0]} ${match[1]}`;
}

/**
 * Conteo de la lista de períodos: SIEMPRE contra el total. La lista se leía
 * recortada en 20 sin decirlo, y un total que no se nombra es un recorte
 * invisible. `shown === total` es el caso normal (la lectura es completa); el
 * otro texto existe para cuando el filtro de estado recorta la vista.
 */
export function payrollPeriodCountLabel(args: { total: number; shown: number }): string {
  const noun = args.total === 1 ? "período" : "períodos";
  // Sin «en la sede»: la instalación es de una sola (M1–M3c) y el rótulo no
  // nombra un alcance que no existe (vocabulario del dueño, 2026-10-04).
  if (args.shown === args.total) {
    return args.total === 1 ? "1 período registrado." : `${args.total} ${noun} registrados.`;
  }
  return `Mostrando ${args.shown} de ${args.total} ${noun}.`;
}

/** Períodos agrupados por el mes del calendario de su fecha de inicio. */
export interface PayrollMonthGroup<TRow extends PayrollPeriodLike = PayrollPeriodLike> {
  month: string;
  periods: TRow[];
}

/**
 * Agrupa por mes para que un mes con muchos pagos sea navegable: el mes más
 * reciente primero y, dentro del mes, el período más reciente primero. Un
 * período con fecha de inicio ilegible no se pierde: cae al grupo sin mes
 * etiquetable y la vista lo muestra aparte en vez de esconderlo.
 *
 * Es genérica en la fila: el llamador recupera EXACTAMENTE el tipo de período
 * que pasó (la vista además necesita `closed_at`, que no es del agrupador).
 */
export function groupPayrollPeriodsByMonth<TRow extends PayrollPeriodLike>(
  periods: readonly TRow[],
): PayrollMonthGroup<TRow>[] {
  const byMonth = new Map<string, TRow[]>();
  for (const period of periods) {
    const month = monthKeyOf(period.start_date) ?? "";
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(period);
    else byMonth.set(month, [period]);
  }
  return [...byMonth.entries()]
    .map(([month, rows]) => ({
      month,
      periods: [...rows].sort((left, right) => (left.start_date < right.start_date ? 1 : -1)),
    }))
    .sort((left, right) => (left.month < right.month ? 1 : -1));
}

/**
 * Mes a la fecha por empleado: qué lleva liquidado y pagado en cada mes y
 * contra qué períodos, con el fijo prorrateado y los días nominados a la vista.
 * Se ordena por mes descendente y, dentro del mes, por identificación del
 * empleado ascendente, para que dos corridas den exactamente lo mismo.
 */
export function buildPayrollMonthToDate(args: {
  periods: readonly PayrollPeriodLike[];
  items: readonly PayrollItemLike[];
}): PayrollMonthEmployeeRow[] {
  const periodById = new Map(args.periods.map((period) => [period.id, period]));
  /** Por mes: los empleados que tienen algo liquidado ese mes. */
  const employees = new Map<string, Set<string>>();
  /** Por mes y empleado: el detalle de cada período, para acumular sin reescribir. */
  const details = new Map<string, Map<string, Map<string, PayrollMonthPeriodEntry>>>();

  for (const item of args.items) {
    const period = periodById.get(item.period_id);
    if (!period) continue;
    const month = monthKeyOf(period.start_date);
    if (month === null) continue;

    const monthEmployees = employees.get(month) ?? new Set<string>();
    employees.set(month, monthEmployees);
    monthEmployees.add(item.employee_id);

    const byEmployee = details.get(month) ?? new Map<string, Map<string, PayrollMonthPeriodEntry>>();
    details.set(month, byEmployee);
    const byPeriod = byEmployee.get(item.employee_id) ?? new Map<string, PayrollMonthPeriodEntry>();
    byEmployee.set(item.employee_id, byPeriod);

    const net = roundMoney(Number(item.net_pay));
    const paid = roundMoney(Number(item.paid ?? 0));
    const remaining = roundMoney(Math.max(0, net - paid));
    const fixed = roundMoney(Number(item.base_fixed));

    const entry = byPeriod.get(period.id);
    if (entry) {
      entry.net = roundMoney(entry.net + net);
      entry.paid = roundMoney(entry.paid + paid);
      entry.remaining = roundMoney(entry.remaining + remaining);
      entry.fixed = roundMoney(entry.fixed + fixed);
    } else {
      byPeriod.set(period.id, {
        periodId: period.id,
        start_date: period.start_date,
        end_date: period.end_date,
        status: period.status,
        net,
        paid,
        remaining,
        fixed,
        days: daysInMonthWithinRange(month, period.start_date, period.end_date),
      });
    }
  }

  const rows: PayrollMonthEmployeeRow[] = [];
  for (const [month, monthEmployees] of employees) {
    for (const employeeId of monthEmployees) {
      rows.push(
        monthRowFrom(month, employeeId, [...(details.get(month)?.get(employeeId)?.values() ?? [])]),
      );
    }
  }

  return rows.sort(compareMonthRows);
}

/** Orden de la vista: mes más reciente primero y, dentro del mes, por legajo. */
function compareMonthRows(left: PayrollMonthEmployeeRow, right: PayrollMonthEmployeeRow): number {
  if (left.month !== right.month) return left.month < right.month ? 1 : -1;
  return left.employeeId < right.employeeId ? -1 : 1;
}

/**
 * Totales de una fila del mes, recalculados SÓLO con sus períodos. Después de
 * `roundMoney` todos los montos son enteros, así que la suma de los totales de
 * los períodos es exacta (no depende del orden).
 */
function monthRowFrom(
  month: string,
  employeeId: string,
  periods: readonly PayrollMonthPeriodEntry[],
): PayrollMonthEmployeeRow {
  const sorted = [...periods].sort((left, right) => (left.start_date < right.start_date ? -1 : 1));
  return {
    month,
    employeeId,
    netTotal: sumMoney(sorted.map((entry) => entry.net)),
    paidTotal: sumMoney(sorted.map((entry) => entry.paid)),
    remainingTotal: sumMoney(sorted.map((entry) => entry.remaining)),
    fixedTotal: sumMoney(sorted.map((entry) => entry.fixed)),
    days: sorted.reduce((acc, entry) => acc + entry.days, 0),
    periods: sorted,
  };
}

/**
 * Reemplaza la porción de UN período dentro del mes a la fecha, con los ítems
 * que acaba de devolver el detalle (o con NINGUNO si el borrador se borró).
 *
 * Por qué existe: el mes a la fecha se lee del servidor al abrir la pantalla,
 * pero el admin paga, recalcula, cierra o borra dentro de la sesión. Sin esto,
 * el número que acaba de cambiar seguiría mostrándose viejo hasta recargar —y
 * un total viejo al lado de una acción recién hecha es una mentira, no un dato
 * desactualizado—. Los períodos que el detalle no toca quedan intactos.
 */
export function replacePayrollMonthPeriod(args: {
  rows: readonly PayrollMonthEmployeeRow[];
  period: PayrollPeriodLike;
  items: readonly PayrollItemLike[];
}): PayrollMonthEmployeeRow[] {
  const month = monthKeyOf(args.period.start_date);
  if (month === null) return [...args.rows];

  // 1. Fuera la porción vieja de ESTE período (y las filas que se quedan sin nada).
  const next: PayrollMonthEmployeeRow[] = [];
  for (const row of args.rows) {
    const periods = row.periods.filter((entry) => entry.periodId !== args.period.id);
    if (periods.length === row.periods.length) {
      next.push(row);
      continue;
    }
    if (periods.length === 0) continue;
    next.push(monthRowFrom(row.month, row.employeeId, periods));
  }

  // 2. Adentro la porción fresca. Sólo se agrega o se completa: la fila puede
  //    tener OTROS períodos del mismo mes, que no se pierden.
  const fresh = buildPayrollMonthToDate({ periods: [args.period], items: args.items });
  for (const row of fresh) {
    const index = next.findIndex(
      (other) => other.month === row.month && other.employeeId === row.employeeId,
    );
    if (index === -1) next.push(row);
    else next[index] = monthRowFrom(row.month, row.employeeId, [...next[index].periods, ...row.periods]);
  }

  return next.sort(compareMonthRows);
}

/** Índice de la planta por id: nombrar una fila no recorre la planta entera. */
export function buildPayrollEmployeeIndex(
  employees: readonly PayrollEmployeeView[],
): Map<string, PayrollEmployeeView> {
  const index = new Map<string, PayrollEmployeeView>();
  for (const employee of employees) index.set(employee.id, employee);
  return index;
}

/**
 * Nombre legible del empleado: nombre + ID interno (el `employee_code`; si no
 * está definido, el documento), igual que en vales, para distinguir homónimos.
 * Un id que no está en la planta (un empleado dado de baja y borrado) cae al
 * fragmento del id: es una degradación EXPLÍCITA, nunca un nombre inventado.
 */
export function payrollEmployeeName(
  index: ReadonlyMap<string, PayrollEmployeeView>,
  id: string,
): string {
  const found = index.get(id);
  if (!found) return id.slice(0, 8);
  const internalId = found.employee_code ? found.employee_code : found.document;
  return `${found.full_name} (${internalId})`;
}
