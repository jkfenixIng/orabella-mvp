"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  closeShiftAction,
  getDayViewAction,
  getHistoryAction,
  listDenominationsAction,
  openShiftAction,
} from "@/src/features/cash/actions";
import { listVouchersAction } from "@/src/features/payroll/actions";
import type { VoucherRequestRow } from "@/src/features/payroll/service";
import type {
  CashRegisterRow,
  CashShiftRow,
  DayShiftView,
  DayView,
  HistoryResult,
} from "@/src/features/cash/service";
import type { PaymentMethodRow } from "@/src/features/admin/service";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";
import { HISTORY_PAGE_SIZE } from "@/src/features/cash/schemas";
import { ArrowLeftRight, Banknote, Coins, CreditCard, Wallet, Zap } from "lucide-react";

const sectionClass = cn(
  "rounded-lg border border-border-color bg-surface p-4 shadow-sm",
  "dark:border-border-color-2",
);
const labelClass = cn("flex flex-col gap-1 text-sm text-text-primary");
const inputClass = cn(
  "rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm",
  "dark:border-border-color-2",
);
const buttonClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);
const ghostClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  "dark:border-border-color-2 dark:hover:bg-surface-hover",
);
const errorClass = cn("text-sm text-error", "dark:text-error");
const okClass = cn("text-sm text-success", "dark:text-success");

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

