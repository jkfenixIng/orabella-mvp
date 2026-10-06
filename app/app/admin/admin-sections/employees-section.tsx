"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { EmptyState } from "@/src/components/ui/lib/empty-state";
import { FormDialog } from "@/src/components/ui/lib/form-dialog";
import { cn } from "@/src/components/ui/lib/utils";
import {
  buttonClass,
  ghostClass,
  inputClass,
  labelClass,
  linkButtonClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
  tableHeaderClass,
} from "../admin-styles";
import {
  ROLE_OPTIONS,
  formatMoney,
  toNumber,
  type ActionResult,
} from "../admin-shared";
import {
  formatMoneyInput,
  stripMoneyInput,
  stripPercentageInput,
} from "@/src/shared/lib/money";

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
  pay_frequency: "",
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

/**
 * F2: opciones de la cadencia de pago. El valor vacío es "sin definir": deja la
 * columna en NULL y CONSERVA el cálculo de hoy (el fijo se prorratea por los
 * días calendario del período). Las otras tres dicen en DINERO qué parte del
 * salario fijo mensual paga la nómina: semanal un cuarto, quincenal la mitad,
 * mensual el mes completo. Es la única copia de esa lista: el `select`, la
 * ayuda y el detalle la leen de acá.
 */
const PAY_FREQUENCY_OPTIONS = [
  { value: "", label: "Sin definir" },
  { value: "semanal", label: "Semanal (mensual / 4)" },
  { value: "quincenal", label: "Quincenal (mensual / 2)" },
  { value: "mensual", label: "Mensual (mes completo)" },
] as const;

function payFrequencyLabel(payFrequency: string | null | undefined): string {
  return (
    PAY_FREQUENCY_OPTIONS.find((option) => option.value === (payFrequency ?? ""))?.label ??
    "Sin definir"
  );
}

