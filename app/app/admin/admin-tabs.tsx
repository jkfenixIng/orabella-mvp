"use client";

import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import {
  listSedeUsersAction,
  setUserRolesAction,
  upsertEmployeeAction,
  upsertPaymentMethodAction,
  upsertTaxConfigAction,
} from "@/src/features/admin/actions";
import { setVoucherLimitsAction } from "@/src/features/payroll/actions";
import { adminCreateUserAction, adminResetPasswordAction } from "@/src/features/auth/actions";
import {
  deleteDenominationAction,
  updateRegisterBaseAction,
  upsertDenominationAction,
} from "@/src/features/cash/actions";
import type {
  CashDenominationRow,
  CashRegisterRow,
} from "@/src/features/cash/service";
import type {
  EmployeeRow,
  PaymentMethodRow,
  SedeUserRow,
  TaxConfigRow,
} from "@/src/features/admin/service";
import type { RoleCode } from "@/src/features/auth/schemas";
import type { VoucherSettingsRow } from "@/src/features/payroll/service";

type Tab = "empleados" | "roles" | "impuestos" | "metodos" | "vales" | "caja";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "empleados", label: "Empleados" },
  { value: "roles", label: "Roles" },
  { value: "impuestos", label: "Impuestos" },
  { value: "metodos", label: "Métodos de pago" },
  { value: "vales", label: "Vales" },
  { value: "caja", label: "Caja" },
];

const inputClass =
  "rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900";
const labelClass = "flex flex-col gap-1 text-sm";
const buttonClass =
  "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-800 dark:text-slate-100";
const sectionClass = "rounded-lg border border-slate-300 p-4 dark:border-slate-700";
const errorClass = "text-sm text-red-600 dark:text-red-400";
const okClass = "text-sm text-green-700 dark:text-green-400";

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number | string | null): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

interface AdminTabsProps {
  sedeId: string;
  currentUserId: string;
  initialEmployees: EmployeeRow[];
  initialUsers: SedeUserRow[];
  initialTaxes: TaxConfigRow[];
  initialMethods: PaymentMethodRow[];
  initialVoucherSettings: VoucherSettingsRow | null;
  initialRegisters: CashRegisterRow[];
  initialDenominations: CashDenominationRow[];
}

