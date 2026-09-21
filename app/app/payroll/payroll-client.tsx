"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  approveVoucherAction,
  calculatePayrollAction,
  closePayrollPeriodAction,
  getPeriodDetailAction,
  listPeriodsAction,
  listVouchersAction,
  openPayrollPeriodAction,
  payPayrollItemAction,
  rejectVoucherAction,
  requestVoucherAction,
  setVoucherLimitsAction,
} from "@/src/features/payroll/actions";
import type {
  PayrollPeriodRow,
  PeriodDetail,
  VoucherRequestRow,
  VoucherSettingsRow,
} from "@/src/features/payroll/service";
import type { EmployeeRow, PaymentMethodRow } from "@/src/features/admin/service";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";

const inputClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
const labelClass = "flex flex-col gap-1 text-sm";
const buttonClass =
  "rounded bg-slate-200 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700";
const ghostClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700";
const sectionClass = "rounded-lg border border-slate-300 p-4 dark:border-slate-700";
const errorClass = "text-sm text-red-600 dark:text-red-400";
const okClass = "text-sm text-green-700 dark:text-green-400";

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
  initialSettings: VoucherSettingsRow | null;
  initialVouchers: VoucherRequestRow[];
  methods: PaymentMethodRow[];
  canAdmin: boolean;
  canPay: boolean;
}

type DetailItem = PeriodDetail["items"][number];