export function EmployeesSection({
  sedeId,
  initial,
  users,
  onUsersChanged,
}: {
  /**
   * Sólo la necesita el alta de la CUENTA de acceso del empleado, que sigue
   * declarando la instalación en su cuerpo (`create_user_with_role`); el alta y
   * la edición del LEGAJO ya no la envían.
   */
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
      pay_frequency: row.pay_frequency ?? "",
      salary_fixed: row.salary_fixed != null ? String(row.salary_fixed) : "",
      commission_percent: row.commission_percent != null ? String(row.commission_percent) : "",
      is_active: row.is_active,
    });
    setError(null);
    setDialog({ mode: "edit", id: row.id });
  }

  function closeDialog() {
    setDialog(null);
    setEditingId(null);
    setForm(EMPTY_EMPLOYEE);
    setError(null);
  }

  // `FormDialog` ya cortó el submit nativo: acá solo va la lógica.
  async function handleSubmit() {
    setBusy(true);
    setError(null);
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
      full_name: form.full_name,
      document: form.document,
      payout_mode: form.payout_mode,
      email: form.email.trim() === "" ? null : form.email,
      birth_date: form.birth_date.trim() === "" ? null : form.birth_date,
      employee_code: form.employee_code.trim() === "" ? null : form.employee_code,
      phone: form.phone.trim() === "" ? null : form.phone,
      position: form.position.trim() === "" ? null : form.position,
      pay_type: form.pay_type,
      pay_frequency: form.pay_frequency === "" ? null : form.pay_frequency,
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
    toast.success(`${editingId ? "Empleado actualizado." : "Empleado creado."}${userNote}`);
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
          <EmptyState className="mt-2">
            {rows.length === 0 ? "Aún no hay empleados en la instalación." : "Sin resultados para ese filtro."}
          </EmptyState>
        ) : (
          // R4 + R38: la lista de Empleados. Antes era una TABLA de seis
          // columnas dentro del carril `overflow-x-auto` de `DataTable`. Sin
          // piso (`minWidth="none"`) pero con `whitespace-nowrap` en cada
          // celda, la tabla no bajaba del ancho de su contenido: el carril
          // desplazaba y las VEINTE acciones de fila —`Consultar` y `Editar`—
          // quedaban fuera de la pantalla, sin gesto horizontal que las
          // trayera. En una celda el dato tampoco tenía dónde caerse sin
          // arrastrar.
          //
          // Ahora es el patrón de `invoices-client.tsx` y
          // `vouchers-client.tsx`, el mismo y no otro: abajo de `sm` cada fila
          // es una TARJETA de cuatro renglones y cada valor lleva su rótulo —la
          // palabra del encabezado, la misma, y por eso las dos superficies no
          // pueden divergir—; arriba de `sm` cada hoja se ancla a su columna
          // con `sm:col-start-N` y la grilla conserva las seis columnas de hoy,
          // en su orden.
          //
          // PRIORIDAD DE LA TARJETA, en el orden en que se lee:
          // 1. QUIÉN es (Nombre): sin identidad no hay legajo.
          // 2. CON QUÉ documento y en qué ESTADO: lo que resuelve la ficha.
          // 3. PARA QUÉ está (Cargo): lo que se busca al abrir el turno.
          // 4. LAS ACCIONES (Consultar, Editar): su propio renglón, envuelto, y
          //    sin gesto horizontal para llegar a él.
          // Lo que NO se apila porque ya está a mano en `Consultar`: teléfono,
          // correo, código interno, fecha de nacimiento, forma de pago y el
          // resto del legajo.
          <div className="mt-3 overflow-hidden rounded-lg border border-border-color dark:border-border-color-2">
            {/* El encabezado nombra las seis columnas y sólo existe arriba de
                `sm`: abajo la fila dice cada rótulo con su propio valor. */}
            <div
              aria-hidden="true"
              className={cn(
                "hidden grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)_minmax(0,1.15fr)_minmax(0,0.60fr)_minmax(0,0.55fr)_minmax(0,0.60fr)] gap-2 border-b border-border-color px-3 py-2 uppercase tracking-wide sm:grid dark:border-border-color-2",
                tableHeaderClass,
              )}
            >
              <span>Nombre</span>
              <span>Documento</span>
              <span>Cargo</span>
              <span>Estado</span>
              <span>Ver</span>
              <span>Editar</span>
            </div>
            <ul className="flex flex-col divide-y divide-border-color dark:divide-border-color-2">
              {visibleRows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)_minmax(0,1.15fr)_minmax(0,0.60fr)_minmax(0,0.55fr)_minmax(0,0.60fr)] sm:items-center sm:gap-2"
                >
                  {/* Las cuatro líneas de la tarjeta móvil. Abajo de `sm` cada
                      hoja es un renglón con su rótulo; cada envoltorio
                      `sm:contents` se borra de la grilla de arriba, donde la
                      hoja se queda en la columna que su `sm:col-start-N` fija. */}
                  <span className="flex items-center gap-2 sm:contents">
                    <span className="break-words text-sm font-medium text-text-primary sm:col-start-1 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Nombre: </span>
                      {row.full_name}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 sm:contents">
                    <span className="break-words text-sm text-text-primary sm:col-start-2 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Documento: </span>
                      {row.document}
                    </span>
                    <span className="text-sm text-text-primary sm:col-start-4 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Estado: </span>
                      {row.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 sm:contents">
                    <span className="break-words text-sm text-text-primary sm:col-start-3 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Cargo: </span>
                      {row.position ?? "—"}
                    </span>
                  </span>
                  {/* Las dos acciones en su propio renglón: `flex-wrap` para que
                      los dos botones quepan en 320 px sin empujar la fila. */}
                  <span className="flex flex-wrap items-center gap-2 sm:contents">
                    <span className="flex flex-wrap items-center gap-2 sm:col-start-5 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Ver: </span>
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
                    </span>
                    <span className="flex flex-wrap items-center gap-2 sm:col-start-6 sm:row-start-1">
                      <span className="font-sans font-medium text-text-secondary sm:hidden">Editar: </span>
                      <button type="button" onClick={() => openEdit(row)} className={linkButtonClass}>
                        Editar
                      </button>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

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
              <div>
                <dt className="text-text-secondary">Frecuencia de pago</dt>
                <dd className="font-medium">{payFrequencyLabel(dialogRow.pay_frequency)}</dd>
              </div>
              {(dialogRow.pay_type === "fijo" || dialogRow.pay_type === "mixto") && (
                <div>
                  <dt className="text-text-secondary">Salario fijo mensual</dt>
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

      {/* `lg`: el formulario es de dos columnas, como el que escribía el
          archivo a mano. El título, el error y el pie los pone la primitiva. */}
      <FormDialog
        open={dialog?.mode === "create" || dialog?.mode === "edit"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={dialog?.mode === "edit" ? "Editar empleado" : "Nuevo empleado"}
        onSubmit={handleSubmit}
        busy={busy}
        submitLabel={dialog?.mode === "edit" ? "Guardar cambios" : "Crear empleado"}
        busyLabel="Guardando…"
        error={error}
        size="lg"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              Código interno (opcional, único en la instalación)
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
              <label className="relative flex items-center gap-2 font-medium after:absolute after:-inset-1.5">
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
                      <label
                        key={option.value}
                        className="relative flex items-center gap-1 after:absolute after:-inset-1.5"
                      >
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
              Salario fijo mensual (fijo/mixto)
              <input
                value={formatMoneyInput(form.salary_fixed)}
                onChange={(event) => setForm({ ...form, salary_fixed: stripMoneyInput(event.target.value) })}
                placeholder="1400000"
                inputMode="numeric"
                className={inputClass}
              />
              <span className="text-xs text-text-tertiary">
                Es el sueldo por MES: la nómina paga la parte que corresponde a los días del período.
              </span>
            </label>
            <label className={labelClass}>
              Frecuencia de pago
              <select
                value={form.pay_frequency}
                onChange={(event) => setForm({ ...form, pay_frequency: event.target.value })}
                className={inputClass}
              >
                {PAY_FREQUENCY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-text-tertiary">
                Cómo se paga el salario fijo mensual: semanal, un cuarto (mensual / 4);
                quincenal, la mitad (mensual / 2); mensual, el mes completo. «Sin definir»
                conserva el cálculo de hoy: el fijo se prorratea por los días del período.
              </span>
            </label>
            <label className={labelClass}>
              Comisión % (porcentaje/mixto, 0–100)
              <input
                value={form.commission_percent}
                onChange={(event) => setForm({ ...form, commission_percent: stripPercentageInput(event.target.value) })}
                placeholder="30"
                inputMode="decimal"
                className={inputClass}
              />
            </label>
            <label className="relative flex items-center gap-2 text-sm after:absolute after:-inset-1.5">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
              />
              Activo
            </label>
        </div>
      </FormDialog>
    </div>
  );
}
