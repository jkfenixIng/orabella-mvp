"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  annulInvoiceAction,
  createInvoiceAction,
  getInvoiceAction,
  listInvoicesAction,
  splitPaymentAction,
} from "@/src/features/billing/actions";
import type {
  InvoiceDetail,
  InvoiceRow,
} from "@/src/features/billing/service";
import type { ProductRow } from "@/src/features/inventory/service";
import type {
  EmployeeRow,
  PaymentMethodRow,
  ServiceRow,
  TaxConfigRow,
} from "@/src/features/admin/service";
import {
  Badge,
} from "@/src/components/ui/lib/badge";
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
  DialogClose,
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

function emptyItem(): ItemDraft {
  return { item_type: "servicio", ref_id: "", custom_name: "", employee_id: "", qty: "1", unit_price: "", no_commission: true, commission_value: null };
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number | string): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

function invoiceStatusVariant(status: string): "default" | "success" | "destructive" | "secondary" {
  if (status === "Pagada") return "success";
  if (status === "Anulada") return "destructive";
  if (status === "Emitida") return "secondary";
  return "default";
}

interface InvoiceRowWithUser extends InvoiceRow {
  user_name: string | null;
}

interface InvoicesClientProps {
  sedeId: string;
  initialInvoices: InvoiceRowWithUser[];
  products: ProductRow[];
  services: ServiceRow[];
  employees: EmployeeRow[];
  methods: PaymentMethodRow[];
  taxes: TaxConfigRow[];
  canWrite: boolean;
  canAnnul: boolean;
  detailMode: "full" | "open-only" | "none";
}

