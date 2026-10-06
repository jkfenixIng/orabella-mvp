"use client";

import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { upsertServiceAction } from "@/src/features/admin/actions";
import type { ServiceRow } from "@/src/features/admin/service";
import { Alert } from "@/src/components/ui/lib/alert";
import { Button } from "@/src/components/ui/lib/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/lib/card";
import { Checkbox } from "@/src/components/ui/lib/checkbox";
import { Input } from "@/src/components/ui/lib/input";
import { Label } from "@/src/components/ui/lib/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { cn } from "@/src/components/ui/lib/utils";
import { formatMoney, formatMoneyInput, stripMoneyInput, stripQuantityInput } from "@/src/shared/lib/money";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { toNumber } from "@/src/shared/lib/format";
import { inputClass, labelClass } from "@/src/shared/lib/ui-styles";

function emptyForm() {
  return {
    name: "",
    description: "",
    price: "",
    duracion_min: "",
    duracion_max: "",
    is_active: true,
  };
}

interface ServicesClientProps {
  initialServices: ServiceRow[];
  canWrite: boolean;
}

/**
 * S1: los servicios son catálogo propio de la sede — qué se brinda, con
 * precio y duración estimada. No es un inventario de cantidades: no hay
 * stock ni movimientos, solo el CRUD de servicios.
 */
