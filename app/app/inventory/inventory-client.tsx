"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ChangeEvent, type FormEvent, type RefObject } from "react";
import { toast } from "sonner";
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
import { proposeSku } from "@/src/features/inventory/schemas";
import { Alert } from "@/src/components/ui/lib/alert";
import { Badge } from "@/src/components/ui/lib/badge";
import { Button } from "@/src/components/ui/lib/button";
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
import { formatMoney, formatMoneyInput, stripMoneyInput, stripQuantityInput } from "@/src/shared/lib/money";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { toNumber } from "@/src/shared/lib/format";
import {
  inputClass,
  labelClass,
  mutedTextClass,
  sectionClass,
} from "@/src/shared/lib/ui-styles";

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

/**
 * CL-6: marca nueva para un intento de movimiento manual.
 * `crypto.randomUUID()` está en el navegador (contexto seguro) y en el runtime
 * de Node; no hace falta ninguna dependencia nueva.
 *
 * El uuid viaja en el cuerpo como `idempotency_key`. El servidor lo guarda con
 * el movimiento y, si vuelve un envío con la MISMA marca para el MISMO producto,
 * devuelve el movimiento que ya existe en vez de escribir un segundo y mover el
 * stock dos veces.
 */
function newMovementKey(): string {
  return crypto.randomUUID();
}

/* --------------------------------------------------------------------------
   El desplazamiento de la barra de acciones.

   MEDIDO, Chromium, 320x568, con la sesión y scrolleando hasta `scrollY 400` de
   412: la barra se anclaba en `top 0` y el encabezado del shell ocupa
   `0 → 63` con `z-30` contra el `z-10` de la barra. `elementFromPoint` en el
   centro de «Crear producto» devolvía el enlace «Orabella» del encabezado, o
   sea que el botón NO era clicable. A 360 y 390 no hay recorrido suficiente
   para llegar a ese estado, y arriba de `lg` el encabezado no existe.

   El arreglo NO es un segundo número. La altura del encabezado no es una
   constante del proyecto: sale de SU padding y del botón del menú, así que
   escribir `top-[63px]` acá sería cablear un valor que otro archivo puede
   cambiar. La barra se ancla a la altura MEDIDA del propio encabezado, que es
   la misma fuente de la que sale la de él.

   Y falla CERRADO, no abierto: la referencia `var(--shell-header-height)` va
   SIN valor de reserva. Antes de medir —o si el encabezado no aparece— la
   variable no está definida, la declaración `top` queda inválida en tiempo de
   valor calculado y `top` queda en `auto`: la barra sigue siendo `sticky`
   pero no tiene contra qué anclarse, o sea que aparece en su sitio en el flujo
   en vez de meterse debajo del encabezado. Un `var(--x, 0px)` sería exactamente
   el defecto original escrito con otra sintaxis.

   Arriba de `lg` el encabezado es `lg:hidden`, así que mide 0 y la barra se
   ancla en 0, que es lo correcto porque ahí no hay con quién competir.
   -------------------------------------------------------------------------- */

/** El NOMBRE de la variable CSS del desplazamiento, en un solo lugar. */
const SHELL_HEADER_OFFSET_VAR = "--shell-header-height";

/**
 * El encabezado ANCLADO del shell (`src/shared/components/main-nav.tsx`), y no
 * `header` a secas: `<header>` también es el del título de la página
 * (`PageHeader`), que no se ancla y cuya altura no es la que hay que librar.
 */
const SHELL_HEADER_SELECTOR = "header.sticky";

/**
 * Escribe en la barra el alto medido del encabezado del shell.
 *
 * `ResizeObserver` y no una medida sola: el alto del encabezado cambia si
 * cambia el padding, la tipografía o el botón del menú, y una medida tomada al
 * montar se quedaría vieja sin avisar.
 *
 * El `style` en línea nombra la variable con su LITERAL a propósito —el valor
 * de un `style` no se puede componer con una constante sin volverlo ilegible— y
 * la guarda de `inventory-dialog-footer.test.ts` comprueba que ese literal y el
 * `setProperty` de acá nombran la MISMA variable.
 */
