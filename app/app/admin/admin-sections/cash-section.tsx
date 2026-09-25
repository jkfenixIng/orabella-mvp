"use client";

import { useState, type FormEvent } from "react";
import {
  deleteDenominationAction,
  updateRegisterBaseAction,
  upsertDenominationAction,
} from "@/src/features/cash/actions";
import type { CashDenominationRow, CashRegisterRow } from "@/src/features/cash/service";
import {
  buttonClass,
  errorClass,
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
import { formatMoney, type ActionResult } from "../admin-shared";

export function CashSection({
  initialRegisters,
  initialDenominations,
}: {
  initialRegisters: CashRegisterRow[];
  initialDenominations: CashDenominationRow[];
}) {
  const [registers, setRegisters] = useState(initialRegisters);
  const [denominations, setDenominations] = useState(initialDenominations);
  const [baseDrafts, setBaseDrafts] = useState<Record<string, string>>({});
  const [newKind, setNewKind] = useState("billete");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleBase(registerId: string) {
    const raw = (baseDrafts[registerId] ?? "").replace(/\D/g, "");
    if (raw === "") {
      setError("Indique la nueva base.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<CashRegisterRow> = await updateRegisterBaseAction(registerId, {
      base_configurada: Number(raw),
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setRegisters((current) => current.map((row) => (row.id === result.data.id ? result.data : row)));
    setBaseDrafts((current) => ({ ...current, [registerId]: "" }));
    setNotice("Base actualizada.");
  }

  async function handleAddDenomination(event: FormEvent) {
    event.preventDefault();
    const value = Number(newValue.replace(/\D/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Indique un valor mayor a 0.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<CashDenominationRow> = await upsertDenominationAction({
      kind: newKind,
      value,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setDenominations((current) => [...current, result.data].sort((a, b) => b.value - a.value));
    setNewValue("");
    setNotice("Denominación agregada.");
  }

  async function toggleDenomination(row: CashDenominationRow) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<CashDenominationRow> = await upsertDenominationAction({
      id: row.id,
      kind: row.kind,
      value: row.value,
      is_active: !row.is_active,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setDenominations((current) => current.map((item) => (item.id === row.id ? result.data : item)));
    setNotice("Denominación actualizada.");
  }

  async function removeDenomination(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await deleteDenominationAction(id);
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setDenominations((current) => current.filter((item) => item.id !== id));
    setNotice("Denominación eliminada.");
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Base de caja">
        <h2 className={sectionTitleClass}>Base de caja</h2>
        {registers.length === 0 ? (
          <p className={`mt-2 ${mutedTextClass}`}>Aún no hay cajas registradas en esta sede.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {registers.map((row) => (
              <li key={row.id} className={listItemClass}>
                <span>
                  <strong>{row.name}</strong> · base actual {formatMoney(row.base_configurada)}
                </span>
                <input
                  value={baseDrafts[row.id] ?? ""}
                  onChange={(event) => setBaseDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                  inputMode="numeric"
                  placeholder="Nueva base"
                  className={inputClass}
                />
                <button type="button" disabled={busy} onClick={() => handleBase(row.id)} className={buttonClass}>
                  {busy ? "Guardando…" : "Guardar base"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClass} aria-label="Denominaciones">
        <h2 className={sectionTitleClass}>Denominaciones ({denominations.length})</h2>
        <form onSubmit={handleAddDenomination} className="mt-3 flex flex-wrap items-end gap-3">
          <label className={labelClass}>
            Tipo
            <select value={newKind} onChange={(event) => setNewKind(event.target.value)} className={inputClass}>
              <option value="billete">Billete</option>
              <option value="moneda">Moneda</option>
            </select>
          </label>
          <label className={labelClass}>
            Valor
            <input value={newValue} onChange={(event) => setNewValue(event.target.value)} inputMode="numeric" className={inputClass} />
          </label>
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Agregando…" : "Agregar"}
          </button>
        </form>
        {denominations.length === 0 ? (
          <p className={`mt-3 ${mutedTextClass}`}>Aún no hay denominaciones registradas.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {denominations.map((row) => (
              <li key={row.id} className={`${listItemClass} justify-between`}>
                <span>
                  {row.kind} · {row.value} · {row.is_active ? "activa" : "inactiva"}
                </span>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => toggleDenomination(row)} className={linkButtonClass}>
                    {row.is_active ? "Desactivar" : "Activar"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => removeDenomination(row.id)} className={linkButtonClass}>
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
      </section>
    </div>
  );
}