export function ServicesClient(props: ServicesClientProps) {
  const [rows, setRows] = useState<ServiceRow[]>(props.initialServices);
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isPending, startRefresh] = useTransition();

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    setDialogOpen(true);
  }

  function startEdit(row: ServiceRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      description: row.description ?? "",
      price: String(row.price),
      duracion_min: String(row.duracion_min),
      duracion_max: String(row.duracion_max),
      is_active: row.is_active,
    });
    setError(null);
    setDialogOpen(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result: ActionResult<ServiceRow> = await upsertServiceAction({
      ...(editingId ? { id: editingId } : {}),
      name: form.name,
      description: form.description.trim() === "" ? null : form.description,
      price: toNumber(form.price) ?? 0,
      duracion_min: toNumber(form.duracion_min) ?? 0,
      duracion_max: toNumber(form.duracion_max) ?? 0,
      is_active: form.is_active,
    });
    setBusy(false);
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      return;
    }
    setRows((current) => {
      const exists = current.some((row) => row.id === result.data.id);
      const next = exists
        ? current.map((row) => (row.id === result.data.id ? result.data : row))
        : [...current, result.data];
      return [...next].sort((a, b) => a.name.localeCompare(b.name));
    });
    // Éxito = EVENTO: acaba de pasar y no tiene que quedarse en pantalla
    // compitiendo con lo que sí importa. Antes era un <p role="status"> que
    // persistía hasta la siguiente acción. El texto es el mismo.
    toast.success(editingId ? "Servicio actualizado." : "Servicio creado.");
    setDialogOpen(false);
    setEditingId(null);
    setForm(emptyForm());
  }

  return (
    <div className="flex min-h-0 flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Servicios de la sede</CardTitle>
              <p className="mt-1 text-sm text-text-secondary">
                Qué servicios se brindan, con su precio y duración estimada.
              </p>
            </div>
            {props.canWrite && (
              <Button type="button" onClick={openCreate} className="whitespace-nowrap">
                Nuevo servicio
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-text-tertiary">Aún no hay servicios en esta sede.</p>
          ) : (
            // R19 + R4 + R38: la fila del catálogo, no una tabla con carril. Antes
            // era `<div className="overflow-x-auto">` + `<table className={cn("w-full
            // text-left text-sm", "min-w-[640px]")}>`: 640 px de contenido en un
            // carril de 222-308 px en un teléfono, así que la columna `Acciones` —
            // el `Editar`, lo único que la fila hace— quedaba SIEMPRE fuera, en los
            // cuatro anchos angostos: son los 4 botones fuera que contó la
            // medición. Y las cinco celdas se leían como cinco valores sueltos, sin
            // que nada dijera cuál era cuál.
            //
            // Ahora es el patrón de `invoices-client.tsx` (R38) y de
            // `vouchers-client.tsx`, el mismo y no otro: abajo de `sm` cada fila es
            // una TARJETA de cuatro renglones y cada valor lleva su rótulo —la
            // palabra del encabezado, la misma, y por eso las dos superficies no
            // pueden divergir—; arriba de `sm` cada hoja se ancla a su columna con
            // `sm:col-start-N` y la grilla conserva las CINCO columnas de hoy, en
            // su orden. La escala se declara una vez por superficie: no queda piso
            // de ancho inventado ni carril que arrastrar.
            //
            // PRIORIDAD DE LA TARJETA — lo que hay que ver para editar o desactivar
            // un servicio, en el orden en que se lee:
            // 1. QUÉ servicio es (Servicio): el nombre lo identifica, y sin
            //    identidad no hay edición; la descripción cuelga de esa misma línea.
            // 2. CUÁNTO cuesta y SI se ofrece (Precio + Estado): el precio es lo
            //    que se cotiza en el mostrador y el estado decide si se puede
            //    facturar; van en un renglón porque los dos se miran al cobrar.
            // 3. CUÁNTO dura (Duración): se consulta al agendar, no al cobrar, así
            //    que baja después del estado.
            // 4. LA ACCIÓN (Acciones): su propio renglón, envuelta, y al alcance
            //    del dedo sin gesto horizontal.
            // El estado NO tiene interruptor propio en la fila —hoy es texto—: lo
            // que activa o desactiva un servicio es la casilla «Activo» del
            // formulario, que se abre desde el `Editar` de la fila. El camino de
            // desactivación es, exactamente, ese botón; por eso tiene que quedar
            // alcanzable, y por eso sigue siendo el único control de la fila.
            <div className="mt-4 overflow-hidden rounded-lg border border-border-color dark:border-border-color-2">
              {/* El encabezado nombra las cinco columnas y sólo existe arriba de
                  `sm`: abajo la fila dice cada rótulo con su propio valor. */}
              <div
                aria-hidden="true"
                className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,0.85fr)_minmax(0,0.75fr)_minmax(0,0.6fr)_minmax(0,0.85fr)] gap-2 border-b border-border-color bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary sm:grid dark:border-border-color-2"
              >
                <span>Servicio</span>
                <span>Precio</span>
                <span>Duración</span>
                <span>Estado</span>
                <span className="text-center">Acciones</span>
              </div>
              <ul className="flex flex-col divide-y divide-border-color dark:divide-border-color-2">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(0,0.85fr)_minmax(0,0.75fr)_minmax(0,0.6fr)_minmax(0,0.85fr)] sm:items-center sm:gap-2"
                  >
                    {/* Las cuatro líneas de la tarjeta móvil. Abajo de `sm` cada hoja
                        es un renglón con su rótulo; cada envoltorio `sm:contents` se
                        borra de la grilla de arriba, donde la hoja se queda en la
                        columna que su `sm:col-start-N` fija. */}
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="break-words text-sm font-medium text-text-primary sm:col-start-1 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Servicio: </span>
                        {row.name}
                        {row.description ? (
                          <span className="ml-2 text-xs text-text-tertiary">{row.description}</span>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2 sm:contents">
                      <span className="whitespace-nowrap text-sm font-medium text-text-primary sm:col-start-2 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Precio: </span>
                        {formatMoney(row.price)}
                      </span>
                      <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-4 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Estado: </span>
                        {row.is_active ? "Activo" : "Inactivo"}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-3 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Duración: </span>
                        {row.duracion_min}–{row.duracion_max} min
                      </span>
                    </span>
                    {/* La acción en su propio renglón: `flex-wrap` para que el botón
                        quepa en 320 px sin empujar la fila. */}
                    <span className="flex flex-wrap items-center gap-2 sm:contents">
                      <span className="flex flex-wrap items-center gap-2 sm:col-start-5 sm:row-start-1 sm:justify-center">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Acciones: </span>
                        {props.canWrite && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => startRefresh(() => startEdit(row))}
                          >
                            Editar
                          </Button>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {props.canWrite && (
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setDialogOpen(false);
              setEditingId(null);
              setForm(emptyForm());
              setError(null);
            } else setDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingId ? "Editar servicio" : "Nuevo servicio"}</DialogTitle>
              <DialogDescription>
                Precio y duración estimada; el servicio se ofrece al facturar.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Label htmlFor="service-name" className={cn(labelClass, "sm:col-span-2")}>
                Nombre *
                <Input
                  id="service-name"
                  className={inputClass}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Label>
              <Label htmlFor="service-price" className={labelClass}>
                Precio
                <Input
                  id="service-price"
                  className={inputClass}
                  value={formatMoneyInput(form.price)}
                  inputMode="numeric"
                  placeholder="35.000"
                  onChange={(event) => setForm({ ...form, price: stripMoneyInput(event.target.value) })}
                />
              </Label>
              <Label htmlFor="service-duration-min" className={labelClass}>
                Duración mínima (min)
                <Input
                  id="service-duration-min"
                  className={inputClass}
                  value={form.duracion_min}
                  inputMode="numeric"
                  placeholder="30"
                  onChange={(event) => setForm({ ...form, duracion_min: stripQuantityInput(event.target.value) })}
                />
              </Label>
              <Label htmlFor="service-duration-max" className={labelClass}>
                Duración máxima (min)
                <Input
                  id="service-duration-max"
                  className={inputClass}
                  value={form.duracion_max}
                  inputMode="numeric"
                  placeholder="60"
                  onChange={(event) => setForm({ ...form, duracion_max: stripQuantityInput(event.target.value) })}
                />
              </Label>
              <Label htmlFor="service-description" className={cn(labelClass, "sm:col-span-2")}>
                Descripción
                <Input
                  id="service-description"
                  className={inputClass}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </Label>
              <Label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox
                  checked={form.is_active}
                  onCheckedChange={(checked: boolean | "indeterminate") =>
                    setForm({ ...form, is_active: checked === true })
                  }
                />
                Activo
              </Label>
              {error ? (
                // Fallo al guardar = ESTADO: sigue siendo el caso mientras el
                // formulario esté abierto, así que va inline y persistente al
                // lado de los campos, no como aviso efímero. `destructive`
                // deriva role="alert" (asertivo) igual que el rol que había.
                <Alert variant="destructive" className="sm:col-span-2">
                  {error}
                </Alert>
              ) : null}
              <DialogFooter className="sm:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDialogOpen(false);
                    setEditingId(null);
                    setForm(emptyForm());
                  }}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear servicio"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
