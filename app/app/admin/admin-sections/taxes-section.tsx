"use client";

import { useState } from "react";
import { toast } from "sonner";
import { upsertTaxConfigAction } from "@/src/features/admin/actions";
import type { TaxConfigRow } from "@/src/features/admin/service";
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
import { toNumber, type ActionResult } from "../admin-shared";
import { stripPercentageInput } from "@/src/shared/lib/money";

const EMPTY_TAX = { code: "IVA", name: "", percent: "", is_active: false };

/**
 * Alta y edición de un impuesto: `FormDialog`, no un formulario pegado debajo
 * de la lista. El alta es una acción SECUNDARIA del listado, así que va en
 * diálogo (estándar §1); el `Alert` de error también, porque `FormDialog` lo
 * renderiza adentro: el fallo al guardar sigue siendo estado, pero el estado
 * que corresponde al formulario, no uno suelto en la página.
 */
export function TaxesSection({ sedeId, initial }: { sedeId: string; initial: TaxConfigRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_TAX);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_TAX);
    setError(null);
    setDialogOpen(true);
  }

  function startEdit(row: TaxConfigRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, percent: String(row.percent), is_active: row.is_active });
    setError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setForm(EMPTY_TAX);
    setError(null);
  }

  // `FormDialog` ya cortó el submit nativo: acá solo va la lógica.
  async function handleSubmit() {
    setBusy(true);
    setError(null);
    const result: ActionResult<TaxConfigRow> = await upsertTaxConfigAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: sedeId,
      code: form.code,
      name: form.name,
      percent: toNumber(form.percent) ?? 0,
      is_active: form.is_active,
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
    toast.success(editingId ? "Impuesto actualizado." : "Impuesto creado.");
    closeDialog();
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de impuestos">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionTitleClass}>Impuestos ({rows.length})</h2>
          <button type="button" onClick={openCreate} className={buttonClass}>
            Nuevo impuesto
          </button>
        </div>
        {rows.length === 0 ? (
          <EmptyState className="mt-2">Aún no hay impuestos configurados en esta sede.</EmptyState>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} className={`${listItemClass} justify-between`}>
                <span>
                  <strong>{row.code}</strong> · {row.name} · {row.percent}% ·{" "}
                  {row.is_active ? "activo" : "inactivo"}
                </span>
                <button type="button" onClick={() => startEdit(row)} className={linkButtonClass}>
                  Editar
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* `lg`: el formulario es de dos columnas, como el que escribía el
          archivo a mano. El título, el error y el pie los pone la primitiva. */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={editingId ? "Editar impuesto" : "Nuevo impuesto"}
        onSubmit={handleSubmit}
        busy={busy}
        submitLabel={editingId ? "Guardar cambios" : "Crear impuesto"}
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
              <option value="IVA">IVA</option>
              <option value="ICA">ICA</option>
              <option value="Rete">Rete</option>
              <option value="otro">Otro</option>
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
          <label className={labelClass}>
            Porcentaje (0–100)
            <input
              value={form.percent}
              onChange={(event) => setForm({ ...form, percent: stripPercentageInput(event.target.value) })}
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
            />
            Activo (inactivo no suma en factura)
          </label>
        </div>
      </FormDialog>
    </div>
  );
}
