"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  calculatePayrollAction,
  closePayrollPeriodAction,
  deletePayrollPeriodAction,
  getPeriodDetailAction,
  listPeriodsAction,
  openPayrollPeriodAction,
  payPayrollItemAction,
} from "@/src/features/payroll/actions";
import type {
  PayrollPeriodRow,
  PeriodDetail,
} from "@/src/features/payroll/service";
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

const inputClass = cn(
  "rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm",
  "dark:border-border-color-2",
);
const labelClass = cn("flex flex-col gap-1 text-sm text-text-primary");
const buttonClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const ghostClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  "dark:border-border-color-2 dark:hover:bg-surface-hover",
);
const sectionClass = cn(
  "rounded-lg border border-border-color bg-surface p-4 shadow-sm",
  "dark:border-border-color-2",
);
const errorClass = cn("text-sm text-error dark:text-error");
const okClass = cn("text-sm text-success dark:text-success");
/** Acción destructiva (borrar borrador): contorno y texto en rojo, separada de las demás. */
const dangerOutlineClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-error bg-transparent px-4 py-2 text-sm font-medium text-error shadow-sm transition-all duration-200 hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const dangerSolidClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-error-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-error-600/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const tableHeaderClass = cn("bg-surface-hover text-xs font-semibold uppercase text-text-tertiary");
const tableCellClass = cn("px-3 py-2 align-middle");
const tableRowClass = cn("border-t border-border-color dark:border-border-color-2");
const tableInputClass = cn(
  "w-28 rounded-md border border-border-color bg-surface px-2 py-1 text-right text-sm text-text-primary shadow-sm",
  "dark:border-border-color-2",
);

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