export function AdminTabs(props: AdminTabsProps) {
  const [tab, setTab] = useState<Tab>("empleados");
  const [users, setUsers] = useState(props.initialUsers);

  async function refreshUsers() {
    const result: ActionResult<SedeUserRow[]> = await listSedeUsersAction(props.sedeId);
    if (result.success) setUsers(result.data);
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-300 p-1 dark:border-slate-700"
        role="tablist"
        aria-label="Secciones de administración"
      >
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            onClick={() => setTab(option.value)}
            className={
              tab === option.value
                ? "rounded-md bg-slate-900 px-3 py-1 text-sm text-white dark:bg-slate-800 dark:text-slate-100"
                : "rounded-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === "empleados" ? (
        <EmployeesSection
          sedeId={props.sedeId}
          initial={props.initialEmployees}
          users={users}
          onUsersChanged={() => void refreshUsers()}
        />
      ) : null}
      {tab === "roles" ? (
        <UsersSection
          key={users.map((user) => user.id).join(",")}
          sedeId={props.sedeId}
          initial={users}
          currentUserId={props.currentUserId}
        />
      ) : null}
      {tab === "impuestos" ? (
        <TaxesSection sedeId={props.sedeId} initial={props.initialTaxes} />
      ) : null}
      {tab === "metodos" ? (
        <MethodsSection sedeId={props.sedeId} initial={props.initialMethods} />
      ) : null}
      {tab === "vales" ? (
        <ValesSection initial={props.initialVoucherSettings} />
      ) : null}
      {tab === "caja" ? (
        <CashSection
          initialRegisters={props.initialRegisters}
          initialDenominations={props.initialDenominations}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- empleados ---
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

function EmployeesSection({
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
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de empleados">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Empleados ({visibleRows.length})</h2>
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
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {rows.length === 0 ? "Aún no hay empleados en esta sede." : "Sin resultados para ese filtro."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-600 dark:text-slate-300">
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
                  <tr key={row.id} className="border-t border-slate-200 dark:border-slate-700">
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
                        className="font-medium underline"
                      >
                        Consultar
                      </button>
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3">
                      <button type="button" onClick={() => openEdit(row)} className="font-medium underline">
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

      {notice ? <p className={okClass}>{notice}</p> : null}

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
                <dt className="text-slate-600 dark:text-slate-300">Documento</dt>
                <dd className="font-medium">{dialogRow.document}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Código interno</dt>
                <dd className="font-medium">{dialogRow.employee_code || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Teléfono</dt>
                <dd className="font-medium">{dialogRow.phone || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Cargo</dt>
                <dd className="font-medium">{dialogRow.position || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Sueldo</dt>
                <dd className="font-medium">{payTypeLabel(dialogRow.pay_type)}</dd>
              </div>
              {(dialogRow.pay_type === "fijo" || dialogRow.pay_type === "mixto") && (
                <div>
                  <dt className="text-slate-600 dark:text-slate-300">Salario fijo</dt>
                  <dd className="font-medium">{formatMoney(dialogRow.salary_fixed)}</dd>
                </div>
              )}
              {(dialogRow.pay_type === "porcentaje" || dialogRow.pay_type === "mixto") && (
                <div>
                  <dt className="text-slate-600 dark:text-slate-300">Comisión</dt>
                  <dd className="font-medium">
                    {dialogRow.commission_percent != null ? `${dialogRow.commission_percent}%` : "—"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Usuario de acceso</dt>
                <dd className="font-medium">
                  {dialogRow.user_id ? (userById.get(dialogRow.user_id)?.full_name ?? "Vinculado") : "Sin usuario"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Cobro de comisiones</dt>
                <dd className="font-medium">
                  {dialogRow.payout_mode === "inmediato" ? "De inmediato" : "En nómina"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Correo electrónico</dt>
                <dd className="font-medium">{dialogRow.email || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Fecha de nacimiento</dt>
                <dd className="font-medium">{dialogRow.birth_date || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-300">Estado</dt>
                <dd className="font-medium">{dialogRow.is_active ? "Activo" : "Inactivo"}</dd>
              </div>
            </dl>
          ) : null}
          <DialogFooter>
            <button type="button" onClick={closeDialog} className="rounded border px-4 py-2 text-sm">
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
              <span className="text-slate-600 dark:text-slate-300">Usuario de acceso</span>
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
              <button type="button" onClick={closeDialog} className="rounded border px-4 py-2 text-sm">
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

// --------------------------------------------------------------- impuestos ---
const EMPTY_TAX = { code: "IVA", name: "", percent: "", is_active: false };

function TaxesSection({ sedeId, initial }: { sedeId: string; initial: TaxConfigRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_TAX);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(row: TaxConfigRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, percent: String(row.percent), is_active: row.is_active });
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
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
    setNotice(editingId ? "Impuesto actualizado." : "Impuesto creado.");
    setEditingId(null);
    setForm(EMPTY_TAX);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de impuestos">
        <h2 className="text-lg font-semibold">Impuestos ({rows.length})</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <span>
                <strong>{row.code}</strong> · {row.name} · {row.percent}% ·{" "}
                {row.is_active ? "activo" : "inactivo"}
              </span>
              <button
                type="button"
                onClick={() => startEdit(row)}
                className="text-sm font-medium underline"
              >
                Editar
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={sectionClass} aria-label="Formulario de impuesto">
        <h2 className="text-lg font-semibold">{editingId ? "Editar impuesto" : "Nuevo impuesto"}</h2>
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
            <p role="alert" className={errorClass}>
              {error}
            </p>
          ) : null}
          {notice ? <p className={okClass}>{notice}</p> : null}
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
                className="rounded border px-4 py-2 text-sm"
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

// ----------------------------------------------------------------- métodos ---
const EMPTY_METHOD = { code: "efectivo", name: "", is_active: true, arqueable: true };

function MethodsSection({ sedeId, initial }: { sedeId: string; initial: PaymentMethodRow[] }) {
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
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de métodos de pago">
        <h2 className="text-lg font-semibold">Métodos de pago ({rows.length})</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <span>
                <strong>{row.name}</strong> ({row.code}) ·{" "}
                {row.is_active ? "activo" : "inactivo"} ·{" "}
                {row.arqueable ? "se arquea" : "sin arqueo"}
              </span>
              <button
                type="button"
                onClick={() => startEdit(row)}
                className="text-sm font-medium underline"
              >
                Editar
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={sectionClass} aria-label="Formulario de método de pago">
        <h2 className="text-lg font-semibold">
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
          {notice ? <p className={okClass}>{notice}</p> : null}
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
                className="rounded border px-4 py-2 text-sm"
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

// --------------------------------------------------------------------- caja ---

function CashSection({
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
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Base de caja">
        <h2 className="text-lg font-semibold">Base de caja</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {registers.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <span>
                <strong>{row.name}</strong> · base actual{" "}
                {new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(row.base_configurada)}
              </span>
              <input
                value={baseDrafts[row.id] ?? ""}
                onChange={(event) => setBaseDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                inputMode="numeric"
                placeholder="Nueva base"
                className={inputClass}
              />
              <button type="button" disabled={busy} onClick={() => handleBase(row.id)} className={buttonClass}>
                Guardar base
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={sectionClass} aria-label="Denominaciones">
        <h2 className="text-lg font-semibold">Denominaciones ({denominations.length})</h2>
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
            Agregar
          </button>
        </form>
        <ul className="mt-3 flex flex-col gap-2">
          {denominations.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <span>
                {row.kind} · {row.value} · {row.is_active ? "activa" : "inactiva"}
              </span>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => toggleDenomination(row)} className="text-sm font-medium underline">
                  {row.is_active ? "Desactivar" : "Activar"}
                </button>
                <button type="button" disabled={busy} onClick={() => removeDenomination(row.id)} className="text-sm font-medium underline">
                  Eliminar
                </button>
              </div>
            </li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        ) : null}
        {notice ? <p className={okClass}>{notice}</p> : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- usuarios ---
const ROLE_OPTIONS: Array<{ value: RoleCode; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "caja", label: "Caja" },
  { value: "empleado", label: "Empleado" },
];

function UsersSection({ sedeId, initial, currentUserId }: { sedeId: string; initial: SedeUserRow[]; currentUserId: string }) {
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
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de usuarios">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Usuarios ({rows.length})</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Los usuarios se crean solos al crear el empleado. Aquí solo se asigna rol y se restablece clave.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Aún no hay usuarios en esta sede.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-600 dark:text-slate-300">
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
                    <tr key={row.id} className="border-t border-slate-200 dark:border-slate-700">
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
                          className="font-medium underline disabled:no-underline disabled:opacity-50"
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
                              className="font-medium underline disabled:opacity-50"
                            >
                              Confirmar
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmResetId(null)}
                              className="font-medium underline"
                            >
                              Cancelar
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => setConfirmResetId(row.id)}
                            className="font-medium underline disabled:opacity-50"
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
        {notice ? <p className={`${okClass} mt-3`}>{notice}</p> : null}
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
                className="rounded border px-4 py-2 text-sm"
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

// ------------------------------------------------------------------- vales ---
function ValesSection({ initial }: { initial: VoucherSettingsRow | null }) {
  const [settings, setSettings] = useState(initial);
  const [day, setDay] = useState(initial ? String(initial.max_per_day) : "");
  const [week, setWeek] = useState(initial ? String(initial.max_per_week) : "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<VoucherSettingsRow> = await setVoucherLimitsAction({
      max_per_day: day,
      max_per_week: week,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setSettings(result.data);
    setDay(String(result.data.max_per_day));
    setWeek(String(result.data.max_per_week));
    setNotice("Topes actualizados.");
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Topes de vales">
        <h2 className="text-lg font-semibold">Topes de vales</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {settings
            ? `Actual: ${formatMoney(settings.max_per_day)} por día · ${formatMoney(settings.max_per_week)} por semana.`
            : "Sin topes: los vales no tienen límite."}
        </p>
        <form onSubmit={handleSubmit} className="mt-3 flex max-w-md flex-col gap-3">
          <label className={labelClass}>
            Tope por día
            <input
              value={day}
              onChange={(event) => setDay(event.target.value)}
              placeholder="200000"
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Tope por semana
            <input
              value={week}
              onChange={(event) => setWeek(event.target.value)}
              placeholder="500000"
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          {error ? (
            <p role="alert" className={errorClass}>
              {error}
            </p>
          ) : null}
          {notice ? <p className={okClass}>{notice}</p> : null}
          <div>
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : "Guardar topes"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
