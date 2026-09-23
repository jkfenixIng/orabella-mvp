"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  calculatePayrollAction,
  closePayrollPeriodAction,
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

interface PayrollClientProps {
  sedeId: string;
  initialEmployees: EmployeeRow[];
  initialPeriods: PayrollPeriodRow[];
  methods: PaymentMethodRow[];
  canAdmin: boolean;
  canPay: boolean;
}

type DetailItem = PeriodDetail["items"][number];

export function PayrollClient(props: PayrollClientProps) {
  const [periods, setPeriods] = useState<PayrollPeriodRow[]>(props.initialPeriods);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialPeriods[0]?.id ?? null);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Periodo: abrir.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Pagos: porciones por ítem (texto "metodo:monto, metodo:monto").
  const [portions, setPortions] = useState<Record<string, string>>({});
  // Ajustes por empleado al calcular ("bonos,otros" por empleado).
  const [adjustments, setAdjustments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  // Transición para los cambios de vista (detalle del periodo / vales):
  // la UI no se congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();

  function show<T>(result: ActionResult<T>, okText?: string): result is { success: true; data: T } {
    if (!result.success) {
      setMessage({ kind: "error", text: `${result.code}: ${result.message}` });
      return false;
    }
    if (okText) setMessage({ kind: "ok", text: okText });
    return true;
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
    setExpanded({});
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
      setMessage({ kind: "error", text: "Indique el rango del periodo." });
      return;
    }
    setBusy(true);
    const result = (await openPayrollPeriodAction({
      start_date: startDate,
      end_date: endDate,
    })) as ActionResult<PayrollPeriodRow>;
    setBusy(false);
    if (show(result, "Periodo abierto en borrador.")) {
      setStartDate("");
      setEndDate("");
      await refreshPeriods(result.data.id);
      await loadDetail(result.data.id);
    }
  }

  async function handleCalculate(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    const list = Object.entries(adjustments)
      .map(([employee_id, raw]) => {
        const [bonusesRaw = "", othersRaw = ""] = raw.split(",");
        return {
          employee_id,
          bonuses: toNumber(bonusesRaw) ?? 0,
          other_discounts: toNumber(othersRaw) ?? 0,
        };
      })
      .filter((row) => row.bonuses > 0 || row.other_discounts > 0);
    setBusy(true);
    const result = (await calculatePayrollAction(selectedId, {
      adjustments: list,
    })) as ActionResult<PeriodDetail>;
    setBusy(false);
    if (show(result, "Nómina calculada: vales pendientes/aprobados quedaron descontados.")) {
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


  const selected = periods.find((row) => row.id === selectedId) ?? null;
  const employeeName = (id: string) => {
    const found = props.initialEmployees.find((row) => row.id === id);
    if (!found) return id.slice(0, 8);
    return `${found.document}${found.employee_code ? ` (${found.employee_code})` : ""}`;
  };

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
          <form onSubmit={handleOpen} className="mt-3 flex flex-wrap items-end gap-3">
            <label className={labelClass}>
              Inicio
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Fin
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={inputClass} />
            </label>
            <button type="submit" disabled={busy} className={buttonClass}>
              Abrir periodo
            </button>
          </form>
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

      {selected && (
        <Dialog
          open={detailDialogOpen}
          onOpenChange={(open) => {
            if (!open) closeDetail();
            else setDetailDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-4xl" aria-busy={isViewPending}>
            <DialogHeader>
              <DialogTitle>
                Liquidación {selected.start_date} → {selected.end_date} ({selected.status})
              </DialogTitle>
            </DialogHeader>
            <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto pr-1">
          {selected.status === "cerrado" ? (
            <p className="mt-2 text-sm text-text-secondary">
              Periodo cerrado.
            </p>
          ) : (
            props.canAdmin && (
              <form onSubmit={handleCalculate} className="mt-3 flex flex-col gap-2">
                <p className="text-sm text-text-secondary">
                  Ajustes opcionales por empleado (bonos,otros descuentos separados por coma).
                </p>
                {props.initialEmployees
                  .filter((row) => row.is_active)
                  .map((row) => (
                    <label key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-48 truncate">{employeeName(row.id)}</span>
                      <input
                        value={adjustments[row.id] ?? ""}
                        onChange={(event) => setAdjustments((prev) => ({ ...prev, [row.id]: event.target.value }))}
                        placeholder="bonos,otros (p. ej. 50000,10000)"
                        className={inputClass}
                      />
                    </label>
                  ))}
                <div>
                  <button type="submit" disabled={busy} className={buttonClass}>
                    Calcular nómina
                  </button>
                </div>
              </form>
            )
          )}
          {!detail && (
            <button
              type="button"
              onClick={() => loadDetail(selected.id)}
              disabled={isViewPending}
              className={`${ghostClass} mt-3`}
            >
              {isViewPending ? "Cargando…" : "Ver liquidación"}
            </button>
          )}
          {detail && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-text-tertiary">
                    <th className="py-1 pr-2">Empleado</th>
                    <th className="py-1 pr-2">Fijo</th>
                    <th className="py-1 pr-2">Comisiones</th>
                    <th className="py-1 pr-2">Bonos</th>
                    <th className="py-1 pr-2">Vales</th>
                    <th className="py-1 pr-2">Otros</th>
                    <th className="py-1 pr-2">Neto</th>
                    <th className="py-1 pr-2">Pagado</th>
                    <th className="py-1 pr-2">Saldo</th>
                    <th className="py-1 pr-2">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((item) => (
                    <tr key={item.id} className="border-t border-border-color dark:border-border-color-2">
                      <td className="py-2 pr-2">{employeeName(item.employee_id)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.base_fixed)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.commissions)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.bonuses)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.deductions_vales)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.other_discounts)}</td>
                      <td className="py-2 pr-2 font-semibold">{formatMoney(item.net_pay)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.paid)}</td>
                      <td className="py-2 pr-2">{formatMoney(item.remaining)}</td>
                      <td className="py-2 pr-2">
                        <button
                          type="button"
                          onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                          className={ghostClass}
                        >
                          {expanded[item.id] ? "Ocultar" : "Ver"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.items.map(
                (item) =>
                  expanded[item.id] && (
                    <div key={`${item.id}-detail`} className="mt-2 rounded bg-surface-hover p-3 text-xs text-text-secondary">
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
                      {props.canPay && selected.status === "borrador" && item.remaining > 0 && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handlePay(item);
                          }}
                          className="mt-2 flex flex-wrap items-end gap-2"
                        >
                          <label className={labelClass}>
                            Porciones (método:monto, …)
                            <input
                              value={portions[item.id] ?? ""}
                              onChange={(event) => setPortions((prev) => ({ ...prev, [item.id]: event.target.value }))}
                              placeholder="efectivo:200000, nequi:100000"
                              className={inputClass}
                            />
                          </label>
                          <button type="submit" disabled={busy} className={buttonClass}>
                            Pagar
                          </button>
                          <span className="text-text-tertiary">
                            Métodos: {props.methods.map((row) => row.code).join(", ") || "sin métodos activos"}
                          </span>
                        </form>
                      )}
                    </div>
                  ),
              )}
              {props.canAdmin && selected.status === "borrador" && (
                <button type="button" onClick={handleClose} disabled={busy} className={`${buttonClass} mt-4`}>
                  Cerrar periodo
                </button>
              )}
            </div>
          )}
            </div>
            <DialogFooter>
              <button type="button" className={ghostClass} onClick={closeDetail}>
                Cerrar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

    </div>
  );
}
