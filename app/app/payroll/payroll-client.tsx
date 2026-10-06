"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import {
  calculatePayrollAction,
  closePayrollPeriodAction,
  correctPayrollPeriodAction,
  deletePayrollPeriodAction,
  getPayrollPeriodCorrectionAction,
  getPayrollSettlementSourcesAction,
  getPeriodDetailAction,
  listPayrollExtrasAction,
  listPayrollMonthRowsAction,
  listPeriodsAction,
  listVouchersAction,
  openPayrollPeriodAction,
  payPayrollExtraAction,
  payPayrollItemAction,
} from "@/src/features/payroll/actions";
import { getInvoiceAction } from "@/src/features/billing/actions";
import type {
  PayrollExtraRow,
  PayrollPeriodCorrectionResult,
  PayrollPeriodRow,
  PayrollPeriodSummary,
  PayrollSettlementSources,
  PayrollSettlementVoucher,
  PeriodDetail,
  VoucherRequestRow,
} from "@/src/features/payroll/service";
import type { InvoiceDetail } from "@/src/features/billing/service";
import {
  ADJUSTMENT_REASON_MAX_LENGTH,
  buildPayrollEmployeeIndex,
  cycleDaysForFrequency,
  detailLineCommissionOrigin,
  groupPayrollPeriodsByMonth,
  isPayrollCycleSettled,
  isRangeBeforePayrollStart,
  openPayrollRejectionMessage,
  payrollCycleRange,
  payrollEmployeeName,
  payrollExtraGuide,
  payrollExtraKindSchema,
  payrollHistoryFloor,
  payrollMonthLabel,
  payrollPeriodCountLabel,
  pendingPayrollSettlements,
  periodCadenceBucket,
  periodRangeDays,
  resolveOpenPayrollRange,
  roundMoney,
  splitCommissionByOrigin,
  sumMoney,
  summarizePayrollItems,
  type PayrollCorrectionView,
  type PayrollExtraKind,
  type PayrollItemTotals,
  type PayrollMonthEmployeeRow,
  type PayrollMonthGroup,
  type PendingPayrollSettlement,
} from "@/src/features/payroll/schemas";
import type { EmployeeRow, PaymentMethodRow } from "@/src/features/admin/service";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { cn } from "@/src/components/ui/lib/utils";
import { DataTable } from "@/src/components/ui/lib/data-table";
import { Alert } from "@/src/components/ui/lib/alert";
import { Badge } from "@/src/components/ui/lib/badge";
import {
  buttonClass,
  ghostClass,
  inputClass,
  labelClass,
  sectionClass,
  tableCellClass,
  tableHeaderClass,
  tableRowClass,
} from "@/src/shared/lib/ui-styles";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { bogotaDay } from "@/src/shared/lib/dates";
import { toNumber } from "@/src/shared/lib/format";
import { formatMoney, formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";

/** Acción destructiva (borrar borrador): contorno y texto en rojo, separada de las demás. */
const dangerOutlineClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-error bg-transparent px-4 py-2 text-sm font-medium text-error shadow-sm transition-all duration-200 hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const dangerSolidClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-error-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-error-600/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const tableInputClass = cn(
  "w-28 rounded-md border border-border-color bg-surface px-2 py-1 text-right text-sm text-text-primary shadow-sm",
  "dark:border-border-color-2",
);

/*
 * Decoración de las DOS tablas de liquidación (12 columnas). Vive acá y no en
 * `ui-styles.ts` a propósito: es la letra de ESTE módulo, no un estándar.
 *
 * - El dinero va a la derecha y con cifras tabulares, para que los dígitos de
 *   una fila se lean en columna; su encabezado también va a la derecha, para
 *   que titule el mismo borde donde termina el número.
 * - `whitespace-nowrap` evita el rótulo de tres palabras partido en cuatro
 *   renglones dentro de una columna angosta.
 *
 * El padding NO se aprieta. `px-3` viene ya en `tableCellClass` y las celdas
 * de vales y de motivo lo tienen escrito (las congela la guarda de la regla
 * del dueño); apretarlo solo en las otras diez movería 4px el borde derecho de
 * la columna de vales y despegaría las cifras entre sí. El ancho lo gana el
 * diálogo, no la celda.
 */
const headCellClass = cn(tableCellClass, "whitespace-nowrap");
const moneyHeadClass = cn(tableCellClass, "whitespace-nowrap text-right");
const moneyCellClass = cn(tableCellClass, "text-right tabular-nums whitespace-nowrap");

/** Etiquetas del tipo de pago del empleado (ADM-08: fijo, porcentaje o mixto). */
const PAY_TYPE_LABELS: Record<string, string> = {
  fijo: "Fijo",
  porcentaje: "Porcentaje",
  mixto: "Mixto",
};

/**
 * Etiqueta legible del tipo de línea del desglose de comisiones. El
 * `detail_json` guarda el tipo y la cantidad, pero NO el nombre del catálogo
 * (ni `product_id`/`service_id` ni `custom_name`), así que no hay con qué
 * resolver el nombre real en el cliente. Se muestra una etiqueta en español
 * en lugar del tipo crudo: `custom` deja de verse como "custom" y pasa a
 * "Personalizado".
 */
function detailLineLabel(itemType: string): string {
  if (itemType === "producto") return "Producto";
  if (itemType === "servicio") return "Servicio";
  if (itemType === "custom") return "Personalizado";
  return itemType;
}

/** Porcentaje sin decimales innecesarios (10 → "10", 10.5 → "10.5"). */
function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * Texto de ayuda del celular de vales: el número es el TOTAL del período de los
 * vales del empleado (puede sumar varios), no el vale puntual que la pantalla de
 * vales muestra por separado. Cuando los descuentos consumen todo el bruto, el
 * tope de descuentos (`capPayrollDiscounts`) recorta el monto respecto a la suma
 * real de vales; se dice para que la cifra no se lea como "la suma de los vales".
 * Solo presentación: no recalcula ni mueve el monto.
 */
function voucherCellTitle(item: {
  base_fixed: number;
  commissions: number;
  bonuses: number;
  deductions_vales: number;
  other_discounts: number;
}): string {
  const base =
    "Total de los vales del período de este empleado (puede sumar varios vales). Se descuenta del neto.";
  const gross = roundMoney(item.base_fixed + item.commissions + item.bonuses);
  const discounts = roundMoney(item.deductions_vales + item.other_discounts);
  return gross > 0 && discounts >= gross
    ? `${base} El descuento topa contra el bruto ganado del período.`
    : base;
}

/**
 * Tipo de pago legible para la liquidación ("Fijo", "Porcentaje 10%",
 * "Mixto 10%"). El porcentaje se anexa solo en porcentaje/mixto con valor
 * definido, para no mostrar "Porcentaje null%".
 */
function formatPayType(payType: string, percent: number | null): string {
  const label = PAY_TYPE_LABELS[payType] ?? payType;
  if ((payType === "porcentaje" || payType === "mixto") && percent !== null) {
    return `${label} ${formatPercent(percent)}%`;
  }
  return label;
}

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** PA-2a: etiqueta legible de cada caso extraordinario. */
const PAYROLL_EXTRA_KIND_LABELS: Record<PayrollExtraKind, string> = {
  despido: "Despido",
  renuncia: "Renuncia",
  emergencia: "Emergencia",
  otro: "Otro",
};

/**
 * PA-2b: lo que la pantalla dice de una corrección. Se escribe UNA vez y se
 * muestra tal cual: la corrección NO mueve dinero y la diferencia no queda
 * saldada, y eso no puede depender de cómo se redactó cada párrafo.
 */
const CORRECTION_MOVES_NO_MONEY =
  "La corrección deja el registro de lo que debía pagarse; NO mueve dinero: no paga, no descuenta ni arrastra saldos.";
const CORRECTION_DIFFERENCE_IS_MANUAL =
  "La diferencia (pagado - corregido) NO queda saldada por la corrección: se salda con un pago extraordinario cuyo motivo diga que es el ajuste por la corrección del período.";
const CORRECTION_KEEPS_ORIGINAL =
  "El período cerrado no se reabre ni se pisa: se guarda una corrección con las dos versiones y un motivo obligatorio.";
const CORRECTION_ORIGINAL_STILL_SHOWN =
  "La liquidación firmada del período queda intacta y se sigue mostrando tal como se cerró.";

/** Máximo de nombres listados en el aviso de pendientes antes de resumir. */
const PENDING_VISIBLE_LIMIT = 8;

/**
 * PA3: máximo de períodos listados dentro del diálogo de apertura antes de
 * resumir. La lectura de períodos ya no se recorta (la sede con más de 20
 * perdía historia), así que el diálogo nombra el total y dice cuántos quedan
 * fuera en vez de renderizar cientos de filas sin decirlo.
 */
const PERIOD_VISIBLE_LIMIT = 12;

interface SimpleDate {
  year: number;
  month: number;
  day: number;
}

/** Parsea yyyy-mm-dd sin pasar por Date (evita el desfase de zona horaria). */
function parseIsoDate(value: string): SimpleDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Etiqueta compacta de un periodo ("1–15 sep"); si comparten mes, un solo nombre. */
function formatPeriodLabel(row: { start_date: string; end_date: string }): string {
  const start = parseIsoDate(row.start_date);
  const end = parseIsoDate(row.end_date);
  if (!start || !end) return `${row.start_date} → ${row.end_date}`;
  const sameMonth = start.year === end.year && start.month === end.month;
  const startText = sameMonth ? `${start.day}` : `${start.day} ${MONTHS_SHORT[start.month - 1]}`;
  return `${startText}–${end.day} ${MONTHS_SHORT[end.month - 1]}`;
}

/** Fecha legible con año ("1 oct 2026"). */
function formatFullDate(value: string): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  return `${date.day} ${MONTHS_SHORT[date.month - 1]} ${date.year}`;
}

/**
 * F9: texto de un ciclo pendiente en el aviso. Nombra la cadencia, el rango del
 * ciclo y a quién le toca; cuando la cadencia tiene más gente que nombres,
 * resume el resto con el conteo (que siempre dice el total).
 */
function pendingSettlementText(entry: PendingPayrollSettlement): string {
  const employees =
    entry.employeeCount === 1
      ? "1 empleado con esa cadencia"
      : `${entry.employeeCount} empleados con esa cadencia`;
  const extra = entry.employeeCount - entry.employeeNames.length;
  const who =
    extra > 0
      ? `${entry.employeeNames.join(", ")} y ${extra} más`
      : entry.employeeNames.join(", ");
  return `Falta liquidar el ciclo ${entry.frequency} ${entry.label} (${employees}: ${who}).`;
}

/**
 * F4: primer período que COLISIONA con [start, end]: comparte días y cae en el
 * MISMO cubo de cadencia (`coalesce(frequency, '')`, el de la restricción de
 * 063). Es la MISMA regla que aplican el servicio y la base: un semanal y un
 * mensual pueden superponerse; dos del mismo ciclo —o los dos sin cadencia— no.
 * El servidor sigue siendo la autoridad; esto es el aviso en vivo del diálogo.
 */
function findOverlappingPeriod(
  rows: PayrollPeriodRow[],
  start: string,
  end: string,
  frequency: string | null,
): PayrollPeriodRow | null {
  const bucket = periodCadenceBucket(frequency);
  return (
    rows.find(
      (row) =>
        periodCadenceBucket(row.frequency) === bucket &&
        start <= row.end_date &&
        end >= row.start_date,
    ) ?? null
  );
}

