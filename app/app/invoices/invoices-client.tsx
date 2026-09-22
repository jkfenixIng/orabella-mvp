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
} from "@/src/features/admin/service";
import {
  Badge,
} from "@/src/components/ui/lib/badge";
import { Button } from "@/src/components/ui/lib/button";
import { Checkbox } from "@/src/components/ui/lib/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/lib/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
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
}

interface PortionDraft {
  method_code: string;
  amount: string;
}

function emptyItem(): ItemDraft {
  return { item_type: "servicio", ref_id: "", custom_name: "", employee_id: "", qty: "1", unit_price: "", no_commission: false };
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

function invoiceStatusVariant(status: string): "default" | "success" | "destructive" {
  if (status === "Pagada") return "success";
  if (status === "Anulada") return "destructive";
  return "default";
}

interface InvoicesClientProps {
  sedeId: string;
  initialInvoices: InvoiceRow[];
  products: ProductRow[];
  services: ServiceRow[];
  employees: EmployeeRow[];
  methods: PaymentMethodRow[];
  canWrite: boolean;
  canAnnul: boolean;
  detailMode: "full" | "open-only" | "none";
}

export function InvoicesClient(props: InvoicesClientProps) {
  const [invoices, setInvoices] = useState(props.initialInvoices);
  const [filters, setFilters] = useState({ status: "", from: "", to: "" });
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
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [portions, setPortions] = useState<PortionDraft[]>([
    { method_code: "efectivo", amount: "" },
  ]);
  const [motivo, setMotivo] = useState("");
  const [splitDraft, setSplitDraft] = useState<PortionDraft>({ method_code: "efectivo", amount: "" });

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    startViewTransition(async () => {
      setError(null);
      const result: ActionResult<InvoiceRow[]> = await listInvoicesAction({
        sede_id: props.sedeId,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }
      setInvoices(result.data);
    });
  }

  function patchItem(index: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function autofillPrice(index: number, type: ItemDraft["item_type"], refId: string) {
    if (type === "producto") {
      const found = props.products.find((row) => row.id === refId);
      if (found?.sale_price != null) patchItem(index, { unit_price: String(found.sale_price) });
    }
    if (type === "servicio") {
      const found = props.services.find((row) => row.id === refId);
      if (found) patchItem(index, { unit_price: String(found.price) });
    }
  }

  // Inventory-style cancel: closing the dialog always resets its draft.
  function cancelCreate() {
    setClientName("");
    setClientDocument("");
    setDiscount("");
    setItems([emptyItem()]);
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
    setItems([emptyItem()]);
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
  const draftTotal = Math.max(0, draftSubtotal - draftDiscount);

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
                <DialogTrigger asChild>
                  <Button variant="default">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Emitir factura
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl border-0 bg-transparent p-0 shadow-none">
                  <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl bg-white text-slate-900 shadow-2xl">
                    <div className="border-b-4 border-double border-slate-300 px-6 py-5 sm:px-8">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-xl font-black tracking-tight">ORABELLA</p>
                          <p className="text-xs text-slate-500">Belleza · Factura de venta</p>
                        </div>
                        <div className="text-right">
                          <p className="text-lg font-bold">FACTURA DE VENTA</p>
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
                            placeholder="Nombre del cliente"
                            required
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
                                <th className="px-3 py-2 text-center">Sin comis.</th>
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
                                    <td className="px-3 py-2">
                                      <input
                                        className={`${paperInputClass} w-20`}
                                        value={item.qty}
                                        onChange={(event) => patchItem(index, { qty: event.target.value })}
                                        placeholder="1"
                                        inputMode="numeric"
                                        required
                                        aria-label={`Ítem ${index + 1} cantidad`}
                                      />
                                    </td>
                                    <td className="min-w-[230px] px-3 py-2">
                                      <Select
                                        value={item.item_type}
                                        onValueChange={(value) => {
                                          const type = value as ItemDraft["item_type"];
                                          patchItem(index, { item_type: type, ref_id: "", custom_name: "", unit_price: "" });
                                        }}
                                      >
                                        <SelectTrigger className={paperInputClass} aria-label={`Ítem ${index + 1} tipo`}>
                                          <SelectValue placeholder="Seleccione un tipo" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="producto">Producto</SelectItem>
                                          <SelectItem value="servicio">Servicio</SelectItem>
                                          <SelectItem value="custom">Personalizado</SelectItem>
                                        </SelectContent>
                                      </Select>
                                      {item.item_type === "producto" && (
                                        <Select
                                          value={item.ref_id}
                                          onValueChange={(value) => {
                                            patchItem(index, { ref_id: value });
                                            autofillPrice(index, "producto", value);
                                          }}
                                        >
                                          <SelectTrigger className={`${paperInputClass} mt-2`} aria-label={`Ítem ${index + 1} producto`}>
                                            <SelectValue placeholder="Producto…" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="">Producto…</SelectItem>
                                            {props.products
                                              .filter((row) => row.is_active)
                                              .map((row) => (
                                                <SelectItem key={row.id} value={row.id}>
                                                  {row.name} (stock {row.stock_qty})
                                                </SelectItem>
                                              ))}
                                          </SelectContent>
                                        </Select>
                                      )}
                                      {item.item_type === "servicio" && (
                                        <Select
                                          value={item.ref_id}
                                          onValueChange={(value) => {
                                            patchItem(index, { ref_id: value });
                                            autofillPrice(index, "servicio", value);
                                          }}
                                        >
                                          <SelectTrigger className={`${paperInputClass} mt-2`} aria-label={`Ítem ${index + 1} servicio`}>
                                            <SelectValue placeholder="Servicio…" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="">Servicio…</SelectItem>
                                            {props.services
                                              .filter((row) => row.is_active)
                                              .map((row) => (
                                                <SelectItem key={row.id} value={row.id}>
                                                  {row.name}
                                                </SelectItem>
                                              ))}
                                          </SelectContent>
                                        </Select>
                                      )}
                                      {item.item_type === "custom" && (
                                        <input
                                          className={`${paperInputClass} mt-2`}
                                          value={item.custom_name}
                                          onChange={(event) => patchItem(index, { custom_name: event.target.value })}
                                          placeholder="Descripción"
                                          required
                                          aria-label={`Ítem ${index + 1} descripción`}
                                        />
                                      )}
                                      <p className="mt-1 text-xs text-slate-500">{draftItemName(item)}</p>
                                    </td>
                                    <td className="min-w-[150px] px-3 py-2">
                                      <Select
                                        value={item.employee_id}
                                        onValueChange={(value) => patchItem(index, { employee_id: value })}
                                      >
                                        <SelectTrigger className={paperInputClass} aria-label={`Ítem ${index + 1} empleado`}>
                                          <SelectValue placeholder="Empleado…" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="">Empleado…</SelectItem>
                                          {props.employees.map((row) => (
                                            <SelectItem key={row.id} value={row.id}>
                                              {row.document}
                                              {row.employee_code ? ` (${row.employee_code})` : ""}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </td>
                                    <td className="px-3 py-2">
                                      <input
                                        className={`${paperInputClass} w-28 text-right`}
                                        value={formatMoneyInput(item.unit_price)}
                                        onChange={(event) => patchItem(index, { unit_price: stripMoneyInput(event.target.value) })}
                                        placeholder="0"
                                        inputMode="numeric"
                                        required
                                        aria-label={`Ítem ${index + 1} precio`}
                                      />
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                      {formatMoney(lineQty * linePrice)}
                                    </td>
                                    <td className="px-3 py-2 text-center">
                                      <Checkbox
                                        checked={item.no_commission}
                                        onCheckedChange={(checked) =>
                                          patchItem(index, { no_commission: checked === true })
                                        }
                                        aria-label={`Ítem ${index + 1} sin comisión`}
                                      />
                                    </td>
                                    <td className="px-3 py-2">
                                      {items.length > 1 && (
                                        <button
                                          type="button"
                                          aria-label={`Quitar ítem ${index + 1}`}
                                          onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                                          className="rounded-md border border-slate-300 p-2 text-slate-500 hover:bg-slate-100"
                                        >
                                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        <button
                          type="button"
                          onClick={() => setItems((prev) => [...prev, emptyItem()])}
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
                                    {props.methods.map((row) => (
                                      <SelectItem key={row.id} value={row.code}>
                                        {row.name}
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
                          onClick={() => setPortions((prev) => [...prev, { method_code: "efectivo", amount: "" }])}
                          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
                        >
                          <Banknote className="h-4 w-4" aria-hidden="true" />
                          Dividir cobro (agregar porción)
                        </button>

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
                            <div className="flex justify-between gap-3 text-slate-500">
                              <dt>Impuestos</dt>
                              <dd>se liquidan al emitir</dd>
                            </div>
                            <div className="flex justify-between gap-3 border-t-2 border-slate-900 pt-2 text-lg font-black">
                              <dt>TOTAL</dt>
                              <dd>{formatMoney(draftTotal)}</dd>
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
                            className="h-10 rounded-md bg-slate-900 px-6 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                          >
                            {busy ? "Emitiendo…" : "Emitir factura"}
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
                <span className="text-sm">
                  <strong>#{row.consecutive_number}</strong> · {row.client_name} ·{" "}
                  {formatMoney(row.total)} ·{" "}
                  <Badge variant={invoiceStatusVariant(row.status)}>{row.status}</Badge>
                </span>
                {props.detailMode !== "none" && (props.detailMode === "full" || row.status === "Emitida") && (
                <Dialog open={detailDialogOpen} onOpenChange={(open) => {
                  if (!open) {
                    setDetail(null);
                    setMotivo("");
                    setSplitDraft({ method_code: "efectivo", amount: "" });
                  }
                  setDetailDialogOpen(open);
                }}>
                  <DialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Ver detalle de la factura ${row.consecutive_number}`}
                      onClick={() => openDetail(row.id)}
                    >
                      <Eye className="h-4 w-4" aria-hidden="true" />
                      Ver detalle
                    </Button>
                  </DialogTrigger>
                  {detail && (
                    <DialogContent className="max-w-3xl">
                      <Card className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
                        <CardHeader className="pb-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <CardTitle>
                                Factura #{detail.invoice.consecutive_number}{" "}
                                <Badge variant={invoiceStatusVariant(detail.invoice.status)}>
                                  {detail.invoice.status}
                                </Badge>
                              </CardTitle>
                              <CardDescription>
                                {detail.invoice.client_name}
                                {detail.invoice.client_document ? ` · ${detail.invoice.client_document}` : ""} ·{" "}
                                {formatMoney(detail.invoice.total)}
                                {detail.invoice.status === "Anulada" && detail.invoice.cancel_reason
                                  ? ` · Motivo: ${detail.invoice.cancel_reason}`
                                  : ""}
                              </CardDescription>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-6">
                          <section>
                            <h3 className="text-sm font-semibold text-text-primary">Ítems</h3>
                            <ul className="mt-1 flex flex-col gap-1 text-sm text-text-primary">
                              {detail.items.map((row) => (
                                <li key={row.id}>
                                  {row.item_type}
                                  {row.custom_name ? ` · ${row.custom_name}` : ""} · cant. {row.qty} ·{" "}
                                  {formatMoney(row.unit_price)} = {formatMoney(row.subtotal)}
                                </li>
                              ))}
                            </ul>
                          </section>
                          <section>
                            <h3 className="text-sm font-semibold text-text-primary">Impuestos (snapshot)</h3>
                            <ul className="mt-1 flex flex-col gap-1 text-sm text-text-primary">
                              {detail.taxes.map((row) => (
                                <li key={row.id}>
                                  {row.tax_name} ({row.percent}%) = {formatMoney(row.amount)}
                                </li>
                              ))}
                              {detail.taxes.length === 0 && <li>Sin impuestos.</li>}
                            </ul>
                          </section>
                          <p className="text-sm text-text-primary">
                            Subtotal {formatMoney(detail.invoice.subtotal)} · Descuento{" "}
                            {formatMoney(detail.invoice.discount)} · Impuestos {formatMoney(detail.invoice.tax)} ·{" "}
                            <strong>Total {formatMoney(detail.invoice.total)}</strong>
                          </p>
                          <section>
                            <h3 className="text-sm font-semibold text-text-primary">Cobro</h3>
                            <ul className="mt-1 flex flex-col gap-1 text-sm text-text-primary">
                              {detail.payments.map((row) => (
                                <li key={row.id}>
                                  {row.method_code} = {formatMoney(row.amount)}
                                </li>
                              ))}
                              {detail.payments.length === 0 && <li>Sin cobro registrado (Emitida).</li>}
                            </ul>
                          </section>
                          <p className="text-sm text-text-primary">
                            Pagado {formatMoney(detail.paid)} · Saldo {formatMoney(detail.remaining)}
                          </p>

                          {props.canWrite && detail.invoice.status === "Emitida" && (
                            <form onSubmit={submitSplit} className="flex flex-wrap items-end gap-3">
                              <Label className="min-w-[10rem]">
                                Método
                                <Select
                                  value={splitDraft.method_code}
                                  onValueChange={(method_code) => setSplitDraft({ ...splitDraft, method_code })}
                                >
                                  <SelectTrigger className={inputClass}>
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
                              </Label>
                              <Label className="min-w-[10rem]">
                                Monto
                                <Input
                                  className={inputClass}
                                  value={formatMoneyInput(splitDraft.amount)}
                                  onChange={(event) => setSplitDraft({ ...splitDraft, amount: stripMoneyInput(event.target.value) })}
                                  placeholder="0"
                                  inputMode="numeric"
                                  required
                                />
                              </Label>
                              <Button type="submit" variant="secondary" loading={busy}>
                                <Banknote className="h-4 w-4" aria-hidden="true" />
                                Registrar porción
                              </Button>
                            </form>
                          )}

                          {props.canAnnul && (detail.invoice.status === "Emitida" || detail.invoice.status === "Pagada") && (
                            <form onSubmit={submitAnnul} className="flex flex-wrap items-end gap-3">
                              <Label className="min-w-0 flex-1">
                                Motivo de anulación
                                <Input
                                  className={inputClass}
                                  value={motivo}
                                  onChange={(event) => setMotivo(event.target.value)}
                                  placeholder="Obligatorio"
                                  required
                                />
                              </Label>
                              <Button type="submit" variant="destructive" loading={busy}>
                                <CircleX className="h-4 w-4" aria-hidden="true" />
                                Anular factura
                              </Button>
                            </form>
                          )}
                        </CardContent>
                        <CardFooter className="border-t border-color-2 pt-4">
                          <DialogClose asChild>
                            <Button variant="outline">Cerrar</Button>
                          </DialogClose>
                        </CardFooter>
                      </Card>
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
