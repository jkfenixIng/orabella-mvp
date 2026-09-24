"use client";

import { useState, useTransition, type FormEvent } from "react";
import { upsertServiceAction } from "@/src/features/admin/actions";
import type { ServiceRow } from "@/src/features/admin/service";
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
import { formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";
import {
  errorClass,
  inputClass,
  labelClass,
  okClass,
  tableCellClass,
  tableHeaderClass,
  tableRowClass,
} from "@/src/shared/lib/ui-styles";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number | string | null): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

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
  sedeId: string;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isPending, startRefresh] = useTransition();

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    setNotice(null);
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
    setNotice(null);
    setDialogOpen(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<ServiceRow> = await upsertServiceAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: props.sedeId,
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
    setNotice(editingId ? "Servicio actualizado." : "Servicio creado.");
    setDialogOpen(false);
    setEditingId(null);
    setForm(emptyForm());
  }

  return (
    <div className="flex min-h-0 flex-col gap-6">
      {notice && (
        <p role="status" className={okClass}>
          {notice}
        </p>
      )}

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
            <div className="overflow-x-auto">
              <table className={cn("w-full text-left text-sm", "min-w-[640px]")}>
                <thead>
                  <tr className={tableHeaderClass}>
                    <th className={tableCellClass} scope="col">
                      Servicio
                    </th>
                    <th className={tableCellClass} scope="col">
                      Precio
                    </th>
                    <th className={tableCellClass} scope="col">
                      Duración
                    </th>
                    <th className={tableCellClass} scope="col">
                      Estado
                    </th>
                    <th className={tableCellClass} scope="col">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={tableRowClass}>
                      <td className={cn(tableCellClass, "font-medium")}>
                        {row.name}
                        {row.description ? (
                          <span className="ml-2 text-xs text-text-tertiary">{row.description}</span>
                        ) : null}
                      </td>
                      <td className={tableCellClass}>{formatMoney(row.price)}</td>
                      <td className={tableCellClass}>
                        {row.duracion_min}–{row.duracion_max} min
                      </td>
                      <td className={tableCellClass}>{row.is_active ? "Activo" : "Inactivo"}</td>
                      <td className={tableCellClass}>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                  onChange={(event) => setForm({ ...form, duracion_min: event.target.value })}
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
                  onChange={(event) => setForm({ ...form, duracion_max: event.target.value })}
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
                <p role="alert" className={cn(errorClass, "sm:col-span-2")}>
                  {error}
                </p>
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
