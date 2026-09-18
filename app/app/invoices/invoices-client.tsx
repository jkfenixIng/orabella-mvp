"use client";

import { useState, type FormEvent } from "react";
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

const inputClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
const labelClass = "flex flex-col gap-1 text-sm";
const buttonClass =
  "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";
const ghostClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700";
const sectionClass = "rounded-lg border border-slate-300 p-4 dark:border-slate-700";
const errorClass = "text-sm text-red-600 dark:text-red-400";
const okClass = "text-sm text-green-700 dark:text-green-400";

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
}

interface PortionDraft {
  method_code: string;
  amount: string;
}

function emptyItem(): ItemDraft {
  return { item_type: "servicio", ref_id: "", custom_name: "", employee_id: "", qty: "1", unit_price: "" };
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

interface InvoicesClientProps {
  sedeId: string;
  initialInvoices: InvoiceRow[];
  products: ProductRow[];
  services: ServiceRow[];
  employees: EmployeeRow[];
  methods: PaymentMethodRow[];
  canWrite: boolean;
  canAnnul: boolean;
}

export function InvoicesClient(props: InvoicesClientProps) {
  const [invoices, setInvoices] = useState(props.initialInvoices);
  const [filters, setFilters] = useState({ status: "", from: "", to: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientDocument, setClientDocument] = useState("");
  const [discount, setDiscount] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [portions, setPortions] = useState<PortionDraft[]>([
    { method_code: "efectivo", amount: "" },
  ]);
  const [motivo, setMotivo] = useState("");
  const [splitDraft, setSplitDraft] = useState<PortionDraft>({ method_code: "efectivo", amount: "" });

  async function applyFilters(event?: FormEvent) {
    event?.preventDefault();
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

  async function openDetail(id: string) {
    setError(null);
    const result: ActionResult<InvoiceDetail> = await getInvoiceAction(id);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setDetail(result.data);
    setMotivo("");
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
    const result: ActionResult<InvoiceDetail> = await createInvoiceAction({
      client_name: clientName,
      client_document: clientDocument.trim() === "" ? null : clientDocument,
      items: parsedItems,
      discount: parsedDiscount,
      payments: parsedPortions,
    });
    setBusy(false);
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
    await applyFilters();
  }

  async function submitAnnul(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const result: ActionResult<InvoiceDetail> = await annulInvoiceAction(detail.invoice.id, {
      motivo,
    });
    setBusy(false);
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
    const result: ActionResult<InvoiceDetail> = await splitPaymentAction(detail.invoice.id, {
      portions: [{ method_code: splitDraft.method_code, amount }],
    });
    setBusy(false);
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

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Facturas de la sede</h2>
        <form onSubmit={applyFilters} className="mt-3 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Estado
            <select
              className={inputClass}
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            >
              <option value="">Todas</option>
              <option value="Emitida">Emitida</option>
              <option value="Pagada">Pagada</option>
              <option value="Anulada">Anulada</option>
            </select>
          </label>
          <label className={labelClass}>
            Desde
            <input
              type="date"
              className={inputClass}
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </label>
          <label className={labelClass}>
            Hasta
            <input
              type="date"
              className={inputClass}
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </label>
          <button type="submit" className={ghostClass}>
            Filtrar
          </button>
        </form>
        <ul className="mt-4 flex flex-col gap-2">
          {invoices.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 dark:border-slate-800"
            >
              <span className="text-sm">
                <strong>#{row.consecutive_number}</strong> · {row.client_name} ·{" "}
                {formatMoney(row.total)} · {row.status}
              </span>
              <button type="button" className={ghostClass} onClick={() => openDetail(row.id)}>
                Ver detalle
              </button>
            </li>
          ))}
          {invoices.length === 0 && (
            <li className="text-sm text-slate-500">Sin facturas para estos filtros.</li>
          )}
        </ul>
      </section>

      {props.canWrite && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">Emitir factura</h2>
          <form onSubmit={submitInvoice} className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <label className={labelClass}>
                Cliente
                <input
                  className={inputClass}
                  value={clientName}
                  onChange={(event) => setClientName(event.target.value)}
                  placeholder="Nombre del cliente"
                  required
                />
              </label>
              <label className={labelClass}>
                Documento (opcional)
                <input
                  className={inputClass}
                  value={clientDocument}
                  onChange={(event) => setClientDocument(event.target.value)}
                  placeholder="CC / NIT"
                />
              </label>
              <label className={labelClass}>
                Descuento factura
                <input
                  className={inputClass}
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                />
              </label>
            </div>
            {items.map((item, index) => (
              <fieldset key={index} className="flex flex-wrap gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                <legend className="px-1 text-xs text-slate-500">Ítem {index + 1}</legend>
                <select
                  className={inputClass}
                  value={item.item_type}
                  onChange={(event) => {
                    const type = event.target.value as ItemDraft["item_type"];
                    patchItem(index, { item_type: type, ref_id: "", custom_name: "", unit_price: "" });
                  }}
                >
                  <option value="producto">Producto</option>
                  <option value="servicio">Servicio</option>
                  <option value="custom">Personalizado</option>
                </select>
                {item.item_type === "producto" && (
                  <select
                    className={inputClass}
                    value={item.ref_id}
                    onChange={(event) => {
                      patchItem(index, { ref_id: event.target.value });
                      autofillPrice(index, "producto", event.target.value);
                    }}
                    required
                  >
                    <option value="">Producto…</option>
                    {props.products
                      .filter((row) => row.is_active)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name} (stock {row.stock_qty})
                        </option>
                      ))}
                  </select>
                )}
                {item.item_type === "servicio" && (
                  <select
                    className={inputClass}
                    value={item.ref_id}
                    onChange={(event) => {
                      patchItem(index, { ref_id: event.target.value });
                      autofillPrice(index, "servicio", event.target.value);
                    }}
                    required
                  >
                    <option value="">Servicio…</option>
                    {props.services
                      .filter((row) => row.is_active)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                )}
                {item.item_type === "custom" && (
                  <input
                    className={inputClass}
                    value={item.custom_name}
                    onChange={(event) => patchItem(index, { custom_name: event.target.value })}
                    placeholder="Descripción"
                    required
                  />
                )}
                <select
                  className={inputClass}
                  value={item.employee_id}
                  onChange={(event) => patchItem(index, { employee_id: event.target.value })}
                  required
                >
                  <option value="">Empleado…</option>
                  {props.employees.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.document}
                      {row.employee_code ? ` (${row.employee_code})` : ""}
                    </option>
                  ))}
                </select>
                <input
                  className={inputClass}
                  value={item.qty}
                  onChange={(event) => patchItem(index, { qty: event.target.value })}
                  placeholder="Cant."
                  inputMode="numeric"
                  required
                />
                <input
                  className={inputClass}
                  value={item.unit_price}
                  onChange={(event) => patchItem(index, { unit_price: event.target.value })}
                  placeholder="Precio"
                  inputMode="decimal"
                  required
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    className={ghostClass}
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Quitar
                  </button>
                )}
              </fieldset>
            ))}
            <div>
              <button type="button" className={ghostClass} onClick={() => setItems((prev) => [...prev, emptyItem()])}>
                Agregar ítem
              </button>
            </div>
            {portions.map((portion, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <label className={labelClass}>
                  Método {index + 1}
                  <select
                    className={inputClass}
                    value={portion.method_code}
                    onChange={(event) =>
                      setPortions((prev) =>
                        prev.map((row, i) => (i === index ? { ...row, method_code: event.target.value } : row)),
                      )
                    }
                  >
                    {props.methods.map((row) => (
                      <option key={row.id} value={row.code}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Monto (vacío = sin cobro inmediato)
                  <input
                    className={inputClass}
                    value={portion.amount}
                    onChange={(event) =>
                      setPortions((prev) =>
                        prev.map((row, i) => (i === index ? { ...row, amount: event.target.value } : row)),
                      )
                    }
                    placeholder="0"
                    inputMode="decimal"
                  />
                </label>
                {portions.length > 1 && (
                  <button
                    type="button"
                    className={ghostClass}
                    onClick={() => setPortions((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Quitar
                  </button>
                )}
              </div>
            ))}
            <div>
              <button
                type="button"
                className={ghostClass}
                onClick={() => setPortions((prev) => [...prev, { method_code: "efectivo", amount: "" }])}
              >
                Dividir cobro (agregar porción)
              </button>
            </div>
            <div>
              <button type="submit" className={buttonClass} disabled={busy}>
                {busy ? "Emitiendo…" : "Emitir factura"}
              </button>
            </div>
          </form>
        </section>
      )}

      {detail && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">
            Factura #{detail.invoice.consecutive_number} · {detail.invoice.status}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {detail.invoice.client_name}
            {detail.invoice.client_document ? ` · ${detail.invoice.client_document}` : ""} ·{" "}
            {formatMoney(detail.invoice.total)}
            {detail.invoice.status === "Anulada" && detail.invoice.cancel_reason
              ? ` · Motivo: ${detail.invoice.cancel_reason}`
              : ""}
          </p>
          <h3 className="mt-3 text-sm font-semibold">Ítems</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {detail.items.map((row) => (
              <li key={row.id}>
                {row.item_type}
                {row.custom_name ? ` · ${row.custom_name}` : ""} · cant. {row.qty} ·{" "}
                {formatMoney(row.unit_price)} = {formatMoney(row.subtotal)}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-sm font-semibold">Impuestos (snapshot)</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {detail.taxes.map((row) => (
              <li key={row.id}>
                {row.tax_name} ({row.percent}%) = {formatMoney(row.amount)}
              </li>
            ))}
            {detail.taxes.length === 0 && <li>Sin impuestos.</li>}
          </ul>
          <p className="mt-2 text-sm">
            Subtotal {formatMoney(detail.invoice.subtotal)} · Descuento{" "}
            {formatMoney(detail.invoice.discount)} · Impuestos {formatMoney(detail.invoice.tax)} ·{" "}
            <strong>Total {formatMoney(detail.invoice.total)}</strong>
          </p>
          <h3 className="mt-3 text-sm font-semibold">Cobro</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {detail.payments.map((row) => (
              <li key={row.id}>
                {row.method_code} = {formatMoney(row.amount)}
              </li>
            ))}
            {detail.payments.length === 0 && <li>Sin cobro registrado (Emitida).</li>}
          </ul>
          <p className="mt-1 text-sm">
            Pagado {formatMoney(detail.paid)} · Saldo {formatMoney(detail.remaining)}
          </p>

          {props.canWrite && detail.invoice.status === "Emitida" && (
            <form onSubmit={submitSplit} className="mt-3 flex flex-wrap items-end gap-2">
              <label className={labelClass}>
                Método
                <select
                  className={inputClass}
                  value={splitDraft.method_code}
                  onChange={(event) => setSplitDraft({ ...splitDraft, method_code: event.target.value })}
                >
                  {props.methods.map((row) => (
                    <option key={row.id} value={row.code}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Monto
                <input
                  className={inputClass}
                  value={splitDraft.amount}
                  onChange={(event) => setSplitDraft({ ...splitDraft, amount: event.target.value })}
                  placeholder="0"
                  inputMode="decimal"
                  required
                />
              </label>
              <button type="submit" className={ghostClass} disabled={busy}>
                Registrar porción
              </button>
            </form>
          )}

          {props.canAnnul && (detail.invoice.status === "Emitida" || detail.invoice.status === "Pagada") && (
            <form onSubmit={submitAnnul} className="mt-3 flex flex-wrap items-end gap-2">
              <label className={labelClass}>
                Motivo de anulación
                <input
                  className={inputClass}
                  value={motivo}
                  onChange={(event) => setMotivo(event.target.value)}
                  placeholder="Obligatorio"
                  required
                />
              </label>
              <button type="submit" className={ghostClass} disabled={busy}>
                Anular factura
              </button>
            </form>
          )}
        </section>
      )}

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
