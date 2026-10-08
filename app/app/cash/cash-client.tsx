"use client";

import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import {
  closeShiftAction,
  getDayViewAction,
  getHistoryAction,
  listDenominationsAction,
  openShiftAction,
  recountClosedShiftAction,
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
import { Alert } from "@/src/components/ui/lib/alert";
import { Badge } from "@/src/components/ui/lib/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoney, formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { formatDateTime } from "@/src/shared/lib/format";
import { HISTORY_PAGE_SIZE } from "@/src/features/cash/schemas";
import {
  buttonClass,
  ghostClass,
  inputClass,
  labelClass,
  mutedTextClass,
  sectionClass,
  tableCellClass,
  tableHeaderClass,
  tableRowClass,
} from "@/src/shared/lib/ui-styles";
import { ArrowLeftRight, Banknote, Coins, CreditCard, Wallet, Zap } from "lucide-react";

// Celdas de la tabla de turnos: la base compartida más el no-wrap que
// necesitan las columnas estrechas (fechas, montos y estados).
const shiftCellClass = cn(tableCellClass, "whitespace-nowrap");

/* --------------------------------------------------------------------------
   R38 — la fila del turno, en el teléfono, NO es una tabla: es una tarjeta con
   pares etiqueta/valor. La forma es la de la lista de facturas (la referencia):
   abajo de `sm` cada valor lleva su propia etiqueta —la palabra del
   encabezado— y arriba de `sm` el encabezado es el que nombra.

   Por qué sigue siendo una `<table>` y no un `<ul>`: acá las columnas son
   DINÁMICAS (una por método de pago activo) y hay un piso de ancho declarado
   para el escritorio. Una grilla como la de facturas se escribe con
   `sm:col-start-N`, una columna por una; esa escala no se puede construir por
   código —Tailwind no compila una clase armada— y la grilla no sabe cuántas
   columnas hay. Lo que se replica es el contrato, no el vehículo.

   LO QUE SE APAGABA Y POR QUÉ: el `min-w-[1100px]` sin variante alcanzaba
   también al teléfono (medido: 1330 px de tabla dentro de un carril de 238, con
   `Recontar` entre 950 y 1100), y el `whitespace-nowrap` de `shiftCellClass`
   impedía que un nombre o un motivo bajaran de renglón. Los dos son de
   ESCRITORIO, y por eso llevan `sm:`.
   -------------------------------------------------------------------------- */

/** La etiqueta de cada valor en el teléfono: la palabra del encabezado, apagada arriba de `sm`. */
const campoLabelClass = cn("font-medium text-text-secondary", "sm:hidden");

/** Un valor de una línea completa (fechas, nombres, la acción). */
const campoClass = cn(
  shiftCellClass,
  "block w-full min-w-0 whitespace-normal px-0 py-1 sm:table-cell sm:w-auto sm:whitespace-nowrap sm:px-3 sm:py-2",
);

/** Dos valores en una línea: los cortos (estado, base, diferencia, revisada). */
const campoParClass = cn(
  shiftCellClass,
  "block w-1/2 min-w-0 whitespace-normal px-0 py-1 sm:table-cell sm:w-auto sm:whitespace-nowrap sm:px-3 sm:py-2",
);

/** Los nombres de persona: se leen enteros en el teléfono y se recortan arriba, como antes. */
const campoNombreClass = cn(
  shiftCellClass,
  "block w-full min-w-0 whitespace-normal px-0 py-1 sm:table-cell sm:w-auto sm:max-w-48 sm:truncate sm:px-3 sm:py-2",
);

/** La acción de la fila: su propia línea, a lo ancho, sin nada que la recorte. */
const accionesClass = cn(
  shiftCellClass,
  "flex w-full flex-wrap items-center gap-2 whitespace-normal px-0 py-1 sm:table-cell sm:w-auto sm:whitespace-nowrap sm:px-3 sm:py-2",
);

// Misma tabla para vista del día e historial: mismas columnas siempre.
function ShiftsTable({
  shifts,
  methodCols,
  isAdmin,
  emptyText,
  onRecount,
  onShowVersions,
}: {
  shifts: DayShiftView[];
  methodCols: PaymentMethodRow[];
  isAdmin: boolean;
  emptyText: string;
  /** U3: abre el reconteo de un cierre (solo llega desde la columna admin). */
  onRecount: (view: DayShiftView) => void;
  /** U3: muestra las dos versiones de un cierre ya recontado. */
  onShowVersions: (view: DayShiftView) => void;
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
        {/* Abajo de `sm` esto es una tarjeta por turno; arriba de `sm` es la tabla de
            siempre, con el mismo carril y el mismo piso. El piso lleva `sm:` porque a
            1100 px en un teléfono no es «una tabla más ancha»: es el carril entero. */}
        <table className={cn("w-full text-left text-sm", "sm:min-w-[1100px]", "block sm:table")}>
          {/* El encabezado nombra las columnas: abajo de `sm` no se ve, y por eso cada
              valor de la tarjeta lleva su propia etiqueta. */}
          <thead className="hidden sm:table-header-group">
              <tr className={tableHeaderClass}>
                <th className={shiftCellClass} scope="col">Apertura</th>
                <th className={shiftCellClass} scope="col">Estado</th>
                <th className={shiftCellClass} scope="col">Abrió</th>
                <th className={shiftCellClass} scope="col">Cerró</th>
                <th className={shiftCellClass} scope="col">Base inicial</th>
              {isAdmin && (
                <>
                  <th className={shiftCellClass} scope="col">Ventas</th>
                  <th className={shiftCellClass} scope="col">Efectivo</th>
                  {methodCols.map((method) => (
                    <th key={method.id} className={shiftCellClass} scope="col">
                      {method.name}
                    </th>
                  ))}
                </>
              )}
              <th className={shiftCellClass} scope="col">Vales</th>
              <th className={shiftCellClass} scope="col">Base final</th>
              {isAdmin && (
                <>
                  <th className={shiftCellClass} scope="col">Diferencia</th>
                  <th className={shiftCellClass} scope="col">Revisada</th>
                  <th className={shiftCellClass} scope="col">Justificación</th>
                  {/* U3: el cierre firmado es inmutable; desde acá se abre el
                      reconteo y se ve que un turno fue corregido. */}
                  <th className={shiftCellClass} scope="col">Reconteo</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {shifts.map((view) => {
              const isClosed = view.shift.status === "cerrado";
              return (
                <tr
                  key={view.shift.id}
                  className={cn(
                    tableRowClass,
                    "flex flex-wrap items-baseline px-3 py-2 sm:table-row sm:px-0 sm:py-0",
                  )}
                >
                {/* EL ORDEN DEL MARCADO ES EL DEL ENCABEZADO, y no es una casualidad:
                    arriba de `sm` cada celda es `sm:table-cell` y una tabla
                    coloca por ÍNDICE DE DOM, no por nombre —el `<th>` es un rótulo
                    pintado, no una llave—. Por eso no hay `order-*` ni
                    `col-start-*`: el orden de lectura del teléfono es el mismo
                    orden de columnas (Apertura · Estado · Abrió · Cerró · Base
                    inicial · Ventas · Efectivo · método · Vales · Base final ·
                    Diferencia), que se lee bien y deja de haber dos órdenes que
                    mantener en paz. Abajo de `sm` las celdas son `block` y la fila
                    `flex flex-wrap`: el orden de la fila es el orden de marcado,
                    así que la tarjeta y la tabla dicen exactamente lo mismo. */}
                <td className={cn(campoClass)}>
                  <span className={campoLabelClass}>Apertura: </span>
                  {formatDateTime(view.shift.opened_at)}
                </td>
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Estado: </span>
                  {view.shift.status}
                </td>
                <td className={cn(campoNombreClass)} title={view.abierto_por ?? undefined}>
                  <span className={campoLabelClass}>Abrió: </span>
                  {view.abierto_por ?? "—"}
                </td>
                <td className={cn(campoNombreClass)} title={view.cerrado_por ?? undefined}>
                  <span className={campoLabelClass}>Cerró: </span>
                  {view.cerrado_por ?? "—"}
                </td>
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Base inicial: </span>
                  {formatMoney(view.shift.opening_base)}
                </td>
                {/* Lo de abajo es de ADMIN en el escritorio, y lo es igual en la tarjeta:
                    un no-admin no ve estas celdas ni sus etiquetas en ninguna de las dos
                    superficies. Ampliarlo sería cambiar un permiso, no un diseño. */}
                {isAdmin && (
                    <>
                      <td className={cn(campoParClass)}>
                        <span className={campoLabelClass}>Ventas: </span>
                        {formatMoney(view.ventas)}
                      </td>
                      <td className={cn(campoParClass)}>
                        <span className={campoLabelClass}>Efectivo: </span>
                        {formatMoney(view.efectivo)}
                      </td>
                      {methodCols.map((method) => {
                        const cobrado = view.metodos.find(
                          (m) => m.method_code === method.code,
                        )?.amount ?? 0;
                        return (
                          <td key={method.id} className={cn(campoParClass)}>
                            <span className={campoLabelClass}>{method.name}: </span>
                            {formatMoney(cobrado)}
                          </td>
                        );
                      })}
                    </>
                  )}
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Vales: </span>
                  {formatMoney(view.vales)}
                </td>
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Base final: </span>
                  {isClosed ? formatMoney(view.vigente.base_left) : "—"}
                </td>
                {isAdmin && (
                    <>
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Diferencia: </span>
                  {!isClosed ? "—" : view.revision ? "Sí" : "No"}
                </td>
                <td className={cn(campoParClass)}>
                  <span className={campoLabelClass}>Revisada: </span>
                  {!view.revision ? "N/A" : view.revision.revisada ? "Sí" : "No"}
                </td>
                <td className={cn(campoClass)}>
                  <span className={campoLabelClass}>Justificación: </span>
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
                {/* La acción, en su línea y sin gesto horizontal: antes vivía en la
                    última columna de una tabla de 1330 px dentro de un carril de 238. */}
                <td className={cn(accionesClass)}>
                  <span className={campoLabelClass}>Reconteo: </span>
                  {!isClosed ? (
                    "—"
                  ) : view.recount ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-medium text-warning">Recontado</span>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => onShowVersions(view)}
                      >
                        Versiones
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="underline" onClick={() => onRecount(view)}>
                      Recontar
                    </button>
                  )}
                </td>
                    </>
                  )}
                </tr>
              );
            })}
            {shifts.length === 0 && (
              <tr
                className={cn(
                  tableRowClass,
                  "flex flex-wrap items-baseline px-3 py-2 sm:table-row sm:px-0 sm:py-0",
                )}
              >
              <td
                colSpan={7 + (isAdmin ? 6 + methodCols.length : 0)}
                  className={cn(
                    campoClass,
                    "text-text-secondary",
                  )}
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
                    <span className={cn("block", mutedTextClass)}>
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

const payIconClass = "h-5 w-5 shrink-0 text-text-tertiary";

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
  // U3: reconteo de un cierre. El cierre firmado no se edita: se abre un
  // conteo completo nuevo con su motivo y quedan las dos versiones.
  const [recountTarget, setRecountTarget] = useState<DayShiftView | null>(null);
  const [recountCounts, setRecountCounts] = useState<Record<string, string>>({});
  const [recountDigitals, setRecountDigitals] = useState<Record<string, string>>({});
  const [recountReason, setRecountReason] = useState("");
  const [recountStep, setRecountStep] = useState<"counts" | "confirm">("counts");
  const [versionsTarget, setVersionsTarget] = useState<DayShiftView | null>(null);
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
      // El fallo de una acción es ESTADO: deja el mensaje en la vista,
      // persistente mientras el problema exista.
      setError(result.message);
      return false;
    }
    setError(null);
    if (okMessage) {
      // El éxito de una acción es EVENTO: acaba de pasar y no tiene que
      // quedarse en pantalla compitiendo con lo que sí importa. Antes era un
      // <p role="status"> que persistía hasta la siguiente acción. El texto es
      // el mismo.
      toast.success(okMessage);
    }
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

  // U3: mismo cierre del bloque anterior pero sobre el estado del reconteo. El
  // reconteo reutiliza la forma del cierre (conteo completo por denominación +
  // totales digitales) para no inventar un camino paralelo.
  function recountCashTotal(): number {
    return denominations.reduce((acc, denom) => {
      const qty = Number(recountCounts[denom.id] ?? "0");
      return acc + (Number.isFinite(qty) ? qty : 0) * Number(denom.value);
    }, 0);
  }

  function buildRecountCounts(): Array<{ method_code: string; denomination: number | null; quantity: number; amount: number }> {
    return [
      ...denominations.map((denom) => {
        const qty = Math.max(0, Math.floor(Number(recountCounts[denom.id] ?? "0")) || 0);
        return { method_code: "efectivo", denomination: Number(denom.value), quantity: qty, amount: qty * Number(denom.value) };
      }),
      ...props.methods
        .filter((method) => method.is_active && method.arqueable && method.code !== "efectivo")
        .map((method) => ({
          method_code: method.code,
          denomination: null,
          quantity: 1,
          amount: Number((recountDigitals[method.code] ?? "").replace(/\D/g, "")) || 0,
        })),
    ];
  }

  async function startRecount(view: DayShiftView): Promise<void> {
    setRecountTarget(view);
    setRecountCounts({});
    setRecountDigitals({});
    setRecountReason("");
    setRecountStep("counts");
    const result = await listDenominationsAction();
    if (result.success) setDenominations(result.data);
  }

  function cancelRecount(): void {
    setRecountTarget(null);
    setRecountCounts({});
    setRecountDigitals({});
    setRecountReason("");
    setRecountStep("counts");
  }

  async function handleRecount(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!recountTarget) return;
    if (recountStep === "counts") {
      setError(null);
      setRecountStep("confirm");
      return;
    }
    const counted = recountCashTotal();
    setBusy(true);
    try {
      const result = await recountClosedShiftAction(recountTarget.shift.id, {
        counted_cash: counted,
        counts: buildRecountCounts(),
        reason: recountReason,
      });
      // La copia de éxito no necesita la data (con `result.data.recount` el
      // argumento se evalúa antes de que el guard la estreche).
      if (!showResult(result, "Turno recontado. El cierre firmado queda intacto.")) {
        // Conteo que no cuadra: volver al detalle para corregirlo, igual que
        // hace el cierre.
        if (result.code === "COUNT_MISMATCH") setRecountStep("counts");
        return;
      }
      cancelRecount();
      const dayResult = await getDayViewAction({ fecha: props.today });
      if (dayResult.success) setDay(dayResult.data);
      const histResult = await getHistoryAction({
        desde: histDesde,
        hasta: histHasta,
        page: histPage,
      });
      if (histResult.success) setHistory(histResult.data);
    } finally {
      setBusy(false);
    }
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
        const dayResult = await getDayViewAction({ fecha: props.today });
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
          // El cierre con diferencias también es EVENTO —el turno ya se
          // cerró, solo que con salvedades—, así que sale por el mismo canal
          // efímero. `setError(null)` se queda: el cierre salió bien y el
          // fallo anterior (si lo había) ya no es el caso.
          setError(null);
          toast.success(
            `Cierre con diferencias: ${parts.join(" · ")}. Sobre ${formatMoney(envelope)}. Se informó a los administradores.`,
          );
        }
        const dayResult = await getDayViewAction({ fecha: props.today });
        if (dayResult.success) setDay(dayResult.data);
        const histResult = await getHistoryAction({
          desde: histDesde,
          hasta: histHasta,
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
        const result = await getDayViewAction({ fecha: props.today });
        if (!showResult(result, "Vista del día actualizada.")) return;
        setDay(result.data);
        setDayPage(0);
        // Item 5: vales del día (no bloquean la vista si fallan).
        const vouchers = (await listVouchersAction({
          request_date: props.today,
          limit: 200,
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
        // Fallo al abrir o cerrar el turno = ESTADO: sigue siendo el caso
        // mientras no se corrija, así que va inline y persistente arriba de las
        // secciones. `destructive` deriva role="alert" (asertivo), el mismo rol
        // que el `<p role="alert">` escribía a mano.
        <Alert variant="destructive">{error}</Alert>
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
              <p className={mutedTextClass}>
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
              <p className={cn("mt-3", mutedTextClass)}>
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
              <p className={mutedTextClass}>
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
            <p className={cn("mt-1", mutedTextClass)}>
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
              <div className="flex flex-col gap-2 rounded-md bg-warning-light px-3 py-2 text-sm font-medium text-warning">
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

      {/* U3: reconteo de un cierre. Primero el conteo COMPLETO (mismo detalle
          por denominación y totales digitales que el cierre); después el
          motivo, que es obligatorio. El cierre firmado no se edita. */}
      {props.isAdmin && recountTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) cancelRecount();
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Recontar turno cerrado</DialogTitle>
            </DialogHeader>
            <p className={cn("mt-1", mutedTextClass)}>
              El cierre firmado no se modifica. Cuente otra vez billetes y monedas por
              denominación y declare los totales digitales; el sistema guarda las dos versiones.
            </p>
            <form onSubmit={handleRecount} className="mt-3 flex flex-col gap-3">
              {recountStep === "counts" ? (
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
                          value={recountCounts[denom.id] ?? ""}
                          onChange={(event) =>
                            setRecountCounts((prev) => ({ ...prev, [denom.id]: event.target.value.replace(/\D/g, "") }))
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
                          value={formatMoneyInput(recountDigitals[method.code] ?? "")}
                          onChange={(event) =>
                            setRecountDigitals((prev) => ({ ...prev, [method.code]: stripMoneyInput(event.target.value) }))
                          }
                          inputMode="numeric"
                          placeholder="0"
                        />
                      </label>
                    ))}
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-2 rounded-md bg-warning-light px-3 py-2 text-sm font-medium text-warning">
                    <p className="font-semibold">¿Está seguro de recontar?</p>
                    <p>
                      Efectivo contado ahora: {formatMoney(recountCashTotal())}. Cierre original:{" "}
                      {formatMoney(recountTarget.shift.counted_cash)}.
                    </p>
                    <p>El cierre original queda firmado y las dos versiones quedan visibles.</p>
                  </div>
                  <label className={labelClass}>
                    Motivo del reconteo
                    <textarea
                      className={inputClass}
                      rows={3}
                      value={recountReason}
                      onChange={(event) => setRecountReason(event.target.value)}
                      placeholder="Explique por qué se recontá el cierre."
                    />
                  </label>
                </div>
              )}
              <DialogFooter>
                {recountStep === "confirm" ? (
                  <>
                    <button type="button" className={ghostClass} onClick={() => setRecountStep("counts")}>
                      Volver
                    </button>
                    <button type="button" className={ghostClass} onClick={cancelRecount}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button type="button" className={ghostClass} onClick={cancelRecount}>
                    Cancelar
                  </button>
                )}
                <button
                  type="submit"
                  className={buttonClass}
                  disabled={busy || (recountStep === "confirm" && recountReason.trim().length === 0)}
                >
                  {recountStep === "counts" ? "Continuar" : "Sí, recontar"}
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* U3: las dos versiones de un cierre recontado, con quién y por qué. */}
      {props.isAdmin && versionsTarget?.recount && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setVersionsTarget(null);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Versiones del cierre</DialogTitle>
            </DialogHeader>
            <div className="mt-2 flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <p className="font-semibold">Cierre original (firmado, intacto)</p>
                <p>
                  Contado {formatMoney(versionsTarget.recount.previous.counted_cash)} · base{" "}
                  {formatMoney(versionsTarget.recount.previous.base_left)} · sobre{" "}
                  {formatMoney(versionsTarget.recount.previous.cash_withdrawn)} · diferencia{" "}
                  {formatMoney(versionsTarget.recount.previous.base_difference)}.
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-warning">Reconteo (gobierna)</p>
                <p>
                  Contado {formatMoney(versionsTarget.recount.counted_cash)} · base{" "}
                  {formatMoney(versionsTarget.recount.base_left)} · sobre{" "}
                  {formatMoney(versionsTarget.recount.cash_withdrawn)} · diferencia{" "}
                  {formatMoney(versionsTarget.recount.base_difference)}.
                </p>
                <p className={mutedTextClass}>
                  Motivo: «{versionsTarget.recount.reason}». Recontado por{" "}
                  {versionsTarget.recount.recounted_by ?? "usuario desconocido"} el{" "}
                  {formatDateTime(versionsTarget.recount.recounted_at)}.
                </p>
              </div>
            </div>
            <DialogFooter>
              <button type="button" className={ghostClass} onClick={() => setVersionsTarget(null)}>
                Cerrar
              </button>
            </DialogFooter>
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
              onRecount={startRecount}
              onShowVersions={setVersionsTarget}
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
              <span className={mutedTextClass}>
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
            <p className={cn("mt-3", mutedTextClass)}>Sin vales este día.</p>
          ) : (
            <>
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {dayVouchers.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {formatMoney(row.amount)} · {row.request_date}
                    </span>
                    <Badge variant="secondary">
                      {row.status}
                      {row.status === "descontada" ? " (en nómina)" : ""}
                    </Badge>
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
          onRecount={startRecount}
          onShowVersions={setVersionsTarget}
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
            <span className={mutedTextClass}>
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
