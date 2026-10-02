"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
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
import { ConfirmDialog } from "@/src/components/ui/lib/form-dialog";
import { Combobox } from "@/src/components/ui/lib/combobox";
import { Alert } from "@/src/components/ui/lib/alert";
import { formatMoney, formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { bogotaDay } from "@/src/shared/lib/dates";
import { checkVoucherEligibility, weekStartOf } from "@/src/features/payroll/schemas";
import { toNumber } from "@/src/shared/lib/format";
import { cn } from "@/src/components/ui/lib/utils";
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
  // Un solo canal de ESTADO: lo que sigue siendo el caso mientras no se
  // corrija (fallo de acción o validación incompleta). Lo que acaba de pasar
  // (éxito) es EVENTO y sale por `toast`, no por estado.
  const [error, setError] = useState<string | null>(null);
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
  // Filtros del listado: se aplican en cliente sobre los vales ya cargados
  // (el backend no expone un filtro combinado, así que se resuelve aquí).
  const [statusFilter, setStatusFilter] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // V1: sin topes configurados no se puede solicitar; el alta vive en un modal.
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // V1 (previsión): el fuera de rango no se envía directo: abre la
  // confirmación que dice que nacerá pendiente en revisión del admin. En
  // rango este diálogo nunca se abre.
  const [outOfRangeConfirmOpen, setOutOfRangeConfirmOpen] = useState(false);
  /**
   * CL-5: marca de idempotencia del INTENTO de solicitud de vale.
   *
   * Una sola marca (no un mapa): el modal abre UN vale a la vez, así que su
   * identidad es (empleado, marca) y el registro del intento alcanza con una
   * marca mientras el diálogo está abierto. Se acuña cuando el intento EMPIEZA
   * (al enviar el formulario) y se conserva si el intento falla: el reintento
   * tiene que llevar la misma para que el servidor devuelva el vale ya
   * registrado en vez de abrir un segundo vale —con su segunda salida de caja en
   * el arqueo y su segundo descuento en la nómina—. Se suelta cuando el intento
   * termina bien y al cerrar el diálogo.
   *
   * Acá no hay nada más que frene un reintento: los topes de 026 son
   * ACUMULADOS (día y semana), no la identidad de un envío, así que mientras
   * `2 × monto` quepa el segundo vale entra. Por eso la marca es la única
   * barrera posible.
   *
   * No es por tecla ni por render: monto, método y observación cambian
   * libremente sin tocar la marca, así que dos vales legítimos distintos son dos
   * intentos con dos marcas.
   *
   * `crypto.randomUUID()` está en el navegador (contexto seguro) y en el runtime
   * de Node: no hace falta ninguna dependencia nueva.
   */
  const voucherKeyRef = useRef<string | null>(null);
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
  // V1 (previsión, no veredicto): ¿este borrador nacería PENDIENTE en
  // revisión del admin? Se deriva en vivo de lo que la pantalla YA tiene —los
  // topes de `settings` más los acumulados de los `vouchers` cargados—, sin
  // llamada nueva: la fecha la asigna el backend (día de la solicitud en
  // Bogotá) y los acumulados son los vigentes que el servicio sumaría
  // (pendiente/aprobada del empleado en el día y en la semana). La
  // elegibilidad la decide LA MISMA función pura que usa el servicio, así que
  // el aviso anticipa su veredicto en vez de adivinarlo. `null` = en rango (o
  // sin nada que decir todavía): no hay aviso y el envío sigue directo.
  const voucherReviewNotice = (() => {
    if (!configured) return null;
    if (!voucherEmployee) return null;
    const requested = toNumber(voucherAmount);
    if (requested === null || requested <= 0) return null;
    // El mismo día que el backend va a asignar: avisar sobre otro día sería
    // prometer lo que no va a pasar.
    const today = bogotaDay();
    const weekStart = weekStartOf(today);
    let dayTotal = 0;
    let weekTotal = 0;
    for (const row of vouchers) {
      if (row.employee_id !== voucherEmployee) continue;
      if (row.status !== "pendiente" && row.status !== "aprobada") continue;
      // Misma semana = mismo lunes: equivale a la ventana [lunes, lunes+6]
      // del servicio sin aritmética de fechas en el cliente.
      if (weekStartOf(row.request_date) !== weekStart) continue;
      weekTotal = weekTotal + Number(row.amount);
      if (row.request_date === today) dayTotal = dayTotal + Number(row.amount);
    }
    const eligibility = checkVoucherEligibility({
      dayTotal,
      weekTotal,
      requested,
      maxPerDay: settings?.max_per_day == null ? null : Number(settings.max_per_day),
      maxPerWeek: settings?.max_per_week == null ? null : Number(settings.max_per_week),
      requestDate: today,
      allowedDays: settings?.allowed_days ?? null,
      perDayLimits: settings?.per_day_limits ?? null,
    });
    const overCap = eligibility.overDay || eligibility.overWeek;
    if (!overCap && !eligibility.dayNotAllowed) return null;
    if (overCap && eligibility.dayNotAllowed) {
      return "Este vale supera el tope vigente y hoy no es un día permitido: nacerá pendiente y el admin debe autorizarlo.";
    }
    if (eligibility.dayNotAllowed) {
      return "Hoy no es un día permitido para vales: este vale nacerá pendiente y el admin debe autorizarlo.";
    }
    return "Este vale supera el tope vigente: nacerá pendiente y el admin debe autorizarlo.";
  })();

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
      setError("Elija el empleado e indique un monto mayor a 0.");
      return;
    }
    if (!voucherMethod) {
      setError("Elija el método de pago por el que saldrá el dinero.");
      return;
    }
    // V1: fuera de rango no se envía todavía: primero se confirma que nacerá
    // pendiente en revisión del admin. En rango se sigue directo, como antes.
    if (voucherReviewNotice !== null && !outOfRangeConfirmOpen) {
      setOutOfRangeConfirmOpen(true);
      return;
    }
    await submitVoucherRequest(amount);
  }

  // El envío real del vale: la MISMA llamada con el MISMO payload de siempre.
  // Llega acá directo (en rango) o tras confirmar (fuera de rango).
  async function submitVoucherRequest(amount: number) {
    setBusy(true);
    // CL-5: la marca del INTENTO. Se acuña al empezar y se conserva si el
    // intento falla (el reintento tiene que llevar la misma para que el servidor
    // devuelva el vale ya registrado en vez de abrir un segundo vale).
    const voucherKey = voucherKeyRef.current ?? crypto.randomUUID();
    voucherKeyRef.current = voucherKey;
    // La fecha del vale la asigna el backend (día de la solicitud) y el turno
    // de caja lo toma del turno abierto; el frontend no los envía.
    const result = (await requestVoucherAction({
      idempotency_key: voucherKey,
      employee_id: voucherEmployee,
      amount,
      method_code: voucherMethod,
      observation: voucherNote || undefined,
    })) as ActionResult<VoucherRequestResult>;
    setBusy(false);
    // V1: la confirmación cumplió su papel en cuanto el intento obtuvo
    // respuesta: el éxito o el fallo se muestran donde siempre (toast y Alert
    // del alta, que queda al descubierto). No se reabre ni se reintenta sola.
    setOutOfRangeConfirmOpen(false);
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
      closeCreateDialog();
      await refreshVouchers();
    }
  }

  /**
   * Cierra el alta de vale. CL-5: es también el CANCELAR —los dos caminos pasan
   * por acá—, así que abandonar el intento suelta su marca: si el intento
   * anterior falló y se reabre el modal para otro vale, ese vale no puede quedar
   * pegado a la marca abandonada (el servidor devolvería el vale viejo).
   */
  function closeCreateDialog() {
    voucherKeyRef.current = null;
    setIsCreateOpen(false);
  }

  async function handleApprove(id: string) {
    setBusy(true);
    const result = (await approveVoucherAction(id, {
      observation: reviewNote || undefined,
    })) as ActionResult<VoucherRequestRow>;
    setBusy(false);
    if (show(result, "Vale aprobado. Su alerta quedó resuelta.")) {
      setReviewNote("");
      await refreshVouchers();
    }
  }

  async function handleReject(id: string) {
    if (!rejectReason.trim()) {
      setError("El motivo del rechazo es requerido.");
      return;
    }
    setBusy(true);
    const result = (await rejectVoucherAction(id, {
      motivo: rejectReason,
    })) as ActionResult<VoucherRequestRow>;
    setBusy(false);
    if (show(result, "Vale rechazado. Su alerta quedó resuelta.")) {
      setRejectReason("");
      await refreshVouchers();
    }
  }

  function openReview(id: string, action: "approve" | "reject") {
    setError(null);
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

  // Filtrado en cliente: estado exacto, empleado por nombre/ID interno y rango
  // de fechas de solicitud (request_date es ISO yyyy-mm-dd, comparable como texto).
  const filteredVouchers = vouchers.filter((row) => {
    if (statusFilter !== "" && row.status !== statusFilter) return false;
    if (dateFrom !== "" && row.request_date < dateFrom) return false;
    if (dateTo !== "" && row.request_date > dateTo) return false;
    const query = employeeFilter.trim().toLowerCase();
    if (query !== "" && !employeeName(row.employee_id).toLowerCase().includes(query)) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-6">
      {error && (
        // Fallo de acción o validación incompleta = ESTADO: sigue siendo el
        // caso mientras no se corrija, así que va inline y persistente arriba
        // del listado. `destructive` deriva role="alert" (asertivo), el mismo
        // rol que la rama de error escribía a mano.
        <Alert variant="destructive">{error}</Alert>
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
                setError(null);
                setIsCreateOpen(true);
              }}
              className={`${buttonClass} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              Solicitar vale
            </button>
          )}
        </div>
        {!configured && (
          // ESTADO que bloquea la acción primaria: sin topes no se puede
          // solicitar. Persistente y deliberadamente `warning` — no es un
          // fallo sino una precondición pendiente, y conserva el par de
          // tokens que el marcado ya usaba (bg-warning-light + text-warning).
          <Alert variant="warning" className="mt-3">
            Los vales no están configurados: un administrador debe definir topes y días permitidos antes de solicitar.
          </Alert>
        )}
        {props.canIssue && configured && shiftBlockReason !== null && (
          // Mismo caso que el anterior: sin caja abierta (o con la caja de
          // otro) la solicitud está bloqueada hasta que se resuelva.
          <Alert variant="warning" className="mt-3">
            {shiftBlockReason}
          </Alert>
        )}
        {props.canIssue && (
          <>
          <Dialog
            open={isCreateOpen}
            onOpenChange={(open) => {
              if (!open) closeCreateDialog();
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
                  // ESTADO dentro del formulario: sin métodos arqueables no hay
                  // método que elegir, así que no se puede enviar la solicitud.
                  // `destructive` porque es un error de configuración, no un
                  // aviso, y es el par de tokens que ya usaba (text-error).
                  <Alert variant="destructive">
                    No hay métodos de pago arqueables activos: configúrelos antes de solicitar vales.
                  </Alert>
                )}
                <label className={labelClass}>
                  Observación (opcional)
                  <input value={voucherNote} onChange={(event) => setVoucherNote(event.target.value)} className={inputClass} />
                </label>
                {voucherReviewNotice && (
                  // V1: aviso DERIVADO EN VIVO mientras se escribe (no el
                  // desenlace de una acción enviada): presentación `Alert`
                  // con `role="status"` explícito (polite). `warning`
                  // derivaría `alert` (asertivo), e interrumpir un cálculo en
                  // curso es el sobreanuncio que el estándar prohíbe (§1).
                  // Solo existe cuando hay algo que decir: con el aviso en
                  // `null` no se renderiza nada.
                  <Alert variant="warning" role="status">
                    {voucherReviewNotice}
                  </Alert>
                )}
                <DialogFooter>
                  <button type="button" className={ghostClass} onClick={closeCreateDialog}>
                    Cancelar
                  </button>
                  <button type="submit" disabled={busy} className={buttonClass}>
                    {busy ? "Solicitando…" : "Solicitar vale"}
                  </button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {/* V1: fuera de rango no nace directo: confirma que nacerá PENDIENTE
              en revisión del admin. En rango este diálogo nunca se abre y el
              envío sigue directo, como antes. */}
          <ConfirmDialog
            open={outOfRangeConfirmOpen}
            onOpenChange={(open) => {
              if (!open) setOutOfRangeConfirmOpen(false);
            }}
            title="Solicitar vale fuera de rango"
            description={voucherReviewNotice}
            confirmLabel="Solicitar igual"
            busyLabel="Solicitando…"
            variant="default"
            busy={busy}
            onConfirm={() => {
              // El aviso solo existe con monto válido, pero la carga útil
              // nunca se inventa: sin monto no se envía nada.
              const amount = toNumber(voucherAmount);
              if (amount === null) return;
              void submitVoucherRequest(amount);
            }}
          />
          </>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Estado
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="">Todos</option>
              <option value="pendiente">Pendiente</option>
              <option value="aprobada">Aprobada</option>
              <option value="rechazada">Rechazada</option>
              <option value="descontada">Descontada</option>
            </select>
          </label>
          <label className={labelClass}>
            Empleado
            <input
              value={employeeFilter}
              onChange={(event) => setEmployeeFilter(event.target.value)}
              placeholder="Nombre o ID interno"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Desde
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Hasta
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        {vouchers.length === 0 ? (
          // VACÍO: el estado base de la lista.
          <p className="mt-4 text-sm text-text-tertiary">Sin vales todavía.</p>
        ) : filteredVouchers.length === 0 ? (
          // VACÍO con filtros puestos: mismo caso que arriba.
          <p className="mt-4 text-sm text-text-tertiary">Sin vales para estos filtros.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className={cn("w-full text-left text-sm", "min-w-[760px]")}>
              <thead>
                <tr className={tableHeaderClass}>
                  <th className={tableCellClass} scope="col">
                    Empleado
                  </th>
                  <th className={tableCellClass} scope="col">
                    Monto
                  </th>
                  <th className={tableCellClass} scope="col">
                    Fecha
                  </th>
                  <th className={tableCellClass} scope="col">
                    Estado
                  </th>
                  <th className={tableCellClass} scope="col">
                    Método
                  </th>
                  <th className={tableCellClass} scope="col">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredVouchers.map((row) => (
                  <tr key={row.id} className={tableRowClass}>
                    <td className={cn(tableCellClass, "font-medium")}>{employeeName(row.employee_id)}</td>
                    <td className={tableCellClass}>{formatMoney(row.amount)}</td>
                    <td className={tableCellClass}>{row.request_date}</td>
                    <td className={tableCellClass}>
                      <span className="rounded bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">
                        {row.status}
                        {row.status === "descontada" ? " (en nómina: sin cambios)" : ""}
                      </span>
                    </td>
                    <td className={tableCellClass}>{methodLabel(row.method_code)}</td>
                    <td className={tableCellClass}>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setError(null);
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
                <DetailField label="Monto">{formatMoney(detailTarget.amount)}</DetailField>
                <DetailField label="Fecha de solicitud">{detailTarget.request_date}</DetailField>
                <DetailField label="Estado">
                  {detailTarget.status}
                  {detailTarget.status === "descontada" ? " (en nómina: sin cambios)" : ""}
                </DetailField>
                <DetailField label="Método de pago">{methodLabel(detailTarget.method_code)}</DetailField>
                <DetailField label="Creado por">{detailTarget.created_by_name ?? "—"}</DetailField>
                {detailTarget.approved_by_name ? (
                  <DetailField label="Aprobado por">{detailTarget.approved_by_name}</DetailField>
                ) : null}
                <DetailField label="Observación">{detailTarget.observation ?? "-"}</DetailField>
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
                  // ESTADO del modal: el motivo falta mientras el campo siga
                  // vacío, así que no es un aviso efímero.
                  <Alert variant="destructive">{reviewError}</Alert>
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
