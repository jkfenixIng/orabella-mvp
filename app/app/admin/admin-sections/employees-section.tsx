"use client";

import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { upsertEmployeeAction } from "@/src/features/admin/actions";
import { adminCreateUserAction } from "@/src/features/auth/actions";
import type { EmployeeRow, SedeUserRow } from "@/src/features/admin/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import {
  buttonClass,
  errorClass,
  ghostClass,
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
import {
  ROLE_OPTIONS,
  formatMoney,
  toNumber,
  type ActionResult,
} from "../admin-shared";

const EMPTY_EMPLOYEE = {
  full_name: "",
  document: "",
  employee_code: "",
  phone: "",
  position: "",
  payout_mode: "nomina",
  email: "",
  birth_date: "",
  pay_type: "fijo",
  salary_fixed: "",
  commission_percent: "",
  is_active: true,
};

type EmployeeDialog =
  | { mode: "create" }
  | { mode: "edit"; id: string }
  | { mode: "view"; id: string };

function payTypeLabel(payType: string): string {
  if (payType === "fijo") return "Fijo";
  if (payType === "porcentaje") return "Porcentaje";
  return "Mixto";
}

export function EmployeesSection({
  sedeId,
  initial,
  users,
  onUsersChanged,
}: {
  sedeId: string;
  initial: EmployeeRow[];
  users: SedeUserRow[];
  onUsersChanged: () => void;
}) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_EMPLOYEE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<EmployeeDialog | null>(null);
  const [filter, setFilter] = useState("");
  const [createLogin, setCreateLogin] = useState(true);
  const [loginIdType, setLoginIdType] = useState("CC");
  const [loginRole, setLoginRole] = useState<RoleCode>("empleado");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dialogRow =
    dialog && dialog.mode !== "create"
      ? (rows.find((row) => row.id === dialog.id) ?? null)
      : null;

  const visibleRows = rows.filter((row) => {
    const query = filter.trim().toLowerCase();
    if (query === "") return true;
    return (
      row.full_name.toLowerCase().includes(query) ||
      row.document.toLowerCase().includes(query) ||
      (row.position ?? "").toLowerCase().includes(query)
    );
  });

  const userById = new Map(users.map((user) => [user.id, user]));

  function openCreate() {
    setForm(EMPTY_EMPLOYEE);
    setEditingId(null);
    setCreateLogin(true);
    setLoginIdType("CC");
    setLoginRole("empleado");
    setError(null);
    setNotice(null);
    setDialog({ mode: "create" });
  }

  function openEdit(row: EmployeeRow) {
    setEditingId(row.id);
    setCreateLogin(!row.user_id);
    setLoginIdType("CC");
    setLoginRole("empleado");
    setForm({
      full_name: row.full_name,
      document: row.document,
      employee_code: row.employee_code ?? "",
      phone: row.phone ?? "",
      position: row.position ?? "",
      payout_mode: row.payout_mode ?? "nomina",
      email: row.email ?? "",
      birth_date: row.birth_date ?? "",
      pay_type: row.pay_type,
      salary_fixed: row.salary_fixed != null ? String(row.salary_fixed) : "",
      commission_percent: row.commission_percent != null ? String(row.commission_percent) : "",
      is_active: row.is_active,
    });
    setError(null);
    setNotice(null);
    setDialog({ mode: "edit", id: row.id });
  }

  function closeDialog() {
    setDialog(null);
    setEditingId(null);
    setForm(EMPTY_EMPLOYEE);
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    // Alta conjunta: primero el usuario (reutiliza nombre, documento,
    // correo y teléfono del formulario), luego el empleado se vincula solo.
    // En edición solo aplica si el empleado aún no tiene usuario.
    const wantLogin = createLogin && (!editingId || !dialogRow?.user_id);
    let userNote = "";
    if (wantLogin) {
      if (form.email.trim() === "") {
        setBusy(false);
        setError("El correo del empleado es obligatorio para crear su acceso.");
        return;
      }
      const created = await adminCreateUserAction({
        full_name: form.full_name,
        documento: form.document,
        id_type: loginIdType as "CC" | "CE" | "PPT" | "PEP" | "otro",
        email: form.email,
        phone: form.phone.trim() === "" ? undefined : form.phone,
        roles: [loginRole],
        sede_id: sedeId,
      });
      if (!created.success) {
        if (created.code !== "USER_EXISTS") {
          setBusy(false);
          setError(`[${created.code}] ${created.message}`);
          return;
        }
        userNote = " El usuario ya existía y quedó vinculado.";
      } else {
        userNote = " Usuario creado (clave inicial: su documento).";
      }
    }
    const result: ActionResult<EmployeeRow> = await upsertEmployeeAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: sedeId,
      full_name: form.full_name,
      document: form.document,
      payout_mode: form.payout_mode,
      email: form.email.trim() === "" ? null : form.email,
      birth_date: form.birth_date.trim() === "" ? null : form.birth_date,
      employee_code: form.employee_code.trim() === "" ? null : form.employee_code,
      phone: form.phone.trim() === "" ? null : form.phone,
      position: form.position.trim() === "" ? null : form.position,
      pay_type: form.pay_type,
      salary_fixed: toNumber(form.salary_fixed),
      commission_percent: toNumber(form.commission_percent),
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
    setNotice(`${editingId ? "Empleado actualizado." : "Empleado creado."}${userNote}`);
    onUsersChanged();
    closeDialog();
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Listado de empleados">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionTitleClass}>Empleados ({visibleRows.length})</h2>
          <button type="button" onClick={openCreate} className={buttonClass}>
            Nuevo empleado
          </button>
        </div>
        <label className={`${labelClass} mt-3 max-w-md`}>
          Buscar
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Nombre, documento o cargo"
            className={inputClass}
          />
        </label>
        {visibleRows.length === 0 ? (
          <p className={`mt-2 ${mutedTextClass}`}>
            {rows.length === 0 ? "Aún no hay empleados en esta sede." : "Sin resultados para ese filtro."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className={tableHeaderClass}>
                  <th className="whitespace-nowrap py-1 pr-3">Nombre</th>
                  <th className="whitespace-nowrap py-1 pr-3">Documento</th>
                  <th className="whitespace-nowrap py-1 pr-3">Cargo</th>
                  <th className="whitespace-nowrap py-1 pr-3">Estado</th>
                  <th className="whitespace-nowrap py-1 pr-3">Ver</th>
                  <th className="whitespace-nowrap py-1 pr-3">Editar</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id} className={tableRowClass}>
                    <td className="max-w-48 truncate whitespace-nowrap py-1 pr-3" title={row.full_name}>
                      {row.full_name}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">{row.document}</td>
                    <td className="whitespace-nowrap py-1 pr-3">{row.position ?? "—"}</td>
                    <td className="whitespace-nowrap py-1 pr-3">{row.is_active ? "Activo" : "Inactivo"}</td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setDialog({ mode: "view", id: row.id });
                        }}
                        className={linkButtonClass}
                      >
                        Consultar
                      </button>
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      <button type="button" onClick={() => openEdit(row)} className={linkButtonClass}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {notice ? (
        <p role="status" className={okClass}>
          {notice}
        </p>
      ) : null}

      <Dialog
        open={dialog?.mode === "view"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialogRow?.full_name ?? "Empleado"}</DialogTitle>
          </DialogHeader>
          {dialogRow ? (
            <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-secondary">Documento</dt>
                <dd className="font-medium">{dialogRow.document}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Código interno</dt>
                <dd className="font-medium">{dialogRow.employee_code || "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Teléfono</dt>
                <dd className="font-medium">{dialogRow.phone || "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Cargo</dt>
                <dd className="font-medium">{dialogRow.position || "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Sueldo</dt>
                <dd className="font-medium">{payTypeLabel(dialogRow.pay_type)}</dd>
              </div>
              {(dialogRow.pay_type === "fijo" || dialogRow.pay_type === "mixto") && (
                <div>
                  <dt className="text-text-secondary">Salario fijo</dt>
                  <dd className="font-medium">{formatMoney(dialogRow.salary_fixed)}</dd>
                </div>
              )}
              {(dialogRow.pay_type === "porcentaje" || dialogRow.pay_type === "mixto") && (
                <div>
                  <dt className="text-text-secondary">Comisión</dt>
                  <dd className="font-medium">
                    {dialogRow.commission_percent != null ? `${dialogRow.commission_percent}%` : "—"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-text-secondary">Usuario de acceso</dt>
                <dd className="font-medium">
                  {dialogRow.user_id ? (userById.get(dialogRow.user_id)?.full_name ?? "Vinculado") : "Sin usuario"}
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary">Cobro de comisiones</dt>
                <dd className="font-medium">
                  {dialogRow.payout_mode === "inmediato" ? "De inmediato" : "En nómina"}
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary">Correo electrónico</dt>
                <dd className="font-medium">{dialogRow.email || "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Fecha de nacimiento</dt>
                <dd className="font-medium">{dialogRow.birth_date || "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Estado</dt>
                <dd className="font-medium">{dialogRow.is_active ? "Activo" : "Inactivo"}</dd>
              </div>
            </dl>
          ) : null}
          <DialogFooter>
            <button type="button" onClick={closeDialog} className={ghostClass}>
              Cerrar
            </button>
            {dialogRow ? (
              <button type="button" onClick={() => openEdit(dialogRow)} className={buttonClass}>
                Editar
              </button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog?.mode === "create" || dialog?.mode === "edit"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "edit" ? "Editar empleado" : "Nuevo empleado"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Nombre completo
              <input
                value={form.full_name}
                onChange={(event) => setForm({ ...form, full_name: event.target.value })}
                placeholder="Carolina Rojas"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Documento
              <input
                value={form.document}
                onChange={(event) => setForm({ ...form, document: event.target.value })}
                placeholder="10000001"
                inputMode="numeric"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Código interno (opcional, único por sede)
              <input
                value={form.employee_code}
                onChange={(event) => setForm({ ...form, employee_code: event.target.value })}
                placeholder="EMP-01"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Teléfono
              <input
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
                placeholder="300 111 0101"
                inputMode="tel"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Cargo
              <input
                value={form.position}
                onChange={(event) => setForm({ ...form, position: event.target.value })}
                placeholder="Estilista"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-secondary">Usuario de acceso</span>
              <span className="font-medium">
                {dialog?.mode === "edit" && dialogRow?.user_id
                  ? (userById.get(dialogRow.user_id)?.full_name ?? "Vinculado")
                  : "Se vincula solo con el documento."}
              </span>
            </div>
            <label className={labelClass}>
              Cobro de comisiones
              <select
                value={form.payout_mode}
                onChange={(event) => setForm({ ...form, payout_mode: event.target.value })}
                className={inputClass}
              >
                <option value="nomina">En nómina</option>
                <option value="inmediato">De inmediato</option>
              </select>
            </label>
            <label className={labelClass}>
              Correo electrónico
              <input
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="nombre@correo.co"
                inputMode="email"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Fecha de nacimiento
              <input
                type="date"
                value={form.birth_date}
                onChange={(event) => setForm({ ...form, birth_date: event.target.value })}
                className={inputClass}
              />
            </label>
            {(dialog?.mode === "create" || (dialog?.mode === "edit" && !dialogRow?.user_id)) && (
            <div className="flex flex-col gap-1 text-sm sm:col-span-2">
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={createLogin}
                  onChange={(event) => setCreateLogin(event.target.checked)}
                />
                Crear usuario de acceso (usa nombre, documento, correo y teléfono de arriba)
              </label>
              {createLogin && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Tipo de documento
                    <select
                      value={loginIdType}
                      onChange={(event) => setLoginIdType(event.target.value)}
                      className={inputClass}
                    >
                      <option value="CC">CC</option>
                      <option value="CE">CE</option>
                      <option value="PPT">PPT</option>
                      <option value="PEP">PEP</option>
                      <option value="otro">Otro</option>
                    </select>
                  </label>
                  <fieldset className="flex flex-col gap-1 text-sm">
                    <legend>Rol</legend>
                    {ROLE_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="empleado-rol"
                          checked={loginRole === option.value}
                          onChange={() => setLoginRole(option.value)}
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
            </div>
            )}
            <label className={labelClass}>
              Esquema de sueldo
              <select
                value={form.pay_type}
                onChange={(event) => setForm({ ...form, pay_type: event.target.value })}
                className={inputClass}
              >
                <option value="fijo">Fijo</option>
                <option value="porcentaje">Porcentaje</option>
                <option value="mixto">Mixto</option>
              </select>
            </label>
            <label className={labelClass}>
              Salario fijo (fijo/mixto)
              <input
                value={form.salary_fixed}
                onChange={(event) => setForm({ ...form, salary_fixed: event.target.value })}
                placeholder="1400000"
                inputMode="decimal"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Comisión % (porcentaje/mixto, 0–100)
              <input
                value={form.commission_percent}
                onChange={(event) => setForm({ ...form, commission_percent: event.target.value })}
                placeholder="30"
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
              Activo
            </label>
            {error ? (
              <p role="alert" className={`${errorClass} sm:col-span-2`}>
                {error}
              </p>
            ) : null}
            <DialogFooter className="sm:col-span-2">
              <button type="button" onClick={closeDialog} className={ghostClass}>
                Cancelar
              </button>
              <button type="submit" disabled={busy} className={buttonClass}>
                {busy ? "Guardando…" : dialog?.mode === "edit" ? "Guardar cambios" : "Crear empleado"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
