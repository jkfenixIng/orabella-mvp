"use client";

import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { listSedeUsersAction, setUserRolesAction } from "@/src/features/admin/actions";
import {
  adminCreateUserAction,
  adminResetPasswordAction,
} from "@/src/features/auth/actions";
import type { SedeUserRow } from "@/src/features/admin/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import {
  buttonClass,
  errorClass,
  ghostClass,
  hintTextClass,
  inputClass,
  labelClass,
  linkButtonClass,
  mutedTextClass,
  okClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
  tableHeaderClass,
  tableRowClass,
} from "../admin-styles";
import { ROLE_OPTIONS, type ActionResult } from "../admin-shared";

export function UsersSection({
  sedeId,
  initial,
  currentUserId,
}: {
  sedeId: string;
  initial: SedeUserRow[];
  currentUserId: string;
}) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<Record<string, RoleCode | null>>(() =>
    Object.fromEntries(initial.map((row) => [row.id, row.roles[0] ?? null])),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    full_name: "",
    documento: "",
    id_type: "CC",
    email: "",
    phone: "",
    role: "empleado" as RoleCode,
  });

  async function refreshUsers() {
    const result: ActionResult<SedeUserRow[]> = await listSedeUsersAction(sedeId);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setRows(result.data);
    setSelected(Object.fromEntries(result.data.map((row) => [row.id, row.roles[0] ?? null])));
  }

  function selectRole(userId: string, role: RoleCode) {
    setSelected((prev) => ({ ...prev, [userId]: role }));
  }

  function isDirty(row: SedeUserRow): boolean {
    const sel = selected[row.id] ?? null;
    return sel !== null && (row.roles.length !== 1 || row.roles[0] !== sel);
  }

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();
    setBusyId("nuevo");
    setError(null);
    setNotice(null);
    const result = await adminCreateUserAction({
      full_name: newUser.full_name,
      documento: newUser.documento,
      id_type: newUser.id_type as "CC" | "CE" | "PPT" | "PEP" | "otro",
      email: newUser.email,
      phone: newUser.phone.trim() === "" ? undefined : newUser.phone,
      roles: [newUser.role],
      sede_id: sedeId,
    });
    setBusyId(null);
    if (!result.success) {
      setError(`[${result.code}] ${result.message}`);
      return;
    }
    setCreateOpen(false);
    setNewUser({ full_name: "", documento: "", id_type: "CC", email: "", phone: "", role: "empleado" });
    setNotice("Usuario creado con su rol.");
    await refreshUsers();
  }

  async function handleReset(row: SedeUserRow) {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    const result: ActionResult<{ user_id: string }> = await adminResetPasswordAction(row.id);
    setBusyId(null);
    setConfirmResetId(null);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setNotice(`Clave de ${row.full_name} restablecida a su documento; deberá cambiarla al entrar.`);
  }

  async function handleSave(row: SedeUserRow) {
    const role = selected[row.id] ?? null;
    if (!role) {
      setError("Seleccione un rol.");
      setNotice(null);
      return;
    }
    setBusyId(row.id);
    setError(null);
    setNotice(null);
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
    setNotice(`Rol de ${row.full_name} actualizado.`);
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
          <p className={`mt-2 ${mutedTextClass}`}>
            Aún no hay usuarios en esta sede.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
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
                        {!row.sede_id ? " · sin sede" : ""}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-3">{row.id_number}</td>
                      <td className="whitespace-nowrap py-1 pr-3">
                        {row.roles.length > 0 ? row.roles.join(", ") : "Sin rol"}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-3">
                        <span className="flex flex-wrap gap-3">
                          {ROLE_OPTIONS.map((option) => (
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
            </table>
          </div>
        )}
        {error ? (
          <p role="alert" className={`${errorClass} mt-3`}>
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className={`${okClass} mt-3`}>
            {notice}
          </p>
        ) : null}
      </section>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Nuevo usuario</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Nombre completo
              <input
                value={newUser.full_name}
                onChange={(event) => setNewUser({ ...newUser, full_name: event.target.value })}
                placeholder="Carolina Rojas"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Documento
              <input
                value={newUser.documento}
                onChange={(event) => setNewUser({ ...newUser, documento: event.target.value })}
                placeholder="10000001"
                inputMode="numeric"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Tipo de documento
              <select
                value={newUser.id_type}
                onChange={(event) => setNewUser({ ...newUser, id_type: event.target.value })}
                className={inputClass}
              >
                <option value="CC">CC</option>
                <option value="CE">CE</option>
                <option value="PPT">PPT</option>
                <option value="PEP">PEP</option>
                <option value="otro">Otro</option>
              </select>
            </label>
            <label className={labelClass}>
              Correo
              <input
                value={newUser.email}
                onChange={(event) => setNewUser({ ...newUser, email: event.target.value })}
                placeholder="nombre@correo.co"
                inputMode="email"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Teléfono (opcional)
              <input
                value={newUser.phone}
                onChange={(event) => setNewUser({ ...newUser, phone: event.target.value })}
                placeholder="300 111 0101"
                inputMode="tel"
                className={inputClass}
              />
            </label>
                  <fieldset className="flex flex-col gap-1 text-sm">
                    <legend>Rol</legend>
                    {ROLE_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="nuevo-rol"
                          checked={newUser.role === option.value}
                          onChange={() => setNewUser({ ...newUser, role: option.value })}
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
            <DialogFooter className="sm:col-span-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className={ghostClass}
              >
                Cancelar
              </button>
              <button type="submit" disabled={busyId === "nuevo"} className={buttonClass}>
                {busyId === "nuevo" ? "Creando…" : "Crear usuario"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
