"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { upsertTaxConfigAction } from "@/src/features/admin/actions";
import type { TaxConfigRow } from "@/src/features/admin/service";
import { Alert } from "@/src/components/ui/lib/alert";
import {
  buttonClass,
  ghostClass,
  inputClass,
  labelClass,
  linkButtonClass,
  listItemClass,
  mutedTextClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
} from "../admin-styles";
import { toNumber, type ActionResult } from "../admin-shared";

const EMPTY_TAX = { code: "IVA", name: "", percent: "", is_active: false };

export function TaxesSection({ sedeId, initial }: { sedeId: string; initial: TaxConfigRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_TAX);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(row: TaxConfigRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, percent: String(row.percent), is_active: row.is_active });
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
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
    setEditingId(null);
    setForm(EMPTY_TAX);
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de impuestos">
        <h2 className={sectionTitleClass}>Impuestos ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className={`mt-2 ${mutedTextClass}`}>Aún no hay impuestos configurados en esta sede.</p>
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

      <section className={sectionClass} aria-label="Formulario de impuesto">
        <h2 className={sectionTitleClass}>{editingId ? "Editar impuesto" : "Nuevo impuesto"}</h2>
        <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              onChange={(event) => setForm({ ...form, percent: event.target.value })}
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
          {error ? (
            // ESTADO: el fallo al guardar sigue siendo el caso mientras no se
            // corrija, así que va inline y persistente. `destructive` deriva
            // role="alert" asertivo, el mismo anuncio que el `<p role="alert">`
            // escribía a mano antes.
            <Alert variant="destructive">{error}</Alert>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear impuesto"}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_TAX);
                }}
                className={ghostClass}
              >
                Cancelar
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