function formatMoney(value: number | string | null): string {
  if (value === null || value === undefined) return "-";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "-";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Etiquetas del tipo de pago del empleado (ADM-08: fijo, porcentaje o mixto). */
const PAY_TYPE_LABELS: Record<string, string> = {
  fijo: "Fijo",
  porcentaje: "Porcentaje",
  mixto: "Mixto",
};

/** Porcentaje sin decimales innecesarios (10 → "10", 10.5 → "10.5"). */
function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
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

/** Máximo de nombres listados en el aviso de pendientes antes de resumir. */
const PENDING_VISIBLE_LIMIT = 8;

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
function formatPeriodLabel(row: PayrollPeriodRow): string {
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

/** Día siguiente a una fecha yyyy-mm-dd (aritmética UTC, solo fechas). */
function nextDay(value: string): string {
  const date = parseIsoDate(value);
  if (!date) return "";
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return next.toISOString().slice(0, 10);
}

/** Último fin de periodo registrado (los rangos llegan ordenados desc). */
function latestEndDate(rows: PayrollPeriodRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (latest === null || row.end_date > latest) latest = row.end_date;
  }
  return latest;
}

/** Primer periodo cuyo rango se solapa con [start, end] (fechas ISO comparables como texto). */
function findOverlappingPeriod(
  rows: PayrollPeriodRow[],
  start: string,
  end: string,
): PayrollPeriodRow | null {
  return rows.find((row) => start <= row.end_date && end >= row.start_date) ?? null;
}

interface PayrollClientProps {
  sedeId: string;
  initialEmployees: EmployeeRow[];
  initialPeriods: PayrollPeriodRow[];
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
}

/** Tabla del detalle del periodo (solo presentación). */
function PeriodDetailTable({ items, employeeName, payLabel, onView }: PeriodDetailTableProps) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className={cn("w-full text-left text-sm", "min-w-[960px]")}>
        <thead>
          <tr className={tableHeaderClass}>
            <th className={tableCellClass} scope="col">
              Empleado
            </th>
            <th className={tableCellClass} scope="col">
              Fijo
            </th>
            <th className={tableCellClass} scope="col">
              Comisiones
            </th>
            <th className={tableCellClass} scope="col">
              Bonos
            </th>
            <th className={tableCellClass} scope="col">
              Vales
            </th>
            <th className={tableCellClass} scope="col">
              Otros
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
              Detalle
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className={tableRowClass}>
              <td className={tableCellClass}>
                <span className="block">{employeeName(item.employee_id)}</span>
                <span className="block text-xs text-text-tertiary">{payLabel(item.employee_id)}</span>
              </td>
              <td className={tableCellClass}>{formatMoney(item.base_fixed)}</td>
              <td className={tableCellClass}>{formatMoney(item.commissions)}</td>
              <td className={tableCellClass}>{formatMoney(item.bonuses)}</td>
              <td className={tableCellClass}>{formatMoney(item.deductions_vales)}</td>
              <td className={tableCellClass}>{formatMoney(item.other_discounts)}</td>
              <td className={cn(tableCellClass, "font-semibold")}>{formatMoney(item.net_pay)}</td>
              <td className={tableCellClass}>{formatMoney(item.paid)}</td>
              <td className={tableCellClass}>{formatMoney(item.remaining)}</td>
              <td className={tableCellClass}>
                <button
                  type="button"
                  onClick={() => onView(item)}
                  aria-label={`Ver el desglose de ${employeeName(item.employee_id)}`}
                  className={ghostClass}
                >
                  Ver
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type AdjustmentField = "bonuses" | "others";

interface DraftRow {
  employeeId: string;
  item: DetailItem | null;
}

interface DraftPayrollTableProps {
  rows: DraftRow[];
  employeeName: (id: string) => string;
  payLabel: (id: string) => string;
  adjustmentValue: (employeeId: string, field: AdjustmentField) => string;
  onAdjustmentChange: (employeeId: string, field: AdjustmentField, value: string) => void;
  onView: (item: DetailItem) => void;
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
  onAdjustmentChange,
  onView,
}: DraftPayrollTableProps) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className={cn("w-full text-left text-sm", "min-w-[1040px]")}>
        <thead>
          <tr className={tableHeaderClass}>
            <th className={tableCellClass} scope="col">
              Empleado
            </th>
            <th className={tableCellClass} scope="col">
              Fijo
            </th>
            <th className={tableCellClass} scope="col">
              Comisiones
            </th>
            <th className={tableCellClass} scope="col">
              Bonos
            </th>
            <th className={tableCellClass} scope="col">
              Vales
            </th>
            <th className={tableCellClass} scope="col">
              Otros
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
              Detalle
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const item = row.item;
            return (
              <tr key={row.employeeId} className={tableRowClass}>
                <td className={tableCellClass}>
                  <span className="block">{employeeName(row.employeeId)}</span>
                  <span className="block text-xs text-text-tertiary">{payLabel(row.employeeId)}</span>
                </td>
                <td className={tableCellClass}>{item ? formatMoney(item.base_fixed) : "—"}</td>
                <td className={tableCellClass}>{item ? formatMoney(item.commissions) : "—"}</td>
                <td className={tableCellClass}>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={adjustmentValue(row.employeeId, "bonuses")}
                    onChange={(event) => onAdjustmentChange(row.employeeId, "bonuses", event.target.value)}
                    aria-label={`Bonos de ${employeeName(row.employeeId)}`}
                    className={tableInputClass}
                  />
                </td>
                <td className={tableCellClass}>{item ? formatMoney(item.deductions_vales) : "—"}</td>
                <td className={tableCellClass}>
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    value={adjustmentValue(row.employeeId, "others")}
                    onChange={(event) => onAdjustmentChange(row.employeeId, "others", event.target.value)}
                    aria-label={`Otros descuentos de ${employeeName(row.employeeId)}`}
                    className={tableInputClass}
                  />
                </td>
                <td className={cn(tableCellClass, "font-semibold")}>
                  {item ? formatMoney(item.net_pay) : "—"}
                </td>
                <td className={tableCellClass}>{item ? formatMoney(item.paid) : "—"}</td>
                <td className={tableCellClass}>{item ? formatMoney(item.remaining) : "—"}</td>
                <td className={tableCellClass}>
                  {item ? (
                    <button
                      type="button"
                      onClick={() => onView(item)}
                      aria-label={`Ver el desglose de ${employeeName(row.employeeId)}`}
                      className={ghostClass}
                    >
                      Ver
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className={tableRowClass}>
              <td className={tableCellClass} colSpan={10}>
                No hay empleados activos para liquidar.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface ExpandedItemPanelProps {
  item: DetailItem;
  methods: PaymentMethodRow[];
  canPay: boolean;
  busy: boolean;
  portionsValue: string;
  onPortionsChange: (value: string) => void;
  onPay: () => void;
}

/** Desglose de comisiones y pago por porciones de un ítem (contenido del modal de detalle). */
function ExpandedItemPanel({
  item,
  methods,
  canPay,
  busy,
  portionsValue,
  onPortionsChange,
  onPay,
}: ExpandedItemPanelProps) {
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
              Factura #{line.consecutive_number ?? "?"} · {line.item_type} × {line.qty} a{" "}
              {formatMoney(line.unit_price)} = {formatMoney(line.line_subtotal)} → comisión{" "}
              {formatMoney(line.commission)}
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
          className="mt-2 flex flex-wrap items-end gap-2"
        >
          <label className={labelClass} htmlFor={`payroll-pay-${item.id}`}>
            Porciones (método:monto, …)
            <input
              id={`payroll-pay-${item.id}`}
              value={portionsValue}
              onChange={(event) => onPortionsChange(event.target.value)}
              placeholder="efectivo:200000, nequi:100000"
              className={inputClass}
            />
          </label>
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Pagando…" : "Pagar"}
          </button>
          <span className="text-text-tertiary">
            Métodos: {methods.map((row) => row.code).join(", ") || "sin métodos activos"}
          </span>
        </form>
      )}
    </div>
  );
}

