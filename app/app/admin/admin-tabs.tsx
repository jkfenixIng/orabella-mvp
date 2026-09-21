"use client";

import { useState, type FormEvent } from "react";
import {
  upsertEmployeeAction,
  upsertPaymentMethodAction,
  upsertServiceAction,
  upsertTaxConfigAction,
} from "@/src/features/admin/actions";
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
  ServiceRow,
  TaxConfigRow,
} from "@/src/features/admin/service";

type Tab = "empleados" | "servicios" | "impuestos" | "metodos" | "caja";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "empleados", label: "Empleados" },
  { value: "servicios", label: "Servicios" },
  { value: "impuestos", label: "Impuestos" },
  { value: "metodos", label: "Métodos de pago" },
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

interface AdminTabsProps {
  sedeId: string;
  initialEmployees: EmployeeRow[];
  initialServices: ServiceRow[];
  initialTaxes: TaxConfigRow[];
  initialMethods: PaymentMethodRow[];
  initialRegisters: CashRegisterRow[];
  initialDenominations: CashDenominationRow[];
}

export function AdminTabs(props: AdminTabsProps) {
  const [tab, setTab] = useState<Tab>("empleados");

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
        <EmployeesSection sedeId={props.sedeId} initial={props.initialEmployees} />
      ) : null}
      {tab === "servicios" ? (
        <ServicesSection sedeId={props.sedeId} initial={props.initialServices} />
      ) : null}
      {tab === "impuestos" ? (
        <TaxesSection sedeId={props.sedeId} initial={props.initialTaxes} />
      ) : null}
      {tab === "metodos" ? (
        <MethodsSection sedeId={props.sedeId} initial={props.initialMethods} />
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
  document: "",
  employee_code: "",
  phone: "",
  position: "",
  user_id: "",
  pay_type: "fijo",
  salary_fixed: "",
  commission_percent: "",
  is_active: true,
};

function EmployeesSection({ sedeId, initial }: { sedeId: string; initial: EmployeeRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_EMPLOYEE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(row: EmployeeRow) {
    setEditingId(row.id);
    setForm({
      document: row.document,
      employee_code: row.employee_code ?? "",
      phone: row.phone ?? "",
      position: row.position ?? "",
      user_id: row.user_id ?? "",
      pay_type: row.pay_type,
      salary_fixed: row.salary_fixed != null ? String(row.salary_fixed) : "",
      commission_percent: row.commission_percent != null ? String(row.commission_percent) : "",
      is_active: row.is_active,
    });
    setError(null);
    setNotice(null);
  }

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_EMPLOYEE);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<EmployeeRow> = await upsertEmployeeAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: sedeId,
      document: form.document,
      employee_code: form.employee_code.trim() === "" ? null : form.employee_code,
      phone: form.phone.trim() === "" ? null : form.phone,
      position: form.position.trim() === "" ? null : form.position,
      user_id: form.user_id.trim() === "" ? null : form.user_id,
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
    setNotice(editingId ? "Empleado actualizado." : "Empleado creado.");
    resetForm();
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de empleados">
        <h2 className="text-lg font-semibold">Empleados ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Aún no hay empleados en esta sede.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
              >
                <span>
                  <strong>{row.document}</strong>
                  {row.employee_code ? ` · código ${row.employee_code}` : " · sin código"}
                  {row.position ? ` · ${row.position}` : ""} · {row.pay_type}
                  {!row.is_active ? " · inactivo" : ""}
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
        )}
      </section>

      <section className={sectionClass} aria-label="Formulario de empleado">
        <h2 className="text-lg font-semibold">{editingId ? "Editar empleado" : "Nuevo empleado"}</h2>
        <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Documento
            <input
              value={form.document}
              onChange={(event) => setForm({ ...form, document: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Código interno (opcional, único por sede)
            <input
              value={form.employee_code}
              onChange={(event) => setForm({ ...form, employee_code: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Teléfono
            <input
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Cargo
            <input
              value={form.position}
              onChange={(event) => setForm({ ...form, position: event.target.value })}
              className={inputClass}
            />
          </label>
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
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Comisión % (porcentaje/mixto, 0–100)
            <input
              value={form.commission_percent}
              onChange={(event) => setForm({ ...form, commission_percent: event.target.value })}
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Usuario de acceso (id, opcional)
            <input
              value={form.user_id}
              onChange={(event) => setForm({ ...form, user_id: event.target.value })}
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
            <p role="alert" className={errorClass}>
              {error}
            </p>
          ) : null}
          {notice ? <p className={okClass}>{notice}</p> : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear empleado"}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} className="rounded border px-4 py-2 text-sm">
                Cancelar
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}

// --------------------------------------------------------------- servicios ---
const EMPTY_SERVICE = {
  name: "",
  description: "",
  price: "",
  duracion_min: "",
  duracion_max: "",
  is_active: true,
};

function ServicesSection({ sedeId, initial }: { sedeId: string; initial: ServiceRow[] }) {
  const [rows, setRows] = useState(initial);
  const [form, setForm] = useState(EMPTY_SERVICE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit(row: ServiceRow) {
    setEditingId(row.id);
    setForm({
      name: row.name,
      description: row.description ?? "",
      price: String(row.price),
      duracion_min: String(row.duracion_min),
      duracion_max: String(row.duracion_max),
      is_active: row.is_active,
    });
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result: ActionResult<ServiceRow> = await upsertServiceAction({
      ...(editingId ? { id: editingId } : {}),
      sede_id: sedeId,
      name: form.name,
      description: form.description.trim() === "" ? null : form.description,
      price: toNumber(form.price) ?? 0,
      duracion_min: toNumber(form.duracion_min) ?? 0,
      duracion_max: toNumber(form.duracion_max) ?? 0,
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
    setNotice(editingId ? "Servicio actualizado." : "Servicio creado.");
    setEditingId(null);
    setForm(EMPTY_SERVICE);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={sectionClass} aria-label="Listado de servicios">
        <h2 className="text-lg font-semibold">Servicios ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Aún no hay servicios en esta sede.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
              >
                <span>
                  <strong>{row.name}</strong> · ${row.price} · {row.duracion_min}–
                  {row.duracion_max} min{!row.is_active ? " · inactivo" : ""}
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
        )}
      </section>

      <section className={sectionClass} aria-label="Formulario de servicio">
        <h2 className="text-lg font-semibold">{editingId ? "Editar servicio" : "Nuevo servicio"}</h2>
        <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Nombre
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Precio
            <input
              value={form.price}
              onChange={(event) => setForm({ ...form, price: event.target.value })}
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Duración mínima (min)
            <input
              value={form.duracion_min}
              onChange={(event) => setForm({ ...form, duracion_min: event.target.value })}
              inputMode="numeric"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Duración máxima (min)
            <input
              value={form.duracion_max}
              onChange={(event) => setForm({ ...form, duracion_max: event.target.value })}
              inputMode="numeric"
              className={inputClass}
            />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            Descripción
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
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
            <p role="alert" className={errorClass}>
              {error}
            </p>
          ) : null}
          {notice ? <p className={okClass}>{notice}</p> : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : editingId ? "Guardar cambios" : "Crear servicio"}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_SERVICE);
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
    setNotice("Base actualizada (queda auditado).");
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