function useShellHeaderOffset(barra: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const elemento = barra.current;
    const encabezado = document.querySelector<HTMLElement>(SHELL_HEADER_SELECTOR);
    if (elemento === null || encabezado === null) return;
    const medir = () => {
      elemento.style.setProperty(SHELL_HEADER_OFFSET_VAR, `${Math.ceil(encabezado.getBoundingClientRect().height)}px`);
    };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(encabezado);
    return () => observador.disconnect();
  }, [barra]);
}

interface InventoryClientProps {
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
  const [busy, setBusy] = useState(false);
  // Transición para los cambios de vista (kardex): la UI no se congela
  // mientras la server action responde.
  const [isViewPending, startViewTransition] = useTransition();
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyProductForm());
  const [movement, setMovement] = useState(emptyMovementForm());
  /**
   * CL-6: la marca del intento de movimiento en curso. Se acuña al empezar el
   * intento (la primera vez que se envía) y se CONSERVA si el intento falla: el
   * reintento —volver a enviar el mismo diálogo— tiene que llevar la misma para
   * que el servidor reconozca la repetición. Se suelta al ÉXITO y al CANCELAR,
   * porque el siguiente envío es OTRO intento y merece otra marca.
   */
  const movementKeyRef = useRef<string | null>(null);
  const [movementProductQuery, setMovementProductQuery] = useState("");
  /**
   * La barra de acciones se ancla al alto MEDIDO del encabezado del shell, no
   * a un número escrito acá. Ver `SHELL_HEADER_OFFSET_VAR`.
   */
  const barraAccionesRef = useRef<HTMLDivElement>(null);
  useShellHeaderOffset(barraAccionesRef);
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
    const result: ActionResult<ProductRow[]> = await listProductsAction();
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

  /**
   * AYUDA del SKU: el usuario presiona el botón y obtiene un SKU propuesto a
   * partir del NOMBRE del producto, libre de choques con los SKU ya cargados.
   *
   * Se calcula contra `products` excluyendo el producto en edición: es la MISMA
   * regla que el aviso `skuTaken` (que compara por `row.id !== editingId`), así
   * que después de generar el aviso lee limpio y Guardar no queda bloqueado.
   * Sólo cambia el campo al presionar: no rellena nada al abrir el diálogo.
   */
  function proposeSkuFromName() {
    const takenSkus = products
      .filter((row) => row.id !== editingId)
      .map((row) => row.sku);
    setForm({ ...form, sku: proposeSku(form.name, takenSkus) });
  }

  function openMovementDialog() {
    setMovement(emptyMovementForm());
    setMovementProductQuery("");
    setError(null);
    // Intento NUEVO: marca nueva (si no, el envío devolvería el movimiento de
    // un intento anterior).
    movementKeyRef.current = null;
    setMovementDialogOpen(true);
  }

  function cancelMovement() {
    setMovement(emptyMovementForm());
    // CL-6: se abandona el intento, así que la marca se suelta: el próximo
    // movimiento es otro intento.
    movementKeyRef.current = null;
    setMovementDialogOpen(false);
  }

  async function handleProductSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const minStock = toNumber(form.min_stock);
    const result: ActionResult<ProductRow> = await upsertProductAction({
      ...(editingId ? { id: editingId } : {}),
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
    // EVENTO: el alta acaba de pasar, así que va por el canal efímero (toast)
    // y no como texto pegado a la pantalla. Antes era un `notice` de estado.
    toast.success(editingId ? "Producto actualizado." : "Producto creado.");
    cancelEdit();
    await refresh();
  }

  async function handleMovementSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const qty = toNumber(movement.qty);
    // CL-6: la marca del INTENTO. Se acuña al empezar y se conserva si el
    // intento falla: el reintento (enviar otra vez, sobre el mismo diálogo)
    // tiene que llevar la misma para que el servidor reconozca la repetición.
    const movementKey = movementKeyRef.current ?? newMovementKey();
    movementKeyRef.current = movementKey;
    const result: ActionResult<{ movement: MovementRow; stock_qty: number }> =
      await registerMovementAction({
        product_id: movement.product_id || undefined,
        type: movement.type,
        qty: qty ?? 0,
        reason: movement.reason,
        idempotency_key: movementKey,
      });
    setBusy(false);
    if (!result.success) {
      // El intento NO terminó: se conserva la marca para el reintento.
      setError(result.message);
      return;
    }
    // El intento terminó bien: el próximo movimiento es OTRO intento y merece
    // otra marca (si no, devolvería este mismo movimiento).
    movementKeyRef.current = null;
    // EVENTO: el movimiento acaba de registrarse; efímero, no estado.
    toast.success(`Movimiento registrado. Stock actual: ${result.data.stock_qty}.`);
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
      {error ? (
        // ESTADO: el fallo al cargar o al guardar sigue siendo el caso mientras
        // no se corrija, así que va inline y persistente. `destructive` deriva
        // role="alert" asertivo, el mismo anuncio que el `<p role="alert">`
        // escribía a mano antes.
        <Alert variant="destructive">{error}</Alert>
      ) : null}

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
        /*
          LA BARRA, midiendo en vez de suponer. Antes era `sticky top-0`, que
          compite con el `sticky top-0 z-30` del encabezado del shell y a 320
          terminaba DEBAJO de él: medido, `elementFromPoint` en el centro de
          «Crear producto» devolvía el enlace «Orabella» del encabezado, o sea
          que el botón no era clicable.

          El `top` sale de `var(--shell-header-height)`, SIN reserva: sin valor
          medido, `top` queda en `auto` y la barra no se ancla en 0. El nombre
          de la variable y suMEDIDA viven en `useShellHeaderOffset`.
        */
        <div
          ref={barraAccionesRef}
          style={{ top: "var(--shell-header-height)" }}
          className="sticky z-10 flex flex-wrap gap-2 rounded-lg border border-border-color bg-surface p-3 shadow-sm dark:border-border-color-2"
        >
          <Button type="button" onClick={() => startProductDialog()}>
            <PackagePlus className="h-4 w-4" aria-hidden="true" />
            Crear producto
          </Button>
          <Button type="button" variant="outline" onClick={openMovementDialog}>
            <PackageOpen className="h-4 w-4" aria-hidden="true" />
            Registrar movimiento
          </Button>
        </div>
      ) : null}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold">Productos ({visible.length})</h2>
        {visible.length === 0 ? (
          // VACÍO: el estado base de la tabla cuando la búsqueda no devuelve
          // nada. Describe lo esperado, no bloquea nada y nunca anunció nada
          // (no tenía rol), así que NO se envuelve en `Alert`: envolverlo
          // AGREGARÍA un anuncio que hoy no existe.
          <p className="mt-3 text-sm text-text-tertiary">Sin productos para esta búsqueda.</p>
        ) : (
          // R19 + R38: la lista de productos. Antes era una `<table>` con un
          // piso de `min-w-[760px]` dentro de un carril de `overflow-x-auto` de
          // ~238 px útiles en un teléfono: las dos últimas columnas —`Estado` y
          // `Acciones`— nunca entraban, y con ellas `Kardex` y `Editar`, que es
          // lo que esta pantalla existe para hacer. Medido: 6 botones de fila
          // fuera de pantalla en los cuatro anchos angostos, sin
          // `elementFromPoint` que los devolviera, y las nueve celdas leídas sin
          // una sola etiqueta.
          //
          // Ahora es el patrón de `invoices-client.tsx` y
          // `vouchers-client.tsx` (R38), el mismo y no otro: abajo de `sm` cada
          // fila es una TARJETA de cinco renglones y cada valor lleva su rótulo
          // —la palabra del encabezado, la misma, y por eso las dos superficies
          // no pueden divergir—; arriba de `sm` cada hoja se ancla a su columna
          // con `sm:col-start-N` y la grilla conserva las NUEVE columnas de hoy,
          // en su orden. La escala se declara una vez por superficie, así que no
          // hay piso de ancho inventado ni carril que arrastrar.
          //
          // PRIORIDAD DE LA TARJETA —lo que hay que ver para decidir sobre un
          // producto en el mostrador, en el orden en que se lee:
          // 1. QUÉ PRODUCTO ES (Nombre + SKU): sin identidad no hay decisión.
          //    El nombre manda y el código lo acompaña a la derecha; el chip
          //    «Bajo mínimo» se queda donde estaba, dentro del nombre.
          // 2. QUÉ HAY DE SU STOCK (Stock + Mínimo): el número que hay, al lado
          //    del umbral que dispara la alerta. Juntos en un renglón se leen de
          //    un vistazo: «Stock: 3» junto a «Mínimo: 5» ya es la alerta.
          // 3. A QUÉ SE VENDE (Venta + Costo): primero el precio del mostrador,
          //    después el costo que lo sostiene.
          // 4. LA COMISIÓN y el ESTADO: el resto del dinero y la bandera de
          //    vida del producto.
          // 5. LA ACCIÓN (Acciones): su propio renglón, con sus dos botones
          //    envueltos, y sin gesto horizontal para llegar.
          // La DESCRIPCIÓN no entra: es un campo de formulario, no una columna
          // de esta lista, y vive en el diálogo de alta y de edición.
          <div className="mt-3 overflow-hidden rounded-lg border border-color-2 dark:border-border-color">
            {/* El encabezado nombra las nueve columnas y sólo existe arriba de
                `sm`: abajo la fila dice cada rótulo con su propio valor. */}
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)_minmax(0,0.35fr)_minmax(0,0.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(5.75rem,1.2fr)] gap-2 border-b border-color-2 bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary sm:grid dark:border-border-color"
            >
              <span>SKU</span>
              <span>Nombre</span>
              <span>Stock</span>
              <span>Mínimo</span>
              <span>Costo</span>
              <span>Venta</span>
              <span>Comisión</span>
              <span>Estado</span>
              <span className="text-center">Acciones</span>
            </div>
            <ul className="flex flex-col divide-y divide-color-2 dark:divide-border-color">
              {paged.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)_minmax(0,0.35fr)_minmax(0,0.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(5.75rem,1.2fr)] sm:items-center sm:gap-2"
                >
                  {/* Las cinco líneas de la tarjeta móvil. Abajo de `sm` cada
                      hoja es un renglón con su rótulo —la palabra del
                      encabezado, la misma— y cada envoltorio `sm:contents` se
                      borra de la grilla de arriba, donde la hoja se queda en la
                      columna que su `sm:col-start-N` fija. El orden del DOM es
                      el de la tarjeta, NO el de las columnas: por eso el pineo
                      explícito. */}
                  <span className="flex items-center justify-between gap-2 sm:contents">
                    <span className="break-words text-sm text-text-primary sm:col-start-2 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Nombre: </span>
                      {row.name}{" "}
                      {alertIds.has(row.id) ? (
                        <Badge variant="warning" size="sm">
                          Bajo mínimo
                        </Badge>
                      ) : null}
                    </span>
                    <span className="font-mono text-sm text-text-primary sm:col-start-1 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">SKU: </span>
                      {row.sku}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 sm:contents">
                    <span className="whitespace-nowrap text-sm font-medium text-text-primary sm:col-start-3 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Stock: </span>
                      {row.stock_qty}
                    </span>
                    <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-4 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Mínimo: </span>
                      {row.min_stock}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 sm:contents">
                    <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-6 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Venta: </span>
                      {formatMoney(row.sale_price)}
                    </span>
                    <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-5 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Costo: </span>
                      {formatMoney(row.cost_price)}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 sm:contents">
                    <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-7 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Comisión: </span>
                      {formatMoney(row.commission_value)}
                    </span>
                    <span className="text-sm text-text-primary sm:col-start-8 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Estado: </span>
                      {row.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </span>
                  {/* La acción en su propio renglón: `flex-wrap` para que los
                      dos botones quepan en 320 px sin empujar la fila. */}
                  <span className="flex flex-wrap items-center gap-2 sm:contents">
                    <span className="flex flex-wrap items-center gap-2 sm:col-start-9 sm:row-start-1 sm:justify-center">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Acciones: </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isViewPending}
                        onClick={() => showKardex(row)}
                      >
                        <Activity
                          className={cn("h-4 w-4", isViewPending && "animate-spin")}
                          aria-hidden="true"
                        />
                        {isViewPending ? "Cargando…" : "Kardex"}
                      </Button>
                      {props.canAdmin ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(row)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                          Editar
                        </Button>
                      ) : null}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
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

      <Dialog
        open={productDialogOpen}
        onOpenChange={(open: boolean) => {
          if (!open) cancelEdit();
          else setProductDialogOpen(open);
        }}
      >
        {/*
          LA ESTRUCTURA, y es la misma de `FormDialog` y de la factura: el
          diálogo es una COLUMNA (`flex flex-col overflow-y-hidden`) que no
          scrollea ella misma, la hoja cede el alto (`min-h-0`) y las tres
          piezas son encabezado (fijo), MEDIO (lo único que scrollea) y pie
          (fijo, FUERA del medio).

          MEDIDO antes, con la sesión y sin enviar nada: 839 px de contenido en
          una caja de 534 a 320x568 y en una de 706 a 360x740, con NINGÚN
          scroller interno — scrolleaba el `DialogContent` — y el envío en
          `y 744-788`: fuera de la caja del diálogo a los dos anchos, o sea que
          guardar exigía scroll INTERNO del modal.

          Y SIN `sticky` en el pie, a propósito: el bloque contenedor de un
          ítem de grilla es su ÁREA, sin recorrido para anclarse, así que un
          pie pegado con `position: sticky` se midió funcionando en Chromium y
          quedaría colgando de la palabra de otro motor. La corrección vive en
          el árbol.
        */}
        <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="shrink-0">
              <DialogTitle>{editingId ? "Editar producto" : "Crear producto"}</DialogTitle>
              <DialogDescription>
                {editingId
                  ? "Actualiza los datos del producto."
                  : "Completa los campos obligatorios para registrar un producto."}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleProductSubmit} className="flex min-h-0 flex-1 flex-col">
              {/* El MEDIO: lo único que scrollea. `min-h-0` para que pueda encogerse por debajo de sus campos; sin eso el `flex-1` no cede y el pie se vuelve a ir de la caja. */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Label htmlFor="product-sku" className={labelClass}>
              SKU *
              <span className="flex items-center gap-2">
                <Input
                  id="product-sku"
                  className={cn(inputClass, "flex-1")}
                  value={form.sku}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, sku: event.target.value })}
                  placeholder="SH-001"
                  required
                />
                {/*
                  AYUDA: para quien no sabe qué SKU escribir. Propone uno a
                  partir del nombre del producto y lo escribe en el campo. Es
                  un evento del usuario (`type="button"` para no enviar el
                  formulario), no un relleno automático.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  id="product-sku-propose"
                  title="Genera un SKU único a partir del nombre del producto."
                  aria-label="Generar SKU a partir del nombre del producto"
                  onClick={proposeSkuFromName}
                >
                  Generar
                </Button>
              </span>
              <span className="text-xs text-text-tertiary">
                Código único en la instalación (p. ej. SH-001 para shampoo).
              </span>
              {skuTaken ? (
                // ESTADO que bloquea: con un SKU ya tomado el botón Guardar
                // queda deshabilitado, y el aviso sigue siendo el caso hasta
                // que se corrija.
                //
                // `role="status"` explícito (polite): este aviso se DERIVA del
                // formulario mientras el usuario escribe el SKU, no es el
                // desenlace de una acción enviada. `destructive` derivaría
                // `alert` (asertivo), y una región asertiva que interrumpe a
                // quien está tecleando es el antipatrón de sobreanuncio. Es el
                // mismo tratamiento que los dos avisos derivados en vivo de
                // nómina: una clase de mensaje, una sola ARIA.
                <Alert variant="destructive" role="status" className="text-xs">
                  Este SKU ya existe en otro producto.
                </Alert>
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
                onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, min_stock: stripQuantityInput(event.target.value) })}
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
            {error ? (
              <Alert variant="destructive" className="sm:col-span-2">
                {error}
              </Alert>
            ) : null}
                </div>
              </div>
              {/* El PIE: `shrink-0` y FUERA del medio, así que la acción primaria y Cancelar están siempre a la vista sin una sola línea de scroll. Última pieza del `<form>` —igual que en `FormDialog`—, o sea que está EN EL FLUJO y no cubre el último campo. */}
              <DialogFooter className="shrink-0">
              <Button type="button" variant="outline" onClick={cancelEdit}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy || skuTaken}>
                {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear producto"}
              </Button>
            </DialogFooter>
          </form>
          </div>
        </DialogContent>
      </Dialog>

      {props.canWrite ? (
        <Dialog open={movementDialogOpen} onOpenChange={(open: boolean) => { if (!open) cancelMovement(); else setMovementDialogOpen(open); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Registrar movimiento</DialogTitle>
              <DialogDescription>
                Selecciona un producto y completa los datos del movimiento.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleMovementSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                      // VACÍO del filtro: mismo caso que el de la tabla. Texto
                      // plano, sin `role` y fuera de `Alert`.
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
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setMovement({ ...movement, qty: stripQuantityInput(event.target.value) })}
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
              {error ? (
                <Alert variant="destructive" className="sm:col-span-2">
                  {error}
                </Alert>
              ) : null}
              <DialogFooter className="sm:col-span-2">
                <Button type="button" variant="outline" onClick={cancelMovement}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Registrando…" : "Registrar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {kardex ? (
        <section className={sectionClass} aria-busy={isViewPending}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="text-lg font-semibold">
              Kardex: {kardex.product.sku} — {kardex.product.name}
            </h2>
            <Button type="button" variant="ghost" size="sm" onClick={() => setKardex(null)}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cerrar
            </Button>
          </div>
          {kardex.rows.length === 0 ? (
            // VACÍO del kardex: mismo criterio que los otros dos. Texto plano,
            // sin anuncio que agregar.
            <p className="mt-3 text-sm text-text-tertiary">Sin movimientos registrados.</p>
          ) : (
            // R19 + R38, la MISMA regla que la lista de productos: el kardex
            // era una `<table>` con un piso de `min-w-[520px]` en un carril de
            // ~238 px, y sus cinco celdas se leían apiladas —cuando se veían—
            // sin una sola etiqueta.
            //
            // PRIORIDAD DE LA TARJETA —qué necesita leer una persona que
            // pregunta «¿por qué el stock está así?», en el orden en que se lee:
            // 1. CUÁNDO (Fecha): el movimiento más reciente es el que explica el
            //    número de hoy, y por eso abre la tarjeta.
            // 2. QUÉ PASÓ Y CUÁNTO (Tipo + Cantidad): el signo del movimiento y
            //    su magnitud, juntos en un renglón.
            // 3. QUIÉN LO HIZO (Quién): la mano detrás del número.
            // 4. POR QUÉ (Motivo): el texto libre, último porque es el más largo
            //    y el menos consultado de un vistazo.
            <div className="mt-3 overflow-hidden rounded-lg border border-color-2 dark:border-border-color">
              <div
                aria-hidden="true"
                className="hidden grid-cols-[minmax(8.5rem,1.3fr)_minmax(0,0.6fr)_minmax(0,0.5fr)_minmax(0,1.5fr)_minmax(0,0.9fr)] gap-2 border-b border-color-2 bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary sm:grid dark:border-border-color"
              >
                <span>Fecha</span>
                <span>Tipo</span>
                <span>Cantidad</span>
                <span>Motivo</span>
                <span>Quién</span>
              </div>
              <ul className="flex flex-col divide-y divide-color-2 dark:divide-border-color">
                {kardex.rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(8.5rem,1.3fr)_minmax(0,0.6fr)_minmax(0,0.5fr)_minmax(0,1.5fr)_minmax(0,0.9fr)] sm:items-center sm:gap-2"
                  >
                    {/* Las cuatro líneas de la tarjeta móvil, en el orden de la
                        prioridad y no en el de las columnas. */}
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="text-sm text-text-primary sm:col-start-1 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Fecha: </span>
                        {new Date(row.created_at).toLocaleString("es-CO")}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2 sm:contents">
                      <span className="font-mono text-sm text-text-primary sm:col-start-2 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Tipo: </span>
                        {row.type}
                      </span>
                      <span className="whitespace-nowrap text-sm font-medium text-text-primary sm:col-start-3 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Cantidad: </span>
                        {row.qty}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="break-words text-sm text-text-primary sm:col-start-5 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Quién: </span>
                        {row.actor_name ?? "—"}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="break-words text-sm text-text-primary sm:col-start-4 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Motivo: </span>
                        {row.reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
