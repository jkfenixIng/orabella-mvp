"use client";

import { useState } from "react";
import { toast } from "sonner";
import { upsertPaymentMethodAction } from "@/src/features/admin/actions";
import type { PaymentMethodRow } from "@/src/features/admin/service";
import type { ArqueoMode } from "@/src/features/admin/schemas";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { FormDialog } from "@/src/components/ui/lib/form-dialog";
import { ListToolbar } from "@/src/components/ui/lib/list-toolbar";
import {
  buttonClass,
  inputClass,
  labelClass,
  linkButtonClass,
  listItemClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
} from "../admin-styles";
import {
  ACTIVE_STATUS_OPTIONS,
  matchesActiveStatus,
  matchesQuery,
  type ActionResult,
  type ActiveStatusFilter,
} from "../admin-shared";

const ARQUEO_MODE_LABEL: Record<ArqueoMode, string> = {
  none: "Sin arqueo",
  denominations: "Se arquea por denominaciones",
  declared_total: "Se arquea con total declarado",
};

const EMPTY_METHOD: { name: string; is_active: boolean; arqueo_mode: ArqueoMode } = {
  name: "",
  is_active: true,
  arqueo_mode: "none",
};

/**
 * Alta y edición de un método de pago: `FormDialog`, no un formulario pegado
 * debajo de la lista. Mismo criterio que en `taxes-section.tsx` (estándar §1):
 * el alta es secundaria del listado, y el error del intento lo muestra el
 * diálogo porque es el estado de ESE formulario.
 */
export function MethodsSection({ initial }: { initial: PaymentMethodRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_METHOD);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ActiveStatusFilter>("all");

  const visibleRows = rows.filter(
    (row) => matchesActiveStatus(row.is_active, status) && matchesQuery(query, [row.name, ARQUEO_MODE_LABEL[row.arqueo_mode]]),
  );

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_METHOD);
    setError(null);
    setDialogOpen(true);
  }

  function startEdit(row: PaymentMethodRow) {
    setEditingId(row.id);
    setForm({ name: row.name, is_active: row.is_active, arqueo_mode: row.is_active ? row.arqueo_mode : "none" });
    setError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setForm(EMPTY_METHOD);
    setError(null);
  }

  // `FormDialog` ya cortó el submit nativo: acá solo va la lógica.
  async function handleSubmit() {
    setBusy(true);
    setError(null);
    const result: ActionResult<PaymentMethodRow> = await upsertPaymentMethodAction({
      ...(editingId ? { id: editingId } : {}),
      name: form.name,
      is_active: form.is_active,
      arqueo_mode: form.arqueo_mode,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setRows((current) => {
      const exists = current.some((row) => row.id === result.data.id);
      if (exists) return current.map((row) => (row.id === result.data.id ? result.data : row));
      return [...current, result.data];
    });
    toast.success(editingId ? "Método actualizado." : "Método creado.");
    closeDialog();
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de métodos de pago">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionTitleClass}>Métodos de pago ({visibleRows.length})</h2>
          <button type="button" onClick={openCreate} className={buttonClass}>
            Nuevo método
          </button>
        </div>
        {rows.length > 0 ? (
          <ListToolbar
            className="mt-3"
            aria-label="Filtrar métodos de pago"
            searchId="admin-payment-methods-search"
            searchLabel="Buscar"
            searchValue={query}
            searchPlaceholder="Nombre o arqueo"
            onSearchChange={setQuery}
            statusLabel="Estado"
            statusValue={status}
            statusOptions={ACTIVE_STATUS_OPTIONS}
            onStatusChange={(value) => setStatus(value as ActiveStatusFilter)}
            onClear={() => {
              setQuery("");
              setStatus("all");
            }}
          />
        ) : null}
        {visibleRows.length === 0 ? (
          <EmptyState className="mt-2">
            {rows.length === 0 ? "Aún no hay métodos de pago configurados en esta sede." : "Sin resultados para ese filtro."}
          </EmptyState>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {visibleRows.map((row) => (
              <li key={row.id} className={`${listItemClass} justify-between`}>
                <span>
                  <strong>{row.name}</strong> · {row.is_active ? "activo" : "inactivo"} ·{" "}
                  {ARQUEO_MODE_LABEL[row.arqueo_mode]}
                </span>
                <button type="button" onClick={() => startEdit(row)} className={linkButtonClass}>
                  Editar
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* `lg`: el formulario es de dos columnas. Título, error y pie son de la
          primitiva, así que esta sección ya no decide cómo se falla. */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={editingId ? "Editar método" : "Nuevo método"}
        onSubmit={handleSubmit}
        busy={busy}
        submitLabel={editingId ? "Guardar cambios" : "Crear método"}
        error={error}
        size="lg"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Nombre
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) =>
                setForm({
                  ...form,
                  is_active: event.target.checked,
                  arqueo_mode: event.target.checked ? form.arqueo_mode : "none",
                })
              }
            />
            Activo (acepta cobros)
          </label>
          <label className={labelClass}>
            Arqueo en caja
            <select
              value={form.arqueo_mode}
              onChange={(event) => setForm({ ...form, arqueo_mode: event.target.value as ArqueoMode })}
              className={inputClass}
              disabled={!form.is_active}
            >
              <option value="none">{ARQUEO_MODE_LABEL.none}</option>
              <option value="denominations">{ARQUEO_MODE_LABEL.denominations}</option>
              <option value="declared_total">{ARQUEO_MODE_LABEL.declared_total}</option>
            </select>
          </label>
        </div>
      </FormDialog>
    </div>
  );
}