export function PayrollClient(props: PayrollClientProps) {
  const [periods, setPeriods] = useState<PayrollPeriodRow[]>(props.initialPeriods);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialPeriods[0]?.id ?? null);
  const [detail, setDetail] = useState<PeriodDetail | null>(null);
  const [vouchers, setVouchers] = useState<VoucherRequestRow[]>(props.initialVouchers);
  const [settings, setSettings] = useState<VoucherSettingsRow | null>(props.initialSettings);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Periodo: abrir.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Vales: topes.
  const [maxDay, setMaxDay] = useState(
    props.initialSettings ? String(props.initialSettings.max_per_day) : "",
  );
  const [maxWeek, setMaxWeek] = useState(
    props.initialSettings ? String(props.initialSettings.max_per_week) : "",
  );
  // Vales: solicitar.
  const [voucherEmployee, setVoucherEmployee] = useState("");
  const [voucherAmount, setVoucherAmount] = useState("");
  const [voucherDate, setVoucherDate] = useState("");
  const [voucherNote, setVoucherNote] = useState("");
  // Vales: revisar.
  const [reviewNote, setReviewNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
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

  function refreshVouchers() {
    startViewTransition(async () => {
      const result = (await listVouchersAction({})) as ActionResult<VoucherRequestRow[]>;
      if (result.success) setVouchers(result.data);
    });
  }

  function loadDetail(id: string) {
    setSelectedId(id);
    startViewTransition(async () => {
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
    if (show(result, "Periodo cerrado: quedó inmutable.")) {
      await refreshPeriods(selectedId);
      await loadDetail(selectedId);
    }
  }

  async function handleLimits(event: FormEvent) {
    event.preventDefault();
    const day = toNumber(maxDay);
    const week = toNumber(maxWeek);
    if (day === null || week === null) {
      setMessage({ kind: "error", text: "Los topes deben ser números." });
      return;
    }
    setBusy(true);
    const result = (await setVoucherLimitsAction({
      max_per_day: day,
      max_per_week: week,
    })) as ActionResult<VoucherSettingsRow>;
    setBusy(false);
    if (show(result, "Topes actualizados.")) setSettings(result.data);
  }

  async function handleRequestVoucher(event: FormEvent) {
    event.preventDefault();
    const amount = toNumber(voucherAmount);
    if (!voucherEmployee || amount === null) {
      setMessage({ kind: "error", text: "Elija el empleado e indique un monto mayor a 0." });
      return;
    }
    setBusy(true);
    const result = (await requestVoucherAction({
      employee_id: voucherEmployee,
      amount,
      request_date: voucherDate || undefined,
      observation: voucherNote || undefined,
    })) as ActionResult<{ requires_approval: boolean }>;
    setBusy(false);
    if (
      show(
        result,
        result.success && result.data.requires_approval
          ? "Vale pendiente: supera los topes y exige aprobación con código."
          : "Vale solicitado.",
      )
    ) {
      setVoucherAmount("");
      setVoucherDate("");
      setVoucherNote("");
      await refreshVouchers();
    }
  }

  async function handleApprove(id: string) {
    setBusy(true);
    const result = (await approveVoucherAction(id, {
      observation: reviewNote || undefined,
    })) as ActionResult<VoucherRequestRow>;
    setBusy(false);
    if (show(result, result.success ? `Vale aprobado con código ${result.data.approval_code}.` : undefined)) {
      setReviewNote("");
      await refreshVouchers();
    }
  }

  async function handleReject(id: string) {
    if (!rejectReason.trim()) {
      setMessage({ kind: "error", text: "El motivo del rechazo es requerido." });
      return;
    }
    setBusy(true);
    const result = (await rejectVoucherAction(id, {
      motivo: rejectReason,
    })) as ActionResult<VoucherRequestRow>;
    setBusy(false);
    if (show(result, "Vale rechazado.")) {
      setRejectReason("");
      await refreshVouchers();
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
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
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
              <span className="rounded bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-800">{row.status}</span>
              {row.status === "cerrado" && row.closed_at && (
                <span className="text-xs text-slate-500">Cerrado: {new Date(row.closed_at).toLocaleString("es-CO")}</span>
              )}
            </li>
          ))}
          {periods.length === 0 && <li className="text-sm text-slate-500">Sin periodos todavía.</li>}
        </ul>
      </section>

      {selected && (
        <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
          <DialogContent className="max-w-4xl" aria-busy={isViewPending}>
            <DialogHeader>
              <DialogTitle>
                Liquidación {selected.start_date} → {selected.end_date} ({selected.status})
              </DialogTitle>
            </DialogHeader>
            <div className="max-h-[calc(100dvh-12rem)] overflow-y-auto pr-1">
          {selected.status === "cerrado" ? (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Periodo cerrado e inmutable: no admite cálculo ni pagos.
            </p>
          ) : (
            props.canAdmin && (
              <form onSubmit={handleCalculate} className="mt-3 flex flex-col gap-2">
                <p className="text-sm text-slate-600 dark:text-slate-300">
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
                  <tr className="text-left text-xs text-slate-500">
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
                    <tr key={item.id} className="border-t border-slate-200 dark:border-slate-800">
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
                    <div key={`${item.id}-detail`} className="mt-2 rounded bg-slate-100 p-3 text-xs dark:bg-slate-900">
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
                          <span className="text-slate-500">
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
              <DialogClose asChild>
                <button type="button" className={ghostClass}>
                  Cerrar
                </button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Vales</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Topes vigentes: día {settings ? formatMoney(settings.max_per_day) : "sin configurar"} · semana{" "}
          {settings ? formatMoney(settings.max_per_week) : "sin configurar"}.
        </p>
        {props.canAdmin && (
          <form onSubmit={handleLimits} className="mt-3 flex flex-wrap items-end gap-3">
            <label className={labelClass}>
              Máximo por día
              <input value={maxDay} onChange={(event) => setMaxDay(event.target.value)} inputMode="decimal" className={inputClass} />
            </label>
            <label className={labelClass}>
              Máximo por semana
              <input value={maxWeek} onChange={(event) => setMaxWeek(event.target.value)} inputMode="decimal" className={inputClass} />
            </label>
            <button type="submit" disabled={busy} className={buttonClass}>
              Guardar topes
            </button>
          </form>
        )}
        <form onSubmit={handleRequestVoucher} className="mt-4 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Empleado
            <select value={voucherEmployee} onChange={(event) => setVoucherEmployee(event.target.value)} className={inputClass}>
              <option value="">Seleccione…</option>
              {props.initialEmployees
                .filter((row) => row.is_active)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {employeeName(row.id)}
                  </option>
                ))}
            </select>
          </label>
          <label className={labelClass}>
            Monto
            <input value={voucherAmount} onChange={(event) => setVoucherAmount(event.target.value)} inputMode="decimal" className={inputClass} />
          </label>
          <label className={labelClass}>
            Fecha (opcional)
            <input type="date" value={voucherDate} onChange={(event) => setVoucherDate(event.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Observación (opcional)
            <input value={voucherNote} onChange={(event) => setVoucherNote(event.target.value)} className={inputClass} />
          </label>
          <button type="submit" disabled={busy} className={buttonClass}>
            Solicitar vale
          </button>
        </form>
        <ul className="mt-4 flex flex-col gap-2">
          {vouchers.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {employeeName(row.employee_id)} · {formatMoney(row.amount)} · {row.request_date}
              </span>
              <span className="rounded bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-800">{row.status}</span>
              {row.approval_code && <span className="text-xs">Código: {row.approval_code}</span>}
              {row.observation && <span className="text-xs text-slate-500">{row.observation}</span>}
              {props.canAdmin && row.status === "pendiente" && (
                <>
                  <button type="button" onClick={() => handleApprove(row.id)} disabled={busy} className={ghostClass}>
                    Aprobar con código
                  </button>
                  <button type="button" onClick={() => handleReject(row.id)} disabled={busy} className={ghostClass}>
                    Rechazar
                  </button>
                </>
              )}
            </li>
          ))}
          {vouchers.length === 0 && <li className="text-sm text-slate-500">Sin vales todavía.</li>}
        </ul>
        {props.canAdmin && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className={labelClass}>
              Observación de aprobación (opcional)
              <input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Motivo de rechazo
              <input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} className={inputClass} />
            </label>
          </div>
        )}
      </section>
    </div>
  );
}
