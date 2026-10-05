"use client";

import { useState } from "react";
import { toast } from "sonner";
import { setUserRolesAction } from "@/src/features/admin/actions";
import { adminResetPasswordAction } from "@/src/features/auth/actions";
import type { SedeUserRow } from "@/src/features/admin/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import { DataTable } from "@/src/components/ui/lib/data-table";
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { Alert } from "@/src/components/ui/lib/alert";
import {
  hintTextClass,
  linkButtonClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
  tableHeaderClass,
  tableRowClass,
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
          <DataTable minWidth="none" wrapperClassName="mt-3">
            <thead>
              <tr className={tableHeaderClass}>
                <th className="whitespace-nowrap py-1 pr-3">Nombre</th>
                <th className="whitespace-nowrap py-1 pr-3">Documento</th>
                <th className="whitespace-nowrap py-1 pr-3">Actual</th>
                <th className="whitespace-nowrap py-1 pr-3">Rol</th>
                <th className="whitespace-nowrap py-1 pr-3">Guardar</th>
                <th className="whitespace-nowrap py-1 pr-3">Clave</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const sel = selected[row.id] ?? row.roles[0] ?? null;
                const isSelf = row.id === currentUserId;
                return (
                  <tr key={row.id} className={tableRowClass}>
                    <td
                      className="max-w-48 truncate whitespace-nowrap py-1 pr-3"
                      title={row.full_name}
                    >
                      {row.full_name}
                      {isSelf ? " (usted)" : ""}
                      {!row.sede_id ? " · sin instalación" : ""}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">{row.id_number}</td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      {row.roles.length > 0 ? row.roles.join(", ") : "Sin rol"}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      <span className="flex flex-wrap gap-3">
                        {ASSIGNABLE_ROLE_OPTIONS.map((option) => (
                          <label key={option.value} className="flex items-center gap-1">
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
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      <button
                        type="button"
                        disabled={busyId === row.id || !isDirty(row)}
                        onClick={() => void handleSave(row)}
                        className={`${linkButtonClass} disabled:no-underline disabled:opacity-50`}
                      >
                        {busyId === row.id ? "Guardando…" : "Guardar"}
                      </button>
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      {confirmResetId === row.id ? (
                        <span className="flex flex-wrap gap-2">
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
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
