"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import {
  annulInvoiceAction,
  createInvoiceAction,
  editEmittedInvoiceAction,
  editInvoiceAction,
  getInvoiceAction,
  listInvoicesAction,
  splitPaymentAction,
} from "@/src/features/billing/actions";
import { getOpenShiftAction } from "@/src/features/cash/actions";
import {
  getPendingCommissionsAction,
  payCommissionNowAction,
} from "@/src/features/commissions/actions";
import type {
  InvoiceDetail,
  InvoiceItemRow,
  InvoiceListItem,
} from "@/src/features/billing/service";
import type { ProductRow } from "@/src/features/inventory/service";
import type {
  EmployeeRow,
  PaymentMethodRow,
  ServiceRow,
  TaxConfigRow,
} from "@/src/features/admin/service";
import { Button } from "@/src/components/ui/lib/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/lib/card";
import {
  Dialog,
  DialogContent,
} from "@/src/components/ui/lib/dialog";
import { Input } from "@/src/components/ui/lib/input";
import { Label } from "@/src/components/ui/lib/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/lib/select";
import { Combobox } from "@/src/components/ui/lib/combobox";
import {
  Banknote,
  CircleX,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";

const inputClass = cn(
  "flex h-10 w-full rounded-lg border border-color bg-surface px-3 text-sm text-text-primary outline-none transition-colors duration-200 placeholder:text-text-tertiary focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border-color dark:bg-surface dark:text-text-primary",
);
const errorClass = cn("text-sm text-error dark:text-error-400");
const okClass = cn("text-sm text-success dark:text-success-400");

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

interface ItemDraft {
  item_type: "producto" | "servicio" | "custom";
  ref_id: string;
  custom_name: string;
  employee_id: string;
  qty: string;
  unit_price: string;
  no_commission: boolean;
  commission_value: number | null;
}

interface PortionDraft {
  method_code: string;
  amount: string;
}

/** Fila del modal de pago inmediato de comisión (un empleado por fila). */
interface CommissionPayRow {
  employee_id: string;
  employee_name: string;
  pending: number;
  method_code: string;
}

function emptyItem(): ItemDraft {
  return { item_type: "servicio", ref_id: "", custom_name: "", employee_id: "", qty: "1", unit_price: "", no_commission: true, commission_value: null };
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number | string | null | undefined): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (numeric == null || !Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

/**
 * Comisión a mostrar en el detalle de solo lectura. Prioriza el valor cargado
 * en el ítem (`commission_value`, el que el usuario ingresó); si no hay, cae al
 * monto calculado por nómina (`commission_amount`); sin ninguno, null (la
 * tabla pinta "—"). Nunca suma ni mezcla ambos campos.
 */
function commissionDisplayValue(
  row: Pick<InvoiceItemRow, "commission_value" | "commission_amount">,
): number | null {
  if (row.commission_value != null) return row.commission_value;
  return row.commission_amount ?? null;
}

/** Pastilla de estado: Emitida azul, Pagada verde, Anulada roja (ambos temas). */
function statusPill(status: string) {
  const tone =
    status === "Pagada"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
      : status === "Anulada"
        ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200"
        : "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200";
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {status}
    </span>
  );
}

/** "Camilo, Andrés + 3 más": dos nombres y el resto resumido. */
function employeeSummary(names: string[]): string {
  if (names.length === 0) return "—";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

interface InvoicesClientProps {
  sedeId: string;
  initialInvoices: InvoiceListItem[];
  initialTotal: number;
  products: ProductRow[];
  services: ServiceRow[];
  employees: EmployeeRow[];
  methods: PaymentMethodRow[];
  taxes: TaxConfigRow[];
  canWrite: boolean;
  canAnnul: boolean;
  isAdmin: boolean;
  currentUserId: string;
  detailMode: "full" | "open-only" | "none";
}

/** Fecha local yyyy-mm-dd (F1: el listado abre solo con las del día). */
function todayLocalISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function InvoicesClient(props: InvoicesClientProps) {
  const [invoices, setInvoices] = useState<InvoiceListItem[]>(props.initialInvoices);
  const [totalInvoices, setTotalInvoices] = useState(props.initialTotal);
  const [invoicePage, setInvoicePage] = useState(1);
  // F1: Desde/Hasta = hoy por defecto; vaciarlas muestra todo el historial.
  const [filters, setFilters] = useState({ status: "", from: todayLocalISO(), to: todayLocalISO(), seller: "", number: "", closedBy: "", employee: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Transición para los cambios de vista (filtros/detalle): la UI no se
  // congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  // Vista cliente: oculta datos internos (empleado y comisión) para mostrar
  // la factura en pantalla sin exponer información de nómina. Arranca interna.
  const [clientView, setClientView] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  type EditItemDraft = ItemDraft & { id?: string; discount: number };
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editItems, setEditItems] = useState<EditItemDraft[]>([]);
  const [editPayments, setEditPayments] = useState<Array<{ id: string; method_code: string }>>([]);
  const [editMotivo, setEditMotivo] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientDocument, setClientDocument] = useState("");
  const [discount, setDiscount] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [isItemDialogOpen, setIsItemDialogOpen] = useState(false);
  const [itemDialogTarget, setItemDialogTarget] = useState<"create" | "edit">("create");
  const [itemDraft, setItemDraft] = useState<ItemDraft>(emptyItem());
  const [itemError, setItemError] = useState<string | null>(null);
  const [portions, setPortions] = useState<PortionDraft[]>([
    { method_code: "efectivo", amount: "" },
  ]);
  const [motivo, setMotivo] = useState("");
  // Modal clásico de confirmación ("¿Está seguro? ...", OK/Cancelar).
  const [confirmKind, setConfirmKind] = useState<"emit" | "pay" | "annul" | null>(null);
  const [splitDraft, setSplitDraft] = useState<PortionDraft>({ method_code: "efectivo", amount: "" });
  // Pago inmediato de comisión(es) al dejar la factura Pagada.
  const [commissionOpen, setCommissionOpen] = useState(false);
  const [commissionRows, setCommissionRows] = useState<CommissionPayRow[]>([]);
  const [commissionError, setCommissionError] = useState<string | null>(null);
  const [commissionBusy, setCommissionBusy] = useState(false);

  // G1: turno abierto conocido por el cliente. La validación de caja se hace
  // ANTES de entrar a emitir o editar (el servidor vuelve a validar).
  const [shiftKnown, setShiftKnown] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftOwn, setShiftOwn] = useState(true);
  const [shiftOwner, setShiftOwner] = useState<string | null>(null);
  // Base de apertura del turno (referencia del tope de efectivo del 50%).
  const [shiftOpeningBase, setShiftOpeningBase] = useState<number | null>(null);
  const [blockNotice, setBlockNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!props.canWrite && !props.canAnnul) return;
    let cancelled = false;
    (async () => {
      const result = await getOpenShiftAction();
      if (cancelled || !result.success) return;
      const shift = result.data;
      setShiftKnown(true);
      setShiftOpen(shift !== null);
      setShiftOwn(shift === null || shift.opened_by === props.currentUserId || props.isAdmin);
      setShiftOwner(shift?.opener_name?.trim() || null);
      setShiftOpeningBase(shift ? Number(shift.opening_base) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.canWrite, props.canAnnul, props.currentUserId, props.isAdmin, createDialogOpen, detailDialogOpen, isEditDialogOpen]);

  // G1: motivo de bloqueo de las acciones que exigen caja propia. El admin
  // queda exento (la válvula auditada del backend); "sin dato aún" no bloquea.
  const shiftBlockReason: string | null = !shiftKnown
    ? null
    : !shiftOpen
      ? "No hay caja abierta: abre tu turno para emitir o editar."
      : !shiftOwn
        ? shiftOwner
          ? `La caja abierta es del turno de ${shiftOwner}: solo ${shiftOwner} o un administrador puede emitir o editar.`
          : "La caja abierta es de otro turno: solo quien abrió el turno o un administrador puede emitir o editar."
        : null;

  /** G1: valida la caja antes de abrir una acción que la exige. */
  function passShiftGate(): boolean {
    if (shiftBlockReason === null) return true;
    setBlockNotice(shiftBlockReason);
    return false;
  }

  function applyFilters(event?: FormEvent, page = 1) {
    event?.preventDefault();
    startViewTransition(async () => {
      setError(null);
      const result: ActionResult<{ rows: InvoiceListItem[]; total: number }> = await listInvoicesAction({
        sede_id: props.sedeId,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        user_id: filters.seller || undefined,
        consecutive_number: filters.number ? parseInt(filters.number, 10) : undefined,
        closed_by: filters.closedBy || undefined,
        employee_id: filters.employee || undefined,
        page,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }
      setInvoices(result.data.rows);
      setTotalInvoices(result.data.total);
      setInvoicePage(page);
    });
  }

  // Debe coincidir con INVOICE_PAGE_SIZE del servicio (import por valor
  // arrastraría código de servidor al cliente).
  const INVOICE_CLIENT_PAGE_SIZE = 10;
  const invoicePageCount = Math.max(1, Math.ceil(totalInvoices / INVOICE_CLIENT_PAGE_SIZE));

  function patchDraft(patch: Partial<ItemDraft>) {
    setItemDraft((prev) => ({ ...prev, ...patch }));
  }

  function patchEditItem(index: number, patch: Partial<EditItemDraft>) {
    setEditItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /** Ajusta un ítem ya agregado al borrador de emisión (edición del listado). */
  function patchDraftItem(index: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /**
   * I1: al elegir el producto se sugieren precio de venta y comisión del
   * catálogo. La comisión del producto es un valor absoluto; si el cajero la
   * edita a mano en la línea, la línea manda.
   */
  function autofillDraftPrice(type: ItemDraft["item_type"], refId: string) {
    if (type === "producto") {
      const found = props.products.find((row) => row.id === refId);
      if (found?.sale_price != null) patchDraft({ unit_price: String(found.sale_price) });
      if (found && found.commission_value != null && found.commission_value > 0) {
        patchDraft({ commission_value: found.commission_value, no_commission: false });
      }
    }
    if (type === "servicio") {
      const found = props.services.find((row) => row.id === refId);
      if (found) patchDraft({ unit_price: String(found.price) });
    }
  }

  /**
   * Modal de ítems generalizado: sirve para crear ("create", agrega al
   * borrador) y para la edición libre de EMITIDAS ("edit", agrega a la
   * edición). Vive a nivel raíz para que ambos diálogos lo reutilicen.
   */
  function openItemDialog(target: "create" | "edit" = "create") {
    setItemDraft(emptyItem());
    setItemError(null);
    setItemDialogTarget(target);
    setIsItemDialogOpen(true);
  }

  function employeeNameOf(employeeId: string): string {
    const found = props.employees.find((row) => row.id === employeeId);
    if (!found) return "—";
    return found.employee_code ? `${found.full_name} (${found.employee_code})` : found.full_name;
  }

  function addItemFromDialog() {
    setItemError(null);
    if (itemDraft.item_type === "producto" && !itemDraft.ref_id) {
      setItemError("Elija el producto.");
      return;
    }
    if (itemDraft.item_type === "servicio" && !itemDraft.ref_id) {
      setItemError("Elija el servicio.");
      return;
    }
    if (itemDraft.item_type === "custom" && itemDraft.custom_name.trim() === "") {
      setItemError("Describa el ítem personalizado.");
      return;
    }
    if (!itemDraft.employee_id) {
      setItemError("Elija el empleado que atiende.");
      return;
    }
    const qty = toNumber(itemDraft.qty);
    const price = toNumber(itemDraft.unit_price);
    if (qty == null || !Number.isInteger(qty) || qty <= 0) {
      setItemError("Cantidad inválida.");
      return;
    }
    if (price == null || price < 0) {
      setItemError("Precio inválido.");
      return;
    }
    const draft: ItemDraft =
      itemDraft.item_type === "servicio"
        ? { ...itemDraft, no_commission: true, commission_value: null }
        : itemDraft.item_type === "custom" && itemDraft.no_commission
          ? { ...itemDraft, commission_value: null }
          : itemDraft;
    if (draft.item_type === "custom" && !draft.no_commission) {
      if (draft.commission_value == null || !(draft.commission_value >= 0)) {
        setItemError("Indique el valor de la comisión.");
        return;
      }
    }
    if (itemDialogTarget === "edit") {
      setEditItems((prev) => [...prev, { ...draft, discount: 0 }]);
    } else {
      setItems((prev) => [...prev, draft]);
    }
    setIsItemDialogOpen(false);
  }

  // Inventory-style cancel: closing the dialog always resets its draft.
  function cancelCreate() {
    setClientName("");
    setClientDocument("");
    setDiscount("");
    setItems([]);
    setPortions([{ method_code: "efectivo", amount: "" }]);
    setCreateDialogOpen(false);
  }

  function openDetail(id: string) {    startViewTransition(async () => {
      setError(null);
      const result: ActionResult<InvoiceDetail> = await getInvoiceAction(id);
      if (!result.success) {
        setError(result.message);
        return;
      }
      setDetail(result.data);
      setMotivo("");
      setClientView(false);
      setDetailDialogOpen(true);
    });
  }

  function closeDetail() {
    setDetail(null);
    setMotivo("");
    setSplitDraft({ method_code: "efectivo", amount: "" });
    setDetailDialogOpen(false);
  }

  function toEditDraft(row: {
    id: string;
    item_type: string;
    product_id: string | null;
    service_id: string | null;
    custom_name: string | null;
    employee_id: string;
    qty: number | string;
    unit_price: number | string;
    discount: number | string;
    no_commission: boolean | null;
    commission_value: number | string | null;
  }): EditItemDraft {
    return {
      id: row.id,
      item_type: row.item_type as ItemDraft["item_type"],
      ref_id: row.product_id ?? row.service_id ?? "",
      custom_name: row.custom_name ?? "",
      employee_id: row.employee_id,
      qty: String(row.qty),
      unit_price: String(row.unit_price),
      discount: Number(row.discount),
      no_commission: Boolean(row.no_commission),
      commission_value: row.commission_value == null ? null : Number(row.commission_value),
    };
  }

  async function openEdit(id: string) {
    // G1: no se entra a editar sin caja propia (el servidor vuelve a validar).
    if (!passShiftGate()) return;
    setBlockNotice(null);
    setError(null);
    setBusy(true);
    try {
      const result: ActionResult<InvoiceDetail> = await getInvoiceAction(id);
      if (!result.success) {
        setError(result.message);
        return;
      }
      const current = result.data;
      setDetail(current);
      setEditItems(current.items.map(toEditDraft));
      setEditPayments(current.payments.map((payment) => ({ id: payment.id, method_code: payment.method_code })));
      setEditMotivo("");
      setEditError(null);
      setClientView(false);
      setIsEditDialogOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!detail) return;
    setEditError(null);
    const parsedItems = [];
    for (const [index, item] of editItems.entries()) {
      const qty = toNumber(item.qty);
      const price = toNumber(item.unit_price);
      if (item.item_type === "producto" && !item.ref_id) {
        setEditError(`Ítem ${index + 1}: elija el producto.`);
        return;
      }
      if (item.item_type === "servicio" && !item.ref_id) {
        setEditError(`Ítem ${index + 1}: elija el servicio.`);
        return;
      }
      if (item.item_type === "custom" && item.custom_name.trim() === "") {
        setEditError(`Ítem ${index + 1}: describa el ítem.`);
        return;
      }
      if (!item.employee_id) {
        setEditError(`Ítem ${index + 1}: el empleado es requerido.`);
        return;
      }
      if (qty == null || !Number.isInteger(qty) || qty <= 0) {
        setEditError(`Ítem ${index + 1}: cantidad inválida.`);
        return;
      }
      if (price == null || price < 0) {
        setEditError(`Ítem ${index + 1}: precio inválido.`);
        return;
      }
      if (item.item_type === "custom" && !item.no_commission) {
        if (item.commission_value == null || !(item.commission_value >= 0)) {
          setEditError(`Ítem ${index + 1}: indique el valor de la comisión.`);
          return;
        }
      }
      parsedItems.push({
        ...(item.id ? { id: item.id } : {}),
        item_type: item.item_type,
        product_id: item.item_type === "producto" ? item.ref_id || null : null,
        service_id: item.item_type === "servicio" ? item.ref_id || null : null,
        custom_name: item.item_type === "custom" ? item.custom_name || null : null,
        employee_id: item.employee_id,
        qty,
        unit_price: price,
        discount: item.discount,
        no_commission: item.no_commission,
        // La comisión se persiste para producto y custom; servicio no lleva valor.
        commission_value: item.item_type !== "servicio" && !item.no_commission ? item.commission_value : null,
      });
    }
    setBusy(true);
    try {
      const free = detail.invoice.status === "Emitida";
      const result: ActionResult<InvoiceDetail> = free
        ? await editEmittedInvoiceAction(detail.invoice.id, {
            items: parsedItems,
            payments: detail.payments.map((payment) => ({
              id: payment.id,
              method_code: payment.method_code,
            })),
          })
        : await editInvoiceAction(detail.invoice.id, {
            motivo: editMotivo,
            items: parsedItems,
            payments: editPayments,
          });
      if (!result.success) {
        setEditError(`[${result.code}] ${result.message}`);
        return;
      }
      setDetail(result.data);
      setIsEditDialogOpen(false);
      setNotice(
        free
          ? `Factura #${result.data.invoice.consecutive_number} actualizada (nuevo total ${formatMoney(result.data.invoice.total)}).`
          : `Factura #${result.data.invoice.consecutive_number} actualizada (total intacto ${formatMoney(result.data.invoice.total)}).`,
      );
      await applyFilters(undefined, invoicePage);
    } finally {
      setBusy(false);
    }
  }

  async function submitInvoice(event: FormEvent) {
    event.preventDefault();
    if (buildCreatePayload() === null) return;
    // Validación local superada: pide confirmación clásica antes de emitir.
    setConfirmKind("emit");
  }

  async function confirmEmit() {
    const payload = buildCreatePayload();
    if (payload === null) {
      setConfirmKind(null);
      return;
    }
    setBusy(true);
    let result: ActionResult<InvoiceDetail>;
    try {
      result = await createInvoiceAction(payload);
    } finally {
      setBusy(false);
    }
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      setConfirmKind(null);
      return;
    }
    setNotice(`Factura #${result.data.invoice.consecutive_number} ${result.data.invoice.status.toLowerCase()}.`);
    setClientName("");
    setClientDocument("");
    setDiscount("");
    setItems([]);
    setPortions([{ method_code: "efectivo", amount: "" }]);
    setConfirmKind(null);
    setDetail(result.data);
    setCreateDialogOpen(false);
    setDetailDialogOpen(true);
    await applyFilters();
    await askCommissionPayment(result.data);
  }

  function buildCreatePayload(): {
    client_name: string;
    client_document: string | null;
    items: Array<{
      item_type: string;
      product_id: string | null;
      service_id: string | null;
      custom_name: string | null;
      employee_id: string;
      qty: number;
      unit_price: number;
      discount: number;
      no_commission: boolean;
      commission_value: number | null;
    }>;
    discount: number;
    payments: Array<{ method_code: string; amount: number }>;
  } | null {
    setError(null);
    setNotice(null);
    if (items.length === 0) {
      setError("Agregue al menos un ítem a la factura.");
      return null;
    }
    const parsedDiscount = discount.trim() === "" ? 0 : toNumber(discount);
    if (parsedDiscount == null) {
      setError("Descuento inválido.");
      return null;
    }
    const parsedItems = [];
    for (const [index, item] of items.entries()) {
      const qty = toNumber(item.qty);
      const price = toNumber(item.unit_price);
      if (!item.employee_id) {
        setError(`Ítem ${index + 1}: el empleado es requerido.`);
        return null;
      }
      if (qty == null || !Number.isInteger(qty) || qty <= 0) {
        setError(`Ítem ${index + 1}: cantidad inválida.`);
        return null;
      }
      if (price == null || price < 0) {
        setError(`Ítem ${index + 1}: precio inválido.`);
        return null;
      }
      if (item.item_type === "custom" && !item.no_commission) {
        if (item.commission_value == null || !(item.commission_value >= 0)) {
          setError(`Ítem ${index + 1}: indique el valor de la comisión.`);
          return null;
        }
      }
      parsedItems.push({
        item_type: item.item_type,
        product_id: item.item_type === "producto" ? item.ref_id || null : null,
        service_id: item.item_type === "servicio" ? item.ref_id || null : null,
        custom_name: item.item_type === "custom" ? item.custom_name || null : null,
        employee_id: item.employee_id,
        qty,
        unit_price: price,
        discount: 0,
        no_commission: item.no_commission,
        // La comisión se persiste para producto y custom; servicio no lleva valor.
        commission_value: item.item_type !== "servicio" && !item.no_commission ? item.commission_value : null,
      });
    }
    const parsedPortions = [];
    for (const portion of portions) {
      const amount = toNumber(portion.amount);
      if (amount == null) continue;
      if (amount <= 0) {
        setError("Las porciones de pago deben ser mayores a 0.");
        return null;
      }
      parsedPortions.push({ method_code: portion.method_code, amount });
    }
    return {
      client_name: clientName,
      client_document: clientDocument.trim() === "" ? null : clientDocument,
      items: parsedItems,
      discount: parsedDiscount,
      payments: parsedPortions,
    };
  }

  async function submitAnnul(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    if (motivo.trim() === "") {
      setError("Indique el motivo de anulación.");
      return;
    }
    // Motivo presente: pide confirmación clásica antes de anular.
    setConfirmKind("annul");
  }

  async function confirmAnnul() {
    if (!detail) {
      setConfirmKind(null);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    let result: ActionResult<InvoiceDetail>;
    try {
      result = await annulInvoiceAction(detail.invoice.id, {
        motivo,
      });
    } finally {
      setBusy(false);
    }
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      setConfirmKind(null);
      return;
    }
    setNotice(`Factura #${result.data.invoice.consecutive_number} anulada (stock revertido).`);
    setDetail(result.data);
    setConfirmKind(null);
    await applyFilters(undefined, invoicePage);
  }

  async function submitSplit(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    // G1: cobrar también exige caja propia (el servidor vuelve a validar).
    if (shiftBlockReason !== null) {
      setError(shiftBlockReason);
      return;
    }
    const amount = toNumber(splitDraft.amount);
    if (amount == null || amount <= 0) {
      setError("Monto de la porción inválido.");
      return;
    }
    // Monto válido: pide confirmación clásica antes de pagar.
    setConfirmKind("pay");
  }

  async function confirmPay() {
    if (!detail) {
      setConfirmKind(null);
      return;
    }
    const amount = toNumber(splitDraft.amount);
    if (amount == null || amount <= 0) {
      setError("Monto de la porción inválido.");
      setConfirmKind(null);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    let result: ActionResult<InvoiceDetail>;
    try {
      result = await splitPaymentAction(detail.invoice.id, {
        portions: [{ method_code: splitDraft.method_code, amount }],
      });
    } finally {
      setBusy(false);
    }
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      return;
    }
    setNotice(
      result.data.invoice.status === "Pagada"
        ? "Cobro completo: factura pagada."
        : `Porción registrada. Saldo: ${formatMoney(result.data.remaining)}.`,
    );
    setDetail(result.data);
    setSplitDraft({ method_code: "efectivo", amount: "" });
    setConfirmKind(null);
    await applyFilters(undefined, invoicePage);
    await askCommissionPayment(result.data);
  }

  /**
   * Pago inmediato de comisión(es): al dejar la factura en "Pagada" se ofrece
   * pagar lo pendiente de cada empleado con `payout_mode === "inmediato"` que
   * tenga comisión en la factura. El monto autoritativo lo calcula el servidor
   * (`getPendingCommissionsAction`); acá solo se elige el método de pago.
   */
  async function askCommissionPayment(next: InvoiceDetail) {
    if (next.invoice.status !== "Pagada") return;
    const employeeIds = [...new Set(next.items.map((item) => item.employee_id))].filter(
      (id) => props.employees.find((row) => row.id === id)?.payout_mode === "inmediato",
    );
    if (employeeIds.length === 0) return;
    const result: ActionResult<Array<{ employee_id: string; pending: number }>> =
      await getPendingCommissionsAction({ invoice_id: next.invoice.id, employee_ids: employeeIds });
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      return;
    }
    const payable = result.data.filter((row) => row.pending > 0);
    if (payable.length === 0) return;
    const fallbackMethod =
      props.methods.find((row) => row.code === "efectivo")?.code ?? props.methods[0]?.code ?? "efectivo";
    setCommissionRows(
      payable.map((row) => ({
        employee_id: row.employee_id,
        employee_name: employeeNameOf(row.employee_id),
        pending: row.pending,
        method_code: fallbackMethod,
      })),
    );
    setCommissionError(null);
    setCommissionOpen(true);
  }

  /** Confirma el pago de las comisiones listadas; si una falla, la conserva. */
  async function confirmCommissionPayment() {
    if (!detail || commissionRows.length === 0) return;
    setCommissionBusy(true);
    setCommissionError(null);
    let paidCount = 0;
    const failed: CommissionPayRow[] = [];
    for (const row of commissionRows) {
      const result = await payCommissionNowAction({
        invoice_id: detail.invoice.id,
        employee_id: row.employee_id,
        amount: row.pending,
        method_code: row.method_code,
      });
      if (result.success) {
        paidCount += 1;
      } else {
        failed.push(row);
        setCommissionError(`[${result.code}] ${result.message}`);
      }
    }
    setCommissionBusy(false);
    if (failed.length === 0) {
      setCommissionOpen(false);
      setCommissionRows([]);
      setNotice(
        paidCount === 1
          ? "Comisión pagada desde la caja del turno."
          : `${paidCount} comisiones pagadas desde la caja del turno.`,
      );
    } else {
      setCommissionRows(failed);
    }
  }

  // Hoja factura: totales vivos del borrador (solo presentación; la verdad la calcula el servidor).
  const todayStr = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  const draftSubtotal = items.reduce((acc, item) => {
    const qty = toNumber(item.qty) ?? 0;
    const price = toNumber(item.unit_price) ?? 0;
    return acc + qty * price;
  }, 0);
  const draftDiscount = toNumber(discount) ?? 0;
  const draftSubtotalAfterDiscount = Math.max(0, draftSubtotal - draftDiscount);
  
  // Calcular impuestos en tiempo real usando los impuestos activos de la sede
  const draftTaxes = props.taxes.reduce((acc, tax) => {
    const percent = tax.percent ?? 0;
    return acc + Math.round(draftSubtotalAfterDiscount * (percent / 100) * 100) / 100;
  }, 0);
  const draftTotal = Math.max(0, draftSubtotalAfterDiscount + draftTaxes);

  // Recargo por método en vivo (tarjeta 5%): fee sobre el NETO de cada
  // porción; el cliente paga el bruto. Misma fórmula que el servidor.
  const draftFees = portions.map((portion) => {
    const net = toNumber(portion.amount) ?? 0;
    const feePercent = Number(props.methods.find((row) => row.code === portion.method_code)?.fee_percent ?? 0);
    const fee = Math.round(net * (feePercent / 100) * 100) / 100;
    return { method_code: portion.method_code, net, feePercent, fee, gross: net + fee };
  });
  const draftSurcharge = draftFees.reduce((acc, row) => acc + row.fee, 0);
  const draftFeeLabel = draftFees
    .filter((row) => row.fee > 0)
    .map((row) => `${row.method_code} ${row.feePercent}%`)
    .join(", ");
  const draftGrandTotal = draftTotal + draftSurcharge;

  // Totalizar: rellena la primera porción vacía con el neto pendiente.
  // Las porciones son NETOS; el recargo se suma solo al total.
  const portionsFilled = portions.reduce((acc, portion) => acc + (toNumber(portion.amount) ?? 0), 0);
  const portionsRemaining = Math.max(0, draftTotal - portionsFilled);
  const canTotalize = portions.some((portion) => portion.amount.trim() === "") && portionsRemaining > 0;

  // Determinar si hay pago inmediato (para botón "Emitir y pagar")
  const hasImmediatePayment = portions.some((p) => (toNumber(p.amount) ?? 0) > 0);

  // Edición libre (Emitida: la cajera del turno edita sin motivo y el total
  // se recalcula) vs edición estricta (Pagada: solo admin, motivo + total
  // inmutable). Anulada nunca se edita (el botón ni se muestra).
  const isFreeEdit = detail?.invoice.status === "Emitida";
  // Medidor de conciliación de edición: el total nunca cambia.
  const editSubtotal = editItems.reduce((acc, item) => {
    const qty = toNumber(item.qty) ?? 0;
    const price = toNumber(item.unit_price) ?? 0;
    return acc + qty * price;
  }, 0);
  const editSubtotalOk =
    detail !== null && Math.abs(editSubtotal - Number(detail.invoice.subtotal)) < 0.01;
  const editFeeRows = (detail?.payments ?? []).map((payment) => {
    const draft = editPayments.find((row) => row.id === payment.id);
    const code = draft?.method_code ?? payment.method_code;
    const feePct = Number(props.methods.find((row) => row.code === code)?.fee_percent ?? 0);
    return { id: payment.id, code, feePct, ok: feePct === Number(payment.fee_percent ?? 0) };
  });
  const editFeesOk = editFeeRows.every((row) => row.ok);
  const canSaveEdit =
    detail !== null &&
    editItems.length > 0 &&
    !busy &&
    (isFreeEdit || (editMotivo.trim() !== "" && editSubtotalOk && editFeesOk));

  // Estimado del nuevo total en edición libre (solo presentación; los
  // impuestos vigentes y el recargo emitido los recalcula el servidor).
  const freeEditDiscount = detail ? Number(detail.invoice.discount) : 0;
  const freeEditBase = Math.max(0, editSubtotal - freeEditDiscount);
  const freeEditTax = props.taxes.reduce((acc, tax) => {
    const percent = Number(tax.percent ?? 0);
    return acc + Math.round(freeEditBase * (percent / 100) * 100) / 100;
  }, 0);
  const freeEditTotal = freeEditBase + freeEditTax + (detail ? Number(detail.invoice.surcharge ?? 0) : 0);

  function totalizePortions() {
    const firstEmpty = portions.findIndex((portion) => portion.amount.trim() === "");
    if (firstEmpty === -1) return;
    const filled = portions.reduce((acc, portion) => acc + (toNumber(portion.amount) ?? 0), 0);
    const remaining = Math.max(0, draftTotal - filled);
    if (remaining <= 0) return;
    const value = String(Math.round(remaining * 100) / 100);
    setPortions((prev) => prev.map((row, i) => (i === firstEmpty ? { ...row, amount: value } : row)));
  }

  // Métodos ya usados en otras porciones: cada método se cobra una sola vez.
  const usedMethodCodes = new Set(portions.map((portion) => portion.method_code));
  const firstFreeMethod =
    props.methods.find((row) => row.is_active !== false && !usedMethodCodes.has(row.code))?.code ?? null;

  function draftItemName(item: ItemDraft): string {
    if (item.item_type === "producto") {
      return props.products.find((row) => row.id === item.ref_id)?.name ?? "Producto por elegir";
    }
    if (item.item_type === "servicio") {
      return props.services.find((row) => row.id === item.ref_id)?.name ?? "Servicio por elegir";
    }
    return item.custom_name.trim() === "" ? "Ítem personalizado" : item.custom_name;
  }

  /**
   * Nombre visible de un ítem ya emitido. El detalle no trae el nombre del
   * catálogo (solo product_id/service_id), así que se resuelve contra los
   * catálogos cargados en el cliente. Si el id no está disponible (ítem
   * inactivo o de otra sede), se usa una etiqueta genérica en lugar de
   * mostrar el tipo crudo o un identificador interno.
   */
  function detailItemName(row: InvoiceItemRow): string {
    if (row.item_type === "producto") {
      return props.products.find((product) => product.id === row.product_id)?.name ?? "Producto";
    }
    if (row.item_type === "servicio") {
      return props.services.find((service) => service.id === row.service_id)?.name ?? "Servicio";
    }
    return row.custom_name?.trim() ? row.custom_name : "Ítem personalizado";
  }

  /**
   * Botón "Modo cliente": alterna la vista para mostrar la factura en
   * pantalla. Activo oculta empleado y comisión (datos internos de nómina).
   */
  function clientViewToggle() {
    return (
      <button
        type="button"
        onClick={() => setClientView((prev) => !prev)}
        aria-pressed={clientView}
        className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100"
      >
        {clientView ? (
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {clientView ? "Volver a vista interna" : "Ver como cliente"}
      </button>
    );
  }

  // Papel factura: paleta clara fija a propósito (documento, no tema).
  const paperInputClass =
    "flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex min-h-0 flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Facturas de la sede</CardTitle>
              <CardDescription>Consulte el historial y abra el detalle de cada factura.</CardDescription>
            </div>
            {props.canWrite && (
              <Dialog
                open={createDialogOpen}
                onOpenChange={(open) => {
                  if (!open) cancelCreate();
                  else setCreateDialogOpen(open);
                }}
              >
                <button
                  type="button"
                  aria-disabled={shiftBlockReason !== null}
                  title={shiftBlockReason ?? undefined}
                  onClick={() => {
                    if (!passShiftGate()) return;
                    setBlockNotice(null);
                    setClientView(false);
                    setCreateDialogOpen(true);
                  }}
                  className={cn(
                    "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 active:scale-[0.98]",
                    shiftBlockReason !== null && "opacity-50",
                  )}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Emitir factura
                </button>
                <DialogContent className="max-w-5xl border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
                  <div className="rounded-xl bg-white text-slate-900 shadow-2xl">
                    <div className="border-b-4 border-double border-slate-300 px-6 py-5 sm:px-8">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-xl font-black tracking-tight">ORABELLA</p>
                          <p className="text-xs text-slate-500">Belleza · Factura de venta</p>
                        </div>
                        <div className="text-right">
                          <h2 className="text-lg font-bold">FACTURA DE VENTA</h2>
                          <p className="text-sm text-slate-500">N.º por asignar · {todayStr}</p>
                          <span className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                            Borrador
                          </span>
                        </div>
                      </div>
                    </div>
                    <form onSubmit={submitInvoice} className="flex flex-col gap-5 px-6 py-5 sm:px-8">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm font-medium">
                          Señor(es)
                          <input
                            className={paperInputClass}
                            value={clientName}
                            onChange={(event) => setClientName(event.target.value)}
                            placeholder="Nombre del cliente (opcional)"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm font-medium">
                          Documento (opcional)
                          <input
                            className={paperInputClass}
                            value={clientDocument}
                            onChange={(event) => setClientDocument(event.target.value)}
                            placeholder="CC / NIT"
                          />
                        </label>
                      </div>

                        <div className="flex justify-end">
                          {clientViewToggle()}
                        </div>
                        <div className="overflow-x-auto rounded-lg border border-slate-200">
                          <table className="w-full min-w-[820px] text-left text-sm text-slate-900">
                            <thead>
                              <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                                <th className="px-3 py-2">#</th>
                                <th className="px-3 py-2">Cant.</th>
                                <th className="px-3 py-2">Descripción</th>
                                {!clientView && <th className="px-3 py-2">Empleado</th>}
                                <th className="px-3 py-2 text-right">V. unitario</th>
                                <th className="px-3 py-2 text-right">Subtotal</th>
                                {!clientView && <th className="px-3 py-2 text-center">Comisión</th>}
                                <th className="px-3 py-2"><span className="sr-only">Quitar</span></th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((item, index) => {
                                const lineQty = toNumber(item.qty) ?? 0;
                                const linePrice = toNumber(item.unit_price) ?? 0;
                                return (
                                  <tr key={index} className="border-t border-slate-200 align-top">
                                    <td className="px-3 py-2 font-semibold">{index + 1}</td>
                                    <td className="whitespace-nowrap px-3 py-2">{item.qty}</td>
                                    <td className="min-w-[200px] px-3 py-2">
                                      <p className="font-medium">{draftItemName(item)}</p>
                                      <p className="text-xs text-slate-500">
                                        {item.item_type === "producto"
                                          ? "Producto"
                                          : item.item_type === "servicio"
                                            ? "Servicio"
                                            : "Personalizado"}
                                      </p>
                                    </td>
                                    {!clientView && (
                                      <td className="min-w-[140px] px-3 py-2">{employeeNameOf(item.employee_id)}</td>
                                    )}
                                    <td className="whitespace-nowrap px-3 py-2 text-right">
                                      {formatMoney(linePrice)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                      {formatMoney(lineQty * linePrice)}
                                    </td>
                                    {!clientView && (
                                      <td className="whitespace-nowrap px-3 py-2 text-center">
                                        {item.item_type === "producto" ? (
                                          <span
                                            className="text-xs text-slate-600"
                                            title="Valor de comisión asignado al ítem."
                                          >
                                            {item.commission_value == null
                                              ? "—"
                                              : formatMoney(item.commission_value)}
                                          </span>
                                        ) : item.item_type === "servicio" || item.no_commission ? (
                                          <span className="text-xs text-slate-500">Sin comisión</span>
                                        ) : (
                                          <div className="flex flex-col items-center gap-0.5">
                                            <input
                                              className={`${paperInputClass} h-9 w-28 text-right`}
                                              value={formatMoneyInput(
                                                item.commission_value == null ? "" : String(item.commission_value),
                                              )}
                                              onChange={(event) =>
                                                patchDraftItem(index, {
                                                  commission_value:
                                                    event.target.value.trim() === ""
                                                      ? null
                                                      : Number(stripMoneyInput(event.target.value)),
                                                })
                                              }
                                              placeholder="Valor $"
                                              inputMode="numeric"
                                              aria-label={`Ítem ${index + 1} valor comisión`}
                                              title="Corrija aquí el valor de la comisión del ítem."
                                            />
                                            {item.commission_value == null && (
                                              <span
                                                className="text-[10px] text-slate-500"
                                                title="Sin valor fijo se aplica el porcentaje del empleado."
                                              >
                                                Se usará % del empleado
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </td>
                                    )}
                                    <td className="px-3 py-2">
                                      <button
                                        type="button"
                                        aria-label={`Quitar ítem ${index + 1}`}
                                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                                        className="rounded-md border border-slate-300 p-2 text-slate-500 hover:bg-slate-100"
                                      >
                                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                              {items.length === 0 && (
                                <tr>
                                  <td colSpan={clientView ? 6 : 8} className="px-3 py-4 text-center text-sm text-slate-500">
                                    Sin ítems. Agregue al menos uno para emitir.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        <button
                          type="button"
                          onClick={() => openItemDialog("create")}
                          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          Agregar ítem
                        </button>

                        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">
                          Cobro inmediato (opcional)
                        </h3>
                        <div className="flex flex-col gap-3">
                          {portions.map((portion, index) => (
                            <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-slate-900">
                                Método {index + 1}
                                <Select
                                  value={portion.method_code}
                                  onValueChange={(value) =>
                                    setPortions((prev) =>
                                      prev.map((row, i) => (i === index ? { ...row, method_code: value } : row)),
                                    )
                                  }
                                >
                                  <SelectTrigger className={paperInputClass}>
                                    <SelectValue placeholder="Método de pago" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {props.methods
                                      .filter(
                                        (row) =>
                                          row.is_active !== false &&
                                          (row.code === portion.method_code || !usedMethodCodes.has(row.code)),
                                      )
                                      .map((row) => (
                                        <SelectItem key={row.id} value={row.code}>
                                          {row.name}
                                          {row.fee_percent > 0 ? ` (+${row.fee_percent}%)` : ""}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </label>
                              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-slate-900">
                                Monto (vacío = sin cobro inmediato)
                                <input
                                  className={paperInputClass}
                                  value={formatMoneyInput(portion.amount)}
                                  onChange={(event) =>
                                    setPortions((prev) =>
                                      prev.map((row, i) => (i === index ? { ...row, amount: stripMoneyInput(event.target.value) } : row)),
                                    )
                                  }
                                  placeholder="0"
                                  inputMode="numeric"
                                />
                                {draftFees[index] && draftFees[index].fee > 0 && (
                                  <span className="text-xs font-normal text-emerald-700">
                                    +{formatMoney(draftFees[index].fee)} recargo → cobra{" "}
                                    {formatMoney(draftFees[index].gross)}
                                  </span>
                                )}
                              </label>
                              {portions.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => setPortions((prev) => prev.filter((_, i) => i !== index))}
                                  className="flex h-10 items-center gap-1 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                  Quitar
                                </button>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row">
                          <button
                            type="button"
                            disabled={!canTotalize}
                            title={
                              canTotalize
                                ? "Rellena la primera porción vacía con el neto pendiente"
                                : "Nada por rellenar"
                            }
                            onClick={totalizePortions}
                            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Totalizar pagos
                          </button>
                          <button
                            type="button"
                            disabled={!firstFreeMethod}
                            title={!firstFreeMethod ? "Todos los métodos ya están en uso" : undefined}
                            onClick={() =>
                              setPortions((prev) => {
                                const filledPrev = prev.reduce(
                                  (acc, portion) => acc + (toNumber(portion.amount) ?? 0),
                                  0,
                                );
                                const remainingPrev = Math.max(0, draftTotal - filledPrev);
                                return [
                                  ...prev,
                                  {
                                    method_code:
                                      props.methods.find(
                                        (row) =>
                                          row.is_active !== false &&
                                          !prev.some((portion) => portion.method_code === row.code),
                                      )?.code ?? "efectivo",
                                    amount:
                                      remainingPrev > 0 ? String(Math.round(remainingPrev * 100) / 100) : "",
                                  },
                                ];
                              })
                            }
                            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Banknote className="h-4 w-4" aria-hidden="true" />
                            Dividir cobro
                          </button>
                        </div>
                        {!firstFreeMethod && (
                          <p className="text-xs text-slate-500">Todos los métodos ya están en uso.</p>
                        )}

                        <div className="flex justify-end">
                          <dl className="w-full max-w-xs space-y-1 text-sm text-slate-900">
                            <div className="flex justify-between gap-3">
                              <dt>Subtotal</dt>
                              <dd className="font-medium">{formatMoney(draftSubtotal)}</dd>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <dt>
                                <label className="font-medium">
                                  Descuento
                                  <span className="sr-only">Descuento factura</span>
                                </label>
                              </dt>
                              <dd>
                                <input
                                  className={`${paperInputClass} h-9 w-28 text-right`}
                                  value={formatMoneyInput(discount)}
                                  onChange={(event) => setDiscount(stripMoneyInput(event.target.value))}
                                  placeholder="0"
                                  inputMode="numeric"
                                  aria-label="Descuento factura"
                                />
                              </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt>Impuestos</dt>
                              <dd className="font-medium">{formatMoney(draftTaxes)}</dd>
                            </div>
                            {draftSurcharge > 0 && (
                              <div className="flex justify-between gap-3 text-emerald-700">
                                <dt>Recargo{draftFeeLabel !== "" ? ` (${draftFeeLabel})` : ""}</dt>
                                <dd className="font-medium">+{formatMoney(draftSurcharge)}</dd>
                              </div>
                            )}
                            <div className="flex justify-between gap-3 border-t-2 border-slate-900 pt-2 text-lg font-black">
                              <dt>TOTAL</dt>
                              <dd>{formatMoney(draftGrandTotal)}</dd>
                            </div>
                          </dl>
                        </div>

                        {shiftBlockReason !== null && (
                          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                            {shiftBlockReason}
                          </p>
                        )}
                        {error && (
                          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                            {error}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
                          <button
                            type="button"
                            onClick={cancelCreate}
                            className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={busy}
                            className="h-10 rounded-md bg-emerald-700 px-6 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 disabled:opacity-50"
                          >
                            {busy ? "Emitiendo…" : hasImmediatePayment ? "Emitir y pagar" : "Emitir factura"}
                          </button>
                        </div>
                      </form>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>
          {(blockNotice ?? shiftBlockReason) !== null && (
            <p
              role={blockNotice ? "alert" : "status"}
              className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
            >
              {blockNotice ?? shiftBlockReason}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={applyFilters} className="mt-0 flex flex-wrap items-end gap-3">
            <Label className="min-w-[10rem]">
              Estado
              <Select
                value={filters.status}
                onValueChange={(status) => setFilters({ ...filters, status })}
              >
                <SelectTrigger className={inputClass}>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Todas</SelectItem>
                  <SelectItem value="Emitida">Emitida</SelectItem>
                  <SelectItem value="Pagada">Pagada</SelectItem>
                  <SelectItem value="Anulada">Anulada</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Label className="min-w-[10rem]">
              Vendedor
              <Combobox
                value={filters.seller}
                onValueChange={(seller) => setFilters({ ...filters, seller })}
                placeholder="Todos"
                allowClear
                clearLabel="Todos"
                options={props.employees
                  .filter((row) => row.is_active)
                  .map((row) => ({
                    value: row.id,
                    label: row.full_name,
                    description: row.employee_code ?? '',
                  }))}
                ariaLabel="Filtrar por vendedor"
                filterPlaceholder="Buscar vendedor..."
              />
            </Label>
            <Label className="min-w-[10rem]">
              Cerró por
              <Combobox
                value={filters.closedBy}
                onValueChange={(closedBy) => setFilters({ ...filters, closedBy })}
                placeholder="Todos"
                allowClear
                clearLabel="Todos"
                options={props.employees
                  .filter((row) => row.is_active)
                  .map((row) => ({
                    value: row.id,
                    label: row.full_name,
                    description: row.employee_code ?? '',
                  }))}
                ariaLabel="Filtrar por quien cerró"
                filterPlaceholder="Buscar..."
              />
            </Label>
            <Label className="min-w-[10rem]">
              Empleado
              <Combobox
                value={filters.employee}
                onValueChange={(employee) => setFilters({ ...filters, employee })}
                placeholder="Todos"
                allowClear
                clearLabel="Todos"
                options={props.employees
                  .filter((row) => row.is_active)
                  .map((row) => ({
                    value: row.id,
                    label: row.full_name,
                    description: row.employee_code ?? '',
                  }))}
                ariaLabel="Filtrar por empleado participante"
                filterPlaceholder="Buscar..."
              />
            </Label>
            <Label className="min-w-[10rem]">
              Nº Factura
              <Input
                className={inputClass}
                value={filters.number}
                onChange={(event) => setFilters({ ...filters, number: event.target.value })}
                placeholder="#123"
                inputMode="numeric"
              />
            </Label>
            <Label className="min-w-[10rem]">
              Desde
              <Input
                type="date"
                className={inputClass}
                value={filters.from}
                onChange={(event) => setFilters({ ...filters, from: event.target.value })}
              />
            </Label>
            <Label className="min-w-[10rem]">
              Hasta
              <Input
                type="date"
                className={inputClass}
                value={filters.to}
                onChange={(event) => setFilters({ ...filters, to: event.target.value })}
              />
            </Label>
            <Button type="submit" variant="outline" loading={isViewPending}>
              <Search className="h-4 w-4" aria-hidden="true" />
              {isViewPending ? "Filtrando…" : "Filtrar"}
            </Button>
          </form>
          <div className="mt-4 overflow-hidden rounded-lg border border-color-2 dark:border-border-color">
            <div
              aria-hidden="true"
              className="hidden grid-cols-[2.5rem_7.5rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem_minmax(0,1.2fr)_5.5rem_4.5rem_4.5rem] gap-2 border-b border-color-2 bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary sm:grid dark:border-border-color"
            >
              <span>ID</span>
              <span>Fecha</span>
              <span>Abrió</span>
              <span>Cerró</span>
              <span>Cerrada</span>
              <span>Empleados</span>
              <span className="text-right">Total</span>
              <span>Estado</span>
              <span className="text-center">Acciones</span>
            </div>
            <ul className="flex flex-col divide-y divide-color-2 dark:divide-border-color">
            {invoices.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[2.5rem_7.5rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem_minmax(0,1.2fr)_5.5rem_4.5rem_4.5rem] sm:items-center sm:gap-2"
              >
                <span className="font-mono text-sm font-semibold text-slate-700 dark:text-slate-300">
                  #{row.consecutive_number}
                </span>
                <span className="whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">
                  {new Date(row.created_at).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" })}{" "}
                  {new Date(row.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="truncate text-sm text-slate-600 dark:text-slate-300" title={row.user_name ?? ""}>
                  {row.user_name ?? "—"}
                </span>
                <span className="truncate text-sm text-slate-600 dark:text-slate-300" title={row.closed_by_name ?? ""}>
                  {row.closed_by_name ?? "—"}
                </span>
                <span className="whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">
                  {row.closed_at
                    ? `${new Date(row.closed_at).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" })} ${new Date(row.closed_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`
                    : "—"}
                </span>
                <span
                  className="truncate text-sm text-slate-600 dark:text-slate-300"
                  title={row.employee_names.join(", ")}
                >
                  {employeeSummary(row.employee_names)}
                </span>
                <span className="whitespace-nowrap text-sm font-medium text-slate-900 sm:text-right dark:text-slate-100">
                  {formatMoney(row.total)}
                </span>
                <span>{statusPill(row.status)}</span>
                <span className="flex items-center gap-1 sm:justify-center">
                  {row.status !== "Anulada" &&
                    (props.isAdmin ||
                      (props.canWrite &&
                        row.status === "Emitida" &&
                        row.user_id === props.currentUserId)) && (
                    <button
                      type="button"
                      aria-disabled={shiftBlockReason !== null}
                      title={shiftBlockReason ?? (row.status === "Emitida"
                        ? "Editar factura emitida (el total se recalcula)"
                        : "Editar factura (solo admin, con motivo)")}
                      aria-label={`Editar factura ${row.consecutive_number}`}
                      onClick={() => openEdit(row.id)}
                      className={cn(
                        "rounded-md border border-slate-300 p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
                        shiftBlockReason !== null && "opacity-50",
                      )}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                {props.detailMode !== "none" && (props.detailMode === "full" || row.status === "Emitida") && (
                  <button
                    type="button"
                    title="Ver detalle"
                    aria-label={`Ver detalle de la factura ${row.consecutive_number}`}
                    onClick={() => openDetail(row.id)}
                    className="rounded-md border border-slate-300 p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
                </span>
                  {detail && detail.invoice.id === row.id && (
                    <Dialog
                      open={detailDialogOpen}
                      onOpenChange={(isOpen) => {
                        if (!isOpen) closeDetail();
                      }}
                    >
                    <DialogContent className="max-w-4xl border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
                      <div className="rounded-xl bg-white text-slate-900 shadow-2xl dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)]">
                        <div className="border-b-4 border-double border-slate-300 px-6 py-5 sm:px-8">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <p className="text-xl font-black tracking-tight">ORABELLA</p>
                              <p className="text-xs text-slate-500">Belleza · Factura de venta</p>
                            </div>
                            <div className="text-right">
                              <h2 className="text-lg font-bold">
                                FACTURA #{detail.invoice.consecutive_number}{" "}
                                {statusPill(detail.invoice.status)}
                              </h2>
                              <p className="text-sm text-slate-500">
                                {new Date(detail.invoice.created_at).toLocaleDateString("es-CO", {
                                  year: "numeric",
                                  month: "long",
                                  day: "numeric",
                                })}
                                {detail.invoice.status === "Anulada" && detail.invoice.cancel_reason
                                  ? ` · Motivo: ${detail.invoice.cancel_reason}`
                                  : ""}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-5 px-6 py-5 sm:px-8">
                          <div className="grid gap-4 sm:grid-cols-2 text-sm">
                            <p>
                              <span className="font-semibold">Señor(es): </span>
                              {detail.invoice.client_name}
                              {detail.invoice.client_document ? ` · ${detail.invoice.client_document}` : ""}
                            </p>
                            <p className="sm:text-right">
                              <span className="font-semibold">Total: </span>
                              {formatMoney(detail.invoice.total)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Ítems</h3>
                            {clientViewToggle()}
                          </div>
                          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
                            <table className="w-full min-w-[560px] text-left text-sm text-slate-900">
                              <thead>
                                <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                                  <th className="px-3 py-2">#</th>
                                  <th className="px-3 py-2">Descripción</th>
                                  {!clientView && <th className="px-3 py-2">Empleado</th>}
                                  <th className="px-3 py-2 text-right">Cant.</th>
                                  <th className="px-3 py-2 text-right">V. unitario</th>
                                  <th className="px-3 py-2 text-right">Subtotal</th>
                                  {!clientView && <th className="px-3 py-2 text-center">¿Comisión?</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {detail.items.map((row, index) => (
                                  <tr key={row.id} className="border-t border-slate-200">
                                    <td className="px-3 py-2 font-semibold">{index + 1}</td>
                                    <td className="px-3 py-2">
                                      {detailItemName(row)}
                                      {!clientView &&
                                        row.item_type !== "servicio" &&
                                        !row.no_commission &&
                                        commissionDisplayValue(row) !== null && (
                                          <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                            Comisión: {formatMoney(commissionDisplayValue(row))}
                                          </span>
                                        )}
                                      {!clientView && row.no_commission && (
                                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                                          Sin comisión
                                        </span>
                                      )}
                                    </td>
                                    {!clientView && (
                                      <td className="px-3 py-2">
                                        {row.employee_full_name ?? "—"}
                                        {row.employee_code ? (
                                          <span className="text-xs text-slate-500"> ({row.employee_code})</span>
                                        ) : null}
                                      </td>
                                    )}
                                    <td className="px-3 py-2 text-right">{row.qty}</td>
                                    <td className="px-3 py-2 text-right">{formatMoney(row.unit_price)}</td>
                                    <td className="px-3 py-2 text-right font-medium">{formatMoney(row.subtotal)}</td>
                                    {!clientView && (
                                      <td className="px-3 py-2 text-center">
                                        {row.item_type === "servicio" ? (
                                          <span className="text-xs text-slate-500">Sin comisión</span>
                                        ) : row.no_commission ? (
                                          <span className="text-slate-500">No</span>
                                        ) : commissionDisplayValue(row) !== null ? (
                                          <span className="font-medium text-emerald-700">{formatMoney(commissionDisplayValue(row))}</span>
                                        ) : (
                                          <span className="text-slate-400">—</span>
                                        )}
                                      </td>
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Impuestos</h3>
                          <ul className="mt-1 flex flex-col gap-1 text-sm text-slate-900">
                            {detail.taxes.map((row) => (
                              <li key={row.id}>
                                {row.tax_name} ({row.percent}%) = {formatMoney(row.amount)}
                              </li>
                            ))}
                            {detail.taxes.length === 0 && <li className="text-slate-500">Sin impuestos.</li>}
                          </ul>
                          <div className="flex justify-end">
                            <dl className="w-full max-w-xs space-y-1 text-sm text-slate-900">
                              <div className="flex justify-between gap-3">
                                <dt>Subtotal</dt>
                                <dd className="font-medium">{formatMoney(detail.invoice.subtotal)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt>Descuento</dt>
                                <dd className="font-medium">{formatMoney(detail.invoice.discount)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt>Impuestos</dt>
                                <dd className="font-medium">{formatMoney(detail.invoice.tax)}</dd>
                              </div>
                              {Number(detail.invoice.surcharge ?? 0) > 0 && (
                                <div className="flex justify-between gap-3 text-emerald-700">
                                  <dt>Recargo</dt>
                                  <dd className="font-medium">+{formatMoney(Number(detail.invoice.surcharge))}</dd>
                                </div>
                              )}
                              <div className="flex justify-between gap-3 border-t-2 border-slate-900 pt-2 text-lg font-black">
                                <dt>TOTAL</dt>
                                <dd>{formatMoney(detail.invoice.total)}</dd>
                              </div>
                            </dl>
                          </div>
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Cobro</h3>
                          <ul className="mt-1 flex flex-col gap-1 text-sm text-slate-900">
                            {detail.payments.map((row) => (
                              <li key={row.id}>
                                {row.method_code} = {formatMoney(row.amount)}
                                {row.fee_amount > 0 && (
                                  <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                    recargo {row.fee_percent}%: +{formatMoney(row.fee_amount)}
                                  </span>
                                )}
                              </li>
                            ))}
                            {detail.payments.length === 0 && (
                              <li className="text-slate-500">Sin cobro registrado (Emitida).</li>
                            )}
                          </ul>
                          <p className="text-sm text-slate-900">
                            Pagado {formatMoney(detail.paid)} · Saldo {formatMoney(detail.remaining)}
                          </p>

                          {((props.canWrite && detail.invoice.status === "Emitida") ||
                            (props.canAnnul &&
                              (detail.invoice.status === "Emitida" || detail.invoice.status === "Pagada"))) && (
                            <div className="rounded-lg bg-slate-50 p-4">
                              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Operaciones</h3>
                              {shiftBlockReason !== null && (
                                <p role="status" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                                  {shiftBlockReason}
                                </p>
                              )}
                              {error && (
                                <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                                  {error}
                                </p>
                              )}
                              <div className="mt-3 flex flex-col gap-4">
                          {props.canWrite && detail.invoice.status === "Emitida" && (
                            <form onSubmit={submitSplit} className="flex flex-col gap-3">
                              <div className="flex flex-wrap items-end gap-3">
                              <label className="flex min-w-[10rem] flex-col gap-1 text-sm font-medium text-slate-900">
                                Método
                                <Select
                                  value={splitDraft.method_code}
                                  onValueChange={(method_code) => setSplitDraft({ ...splitDraft, method_code })}
                                >
                                  <SelectTrigger className={paperInputClass}>
                                    <SelectValue placeholder="Método" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {props.methods.map((row) => (
                                      <SelectItem key={row.id} value={row.code}>
                                        {row.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </label>
                              <label className="flex min-w-[10rem] flex-col gap-1 text-sm font-medium text-slate-900">
                                Monto
                                <input
                                  className={paperInputClass}
                                  value={formatMoneyInput(splitDraft.amount)}
                                  onChange={(event) => setSplitDraft({ ...splitDraft, amount: stripMoneyInput(event.target.value) })}
                                  placeholder="0"
                                  inputMode="numeric"
                                  required
                                />
                              </label>
                              </div>
                              <div>
                              <button
                                type="submit"
                                disabled={busy}
                                className="flex h-10 items-center gap-2 rounded-md bg-slate-200 px-4 text-sm font-medium text-slate-900 hover:bg-slate-300 disabled:opacity-50"
                              >
                                <Banknote className="h-4 w-4" aria-hidden="true" />
                                {busy ? "Pagando…" : "Pagar"}
                              </button>
                              </div>
                            </form>
                          )}

                          {props.canAnnul && (detail.invoice.status === "Emitida" || detail.invoice.status === "Pagada") && (
                            <form onSubmit={submitAnnul} className="flex flex-col gap-3">
                              <div className="flex flex-wrap items-end gap-3">
                              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-slate-900">
                                Motivo de anulación
                                <input
                                  className={paperInputClass}
                                  value={motivo}
                                  onChange={(event) => setMotivo(event.target.value)}
                                  placeholder="Obligatorio"
                                  required
                                />
                              </label>
                              </div>
                              <div>
                              <button
                                type="submit"
                                disabled={busy}
                                className="flex h-10 items-center gap-2 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                <CircleX className="h-4 w-4" aria-hidden="true" />
                                {busy ? "Anulando…" : "Anular factura"}
                              </button>
                              </div>
                            </form>
                          )}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-6 py-4 sm:px-8">
                          <button
                            type="button"
                            onClick={closeDetail}
                            className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Cerrar
                          </button>
                        </div>
                      </div>
                    </DialogContent>
                    </Dialog>
                  )}
                  {row.status !== "Anulada" &&
                    (props.isAdmin ||
                      (props.canWrite &&
                        row.status === "Emitida" &&
                        row.user_id === props.currentUserId)) && (
                    <Dialog
                      open={isEditDialogOpen}
                      onOpenChange={(isOpen) => {
                        if (!isOpen) setIsEditDialogOpen(false);
                      }}
                    >
                      <DialogContent className="max-w-5xl border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
                        <div className="rounded-xl bg-white text-slate-900 shadow-2xl">
                          <div className="border-b-4 border-double border-slate-300 px-6 py-5 sm:px-8">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div>
                                <p className="text-xl font-black tracking-tight">ORABELLA</p>
                                <p className="text-xs text-slate-500">
                                  {isFreeEdit
                                    ? "Edición libre de emitida (sin motivo, el total se recalcula)"
                                    : "Edición con motivo y auditoría"}
                                </p>
                              </div>
                              <div className="text-right">
                                <h2 className="text-lg font-bold">
                                  EDITAR FACTURA #{detail?.invoice.consecutive_number ?? "—"}
                                </h2>
                                <p className="mt-1 text-sm">
                                  <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                                    {isFreeEdit
                                      ? `Total anterior: ${detail ? formatMoney(detail.invoice.total) : "—"} (se recalcula)`
                                      : `Total inmutable: ${detail ? formatMoney(detail.invoice.total) : "—"}`}
                                  </span>
                                </p>
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col gap-5 px-6 py-5 sm:px-8">
                            {!isFreeEdit && (
                              <label className="flex flex-col gap-1 text-sm font-medium">
                                Motivo de la edición (obligatorio, queda auditado)
                                <input
                                  className={paperInputClass}
                                  value={editMotivo}
                                  onChange={(event) => setEditMotivo(event.target.value)}
                                  placeholder="Ej. Servicio mal depreciado: se ajusta y agrega kit"
                                />
                              </label>
                            )}
                            <div className="flex justify-end">
                              {clientViewToggle()}
                            </div>
                            <div className="overflow-x-auto rounded-lg border border-slate-200">
                              <table className="w-full min-w-[860px] text-left text-sm text-slate-900">
                                <thead>
                                  <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                                    <th className="px-3 py-2">#</th>
                                    <th className="px-3 py-2">Cant.</th>
                                    <th className="px-3 py-2">Descripción</th>
                                    {!clientView && <th className="px-3 py-2">Empleado</th>}
                                    <th className="px-3 py-2 text-right">V. unitario</th>
                                    <th className="px-3 py-2 text-right">Subtotal</th>
                                    {!clientView && <th className="px-3 py-2 text-center">Comisión</th>}
                                    <th className="px-3 py-2"><span className="sr-only">Quitar</span></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {editItems.map((item, index) => {
                                    const lineQty = toNumber(item.qty) ?? 0;
                                    const linePrice = toNumber(item.unit_price) ?? 0;
                                    return (
                                      <tr key={item.id ?? `nuevo-${index}`} className="border-t border-slate-200 align-top">
                                        <td className="px-3 py-2 font-semibold">{index + 1}</td>
                                        <td className="px-3 py-2">
                                          <input
                                            className={`${paperInputClass} w-20`}
                                            value={item.qty}
                                            onChange={(event) => patchEditItem(index, { qty: event.target.value })}
                                            placeholder="1"
                                            inputMode="numeric"
                                            aria-label={`Editar ítem ${index + 1} cantidad`}
                                          />
                                        </td>
                                        <td className="min-w-[220px] px-3 py-2">
                                          {item.item_type === "producto" && (
                                            <Combobox
                                              value={item.ref_id}
                                              onValueChange={(value) => {
                                                patchEditItem(index, { ref_id: value });
                                                const found = props.products.find((row) => row.id === value);
                                                if (found?.sale_price != null) {
                                                  patchEditItem(index, { unit_price: String(found.sale_price) });
                                                }
                                              }}
                                              placeholder="Producto…"
                                              options={props.products
                                                .filter((row) => row.is_active)
                                                .map((row) => ({
                                                  value: row.id,
                                                  label: row.name,
                                                  description: `Stock: ${row.stock_qty}`,
                                                }))}
                                              ariaLabel={`Editar ítem ${index + 1} producto`}
                                              filterPlaceholder="Escriba para filtrar…"
                                            />
                                          )}
                                          {item.item_type === "servicio" && (
                                            <Combobox
                                              value={item.ref_id}
                                              onValueChange={(value) => {
                                                patchEditItem(index, { ref_id: value });
                                                const found = props.services.find((row) => row.id === value);
                                                if (found) patchEditItem(index, { unit_price: String(found.price) });
                                              }}
                                              placeholder="Servicio…"
                                              options={props.services
                                                .filter((row) => row.is_active)
                                                .map((row) => ({ value: row.id, label: row.name }))}
                                              ariaLabel={`Editar ítem ${index + 1} servicio`}
                                              filterPlaceholder="Escriba para filtrar…"
                                            />
                                          )}
                                          {item.item_type === "custom" && (
                                            <input
                                              className={paperInputClass}
                                              value={item.custom_name}
                                              onChange={(event) => patchEditItem(index, { custom_name: event.target.value })}
                                              placeholder="Descripción"
                                              aria-label={`Editar ítem ${index + 1} descripción`}
                                            />
                                          )}
                                          <p className="mt-1 text-xs text-slate-500">
                                            {item.item_type === "producto"
                                              ? "Producto"
                                              : item.item_type === "servicio"
                                                ? "Servicio"
                                                : "Personalizado"}
                                          </p>
                                        </td>
                                        {!clientView && (
                                          <td className="min-w-[150px] px-3 py-2">
                                            <Combobox
                                              value={item.employee_id}
                                              onValueChange={(value) => patchEditItem(index, { employee_id: value })}
                                              placeholder="Empleado…"
                                              options={props.employees.map((row) => ({
                                                value: row.id,
                                                label: row.full_name,
                                                description: row.employee_code ? `ID ${row.employee_code}` : undefined,
                                              }))}
                                              ariaLabel={`Editar ítem ${index + 1} empleado`}
                                              filterPlaceholder="Escriba para filtrar…"
                                            />
                                          </td>
                                        )}
                                        <td className="px-3 py-2">
                                          <input
                                            className={`${paperInputClass} w-28 text-right`}
                                            value={formatMoneyInput(item.unit_price)}
                                            onChange={(event) =>
                                              patchEditItem(index, { unit_price: stripMoneyInput(event.target.value) })
                                            }
                                            placeholder="0"
                                            inputMode="numeric"
                                            aria-label={`Editar ítem ${index + 1} precio`}
                                          />
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                          {formatMoney(lineQty * linePrice)}
                                        </td>
                                        {!clientView && (
                                          <td className="px-3 py-2 text-center">
                                            {item.item_type === "servicio" ? (
                                              <span className="text-xs text-slate-500">Sin comisión</span>
                                            ) : (
                                              <div className="flex flex-col items-center gap-1">
                                                <label className="flex items-center gap-1.5 text-sm">
                                                  <input
                                                    type="checkbox"
                                                    checked={!item.no_commission}
                                                    onChange={(event) =>
                                                      patchEditItem(index, {
                                                        no_commission: !event.target.checked,
                                                        commission_value: null,
                                                      })
                                                    }
                                                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                                  />
                                                  <span className="text-slate-600">¿Comisión?</span>
                                                </label>
                                                {!item.no_commission && (
                                                  <>
                                                    <input
                                                      className={`${paperInputClass} h-9 w-28 text-right`}
                                                      value={formatMoneyInput(
                                                        item.commission_value == null ? "" : String(item.commission_value),
                                                      )}
                                                      onChange={(event) =>
                                                        patchEditItem(index, {
                                                          commission_value:
                                                            event.target.value.trim() === ""
                                                              ? null
                                                              : Number(stripMoneyInput(event.target.value)),
                                                        })
                                                      }
                                                      placeholder="Valor $"
                                                      inputMode="numeric"
                                                      aria-label={`Editar ítem ${index + 1} valor comisión`}
                                                      title="Corrija aquí el valor de la comisión del ítem."
                                                    />
                                                    {item.commission_value == null && (
                                                      <span
                                                        className="text-[10px] text-slate-500"
                                                        title="Sin valor fijo se aplica el porcentaje del empleado."
                                                      >
                                                        Se usará % del empleado
                                                      </span>
                                                    )}
                                                  </>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        )}
                                        <td className="px-3 py-2">
                                          <button
                                            type="button"
                                            aria-label={`Quitar ítem ${index + 1}`}
                                            onClick={() => setEditItems((prev) => prev.filter((_, i) => i !== index))}
                                            className="rounded-md border border-slate-300 p-2 text-slate-500 hover:bg-slate-100"
                                          >
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <button
                              type="button"
                              onClick={() => openItemDialog("edit")}
                              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
                            >
                              <Plus className="h-4 w-4" aria-hidden="true" />
                              Agregar ítem
                            </button>
                            {!isFreeEdit && (
                            <div>
                              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
                                Cobros (solo cambia el método, montos intactos)
                              </h3>
                              <div className="flex flex-col gap-2">
                                {(detail?.payments ?? []).map((payment) => {
                                  const draft = editPayments.find((row) => row.id === payment.id);
                                  const code = draft?.method_code ?? payment.method_code;
                                  const feePct = Number(
                                    props.methods.find((row) => row.code === code)?.fee_percent ?? 0,
                                  );
                                  const feeOk = feePct === Number(payment.fee_percent ?? 0);
                                  return (
                                    <div key={payment.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                                      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-slate-900">
                                        Método ({formatMoney(payment.amount)})
                                        <Select
                                          value={code}
                                          onValueChange={(value) =>
                                            setEditPayments((prev) =>
                                              prev.map((row) =>
                                                row.id === payment.id ? { ...row, method_code: value } : row,
                                              ),
                                            )
                                          }
                                        >
                                          <SelectTrigger className={paperInputClass}>
                                            <SelectValue placeholder="Método" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {props.methods.map((row) => (
                                              <SelectItem key={row.id} value={row.code}>
                                                {row.name}
                                                {row.fee_percent > 0 ? ` (+${row.fee_percent}%)` : ""}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </label>
                                      {!feeOk && (
                                        <p className="text-xs font-medium text-red-700">
                                          Cambia el recargo: el total no cuadraría.
                                        </p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            )}
                            {isFreeEdit ? (
                              <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-slate-900">
                                <p>
                                  Subtotal nuevo: {formatMoney(editSubtotal)} (antes{" "}
                                  {detail ? formatMoney(detail.invoice.subtotal) : "—"})
                                </p>
                                <p className="font-semibold">
                                  Nuevo total estimado: {formatMoney(freeEditTotal)}
                                </p>
                              </div>
                            ) : (
                            <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-900">
                              <p>
                                Subtotal: {formatMoney(editSubtotal)} / emitido{" "}
                                {detail ? formatMoney(detail.invoice.subtotal) : "—"}{" "}
                                {editSubtotalOk ? "✓" : "✗ debe cuadrar"}
                              </p>
                              <p>
                                Recargo:{" "}
                                {editFeesOk
                                  ? "igual al emitido ✓"
                                  : "✗ use métodos con igual recargo"}
                              </p>
                              <p className="font-semibold">
                                TOTAL intacto: {detail ? formatMoney(detail.invoice.total) : "—"}
                              </p>
                            </div>
                            )}
                            {editError && (
                              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                                {editError}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-6 py-4 sm:px-8">
                            <button
                              type="button"
                              onClick={() => setIsEditDialogOpen(false)}
                              className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              onClick={submitEdit}
                              disabled={!canSaveEdit}
                              title={
                                !canSaveEdit
                                  ? isFreeEdit
                                    ? "Agregue al menos un ítem válido para guardar"
                                    : "Cuadre subtotal, recargo y motivo para guardar"
                                  : undefined
                              }
                              className="h-10 rounded-md bg-slate-900 px-6 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                            >
                              {busy ? "Guardando…" : "Guardar edición"}
                            </button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                </li>
            ))}
            {invoices.length === 0 && (
              <li className="px-3 py-4 text-sm text-text-secondary">Sin facturas para estos filtros.</li>
            )}
          </ul>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
            <p>
              {totalInvoices} factura(s) · Página {invoicePage} de {invoicePageCount}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={invoicePage <= 1 || isViewPending}
                onClick={() => applyFilters(undefined, invoicePage - 1)}
              >
                Anterior
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={invoicePage >= invoicePageCount || isViewPending}
                onClick={() => applyFilters(undefined, invoicePage + 1)}
              >
                Siguiente
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

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

      {/* Modal de ítems generalizado: crear (borrador) y edición libre de
          EMITIDAS (agrega a la edición). Nivel raíz para no anidarse. */}
      <Dialog
        open={isItemDialogOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) setIsItemDialogOpen(false);
          else setIsItemDialogOpen(isOpen);
        }}
      >
        <DialogContent className="max-w-lg border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
          <div className="max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-xl bg-white text-slate-900 shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-3">
              <h2 className="text-lg font-bold">
                {itemDialogTarget === "edit" ? "Agregar ítem a la edición" : "Agregar ítem"}
              </h2>
              <p className="text-sm text-slate-500">
                Subtotal:{" "}
                {formatMoney(
                  (toNumber(itemDraft.qty) ?? 0) * (toNumber(itemDraft.unit_price) ?? 0),
                )}
              </p>
            </div>
            <div className="flex flex-col gap-3 px-5 py-3">
              <div>
                <p className="mb-2 text-sm font-medium">Tipo</p>
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tipo de ítem">
                  {(
                    [
                      ["producto", "Producto"],
                      ["servicio", "Servicio"],
                      ["custom", "Personalizado"],
                    ] as Array<[ItemDraft["item_type"], string]>
                  ).map(([type, label]) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={itemDraft.item_type === type}
                      onClick={() =>
                        patchDraft({
                          item_type: type,
                          ref_id: "",
                          custom_name: "",
                          unit_price: "",
                          no_commission: type !== "producto",
                          commission_value: null,
                        })
                      }
                      className={
                        itemDraft.item_type === type
                          ? "h-9 rounded-md bg-slate-900 text-sm font-semibold text-white"
                          : "h-9 rounded-md border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {itemDraft.item_type === "producto" && (
                <div>
                  <p className="mb-1 text-sm font-medium">
                    Producto <span className="text-xs font-normal text-emerald-700">puede llevar comisión</span>
                  </p>
                  <Combobox
                    value={itemDraft.ref_id}
                    onValueChange={(value) => {
                      patchDraft({ ref_id: value });
                      autofillDraftPrice("producto", value);
                    }}
                    placeholder="Buscar producto…"
                    options={props.products
                      .filter((row) => row.is_active)
                      .map((row) => ({
                        value: row.id,
                        label: row.name,
                        description: `Stock: ${row.stock_qty}`,
                      }))}
                    ariaLabel="Producto del ítem"
                    filterPlaceholder="Escriba para filtrar…"
                  />
                </div>
              )}
              {itemDraft.item_type === "servicio" && (
                <div>
                  <p className="mb-1 text-sm font-medium">
                    Servicio <span className="text-xs font-normal text-slate-500">sin comisión</span>
                  </p>
                  <Combobox
                    value={itemDraft.ref_id}
                    onValueChange={(value) => {
                      patchDraft({ ref_id: value });
                      autofillDraftPrice("servicio", value);
                    }}
                    placeholder="Buscar servicio…"
                    options={props.services
                      .filter((row) => row.is_active)
                      .map((row) => ({ value: row.id, label: row.name }))}
                    ariaLabel="Servicio del ítem"
                    filterPlaceholder="Escriba para filtrar…"
                  />
                </div>
              )}
              {itemDraft.item_type === "custom" && (
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Descripción
                  <input
                    className={paperInputClass}
                    value={itemDraft.custom_name}
                    onChange={(event) => patchDraft({ custom_name: event.target.value })}
                    placeholder="Ej. Peinado novia"
                  />
                </label>
              )}
              <div>
                <p className="mb-1 text-sm font-medium">Empleado que atiende</p>
                <Combobox
                  value={itemDraft.employee_id}
                  onValueChange={(value) => patchDraft({ employee_id: value })}
                  placeholder="Buscar empleado…"
                  options={props.employees
                    .filter((row) => row.is_active)
                    .map((row) => ({
                      value: row.id,
                      label: row.full_name,
                      description: row.employee_code
                        ? `ID ${row.employee_code}`
                        : undefined,
                    }))}
                  ariaLabel="Empleado del ítem"
                  filterPlaceholder="Escriba para filtrar…"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Cantidad
                  <input
                    className={paperInputClass}
                    value={itemDraft.qty}
                    onChange={(event) => patchDraft({ qty: event.target.value })}
                    placeholder="1"
                    inputMode="numeric"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Precio unitario
                  <input
                    className={paperInputClass}
                    value={formatMoneyInput(itemDraft.unit_price)}
                    onChange={(event) =>
                      patchDraft({ unit_price: stripMoneyInput(event.target.value) })
                    }
                    placeholder="0"
                    inputMode="numeric"
                  />
                </label>
              </div>
              {itemDraft.item_type === "producto" && (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!itemDraft.no_commission}
                      onChange={(event) =>
                        patchDraft({ no_commission: !event.target.checked })
                      }
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-slate-700">¿Tiene comisión?</span>
                    {!itemDraft.no_commission && itemDraft.commission_value != null && (
                      <span className="text-slate-500">
                        Comisión: {formatMoney(itemDraft.commission_value)}
                      </span>
                    )}
                  </label>
                  {!itemDraft.no_commission && (
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      Valor de la comisión ($)
                      <input
                        type="number"
                        className={paperInputClass}
                        value={itemDraft.commission_value ?? ""}
                        onChange={(event) =>
                          patchDraft({
                            commission_value:
                              event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                        placeholder="Ej. 10000"
                        min={0}
                        step={100}
                        inputMode="decimal"
                      />
                    </label>
                  )}
                </div>
              )}
              {itemDraft.item_type === "custom" && (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!itemDraft.no_commission}
                      onChange={(event) =>
                        patchDraft({
                          no_commission: !event.target.checked,
                          commission_value: null,
                        })
                      }
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-slate-700">¿Tiene comisión?</span>
                  </label>
                  {!itemDraft.no_commission && (
                    <label className="flex flex-col gap-1 text-sm font-medium">
                      Valor de la comisión ($)
                      <input
                        type="number"
                        className={paperInputClass}
                        value={itemDraft.commission_value ?? ""}
                        onChange={(event) =>
                          patchDraft({
                            commission_value:
                              event.target.value === "" ? null : Number(event.target.value),
                          })
                        }
                        placeholder="Ej. 10000"
                        min={0}
                        step={100}
                        inputMode="decimal"
                      />
                    </label>
                  )}
                </div>
              )}
              {itemError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {itemError}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-5 py-3">
              <button
                type="button"
                onClick={() => setIsItemDialogOpen(false)}
                className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={addItemFromDialog}
                className="h-10 rounded-md bg-slate-900 px-6 text-sm font-semibold text-white hover:bg-slate-700"
              >
                {itemDialogTarget === "edit" ? "Agregar a la edición" : "Agregar a la factura"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pago inmediato de comisión(es): aparece al dejar la factura Pagada si
          hay empleados con payout_mode "inmediato" y comisión pendiente. */}
      <Dialog
        open={commissionOpen}
        onOpenChange={(open) => {
          if (!open && !commissionBusy) {
            setCommissionOpen(false);
            setCommissionRows([]);
            setCommissionError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
          <div className="max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-xl bg-white text-slate-900 shadow-2xl">
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-bold">Pagar comisión al empleado</h2>
              <p className="text-sm text-slate-500">
                {detail ? `Factura #${detail.invoice.consecutive_number}` : "Factura"} · el
                pago sale de la caja del turno abierto.
              </p>
            </div>
            <div className="flex flex-col gap-4 px-6 py-4">
              {commissionRows.map((row, index) => (
                <div key={row.employee_id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{row.employee_name}</span>
                    <span className="text-sm font-medium">{formatMoney(row.pending)}</span>
                  </div>
                  <label className="mt-3 flex flex-col gap-1 text-sm font-medium text-slate-900">
                    Método de pago
                    <Select
                      value={row.method_code}
                      onValueChange={(value) =>
                        setCommissionRows((prev) =>
                          prev.map((item, i) => (i === index ? { ...item, method_code: value } : item)),
                        )
                      }
                    >
                      <SelectTrigger className={paperInputClass}>
                        <SelectValue placeholder="Método" />
                      </SelectTrigger>
                      <SelectContent>
                        {props.methods.map((method) => (
                          <SelectItem key={method.id} value={method.code}>
                            {method.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {row.method_code === "efectivo" && (
                    <p className="mt-2 text-xs text-slate-500">
                      El efectivo no puede superar el 50% de la base de apertura del turno
                      {shiftOpeningBase !== null ? ` (${formatMoney(shiftOpeningBase)})` : ""}. Si lo
                      supera, el sistema lo rechazará indicando cuánto queda disponible.
                    </p>
                  )}
                </div>
              ))}
              {commissionError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {commissionError}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  setCommissionOpen(false);
                  setCommissionRows([]);
                  setCommissionError(null);
                }}
                disabled={commissionBusy}
                className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmCommissionPayment()}
                disabled={commissionBusy || commissionRows.length === 0 || props.methods.length === 0}
                className="h-10 rounded-md bg-emerald-700 px-6 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {commissionBusy ? "Pagando…" : "Confirmar pago"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmación clásica: ¿Está seguro? … OK/Cancelar. */}
      <Dialog
        open={confirmKind !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmKind(null);
        }}
      >
        <DialogContent className="max-w-sm border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
          <div className="rounded-xl bg-white text-slate-900 shadow-2xl">
            <div className="px-6 pt-5">
              <h2 className="text-lg font-bold">
                {confirmKind === "annul"
                  ? "Anular factura"
                  : confirmKind === "pay"
                    ? "Pagar factura"
                    : hasImmediatePayment
                      ? "Emitir y pagar"
                      : "Emitir factura"}
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                {confirmKind === "annul"
                  ? `¿Está seguro de anular la factura${detail ? ` #${detail.invoice.consecutive_number}` : ""}? Se revertirá el stock y no se puede deshacer.`
                  : confirmKind === "pay"
                    ? `¿Está seguro de registrar el pago de ${formatMoney(toNumber(splitDraft.amount) ?? 0)} (${splitDraft.method_code})${detail ? ` en la factura #${detail.invoice.consecutive_number}` : ""}? Después no se podrá modificar.`
                    : hasImmediatePayment
                      ? `¿Está seguro de emitir y cobrar la factura por ${formatMoney(draftGrandTotal)}? Después no se podrá modificar.`
                      : `¿Está seguro de emitir la factura por ${formatMoney(draftGrandTotal)}? Esta acción genera un registro permanente que no se podrá eliminar.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-4">
              <button
                type="button"
                onClick={() => setConfirmKind(null)}
                disabled={busy}
                className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirmKind === "annul") void confirmAnnul();
                  else if (confirmKind === "pay") void confirmPay();
                  else void confirmEmit();
                }}
                className={
                  confirmKind === "annul"
                    ? "h-10 rounded-md bg-red-600 px-6 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-50"
                    : "h-10 rounded-md bg-emerald-700 px-6 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-50"
                }
              >
                {busy
                  ? "Procesando…"
                  : confirmKind === "annul"
                    ? "Anular factura"
                    : confirmKind === "pay"
                      ? "Pagar"
                      : hasImmediatePayment
                        ? "Emitir y pagar"
                        : "Emitir factura"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
