"use client";

import { useState, type FormEvent } from "react";
import {
  approveVoucherAction,
  listVouchersAction,
  rejectVoucherAction,
  requestVoucherAction,
  setVoucherLimitsAction,
} from "@/src/features/payroll/actions";
import type {
  VoucherRequestRow,
  VoucherSettingsRow,
} from "@/src/features/payroll/service";
import type { EmployeeRow } from "@/src/features/admin/service";

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

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

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

interface VouchersClientProps {
  initialEmployees: EmployeeRow[];
  initialSettings: VoucherSettingsRow | null;
  initialVouchers: VoucherRequestRow[];
  canAdmin: boolean;
}

export function VouchersClient(props: VouchersClientProps) {
  const [vouchers, setVouchers] = useState<VoucherRequestRow[]>(props.initialVouchers);
  const [settings, setSettings] = useState<VoucherSettingsRow | null>(props.initialSettings);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [maxDay, setMaxDay] = useState(
    props.initialSettings ? String(props.initialSettings.max_per_day) : "",
  );
  const [maxWeek, setMaxWeek] = useState(
    props.initialSettings ? String(props.initialSettings.max_per_week) : "",
  );
  const [voucherEmployee, setVoucherEmployee] = useState("");
  const [voucherAmount, setVoucherAmount] = useState("");
  const [voucherDate, setVoucherDate] = useState("");
  const [voucherNote, setVoucherNote] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  function show<T>(result: ActionResult<T>, okText?: string): result is { success: true; data: T } {
    if (!result.success) {
      setMessage({ kind: "error", text: `${result.code}: ${result.message}` });
      return false;
    }
    if (okText) setMessage({ kind: "ok", text: okText });
    return true;
  }

  function employeeName(id: string): string {
    const found = props.initialEmployees.find((row) => row.id === id);
    if (!found) return id.slice(0, 8);
    return `${found.document}${found.employee_code ? ` (${found.employee_code})` : ""}`;
  }

  async function refreshVouchers() {
    const result = (await listVouchersAction({})) as ActionResult<VoucherRequestRow[]>;
    if (result.success) setVouchers(result.data);
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

  return (
    <div className="flex flex-col gap-6">
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? errorClass : okClass}>
          {message.text}
        </p>
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
