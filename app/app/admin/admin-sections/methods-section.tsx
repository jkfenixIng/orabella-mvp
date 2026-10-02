"use client";

import { useState } from "react";
import { toast } from "sonner";
import { upsertPaymentMethodAction } from "@/src/features/admin/actions";
import type { PaymentMethodRow } from "@/src/features/admin/service";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { FormDialog } from "@/src/components/ui/lib/form-dialog";
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
import type { ActionResult } from "../admin-shared";

const EMPTY_METHOD = { code: "efectivo", name: "", is_active: true, arqueable: true };

/**
 * Alta y edición de un método de pago: `FormDialog`, no un formulario pegado
 * debajo de la lista. Mismo criterio que en `taxes-section.tsx` (estándar §1):
 * el alta es secundaria del listado, y el error del intento lo muestra el
 * diálogo porque es el estado de ESE formulario.
 */
export function MethodsSection({ sedeId, initial }: { sedeId: string; initial: PaymentMethodRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_METHOD);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_METHOD);
    setError(null);
    setDialogOpen(true);
  }

  function startEdit(row: PaymentMethodRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, is_active: row.is_active, arqueable: row.arqueable });
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
      sede_id: sedeId,
      code: form.code,
      name: form.name,
      is_active: form.is_active,
      arqueable: form.arqueable,
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
          <h2 className={sectionTitleClass}>Métodos de pago ({rows.length})</h2>
          <button type="button" onClick={openCreate} className={buttonClass}>
            Nuevo método
          </button>
        </div>
        {rows.length === 0 ? (
          <EmptyState className="mt-2">
            Aún no hay métodos de pago configurados en esta sede.
          </EmptyState>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} className={`${listItemClass} justify-between`}>
                <span>
                  <strong>{row.name}</strong> ({row.code}) ·{" "}
                  {row.is_active ? "activo" : "inactivo"} ·{" "}
                  {row.arqueable ? "se arquea" : "sin arqueo"}
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
            Código
            <select
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
              className={inputClass}
            >
              <option value="efectivo">efectivo</option>
              <option value="transferencia_normal">transferencia_normal</option>
              <option value="nequi">nequi</option>
              <option value="daviplata">daviplata</option>
              <option value="bre-b">bre-b</option>
              <option value="tarjeta">tarjeta</option>
            </select>
          </label>
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
              onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
            />
            Activo (solo activos aceptan cobros)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.arqueable}
              onChange={(event) => setForm({ ...form, arqueable: event.target.checked })}
            />
            Se arquea (desactívelo si no se puede contar, p. ej. tarjeta por terminal)
          </label>
        </div>
      </FormDialog>
    </div>
  );
}
