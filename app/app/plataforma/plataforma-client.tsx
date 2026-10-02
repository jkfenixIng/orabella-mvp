"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Alert } from "@/src/components/ui/lib/alert";
import {
  createPlatformSedeAction,
  listPlatformSedeUsersAction,
  setPlatformPayrollStartDateAction,
  setPlatformSedeUserRolesAction,
} from "@/src/features/platform/actions";
import type { PlatformSedeUserRow } from "@/src/features/platform/service";
import type { RoleCode, SedeAssignableRole } from "@/src/features/auth/schemas";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { buttonClass, ghostClass, hintTextClass, inputClass, labelClass } from "@/src/shared/lib/ui-styles";

/**
 * G3b/G5 — islas CLIENTE de la superficie de plataforma.
 *
 * La página sigue siendo el componente servidor con la guarda: acá solo viven
 * las interacciones —el campo de la fecha por sede, el alta de una sede y quién
 * administra cada una—, el toast de éxito y el canal de error. Las escrituras se
 * piden a las acciones de plataforma, que vuelven a aplicar
 * `requirePlatformAdmin` en el servidor: la pantalla no decide quién puede
 * escribir, solo lo ofrece.
 *
 * El valor inicial de la fecha viene leído de la página (SSR) y el éxito de la
 * acción lo pisa con lo que el servidor escribió: el servidor es la única fuente
 * de la fecha, igual que en el resto del módulo.
 */
interface PlataformaPayrollStartDateFormProps {
  sedeId: string;
  sedeName: string;
  initialPayrollStartDate: string | null;
}

type WriteResult = { sede_id: string; payroll_start_date: string | null };

export function PlataformaPayrollStartDateForm({
  sedeId,
  sedeName,
  initialPayrollStartDate,
}: PlataformaPayrollStartDateFormProps) {
  // Fecha vigente de la sede, según el servidor. `null` = «sin configurar».
  const [payrollStartDate, setPayrollStartDate] = useState<string | null>(initialPayrollStartDate);
  // Borrador del campo: lo que se escribió todavía sin guardar (vacío = limpiar).
  const [draft, setDraft] = useState(initialPayrollStartDate ?? "");
  // Un solo canal de error: lo que sigue siendo el caso hasta corregirlo.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(value: string | null) {
    setBusy(true);
    const result = (await setPlatformPayrollStartDateAction({
      sede_id: sedeId,
      payroll_start_date: value,
    })) as ActionResult<WriteResult>;
    setBusy(false);
    if (!result.success) {
      setError(`${result.code}: ${result.message}`);
      return;
    }
    setError(null);
    setPayrollStartDate(result.data.payroll_start_date);
    setDraft(result.data.payroll_start_date ?? "");
    // El éxito es EVENTO: sale por el toast y no se queda compitiendo en pantalla.
    toast.success(
      result.data.payroll_start_date === null
        ? `Se retiró la fecha de inicio de la nómina de ${sedeName}.`
        : `Inicio de la nómina de ${sedeName}: ${result.data.payroll_start_date}.`,
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void save(draft.trim() === "" ? null : draft.trim());
  }

  function handleClear() {
    void save(null);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {error && <Alert variant="destructive">{error}</Alert>}
      <p className="text-sm text-text-secondary">
        Inicio de nómina: {payrollStartDate ?? "Sin configurar"}
      </p>
      <label className={labelClass} htmlFor={`payroll-start-date-${sedeId}`}>
        Fecha de inicio de la nómina
        <input
          id={`payroll-start-date-${sedeId}`}
          type="date"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? "Guardando…" : "Guardar fecha"}
        </button>
        <button
          type="button"
          disabled={busy || payrollStartDate === null}
          onClick={handleClear}
          className={ghostClass}
        >
          Quitar fecha
        </button>
      </div>
      <p className={hintTextClass}>
        Nada anterior a esta fecha existe para el sistema: no se ofrece como ciclo
        y no se puede abrir. Dejarla vacía y guardar también la vuelve a «sin
        configurar».
      </p>
    </form>
  );
}

/* ------------------------------------------------------------ alta de sede -- */

type CreatedSede = { id: string; name: string; is_active: boolean };

/**
 * G5 — ALTA de una sede de la instalación.
 *
 * Los tres campos son los de la fila `sedes` de `003_admin.sql`: el nombre es
 * lo único obligatorio y es el que la 070 hace único; en blanco se manda `null`,
 * nunca una cadena vacía, para que dirección y teléfono queden «sin valor» y no
 * como un texto que parece guardado.
 *
 * El cuerpo NO lleva `id`: desde la plataforma una sede se crea, no se edita. Al
 * crearse, la lista de sedes la vuelve a leer el servidor y la pantalla se
 * refresca para que la sede nueva aparezca con la fila del resto.
 */
export function PlataformaCreateSedeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Texto entered o `null`: en blanco es «sin valor», no una cadena vacía. */
  function textoOpcional(valor: string): string | null {
    const limpio = valor.trim();
    return limpio === "" ? null : limpio;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = (await createPlatformSedeAction({
      name,
      address: textoOpcional(address),
      phone: textoOpcional(phone),
    })) as ActionResult<CreatedSede>;
    setBusy(false);
    if (!result.success) {
      setError(`${result.code}: ${result.message}`);
      return;
    }
    setName("");
    setAddress("");
    setPhone("");
    toast.success(`Sede creada: ${result.data.name}. Ya se puede ingresar con su documento.`);
    // La lista de sedes la lee el servidor: sin este refresco la sede nueva
    // aparecería recién al recargar a mano.
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {error && <Alert variant="destructive">{error}</Alert>}
      <label className={labelClass} htmlFor="sede-nueva-nombre">
        Nombre de la sede
        <input
          id="sede-nueva-nombre"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className={labelClass} htmlFor="sede-nueva-direccion">
        Dirección (opcional)
        <input
          id="sede-nueva-direccion"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className={labelClass} htmlFor="sede-nueva-telefono">
        Teléfono (opcional)
        <input
          id="sede-nueva-telefono"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? "Creando…" : "Crear sede"}
        </button>
      </div>
      <p className={hintTextClass}>
        El nombre es único en toda la instalación: no puede repetirse ni cambiar
        las mayúsculas. La sede nueva empieza sin usuarios y sin fecha de inicio
        de nómina configurada.
      </p>
    </form>
  );
}

