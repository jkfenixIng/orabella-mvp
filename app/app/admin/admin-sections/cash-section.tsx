"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  deleteDenominationAction,
  updateRegisterBaseAction,
  upsertDenominationAction,
} from "@/src/features/cash/actions";
import type { CashDenominationRow, CashRegisterRow } from "@/src/features/cash/service";
import { Alert } from "@/src/components/ui/lib/alert";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { ConfirmDialog, FormDialog } from "@/src/components/ui/lib/form-dialog";
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
import { formatMoney, type ActionResult } from "../admin-shared";

/**
 * Tres superficies y, por lo tanto, tres estados de fallo distintos (estándar
 * §1, "un hecho, un canal"):
 *
 *  - "Base de caja": la base es un ajuste POR FILA, así que el guardado sigue
 *    inline y su error, inline y persistente, en el `Alert` de la sección.
 *  - "Denominaciones", alta: es un formulario de creación, o sea un diálogo;
 *    su error lo muestra `FormDialog` adentro.
 *  - "Denominaciones", Activar/Desactivar y eliminar: acciones de fila.
 *    Desactivar es reversible y queda inline; eliminar es IRREVERSIBLE, así
 *    que pasa por `ConfirmDialog`. Las dos comparten el `Alert` de la lista
 *    porque son la misma superficie.
 *
 * Antes estas tres compartían UN `error` que se pintaba siempre en el mismo
 * sitio: el fallo de la base aparecía dentro de la sección de denominaciones y
 * el del alta se leía pegado a una lista con la que no tenía nada que ver.
 */
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
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CashDenominationRow | null>(null);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [denominationError, setDenominationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openAdd() {
    setNewKind("billete");
    setNewValue("");
    setAddError(null);
    setAddOpen(true);
  }

  function closeAdd() {
    setAddOpen(false);
    setAddError(null);
  }

  function openDelete(row: CashDenominationRow) {
    setDenominationError(null);
    setPendingDelete(row);
  }

  function closeDelete() {
    setPendingDelete(null);
  }

  async function handleBase(registerId: string) {
    const raw = (baseDrafts[registerId] ?? "").replace(/\D/g, "");
    if (raw === "") {
      setBaseError("Indique la nueva base.");
      return;
    }
    setBusy(true);
    setBaseError(null);
    const result: ActionResult<CashRegisterRow> = await updateRegisterBaseAction(registerId, {
      base_configurada: Number(raw),
    });
    setBusy(false);
    if (!result.success) {
      setBaseError(result.message);
      return;
    }
    setRegisters((current) => current.map((row) => (row.id === result.data.id ? result.data : row)));
    setBaseDrafts((current) => ({ ...current, [registerId]: "" }));
    toast.success("Base actualizada.");
  }

  // `FormDialog` ya cortó el submit nativo: acá solo va la lógica.
  async function handleAddDenomination() {
    const value = Number(newValue.replace(/\D/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      setAddError("Indique un valor mayor a 0.");
      return;
    }
    setBusy(true);
    setAddError(null);
    const result: ActionResult<CashDenominationRow> = await upsertDenominationAction({
      kind: newKind,
      value,
    });
    setBusy(false);
    if (!result.success) {
      setAddError(result.message);
      return;
    }
    setDenominations((current) => [...current, result.data].sort((a, b) => b.value - a.value));
    setNewValue("");
    toast.success("Denominación agregada.");
    closeAdd();
  }

  async function toggleDenomination(row: CashDenominationRow) {
    setBusy(true);
    setDenominationError(null);
    const result: ActionResult<CashDenominationRow> = await upsertDenominationAction({
      id: row.id,
      kind: row.kind,
      value: row.value,
      is_active: !row.is_active,
    });
    setBusy(false);
    if (!result.success) {
      setDenominationError(result.message);
      return;
    }
    setDenominations((current) => current.map((item) => (item.id === row.id ? result.data : item)));
    toast.success("Denominación actualizada.");
  }

  async function removeDenomination(id: string) {
    setBusy(true);
    setDenominationError(null);
    const result = await deleteDenominationAction(id);
    setBusy(false);
    // `ConfirmDialog` no tiene prop de error: el fallo cierra la confirmación y
    // queda en el `Alert` de la lista, que es donde el usuario puede leerlo y
    // reintentar. Dejarlo abierto taparía el mensaje detrás del overlay.
    setPendingDelete(null);
    if (!result.success) {
      setDenominationError(result.message);
      return;
    }
    setDenominations((current) => current.filter((item) => item.id !== id));
    toast.success("Denominación eliminada.");
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Base de caja">
        <h2 className={sectionTitleClass}>Base de caja</h2>
        {registers.length === 0 ? (
          <EmptyState className="mt-2">Aún no hay cajas registradas en esta sede.</EmptyState>
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
        {baseError ? (
          // ESTADO: el guardado de la base es una acción de fila y su fallo es
          // el caso hasta que se corrija, así que va inline y persistente, al
          // lado de la lista que lo produce. `destructive` deriva role="alert".
          <Alert variant="destructive" className="mt-3">{baseError}</Alert>
        ) : null}
      </section>

      <section className={sectionClass} aria-label="Denominaciones">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionTitleClass}>Denominaciones ({denominations.length})</h2>
          <button type="button" onClick={openAdd} className={buttonClass}>
            Nueva denominación
          </button>
        </div>
        {denominations.length === 0 ? (
          <EmptyState className="mt-3">Aún no hay denominaciones registradas.</EmptyState>
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
                  <button type="button" disabled={busy} onClick={() => openDelete(row)} className={linkButtonClass}>
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {denominationError ? (
          // ESTADO: el fallo de una acción de fila (activar/desactivar o la
          // baja confirmada) sigue siendo el caso hasta que se corrija, así que
          // queda inline y persistente en la lista que lo produce.
          <Alert variant="destructive" className="mt-3">{denominationError}</Alert>
        ) : null}
      </section>

      {/* `lg`: los dos campos van side by side, como el formulario inline que
          reemplazó este diálogo. */}
      <FormDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) closeAdd();
        }}
        title="Nueva denominación"
        onSubmit={handleAddDenomination}
        busy={busy}
        submitLabel="Agregar"
        busyLabel="Agregando…"
        error={addError}
        size="lg"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>
      </FormDialog>

      {/* La baja es un `delete` sin reversa: por eso la confirmación es
          explícita y el cuerpo dice qué se pierde. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        title="Eliminar denominación"
        description={
          pendingDelete
            ? `Se elimina la denominación de ${formatMoney(pendingDelete.value)} y no se puede deshacer.`
            : null
        }
        confirmLabel="Eliminar"
        busyLabel="Eliminando…"
        variant="destructive"
        busy={busy}
        onConfirm={() => {
          if (pendingDelete) {
            void removeDenomination(pendingDelete.id);
          }
        }}
      />
    </div>
  );
}
