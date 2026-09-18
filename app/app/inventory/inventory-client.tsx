"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  getKardexAction,
  listProductsAction,
  registerMovementAction,
  upsertProductAction,
} from "@/src/features/inventory/actions";
import type {
  MovementRow,
  ProductRow,
} from "@/src/features/inventory/service";

const inputClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
const labelClass = "flex flex-col gap-1 text-sm";
const buttonClass =
  "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";
const sectionClass = "rounded-lg border border-slate-300 p-4 dark:border-slate-700";
const errorClass = "text-sm text-red-600 dark:text-red-400";
const okClass = "text-sm text-green-700 dark:text-green-400";
const alertClass =
  "rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

interface InventoryClientProps {
  sedeId: string;
  initialProducts: ProductRow[];
  initialAlertIds: string[];
  canWrite: boolean;
}

export function InventoryClient(props: InventoryClientProps) {
  const [products, setProducts] = useState(props.initialProducts);
  const [alertIds, setAlertIds] = useState<Set<string>>(new Set(props.initialAlertIds));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    sku: "",
    name: "",
    description: "",
    min_stock: "0",
    cost_price: "",
    sale_price: "",
    is_active: true,
  });
  const [movement, setMovement] = useState({ product_id: "", type: "IN", qty: "", reason: "" });
  const [kardex, setKardex] = useState<{ product: ProductRow; rows: MovementRow[] } | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return products;
    return products.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.sku.toLowerCase().includes(needle),
    );
  }, [products, query]);

  async function refresh() {
    const result: ActionResult<ProductRow[]> = await listProductsAction(props.sedeId);
    if (result.success) {
      setProducts(result.data);
      setAlertIds(
        new Set(result.data.filter((row) => row.stock_qty <= row.min_stock).map((row) => row.id)),
      );
    }
  }

  function startEdit(row: ProductRow) {
    setEditingId(row.id);
    setForm({
      sku: row.sku,
      name: row.name,
      description: row.description ?? "",
      min_stock: String(row.min_stock),
      cost_price: row.cost_price == null ? "" : String(row.cost_price),
      sale_price: row.sale_price == null ? "" : String(row.sale_price),
      is_active: row.is_active,
    });
    setError(null);
    setNotice(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({
      sku: "",
      name: "",
      description: "",
      min_stock: "0",
      cost_price: "",
      sale_price: "",
      is_active: true,
    });
  }

  async function handleProductSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const minStock = toNumber(form.min_stock);
    const result: ActionResult<ProductRow> = await upsertProductAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: props.sedeId,
      sku: form.sku,
      name: form.name,
      description: form.description || null,
      min_stock: minStock ?? 0,
      cost_price: toNumber(form.cost_price),
      sale_price: toNumber(form.sale_price),
      is_active: form.is_active,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setNotice(editingId ? "Producto actualizado." : "Producto creado. Registre el stock inicial con un movimiento IN.");
    cancelEdit();
    await refresh();
  }

  async function handleMovementSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const qty = toNumber(movement.qty);
    const result: ActionResult<{ movement: MovementRow; stock_qty: number }> =
      await registerMovementAction({
        product_id: movement.product_id || undefined,
        type: movement.type,
        qty: qty ?? 0,
        reason: movement.reason,
      });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setNotice(`Movimiento registrado. Stock actual: ${result.data.stock_qty}.`);
    setMovement({ product_id: "", type: "IN", qty: "", reason: "" });
    await refresh();
    if (kardex && kardex.product.id === result.data.movement.product_id) {
      await showKardex(kardex.product);
    }
  }

  async function showKardex(row: ProductRow) {
    setError(null);
    const result: ActionResult<MovementRow[]> = await getKardexAction(row.id);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setKardex({ product: row, rows: result.data });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass}>
        <label className={labelClass}>
          Buscar por nombre o SKU
          <input
            className={inputClass}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. shampoo o SH-001"
          />
        </label>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Productos ({visible.length})</h2>
        {error ? (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className={okClass}>
            {notice}
          </p>
        ) : null}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-300 dark:border-slate-700">
                <th className="py-2 pr-3">SKU</th>
                <th className="py-2 pr-3">Nombre</th>
                <th className="py-2 pr-3">Stock</th>
                <th className="py-2 pr-3">Mínimo</th>
                <th className="py-2 pr-3">Costo</th>
                <th className="py-2 pr-3">Venta</th>
                <th className="py-2 pr-3">Estado</th>
                <th className="py-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className="border-b border-slate-200 dark:border-slate-800">
                  <td className="py-2 pr-3 font-mono">{row.sku}</td>
                  <td className="py-2 pr-3">
                    {row.name}{" "}
                    {alertIds.has(row.id) ? <span className={alertClass}>Bajo mínimo</span> : null}
                  </td>
                  <td className="py-2 pr-3">{row.stock_qty}</td>
                  <td className="py-2 pr-3">{row.min_stock}</td>
                  <td className="py-2 pr-3">{formatMoney(row.cost_price)}</td>
                  <td className="py-2 pr-3">{formatMoney(row.sale_price)}</td>
                  <td className="py-2 pr-3">{row.is_active ? "Activo" : "Inactivo"}</td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-sm underline"
                        onClick={() => showKardex(row)}
                      >
                        Kardex
                      </button>
                      {props.canWrite ? (
                        <button
                          type="button"
                          className="text-sm underline"
                          onClick={() => startEdit(row)}
                        >
                          Editar
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-4 text-slate-500">
                    Sin productos para esta búsqueda.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {props.canWrite ? (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">
            {editingId ? "Editar producto" : "Crear producto"}
          </h2>
          <form onSubmit={handleProductSubmit} className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              SKU *
              <input
                className={inputClass}
                value={form.sku}
                onChange={(event) => setForm({ ...form, sku: event.target.value })}
                placeholder="SH-001"
                required
              />
            </label>
            <label className={labelClass}>
              Nombre *
              <input
                className={inputClass}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Shampoo"
                required
              />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Descripción
              <input
                className={inputClass}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label className={labelClass}>
              Stock mínimo
              <input
                className={inputClass}
                value={form.min_stock}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, min_stock: event.target.value })}
              />
            </label>
            <label className={labelClass}>
              Activo
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
              />
            </label>
            <label className={labelClass}>
              Precio de costo
              <input
                className={inputClass}
                value={form.cost_price}
                inputMode="decimal"
                onChange={(event) => setForm({ ...form, cost_price: event.target.value })}
              />
            </label>
            <label className={labelClass}>
              Precio de venta
              <input
                className={inputClass}
                value={form.sale_price}
                inputMode="decimal"
                onChange={(event) => setForm({ ...form, sale_price: event.target.value })}
              />
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" className={buttonClass} disabled={busy}>
                {editingId ? "Guardar cambios" : "Crear producto"}
              </button>
              {editingId ? (
                <button type="button" className={buttonClass} onClick={cancelEdit}>
                  Cancelar
                </button>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}

      {props.canWrite ? (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold">Registrar movimiento</h2>
          <form onSubmit={handleMovementSubmit} className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Producto *
              <select
                className={inputClass}
                value={movement.product_id}
                onChange={(event) => setMovement({ ...movement, product_id: event.target.value })}
                required
              >
                <option value="">Seleccione…</option>
                {products.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.sku} — {row.name} (stock {row.stock_qty})
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Tipo *
              <select
                className={inputClass}
                value={movement.type}
                onChange={(event) => setMovement({ ...movement, type: event.target.value })}
              >
                <option value="IN">Entrada (IN)</option>
                <option value="OUT">Salida (OUT)</option>
                <option value="ADJUST">Ajuste: fija el nivel (ADJUST)</option>
              </select>
            </label>
            <label className={labelClass}>
              Cantidad * {movement.type === "ADJUST" ? "(nivel que se fija)" : ""}
              <input
                className={inputClass}
                value={movement.qty}
                inputMode="numeric"
                onChange={(event) => setMovement({ ...movement, qty: event.target.value })}
                required
              />
            </label>
            <label className={labelClass}>
              Motivo *
              <input
                className={inputClass}
                value={movement.reason}
                onChange={(event) => setMovement({ ...movement, reason: event.target.value })}
                placeholder="Compra a proveedor, venta, conteo físico…"
                required
              />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className={buttonClass} disabled={busy}>
                Registrar
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {kardex ? (
        <section className={sectionClass}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              Kardex: {kardex.product.sku} — {kardex.product.name}
            </h2>
            <button type="button" className="text-sm underline" onClick={() => setKardex(null)}>
              Cerrar
            </button>
          </div>
          {kardex.rows.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Sin movimientos registrados.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-300 dark:border-slate-700">
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 pr-3">Tipo</th>
                    <th className="py-2 pr-3">Cantidad</th>
                    <th className="py-2">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {kardex.rows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-200 dark:border-slate-800">
                      <td className="py-2 pr-3">{new Date(row.created_at).toLocaleString("es-CO")}</td>
                      <td className="py-2 pr-3 font-mono">{row.type}</td>
                      <td className="py-2 pr-3">{row.qty}</td>
                      <td className="py-2">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