// Misma tabla para vista del día e historial: mismas columnas siempre.
function ShiftsTable({
  shifts,
  methodCols,
  isAdmin,
  emptyText,
}: {
  shifts: DayShiftView[];
  methodCols: PaymentMethodRow[];
  isAdmin: boolean;
  emptyText: string;
}) {
  const [justOpen, setJustOpen] = useState<Array<{
    accion: string;
    fecha: string;
    nota: string;
    revisor: string | null;
  }> | null>(null);
  return (
    <>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
              <tr className="text-left text-slate-600 dark:text-slate-300">
                <th className="whitespace-nowrap py-1 pr-3">Apertura</th>
                <th className="whitespace-nowrap py-1 pr-3">Estado</th>
                <th className="whitespace-nowrap py-1 pr-3">Abrió</th>
                <th className="whitespace-nowrap py-1 pr-3">Cerró</th>
                <th className="whitespace-nowrap py-1 pr-3">Base inicial</th>
              {isAdmin && (
                <>
                  <th className="whitespace-nowrap py-1 pr-3">Ventas</th>
                  <th className="whitespace-nowrap py-1 pr-3">Efectivo</th>
                  {methodCols.map((method) => (
                    <th key={method.id} className="whitespace-nowrap py-1 pr-3">
                      {method.name}
                    </th>
                  ))}
                </>
              )}
              <th className="whitespace-nowrap py-1 pr-3">Vales</th>
              <th className="whitespace-nowrap py-1 pr-3">Base final</th>
              {isAdmin && (
                <>
                  <th className="whitespace-nowrap py-1 pr-3">Diferencia</th>
                  <th className="whitespace-nowrap py-1 pr-3">Revisada</th>
                  <th className="whitespace-nowrap py-1 pr-3">Justificación</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {shifts.map((view) => {
              const isClosed = view.shift.status === "cerrado";
              return (
                <tr key={view.shift.id} className="border-t border-slate-200 dark:border-slate-700">
                  <td className="whitespace-nowrap py-1 pr-3">{formatDateTime(view.shift.opened_at)}</td>
                  <td className="whitespace-nowrap py-1 pr-3">{view.shift.status}</td>
                  <td
                    className="max-w-48 truncate whitespace-nowrap py-1 pr-3"
                    title={view.abierto_por ?? undefined}
                  >
                    {view.abierto_por ?? "—"}
                  </td>
                  <td
                    className="max-w-48 truncate whitespace-nowrap py-1 pr-3"
                    title={view.cerrado_por ?? undefined}
                  >
                    {view.cerrado_por ?? "—"}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3">{formatMoney(view.shift.opening_base)}</td>
                  {isAdmin && (
                    <>
                      <td className="whitespace-nowrap py-1 pr-3">{formatMoney(view.ventas)}</td>
                      <td className="whitespace-nowrap py-1 pr-3">{formatMoney(view.efectivo)}</td>
                      {methodCols.map((method) => {
                        const cobrado = view.metodos.find(
                          (m) => m.method_code === method.code,
                        )?.amount ?? 0;
                        return (
                          <td key={method.id} className="whitespace-nowrap py-1 pr-3">
                            {formatMoney(cobrado)}
                          </td>
                        );
                      })}
                    </>
                  )}
                  <td className="whitespace-nowrap py-1 pr-3">{formatMoney(view.vales)}</td>
                  <td className="whitespace-nowrap py-1 pr-3">
                    {isClosed ? formatMoney(view.shift.base_left) : "—"}
                  </td>
                  {isAdmin && (
                    <>
                      <td className="whitespace-nowrap py-1 pr-3">
                        {!isClosed ? "—" : view.revision ? "Sí" : "No"}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-3">
                        {!view.revision ? "N/A" : view.revision.revisada ? "Sí" : "No"}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-3">
                        {!view.revision ? (
                          "N/A"
                        ) : view.revision.notas.length > 0 ? (
                          <button
                            type="button"
                            className="underline"
                            onClick={() => setJustOpen(view.revision?.notas ?? null)}
                          >
                            Ver
                          </button>
                        ) : (
                          ""
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {shifts.length === 0 && (
              <tr>
              <td
                colSpan={7 + (isAdmin ? 5 + methodCols.length : 0)}
                  className="py-2 text-slate-600 dark:text-slate-300"
                >
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {justOpen && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setJustOpen(null);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Justificación de la revisión</DialogTitle>
            </DialogHeader>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {(justOpen ?? []).map((item, index) => (
                <li key={index}>
                  {item.accion} · {formatDateTime(item.fecha)} — «{item.nota}»
                  {item.revisor && (
                    <span className="block text-slate-600 dark:text-slate-300">
                      Revisada por {item.revisor}.
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <button type="button" className={ghostClass} onClick={() => setJustOpen(null)}>
                Cerrar
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
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

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Brand badge as inline SVG (no external assets): rounded square in the
// brand color with its initial. Stylized visual aid, not the official logo.
function BrandBadge({ initial, fill }: { initial: string; fill: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill={fill} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="12"
        fontWeight="800"
        fill="#ffffff"
        fontFamily="Arial, sans-serif"
      >
        {initial}
      </text>
    </svg>
  );
}

const payIconClass = "h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400";

// Visual aid for cash counts: denomination kind or payment method code
// mapped to a recognizable icon. Unknown codes fall back to a wallet.
function PayIcon({ code, kind }: { code?: string; kind?: string }) {
  if (kind === "moneda") return <Coins className={payIconClass} aria-hidden="true" />;
  if (kind === "billete") return <Banknote className={payIconClass} aria-hidden="true" />;
  switch (code) {
    case "efectivo":
      return <Banknote className={payIconClass} aria-hidden="true" />;
    case "nequi":
      return <BrandBadge initial="N" fill="#6b21a8" />;
    case "daviplata":
      return <BrandBadge initial="D" fill="#d9261c" />;
    case "tarjeta":
      return <CreditCard className={payIconClass} aria-hidden="true" />;
    case "bre-b":
      return <Zap className={payIconClass} aria-hidden="true" />;
    case "transferencia_normal":
      return <ArrowLeftRight className={payIconClass} aria-hidden="true" />;
    default:
      return <Wallet className={payIconClass} aria-hidden="true" />;
  }
}

interface CashClientProps {
  sedeId: string;
  today: string;
  currentUserId: string;
  initialRegisters: CashRegisterRow[];
  initialOpenShift: CashShiftRow | null;
  initialOpenerName: string | null;
  initialDay: DayView;
  initialHistory: HistoryResult;
  methods: PaymentMethodRow[];
  canWrite: boolean;
  isAdmin: boolean;
}

export function CashClient(props: CashClientProps) {
  const [registers] = useState<CashRegisterRow[]>(props.initialRegisters);
  const [openShift, setOpenShift] = useState<CashShiftRow | null>(props.initialOpenShift);
  const [day, setDay] = useState<DayView>(props.initialDay);
  const [history, setHistory] = useState<HistoryResult>(props.initialHistory);
  const [histDesde, setHistDesde] = useState(props.initialHistory.desde);
  const [histHasta, setHistHasta] = useState(props.initialHistory.hasta);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isOpeningDialogOpen, setIsOpeningDialogOpen] = useState(false);
  const [isClosingDialogOpen, setIsClosingDialogOpen] = useState(false);
  const [denominations, setDenominations] = useState<Array<{ id: string; kind: string; value: number }>>([]);
  const [openCounts, setOpenCounts] = useState<Record<string, string>>({});
  const [openDigitals, setOpenDigitals] = useState<Record<string, string>>({});
  const [closeCounts, setCloseCounts] = useState<Record<string, string>>({});
  const [closeDigitals, setCloseDigitals] = useState<Record<string, string>>({});
  const [closeStep, setCloseStep] = useState<"counts" | "confirm">("counts");
  // La vista del día no se carga al entrar (abrir/cerrar no la necesita):
  // solo se pide si el usuario la muestra.
  const [showDay, setShowDay] = useState(false);
  // Item 5: vales del día visibles en caja (se cargan con la vista del día).
  const [dayVouchers, setDayVouchers] = useState<VoucherRequestRow[]>([]);
  const [histPage, setHistPage] = useState(1);
  // Paginador local de la vista del día (el servidor la acota a 50).
  const [dayPage, setDayPage] = useState(0);
  // Transición para los cambios de vista (día/historial): la UI no se
  // congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();

  const register = registers[0] ?? day.register;
  const baseConfigurada = Number(register?.base_configurada ?? 200000);
  // Solo quien abrió cierra; el admin es la válvula para no bloquear la caja.
  const isOpener = openShift !== null && openShift.opened_by === props.currentUserId;
  const canClose = props.canWrite && (isOpener || props.isAdmin);
  // Columnas dinámicas: una columna por método activo (desglose de
  // ventas cobrado real, aunque no sea arqueable).
  const methodCols = props.methods.filter(
    (method) => method.is_active && method.code !== "efectivo",
  );
  // Paginadores: el historial pagina en servidor (los rangos pueden
  // traer más de una página); el día pagina en cliente sobre lo cargado.
  const histPageCount = Math.max(1, Math.ceil(history.total / history.pageSize));
  const dayPageCount = Math.max(1, Math.ceil(day.shifts.length / HISTORY_PAGE_SIZE));
  const safeDayPage = Math.min(dayPage, dayPageCount - 1);
  const dayVisible = day.shifts.slice(
    safeDayPage * HISTORY_PAGE_SIZE,
    (safeDayPage + 1) * HISTORY_PAGE_SIZE,
  );

  function showResult<T>(result: ActionResult<T>, okMessage: string): result is { success: true; data: T } {
    if (!result.success) {
      setError(result.message);
      setNotice(null);
      return false;
    }
    setError(null);
    setNotice(okMessage);
    return true;
  }

  async function startOpening() {
    setOpenCounts({});
    setOpenDigitals({});
    setIsOpeningDialogOpen(true);
    const result = await listDenominationsAction();
    if (result.success) setDenominations(result.data);
  }

  function closeCashTotal(): number {
    return denominations.reduce((acc, denom) => {
      const qty = Number(closeCounts[denom.id] ?? "0");
      return acc + (Number.isFinite(qty) ? qty : 0) * Number(denom.value);
    }, 0);
  }

  async function startClosing() {
    setCloseCounts({});
    setCloseDigitals({});
    setCloseStep("counts");
    setIsClosingDialogOpen(true);
    const result = await listDenominationsAction();
    if (result.success) setDenominations(result.data);
  }

  // Inventory-style cancel: closing the dialog always resets its state,
  // so Esc/overlay/Cancel never leave stale counts or steps behind.
  function cancelOpening() {
    setOpenCounts({});
    setOpenDigitals({});
    setIsOpeningDialogOpen(false);
  }

  function cancelClosing() {
    setCloseCounts({});
    setCloseDigitals({});
    setCloseStep("counts");
    setIsClosingDialogOpen(false);
  }

  function buildCloseCounts(): Array<{ method_code: string; denomination: number | null; quantity: number; amount: number }> {
    return [
      ...denominations.map((denom) => {
        const qty = Math.max(0, Math.floor(Number(closeCounts[denom.id] ?? "0")) || 0);
        return { method_code: "efectivo", denomination: Number(denom.value), quantity: qty, amount: qty * Number(denom.value) };
      }),
      ...props.methods
        .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
        .map((method) => ({
          method_code: method.code,
          denomination: null,
          quantity: 1,
          amount: Number((closeDigitals[method.code] ?? "").replace(/\D/g, "")) || 0,
        })),
    ];
  }

  async function handleOpen(event: FormEvent): Promise<void> {
    event.preventDefault();
    const counts: Array<{ method_code: string; denomination: number | null; quantity: number; amount: number }> = [
      ...denominations.map((denom) => {
        const qty = Math.max(0, Math.floor(Number(openCounts[denom.id] ?? "0")) || 0);
        return { method_code: "efectivo", denomination: Number(denom.value), quantity: qty, amount: qty * Number(denom.value) };
      }),
      ...props.methods
        .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
        .map((method) => ({
          method_code: method.code,
          denomination: null,
          quantity: 1,
          amount: Number((openDigitals[method.code] ?? "").replace(/\D/g, "")) || 0,
        })),
    ];
    setBusy(true);
    try {
      const result = await openShiftAction({ counts });
      if (result.success) {
        const { shift, mismatches, firstOpen } = result.data;
        setOpenShift(shift);
        if (mismatches.length === 0) {
          showResult(result, `Turno abierto con base ${formatMoney(shift.opening_base)}.`);
        } else if (firstOpen) {
          showResult(result, "Turno abierto. Primera apertura: el conteo inicial quedó registrado.");
        } else {
          showResult(result, "Turno abierto con diferencias registradas.");
        }
        setIsOpeningDialogOpen(false);
        const dayResult = await getDayViewAction({ fecha: props.today, sede_id: props.sedeId });
        if (dayResult.success) setDay(dayResult.data);
      } else {
        showResult(result, "");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!openShift) return;
    if (closeStep === "counts") {
      setError(null);
      setCloseStep("confirm");
      return;
    }
    const counted = closeCashTotal();
    setBusy(true);
    try {
      const result = await closeShiftAction(openShift.id, {
        counted_cash: counted,
        counts: buildCloseCounts(),
        confirmed: true,
      });
      if (result.success) {
        const row = result.data.shift;
        const digitalDiff = result.data.methodDifferences;
        const baseDiff = Number(row.base_difference ?? 0);
        const envelope = Number(row.cash_withdrawn ?? 0);
        setOpenShift(null);
        setCloseCounts({});
        setCloseDigitals({});
        setCloseStep("counts");
        setIsClosingDialogOpen(false);
        // Hidden count: only admins see bases, differences and expected
        // values. Everyone else gets a neutral confirmation.
        if (!props.isAdmin) {
          showResult(result, "Turno cerrado.");
        } else if (digitalDiff.length === 0 && baseDiff >= 0) {
          showResult(result, `Turno cerrado. Base ${formatMoney(row.base_left)} · sobre ${formatMoney(envelope)}.`);
        } else {
          const parts = digitalDiff.map(
            (d) => `${d.method_code}: declarado ${formatMoney(d.declared)}, esperado ${formatMoney(d.expected)}`,
          );
          if (baseDiff < 0) parts.push(`base incompleta (faltante ${formatMoney(-baseDiff)})`);
          if (baseDiff > 0) parts.push(`sobrante en base ${formatMoney(baseDiff)}`);
          setError(null);
          setNotice(`Cierre con diferencias: ${parts.join(" · ")}. Sobre ${formatMoney(envelope)}. Se informó a los administradores.`);
        }
        const dayResult = await getDayViewAction({ fecha: props.today, sede_id: props.sedeId });
        if (dayResult.success) setDay(dayResult.data);
        const histResult = await getHistoryAction({
          desde: histDesde,
          hasta: histHasta,
          sede_id: props.sedeId,
          page: histPage,
        });
        if (histResult.success) setHistory(histResult.data);
      } else {
        if (result.code === "COUNT_MISMATCH") setCloseStep("counts");
        showResult(result, "");
      }
    } finally {
      setBusy(false);
    }
  }

  function loadDay(): void {
    startViewTransition(async () => {
      setBusy(true);
      try {
        const result = await getDayViewAction({ fecha: props.today, sede_id: props.sedeId });
        if (!showResult(result, "Vista del día actualizada.")) return;
        setDay(result.data);
        setDayPage(0);
        // Item 5: vales del día (no bloquean la vista si fallan).
        const vouchers = (await listVouchersAction({
          request_date: props.today,
          limit: 200,
          sede_id: props.sedeId,
        })) as ActionResult<VoucherRequestRow[]>;
        if (vouchers.success) setDayVouchers(vouchers.data);
      } finally {
        setBusy(false);
      }
    });
  }

  function handleHistory(event: FormEvent): void {
    event.preventDefault();
    fetchHistory(1);
  }

  // Historial paginado en servidor: cada página se pide con su número.
  function fetchHistory(page: number): void {
    startViewTransition(async () => {
      setBusy(true);
      try {
        const result = await getHistoryAction({
          desde: histDesde,
          hasta: histHasta,
          sede_id: props.sedeId,
          page,
        });
        if (!showResult(result, `Historial ${histDesde} … ${histHasta} actualizado.`)) return;
        setHistory(result.data);
        setHistPage(page);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={okClass}>
          {notice}
        </p>
      )}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">
          {openShift && props.initialOpenerName
            ? `Turno actual de ${props.initialOpenerName}`
            : "Turno actual"}
        </h2>
        {openShift ? (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <p>
              Turno abierto desde {formatDateTime(openShift.opened_at)} con base{" "}
              <strong>{formatMoney(openShift.opening_base)}</strong>.
            </p>
            {props.isAdmin && (
              <p className="text-slate-600 dark:text-slate-300">
                Base configurada: {formatMoney(baseConfigurada)}.
              </p>
            )}
            {canClose ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={startClosing} className={buttonClass}>
                  Cerrar turno
                </button>
              </div>
            ) : props.canWrite ? (
              <p className="mt-3 text-slate-600 dark:text-slate-300">
                Solo quien abrió el turno puede cerrarlo.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <p>No hay un turno abierto.</p>
            {props.canWrite ? (
              <div>
                <button type="button" onClick={startOpening} className={buttonClass}>
                  Abrir turno
                </button>
              </div>
            ) : (
              <p className="text-slate-600 dark:text-slate-300">
                Solo admin o caja pueden abrir turnos.
              </p>
            )}
          </div>
        )}
      </section>

      {props.canWrite && !openShift && (
        <Dialog
          open={isOpeningDialogOpen}
          onOpenChange={(open) => {
            if (!open) cancelOpening();
            else setIsOpeningDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Abrir turno</DialogTitle>
            </DialogHeader>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Cuente billetes y monedas por denominación y declare los totales digitales.
            </p>
            <form onSubmit={handleOpen} className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {denominations.map((denom) => (
                  <label key={denom.id} className={labelClass}>
                    <span className="inline-flex items-center gap-1.5">
                      <PayIcon kind={denom.kind} />
                      {denom.kind} {formatMoney(denom.value)}
                    </span>
                    <input
                      className={inputClass}
                      value={openCounts[denom.id] ?? ""}
                      onChange={(event) =>
                        setOpenCounts((prev) => ({ ...prev, [denom.id]: event.target.value.replace(/\D/g, "") }))
                      }
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </label>
                ))}
              </div>
              {props.methods
                .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
                .map((method) => (
                  <label key={method.id} className={labelClass}>
                    <span className="inline-flex items-center gap-1.5">
                      <PayIcon code={method.code} />
                      {method.name} (total en la aplicación)
                    </span>
                    <input
                      className={inputClass}
                      value={formatMoneyInput(openDigitals[method.code] ?? "")}
                      onChange={(event) =>
                        setOpenDigitals((prev) => ({ ...prev, [method.code]: stripMoneyInput(event.target.value) }))
                      }
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </label>
                ))}
              <DialogFooter>
                <button type="button" className={ghostClass} onClick={cancelOpening}>
                  Cancelar
                </button>
                <button type="submit" className={buttonClass} disabled={busy}>
                  Validar y abrir
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {props.canWrite && openShift && (
        <Dialog
          open={isClosingDialogOpen}
          onOpenChange={(open) => {
            if (!open) cancelClosing();
            else setIsClosingDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Cerrar turno</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleClose} className="mt-3 flex flex-col gap-3">
            {closeStep === "counts" ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {denominations.map((denom) => (
                    <label key={denom.id} className={labelClass}>
                      <span className="inline-flex items-center gap-1.5">
                        <PayIcon kind={denom.kind} />
                        {denom.kind} {formatMoney(denom.value)}
                      </span>
                      <input
                        className={inputClass}
                        value={closeCounts[denom.id] ?? ""}
                        onChange={(event) =>
                          setCloseCounts((prev) => ({ ...prev, [denom.id]: event.target.value.replace(/\D/g, "") }))
                        }
                        inputMode="numeric"
                        placeholder="0"
                      />
                    </label>
                  ))}
                </div>
                {props.methods
                  .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
                  .map((method) => (
                    <label key={method.id} className={labelClass}>
                      <span className="inline-flex items-center gap-1.5">
                        <PayIcon code={method.code} />
                        {method.name} (total en la aplicación)
                      </span>
                      <input
                        className={inputClass}
                        value={formatMoneyInput(closeDigitals[method.code] ?? "")}
                        onChange={(event) =>
                          setCloseDigitals((prev) => ({ ...prev, [method.code]: stripMoneyInput(event.target.value) }))
                        }
                        inputMode="numeric"
                        placeholder="0"
                      />
                    </label>
                  ))}
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="font-semibold">¿Está seguro de cerrar?</p>
                {props.isAdmin && !isOpener && <p>Cierra este turno como administrador.</p>}
                <p>Después del cierre ya no podrá modificarlo.</p>
              </div>
            )}
            <DialogFooter>
              {closeStep === "confirm" ? (
                <>
                  <button type="button" className={ghostClass} onClick={() => setCloseStep("counts")}>
                    Volver
                  </button>
                  <button type="button" className={ghostClass} onClick={cancelClosing}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button type="button" className={ghostClass} onClick={cancelClosing}>
                  Cancelar
                </button>
              )}
              <button type="submit" className={buttonClass} disabled={busy}>
                {closeStep === "counts" ? "Continuar" : "Sí, cerrar turno"}
              </button>
            </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      <section className={sectionClass} aria-busy={isViewPending}>
        <h2 className="text-lg font-semibold">Vista del día</h2>
        {!showDay ? (
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <div>
              <button
                type="button"
                className={ghostClass}
                disabled={busy || isViewPending}
                onClick={() => {
                  setShowDay(true);
                  loadDay();
                }}
              >
                {isViewPending ? "Cargando…" : "Mostrar vista del día"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3">
              <button
                type="button"
                className={ghostClass}
                disabled={busy || isViewPending}
                onClick={loadDay}
              >
                {isViewPending ? "Actualizando…" : "Actualizar"}
              </button>
            </div>
            <ShiftsTable
              shifts={dayVisible}
              methodCols={methodCols}
              isAdmin={props.isAdmin}
              emptyText="Sin turnos este día."
            />
          {dayPageCount > 1 && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <button
                type="button"
                className={ghostClass}
                disabled={safeDayPage === 0}
                onClick={() => setDayPage(safeDayPage - 1)}
              >
                Anterior
              </button>
              <span className="text-slate-600 dark:text-slate-300">
                Página {safeDayPage + 1} de {dayPageCount}
              </span>
              <button
                type="button"
                className={ghostClass}
                disabled={safeDayPage >= dayPageCount - 1}
                onClick={() => setDayPage(safeDayPage + 1)}
              >
                Siguiente
              </button>
            </div>
          )}
            {props.isAdmin ? (
              <p className="mt-3 text-sm">
                Acumulado ({day.totals.turnos} turnos): ventas {formatMoney(day.totals.ventas)} ·
                recogido {formatMoney(day.totals.recogido)} ·
                diferencias {formatMoney(day.totals.diferencias)}.
              </p>
            ) : null}
          </>
        )}
      </section>

      {showDay ? (
        <section className={sectionClass} aria-busy={isViewPending}>
          <h2 className="text-lg font-semibold">Vales del día</h2>
          {dayVouchers.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">Sin vales este día.</p>
          ) : (
            <>
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {dayVouchers.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {formatMoney(row.amount)} · {row.request_date}
                    </span>
                    <span className="rounded bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-800">
                      {row.status}
                      {row.status === "descontada" ? " (en nómina)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">
                Total en vales:{" "}
                {formatMoney(dayVouchers.reduce((acc, row) => acc + Number(row.amount), 0))} (
                {dayVouchers.length} vales).
              </p>
            </>
          )}
        </section>
      ) : null}

      {props.isAdmin ? (
      <section className={sectionClass} aria-busy={isViewPending}>
        <h2 className="text-lg font-semibold">Historial</h2>
        <form onSubmit={handleHistory} className="mt-3 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Desde
            <input
              type="date"
              className={inputClass}
              value={histDesde}
              onChange={(event) => setHistDesde(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Hasta
            <input
              type="date"
              className={inputClass}
              value={histHasta}
              onChange={(event) => setHistHasta(event.target.value)}
            />
          </label>
          <button type="submit" className={ghostClass} disabled={busy || isViewPending}>
            {isViewPending ? "Filtrando…" : "Filtrar"}
          </button>
        </form>
        <ShiftsTable
          shifts={history.shifts}
          methodCols={methodCols}
          isAdmin={props.isAdmin}
          emptyText="Sin turnos en el rango."
        />
        {histPageCount > 1 && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <button
              type="button"
              className={ghostClass}
              disabled={histPage <= 1 || isViewPending}
              onClick={() => fetchHistory(histPage - 1)}
            >
              Anterior
            </button>
            <span className="text-slate-600 dark:text-slate-300">
              Página {histPage} de {histPageCount} ({history.total} turnos)
            </span>
            <button
              type="button"
              className={ghostClass}
              disabled={histPage >= histPageCount || isViewPending}
              onClick={() => fetchHistory(histPage + 1)}
            >
              Siguiente
            </button>
          </div>
        )}
      </section>
      ) : null}
    </div>
  );
}