export function PayrollClient(props: PayrollClientProps) {
  const [periods, setPeriods] = useState<PayrollPeriodRow[]>(props.initialPeriods);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialPeriods[0]?.id ?? null);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [detailTargetId, setDetailTargetId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Periodo: abrir (el rango se pide en el modal, no en la vista principal).
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Pagos: porciones por ítem (texto "metodo:monto, metodo:monto").
  const [portions, setPortions] = useState<Record<string, string>>({});
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
      setMessage({ kind: "error", text: `${result.code}: ${result.message}` });
      return false;
    }
    if (okText) setMessage({ kind: "ok", text: okText });
    return true;
  }

  /**
   * Valor vigente de un ajuste: lo editado por el usuario o, si todavía no lo
   * tocó, el monto ya calculado del ítem (así la tabla "viene" con lo
   * calculado y recalcular no borra los ajustes previos).
   */
  function adjustmentValue(employeeId: string, field: AdjustmentField): string {
    const edited = adjustments[employeeId]?.[field];
    if (edited !== undefined) return edited;
    const item = itemByEmployee.get(employeeId);
    if (!item) return "";
    return String(field === "bonuses" ? item.bonuses : item.other_discounts);
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

  // Inventory-style cancel: closing the dialog always resets its state.
  function closeDetail() {
    setDetail(null);
    setDetailTargetId(null);
    setAdjustments({});
    setPortions({});
    setDetailDialogOpen(false);
  }

  function loadDetail(id: string) {
    setSelectedId(id);    startViewTransition(async () => {
      const result = (await getPeriodDetailAction(id)) as ActionResult<PeriodDetail>;
      if (show(result)) {
        setDetail(result.data);
        setDetailDialogOpen(true);
      }
    });
  }

  async function handleOpen(event: FormEvent) {
    event.preventDefault();
    if (!startDate || !endDate) {
      setOpenError("Indique el rango del período.");
      return;
    }
    if (endDate < startDate) {
      setOpenError("La fecha final no puede ser anterior a la inicial.");
      return;
    }
    const collision = findOverlappingPeriod(periods, startDate, endDate);
    if (collision) {
      setOpenError(
        `El rango se solapa con ${formatPeriodLabel(collision)} (${collision.status}). Ajuste las fechas.`,
      );
      return;
    }
    setOpenError(null);
    setBusy(true);
    const result = (await openPayrollPeriodAction({
      start_date: startDate,
      end_date: endDate,
    })) as ActionResult<PayrollPeriodRow>;
    setBusy(false);
    if (!result.success) {
      setOpenError(`${result.code}: ${result.message}`);
      return;
    }
    setMessage({ kind: "ok", text: "Periodo abierto en borrador." });
    setStartDate("");
    setEndDate("");
    setOpenDialogOpen(false);
    await refreshPeriods(result.data.id);
    await loadDetail(result.data.id);
  }

  // Cerrar el modal de apertura siempre limpia su estado (mismo criterio que closeDetail).
  function closeOpenDialog() {
    setStartDate("");
    setEndDate("");
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
    const list = draftRows.map((row) => ({
      employee_id: row.employeeId,
      bonuses: toNumber(adjustmentValue(row.employeeId, "bonuses")) ?? 0,
      other_discounts: toNumber(adjustmentValue(row.employeeId, "others")) ?? 0,
    }));
    setBusy(true);
    const result = (await calculatePayrollAction(selectedId, {
      adjustments: list,
    })) as ActionResult<PeriodDetail>;
    setBusy(false);
    if (show(result, "Borrador recalculado: vales pendientes/aprobados quedaron descontados.")) {
      setDetail(result.data);
    }
  }

  async function handlePay(item: DetailItem) {
    const raw = portions[item.id] ?? "";
    const parts = raw
      .split(",")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [method_code = "", amountRaw = "", ...rest] = chunk.split(":");
        return {
          method_code: method_code.trim(),
          amount: toNumber(amountRaw) ?? NaN,
          reference: rest.join(":").trim() || undefined,
        };
      });
    if (parts.length === 0 || parts.some((row) => !row.method_code || !Number.isFinite(row.amount))) {
      setMessage({
        kind: "error",
        text: "Indique porciones método:monto separadas por coma (p. ej. efectivo:200000, nequi:100000).",
      });
      return;
    }
    setBusy(true);
    const result = (await payPayrollItemAction(item.id, {
      portions: parts,
    })) as ActionResult<{ paid: number; remaining: number }>;
    setBusy(false);
    if (show(result, "Pago registrado.")) {
      setPortions((prev) => ({ ...prev, [item.id]: "" }));
      if (selectedId) await loadDetail(selectedId);
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
      closeDetail();
      setSelectedId(null);
      await refreshPeriods();
    }
  }


  const selected = periods.find((row) => row.id === selectedId) ?? null;
  // Ítem cuyo desglose se muestra en el modal de detalle. Se resuelve contra el
  // detalle vigente para que un pago o recálculo refresque sus montos.
  const detailTarget = detailTargetId
    ? detail?.items.find((item) => item.id === detailTargetId) ?? null
    : null;

  // Ayuda para elegir el rango del nuevo periodo, construida solo con `periods`.
  const lastEnd = latestEndDate(periods);
  const suggestedStart = lastEnd ? nextDay(lastEnd) : null;
  const draftPeriods = periods.filter((row) => row.status === "borrador");
  const rangeInvalid = Boolean(startDate && endDate && endDate < startDate);
  const overlap =
    startDate && endDate && !rangeInvalid ? findOverlappingPeriod(periods, startDate, endDate) : null;

  /**
   * Nombre legible del empleado: nombre + ID interno (el código de empleado
   * `employee_code`; si no está definido, el documento). Nunca el número de
   * documento solo, para distinguir homónimos igual que en vales.
   */
  const employeeName = (id: string) => {
    const found = props.initialEmployees.find((row) => row.id === id);
    if (!found) return id.slice(0, 8);
    const internalId = found.employee_code ? found.employee_code : found.document;
    return `${found.full_name} (${internalId})`;
  };

  /**
   * Tipo de pago del empleado (fijo/porcentaje/mixto y su porcentaje) para la
   * columna de liquidación. Se resuelve contra la configuración vigente del
   * empleado, igual que el nombre.
   */
  const employeePayLabel = (id: string) => {
    const found = props.initialEmployees.find((row) => row.id === id);
    if (!found) return "Sin definir";
    return formatPayType(found.pay_type, found.commission_percent);
  };

  // Ítems del detalle con saldo pendiente de pago: bloquean el cierre del borrador.
  const pendingItems = (detail?.items ?? []).filter((item) => item.remaining > 0);

  return (
    <div className="flex flex-col gap-6">
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? errorClass : okClass}>
          {message.text}
        </p>
      )}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Periodos</h2>
        {props.initialEmployees.length === 0 && (
          <p className="mt-2 text-sm text-text-secondary">
            Aún no hay empleados en la sede: créelos en /admin antes de liquidar.
          </p>
        )}
        {props.canAdmin && (
          <button
            type="button"
            onClick={() => {
              setOpenError(null);
              setOpenDialogOpen(true);
            }}
            className={`${buttonClass} mt-3`}
          >
            Abrir período
          </button>
        )}
        <ul className="mt-3 flex flex-col gap-2">
          {periods.map((row) => (
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
              <span className="rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">{row.status}</span>
              {row.status === "cerrado" && row.closed_at && (
                <span className="text-xs text-text-tertiary">Cerrado: {new Date(row.closed_at).toLocaleString("es-CO")}</span>
              )}
            </li>
          ))}
          {periods.length === 0 && <li className="text-sm text-text-tertiary">Sin periodos todavía.</li>}
        </ul>
      </section>

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
                Elija el rango de fechas. El período se abre en borrador.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleOpen} className="mt-4 flex flex-col gap-4">
              <div className="flex flex-wrap gap-3">
                <label className={labelClass} htmlFor="payroll-open-start">
                  Inicio
                  <input
                    id="payroll-open-start"
                    type="date"
                    value={startDate}
                    onChange={(event) => {
                      setStartDate(event.target.value);
                      setOpenError(null);
                    }}
                    className={inputClass}
                    required
                  />
                </label>
                <label className={labelClass} htmlFor="payroll-open-end">
                  Fin
                  <input
                    id="payroll-open-end"
                    type="date"
                    value={endDate}
                    onChange={(event) => {
                      setEndDate(event.target.value);
                      setOpenError(null);
                    }}
                    className={inputClass}
                    required
                  />
                </label>
              </div>

              <div className="rounded-md border border-border-color bg-surface-hover p-3 text-sm text-text-secondary dark:border-border-color-2">
                <p className="font-medium text-text-primary">Períodos existentes</p>
                {periods.length === 0 ? (
                  <p className="mt-1">Sin períodos todavía: este será el primero.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {periods.map((row) => (
                      <li key={row.id} className="flex items-center justify-between gap-3">
                        <span>{formatPeriodLabel(row)}</span>
                        <span className="text-xs text-text-tertiary">{row.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {suggestedStart && (
                  <p className="mt-2">
                    Sugerencia: empiece el {formatFullDate(suggestedStart)}, día siguiente al último período
                    registrado.
                  </p>
                )}
                {draftPeriods.length > 0 && (
                  <p className="mt-2 text-text-tertiary">
                    {draftPeriods.length === 1
                      ? "Hay un período en borrador"
                      : `Hay ${draftPeriods.length} períodos en borrador`}
                    : no se pueden solapar rangos.
                  </p>
                )}
              </div>

              {rangeInvalid ? (
                <p className={errorClass}>La fecha final no puede ser anterior a la inicial.</p>
              ) : overlap ? (
                <p className={errorClass}>
                  El rango se solapa con {formatPeriodLabel(overlap)} ({overlap.status}). Ajuste las fechas.
                </p>
              ) : openError ? (
                <p role="alert" className={errorClass}>
                  {openError}
                </p>
              ) : null}

              <DialogFooter>
                <button type="button" className={ghostClass} onClick={closeOpenDialog}>
                  Cancelar
                </button>
                <button type="submit" disabled={busy} className={buttonClass}>
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
          <DialogContent className="max-w-6xl" aria-busy={isViewPending}>
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
                  {detail && (
                    <PeriodDetailTable
                      items={detail.items}
                      employeeName={employeeName}
                      payLabel={employeePayLabel}
                      onView={(item) => setDetailTargetId(item.id)}
                    />
                  )}
                </>
              ) : props.canAdmin ? (
                <>
                  <p className="mt-3 text-sm text-text-secondary">
                    Tabla del borrador: ajuste bonos y otros descuentos por empleado y recalcule si hubo
                    cambios.
                  </p>
                  <DraftPayrollTable
                    rows={draftRows}
                    employeeName={employeeName}
                    payLabel={employeePayLabel}
                    adjustmentValue={adjustmentValue}
                    onAdjustmentChange={updateAdjustment}
                    onView={(item) => setDetailTargetId(item.id)}
                  />
                  {pendingItems.length > 0 && (
                    <div
                      role="status"
                      className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
                    >
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
                    </div>
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
                    onView={(item) => setDetailTargetId(item.id)}
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
              portionsValue={portions[detailTarget.id] ?? ""}
              onPortionsChange={(value) =>
                setPortions((prev) => ({ ...prev, [detailTarget.id]: value }))
              }
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