/* ------------------------------------------------- quién administra la sede -- */

/**
 * Roles que esta pantalla puede asignar. Es la MISMA lista que la administración
 * de una sede (`sedeAssignableRoleSchema`): el tipo la ata al catálogo, así que un
 * rol nuevo obliga a decidir acá. El rol de plataforma NO está y no se ofrece:
 * quienes lo administran desde la plataforma no se administran a sí mismos desde
 * esta lista. El servidor rechaza el mismo código aunque llegue por la acción.
 */
const OPCIONES_DE_ROL: Array<{ value: SedeAssignableRole; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "caja", label: "Caja" },
  { value: "empleado", label: "Empleado" },
];

type RolesResult = { sede_id: string; user_id: string; roles: SedeAssignableRole[] };

/**
 * G5 — QUIÉN ADMINISTRA la sede elegida: sus usuarios, su rol actual y el rol
 * que se les puede dejar. Dar `admin` y quitárselo son la misma operación —una
 * sede tiene un rol por usuario—: quitarlo es dejarle el que sí corresponde.
 *
 * Los usuarios NO se leen todos de una vez: se piden al abrir, con la acción de
 * plataforma, para que la pantalla abra sin traer el directorio completo de
 * todas las sedes de la instalación. El servidor es la única fuente de la lista
 * y de los roles; la pantalla sólo los refleja y manda el cambio.
 */
export function PlataformaSedeRolesSection({
  sedeId,
  sedeName,
}: {
  sedeId: string;
  sedeName: string;
}) {
  const [rows, setRows] = useState<PlatformSedeUserRow[] | null>(null);
  const [selected, setSelected] = useState<Record<string, RoleCode>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function cargar() {
    setLoading(true);
    setError(null);
    const result = (await listPlatformSedeUsersAction({ sede_id: sedeId })) as ActionResult<
      PlatformSedeUserRow[]
    >;
    setLoading(false);
    if (!result.success) {
      setError(`${result.code}: ${result.message}`);
      return;
    }
    setRows(result.data);
    // Un usuario sin rol (quedó así antes de que el reemplazo fuera atómico)
    // arranca proposing `empleado`: el modelo exige un rol por usuario y ése es
    // el de menor privilegio.
    setSelected(
      Object.fromEntries(result.data.map((row) => [row.id, row.roles[0] ?? "empleado"])),
    );
  }

  function isDirty(row: PlatformSedeUserRow): boolean {
    const elegido = selected[row.id];
    return elegido !== undefined && (row.roles.length !== 1 || row.roles[0] !== elegido);
  }

  async function guardar(row: PlatformSedeUserRow) {
    const rol = selected[row.id];
    if (rol === undefined) return;
    setBusyId(row.id);
    setError(null);
    const result = (await setPlatformSedeUserRolesAction({
      sede_id: sedeId,
      user_id: row.id,
      roles: [rol],
    })) as ActionResult<RolesResult>;
    setBusyId(null);
    if (!result.success) {
      setError(`${result.code}: ${result.message}`);
      return;
    }
    setRows((current) =>
      (current ?? []).map((item) =>
        item.id === row.id ? { ...item, roles: result.data.roles } : item,
      ),
    );
    toast.success(`${sedeName}: ${row.full_name} queda como ${result.data.roles[0]}.`);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void cargar()}
          className={ghostClass}
        >
          {loading ? "Cargando…" : rows === null ? "Administrar esta sede" : "Actualizar listado"}
        </button>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {rows !== null && rows.length === 0 && !error ? (
        <p className="text-sm text-text-secondary">
          Esta sede todavía no tiene usuarios. Se crean al registrar a su primer
          empleado.
        </p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-3 rounded border border-border-color-2 px-3 py-2 text-sm dark:border-border-color-2"
            >
              <span className="text-text-primary">
                {row.full_name}
                <span className="text-text-secondary"> · {row.id_number}</span>
              </span>
              <span className="text-text-secondary">
                {row.roles.length > 0 ? row.roles.join(", ") : "Sin rol"}
              </span>
              <span className="flex flex-wrap gap-3">
                {OPCIONES_DE_ROL.map((opcion) => (
                  <label key={opcion.value} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`rol-plataforma-${row.id}`}
                      checked={selected[row.id] === opcion.value}
                      disabled={busyId === row.id}
                      onChange={() =>
                        setSelected((prev) => ({ ...prev, [row.id]: opcion.value }))
                      }
                    />
                    {opcion.label}
                  </label>
                ))}
              </span>
              <button
                type="button"
                disabled={busyId === row.id || !isDirty(row)}
                onClick={() => void guardar(row)}
                className={ghostClass}
              >
                {busyId === row.id ? "Guardando…" : "Guardar"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={hintTextClass}>
        Quién administra esta sede decide qué entra a su caja, su nómina y su
        facturación. El cambio queda registrado con el rol anterior y el nuevo.
      </p>
    </div>
  );
}