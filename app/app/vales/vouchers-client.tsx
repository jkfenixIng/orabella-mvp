"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import {
  approveVoucherAction,
  listVouchersAction,
  rejectVoucherAction,
  requestVoucherAction,
} from "@/src/features/payroll/actions";
import type {
  VoucherRequestRow,
  VoucherSettingsRow,
} from "@/src/features/payroll/service";
import type { EmployeeRow, PaymentMethodRow } from "@/src/features/admin/service";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { Combobox } from "@/src/components/ui/lib/combobox";
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";
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

/** Campo de solo lectura del detalle: etiqueta pequeña sobre el valor. */
function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className="break-words text-sm text-text-primary">{children}</dd>
    </div>
  );
}

/** Item 5: días ISO (1=lunes…7=domingo) con nombre corto. */
const DAY_NAMES: Array<{ day: number; label: string }> = [
  { day: 1, label: "Lun" },
  { day: 2, label: "Mar" },
  { day: 3, label: "Mié" },
  { day: 4, label: "Jue" },
  { day: 5, label: "Vie" },
  { day: 6, label: "Sáb" },
  { day: 7, label: "Dom" },
];

interface VoucherRequestResult {
  requires_approval: boolean;
  day_not_allowed: boolean;
  auto_approved: boolean;
}

interface VouchersClientProps {
  initialEmployees: EmployeeRow[];
  initialSettings: VoucherSettingsRow | null;
  initialVouchers: VoucherRequestRow[];
  /** Métodos activos y arqueables de la sede (la lista NO va hardcodeada). */
  initialMethods: PaymentMethodRow[];
  /** Hay caja abierta en la sede. */
  shiftOpen: boolean;
  /** La caja abierta es mía (o soy admin). */
  shiftOwn: boolean;
  /** Nombre de quien abrió la caja (para el aviso de bloqueo). */
  shiftOwner: string | null;
  canAdmin: boolean;
  canIssue: boolean;
}

