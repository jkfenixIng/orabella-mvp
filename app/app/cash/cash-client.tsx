"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  closeShiftAction,
  getDayViewAction,
  getHistoryAction,
  listDenominationsAction,
  openShiftAction,
} from "@/src/features/cash/actions";
import type {
  CashRegisterRow,
  CashShiftRow,
  DayView,
  HistoryResult,
} from "@/src/features/cash/service";
import type { PaymentMethodRow } from "@/src/features/admin/service";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";

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

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

interface CashClientProps {
  sedeId: string;
  today: string;
  initialRegisters: CashRegisterRow[];
  initialOpenShift: CashShiftRow | null;
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
  const [dayFecha, setDayFecha] = useState(props.today);
  const [histDesde, setHistDesde] = useState(props.initialHistory.desde);
  const [histHasta, setHistHasta] = useState(props.initialHistory.hasta);

  const [baseLeft, setBaseLeft] = useState("");
  const [observation, setObservation] = useState("");

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
  // Transición para los cambios de vista (día/historial): la UI no se
  // congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();

  const register = registers[0] ?? day.register;
  const baseConfigurada = Number(register?.base_configurada ?? 200000);

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

  function openCashTotal(): number {
    return denominations.reduce((acc, denom) => {
      const qty = Number(openCounts[denom.id] ?? "0");
      return acc + (Number.isFinite(qty) ? qty : 0) * Number(denom.value);
    }, 0);
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
        showResult(result, `Turno abierto con base ${formatMoney(result.data.opening_base)}.`);
        setOpenShift(result.data);
        setIsOpeningDialogOpen(false);
        const dayResult = await getDayViewAction({ fecha: dayFecha, sede_id: props.sedeId });
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
    const base = toNumber(baseLeft);
    if (base === null || base < 0) {
      setError("La base dejada es obligatoria.");
      return;
    }
    if (base < baseConfigurada && observation.trim() === "") {
      setError(
        `La base quedó incompleta (${formatMoney(base)} de ${formatMoney(baseConfigurada)}): la observación es obligatoria.`,
      );
      return;
    }
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
        base_left: base,
        observation: observation.trim() || undefined,
        counts: buildCloseCounts(),
        confirmed: true,
      });
      if (result.success) {
        const row = result.data.shift;
        const digitalDiff = result.data.methodDifferences;
        const baseDiff = Number(row.base_difference ?? 0);
        const envelope = Number(row.cash_withdrawn ?? 0);
        setOpenShift(null);
        setBaseLeft("");
        setObservation("");
        setCloseCounts({});
        setCloseDigitals({});
        setCloseStep("counts");
        setIsClosingDialogOpen(false);
        if (digitalDiff.length === 0 && baseDiff >= 0) {
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
        const dayResult = await getDayViewAction({ fecha: dayFecha, sede_id: props.sedeId });
        if (dayResult.success) setDay(dayResult.data);
        const histResult = await getHistoryAction({
          desde: histDesde,
          hasta: histHasta,
          sede_id: props.sedeId,
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

  function handleDay(event: FormEvent): void {
    event.preventDefault();
    startViewTransition(async () => {
      setBusy(true);
      try {
        const result = await getDayViewAction({ fecha: dayFecha, sede_id: props.sedeId });
        if (!showResult(result, `Vista del día ${dayFecha} actualizada.`)) return;
        setDay(result.data);
      } finally {
        setBusy(false);
      }
    });
  }

  function handleHistory(event: FormEvent): void {
    event.preventDefault();
    startViewTransition(async () => {
      setBusy(true);
      try {
        const result = await getHistoryAction({
          desde: histDesde,
          hasta: histHasta,
          sede_id: props.sedeId,
        });
        if (!showResult(result, `Historial ${histDesde} … ${histHasta} actualizado.`)) return;
        setHistory(result.data);
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
        <h2 className="text-lg font-semibold">Turno actual</h2>
        {openShift ? (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <p>
              Turno abierto desde {formatDateTime(openShift.opened_at)} con base{" "}
              <strong>{formatMoney(openShift.opening_base)}</strong>.
            </p>
            <p className="text-slate-600 dark:text-slate-300">
              Base configurada: {formatMoney(baseConfigurada)}.
            </p>
            {props.canWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={startClosing} className={buttonClass}>
                  Cerrar turno
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <p>No hay un turno abierto.</p>
            {props.canWrite ? (
              <div>
                <p className="w-full text-slate-600 dark:text-slate-300">
                  Al abrir se valida el pre-arqueo contra el último cierre antes de iniciar.
                </p>
                <button type="button" onClick={startOpening} className={`${buttonClass} mt-3`}>
                  Abrir turno con pre-arqueo
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
        <Dialog open={isOpeningDialogOpen} onOpenChange={setIsOpeningDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Pre-arqueo de apertura</DialogTitle>
            </DialogHeader>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Cuente billetes y monedas por denominación y declare los totales digitales.
              El sistema valida contra el cierre anterior antes de abrir.
            </p>
            <form onSubmit={handleOpen} className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {denominations.map((denom) => (
                  <label key={denom.id} className={labelClass}>
                    {denom.kind} {formatMoney(denom.value)}
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
              <p className="text-sm font-semibold">Efectivo contado: {formatMoney(openCashTotal())}</p>
              {props.methods
                .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
                .map((method) => (
                  <label key={method.id} className={labelClass}>
                    {method.name} (total en la aplicación)
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
                <DialogClose asChild>
                  <button type="button" className={ghostClass}>
                    Cancelar
                  </button>
                </DialogClose>
                <button type="submit" className={buttonClass} disabled={busy}>
                  Validar y abrir
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {props.canWrite && openShift && (
        <Dialog open={isClosingDialogOpen} onOpenChange={setIsClosingDialogOpen}>
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
                      {denom.kind} {formatMoney(denom.value)}
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
                <p className="text-sm font-semibold">Efectivo contado: {formatMoney(closeCashTotal())}</p>
                {props.methods
                  .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
                  .map((method) => (
                    <label key={method.id} className={labelClass}>
                      {method.name} (total en la aplicación)
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
                <label className={labelClass}>
                  Base dejada (obligatoria)
                  <input
                    className={inputClass}
                    value={formatMoneyInput(baseLeft)}
                    onChange={(event) => setBaseLeft(stripMoneyInput(event.target.value))}
                    inputMode="numeric"
                    placeholder="200.000"
                  />
                </label>
                <label className={labelClass}>
                  Observación (obligatoria si la base queda incompleta)
                  <input
                    className={inputClass}
                    value={observation}
                    onChange={(event) => setObservation(event.target.value)}
                    placeholder="Faltante de 150000…"
                  />
                </label>
              </>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="font-semibold">¿Está seguro de cerrar?</p>
                <p>
                  Efectivo contado {formatMoney(closeCashTotal())} · base que queda{" "}
                  {formatMoney(toNumber(baseLeft) ?? 0)} · sobre {formatMoney(closeCashTotal() - (toNumber(baseLeft) ?? 0))}.
                </p>
                <p>Después del cierre ya no podrá modificarlo. Solo un administrador puede editarlo y queda registrado.</p>
              </div>
            )}
            <DialogFooter>
              {closeStep === "confirm" ? (
                <button type="button" className={ghostClass} onClick={() => setCloseStep("counts")}>
                  Volver
                </button>
              ) : (
                <DialogClose asChild>
                  <button type="button" className={ghostClass}>
                    Cancelar
                  </button>
                </DialogClose>
              )}
              <button type="submit" className={buttonClass} disabled={busy}>
                {closeStep === "counts" ? "Continuar" : "Sí, cerrar turno"}
              </button>
            </DialogFooter>
            </form>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Base configurada: {formatMoney(baseConfigurada)}. Recogido = contado − base;
              diferencia = base − configurada.
            </p>
          </DialogContent>
        </Dialog>
      )}

      <section className={sectionClass} aria-busy={isViewPending}>
        <h2 className="text-lg font-semibold">Vista del día</h2>
        <form onSubmit={handleDay} className="mt-3 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Fecha
            <input
              type="date"
              className={inputClass}
              value={dayFecha}
              onChange={(event) => setDayFecha(event.target.value)}
            />
          </label>
          <button type="submit" className={ghostClass} disabled={busy || isViewPending}>
            {isViewPending ? "Actualizando…" : "Ver día"}
          </button>
        </form>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-600 dark:text-slate-300">
                <th className="py-1 pr-3">Apertura</th>
                <th className="py-1 pr-3">Estado</th>
                <th className="py-1 pr-3">Base inicial</th>
                <th className="py-1 pr-3">Ventas</th>
                <th className="py-1 pr-3">Esperado</th>
                <th className="py-1 pr-3">Contado</th>
                <th className="py-1 pr-3">Base dejada</th>
                <th className="py-1 pr-3">Recogido</th>
                <th className="py-1 pr-3">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {day.shifts.map((view) => (
                <tr key={view.shift.id} className="border-t border-slate-200 dark:border-slate-700">
                  <td className="py-1 pr-3">{formatDateTime(view.shift.opened_at)}</td>
                  <td className="py-1 pr-3">{view.shift.status}</td>
                  <td className="py-1 pr-3">{formatMoney(view.shift.opening_base)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.ventas)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.efectivo)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.shift.counted_cash)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.shift.base_left)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.shift.cash_withdrawn)}</td>
                  <td className="py-1 pr-3">{formatMoney(view.shift.base_difference)}</td>
                </tr>
              ))}
              {day.shifts.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-2 text-slate-600 dark:text-slate-300">
                    Sin turnos este día.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm">
          Acumulado ({day.totals.turnos} turnos): ventas {formatMoney(day.totals.ventas)} ·
          esperado {formatMoney(day.totals.esperado)} · contado {formatMoney(day.totals.contado)} ·
          base dejada {formatMoney(day.totals.baseDejada)} · recogido {formatMoney(day.totals.recogido)} ·
          diferencias {formatMoney(day.totals.diferencias)}.
        </p>
      </section>

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
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {history.shifts.map((view) => (
            <li key={view.shift.id} className="border-t border-slate-200 pt-2 dark:border-slate-700">
              {formatDateTime(view.shift.opened_at)} · {view.shift.status} · base{" "}
              {formatMoney(view.shift.opening_base)} · ventas {formatMoney(view.ventas)}
              {view.shift.status === "cerrado" && (
                <>
                  {" "}· contado {formatMoney(view.shift.counted_cash)} · base dejada{" "}
                  {formatMoney(view.shift.base_left)} · recogido {formatMoney(view.shift.cash_withdrawn)} ·
                  diferencia {formatMoney(view.shift.base_difference)}
                  {view.shift.observation ? ` · «${view.shift.observation}»` : ""}
                </>
              )}
            </li>
          ))}
          {history.shifts.length === 0 && (
            <li className="text-slate-600 dark:text-slate-300">Sin turnos en el rango.</li>
          )}
        </ul>
      </section>
      ) : null}
    </div>
  );
}
