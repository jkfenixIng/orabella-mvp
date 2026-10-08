"use client";

import { useState } from "react";
import { toast } from "sonner";
import { setUserRolesAction } from "@/src/features/admin/actions";
import { adminResetPasswordAction } from "@/src/features/auth/actions";
import type { SedeUserRow } from "@/src/features/admin/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { Alert } from "@/src/components/ui/lib/alert";
import { cn } from "@/src/components/ui/lib/utils";
import {
  hintTextClass,
  linkButtonClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
  tableHeaderClass,
} from "../admin-styles";
import { ROLE_OPTIONS, type ActionResult } from "../admin-shared";

/**
 * Roles que esta pantalla puede asignar. `superadmin` no se otorga ni se quita
 * desde una sede: ninguna superficie de la aplicación lo hace. El filtro es la
 * puerta de la interfaz; el servicio (`setUserRoles`) rechaza el mismo código
 * aunque llegue por la action.
 */
const ASSIGNABLE_ROLE_OPTIONS = ROLE_OPTIONS.filter((option) => option.value !== "superadmin");

export function UsersSection({
  initial,
  currentUserId,
}: {
  initial: SedeUserRow[];
  currentUserId: string;
}) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<Record<string, RoleCode | null>>(() =>
    Object.fromEntries(initial.map((row) => [row.id, row.roles[0] ?? null])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);

  function selectRole(userId: string, role: RoleCode) {
    setSelected((prev) => ({ ...prev, [userId]: role }));
  }

  function isDirty(row: SedeUserRow): boolean {
    const sel = selected[row.id] ?? null;
    return sel !== null && (row.roles.length !== 1 || row.roles[0] !== sel);
  }

  async function handleReset(row: SedeUserRow) {
    setBusyId(row.id);
    setError(null);
    const result: ActionResult<{ user_id: string }> = await adminResetPasswordAction(row.id);
    setBusyId(null);
    setConfirmResetId(null);
    if (!result.success) {
      setError(result.message);
      return;
    }
    toast.success(`Clave de ${row.full_name} restablecida a su documento; deberá cambiarla al entrar.`);
  }

  async function handleSave(row: SedeUserRow) {
    const role = selected[row.id] ?? null;
    if (!role) {
      setError("Seleccione un rol.");
      return;
    }
    setBusyId(row.id);
    setError(null);
    const result: ActionResult<{ user_id: string; roles: RoleCode[] }> = await setUserRolesAction({
      user_id: row.id,
      roles: [role],
    });
    setBusyId(null);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setRows((current) =>
      current.map((item) => (item.id === row.id ? { ...item, roles: result.data.roles } : item)),
    );
    setSelected((prev) => ({ ...prev, [row.id]: result.data.roles[0] ?? null }));
    toast.success(`Rol de ${row.full_name} actualizado.`);
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de usuarios">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionTitleClass}>Usuarios ({rows.length})</h2>
          <p className={hintTextClass}>
            Los usuarios se crean solos al crear el empleado. Aquí solo se asigna rol y se restablece clave.
          </p>
        </div>
        {rows.length === 0 ? (
          <EmptyState className="mt-2">Aún no hay usuarios en esta sede.</EmptyState>
        ) : (
          // R4 + R38: la lista de Usuarios. Antes era una TABLA de seis columnas
          // dentro del carril `overflow-x-auto` de `DataTable`: sin piso
          // (`minWidth="none"`) pero con `whitespace-nowrap` en cada celda, no
          // bajaba del ancho de su contenido. Con un usuario el carril apenas
          // se movía —una acción fuera de pantalla—, y con cinco o seis la
          // última columna se iba entera.
          //
          // Ahora es el patrón de `invoices-client.tsx` y
          // `vouchers-client.tsx`, el mismo y no otro: abajo de `sm` cada fila
          // es una TARJETA de cuatro renglones y cada valor lleva su rótulo —la
          // palabra del encabezado, la misma—; arriba de `sm` cada hoja se ancla
          // a su columna con `sm:col-start-N` y la grilla conserva las seis
          // columnas de hoy, en su orden.
          //
          // PRIORIDAD DE LA TARJETA, en el orden en que se lee:
          // 1. QUIÉN es (Nombre), con la marca de «(usted)» y de «sin
          //    instalación» cuando corresponde: sin identidad no hay rol.
          // 2. CON QUÉ documento y qué TIENE HOY (Actual): el estado vivo de la
          //    cuenta, que es contra lo que se compara el rol nuevo.
          // 3. EL ROL que se propone: los radios, con su blanco táctil de 24 px
          //    (R13) y envueltos para que quepan en 320 px.
          // 4. LAS DOS ACCIONES (Guardar, Restablecer): su propio renglón,
          //    envuelto, y sin gesto horizontal para llegar a ellas. `Guardar`
          //    sólo se habilita cuando la fila está sucia, que es lo que
          //    decide el `disabled` de hoy.
          <div className="mt-3 overflow-hidden rounded-lg border border-border-color dark:border-border-color-2">
            {/* El encabezado nombra las seis columnas y sólo existe arriba de
                `sm`: abajo la fila dice cada rótulo con su propio valor. */}
            <div
              aria-hidden="true"
              className={cn(
                "hidden grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)_minmax(0,0.95fr)_minmax(0,1.60fr)_minmax(0,0.60fr)_minmax(0,0.85fr)] gap-2 border-b border-border-color px-3 py-2 uppercase tracking-wide sm:grid dark:border-border-color-2",
                tableHeaderClass,
              )}
            >
              <span>Nombre</span>
              <span>Documento</span>
              <span>Actual</span>
              <span>Rol</span>
              <span>Guardar</span>
              <span>Clave</span>
            </div>
            <ul className="flex flex-col divide-y divide-border-color dark:divide-border-color-2">
              {rows.map((row) => {
                const sel = selected[row.id] ?? row.roles[0] ?? null;
                const isSelf = row.id === currentUserId;
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)_minmax(0,0.95fr)_minmax(0,1.60fr)_minmax(0,0.60fr)_minmax(0,0.85fr)] sm:items-center sm:gap-2"
                  >
                    {/* Las cuatro líneas de la tarjeta móvil. Abajo de `sm` cada
                        hoja es un renglón con su rótulo; cada envoltorio
                        `sm:contents` se borra de la grilla de arriba, donde la
                        hoja se queda en la columna que su `sm:col-start-N` fija. */}
                    <span className="flex items-center gap-2 sm:contents">
                      <span className="break-words text-sm font-medium text-text-primary sm:col-start-1 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Nombre: </span>
                        {row.full_name}
                        {isSelf ? " (usted)" : ""}
                        {!row.sede_id ? " · sin instalación" : ""}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2 sm:contents">
                      <span className="break-words text-sm text-text-primary sm:col-start-2 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Documento: </span>
                        {row.id_number}
                      </span>
                      <span className="break-words text-sm text-text-primary sm:col-start-3 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Actual: </span>
                        {row.roles.length > 0 ? row.roles.join(", ") : "Sin rol"}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 sm:contents">
                      <span className="flex flex-wrap items-center gap-2 sm:col-start-4 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Rol: </span>
                        {ASSIGNABLE_ROLE_OPTIONS.map((option) => (
                          // R13: el radio nativo mide 13×13 px, bajo el piso duro
                          // de 24×24. La rebanada `::after` va en el ENVOLTORIO y
                          // no en el control: un `<input>` es un elemento
                          // reemplazado y no dibuja pseudo-elementos, mientras
                          // que el `<label>` es lo que activa el radio y recibe
                          // el toque de toda la rebanada. Es el mismo mecanismo
                          // de `src/components/ui/lib/checkbox.tsx`, que no se
                          // toca: sin `max-sm:` porque el piso no tiene
                          // excepción de escritorio, y el `gap-3` del renglón
                          // deja las rebanadas de radios vecinos justo al borde
                          // de tocarse, sin solaparse.
                          <label
                            key={option.value}
                            className="relative flex items-center gap-1 after:absolute after:-inset-1.5"
                          >
                            <input
                              type="radio"
                              name={`rol-${row.id}`}
                              checked={sel === option.value}
                              disabled={isSelf}
                              onChange={() => selectRole(row.id, option.value)}
                            />
                            {option.label}
                          </label>
                        ))}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 sm:contents">
                      <span className="flex flex-wrap items-center gap-2 sm:col-start-5 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Guardar: </span>
                        <button
                          type="button"
                          disabled={busyId === row.id || !isDirty(row)}
                          onClick={() => void handleSave(row)}
                          className={`${linkButtonClass} disabled:no-underline disabled:opacity-50`}
                        >
                          {busyId === row.id ? "Guardando…" : "Guardar"}
                        </button>
                      </span>
                      <span className="flex flex-wrap items-center gap-2 sm:col-start-6 sm:row-start-1">
                        <span className="font-sans font-medium text-text-secondary sm:hidden">Clave: </span>
                        {confirmResetId === row.id ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={busyId === row.id}
                              onClick={() => void handleReset(row)}
                              className={`${linkButtonClass} disabled:opacity-50`}
                            >
                              Confirmar
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmResetId(null)}
                              className={linkButtonClass}
                            >
                              Cancelar
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => setConfirmResetId(row.id)}
                            className={`${linkButtonClass} disabled:opacity-50`}
                          >
                            Restablecer
                          </button>
                        )}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {error ? (
          // ESTADO: el fallo al crear o guardar sigue siendo el caso mientras
          // no se corrija, así que va inline y persistente. `destructive`
          // deriva role="alert" asertivo, el mismo anuncio que el
          // `<p role="alert">` escribía a mano antes.
          <Alert variant="destructive" className="mt-3">
            {error}
          </Alert>
        ) : null}
      </section>

    </div>
  );
}
