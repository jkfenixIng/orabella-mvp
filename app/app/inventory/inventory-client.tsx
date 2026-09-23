"use client";

import { useMemo, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { Activity, PackageOpen, PackagePlus, Pencil, X } from "lucide-react";
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
import { Badge } from "@/src/components/ui/lib/badge";
import { Button } from "@/src/components/ui/lib/button";
import { Card, CardContent, CardHeader } from "@/src/components/ui/lib/card";
import { Checkbox } from "@/src/components/ui/lib/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";

const inputClass = cn(
  "h-10 w-full rounded-lg border border-color bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-all duration-200 placeholder:text-text-tertiary focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20 dark:border-border-color dark:bg-surface dark:text-text-primary",
);
const labelClass = cn("flex flex-col gap-1 text-sm");
const buttonClass = cn("gap-2");
const sectionClass = cn("rounded-xl border border-color bg-surface p-4 shadow-sm");
const errorClass = cn("text-sm text-error-600 dark:text-error-400");
const okClass = cn("text-sm text-success-600 dark:text-success-600");
const tableHeaderClass = cn("border-b border-color-2 dark:border-color");
const tableRowClass = cn("border-b border-color-2 dark:border-color");
const tableCellClass = cn("py-2 pr-3");
const mutedTextClass = cn("text-sm text-text-secondary");

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

function emptyProductForm() {
  return {
    sku: "",
    name: "",
    description: "",
    min_stock: "0",
    cost_price: "",
    sale_price: "",
    commission_value: "",
    is_active: true,
  };
}

function emptyMovementForm() {
  return { product_id: "", type: "IN", qty: "", reason: "" };
}

interface InventoryClientProps {
  sedeId: string;
  initialProducts: ProductRow[];
  initialAlertIds: string[];
  canWrite: boolean;
  canAdmin: boolean;
}

export function InventoryClient(props: InventoryClientProps) {
  const [products, setProducts] = useState(props.initialProducts);
  const [alertIds, setAlertIds] = useState<Set<string>>(new Set(props.initialAlertIds));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Transición para los cambios de vista (kardex): la UI no se congela
  // mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyProductForm());
  const [movement, setMovement] = useState(emptyMovementForm());
  const [movementProductQuery, setMovementProductQuery] = useState("");
  const movementProductOptions = useMemo(() => {
    const needle = movementProductQuery.trim().toLowerCase();
    if (needle === "") return products;
    return products.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.sku.toLowerCase().includes(needle),
    );
  }, [products, movementProductQuery]);
  const [kardex, setKardex] = useState<{ product: ProductRow; rows: MovementRow[] } | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return products;
    return products.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.sku.toLowerCase().includes(needle),
    );
  }, [products, query]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const skuTaken =
    form.sku.trim() !== "" &&
    products.some(
      (row) => row.sku.trim().toLowerCase() === form.sku.trim().toLowerCase() && row.id !== editingId,
    );

  async function refresh() {
    const result: ActionResult<ProductRow[]> = await listProductsAction(props.sedeId);
    if (result.success) {
      setProducts(result.data);
      setAlertIds(
        new Set(result.data.filter((row) => row.stock_qty <= row.min_stock).map((row) => row.id)),
      );
    }
  }

  function startProductDialog(row?: ProductRow) {
    setEditingId(row?.id ?? null);
    setForm(
      row
        ? {
            sku: row.sku,
            name: row.name,
            description: row.description ?? "",
            min_stock: String(row.min_stock),
    cost_price: row.cost_price == null ? "" : String(row.cost_price),
    sale_price: row.sale_price == null ? "" : String(row.sale_price),
    commission_value: row.commission_value == null ? "" : String(row.commission_value),
            is_active: row.is_active,
          }
        : emptyProductForm(),
    );
    setError(null);
    setNotice(null);
    setProductDialogOpen(true);
  }

  function startEdit(row: ProductRow) {
    startProductDialog(row);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyProductForm());
    setProductDialogOpen(false);
  }

  function openMovementDialog() {
    setMovement(emptyMovementForm());
    setMovementProductQuery("");
    setMovementDialogOpen(true);
  }

  function cancelMovement() {
    setMovement(emptyMovementForm());
    setMovementDialogOpen(false);
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
    commission_value: toNumber(form.commission_value),
      is_active: form.is_active,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setNotice(editingId ? "Producto actualizado." : "Producto creado.");
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
    setMovement(emptyMovementForm());
    await refresh();
    if (kardex && kardex.product.id === result.data.movement.product_id) {
      await showKardex(kardex.product);
    }
    setMovementDialogOpen(false);
  }

  function showKardex(row: ProductRow) {
    startViewTransition(async () => {
      setError(null);
      const result: ActionResult<MovementRow[]> = await getKardexAction(row.id);
      if (!result.success) {
        setError(result.message);
        return;
      }
      setKardex({ product: row, rows: result.data });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass}>
        <Label htmlFor="inventory-search" className={labelClass}>
          Buscar por nombre o SKU
          <Input
            id="inventory-search"
            className={inputClass}
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { setPage(0); setQuery(event.target.value); }}
            placeholder="Ej. shampoo o SH-001"
          />
        </Label>
      </section>

      {props.canWrite ? (
        <div className="sticky top-0 z-10 flex flex-wrap gap-2 rounded-xl border border-color bg-surface p-3 shadow-sm">
          <Button type="button" onClick={() => setProductDialogOpen(true)}>
            <PackagePlus className="h-4 w-4" aria-hidden="true" />
            Crear producto
          </Button>
          <Button type="button" variant="outline" onClick={openMovementDialog}>
            <PackageOpen className="h-4 w-4" aria-hidden="true" />
            Registrar movimiento
          </Button>
        </div>
      ) : null}

      <Dialog
        open={productDialogOpen}
        onOpenChange={(open: boolean) => {
          if (!open) cancelEdit();
          else setProductDialogOpen(open);
        }}
      >
        <div className="flex flex-col gap-6">
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
              <table className={cn("w-full text-left text-sm", "min-w-[720px]")}>
                <thead>
                  <tr className={tableHeaderClass}>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      SKU
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Nombre
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Stock
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Mínimo
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Costo
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Venta
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Comisión
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Estado
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((row) => (
                    <tr key={row.id} className={tableRowClass}>
                      <td className={cn(tableCellClass, "font-mono")}>{row.sku}</td>
                      <td className={tableCellClass}>
                        {row.name}{" "}
                        {alertIds.has(row.id) ? (
                          <Badge variant="warning" size="sm">
                            Bajo mínimo
                          </Badge>
                        ) : null}
                      </td>
                      <td className={tableCellClass}>{row.stock_qty}</td>
                      <td className={tableCellClass}>{row.min_stock}</td>
                      <td className={tableCellClass}>{formatMoney(row.cost_price)}</td>
                      <td className={tableCellClass}>{formatMoney(row.sale_price)}</td>
                      <td className={tableCellClass}>{formatMoney(row.commission_value)}</td>
                      <td className={tableCellClass}>{row.is_active ? "Activo" : "Inactivo"}</td>
                      <td className={tableCellClass}>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isViewPending}
                            onClick={() => showKardex(row)}
                            className={cn("gap-1.5", isViewPending && "opacity-50")}
                          >
                            {isViewPending ? (
                              <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Activity className="h-4 w-4" aria-hidden="true" />
                            )}
                            {isViewPending ? "Cargando…" : "Kardex"}
                          </Button>
                          {props.canAdmin ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(row)}
                              className="gap-1.5"
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              Editar
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={8} className={cn("py-4 text-sm text-text-secondary")}>
                        Sin productos para esta búsqueda.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {pageCount > 1 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className={mutedTextClass}>
                  Página {safePage + 1} de {pageCount} · {visible.length} productos
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage === 0}
                    onClick={() => setPage(safePage - 1)}
                  >
                    Anterior
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage(safePage + 1)}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <DialogContent className="max-w-2xl">
          <Card className="overflow-hidden">
            <CardHeader>
              <DialogHeader>
                <DialogTitle>{editingId ? "Editar producto" : "Crear producto"}</DialogTitle>
                <DialogDescription>
                  {editingId
                    ? "Actualiza los datos del producto."
                    : "Completa los campos obligatorios para registrar un producto."}
                </DialogDescription>
              </DialogHeader>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleProductSubmit} className="grid gap-3 sm:grid-cols-2">
                <Label htmlFor="product-sku" className={labelClass}>
                  SKU *
                  <Input
                    id="product-sku"
                    className={inputClass}
                    value={form.sku}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, sku: event.target.value })}
                    placeholder="SH-001"
                    required
                  />
                  <span className="text-xs text-text-secondary">
                    Código único por sede (p. ej. SH-001 para shampoo).
                  </span>
                  {skuTaken ? (
                    <span role="alert" className="text-xs text-error">
                      Este SKU ya existe en otro producto.
                    </span>
                  ) : null}
                </Label>
                <Label htmlFor="product-name" className={labelClass}>
                  Nombre *
                  <Input
                    id="product-name"
                    className={inputClass}
                    value={form.name}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, name: event.target.value })}
                    placeholder="Shampoo"
                    required
                  />
                </Label>
                <Label htmlFor="product-description" className={cn(labelClass, "sm:col-span-2")}>
                  Descripción
                  <Input
                    id="product-description"
                    className={inputClass}
                    value={form.description}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, description: event.target.value })}
                  />
                </Label>
                <Label htmlFor="product-min-stock" className={labelClass}>
                  Stock mínimo
                  <Input
                    id="product-min-stock"
                    className={inputClass}
                    value={form.min_stock}
                    inputMode="numeric"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, min_stock: event.target.value })}
                  />
                </Label>
                <Label htmlFor="product-is-active" className={cn(labelClass, "flex-row items-center")}>
                  <Checkbox id="product-is-active" checked={form.is_active} onCheckedChange={(checked: boolean | "indeterminate") => setForm({ ...form, is_active: checked === true })} />
                  Activo
                </Label>
                <Label htmlFor="product-cost-price" className={labelClass}>
                  Precio de costo
                  <Input
                    id="product-cost-price"
                    className={inputClass}
                    value={formatMoneyInput(form.cost_price)}
                    inputMode="numeric"
                    placeholder="25.000"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, cost_price: stripMoneyInput(event.target.value) })}
                  />
                </Label>
                <Label htmlFor="product-sale-price" className={labelClass}>
                  Precio de venta
                  <Input
                    id="product-sale-price"
                    className={inputClass}
                    value={formatMoneyInput(form.sale_price)}
                    inputMode="numeric"
                    placeholder="35.000"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, sale_price: stripMoneyInput(event.target.value) })}
                  />
                </Label>
                <Label htmlFor="product-commission-value" className={labelClass}>
                  Comisión sugerida
                  <Input
                    id="product-commission-value"
                    className={inputClass}
                    value={formatMoneyInput(form.commission_value)}
                    inputMode="numeric"
                    placeholder="Ej. 5.000"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, commission_value: stripMoneyInput(event.target.value) })}
                  />
                </Label>
                <DialogFooter className="sm:col-span-2">
                  <Button type="button" variant="outline" onClick={cancelEdit}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={busy || skuTaken} className={buttonClass}>
                    {editingId ? "Guardar cambios" : "Crear producto"}
                  </Button>
                </DialogFooter>
              </form>
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      {props.canWrite ? (
        <Dialog open={movementDialogOpen} onOpenChange={(open: boolean) => { if (!open) cancelMovement(); else setMovementDialogOpen(open); }}>
          <DialogContent className="max-w-2xl">
            <Card className="overflow-hidden">
              <CardHeader>
                <DialogHeader>
                  <DialogTitle>Registrar movimiento</DialogTitle>
                  <DialogDescription>
                    Selecciona un producto y completa los datos del movimiento.
                  </DialogDescription>
                </DialogHeader>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleMovementSubmit} className="grid gap-3 sm:grid-cols-2">
                  <Label className={labelClass}>
                    Producto *
                    <Select required value={movement.product_id} onValueChange={(value: string) => setMovement({ ...movement, product_id: value })}>
                      <SelectTrigger className={inputClass}>
                        <SelectValue placeholder="Seleccione…" />
                      </SelectTrigger>
                      <SelectContent>
                        <div className="p-2">
                          <Input
                            placeholder="Filtrar por nombre o SKU…"
                            value={movementProductQuery}
                            onChange={(event: ChangeEvent<HTMLInputElement>) => setMovementProductQuery(event.target.value)}
                            onKeyDown={(event) => event.stopPropagation()}
                          />
                        </div>
                        <SelectItem value="">Seleccione…</SelectItem>
                        {movementProductOptions.map((row) => (
                          <SelectItem key={row.id} value={row.id}>
                            {row.sku} — {row.name} (stock {row.stock_qty})
                          </SelectItem>
                        ))}
                        {movementProductOptions.length === 0 && (
                          <p className="px-2 py-1 text-xs text-text-secondary">Sin coincidencias.</p>
                        )}
                      </SelectContent>
                    </Select>
                  </Label>
                  <Label className={labelClass}>
                    Tipo *
                    <Select value={movement.type} onValueChange={(value: string) => setMovement({ ...movement, type: value })}>
                      <SelectTrigger className={inputClass}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="IN">Entrada (IN)</SelectItem>
                        {props.canAdmin ? (
                          <>
                            <SelectItem value="OUT">Salida (OUT)</SelectItem>
                            <SelectItem value="ADJUST">Ajuste: fija el nivel (ADJUST)</SelectItem>
                          </>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </Label>
                  <Label className={labelClass}>
                    Cantidad * {movement.type === "ADJUST" ? "(nivel que se fija)" : ""}
                    <Input
                      className={inputClass}
                      value={movement.qty}
                      inputMode="numeric"
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setMovement({ ...movement, qty: event.target.value })}
                      required
                    />
                  </Label>
                  <Label className={labelClass}>
                    Motivo *
                    <Input
                      className={inputClass}
                      value={movement.reason}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setMovement({ ...movement, reason: event.target.value })}
                      placeholder="Compra a proveedor, venta, conteo físico…"
                      required
                    />
                  </Label>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={cancelMovement}>
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={busy} className={buttonClass}>
                      Registrar
                    </Button>
                  </DialogFooter>
                </form>
              </CardContent>
            </Card>
          </DialogContent>
        </Dialog>
      ) : null}

      {kardex ? (
        <section className={sectionClass} aria-busy={isViewPending}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              Kardex: {kardex.product.sku} — {kardex.product.name}
            </h2>
            <Button type="button" variant="ghost" size="sm" onClick={() => setKardex(null)} className="gap-1.5">
              <X className="h-4 w-4" aria-hidden="true" />
              Cerrar
            </Button>
          </div>
          {kardex.rows.length === 0 ? (
            <p className={cn("mt-2", mutedTextClass)}>Sin movimientos registrados.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className={cn("w-full text-left text-sm", "min-w-[520px]")}>
                <thead>
                  <tr className={tableHeaderClass}>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Fecha
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Tipo
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Cantidad
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Motivo
                    </th>
                    <th className={cn(tableCellClass, "text-left")} scope="col">
                      Quién
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {kardex.rows.map((row) => (
                    <tr key={row.id} className={tableRowClass}>
                      <td className={tableCellClass}>{new Date(row.created_at).toLocaleString("es-CO")}</td>
                      <td className={cn(tableCellClass, "font-mono")}>{row.type}</td>
                      <td className={tableCellClass}>{row.qty}</td>
                      <td className={tableCellClass}>{row.reason}</td>
                      <td className={tableCellClass}>{row.actor_name ?? "—"}</td>
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