export function InvoicesClient(props: InvoicesClientProps) {
  const [invoices, setInvoices] = useState<InvoiceRowWithUser[]>(props.initialInvoices);
  const [filters, setFilters] = useState({ status: "", from: "", to: "", seller: "", number: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Transición para los cambios de vista (filtros/detalle): la UI no se
  // congela mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [clientDocument, setClientDocument] = useState("");
  const [discount, setDiscount] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [isItemDialogOpen, setIsItemDialogOpen] = useState(false);
  const [itemDraft, setItemDraft] = useState<ItemDraft>(emptyItem());
  const [itemError, setItemError] = useState<string | null>(null);
  const [portions, setPortions] = useState<PortionDraft[]>([
    { method_code: "efectivo", amount: "" },
  ]);
  const [motivo, setMotivo] = useState("");
  const [splitDraft, setSplitDraft] = useState<PortionDraft>({ method_code: "efectivo", amount: "" });

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    startViewTransition(async () => {
      setError(null);
      const result: ActionResult<InvoiceRowWithUser[]> = await listInvoicesAction({
        sede_id: props.sedeId,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        user_id: filters.seller || undefined,
        consecutive_number: filters.number ? parseInt(filters.number, 10) : undefined,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }
      setInvoices(result.data);
    });
  }

  function patchDraft(patch: Partial<ItemDraft>) {
    setItemDraft((prev) => ({ ...prev, ...patch }));
  }

  function autofillDraftPrice(type: ItemDraft["item_type"], refId: string) {
    if (type === "producto") {
      const found = props.products.find((row) => row.id === refId);
      if (found?.sale_price != null) patchDraft({ unit_price: String(found.sale_price) });
    }
    if (type === "servicio") {
      const found = props.services.find((row) => row.id === refId);
      if (found) patchDraft({ unit_price: String(found.price) });
    }
  }

  function openItemDialog() {
    setItemDraft(emptyItem());
    setItemError(null);
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
    setItems((prev) => [...prev, draft]);
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
      setDetailDialogOpen(true);
    });
  }

  async function submitInvoice(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (items.length === 0) {
      setError("Agregue al menos un ítem a la factura.");
      return;
    }
    const parsedDiscount = discount.trim() === "" ? 0 : toNumber(discount);
    if (parsedDiscount == null) {
      setError("Descuento inválido.");
      return;
    }
    const parsedItems = [];
    for (const [index, item] of items.entries()) {
      const qty = toNumber(item.qty);
      const price = toNumber(item.unit_price);
      if (!item.employee_id) {
        setError(`Ítem ${index + 1}: el empleado es requerido.`);
        return;
      }
      if (qty == null || !Number.isInteger(qty) || qty <= 0) {
        setError(`Ítem ${index + 1}: cantidad inválida.`);
        return;
      }
      if (price == null || price < 0) {
        setError(`Ítem ${index + 1}: precio inválido.`);
        return;
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
      });
    }
    const parsedPortions = [];
    for (const portion of portions) {
      const amount = toNumber(portion.amount);
      if (amount == null) continue;
      if (amount <= 0) {
        setError("Las porciones de pago deben ser mayores a 0.");
        return;
      }
      parsedPortions.push({ method_code: portion.method_code, amount });
    }
    setBusy(true);
    let result: ActionResult<InvoiceDetail>;
    try {
      result = await createInvoiceAction({
        client_name: clientName,
        client_document: clientDocument.trim() === "" ? null : clientDocument,
        items: parsedItems,
        discount: parsedDiscount,
        payments: parsedPortions,
      });
    } finally {
      setBusy(false);
    }
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      return;
    }
    setNotice(`Factura #${result.data.invoice.consecutive_number} ${result.data.invoice.status.toLowerCase()}.`);
    setClientName("");
    setClientDocument("");
    setDiscount("");
    setItems([]);
    setPortions([{ method_code: "efectivo", amount: "" }]);
    setDetail(result.data);
    setCreateDialogOpen(false);
    setDetailDialogOpen(true);
    await applyFilters();
  }

  async function submitAnnul(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
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
      return;
    }
    setNotice(`Factura #${result.data.invoice.consecutive_number} anulada (stock revertido).`);
    setDetail(result.data);
    await applyFilters();
  }

  async function submitSplit(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const amount = toNumber(splitDraft.amount);
    if (amount == null || amount <= 0) {
      setError("Monto de la porción inválido.");
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
    await applyFilters();
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

  // Determinar si hay pago inmediato (para botón "Emitir y pagar")
  const hasImmediatePayment = portions.some((p) => (toNumber(p.amount) ?? 0) > 0);

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
                  onClick={() => setCreateDialogOpen(true)}
                  className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 active:scale-[0.98]"
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

                        <div className="overflow-x-auto rounded-lg border border-slate-200">
                          <table className="w-full min-w-[820px] text-left text-sm text-slate-900">
                            <thead>
                              <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                                <th className="px-3 py-2">#</th>
                                <th className="px-3 py-2">Cant.</th>
                                <th className="px-3 py-2">Descripción</th>
                                <th className="px-3 py-2">Empleado</th>
                                <th className="px-3 py-2 text-right">V. unitario</th>
                                <th className="px-3 py-2 text-right">Subtotal</th>
                                <th className="px-3 py-2 text-center">Comisión</th>
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
                                    <td className="min-w-[140px] px-3 py-2">{employeeNameOf(item.employee_id)}</td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right">
                                      {formatMoney(linePrice)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                      {formatMoney(lineQty * linePrice)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-center">
                                      {item.item_type === "servicio" ? (
                                        <span className="text-xs text-slate-500">Sin comisión</span>
                                      ) : item.no_commission ? (
                                        <span className="text-xs text-slate-500">Sin comisión</span>
                                      ) : item.item_type === "custom" &&
                                        item.commission_value !== null &&
                                        item.commission_value !== undefined ? (
                                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                          {formatMoney(item.commission_value)}
                                        </span>
                                      ) : (
                                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                          Con comisión
                                        </span>
                                      )}
                                    </td>
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
                                  <td colSpan={8} className="px-3 py-4 text-center text-sm text-slate-500">
                                    Sin ítems. Agregue al menos uno para emitir.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        <button
                          type="button"
                          onClick={openItemDialog}
                          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          Agregar ítem
                        </button>

                        <Dialog
                          open={isItemDialogOpen}
                          onOpenChange={(isOpen) => {
                            if (!isOpen) setIsItemDialogOpen(false);
                            else setIsItemDialogOpen(isOpen);
                          }}
                        >
                          {isItemDialogOpen && (
                            <div
                              className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[2px]"
                              aria-hidden="true"
                              onClick={() => setIsItemDialogOpen(false)}
                            />
                          )}
                          <DialogContent className="max-w-lg border-0 bg-transparent p-0 shadow-none dark:bg-transparent">
                            <div className="max-h-[calc(100dvh-3rem)] overflow-y-auto rounded-xl bg-white text-slate-900 shadow-2xl">
                              <div className="border-b border-slate-200 px-5 py-3">
                                <h2 className="text-lg font-bold">Agregar ítem</h2>
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
                                  </label>
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
                                  Agregar a la factura
                                </button>
                              </div>
                            </div>
                          </DialogContent>
                        </Dialog>

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

                        <button
                          type="button"
                          disabled={!firstFreeMethod}
                          title={!firstFreeMethod ? "Todos los métodos ya están en uso" : undefined}
                          onClick={() =>
                            setPortions((prev) => [
                              ...prev,
                              {
                                method_code:
                                  props.methods.find(
                                    (row) =>
                                      row.is_active !== false &&
                                      !prev.some((portion) => portion.method_code === row.code),
                                  )?.code ?? "efectivo",
                                amount: "",
                              },
                            ])
                          }
                          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Banknote className="h-4 w-4" aria-hidden="true" />
                          Dividir cobro (agregar porción)
                        </button>
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
          <ul className="mt-4 flex flex-col gap-2">
            {invoices.map((row) => (
              <li
                key={row.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-color-2 bg-surface px-3 py-2 dark:border-border-color",
                )}
              >
                <div className="flex flex-wrap items-center gap-3 min-w-0 flex-1">
                  <span className="text-sm font-mono font-semibold text-slate-700 dark:text-slate-300">
                    #{row.consecutive_number}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {new Date(row.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="text-sm text-slate-600 dark:text-slate-300 truncate max-w-[180px]">
                    {row.user_name ?? "—"}
                  </span>
                  <Badge variant={invoiceStatusVariant(row.status)} className="whitespace-nowrap">
                    {row.status}
                  </Badge>
                </div>
                {props.detailMode !== "none" && (props.detailMode === "full" || row.status === "Emitida") && (
                <Dialog open={detailDialogOpen} onOpenChange={(open) => {
                  if (!open) {
                    setDetail(null);
                    setMotivo("");
                    setSplitDraft({ method_code: "efectivo", amount: "" });
                  }
                  setDetailDialogOpen(open);
                }}>
                  <button
                      type="button"
                      aria-label={`Ver detalle de la factura ${row.consecutive_number}`}
                      onClick={() => openDetail(row.id)}
                      className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition-all duration-200 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 active:scale-[0.98]"
                    >
                      <Eye className="h-4 w-4" aria-hidden="true" />
                      Ver detalle
                    </button>
                  {detail && (
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
                                <Badge variant={invoiceStatusVariant(detail.invoice.status)}>
                                  {detail.invoice.status}
                                </Badge>
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
                          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Ítems</h3>
                          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
                            <table className="w-full min-w-[560px] text-left text-sm text-slate-900">
                              <thead>
                                <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                                  <th className="px-3 py-2">#</th>
                                  <th className="px-3 py-2">Descripción</th>
                                  <th className="px-3 py-2">Empleado</th>
                                  <th className="px-3 py-2 text-right">Cant.</th>
                                  <th className="px-3 py-2 text-right">V. unitario</th>
                                  <th className="px-3 py-2 text-right">Subtotal</th>
                                  <th className="px-3 py-2 text-center">¿Comisión?</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.items.map((row, index) => (
                                  <tr key={row.id} className="border-t border-slate-200">
                                    <td className="px-3 py-2 font-semibold">{index + 1}</td>
                                    <td className="px-3 py-2">
                                      {row.item_type === "custom" && row.custom_name ? row.custom_name : row.item_type}
                                      {row.item_type === "custom" && row.commission_value !== null && row.commission_value !== undefined && !row.no_commission && (
                                        <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                          Comisión: {formatMoney(row.commission_value)}
                                        </span>
                                      )}
                                      {row.no_commission && (
                                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                                          Sin comisión
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2">
                                      {row.employee_full_name ?? "—"}
                                      {row.employee_code ? (
                                        <span className="text-xs text-slate-500"> ({row.employee_code})</span>
                                      ) : null}
                                    </td>
                                    <td className="px-3 py-2 text-right">{row.qty}</td>
                                    <td className="px-3 py-2 text-right">{formatMoney(row.unit_price)}</td>
                                    <td className="px-3 py-2 text-right font-medium">{formatMoney(row.subtotal)}</td>
                                    <td className="px-3 py-2 text-center">
                                      {row.item_type === "servicio" ? (
                                        <span className="text-xs text-slate-500">Sin comisión</span>
                                      ) : row.no_commission ? (
                                        <span className="text-slate-500">No</span>
                                      ) : row.item_type === "custom" && row.commission_value !== null && row.commission_value !== undefined ? (
                                        <span className="font-medium text-emerald-700">{formatMoney(row.commission_value)}</span>
                                      ) : (
                                        <span className="text-emerald-700">Sí</span>
                                      )}
                                    </td>
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
                              {error && (
                                <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                                  {error}
                                </p>
                              )}
                              <div className="mt-3 flex flex-col gap-4">
                          {props.canWrite && detail.invoice.status === "Emitida" && (
                            <form onSubmit={submitSplit} className="flex flex-wrap items-end gap-3">
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
                              <button
                                type="submit"
                                disabled={busy}
                                className="flex h-10 items-center gap-2 rounded-md bg-slate-200 px-4 text-sm font-medium text-slate-900 hover:bg-slate-300 disabled:opacity-50"
                              >
                                <Banknote className="h-4 w-4" aria-hidden="true" />
                                {busy ? "Registrando…" : "Registrar porción"}
                              </button>
                            </form>
                          )}

                          {props.canAnnul && (detail.invoice.status === "Emitida" || detail.invoice.status === "Pagada") && (
                            <form onSubmit={submitAnnul} className="flex flex-wrap items-end gap-3">
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
                              <button
                                type="submit"
                                disabled={busy}
                                className="flex h-10 items-center gap-2 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                <CircleX className="h-4 w-4" aria-hidden="true" />
                                {busy ? "Anulando…" : "Anular factura"}
                              </button>
                            </form>
                          )}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 px-6 py-4 sm:px-8">
                          <DialogClose asChild>
                            <button
                              type="button"
                              className="h-10 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100"
                            >
                              Cerrar
                            </button>
                          </DialogClose>
                        </div>
                      </div>
                    </DialogContent>
                  )}
                </Dialog>
                )}
              </li>
            ))}
            {invoices.length === 0 && (
              <li className="text-sm text-text-secondary">Sin facturas para estos filtros.</li>
            )}
          </ul>
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
    </div>
  );
}
