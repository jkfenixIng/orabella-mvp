"use client";

import { useState, type FormEvent } from "react";
import { upsertPaymentMethodAction } from "@/src/features/admin/actions";
import type { PaymentMethodRow } from "@/src/features/admin/service";
import {
  buttonClass,
  errorClass,
  ghostClass,
  inputClass,
  labelClass,
  linkButtonClass,
  listItemClass,
  mutedTextClass,
  okClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
} from "../admin-styles";
import type { ActionResult } from "../admin-shared";

const EMPTY_METHOD = { code: "efectivo", name: "", is_active: true, arqueable: true };

export function MethodsSection({ sedeId, initial }: { sedeId: string; initial: PaymentMethodRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_METHOD);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(row: PaymentMethodRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, is_active: row.is_active, arqueable: row.arqueable });
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
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
    setNotice(editingId ? "Método actualizado." : "Método creado.");
    setEditingId(null);
    setForm(EMPTY_METHOD);
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de métodos de pago">
        <h2 className={sectionTitleClass}>Métodos de pago ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className={`mt-2 ${mutedTextClass}`}>
            Aún no hay métodos de pago configurados en esta sede.
          </p>
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

      <section className={sectionClass} aria-label="Formulario de método de pago">
        <h2 className={sectionTitleClass}>
          {editingId ? "Editar método" : "Nuevo método"}
        </h2>
        <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear método"}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_METHOD);
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