/** Días de un rango inclusivo (mismo criterio que la prorata del servidor). */
function rangeDayCount(start: string, end: string): number {
  const [startY, startM, startD] = start.split("-").map(Number);
  const [endY, endM, endD] = end.split("-").map(Number);
  const days =
    Math.round((Date.UTC(endY, endM - 1, endD) - Date.UTC(startY, startM - 1, startD)) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * PR1: la base del fijo, a la vista. El fijo de un período NO es el sueldo del
 * mes: es la parte que corresponde a sus días (el servidor prorratea el sueldo
 * mensual por los días nominados). Sin esta nota el administrador ve un número
 * sin explicación —que era el defecto: cada período pagaba el sueldo completo—.
 * Presentación pura: los días salen del rango del período que ya está cargado.
 */
function FixedBasisNote({ start, end }: { start: string; end: string }) {
  const days = rangeDayCount(start, end);
  return (
    <p className="mt-3 text-xs text-text-tertiary">
      Fijo de estos días: la parte del sueldo mensual que corresponde a los {days}{" "}
      {days === 1 ? "día" : "días"} del período ({start} a {end}) es el máximo que se paga por
      ellos; si el período cruza el fin de mes, el sueldo se prorratea en los dos meses. Las
      comisiones y los bonos van aparte, encima del fijo; los mismos días no se pueden nominar
      en otro período de la instalación.
    </p>
  );
}

/** Totales por período, indexados por id para leerlos en la lista y por mes. */
function indexPeriodTotals(rows: readonly PayrollPeriodSummary[]): Record<string, PayrollItemTotals> {
  const index: Record<string, PayrollItemTotals> = {};
  for (const row of rows) {
    index[row.period.id] = {
      employeeCount: row.employeeCount,
      netTotal: row.netTotal,
      paidTotal: row.paidTotal,
      remainingTotal: row.remainingTotal,
    };
  }
  return index;
}

interface PayrollClientProps {
  initialEmployees: EmployeeRow[];
  initialPeriods: PayrollPeriodRow[];
  /**
   * PA3: totales por período (neto, pagado, saldo y cuántos empleados liquidó).
   * Agregan plata de TODA la planta, así que llegan vacíos para el empleado.
   */
  initialSummaries: PayrollPeriodSummary[];
  methods: PaymentMethodRow[];
  canAdmin: boolean;
  canPay: boolean;
}

type DetailItem = PeriodDetail["items"][number];

interface PeriodDetailTableProps {
  items: DetailItem[];
  employeeName: (id: string) => string;
  payLabel: (id: string) => string;
  onView: (item: DetailItem) => void;
  onViewSources: (item: DetailItem) => void;
}

/** Tabla del detalle del periodo (solo presentación). */
function PeriodDetailTable({ items, employeeName, payLabel, onView, onViewSources }: PeriodDetailTableProps) {
  return (
    <DataTable minWidth="2xl" wrapperClassName="mt-4">
      <thead>
        <tr className={tableHeaderClass}>
          <th className={headCellClass} scope="col">
            Empleado
          </th>
          <th className={moneyHeadClass} scope="col">
            Fijo (días)
          </th>
          <th className={moneyHeadClass} scope="col">
            Comisión fija
          </th>
          <th className={moneyHeadClass} scope="col">
            Comisión por porcentaje
          </th>
          <th className={moneyHeadClass} scope="col">
            Bonos
          </th>
          <th className={moneyHeadClass} scope="col">
            Vales (descuento)
          </th>
          <th className={moneyHeadClass} scope="col">
            Otros (descuento)
          </th>
          <th className={headCellClass} scope="col">
            Motivo del ajuste
          </th>
          <th className={moneyHeadClass} scope="col">
            Neto
          </th>
          <th className={moneyHeadClass} scope="col">
            Pagado
          </th>
          <th className={moneyHeadClass} scope="col">
            Saldo
          </th>
          <th className={headCellClass} scope="col">
            Detalle
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          // Reclasificación sin mover el total: fija = comisiones − porcentaje.
          const commission = splitCommissionByOrigin({
            commissions: item.commissions,
            detail: item.detail_json,
          });
          return (
            <tr key={item.id} className={tableRowClass}>
              <td className={tableCellClass}>
                <span className="block">{employeeName(item.employee_id)}</span>
                <span className="block text-xs text-text-tertiary">
                  {payLabel(item.employee_id)}
                </span>
              </td>
              <td className={moneyCellClass}>{formatMoney(item.base_fixed)}</td>
              <td className={moneyCellClass}>{formatMoney(commission.fixed)}</td>
              <td className={moneyCellClass}>{formatMoney(commission.percent)}</td>
              <td className={moneyCellClass}>{formatMoney(item.bonuses)}</td>
              {/*
                Regla del dueño (2026-10-01): «vales es solo vales y punto».
                La celda muestra ÚNICAMENTE el total REAL de vales del período
                (`voucher_total`) con el signo de descuento. Antes imprimía
                además `aplicado` y `deuda pendiente`; el aplicado igualaba la
                comisión en el caso del dueño y la columna terminaba nombrando
                la comisión bajo otra etiqueta. Esa conciliación vive en el
                modal «Ver facturas y vales», que es donde se lee el desglose.
                El signo es solo presentación: el vale se guarda positivo.

                El `className` de esta celda lo congela la guarda del dueño: el
                alineado del dinero va en el `span` de adentro.
              */}
              <td className={tableCellClass} title={voucherCellTitle(item)}>
                <span className="block text-right tabular-nums">{`-${formatMoney(item.voucher_total)}`}</span>
              </td>
              <td className={moneyCellClass}>{`-${formatMoney(item.other_discounts)}`}</td>
              {/*
                F8: la respuesta a «¿por qué este empleado tiene este ajuste?».
                El motivo se guarda en el ítem (misma fila y misma
                transacción que el monto) y acá se muestra tal cual: una
                liquidación cerrada tiene que poder explicarse sola.
              */}
              <td className={tableCellClass}>{item.adjustment_reason ?? "—"}</td>
              <td className={cn(moneyCellClass, "font-semibold")}>{formatMoney(item.net_pay)}</td>
              <td className={moneyCellClass}>{formatMoney(item.paid)}</td>
              <td className={moneyCellClass}>{formatMoney(item.remaining)}</td>
              <td className={tableCellClass}>
                <span className="inline-flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onView(item)}
                    aria-label={`Ver el desglose de ${employeeName(item.employee_id)}`}
                    className={ghostClass}
                  >
                    Ver
                  </button>
                  {/*
                    F6: abre el modal con las facturas y los vales que
                    componen ESTA liquidación, con el detalle de cada uno.
                  */}
                  <button
                    type="button"
                    onClick={() => onViewSources(item)}
                    aria-label={`Ver facturas y vales de ${employeeName(item.employee_id)}`}
                    className={ghostClass}
                  >
                    Ver facturas y vales
                  </button>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

/**
 * PA-2b: la comparación de una corrección. Muestra las tres cifras —lo que el
 * período decía antes, lo que dicen las reglas vigentes y lo pagado— y la
 * diferencia (pagado - corregido), por empleado y para el período.
 *
 * NO hay ninguna acción acá y no se puede pagar desde un período cerrado: la
 * corrección es un registro, la diferencia se salda a mano. El orden es por
 * nombre del empleado para leer, no por id.
 */
function CorrectionComparison({
  view,
  employeeName,
}: {
  view: PayrollCorrectionView;
  employeeName: (id: string) => string;
}) {
  const rows = [...view.rows].sort((left, right) =>
    employeeName(left.employee_id).localeCompare(employeeName(right.employee_id), "es-CO"),
  );
  return (
    <div className="mt-3 overflow-x-auto">
      <table className={cn("w-full text-left text-sm", "min-w-[880px]")}>
        <thead>
          <tr className={tableHeaderClass}>
            <th className={tableCellClass} scope="col">
              Empleado
            </th>
            <th className={tableCellClass} scope="col">
              Debido antes (versión anterior)
            </th>
            <th className={tableCellClass} scope="col">
              Debido corregido (versión vigente)
            </th>
            <th className={tableCellClass} scope="col">
              Pagado
            </th>
            <th className={tableCellClass} scope="col">
              Diferencia (pagado - corregido)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.employee_id} className={tableRowClass}>
              <td className={tableCellClass}>{employeeName(row.employee_id)}</td>
              <td className={tableCellClass}>{formatMoney(Number(row.previous.net_pay))}</td>
              <td className={cn(tableCellClass, "font-semibold")}>
                {formatMoney(Number(row.corrected.net_pay))}
              </td>
              <td className={tableCellClass}>{formatMoney(row.paid)}</td>
              <td className={cn(tableCellClass, "font-semibold")}>{formatMoney(row.difference)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={tableRowClass}>
            <td className={cn(tableCellClass, "font-semibold")}>Total del período</td>
            <td className={tableCellClass}>{formatMoney(view.previousNetTotal)}</td>
            <td className={cn(tableCellClass, "font-semibold")}>
              {formatMoney(view.correctedNetTotal)}
            </td>
            <td className={tableCellClass}>{formatMoney(view.paidTotal)}</td>
            <td className={cn(tableCellClass, "font-semibold")}>{formatMoney(view.differenceTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

type AdjustmentMoneyField = "bonuses" | "others";
type AdjustmentField = AdjustmentMoneyField | "reason";

interface DraftRow {
  employeeId: string;
  item: DetailItem | null;
}

interface DraftPayrollTableProps {
  rows: DraftRow[];
  employeeName: (id: string) => string;
  payLabel: (id: string) => string;
  adjustmentValue: (employeeId: string, field: AdjustmentMoneyField) => string;
  adjustmentReasonValue: (employeeId: string) => string;
  onAdjustmentChange: (employeeId: string, field: AdjustmentField, value: string) => void;
  onView: (item: DetailItem) => void;
  onViewSources: (item: DetailItem) => void;
}

/**
 * Tabla editable del borrador: muestra lo calculado por empleado (fijo,
 * comisiones, vales, neto) y permite ajustar bonos y otros descuentos por
 * fila antes de recalcular. Los empleados aún sin cálculo aparecen con sus
 * montos en blanco ("—") para poder cargarles un ajuste.
 */
function DraftPayrollTable({
  rows,
  employeeName,
  payLabel,
  adjustmentValue,
  adjustmentReasonValue,
  onAdjustmentChange,
  onView,
  onViewSources,
}: DraftPayrollTableProps) {
  return (
    <DataTable minWidth="2xl" wrapperClassName="mt-4">
      <thead>
        <tr className={tableHeaderClass}>
          <th className={headCellClass} scope="col">
            Empleado
          </th>
          <th className={moneyHeadClass} scope="col">
            Fijo (días)
          </th>
          <th className={moneyHeadClass} scope="col">
            Comisión fija
          </th>
          <th className={moneyHeadClass} scope="col">
            Comisión por porcentaje
          </th>
          <th className={moneyHeadClass} scope="col">
            Bonos
          </th>
          <th className={moneyHeadClass} scope="col">
            Vales (descuento)
          </th>
          <th className={moneyHeadClass} scope="col">
            Otros (descuento)
          </th>
          <th className={headCellClass} scope="col">
            Motivo del ajuste
          </th>
          <th className={moneyHeadClass} scope="col">
            Neto
          </th>
          <th className={moneyHeadClass} scope="col">
            Pagado
          </th>
          <th className={moneyHeadClass} scope="col">
            Saldo
          </th>
          <th className={headCellClass} scope="col">
            Detalle
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const item = row.item;
          // F8: el motivo es obligatorio en cuanto la fila tiene un bono o un
          // descuento distinto de 0. Se DERIVA del valor que se está
          // editando, no de lo ya persistido, así el campo acompaña el
          // número que el admin acaba de escribir.
          const reasonRequired =
            (toNumber(adjustmentValue(row.employeeId, "bonuses")) ?? 0) !== 0 ||
            (toNumber(adjustmentValue(row.employeeId, "others")) ?? 0) !== 0;
          const reasonValue = adjustmentReasonValue(row.employeeId);
          // F8 (visibilidad): el aviso del motivo faltante vive DENTRO del
          // diálogo, en la MISMA celda del motivo. El error de la página queda
          // detrás del modal abierto —el admin no lo ve y cree que el botón no
          // responde—, así que el aviso va donde está escribiendo. Se deriva
          // del valor que se está editando: aparece con el monto y desaparece
          // apenas el motivo existe.
          const reasonMissing = reasonRequired && reasonValue.trim() === "";
          // Reclasificación sin mover el total: fija = comisiones − porcentaje.
          const commission = item
            ? splitCommissionByOrigin({ commissions: item.commissions, detail: item.detail_json })
            : null;
          return (
            <tr key={row.employeeId} className={tableRowClass}>
              <td className={tableCellClass}>
                <span className="block">{employeeName(row.employeeId)}</span>
                <span className="block text-xs text-text-tertiary">{payLabel(row.employeeId)}</span>
              </td>
              <td className={moneyCellClass}>{item ? formatMoney(item.base_fixed) : "—"}</td>
              <td className={moneyCellClass}>{commission ? formatMoney(commission.fixed) : "—"}</td>
              <td className={moneyCellClass}>{commission ? formatMoney(commission.percent) : "—"}</td>
              <td className={tableCellClass}>
                <input
                  inputMode="numeric"
                  value={formatMoneyInput(adjustmentValue(row.employeeId, "bonuses"))}
                  onChange={(event) => onAdjustmentChange(row.employeeId, "bonuses", stripMoneyInput(event.target.value))}
                  aria-label={`Bonos de ${employeeName(row.employeeId)}`}
                  className={tableInputClass}
                />
              </td>
              {/*
                Regla del dueño (2026-10-01): mismo criterio que la tabla
                cerrada —la celda muestra SOLO el total REAL de vales
                (`voucher_total`), sin líneas secundarias—. La conciliación del
                monto aplicado y de la deuda vive en el modal «Ver facturas y
                vales». El signo es solo presentación: el vale se guarda
                positivo.

                El `className` de esta celda lo congela la guarda del dueño: el
                alineado del dinero va en el `span` de adentro.
              */}
              <td className={tableCellClass} title={item ? voucherCellTitle(item) : undefined}>
                {item ? (
                  <span className="block text-right tabular-nums">{`-${formatMoney(item.voucher_total)}`}</span>
                ) : (
                  "—"
                )}
              </td>
              <td className={tableCellClass}>
                {/* El signo es solo presentación: el descuento se guarda positivo. */}
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true">−</span>
                  <input
                    inputMode="numeric"
                    value={formatMoneyInput(adjustmentValue(row.employeeId, "others"))}
                    onChange={(event) => onAdjustmentChange(row.employeeId, "others", stripMoneyInput(event.target.value))}
                    aria-label={`Otros descuentos de ${employeeName(row.employeeId)}`}
                    className={tableInputClass}
                  />
                </span>
              </td>
              {/*
                F8: el motivo viaja con el monto. Es un campo de texto sin
                máscara de dinero; `aria-required` y el marcador «Motivo
                (obligatorio)» lo anuncian cuando la fila lleva ajuste. La
                guarda de verdad vive en el servicio; la comprobación de la
                pantalla nombra al empleado y, ahora, avisa INLINE junto al
                campo (texto plano, nunca un `Alert` ni un `role=` a mano).
              */}
              <td className={tableCellClass}>
                <input
                  type="text"
                  value={reasonValue}
                  onChange={(event) => onAdjustmentChange(row.employeeId, "reason", event.target.value)}
                  maxLength={ADJUSTMENT_REASON_MAX_LENGTH}
                  aria-label={`Motivo del ajuste de ${employeeName(row.employeeId)}`}
                  aria-required={reasonRequired}
                  placeholder={reasonRequired ? "Motivo (obligatorio)" : "—"}
                  className={tableInputClass}
                />
                {/* El aviso vive pegado al campo, no en el error de la
                    página: con el diálogo abierto ese error queda detrás. */}
                {reasonMissing && (
                  <p className="mt-1 text-xs text-error">
                    {`Falta el motivo del ajuste de ${employeeName(row.employeeId)}.`}
                  </p>
                )}
              </td>
                <td className={cn(moneyCellClass, "font-semibold")}>
                {item ? formatMoney(item.net_pay) : "—"}
              </td>
              <td className={moneyCellClass}>{item ? formatMoney(item.paid) : "—"}</td>
              <td className={moneyCellClass}>{item ? formatMoney(item.remaining) : "—"}</td>
              <td className={tableCellClass}>
                {item ? (
                  <span className="inline-flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onView(item)}
                      aria-label={`Ver el desglose de ${employeeName(row.employeeId)}`}
                      className={ghostClass}
                    >
                      Ver
                    </button>
                    {/* F6: mismo modal de facturas y vales que la tabla cerrada. */}
                    <button
                      type="button"
                      onClick={() => onViewSources(item)}
                      aria-label={`Ver facturas y vales de ${employeeName(row.employeeId)}`}
                      className={ghostClass}
                    >
                      Ver facturas y vales
                    </button>
                  </span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr className={tableRowClass}>
            <td className={tableCellClass} colSpan={12}>
              No hay empleados activos para liquidar.
            </td>
          </tr>
        )}
      </tbody>
    </DataTable>
  );
}

/** Fila editable del pago por porciones: método y monto como campos separados. */
interface PortionDraft {
  key: string;
  method_code: string;
  amount: string;
}

interface ExpandedItemPanelProps {
  item: DetailItem;
  methods: PaymentMethodRow[];
  canPay: boolean;
  busy: boolean;
  portions: PortionDraft[];
  onPortionChange: (key: string, patch: Partial<Pick<PortionDraft, "method_code" | "amount">>) => void;
  onAddPortion: () => void;
  onRemovePortion: (key: string) => void;
  onTotalize: () => void;
  onPay: () => void;
}

/**
 * Desglose de comisiones y pago por porciones de un ítem (contenido del modal
 * de detalle). Las porciones se capturan en una tabla con método y monto como
 * columnas independientes, en lugar del string "metodo:monto" que había que
 * escribir y parsear.
 */
function ExpandedItemPanel({
  item,
  methods,
  canPay,
  busy,
  portions,
  onPortionChange,
  onAddPortion,
  onRemovePortion,
  onTotalize,
  onPay,
}: ExpandedItemPanelProps) {
  const filled = portions.reduce((acc, portion) => acc + (toNumber(portion.amount) ?? 0), 0);
  const missing = Math.max(0, item.remaining - filled);
  const canTotalize = portions.some((portion) => portion.amount.trim() === "") && missing > 0;
  return (
    <div
      id={`payroll-item-detail-${item.id}`}
      className="mt-2 rounded bg-surface-hover p-3 text-xs text-text-secondary"
    >
      {item.detail_json.length === 0 ? (
        <p>Sueldo fijo: sin reporte de comisiones.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {item.detail_json.map((line) => (
            <li key={line.item_id}>
              Factura #{line.consecutive_number ?? "?"} · {detailLineLabel(line.item_type)} × {line.qty} a{" "}
              {formatMoney(line.unit_price)} = {formatMoney(line.line_subtotal)} →{" "}
              {detailLineCommissionOrigin(line) === "percent"
                ? `comisión por porcentaje ${formatMoney(line.commission)}${
                    line.commission_percent != null
                      ? ` (${formatPercent(line.commission_percent)}%)`
                      : ""
                  }`
                : `comisión fija ${formatMoney(line.commission)}`}
            </li>
          ))}
        </ul>
      )}
      {canPay && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onPay();
          }}
          className="mt-3 flex flex-col gap-3"
        >
          <div className="overflow-x-auto">
            <table className={cn("w-full text-left text-xs", "min-w-[420px]")}>
              <thead>
                <tr className={tableHeaderClass}>
                  <th className={tableCellClass} scope="col">
                    Método
                  </th>
                  <th className={tableCellClass} scope="col">
                    Monto
                  </th>
                  <th className={tableCellClass} scope="col">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {portions.map((portion, index) => (
                  <tr key={portion.key} className={tableRowClass}>
                    <td className={tableCellClass}>
                      <select
                        value={portion.method_code}
                        onChange={(event) => onPortionChange(portion.key, { method_code: event.target.value })}
                        aria-label={`Método de la porción ${index + 1}`}
                        className={inputClass}
                      >
                        <option value="">Método…</option>
                        {methods.map((row) => (
                          <option key={row.id} value={row.code}>
                            {row.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={tableCellClass}>
                      <input
                        inputMode="numeric"
                        value={formatMoneyInput(portion.amount)}
                        onChange={(event) => onPortionChange(portion.key, { amount: stripMoneyInput(event.target.value) })}
                        aria-label={`Monto de la porción ${index + 1}`}
                        placeholder="0"
                        className={tableInputClass}
                      />
                    </td>
                    <td className={tableCellClass}>
                      {portions.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onRemovePortion(portion.key)}
                          aria-label={`Quitar la porción ${index + 1}`}
                          className={ghostClass}
                        >
                          Quitar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {portions.length === 0 && (
                  <tr className={tableRowClass}>
                    <td className={tableCellClass} colSpan={3}>
                      Sin porciones. Agregue al menos una para pagar.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onAddPortion} className={ghostClass}>
              Agregar porción
            </button>
            <button
              type="button"
              onClick={onTotalize}
              disabled={!canTotalize}
              title={canTotalize ? "Rellena una porción vacía con lo que falta" : "Nada por rellenar"}
              className={ghostClass}
            >
              Totalizar
            </button>
            <span className="text-text-tertiary">
              Saldo: {formatMoney(item.remaining)} · Porciones: {formatMoney(filled)} · Falta:{" "}
              {formatMoney(missing)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Pagando…" : "Pagar"}
            </button>
            <span className="text-text-tertiary">
              Métodos activos: {methods.map((row) => row.code).join(", ") || "sin métodos activos"}
            </span>
          </div>
        </form>
      )}
    </div>
  );
}

/** Campo de solo lectura del detalle de una factura o un vale. */
function SourceDetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className="break-words text-sm text-text-primary">{children}</dd>
    </div>
  );
}

interface SettlementSourcesPanelProps {
  sources: PayrollSettlementSources | null;
  /**
   * F6/regla del dueño (2026-10-01): el ítem de nómina del empleado.
   *
   * Es la fuente del monto APLICADO (`deductions_vales`, lo que el neto
   * descuenta de verdad) y de la deuda PENDIENTE (`pending_debt`) que la
   * columna de vales ya no imprime. Vive acá y no en la lectura de fuentes
   * porque el detalle del período ya lo trae leído: no se duplica consulta.
   */
  item: DetailItem | null;
  busy: boolean;
  invoiceTargetId: string | null;
  invoiceDetail: InvoiceDetail | null;
  invoiceBusy: boolean;
  voucherTargetId: string | null;
  voucherDetail: VoucherRequestRow | null;
  voucherBusy: boolean;
  employeeName: (id: string) => string;
  onViewInvoice: (invoiceId: string) => void;
  onViewVoucher: (voucher: PayrollSettlementVoucher) => void;
}

/**
 * F6: contenido del modal "Ver facturas y vales": las dos listas del empleado
 * (facturas y vales) y el detalle de la fila elegida, en un panel EN LÍNEA (no
 * otro diálogo). El detalle de la factura sale de la lectura EXISTENTE de
 * facturación (`getInvoiceAction`) y el del vale de la lectura existente de
 * vales (`listVouchersAction`): acá no se duplica ninguna consulta.
 *
 * El ajuste del mixto (`ajuste_mixto`) NO es una factura: se muestra aparte, con
 * su monto y su explicación, para que el lector no lo confunda con un
 * consecutivo. Los vacíos describen lo esperado ("no tiene facturas/vales") y
 * son texto plano, no un aviso.
 *
 * Regla del dueño (2026-10-01): «vales es solo vales y punto». La columna de
 * vales de las dos tablas muestra solo el total; la conciliación —cuánto
 * descontó el neto y cuánta deuda quedó— se lee acá, junto a los vales que la
 * componen, y solo cuando cada cifra aplica.
 */
function SettlementSourcesPanel({
  sources,
  item,
  busy,
  invoiceTargetId,
  invoiceDetail,
  invoiceBusy,
  voucherTargetId,
  voucherDetail,
  voucherBusy,
  employeeName,
  onViewInvoice,
  onViewVoucher,
}: SettlementSourcesPanelProps) {
  return (
    <div className="mt-3 flex flex-col gap-5">
      {busy && !sources ? (
        <p className="text-sm text-text-tertiary">Leyendo facturas y vales…</p>
      ) : null}

      {sources?.adjustment ? (
        <section className="rounded-md border border-border-color p-3 dark:border-border-color-2">
          <h3 className="text-sm font-semibold text-text-primary">Ajuste del mixto</h3>
          <p className="mt-1 text-sm text-text-secondary">
            {`El básico absorbió ${formatMoney(-sources.adjustment.commission)} de los porcentajes de servicios: ese porcentaje no se suma aparte. Se muestra en negativo para que la suma del detalle cuadre con las comisiones.`}
          </p>
          <p className="mt-1 text-sm font-semibold text-text-primary">
            {formatMoney(sources.adjustment.commission)}
          </p>
        </section>
      ) : null}

      <section>
        <h3 className="text-sm font-semibold text-text-primary">Facturas de la liquidación</h3>
        {sources && sources.invoices.length === 0 ? (
          <p className="mt-1 text-sm text-text-tertiary">
            La liquidación no tiene facturas: no hubo comisiones por factura en este período.
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2">
          {(sources?.invoices ?? []).map((invoice) => (
            <li
              key={invoice.invoice_id}
              className="rounded border border-border-color p-2 dark:border-border-color-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-text-primary">
                  {`Factura #${invoice.consecutive_number ?? "sin consecutivo"}`}
                </span>
                <span className="text-sm text-text-secondary">
                  {`Comisión de la liquidación: ${formatMoney(invoice.commission)}`}
                </span>
                <button
                  type="button"
                  onClick={() => onViewInvoice(invoice.invoice_id)}
                  aria-label={`Ver el detalle de la factura ${invoice.consecutive_number ?? "sin consecutivo"}`}
                  className={ghostClass}
                >
                  Ver detalle
                </button>
              </div>
              {invoiceTargetId === invoice.invoice_id ? (
                <div className="mt-2 rounded bg-surface-hover p-2">
                  {invoiceBusy ? (
                    <p className="text-xs text-text-tertiary">Leyendo la factura…</p>
                  ) : invoiceDetail ? (
                    <>
                      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <SourceDetailField label="Consecutivo">
                          {invoiceDetail.invoice.consecutive_number}
                        </SourceDetailField>
                        <SourceDetailField label="Estado">{invoiceDetail.invoice.status}</SourceDetailField>
                        <SourceDetailField label="Cliente">
                          {invoiceDetail.invoice.client_name ?? "—"}
                        </SourceDetailField>
                        <SourceDetailField label="Fecha">
                          {new Date(invoiceDetail.invoice.created_at).toLocaleString("es-CO")}
                        </SourceDetailField>
                        <SourceDetailField label="Total">
                          {formatMoney(invoiceDetail.invoice.total)}
                        </SourceDetailField>
                        <SourceDetailField label="Pagado">{formatMoney(invoiceDetail.paid)}</SourceDetailField>
                        <SourceDetailField label="Saldo">{formatMoney(invoiceDetail.remaining)}</SourceDetailField>
                      </dl>
                      <ul className="mt-2 flex flex-col gap-1 text-xs text-text-secondary">
                        {invoiceDetail.items.map((item) => (
                          <li key={item.id}>
                            {`${item.custom_name ?? detailLineLabel(item.item_type)} × ${item.qty} = ${formatMoney(item.subtotal)}`}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="text-xs text-text-tertiary">No se pudo abrir la factura.</p>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-text-primary">Vales de la liquidación</h3>
        {sources && sources.vouchers.length === 0 ? (
          <p className="mt-1 text-sm text-text-tertiary">
            La liquidación no tiene vales: no hubo vales descontados en este período.
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2">
          {(sources?.vouchers ?? []).map((voucher) => (
            <li key={voucher.id} className="rounded border border-border-color p-2 dark:border-border-color-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-text-primary">{formatFullDate(voucher.request_date)}</span>
                <span className="text-sm text-text-secondary">{formatMoney(voucher.amount)}</span>
                <span className="text-sm text-text-secondary">{voucher.status}</span>
                <button
                  type="button"
                  onClick={() => onViewVoucher(voucher)}
                  aria-label={`Ver el detalle del vale del ${voucher.request_date}`}
                  className={ghostClass}
                >
                  Ver detalle
                </button>
              </div>
              {voucherTargetId === voucher.id ? (
                <div className="mt-2 rounded bg-surface-hover p-2">
                  {voucherBusy ? (
                    <p className="text-xs text-text-tertiary">Leyendo el vale…</p>
                  ) : voucherDetail ? (
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <SourceDetailField label="Empleado">
                        {employeeName(voucherDetail.employee_id)}
                      </SourceDetailField>
                      <SourceDetailField label="Monto">{formatMoney(voucherDetail.amount)}</SourceDetailField>
                      <SourceDetailField label="Fecha de solicitud">
                        {voucherDetail.request_date}
                      </SourceDetailField>
                      <SourceDetailField label="Estado">{voucherDetail.status}</SourceDetailField>
                      <SourceDetailField label="Método de pago">
                        {voucherDetail.method_code ?? "—"}
                      </SourceDetailField>
                      <SourceDetailField label="Creado por">
                        {voucherDetail.created_by_name ?? "—"}
                      </SourceDetailField>
                      {voucherDetail.approved_by_name ? (
                        <SourceDetailField label="Aprobado por">
                          {voucherDetail.approved_by_name}
                        </SourceDetailField>
                      ) : null}
                      <SourceDetailField label="Observación">
                        {voucherDetail.observation ?? "-"}
                      </SourceDetailField>
                    </dl>
                  ) : (
                    <p className="text-xs text-text-tertiary">No se pudo abrir el vale.</p>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {item && item.deductions_vales < item.voucher_total ? (
          <p className="mt-2 text-sm text-text-secondary">
            {`Del total de vales, el neto de este período descuenta ${formatMoney(item.deductions_vales)}: el tope de descuentos no aplicó el resto.`}
          </p>
        ) : null}
        {item && item.pending_debt > 0 ? (
          <p className="mt-1 text-sm text-text-secondary">
            {`Queda una deuda de ${formatMoney(item.pending_debt)} originada en este período: es el sobrante de vales que el tope no alcanzó a descontar.`}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function PayrollClient(props: PayrollClientProps) {
  const [periods, setPeriods] = useState<PayrollPeriodRow[]>(props.initialPeriods);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialPeriods[0]?.id ?? null);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [detailTargetId, setDetailTargetId] = useState<string | null>(null);
  // PA3: el resumen por período llega leído del servidor (agrega plata de TODA
  // la planta) y se PISA con el detalle más fresco de cada período: abrir,
  // calcular, pagar, cerrar o borrar. Es estado, no derivación, porque el
  // servidor es la única fuente de un agregado de la sede y lo único que lo
  // actualiza es una lectura suya.
  const [summaries, setSummaries] = useState<Record<string, PayrollItemTotals>>(() =>
    indexPeriodTotals(props.initialSummaries),
  );
  // Filtro de estado de la lista de períodos.
  const [statusFilter, setStatusFilter] = useState<string>("todos");
  // PA3 (consulta puntual): "pagos del mes por empleado" NO llega leído del
  // servidor. El formulario guarda lo ELEGIDO y `monthQuery` lo ÚLTIMO
  // consultado con su resultado; `null` es el estado previo a la consulta, que
  // no muestra tabla ni número alguno.
  const [queryMonth, setQueryMonth] = useState<string>("");
  const [queryEmployeeId, setQueryEmployeeId] = useState<string>("");
  const [monthQuery, setMonthQuery] = useState<{
    month: string;
    employeeId: string;
    rows: PayrollMonthEmployeeRow[];
  } | null>(null);
  // Un solo canal de ESTADO: lo que sigue siendo el caso mientras no se
  // corrija (fallo de acción o validación incompleta). Lo que acaba de pasar
  // (éxito) es EVENTO y sale por `toast`, no por estado.
  const [error, setError] = useState<string | null>(null);

  /**
   * F10 (2026-10-04): el día desde el que la nómina OPERA es un HECHO derivado —
   * el del primer período (`payrollHistoryFloor`), no una configuración. Se
   * DERIVA acá de los períodos que la pantalla ya tiene (y que se refrescan con
   * cada apertura), con la MISMA función pura que usa el servicio: una prop de
   * servidor para esto quedaría vieja en el instante en que se abre el primer
   * período. `null` = todavía no hay ningún período, y entonces lo declara esta
   * liquidación.
   */
  const payrollStartDate = payrollHistoryFloor(periods);

  // F10: abrir un período NO se pregunta el rango. La única entrada al diálogo
  // es la lista de ciclos pendientes: su ciclo queda ELEGIDO y el rango se
  // DERIVA del ciclo y del arranque. `openTarget` es ese ciclo pendiente.
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [openTarget, setOpenTarget] = useState<PendingPayrollSettlement | null>(null);
  /**
   * La fecha desde la que la nómina OPERA, tal como la escribe quien abre la
   * PRIMERA liquidación. Es estado del diálogo (no de la instalación): sólo
   * existe mientras no haya períodos, y en cuanto el primer período se crea
   * deja de preguntarse — el arranque pasa a ser un hecho derivado.
   */
  const [openDeclaredStart, setOpenDeclaredStart] = useState<string>("");
  const [openError, setOpenError] = useState<string | null>(null);
  // Pagos: porciones por ítem (método y monto como campos separados en tabla).
  const [portions, setPortions] = useState<Record<string, PortionDraft[]>>({});
  // Contador para claves estables de las filas de porciones (no usar el índice:
  // al quitar una fila intermedia el índice cambia y React reusaría el input equivocado).
  const portionKeyRef = useRef(0);
  /**
   * CL-2: marca de idempotencia del INTENTO de pago, por ítem.
   *
   * Se acuña cuando el intento EMPIEZA (al confirmar el pago de ese ítem) y se
   * conserva mientras el intento se reintenta: si la red se corta y el usuario
   * vuelve a oprimir Pagar, el servidor recibe la MISMA marca y devuelve el pago
   * ya registrado, en vez de pagar otra vez. Se renueva sólo cuando el intento
   * anterior terminó bien, o cuando el desglose se cierra (el siguiente intento
   * es otro distinto).
   *
   * Es un mapa por ÍTEM y no una marca sola: la identidad de la operación es
   * (ítem, marca) —el ítem es el que identifica la URL—, y así un intento fallido
   * del ítem A no le presta su marca a un pago del ítem B.
   *
   * No es por tecla ni por render: los montos y los métodos del borrador cambian
   * libremente sin tocar la marca, así que dos abonos legítimos del mismo monto
   * son dos intentos con dos marcas (dos pagos), no una repetición.
   */
  const paymentKeyRef = useRef(new Map<string, string>());
  /**
   * CL-5: marca de idempotencia del INTENTO de pago extraordinario (PA-2a).
   *
   * Una sola marca (no un mapa): el formulario escribe UN pago a la vez, así que
   * su identidad es (empleado, marca) y el registro del intento alcanza con una
   * marca mientras el diálogo está abierto. Se acuña cuando el intento EMPIEZA
   * (al confirmar) y se conserva si el intento falla: el reintento tiene que
   * llevar la misma para que el servidor reconozca la repetición en vez de
   * escribir un segundo pago extraordinario. Se suelta cuando el intento termina
   * bien y al cerrar el diálogo.
   *
   * Acá no hay tope que frene nada: el monto lo escribe el admin y NO se topa
   * (decisión del dueño, 036). Por eso la marca es la única barrera posible.
   *
   * No es por tecla ni por render: los campos del formulario (monto, motivo,
   * tipo, días) cambian libremente sin tocar la marca, así que dos pagos
   * legítimos distintos son dos intentos con dos marcas.
   */
  const extraKeyRef = useRef<string | null>(null);
  // Ajustes por empleado al calcular (bonos y otros descuentos editables).
  const [adjustments, setAdjustments] = useState<
    Record<string, Partial<Record<AdjustmentField, string>>>
  >({});
  const [busy, setBusy] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  // Confirmación clásica antes de una acción destructiva (borrar borrador).
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // Transición para los cambios de vista (detalle del periodo / vales):
  // la UI no se congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();

  // PA-2a: pagos extraordinarios (nómina individual). La lista es el registro
  // visible del módulo; el formulario es el único lugar donde se escribe un
  // monto con motivo. `extraError` es ESTADO del diálogo (lo que sigue mal
  // mientras no se corrija), separado del error de la página.
  const [extras, setExtras] = useState<PayrollExtraRow[]>([]);
  const [extraDialogOpen, setExtraDialogOpen] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const [extraBusy, setExtraBusy] = useState(false);
  const [extraEmployeeId, setExtraEmployeeId] = useState("");
  const [extraKind, setExtraKind] = useState<PayrollExtraKind | "">("");
  const [extraReason, setExtraReason] = useState("");
  const [extraAmount, setExtraAmount] = useState("");
  const [extraMethodCode, setExtraMethodCode] = useState("");
  const [extraReference, setExtraReference] = useState("");
  const [extraDaysFrom, setExtraDaysFrom] = useState("");
  const [extraDaysTo, setExtraDaysTo] = useState("");

  // PA-2b: la corrección del período cerrado que se está mirando, con las dos
  // versiones ya comparadas. Es lectura del período (se recarga con el detalle)
  // y el formulario es el único lugar donde se escribe el motivo.
  const [correction, setCorrection] = useState<PayrollPeriodCorrectionResult | null>(null);
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);

  /**
   * F6: las fuentes de la liquidación (facturas, ajuste del mixto y vales) del
   * empleado cuyo modal está abierto. `sourcesTarget` guarda a QUIÉN y de QUÉ
   * período pertenece, para que el modal no pueda mostrar las fuentes de otro
   * empleado si el usuario cambia de período mientras carga.
   */
  const [sourcesTarget, setSourcesTarget] = useState<{ periodId: string; employeeId: string } | null>(null);
  const [sources, setSources] = useState<PayrollSettlementSources | null>(null);
  const [sourcesBusy, setSourcesBusy] = useState(false);
  /** F6: detalle de la factura abierta con la lectura existente de facturación. */
  const [invoiceTargetId, setInvoiceTargetId] = useState<string | null>(null);
  const [invoiceDetail, setInvoiceDetail] = useState<InvoiceDetail | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  /** F6: detalle del vale abierto con la lectura existente de vales. */
  const [voucherTargetId, setVoucherTargetId] = useState<string | null>(null);
  const [voucherDetail, setVoucherDetail] = useState<VoucherRequestRow | null>(null);
  const [voucherBusy, setVoucherBusy] = useState(false);

  // Los pagos extraordinarios no llegan por props (la página los arma para los
  // períodos): se leen al montar. Sólo el admin tiene la superficie, así que el
  // efecto no dispara para el empleado.
  useEffect(() => {
    if (!props.canAdmin) return;
    let active = true;
    void listPayrollExtrasAction().then((result) => {
      if (!active) return;
      if (result.success) setExtras(result.data);
      else setError(`${result.code}: ${result.message}`);
    });
    return () => {
      active = false;
    };
  }, [props.canAdmin]);

  // Filas del borrador: la planta activa más los empleados ya calculados que
  // hayan quedado inactivos después del cálculo (no se pierden al recalcular).
  const itemByEmployee = new Map((detail?.items ?? []).map((item) => [item.employee_id, item]));
  const activeEmployeeIds = props.initialEmployees
    .filter((row) => row.is_active)
    .map((row) => row.id);
  const draftEmployeeIds = [
    ...activeEmployeeIds,
    ...(detail?.items ?? [])
      .map((item) => item.employee_id)
      .filter((id) => !activeEmployeeIds.includes(id)),
  ];
  const draftRows: DraftRow[] = draftEmployeeIds.map((employeeId) => ({
    employeeId,
    item: itemByEmployee.get(employeeId) ?? null,
  }));

  function show<T>(result: ActionResult<T>, okText?: string): result is { success: true; data: T } {
    if (!result.success) {
      // El fallo de una acción es ESTADO: deja el mensaje en la vista,
      // persistente mientras el problema exista.
      setError(`${result.code}: ${result.message}`);
      return false;
    }
    if (okText) {
      // El éxito de una acción es EVENTO: acaba de pasar y no tiene que
      // quedarse en pantalla compitiendo con lo que sí importa. Antes era un
      // <p role="status"> que persistía hasta la siguiente acción. El texto es
      // el mismo.
      toast.success(okText);
    }
    return true;
  }

  /**
   * Valor vigente de un ajuste: lo editado por el usuario o, si todavía no lo
   * tocó, el monto ya calculado del ítem (así la tabla "viene" con lo
   * calculado y recalcular no borra los ajustes previos).
   */
  function adjustmentValue(employeeId: string, field: AdjustmentMoneyField): string {
    const edited = adjustments[employeeId]?.[field];
    if (edited !== undefined) return edited;
    const item = itemByEmployee.get(employeeId);
    if (!item) return "";
    return String(field === "bonuses" ? item.bonuses : item.other_discounts);
  }

  /**
   * F8: motivo vigente de un ajuste. Igual que los montos, si el admin todavía
   * no lo tocó se muestra el motivo ya persistido del ítem (así recalcular no
   * borra el escrito antes).
   */
  function adjustmentReasonValue(employeeId: string): string {
    const edited = adjustments[employeeId]?.reason;
    if (edited !== undefined) return edited;
    return itemByEmployee.get(employeeId)?.adjustment_reason ?? "";
  }

  function updateAdjustment(employeeId: string, field: AdjustmentField, value: string) {
    setAdjustments((prev) => ({
      ...prev,
      [employeeId]: { ...prev[employeeId], [field]: value },
    }));
  }

  async function refreshPeriods(select?: string) {
    const result = (await listPeriodsAction()) as ActionResult<PayrollPeriodRow[]>;
    if (result.success) {
      setPeriods(result.data);
      if (select) setSelectedId(select);
      else if (!selectedId && result.data[0]) setSelectedId(result.data[0].id);
    }
  }

  /**
   * Acepta el detalle MÁS FRESCO de un período. Es la única lectura de nómina
   * que vuelve de una acción, así que es la que pisa el resumen del período: sin
   * esto, el monto que el admin acaba de pagar (o recalcular) seguiría
   * mostrándose viejo en la lista hasta recargar.
   */
  function acceptDetail(next: PeriodDetail) {
    setDetail(next);
    setSummaries((prev) => ({ ...prev, [next.period.id]: summarizePayrollItems(next.items) }));
  }

  // Inventory-style cancel: closing the dialog always resets its state.
  function closeDetail() {
    setDetail(null);
    setDetailTargetId(null);
    setAdjustments({});
    setPortions({});
    // CL-2: cerrar el desglose abandona los intentos de pago pendientes; el
    // próximo acuña marcas nuevas. Si un intento falló y se reabre el desglose
    // para OTRO pago, ese pago no puede quedar pegado a la marca abandonada.
    paymentKeyRef.current.clear();
    setDetailDialogOpen(false);
    setCorrection(null);
    closeCorrectionDialog();
    // F6: cerrar la liquidación cierra también su modal de facturas y vales.
    closeSettlementSources();
  }

  /**
   * PA-2b: la corrección del período (o `null`). Se lee SIEMPRE al cargar el
   * detalle: si no, la pantalla mostraría la corrección del período anterior.
   */
  async function loadCorrection(id: string) {
    const result = (await getPayrollPeriodCorrectionAction(
      id,
    )) as ActionResult<PayrollPeriodCorrectionResult | null>;
    if (result.success) setCorrection(result.data);
    else setError(`${result.code}: ${result.message}`);
  }

  function loadDetail(id: string) {
    setSelectedId(id);    startViewTransition(async () => {
      const result = (await getPeriodDetailAction(id)) as ActionResult<PeriodDetail>;
      if (show(result)) {
        acceptDetail(result.data);
        setDetailDialogOpen(true);
      }
      // Sólo el admin tiene la superficie de la corrección (es nómina de la
      // sede); para el empleado se limpia para no dejar la del período previo.
      if (props.canAdmin) await loadCorrection(id);
      else setCorrection(null);
    });
  }

  /**
   * F10: abre el diálogo en el ciclo pendiente MÁS ATRASADO. La lista de
   * pendientes ya viene ordenada así (lo más vencido primero), y si está vacía
   * el diálogo lo dice: no hay rango que elegir ni período que abrir.
   */
  function openPeriodDialog() {
    setOpenError(null);
    setOpenTarget(pendingSettlements[0] ?? null);
    setOpenDeclaredStart("");
    setOpenDialogOpen(true);
  }

  /**
   * F9/F10: abre el diálogo ya POSICIONADO en el ciclo que el aviso acaba de
   * nombrar. Es la única entrada: el ciclo queda elegido y su rango se deriva
   * (completo, o recortado al arranque de la nómina).
   */
  function openPendingSettlement(entry: PendingPayrollSettlement) {
    setOpenError(null);
    setOpenTarget(entry);
    // La fecha declarada es del CICLO elegido: al cambiar de ciclo, la que se
    // había escrito ya no aplica (el campo está acotado al nuevo ciclo).
    setOpenDeclaredStart("");
    setOpenDialogOpen(true);
  }

  async function handleOpen(event: FormEvent) {
    event.preventDefault();
    if (openTarget === null) {
      setOpenError("No hay ciclos cerrados sin liquidar: no hay período que abrir.");
      return;
    }
    if (!startDate || !endDate) {
      // F10: el rango no sale cuando el CICLO no se puede abrir, y el motivo lo
      // dice el MISMO validador del servicio (`resolveOpenPayrollRange`): sin
      // ciclos que elegir no es lo que impide abrir, así que decirlo sería
      // mentir sobre la causa.
      setOpenError(
        // Guarda defensiva: con un ciclo elegido el rango SIEMPRE sale del
        // validador, así que esta rama no debería dispararse — queda como el
        // invariante, con la copia de siempre.
        openResolution === null || openResolution.ok
          ? "Indique el rango del período."
          : openPayrollRejectionMessage(openResolution.reason, {
              payrollStartDate,
              cycle: openCycle,
            }),
      );
      return;
    }
    if (endDate < startDate) {
      setOpenError("La fecha final no puede ser anterior a la inicial.");
      return;
    }
    // F10: la guarda de apertura repite las DOS verdades del servidor sobre el
    // ciclo elegido, con las MISMAS funciones puras que el aviso y el servicio:
    // no se abre un ciclo ANTERIOR al arranque de la nómina
    // (`isRangeBeforePayrollStart`, la regla única del arranque) y no se abre uno
    // que YA tiene su liquidación (`isPayrollCycleSettled`). El rango del primer
    // ciclo —recortado al arranque— sale de `resolveOpenPayrollRange`, el mismo
    // validador que el servicio aplica antes del INSERT; la autoridad final
    // sigue siendo el servidor, que decide sobre lo que el cliente no ve.
    if (isRangeBeforePayrollStart({ payrollStartDate, startDate, endDate })) {
      setOpenError(
        `Este ciclo cierra antes del ${payrollStartDate}, el día del primer período: la nómina de la instalación arranca ese día y nada anterior existe para el sistema.`,
      );
      return;
    }
    const collision = findOverlappingPeriod(periods, startDate, endDate, openTarget.frequency);
    if (collision) {
      setOpenError(
        `El rango se solapa con ${formatPeriodLabel(collision)} (${collision.status}). Ajuste las fechas o la cadencia.`,
      );
      return;
    }
    const settledCycle = isPayrollCycleSettled({
      periods,
      frequency: openTarget.frequency,
      cycle: { start_date: startDate, end_date: endDate },
    });
    if (settledCycle) {
      setOpenError(
        "Este ciclo ya tiene su liquidación para la cadencia elegida (o lo cubre un período heredado sin cadencia, que pagó a todo el plantel). Elija otro ciclo.",
      );
      return;
    }
    setOpenError(null);
    setBusy(true);
    // F10: el cuerpo lleva la CADENCIA del ciclo pendiente y su CIERRE. No hay
    // fechas en el envío: el rango (y su recorte) lo deriva el servidor. La
    // ÚNICA fecha que viaja es la que declara la PRIMERA liquidación —con
    // períodos ya no se manda, porque el arranque lo dan ellos—.
    const declaredStartDate = primeraLiquidacion ? openDeclaredStart : "";
    const result = (await openPayrollPeriodAction({
      frequency: openTarget.frequency,
      cycle_end_date: openTarget.end_date,
      ...(declaredStartDate ? { declared_start_date: declaredStartDate } : {}),
    })) as ActionResult<PayrollPeriodRow>;
    if (!result.success) {
      setBusy(false);
      setOpenError(`${result.code}: ${result.message}`);
      return;
    }
    const created = result.data;
    setOpenTarget(null);
    setOpenDialogOpen(false);
    await refreshPeriods(created.id);

    // Calcular de inmediato el período recién creado: así el borrador "viene"
    // calculado y el usuario no tiene que apretar "Recalcular".
    //
    // ATENCIÓN — efecto lateral real: `calculatePayroll` marca como
    // `descontada` los vales pendientes/aprobados del rango y escribe
    // auditoría. Por eso este cálculo se dispara SOLO al crear un período
    // nuevo; NUNCA al abrir uno existente (eso movería vales sin que nadie lo
    // pida). Crear un período, por lo tanto, descuenta vales sin intervención
    // adicional del usuario.
    const calculated = (await calculatePayrollAction(created.id, {
      adjustments: [],
    })) as ActionResult<PeriodDetail>;
    setBusy(false);
    if (calculated.success) {
      acceptDetail(calculated.data);
      setDetailDialogOpen(true);
      // EVENTO: el período recién abierto y calculado. Es la única salida de
      // éxito que no pasa por `show()` porque este flujo tiene dos desenlaces.
      toast.success("Periodo abierto y calculado.");
      return;
    }
    // Si el cálculo falla, el período igual quedó creado en borrador: se
    // muestra su detalle vacío para poder recalcular a mano. ESTADO: el
    // problema sigue ahí hasta que el usuario recalcule.
    setError(`Periodo abierto, pero el cálculo falló — ${calculated.code}: ${calculated.message}`);
    await loadDetail(created.id);
  }

  // Cerrar el modal de apertura siempre limpia su estado (mismo criterio que closeDetail).
  function closeOpenDialog() {
    setOpenTarget(null);
    setOpenDeclaredStart("");
    setOpenError(null);
    setOpenDialogOpen(false);
  }

  /**
   * Recalcula el borrador enviando el ajuste vigente de cada fila. Se envían
   * todas las filas (no solo las modificadas) porque el backend parte de cero
   * por empleado: omitir una fila borraría su bono/descuento previo.
   */
  async function handleRecalculate() {
    if (!selectedId) return;
    // F8: el motivo es obligatorio cuando la fila lleva un bono o un descuento.
    // Se rechaza acá con el canal de error que el módulo ya usa (el Alert de la
    // página), nombrando al empleado, para que el admin no mande un envío que el
    // servicio va a rechazar igual. La guarda de verdad es la del servicio: esto
    // es sólo la respuesta inmediata en pantalla.
    const missingReason = draftRows.find((row) => {
      const hasAdjustment =
        (toNumber(adjustmentValue(row.employeeId, "bonuses")) ?? 0) !== 0 ||
        (toNumber(adjustmentValue(row.employeeId, "others")) ?? 0) !== 0;
      return hasAdjustment && adjustmentReasonValue(row.employeeId).trim() === "";
    });
    if (missingReason) {
      setError(
        `Falta el motivo del ajuste de ${employeeName(missingReason.employeeId)}: escriba por qué se carga el bono o el descuento.`,
      );
      return;
    }
    const list = draftRows.map((row) => {
      const reason = adjustmentReasonValue(row.employeeId).trim();
      return {
        employee_id: row.employeeId,
        bonuses: toNumber(adjustmentValue(row.employeeId, "bonuses")) ?? 0,
        other_discounts: toNumber(adjustmentValue(row.employeeId, "others")) ?? 0,
        // Un motivo sin ajuste se envía como null: el servicio lo descarta y la
        // columna queda NULL («sin ajuste manual»), nunca un motivo suelto.
        adjustment_reason: reason === "" ? null : reason,
      };
    });
    setBusy(true);
    const result = (await calculatePayrollAction(selectedId, {
      adjustments: list,
    })) as ActionResult<PeriodDetail>;
    setBusy(false);
    if (show(result, "Borrador recalculado: vales pendientes/aprobados quedaron descontados.")) {
      acceptDetail(result.data);
    }
  }

  /** Filas de porción vigentes de un ítem. */
  function itemPortions(itemId: string): PortionDraft[] {
    return portions[itemId] ?? [];
  }

  /**
   * Crea una fila de porción con el primer método aún no usado y, si hay saldo,
   * prellena el monto con lo que falta por pagar (el usuario solo confirma).
   */
  function createPortion(item: DetailItem, rows: PortionDraft[]): PortionDraft {
    const used = new Set(rows.map((row) => row.method_code));
    const free = props.methods.find((row) => !used.has(row.code))?.code ?? "";
    const filled = rows.reduce((acc, row) => acc + (toNumber(row.amount) ?? 0), 0);
    const remaining = Math.max(0, item.remaining - filled);
    portionKeyRef.current += 1;
    return {
      key: `portion-${portionKeyRef.current}`,
      method_code: free,
      amount: remaining > 0 ? String(remaining) : "",
    };
  }

  function addPortion(item: DetailItem) {
    const row = createPortion(item, itemPortions(item.id));
    setPortions((prev) => ({ ...prev, [item.id]: [...(prev[item.id] ?? []), row] }));
  }

  function removePortion(itemId: string, key: string) {
    setPortions((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] ?? []).filter((row) => row.key !== key),
    }));
  }

  function changePortion(
    itemId: string,
    key: string,
    patch: Partial<Pick<PortionDraft, "method_code" | "amount">>,
  ) {
    setPortions((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  }

  /** Rellena la primera porción vacía con el saldo que falta (patrón de facturas). */
  function totalizePortions(item: DetailItem) {
    setPortions((prev) => {
      const rows = prev[item.id] ?? [];
      const index = rows.findIndex((row) => row.amount.trim() === "");
      if (index === -1) return prev;
      const filled = rows.reduce((acc, row) => acc + (toNumber(row.amount) ?? 0), 0);
      const remaining = Math.max(0, item.remaining - filled);
      if (remaining <= 0) return prev;
      return {
        ...prev,
        [item.id]: rows.map((row, i) => (i === index ? { ...row, amount: String(remaining) } : row)),
      };
    });
  }

  /** Abre el desglose de un ítem y deja una porción lista con el saldo pendiente. */
  function openItemDetail(item: DetailItem) {
    setDetailTargetId(item.id);
    if (!props.canPay || item.remaining <= 0) return;
    if (itemPortions(item.id).length > 0) return;
    const row = createPortion(item, []);
    setPortions((prev) => (prev[item.id]?.length ? prev : { ...prev, [item.id]: [row] }));
  }

  /**
   * F6: abre el modal "Ver facturas y vales" de la liquidación de un empleado.
   * El empleado logueado solo puede abrir la suya (el alcance por fila lo aplica
   * la action, igual que el detalle del período).
   */
  async function openSettlementSources(periodId: string, employeeId: string) {
    setSourcesTarget({ periodId, employeeId });
    setSources(null);
    setSourcesBusy(true);
    // El detalle de una fila anterior no sobrevive al cambio de empleado.
    setInvoiceTargetId(null);
    setInvoiceDetail(null);
    setVoucherTargetId(null);
    setVoucherDetail(null);
    const result = (await getPayrollSettlementSourcesAction(
      periodId,
      employeeId,
    )) as ActionResult<PayrollSettlementSources>;
    setSourcesBusy(false);
    if (show(result)) setSources(result.data);
  }

  function closeSettlementSources() {
    setSourcesTarget(null);
    setSources(null);
    setSourcesBusy(false);
    setInvoiceTargetId(null);
    setInvoiceDetail(null);
    setVoucherTargetId(null);
    setVoucherDetail(null);
  }

  /**
   * F6: detalle de una factura con la lectura EXISTENTE de facturación
   * (`getInvoiceAction`): no se duplica la consulta ni el alcance por sede.
   */
  async function openInvoiceDetail(invoiceId: string) {
    setInvoiceTargetId(invoiceId);
    setInvoiceDetail(null);
    setInvoiceBusy(true);
    const result = (await getInvoiceAction(invoiceId)) as ActionResult<InvoiceDetail>;
    setInvoiceBusy(false);
    if (show(result)) setInvoiceDetail(result.data);
  }

  /**
   * F6: detalle de un vale con la lectura EXISTENTE de vales
   * (`listVouchersAction`): se filtra por el mismo empleado y la MISMA fecha de
   * solicitud del vale de la liquidación, y se elige la fila por id.
   */
  async function openVoucherDetail(voucher: PayrollSettlementVoucher) {
    setVoucherTargetId(voucher.id);
    setVoucherDetail(null);
    setVoucherBusy(true);
    const result = (await listVouchersAction({
      employee_id: sourcesTarget?.employeeId,
      request_date: voucher.request_date,
      limit: 200,
    })) as ActionResult<VoucherRequestRow[]>;
    setVoucherBusy(false);
    if (show(result)) setVoucherDetail(result.data.find((row) => row.id === voucher.id) ?? null);
  }

  async function handlePay(item: DetailItem) {
    const rows = itemPortions(item.id);
    if (rows.length === 0) {
      setError("Agregue al menos una porción de pago.");
      return;
    }
    const parts: Array<{ method_code: string; amount: number }> = [];
    for (const row of rows) {
      const amount = toNumber(row.amount);
      if (!row.method_code.trim() || amount === null || amount <= 0) {
        setError("Complete el método y un monto mayor a 0 en cada porción.");
        return;
      }
      parts.push({ method_code: row.method_code.trim(), amount });
    }
    // El backend permite pago parcial: solo se rechaza pasarse del saldo
    // pendiente (misma regla OVERPAID que `assertNoOverpay`).
    const total = parts.reduce((acc, part) => acc + part.amount, 0);
    if (total - item.remaining > 0.009) {
      setError(
        `Las porciones (${formatMoney(total)}) superan el saldo pendiente (${formatMoney(item.remaining)}).`,
      );
      return;
    }
    setBusy(true);
    // CL-2: la marca del INTENTO. Se acuña al empezar y se conserva si el
    // intento falla (el reintento tiene que llevar la misma para que el
    // servidor reconozca la repetición en vez de pagar dos veces). `crypto`
    // existe en el navegador (contexto seguro) y en el runtime de Node: no
    // hace falta ninguna dependencia nueva.
    const paymentKey = paymentKeyRef.current.get(item.id) ?? crypto.randomUUID();
    paymentKeyRef.current.set(item.id, paymentKey);
    const result = (await payPayrollItemAction(item.id, {
      idempotency_key: paymentKey,
      portions: parts,
    })) as ActionResult<{ paid: number; remaining: number }>;
    setBusy(false);
    if (show(result, "Pago registrado.")) {
      // El intento TERMINÓ bien: el próximo pago de este ítem es OTRO intento y
      // merece otra marca (si no, devolvería este mismo pago).
      paymentKeyRef.current.delete(item.id);
      setPortions((prev) => ({ ...prev, [item.id]: [] }));
      if (selectedId) await loadDetail(selectedId);
    }
  }

  /** PA-2a: recarga el registro visible de pagos extraordinarios. */
  async function loadExtras() {
    const result = (await listPayrollExtrasAction()) as ActionResult<PayrollExtraRow[]>;
    if (show(result)) setExtras(result.data);
  }

  function closeExtraDialog() {
    setExtraDialogOpen(false);
    setExtraError(null);
    setExtraEmployeeId("");
    setExtraKind("");
    setExtraReason("");
    setExtraAmount("");
    setExtraMethodCode("");
    setExtraReference("");
    setExtraDaysFrom("");
    setExtraDaysTo("");
    // CL-5: cerrar el diálogo abandona el intento de pago extraordinario; el
    // próximo pago es otro intento y acuña su propia marca. Si el intento
    // anterior falló y se reabre para pagar OTRA cosa, ese pago no puede quedar
    // pegado a la marca abandonada.
    extraKeyRef.current = null;
  }

  /**
   * PA-2a: registra un pago extraordinario. El monto se escribe libre (la guía
   * se muestra, no se aplica); el motivo es obligatorio. La validación de acá
   * es la misma del esquema del servidor, para no ir y volver con un error.
   */
  async function handlePayExtra(event: FormEvent) {
    event.preventDefault();
    setExtraError(null);
    const amount = toNumber(extraAmount);
    if (!extraEmployeeId) {
      setExtraError("Elija el empleado.");
      return;
    }
    if (!extraKind) {
      setExtraError("Elija el tipo de caso extraordinario.");
      return;
    }
    if (!extraReason.trim()) {
      setExtraError("El motivo del pago es obligatorio.");
      return;
    }
    if (amount === null || amount <= 0) {
      setExtraError("El monto debe ser mayor a 0.");
      return;
    }
    if (!extraMethodCode) {
      setExtraError("Elija el método de pago.");
      return;
    }
    if (Boolean(extraDaysFrom) !== Boolean(extraDaysTo)) {
      setExtraError("Indique las dos fechas de los días liquidados, o ninguna.");
      return;
    }
    if (extraDaysFrom && extraDaysTo && extraDaysTo < extraDaysFrom) {
      setExtraError("La fecha final no puede ser anterior a la inicial.");
      return;
    }

    setExtraBusy(true);
    // CL-5: la marca del INTENTO. Se acuña al empezar y se conserva si el
    // intento falla (el reintento tiene que llevar la misma para que el servidor
    // reconozca la repetición en vez de escribir un segundo pago extraordinario).
    // `crypto` existe en el navegador (contexto seguro) y en el runtime de Node:
    // no hace falta ninguna dependencia nueva.
    const extraKey = extraKeyRef.current ?? crypto.randomUUID();
    extraKeyRef.current = extraKey;
    const result = (await payPayrollExtraAction({
      idempotency_key: extraKey,
      employee_id: extraEmployeeId,
      amount,
      method_code: extraMethodCode,
      reference: extraReference.trim() || null,
      reason: extraReason.trim(),
      kind: extraKind,
      days_from: extraDaysFrom || null,
      days_to: extraDaysTo || null,
    })) as ActionResult<PayrollExtraRow>;
    setExtraBusy(false);
    if (show(result, "Pago extraordinario registrado.")) {
      // El intento TERMINÓ bien: el próximo pago es OTRO intento y merece otra
      // marca (si no, devolvería este mismo pago). `closeExtraDialog` la suelta.
      closeExtraDialog();
      await loadExtras();
    }
  }

  async function handleClose() {
    if (!selectedId) return;
    setBusy(true);
    const result = (await closePayrollPeriodAction(selectedId)) as ActionResult<PayrollPeriodRow>;
    setBusy(false);
    if (show(result, "Periodo cerrado.")) {
      await refreshPeriods(selectedId);
      await loadDetail(selectedId);
    }
  }

  function closeCorrectionDialog() {
    setCorrectionDialogOpen(false);
    setCorrectionReason("");
    setCorrectionError(null);
  }

  /**
   * PA-2b: corrige el período CERRADO. Recalcula con las reglas vigentes y
   * guarda las dos versiones con el motivo obligatorio. NO mueve dinero: acá no
   * hay pago, descuento ni ajuste; la diferencia se muestra y se salda a mano
   * con un pago extraordinario. La liquidación firmada no se reabre.
   */
  async function handleCorrectPeriod(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    if (!correctionReason.trim()) {
      setCorrectionError("El motivo de la corrección es obligatorio.");
      return;
    }
    setCorrectionBusy(true);
    const result = (await correctPayrollPeriodAction(selectedId, {
      reason: correctionReason,
    })) as ActionResult<PayrollPeriodCorrectionResult>;
    setCorrectionBusy(false);
    if (
      show(result, "Período corregido. La corrección queda registrada y no mueve dinero.")
    ) {
      closeCorrectionDialog();
      // La corrección no cambia la liquidación firmada: se recarga igual para
      // que la pantalla lea el estado del servidor y no una copia.
      await loadDetail(selectedId);
    }
  }

  /**
   * Borra el borrador seleccionado tras la confirmación clásica. El backend
   * rechaza períodos cerrados y arrastra ítems/pagos; los vales descontados
   * vuelven a su estado previo. Al terminar se refresca la lista y se cierra
   * el detalle (el período ya no existe).
   */
  async function handleDelete() {
    if (!selectedId) return;
    setBusy(true);
    const result = (await deletePayrollPeriodAction(selectedId)) as ActionResult<{ id: string }>;
    setBusy(false);
    if (show(result, "Borrador borrado.")) {
      setConfirmDeleteOpen(false);
      const removed = periods.find((row) => row.id === selectedId) ?? null;
      closeDetail();
      setSelectedId(null);
      // El período borrado sale también del resumen: si quedara, la vista
      // seguiría mostrando plata de un período que ya no existe (y cuyos pagos
      // se devolvieron).
      if (removed) {
        setSummaries((prev) => {
          const rest = { ...prev };
          delete rest[removed.id];
          return rest;
        });
      }
      await refreshPeriods();
    }
  }


  const selected = periods.find((row) => row.id === selectedId) ?? null;
  // Ítem cuyo desglose se muestra en el modal de detalle. Se resuelve contra el
  // detalle vigente para que un pago o recálculo refresque sus montos.
  const detailTarget = detailTargetId
    ? detail?.items.find((item) => item.id === detailTargetId) ?? null
    : null;

  // F10: el ciclo pendiente elegido y SU RANGO. El rango no se escribe ni se
  // elige: sale del ÚNICO validador de la forma del período
  // (`resolveOpenPayrollRange`), el mismo que el servicio aplica antes del
  // INSERT —un ciclo COMPLETO de la cadencia, o el PRIMER ciclo recortado al
  // arranque de la nómina—. `openResolution` es `null` sólo mientras el
  // diálogo no eligió nada; `startDate`/`endDate` alimentan la guarda en vivo,
  // el texto del diálogo y el envío.
  //
  // La PRIMERA liquidación (sin períodos) es la única que declara el arranque:
  // entonces lo que se escribió manda, y el resto de la vida del módulo manda
  // el derivado. Con historial, `declaredStartDate` viaja en `null` a propósito.
  const primeraLiquidacion = periods.length === 0;
  const declaredStartDate = primeraLiquidacion ? openDeclaredStart : "";
  const openCycle = openTarget
    ? payrollCycleRange({ frequency: openTarget.frequency, cycleEndDate: openTarget.end_date })
    : null;
  // El campo de la fecha está ACOTADO al ciclo elegido (y a hoy): el recorte
  // sólo existe dentro del ciclo, así que la pantalla no ofrece otros días.
  const declaredMin = openCycle?.start_date ?? "";
  const declaredMax = openCycle
    ? [openCycle.end_date, bogotaDay()].sort()[0]
    : "";
  const openResolution =
    openTarget === null
      ? null
      : resolveOpenPayrollRange({
          frequency: openTarget.frequency,
          cycleEndDate: openTarget.end_date,
          payrollStartDate: payrollStartDate,
          declaredStartDate,
          periods,
          referenceDate: bogotaDay(),
        });
  const startDate = openResolution?.ok ? openResolution.start_date : "";
  const endDate = openResolution?.ok ? openResolution.end_date : "";
  // F10: el rango derivado, en palabras, y la nota del PRIMER ciclo recortado.
  // El día del rango se muestra porque un ciclo recortado paga menos que uno
  // completo (la prorrata de F5), y eso no puede sorprender al admin.
  const openCycleDays = periodRangeDays(startDate, endDate);
  const openCycleDaysTotal =
    openTarget === null ? null : cycleDaysForFrequency(openTarget.frequency);
  // La PRORRATA del rango recortado, dicha con números: `x de y días del
  // ciclo`. Es la misma cuenta que hace F5 al pagar, mostrada antes de pagar.
  const openProrationText =
    openCycleDays === null || openCycleDaysTotal === null
      ? null
      : `${openCycleDays} de ${openCycleDaysTotal} días del ciclo`;
  const openRangeText =
    openResolution === null || !openResolution.ok
      ? null
      : `Del ${formatFullDate(startDate)} al ${formatFullDate(endDate)}${
          openCycleDays === null ? "" : ` (${openCycleDays} ${openCycleDays === 1 ? "día" : "días"})`
        }. El rango sale del ciclo y del arranque de la nómina: no hay campos de fecha.`;
  const openTrimmedNote =
    openResolution === null || !openResolution.ok || !openResolution.trimmed
      ? null
      : `Primer ciclo recortado: ${
          primeraLiquidacion
            ? "declaraste que la nómina de la instalación opera desde ese día"
            : "la nómina de la instalación arranca ese día, el del primer período"
        }, así que este ciclo se liquida sólo desde ahí. Su fijo se prorratea por los días del rango (${openProrationText ?? "la parte del ciclo"}).`;
  const draftPeriods = periods.filter((row) => row.status === "borrador");
  // Guarda defensiva conservada: el rango resuelto siempre termina después de
  // empezar, así que no puede dispararse; se deja a la vista por si el día de
  // mañana el rango volviera a tener otra fuente.
  const rangeInvalid = Boolean(startDate && endDate && endDate < startDate);
  const overlap =
    startDate && endDate && !rangeInvalid
      ? findOverlappingPeriod(periods, startDate, endDate, openTarget?.frequency ?? null)
      : null;

  /**
   * Nombre legible del empleado: nombre + ID interno (el código de empleado
   * `employee_code`; si no está definido, el documento). Nunca el número de
   * documento solo, para distinguir homónimos igual que en vales.
   *
   * PA3: la planta se indexa UNA sola vez. Antes cada nombre era un `find`
   * sobre la lista, y la lista venía recortada en 50, así que más allá de ese
   * tope el nombre caía al fragmento del id.
   */
  const employeeIndex = buildPayrollEmployeeIndex(props.initialEmployees);
  const employeeName = (id: string) => payrollEmployeeName(employeeIndex, id);

  /**
   * Tipo de pago del empleado (fijo/porcentaje/mixto y su porcentaje) para la
   * columna de liquidación. Se resuelve contra la configuración vigente del
   * empleado, igual que el nombre.
   */
  const employeePayLabel = (id: string) => {
    const found = employeeIndex.get(id);
    if (!found) return "Sin definir";
    return formatPayType(found.pay_type, found.commission_percent);
  };

  /**
   * PA3: la lista se filtra por estado y se agrupa por mes, para que un mes con
   * muchos pagos sea navegable. El conteo se lee SIEMPRE contra el total.
   */
  const statusOptions = [...new Set(periods.map((row) => row.status))].sort();
  const visiblePeriods =
    statusFilter === "todos" ? periods : periods.filter((row) => row.status === statusFilter);
  const periodGroups = groupPayrollPeriodsByMonth(visiblePeriods);

  /**
   * F9: los ciclos ya CERRADOS que sigue sin liquidar la sede, por cadencia (el
   * atraso que nadie notaba). Sale de los períodos y la planta que la pantalla
   * YA tiene cargados: no agrega ninguna lectura —un `select` por cadencia serían
   * N consultas para el mismo dato— y usa la MISMA función pura que el servicio,
   * así que la lista y el resumen de la sede no pueden discrepar. Sólo el admin:
   * es información de la nómina de la sede.
   *
   * F10 (2026-10-04): el arranque se deriva de esos mismos períodos, así que el
   * aviso se acota con la regla de siempre (un ciclo que cierra antes del
   * primer período no existe para el sistema) y, sin períodos, ofrece los
   * últimos ciclos cerrados de cada cadencia. Es la MISMA función que el
   * servicio, así que el aviso y el resumen no pueden discrepar.
   */
  const pendingSettlements = props.canAdmin
    ? pendingPayrollSettlements({
        periods,
        employees: props.initialEmployees,
        referenceDate: bogotaDay(),
      })
    : [];

  /**
   * Totales de un mes: SÓLO si TODOS sus períodos tienen resumen. Con uno sin
   * resumen el total de la fila mentiría por omisión, así que se dice. Los
   * montos van en peso entero (`sumMoney` sobre `roundMoney`).
   */
  function groupTotals(group: PayrollMonthGroup<PayrollPeriodRow>) {
    const totals = group.periods.map((row) => summaries[row.id]);
    if (totals.some((row) => row === undefined)) return null;
    return {
      net: sumMoney(totals.map((row) => row?.netTotal ?? 0)),
      paid: sumMoney(totals.map((row) => row?.paidTotal ?? 0)),
      remaining: sumMoney(totals.map((row) => row?.remainingTotal ?? 0)),
    };
  }

  /** Resumen de un período en la lista: se lee sin abrirlo. */
  function periodSummaryText(row: PayrollPeriodRow): string {
    const totals = summaries[row.id];
    if (!totals) return "Abra el período para ver sus totales.";
    const employees = totals.employeeCount === 1 ? "1 empleado" : `${totals.employeeCount} empleados`;
    return `${employees} · Neto ${formatMoney(totals.netTotal)} · Pagado ${formatMoney(totals.paidTotal)} · Saldo ${formatMoney(totals.remainingTotal)}`;
  }

  // PA3 (consulta puntual): los meses que se pueden consultar, derivados de los
  // períodos que la pantalla ya tiene (la fecha de INICIO define el mes, la
  // misma regla que la lectura del servidor). El más reciente primero.
  const monthOptions = groupPayrollPeriodsByMonth(periods)
    .map((group) => group.month)
    .filter((month) => month !== "");

  /**
   * PA3 (consulta puntual): el admin pide los pagos de UN mes de UN empleado.
   * Es una lectura del servidor (agrega plata de la sede) envuelta en la
   * transición de vista, para que la UI no se congele mientras responde. El
   * resultado reemplaza al anterior; `monthQuery` nace en `null` (nada leído) y
   * aquí pasa a tener lo consultado.
   */
  function handleMonthQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!queryMonth || !queryEmployeeId) return;
    startViewTransition(async () => {
      const result = (await listPayrollMonthRowsAction({
        month: queryMonth,
        employeeId: queryEmployeeId,
      })) as ActionResult<PayrollMonthEmployeeRow[]>;
      if (show(result)) {
        setMonthQuery({ month: queryMonth, employeeId: queryEmployeeId, rows: result.data });
      }
    });
  }

  /** Sueldo mensual del empleado: la base de la prorata, a la vista. */
  function monthSalaryLabel(id: string): string {
    const found = employeeIndex.get(id);
    if (!found) return "Empleado fuera de la planta.";
    if (found.salary_fixed === null || Number(found.salary_fixed) <= 0) {
      return "Sin sueldo fijo configurado.";
    }
    return `Sueldo mensual ${formatMoney(found.salary_fixed)}.`;
  }

  // Ítems del detalle con saldo pendiente de pago: bloquean el cierre del borrador.
  const pendingItems = (detail?.items ?? []).filter((item) => item.remaining > 0);

  // PA-2a: la GUÍA del pago extraordinario (el sueldo prorrateado por los días
  // que se liquidan). Se MUESTRA, nunca se aplica: el dueño fue explícito en
  // que el sueldo mensual es la base guía y no un tope (un despido liquida
  // prestaciones; una emergencia puede costar más). Un rango invertido lanza
  // (misma regla que la prorata); acá se convierte en aviso, no en pantalla
  // rota.
  const extraEmployee = props.initialEmployees.find((row) => row.id === extraEmployeeId) ?? null;
  let extraGuide: ReturnType<typeof payrollExtraGuide> | null = null;
  let extraGuideInvalid = false;
  try {
    extraGuide = payrollExtraGuide({
      salaryFixed: extraEmployee?.salary_fixed ?? null,
      daysFrom: extraDaysFrom || null,
      daysTo: extraDaysTo || null,
      amount: toNumber(extraAmount),
    });
  } catch {
    extraGuideInvalid = true;
  }

  /** Nombre del método por su código; el código si ya no está en el catálogo. */
  const methodLabel = (code: string) =>
    props.methods.find((row) => row.code === code)?.name ?? code;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        // Fallo de acción o validación incompleta = ESTADO: sigue siendo el
        // caso mientras no se corrija, así que va inline y persistente arriba
        // de los períodos. `destructive` deriva role="alert" (asertivo), el
        // mismo rol que la rama de error escribía a mano.
        <Alert variant="destructive">{error}</Alert>
      )}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Períodos</h2>
        {/*
          F10 (2026-10-04): la fecha desde la que la nómina OPERA ya NO se
          configura en ninguna pantalla — la declara la primera liquidación, en
          el diálogo de más abajo—. Esta pantalla conserva el ARRANQUE porque el
          aviso de pendientes y el diálogo lo necesitan para acotar los ciclos,
          y lo deriva de los períodos que ya tiene.
        */}
        {/*
          F9: el atraso, a la vista donde el admin aterriza. Un ciclo que ya
          cerró y no tiene liquidación es plata que la sede debe: mientras el
          aviso no existía, una sede podía liquidar semanal durante meses y
          nunca pagarle su ciclo a quien cobra quincenal, sin que nadie lo
          notara. ESTADO, no evento: sigue ahí hasta que el ciclo se liquide,
          así que va inline y persistente. `warning` (no `destructive`) porque
          no es un fallo de la pantalla: es un pendiente que exige acción, y la
          variante deriva su propio rol, sin escribirlo a mano.

          F10 (2026-10-04): cada entrada es la ÚNICA puerta al diálogo de apertura
          (su ciclo queda elegido y el rango se deriva). El aviso NO manda a
          otra pantalla: la fecha de arranque la declara la primera liquidación,
          dentro de ese diálogo.
        */}
        {props.canAdmin && pendingSettlements.length > 0 && (
          <Alert variant="warning" className="mt-3">
            <p>
              Hay ciclos ya cerrados sin liquidar. Mientras sigan pendientes, los empleados que
              cobran por esas cadencias no reciben su pago.
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {pendingSettlements.map((entry) => (
                <li key={`${entry.frequency}-${entry.end_date}`}>
                  <button
                    type="button"
                    onClick={() => openPendingSettlement(entry)}
                    className="text-left font-medium text-text-primary underline"
                  >
                    {pendingSettlementText(entry)}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1">
              Cada uno abre el diálogo con su ciclo ya elegido y listo para liquidarlo: el rango
              sale del ciclo y del arranque de la nómina.
            </p>
          </Alert>
        )}
        {props.canAdmin && (
          <p className="mt-2 text-sm text-text-secondary">
            {/* PA3: el conteo se lee SIEMPRE contra el total (la lista se
                recortaba en 20 sin decirlo) y el resumen de cada período evita
                tener que abrirlo para saber cuánto hay y a cuántos empleados. */}
            {payrollPeriodCountLabel({ total: periods.length, shown: visiblePeriods.length })}
          </p>
        )}
        {props.canAdmin && (
          <label className={labelClass} htmlFor="payroll-status-filter">
            Estado
            <select
              id="payroll-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="todos">Todos los estados</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.canAdmin && props.initialEmployees.length === 0 && (
          // VACÍO: no es un aviso, es el estado base de la sede sin planta.
          <p className="mt-2 text-sm text-text-secondary">
            Aún no hay empleados en la instalación: créelos en /admin antes de liquidar.
          </p>
        )}
        {props.canAdmin && (
          <button
            type="button"
            onClick={openPeriodDialog}
            className={`${buttonClass} mt-3`}
          >
            Abrir período
          </button>
        )}
        {/* PA3: agrupados por mes, el más reciente primero, para que un mes con
            muchos pagos se pueda recorrer sin perder de vista los totales. */}
        {periodGroups.map((group) => {
          const totals = groupTotals(group);
          return (
            <div key={group.month || "sin-mes"} className="mt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-text-primary">
                  {group.month ? payrollMonthLabel(group.month) : "Sin mes determinable"}
                </h3>
                {props.canAdmin && (
                  <p className="text-xs text-text-tertiary">
                    {group.periods.length === 1 ? "1 período" : `${group.periods.length} períodos`}
                    {totals
                      ? ` · Neto ${formatMoney(totals.net)} · Pagado ${formatMoney(totals.paid)} · Saldo ${formatMoney(totals.remaining)}`
                      : " · Totales parciales: abra los períodos sin resumen."}
                  </p>
                )}
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {group.periods.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => loadDetail(row.id)}
                      disabled={isViewPending}
                      aria-current={row.id === selectedId ? "true" : undefined}
                      className={ghostClass}
                    >
                      {row.start_date} → {row.end_date}
                    </button>
                    <Badge variant="secondary">{row.status}</Badge>
                    {props.canAdmin && (
                      <span className="text-xs text-text-secondary">{periodSummaryText(row)}</span>
                    )}
                    {row.status === "cerrado" && row.closed_at && (
                      <span className="text-xs text-text-tertiary">Cerrado: {new Date(row.closed_at).toLocaleString("es-CO")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {visiblePeriods.length === 0 && (
          <p className="mt-3 text-sm text-text-tertiary">
            {periods.length === 0
              ? "Sin periodos todavía."
              : `Ningún período con estado ${statusFilter}.`}
          </p>
        )}
      </section>

      {/*
        PA-2a: nómina individual por caso extraordinario. Es el REGISTRO
        VISIBLE (no sólo la auditoría) de cuánto y cómo se pagó, y existe
        porque un período cerrado no admite el pago de sus ítems. Sólo admin.
      */}
      {props.canAdmin && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">Pagos extraordinarios</h2>
          <p className="mt-2 text-sm text-text-secondary">
            Nómina individual por despido, renuncia o emergencia del empleado. No es un período: sirve
            para pagar días que un período cerrado ya cubrió, y queda registrado cuánto y cómo se pagó.
          </p>
          <button
            type="button"
            onClick={() => {
              setExtraError(null);
              setExtraDialogOpen(true);
            }}
            className={`${buttonClass} mt-3`}
          >
            Registrar pago extraordinario
          </button>
          {extras.length === 0 ? (
            <p className="mt-3 text-sm text-text-tertiary">
              Sin pagos extraordinarios registrados.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className={cn("w-full text-left text-sm", "min-w-[880px]")}>
                <thead>
                  <tr className={tableHeaderClass}>
                    <th className={tableCellClass} scope="col">
                      Fecha
                    </th>
                    <th className={tableCellClass} scope="col">
                      Empleado
                    </th>
                    <th className={tableCellClass} scope="col">
                      Tipo
                    </th>
                    <th className={tableCellClass} scope="col">
                      Monto
                    </th>
                    <th className={tableCellClass} scope="col">
                      Método
                    </th>
                    <th className={tableCellClass} scope="col">
                      Motivo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {extras.map((row) => (
                    <tr key={row.id} className={tableRowClass}>
                      <td className={tableCellClass}>
                        {row.paid_at ? formatFullDate(row.paid_at.slice(0, 10)) : "—"}
                      </td>
                      <td className={tableCellClass}>{employeeName(row.employee_id)}</td>
                      <td className={tableCellClass}>{PAYROLL_EXTRA_KIND_LABELS[row.kind]}</td>
                      <td className={tableCellClass}>{formatMoney(row.amount)}</td>
                      <td className={tableCellClass}>{methodLabel(row.method_code)}</td>
                      <td className={tableCellClass}>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/*
        PA3: pagos del mes por empleado. Es la respuesta práctica a "qué lleva
        cada persona este mes": lo liquidado, lo pagado y el saldo, contra qué
        períodos, con el fijo prorrateado por los días nominados a la vista.
        Solo admin: agrega plata de TODA la planta (el mismo dato que el detalle
        sin alcance por fila). Se LEE, no se aplica: la porción prorrateada no
        topa ni bloquea nada.
      */}
      {props.canAdmin && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">Pagos del mes por empleado</h2>
          <p className="mt-2 text-sm text-text-secondary">
            Lo que cada empleado lleva liquidado y pagado en el mes, y contra qué períodos. El fijo
            se muestra prorrateado por los días nominados: el sueldo mensual es la base, no lo que se
            paga en cada período. Un período que cruza el fin de mes se prorratea en los dos meses y
            acá aparece en el mes donde empieza. Los pagos extraordinarios individuales
            (despido, renuncia, emergencia) NO entran en estos totales: no pertenecen a ningún
            período y están listados en su propia sección.
          </p>
          {/*
            PA3 (consulta puntual): el mes y el empleado los ELIGE el admin; la
            lectura no ocurre antes. La transición de vista (`isViewPending`) es
            la misma del resto de la pantalla, así que la UI no se congela
            mientras el servidor responde.
          */}
          <form onSubmit={handleMonthQuery} className="mt-3 flex flex-wrap items-end gap-3">
            <label className={labelClass} htmlFor="payroll-month-filter">
              Mes
              <select
                id="payroll-month-filter"
                value={queryMonth}
                onChange={(event) => setQueryMonth(event.target.value)}
                className={inputClass}
                required
              >
                <option value="">Mes…</option>
                {monthOptions.map((month) => (
                  <option key={month} value={month}>
                    {payrollMonthLabel(month)}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass} htmlFor="payroll-month-employee">
              Empleado
              <select
                id="payroll-month-employee"
                value={queryEmployeeId}
                onChange={(event) => setQueryEmployeeId(event.target.value)}
                className={inputClass}
                required
              >
                <option value="">Empleado…</option>
                {props.initialEmployees.map((row) => (
                  <option key={row.id} value={row.id}>
                    {employeeName(row.id)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!queryMonth || !queryEmployeeId || isViewPending}
              className={buttonClass}
            >
              {isViewPending ? "Consultando…" : "Consultar"}
            </button>
          </form>
          {monthQuery === null ? (
            // Antes de la consulta no hay tabla ni número: la pantalla sólo pide
            // el mes y el empleado.
            <p className="mt-3 text-sm text-text-tertiary">
              Elija mes y empleado para consultar sus pagos.
            </p>
          ) : isViewPending ? (
            <p className="mt-3 text-sm text-text-tertiary">Consultando…</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className={cn("w-full text-left text-sm", "min-w-[960px]")}>
                <thead>
                  <tr className={tableHeaderClass}>
                    <th className={tableCellClass} scope="col">
                      Empleado
                    </th>
                    <th className={tableCellClass} scope="col">
                      Fijo prorrateado (días)
                    </th>
                    <th className={tableCellClass} scope="col">
                      Neto
                    </th>
                    <th className={tableCellClass} scope="col">
                      Pagado
                    </th>
                    <th className={tableCellClass} scope="col">
                      Saldo
                    </th>
                    <th className={tableCellClass} scope="col">
                      Períodos
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {monthQuery.rows.map((row) => (
                    <tr key={`${row.month}-${row.employeeId}`} className={tableRowClass}>
                      <td className={tableCellClass}>
                        <span className="block">{employeeName(row.employeeId)}</span>
                        <span className="block text-xs text-text-tertiary">
                          {monthSalaryLabel(row.employeeId)}
                        </span>
                      </td>
                      <td className={tableCellClass}>
                        <span className="block">{formatMoney(row.fixedTotal)}</span>
                        <span className="block text-xs text-text-tertiary">
                          {row.days === 1 ? "1 día nominado" : `${row.days} días nominados`}
                        </span>
                      </td>
                      <td className={tableCellClass}>{formatMoney(row.netTotal)}</td>
                      <td className={tableCellClass}>{formatMoney(row.paidTotal)}</td>
                      <td className={cn(tableCellClass, "font-semibold")}>
                        {formatMoney(row.remainingTotal)}
                      </td>
                      <td className={tableCellClass}>
                        <ul className="flex flex-col gap-0.5">
                          {row.periods.map((entry) => (
                            <li key={entry.periodId}>
                              {formatPeriodLabel(entry)} ({entry.status}): neto{" "}
                              {formatMoney(entry.net)}, pagado {formatMoney(entry.paid)}, saldo{" "}
                              {formatMoney(entry.remaining)}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                  {monthQuery.rows.length === 0 && (
                    <tr className={tableRowClass}>
                      <td className={tableCellClass} colSpan={6}>
                        {`Sin pagos de nómina de ${employeeName(monthQuery.employeeId)} en ${payrollMonthLabel(monthQuery.month)}.`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* PA-2a: el formulario del pago extraordinario. */}
      {props.canAdmin && (
        <Dialog
          open={extraDialogOpen}
          onOpenChange={(open) => {
            if (!open) closeExtraDialog();
            else setExtraDialogOpen(true);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Registrar pago extraordinario</DialogTitle>
              <DialogDescription>
                Nómina individual por despido, renuncia o emergencia. No crea ni reabre períodos:
                puede pagar días que un período cerrado ya cubrió. El motivo es obligatorio.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handlePayExtra} className="mt-4 flex flex-col gap-4">
              <div className="flex flex-wrap gap-3">
                <label className={labelClass} htmlFor="payroll-extra-employee">
                  Empleado
                  <select
                    id="payroll-extra-employee"
                    value={extraEmployeeId}
                    onChange={(event) => {
                      setExtraEmployeeId(event.target.value);
                      setExtraError(null);
                    }}
                    className={inputClass}
                    required
                  >
                    <option value="">Empleado…</option>
                    {props.initialEmployees.map((row) => (
                      <option key={row.id} value={row.id}>
                        {employeeName(row.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass} htmlFor="payroll-extra-kind">
                  Tipo de caso
                  <select
                    id="payroll-extra-kind"
                    value={extraKind}
                    onChange={(event) => {
                      setExtraKind(event.target.value as PayrollExtraKind);
                      setExtraError(null);
                    }}
                    className={inputClass}
                    required
                  >
                    <option value="">Tipo…</option>
                    {payrollExtraKindSchema.options.map((kind) => (
                      <option key={kind} value={kind}>
                        {PAYROLL_EXTRA_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass} htmlFor="payroll-extra-amount">
                  Monto
                  <input
                    id="payroll-extra-amount"
                    inputMode="numeric"
                    value={formatMoneyInput(extraAmount)}
                    onChange={(event) => {
                      setExtraAmount(stripMoneyInput(event.target.value));
                      setExtraError(null);
                    }}
                    placeholder="0"
                    className={tableInputClass}
                    required
                  />
                </label>
              </div>

              <label className={labelClass} htmlFor="payroll-extra-reason">
                Motivo
                <textarea
                  id="payroll-extra-reason"
                  value={extraReason}
                  onChange={(event) => {
                    setExtraReason(event.target.value);
                    setExtraError(null);
                  }}
                  rows={2}
                  maxLength={500}
                  placeholder="Por qué se paga (renuncia del 16 de septiembre, emergencia médica…)"
                  className={inputClass}
                  required
                />
              </label>

              <div className="flex flex-wrap gap-3">
                <label className={labelClass} htmlFor="payroll-extra-method">
                  Método de pago
                  <select
                    id="payroll-extra-method"
                    value={extraMethodCode}
                    onChange={(event) => {
                      setExtraMethodCode(event.target.value);
                      setExtraError(null);
                    }}
                    className={inputClass}
                    required
                  >
                    <option value="">Método…</option>
                    {props.methods.map((row) => (
                      <option key={row.id} value={row.code}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass} htmlFor="payroll-extra-reference">
                  Referencia (opcional)
                  <input
                    id="payroll-extra-reference"
                    type="text"
                    value={extraReference}
                    onChange={(event) => setExtraReference(event.target.value)}
                    maxLength={120}
                    placeholder="N.º de comprobante o transferencia"
                    className={inputClass}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <label className={labelClass} htmlFor="payroll-extra-days-from">
                  Días liquidados desde (opcional)
                  <input
                    id="payroll-extra-days-from"
                    type="date"
                    value={extraDaysFrom}
                    onChange={(event) => {
                      setExtraDaysFrom(event.target.value);
                      setExtraError(null);
                    }}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass} htmlFor="payroll-extra-days-to">
                  Hasta
                  <input
                    id="payroll-extra-days-to"
                    type="date"
                    value={extraDaysTo}
                    onChange={(event) => {
                      setExtraDaysTo(event.target.value);
                      setExtraError(null);
                    }}
                    className={inputClass}
                  />
                </label>
              </div>

              <div className="rounded-md border border-border-color bg-surface-hover p-3 text-sm text-text-secondary dark:border-border-color-2">
                <p className="font-medium text-text-primary">Guía (no es un tope)</p>
                {extraGuideInvalid ? (
                  <p className="mt-1">La fecha final no puede ser anterior a la inicial.</p>
                ) : extraGuide && extraGuide.monthlySalary === null ? (
                  <p className="mt-1">
                    El empleado no tiene sueldo fijo configurado: no hay guía que mostrar. El monto lo
                    define usted.
                  </p>
                ) : extraGuide ? (
                  <>
                    <p className="mt-1">
                      {extraGuide.proratedAmount !== null
                        ? `Porción de ${extraGuide.days} día(s) liquidado(s): ${formatMoney(extraGuide.proratedAmount)}.`
                        : `Sueldo mensual de referencia: ${formatMoney(extraGuide.monthlySalary ?? 0)}.`}
                    </p>
                    {extraGuide.exceedsGuide && (
                      <p className="mt-1">
                        El monto supera la guía. Está permitido —un despido liquida prestaciones y una
                        emergencia puede costar más que los días trabajados—: se registrará tal como lo
                        escribió.
                      </p>
                    )}
                  </>
                ) : null}
              </div>

              {extraError ? <Alert variant="destructive">{extraError}</Alert> : null}

              <DialogFooter>
                <button type="button" className={ghostClass} onClick={closeExtraDialog}>
                  Cancelar
                </button>
                <button type="submit" disabled={extraBusy} className={buttonClass}>
                  {extraBusy ? "Registrando…" : "Registrar pago"}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {props.canAdmin && (
        <Dialog
          open={openDialogOpen}
          onOpenChange={(open) => {
            if (!open) closeOpenDialog();
            else setOpenDialogOpen(true);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Abrir período</DialogTitle>
              <DialogDescription>
                Elija una liquidación pendiente. No hay fechas que escribir ni cadencia que
                elegir: el rango sale del ciclo cerrado y del arranque de la nómina, y el período
                se abre en borrador.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleOpen} className="mt-4 flex flex-col gap-4">
              {pendingSettlements.length === 0 ? (
                // VACÍO dentro del diálogo: describe lo esperado, no bloquea nada y
                // nunca anunció nada. Sin ciclos cerrados sin liquidar no hay rango
                // que elegir —ni período que abrir—, así que el diálogo no ofrece
                // ninguna opción libre. Es el ÚNICO vacío: el arranque ya no se
                // configura en ninguna parte, así que no hay otra causa que
                // nombrar (y esa otra causa mandaba a una pantalla que el admin
                // no puede abrir).
                <p className="text-sm text-text-secondary">
                  No hay ciclos cerrados sin liquidar: no hay período que abrir. Cuando un ciclo
                  cierre sin su liquidación aparecerá en el aviso de la pantalla, y desde ahí se
                  abre.
                </p>
              ) : (
                <fieldset className="flex flex-col gap-2">
                  <legend className={labelClass}>
                    Ciclo a liquidar
                    <span className="mt-1 block text-xs font-normal text-text-tertiary">
                      Son los ciclos ya cerrados que todavía no tienen liquidación, el más atrasado
                      primero. Al elegir uno quedan derivados su cadencia y su rango.
                    </span>
                  </legend>
                  {pendingSettlements.map((entry) => (
                    <label
                      key={`${entry.frequency}-${entry.end_date}`}
                      className="flex items-start gap-2 rounded-md border border-border-color p-2 text-sm text-text-secondary dark:border-border-color-2"
                    >
                      <input
                        type="radio"
                        name="payroll-open-target"
                        value={`${entry.frequency}-${entry.end_date}`}
                        checked={
                          openTarget?.frequency === entry.frequency &&
                          openTarget?.end_date === entry.end_date
                        }
                        onChange={() => {
                          setOpenError(null);
                          setOpenTarget(entry);
                          // La fecha declarada pertenece al CICLO: al cambiar de
                          // ciclo, la que estaba escrita ya no aplica (el campo
                          // está acotado al nuevo) y se pide de nuevo.
                          setOpenDeclaredStart("");
                        }}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium text-text-primary">
                          {`Ciclo ${entry.frequency} ${entry.label}`}
                        </span>
                        <span className="mt-1 block text-xs text-text-tertiary">
                          {entry.employeeCount === 1
                            ? "1 empleado con esa cadencia"
                            : `${entry.employeeCount} empleados con esa cadencia`}
                          {entry.employeeNames.length > 0
                            ? `: ${entry.employeeNames.join(", ")}`
                            : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              {/* F10 (2026-10-04): el arranque de la nómina lo declara QUIEN abre
                  la PRIMERA liquidación —este mismo diálogo—, no una pantalla
                  que el admin no puede abrir. Con períodos registrados el campo
                  no aparece: el arranque es un hecho derivado y nadie vuelve a
                  preguntar nada. */}
              {primeraLiquidacion && openTarget !== null && (
                <label className={labelClass} htmlFor="payroll-open-start-date">
                  Desde qué día opera la nómina
                  <input
                    id="payroll-open-start-date"
                    type="date"
                    value={openDeclaredStart}
                    min={declaredMin}
                    max={declaredMax}
                    onChange={(event) => {
                      setOpenError(null);
                      setOpenDeclaredStart(event.target.value);
                    }}
                    className={inputClass}
                  />
                  <span className="text-xs font-normal text-text-tertiary">
                    {declaredMin !== "" && declaredMax !== "" && (
                      <>Elige un día entre el {formatFullDate(declaredMin)} y el {formatFullDate(declaredMax)}: </>
                    )}
                    el primer ciclo se liquida desde ese día y su fijo paga sólo los días del rango.
                    Con el primer período creado, el arranque queda fijado y no se vuelve a preguntar.
                  </span>
                </label>
              )}

              {openRangeText !== null && (
                <p className="text-xs text-text-tertiary">{openRangeText}</p>
              )}
              {openTrimmedNote !== null && (
                <p className="text-xs text-text-tertiary">{openTrimmedNote}</p>
              )}

              <div className="rounded-md border border-border-color bg-surface-hover p-3 text-sm text-text-secondary dark:border-border-color-2">
                <p className="font-medium text-text-primary">Períodos existentes</p>
                {periods.length === 0 ? (
                  // VACÍO dentro del diálogo: describe lo esperado (el primero
                  // de la lista), no bloquea nada y nunca anunció nada.
                  <>
                    <p className="mt-1">Sin períodos todavía: este será el primero.</p>
                    {/* F5 corregido (F8) + F10: cada período NUEVO sale de un
                        ciclo CERRADO —el rango no se escribe—, así que paga la
                        fracción entera de la cadencia, igual que las
                        siguientes. La EXCEPCIÓN es el primer ciclo —de esta
                        liquidación o de cada cadencia— cuando el arranque de la
                        nómina cae dentro de él: se recorta a ese día y se
                        prorratea por los días del rango (la regla del ciclo
                        parcial de F5).
                        Si hay que completar algo (por ejemplo, días que el
                        ciclo no alcanza a cubrir), se carga como bono u otro
                        descuento por empleado en el borrador, y ESE ajuste
                        exige su motivo. Nota informativa en texto plano, como
                        los otros vacíos del diálogo. */}
                    <p className="mt-1">
                      La primera liquidación recorta el ciclo al día desde el que declaraste que
                      opera la nómina y paga sólo los días del rango; los períodos siguientes son
                      ciclos completos y pagan la fracción entera de la cadencia. Si hay que
                      completar algo, se carga como bono u otro descuento por empleado en el
                      borrador, con su motivo.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-1">
                      {periods.length === 1
                        ? "1 período registrado."
                        : `${periods.length} períodos registrados.`}
                    </p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {periods.slice(0, PERIOD_VISIBLE_LIMIT).map((row) => (
                        <li key={row.id} className="flex items-center justify-between gap-3">
                          <span>{formatPeriodLabel(row)}</span>
                          <span className="text-xs text-text-tertiary">{row.status}</span>
                        </li>
                      ))}
                    </ul>
                    {periods.length > PERIOD_VISIBLE_LIMIT && (
                      <p className="mt-1">
                        {`y ${periods.length - PERIOD_VISIBLE_LIMIT} más (vea la lista de períodos de la pantalla).`}
                      </p>
                    )}
                  </>
                )}
                {draftPeriods.length > 0 && (
                  <p className="mt-2 text-text-tertiary">
                    {draftPeriods.length === 1
                      ? "Hay un período en borrador"
                      : `Hay ${draftPeriods.length} períodos en borrador`}
                    : no se pueden solapar rangos del mismo ciclo.
                  </p>
                )}
              </div>

              {rangeInvalid ? (
                // ESTADO calculado en vivo. Con el ciclo como única fuente del
                // rango esta rama no puede dispararse (el ciclo siempre termina
                // después de empezar); se conserva como guarda defensiva y como
                // el canal ya adoptado para el rango inválido, no como UI viva.
                //
                // `role="status"` explícito (polite): este aviso se DERIVA del
                // formulario, no es el desenlace de una acción enviada.
                // `destructive` derivaría `alert` (asertivo), y una región
                // asertiva que interrumpe a quien está eligiendo es el
                // antipatrón de sobreanuncio. Los fallos confirmados del mismo
                // archivo (arriba, `{error}`) siguen asertivos porque hay que
                // enterarse antes de salir.
                <Alert variant="destructive" role="status">
                  La fecha final no puede ser anterior a la inicial.
                </Alert>
              ) : overlap ? (
                // Mismo caso derivado en vivo y por la misma razón: `polite`.
                <Alert variant="destructive" role="status">
                  El rango se solapa con {formatPeriodLabel(overlap)} ({overlap.status}). Ajuste las fechas.
                </Alert>
              ) : openError ? (
                <Alert variant="destructive">{openError}</Alert>
              ) : null}

              <DialogFooter>
                <button type="button" className={ghostClass} onClick={closeOpenDialog}>
                  Cancelar
                </button>
                <button type="submit" disabled={busy || openTarget === null} className={buttonClass}>
                  {busy ? "Creando…" : "Crear"}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {selected && (
        <Dialog
          open={detailDialogOpen}
          onOpenChange={(open) => {
            if (!open) closeDetail();
            else setDetailDialogOpen(open);
          }}
        >
          {/*
            El ancho que la liquidación necesita, no el de un modal normal. Con
            `max-w-6xl` y su `p-6` el diálogo ofrecía 1098px útiles en cualquier
            monitor, y las 12 columnas piden unos 1450: por eso la tabla leía
            apretada («espichada») sin que nada estuviera mal escrito. Este es
            el cambio que devuelve el espacio; el carril angosto lo resuelve
            `DataTable`, y el dinero alineado y los rótulos en una línea lo que
            se lee de un vistazo.
          */}
          <DialogContent className="sm:max-w-[96vw]" aria-busy={isViewPending}>
            <DialogHeader>
              <DialogTitle>
                Liquidación {selected.start_date} → {selected.end_date} ({selected.status})
              </DialogTitle>
            </DialogHeader>
            <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto pr-1">
              {selected.status === "cerrado" ? (
                <>
                  <p className="mt-2 text-sm text-text-secondary">
                    Periodo cerrado. La liquidación quedó registrada.
                  </p>
                  <FixedBasisNote start={selected.start_date} end={selected.end_date} />
                  {detail && (
                    <PeriodDetailTable
                      items={detail.items}
                      employeeName={employeeName}
                      payLabel={employeePayLabel}
                      onView={openItemDetail}
                      onViewSources={(item) =>
                        void openSettlementSources(selected.id, item.employee_id)
                      }
                    />
                  )}
                  {/*
                    PA-2b: un período cerrado y equivocado no tenía salida —no
                    se borra, no se recalcula y sus días no se vuelven a
                    nominar—. La corrección es un REGISTRO con las dos
                    versiones, con motivo, y no mueve dinero. Sólo admin.
                  */}
                  {props.canAdmin && (
                    <section className="mt-5 rounded-md border border-border-color p-3 dark:border-border-color-2">
                      <h3 className="text-sm font-semibold text-text-primary">
                        Corrección del período
                      </h3>
                      {correction ? (
                        <>
                          <p className="mt-2 text-sm text-text-secondary">
                            {CORRECTION_MOVES_NO_MONEY}
                          </p>
                          <p className="mt-1 text-sm text-text-secondary">
                            {CORRECTION_DIFFERENCE_IS_MANUAL}
                          </p>
                          <p className="mt-1 text-sm text-text-tertiary">
                            {CORRECTION_ORIGINAL_STILL_SHOWN}
                          </p>
                          <p className="mt-2 text-xs text-text-tertiary">
                            {`Corregido el ${new Date(correction.correction.corrected_at).toLocaleString("es-CO")} — motivo: ${correction.correction.reason}`}
                          </p>
                          <CorrectionComparison view={correction.view} employeeName={employeeName} />
                        </>
                      ) : (
                        <>
                          <p className="mt-2 text-sm text-text-secondary">
                            La liquidación de este período ya está firmada. Si quedó mal, se corrige sin
                            reabrirlo: se recalcula con las reglas vigentes y se guarda una corrección con las
                            dos versiones. NO mueve dinero.
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setCorrectionError(null);
                              setCorrectionDialogOpen(true);
                            }}
                            className={`${buttonClass} mt-3`}
                          >
                            Corregir período (recalcula con las reglas vigentes)
                          </button>
                        </>
                      )}
                    </section>
                  )}
                </>
              ) : props.canAdmin ? (
                <>
                  <p className="mt-3 text-sm text-text-secondary">
                    Tabla del borrador: ajuste bonos y otros descuentos por empleado y recalcule si hubo
                    cambios.
                  </p>
                  <FixedBasisNote start={selected.start_date} end={selected.end_date} />
                  <DraftPayrollTable
                    rows={draftRows}
                    employeeName={employeeName}
                    payLabel={employeePayLabel}
                    adjustmentValue={adjustmentValue}
                    adjustmentReasonValue={adjustmentReasonValue}
                    onAdjustmentChange={updateAdjustment}
                    onView={openItemDetail}
                    onViewSources={(item) =>
                      void openSettlementSources(selected.id, item.employee_id)
                    }
                  />
                  {pendingItems.length > 0 && (
                    // ESTADO que bloquea el cierre de la nómina: el botón
                    // "Cerrar nómina" queda deshabilitado hasta pagar todo.
                    // No es un error — es un pendiente — así que la variante
                    // deliberada es `warning`, que es además el par de tokens
                    // que el marcado ya usaba (bg-warning-light + text-warning).
                    <Alert variant="warning" className="mt-4">
                      <p>
                        {`Pendientes de pago (${pendingItems.length}): páguelos todos antes de cerrar la nómina.`}
                      </p>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {pendingItems.slice(0, PENDING_VISIBLE_LIMIT).map((item) => (
                          <li key={item.id}>
                            {employeeName(item.employee_id)} — {formatMoney(item.remaining)}
                          </li>
                        ))}
                      </ul>
                      {pendingItems.length > PENDING_VISIBLE_LIMIT && (
                        <p className="mt-1">
                          {`y ${pendingItems.length - PENDING_VISIBLE_LIMIT} más (vea la columna Saldo de la tabla).`}
                        </p>
                      )}
                    </Alert>
                  )}
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => void handleRecalculate()}
                      disabled={busy}
                      className={buttonClass}
                    >
                      {busy ? "Recalculando…" : "Recalcular borrador"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleClose()}
                      disabled={busy || pendingItems.length > 0}
                      title={
                        pendingItems.length > 0
                          ? "Hay empleados con saldo pendiente de pago."
                          : undefined
                      }
                      className={buttonClass}
                    >
                      {busy ? "Cerrando…" : "Cerrar nómina"}
                    </button>
                  </div>
                </>
              ) : (
                detail && (
                  <PeriodDetailTable
                    items={detail.items}
                    employeeName={employeeName}
                    payLabel={employeePayLabel}
                    onView={openItemDetail}
                    onViewSources={(item) =>
                      void openSettlementSources(selected.id, item.employee_id)
                    }
                  />
                )
              )}
            </div>
            <DialogFooter>
              {selected.status === "borrador" && props.canAdmin && (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteOpen(true)}
                  disabled={busy}
                  className={dangerOutlineClass}
                >
                  Borrar borrador
                </button>
              )}
              <button type="button" className={ghostClass} onClick={closeDetail}>
                Cancelar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Detalle de un ítem en modal propio, apilado sobre el del período. */}
      {detailTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDetailTargetId(null);
          }}
        >
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Desglose de {employeeName(detailTarget.employee_id)}</DialogTitle>
              <DialogDescription>
                Comisiones del período y registro de pagos por porciones.
              </DialogDescription>
            </DialogHeader>
            <ExpandedItemPanel
              item={detailTarget}
              methods={props.methods}
              canPay={props.canPay && detailTarget.remaining > 0}
              busy={busy}
              portions={itemPortions(detailTarget.id)}
              onPortionChange={(key, patch) => changePortion(detailTarget.id, key, patch)}
              onAddPortion={() => addPortion(detailTarget)}
              onRemovePortion={(key) => removePortion(detailTarget.id, key)}
              onTotalize={() => totalizePortions(detailTarget)}
              onPay={() => void handlePay(detailTarget)}
            />
            <DialogFooter className="mt-4">
              <button type="button" className={ghostClass} onClick={() => setDetailTargetId(null)}>
                Cerrar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/*
        F6: modal "Ver facturas y vales" de la liquidación de UN empleado.
        Apilado sobre el detalle del período y con su propio `DialogTitle`.
      */}
      {sourcesTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeSettlementSources();
          }}
        >
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>
                {`Facturas y vales de ${employeeName(sourcesTarget.employeeId)}`}
              </DialogTitle>
              <DialogDescription>
                Las facturas y los vales que componen esta liquidación, con el detalle de cada uno.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto pr-1">
              <SettlementSourcesPanel
                sources={sources}
                item={itemByEmployee.get(sourcesTarget.employeeId) ?? null}
                busy={sourcesBusy}
                invoiceTargetId={invoiceTargetId}
                invoiceDetail={invoiceDetail}
                invoiceBusy={invoiceBusy}
                voucherTargetId={voucherTargetId}
                voucherDetail={voucherDetail}
                voucherBusy={voucherBusy}
                employeeName={employeeName}
                onViewInvoice={(invoiceId) => void openInvoiceDetail(invoiceId)}
                onViewVoucher={(voucher) => void openVoucherDetail(voucher)}
              />
            </div>
            <DialogFooter className="mt-4">
              <button type="button" className={ghostClass} onClick={closeSettlementSources}>
                Cerrar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/*
        PA-2b: corrección de un período cerrado. El motivo es obligatorio y el
        diálogo dice, en el mismo lugar donde se firma, que la corrección no
        mueve dinero y que la diferencia se salda con un pago extraordinario.
      */}
      {props.canAdmin && selected && (
        <Dialog
          open={correctionDialogOpen}
          onOpenChange={(open) => {
            if (!open) closeCorrectionDialog();
            else setCorrectionDialogOpen(true);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Corregir período cerrado</DialogTitle>
              <DialogDescription>{CORRECTION_KEEPS_ORIGINAL}</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCorrectPeriod} className="mt-4 flex flex-col gap-4">
              <p className="text-sm text-text-secondary">{CORRECTION_MOVES_NO_MONEY}</p>
              <p className="text-sm text-text-secondary">{CORRECTION_DIFFERENCE_IS_MANUAL}</p>

              <label className={labelClass} htmlFor="payroll-correction-reason">
                Motivo de la corrección
                <textarea
                  id="payroll-correction-reason"
                  value={correctionReason}
                  onChange={(event) => {
                    setCorrectionReason(event.target.value);
                    setCorrectionError(null);
                  }}
                  rows={2}
                  maxLength={500}
                  placeholder="Por qué se corrige (por ejemplo: el fijo se pagó completo cuando correspondía la parte de los días)"
                  className={inputClass}
                  required
                />
              </label>

              {correctionError ? <Alert variant="destructive">{correctionError}</Alert> : null}

              <DialogFooter>
                <button type="button" className={ghostClass} onClick={closeCorrectionDialog}>
                  Cancelar
                </button>
                <button type="submit" disabled={correctionBusy} className={buttonClass}>
                  {correctionBusy ? "Corrigiendo…" : "Corregir período"}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* Confirmación clásica: ¿Está seguro? … Cancelar/Borrar. */}
      {selected && (
        <Dialog
          open={confirmDeleteOpen}
          onOpenChange={(open) => {
            if (!open && !busy) setConfirmDeleteOpen(false);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Borrar borrador</DialogTitle>
              <DialogDescription>
                ¿Está seguro de borrar el borrador {selected.start_date} → {selected.end_date}? Se
                eliminarán sus ítems y pagos, y los vales que haya descontado volverán a su estado
                anterior. No se puede deshacer.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <button
                type="button"
                className={ghostClass}
                onClick={() => setConfirmDeleteOpen(false)}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={dangerSolidClass}
                onClick={() => void handleDelete()}
                disabled={busy}
              >
                {busy ? "Borrando…" : "Borrar borrador"}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

    </div>
  );
}