export function VouchersClient(props: VouchersClientProps) {
  const [vouchers, setVouchers] = useState<VoucherRequestRow[]>(props.initialVouchers);
  const [settings] = useState<VoucherSettingsRow | null>(props.initialSettings);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [voucherEmployee, setVoucherEmployee] = useState("");
  const [voucherAmount, setVoucherAmount] = useState("");
  const [voucherMethod, setVoucherMethod] = useState("");
  const [voucherNote, setVoucherNote] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  // Aprobación y rechazo comparten un único modal: guarda el vale y la acción.
  const [reviewTarget, setReviewTarget] = useState<{ id: string; action: "approve" | "reject" } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Detalle de solo lectura: guarda el vale seleccionado. Estado propio para no
  // colisionar con reviewTarget (aprobar/rechazar) ni con isCreateOpen.
  const [detailTarget, setDetailTarget] = useState<VoucherRequestRow | null>(null);
  const [busy, setBusy] = useState(false);
  // V1: sin topes configurados no se puede solicitar; el alta vive en un modal.
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const configured = settings !== null;
  // La caja abierta es quien abre el vale: sin turno abierto, o si el turno
  // es de otro y no soy admin, se bloquea (el servidor vuelve a validar).
  const shiftBlockReason: string | null = !props.shiftOpen
    ? "No hay caja abierta: abre tu turno para solicitar vales."
    : !props.shiftOwn
      ? props.shiftOwner
        ? `La caja abierta es del turno de ${props.shiftOwner}: solo ${props.shiftOwner} o un administrador puede solicitar vales.`
        : "La caja abierta es de otro turno: solo quien abrió el turno o un administrador puede solicitar vales."
      : null;
  // V2: resumen legible de los topes vigentes.
  const capsSummary = (() => {
    const parts: string[] = [];
    const perDay = settings?.per_day_limits ?? null;
    if (perDay && Object.keys(perDay).length > 0) {
      parts.push(
        `por día ${Object.entries(perDay)
          .map(([day, amount]) => `${DAY_NAMES[Number(day) - 1]?.label ?? day} ${formatMoney(amount)}`)
          .join(", ")}`,
      );
    }
    const day = Number(settings?.max_per_day ?? 0);
    const week = Number(settings?.max_per_week ?? 0);
    if (day > 0) parts.push(`día ${formatMoney(day)}`);
    if (week > 0) parts.push(`semana ${formatMoney(week)}`);
    return parts.length > 0 ? parts.join(" · ") : "sin topes";
  })();

  function show<T>(result: ActionResult<T>, okText?: string): result is { success: true; data: T } {
    if (!result.success) {
      setMessage({ kind: "error", text: `${result.code}: ${result.message}` });
      return false;
    }
    if (okText) setMessage({ kind: "ok", text: okText });
    return true;
  }

  /**
   * Etiqueta legible del empleado: nombre + ID interno. El ID interno es el
   * código de empleado (`employee_code`); si no está definido, se usa el
   * documento. Así dos personas con el mismo nombre se distinguen de un vistazo.
   */
  function employeeName(id: string): string {
    const found = props.initialEmployees.find((row) => row.id === id);
    if (!found) return id.slice(0, 8);
    const internalId = found.employee_code ? found.employee_code : found.document;
    return `${found.full_name} (${internalId})`;
  }

  /**
   * Nombre legible del método de pago. Se resuelve contra los métodos activos;
   * un vale histórico puede apuntar a un método ya inactivo, en ese caso se
   * muestra el código tal cual.
   */
  function methodLabel(code: string | null): string {
    if (!code) return "-";
    const found = props.initialMethods.find((row) => row.code === code);
    return found ? `${found.name} (${code})` : code;
  }

  async function refreshVouchers() {
    const result = (await listVouchersAction({})) as ActionResult<VoucherRequestRow[]>;
    if (result.success) setVouchers(result.data);
  }

  async function handleRequestVoucher(event: FormEvent) {
    event.preventDefault();
    const amount = toNumber(voucherAmount);
    if (!voucherEmployee || amount === null) {
      setMessage({ kind: "error", text: "Elija el empleado e indique un monto mayor a 0." });
      return;
    }
    if (!voucherMethod) {
      setMessage({ kind: "error", text: "Elija el método de pago por el que saldrá el dinero." });
      return;
    }
    setBusy(true);
    // La fecha del vale la asigna el backend (día de la solicitud) y el turno
    // de caja lo toma del turno abierto; el frontend no los envía.
    const result = (await requestVoucherAction({
      employee_id: voucherEmployee,
      amount,
      method_code: voucherMethod,
      observation: voucherNote || undefined,
    })) as ActionResult<VoucherRequestResult>;
    setBusy(false);
    if (
      show(
        result,
        !result.success
          ? undefined
          : result.data.auto_approved
            ? "Vale aprobado: dentro de rango se generó directo con su método de pago."
            : "Vale pendiente: fuera de rango (día o topes), el admin debe autorizarlo.",
      )
    ) {
      setVoucherAmount("");
      setVoucherMethod("");
      setVoucherNote("");
      setIsCreateOpen(false);
      await refreshVouchers();
    }
  }

  async function handleApprove(id: string) {
    setBusy(true);
    const result = (await approveVoucherAction(id, {
      observation: reviewNote || undefined,
    })) as ActionResult<VoucherRequestRow>;
    setBusy(false);
    if (show(result, "Vale aprobado.")) {
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

  function openReview(id: string, action: "approve" | "reject") {
    setMessage(null);
    setReviewError(null);
    setReviewNote("");
    setRejectReason("");
    setReviewTarget({ id, action });
  }

  function closeReview() {
    setReviewTarget(null);
    setReviewError(null);
    setReviewNote("");
    setRejectReason("");
  }

  async function confirmReview() {
    if (!reviewTarget) return;
    if (reviewTarget.action === "reject" && !rejectReason.trim()) {
      setReviewError("El motivo del rechazo es requerido.");
      return;
    }
    const { id, action } = reviewTarget;
    if (action === "approve") {
      await handleApprove(id);
    } else {
      await handleReject(id);
    }
    closeReview();
  }

  return (
    <div className="flex flex-col gap-6">
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? errorClass : okClass}>
          {message.text}
        </p>
      )}

      <section className={sectionClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Vales</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {configured ? (
                <>
                  Topes vigentes: {capsSummary} · días{" "}
                  {settings?.allowed_days && settings.allowed_days.length < 7
                    ? settings.allowed_days.map((day) => DAY_NAMES[day - 1]?.label ?? day).join(", ")
                    : "todos"}.
                </>
              ) : (
                "Topes vigentes: sin configurar."
              )}
            </p>
          </div>
          {props.canIssue && (
            <button
              type="button"
              title={
                !configured
                  ? "Configure los topes antes de solicitar vales"
                  : shiftBlockReason ?? undefined
              }
              disabled={!configured || shiftBlockReason !== null}
              onClick={() => {
                setMessage(null);
                setIsCreateOpen(true);
              }}
              className={`${buttonClass} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              Solicitar vale
            </button>
          )}
        </div>
        {!configured && (
          <p role="status" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            Los vales no están configurados: un administrador debe definir topes y días permitidos antes de solicitar.
          </p>
        )}
        {props.canIssue && configured && shiftBlockReason !== null && (
          <p role="status" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            {shiftBlockReason}
          </p>
        )}
        {props.canIssue && (
          <Dialog
            open={isCreateOpen}
            onOpenChange={(open) => {
              if (!open) setIsCreateOpen(false);
              else setIsCreateOpen(true);
            }}
          >
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Solicitar vale</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleRequestVoucher} className="mt-3 flex flex-col gap-3">
                <label className={labelClass}>
                  Empleado
                  <Combobox
                    value={voucherEmployee}
                    onValueChange={setVoucherEmployee}
                    placeholder="Seleccione…"
                    options={props.initialEmployees
                      .filter((row) => row.is_active)
                      .map((row) => ({
                        value: row.id,
                        label: employeeName(row.id),
                      }))}
                    ariaLabel="Empleado que solicita el vale"
                    filterPlaceholder="Buscar empleado…"
                  />
                </label>
                <label className={labelClass}>
                  Monto
                  <input value={formatMoneyInput(voucherAmount)} onChange={(event) => setVoucherAmount(stripMoneyInput(event.target.value))} inputMode="numeric" className={inputClass} />
                </label>
                <label className={labelClass}>
                  Método de pago (arqueable)
                  <Combobox
                    value={voucherMethod}
                    onValueChange={setVoucherMethod}
                    placeholder="Seleccione…"
                    options={props.initialMethods.map((row) => ({
                      value: row.code,
                      label: row.name,
                    }))}
                    ariaLabel="Método de pago por el que sale el vale"
                    filterPlaceholder="Buscar método…"
                  />
                </label>
                {props.initialMethods.length === 0 && (
                  <p role="status" className={errorClass}>
                    No hay métodos de pago arqueables activos: configúrelos antes de solicitar vales.
                  </p>
                )}
                <label className={labelClass}>
                  Observación (opcional)
                  <input value={voucherNote} onChange={(event) => setVoucherNote(event.target.value)} className={inputClass} />
                </label>
                <DialogFooter>
                  <button type="button" className={ghostClass} onClick={() => setIsCreateOpen(false)}>
                    Cancelar
                  </button>
                  <button type="submit" disabled={busy} className={buttonClass}>
                    {busy ? "Solicitando…" : "Solicitar vale"}
                  </button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
        <ul className="mt-4 flex flex-col gap-2">
          {vouchers.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {employeeName(row.employee_id)} · {formatMoney(row.amount)} · {row.request_date}
              </span>
              <span className="rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">
                {row.status}
                {row.status === "descontada" ? " (en nómina: sin cambios)" : ""}
              </span>
              {row.method_code && <span className="text-xs">Método: {row.method_code}</span>}
              {row.observation && <span className="text-xs text-text-tertiary">{row.observation}</span>}
              <button
                type="button"
                onClick={() => {
                  setMessage(null);
                  setDetailTarget(row);
                }}
                className={ghostClass}
                aria-label={`Ver detalle del vale de ${employeeName(row.employee_id)}`}
              >
                Ver detalle
              </button>
              {props.canAdmin && row.status === "pendiente" && (
                <>
                  <button type="button" onClick={() => openReview(row.id, "approve")} disabled={busy} className={ghostClass}>
                    Aprobar
                  </button>
                  <button type="button" onClick={() => openReview(row.id, "reject")} disabled={busy} className={ghostClass}>
                    Rechazar
                  </button>
                </>
              )}
            </li>
          ))}
          {vouchers.length === 0 && <li className="text-sm text-text-tertiary">Sin vales todavía.</li>}
        </ul>
        {/* Detalle de solo lectura: disponible para cualquier rol, sin acciones. */}
        <Dialog
          open={detailTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDetailTarget(null);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Detalle del vale</DialogTitle>
            </DialogHeader>
            {detailTarget && (
              <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailField label="Empleado">{employeeName(detailTarget.employee_id)}</DetailField>
                <DetailField label="Identificador">{detailTarget.id}</DetailField>
                <DetailField label="Monto">{formatMoney(detailTarget.amount)}</DetailField>
                <DetailField label="Fecha de solicitud">{detailTarget.request_date}</DetailField>
                <DetailField label="Estado">
                  {detailTarget.status}
                  {detailTarget.status === "descontada" ? " (en nómina: sin cambios)" : ""}
                </DetailField>
                <DetailField label="Método de pago">{methodLabel(detailTarget.method_code)}</DetailField>
                <DetailField label="Turno de caja">{detailTarget.cash_shift_id ?? "-"}</DetailField>
                <DetailField label="Observación">{detailTarget.observation ?? "-"}</DetailField>
                <DetailField label="Código histórico">{detailTarget.approval_code ?? "-"}</DetailField>
              </dl>
            )}
            <DialogFooter>
              <button type="button" className={ghostClass} onClick={() => setDetailTarget(null)}>
                Cerrar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {props.canAdmin && (
          <Dialog
            open={reviewTarget !== null}
            onOpenChange={(open) => {
              if (!open) closeReview();
            }}
          >
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  {reviewTarget?.action === "reject" ? "Rechazar vale" : "Aprobar vale"}
                </DialogTitle>
              </DialogHeader>
              <div className="mt-3 flex flex-col gap-3">
                {reviewTarget?.action === "reject" ? (
                  <label className={labelClass}>
                    Motivo de rechazo
                    <input
                      value={rejectReason}
                      onChange={(event) => {
                        setRejectReason(event.target.value);
                        if (reviewError) setReviewError(null);
                      }}
                      className={inputClass}
                    />
                  </label>
                ) : (
                  <label className={labelClass}>
                    Observación de aprobación (opcional)
                    <input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} className={inputClass} />
                  </label>
                )}
                {reviewError && (
                  <p role="alert" className={errorClass}>
                    {reviewError}
                  </p>
                )}
                <DialogFooter>
                  <button type="button" className={ghostClass} onClick={closeReview}>
                    Cancelar
                  </button>
                  <button type="button" disabled={busy} className={buttonClass} onClick={confirmReview}>
                    {busy ? "Procesando…" : reviewTarget?.action === "reject" ? "Rechazar" : "Aprobar"}
                  </button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </section>
    </div>
  );
}
