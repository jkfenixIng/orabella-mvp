"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert } from "@/src/components/ui/lib/alert";
import { setPlatformPayrollStartDateAction } from "@/src/features/platform/actions";
import type { ActionResult } from "@/src/shared/lib/api-response";
import { buttonClass, ghostClass, hintTextClass, inputClass, labelClass } from "@/src/shared/lib/ui-styles";

/**
 * Isla CLIENTE de la superficie de plataforma.
 *
 * La página sigue siendo el componente servidor con la guarda: acá solo viven la
 * interacción —el campo de la fecha de inicio de la nómina—, el toast de éxito y
 * el canal de error. La escritura se pide a la acción de plataforma, que vuelve a
 * aplicar `requirePlatformAdmin` en el servidor: la pantalla no decide quién
 * puede escribir, solo lo ofrece. El cuerpo NO lleva la sede —la instalación es
 * de una sola sede y el servidor la resuelve—.
 *
 * El valor inicial de la fecha viene leído de la página (SSR) y el éxito de la
 * acción lo pisa con lo que el servidor escribió: el servidor es la única fuente
 * de la fecha, igual que en el resto del módulo.
 */
interface PlataformaPayrollStartDateFormProps {
  /** Nombre de la instalación: sólo se usa para nombrar lo que se configuró. */
  installationName: string;
  initialPayrollStartDate: string | null;
}

/** Lo que la pantalla necesita de la escritura: la fecha que el servidor aplicó. */
type WriteResult = { payroll_start_date: string | null };

export function PlataformaPayrollStartDateForm({
  installationName,
  initialPayrollStartDate,
}: PlataformaPayrollStartDateFormProps) {
  // Fecha vigente de la instalación, según el servidor. `null` = «sin configurar».
  const [payrollStartDate, setPayrollStartDate] = useState<string | null>(initialPayrollStartDate);
  // Borrador del campo: lo que se escribió todavía sin guardar (vacío = limpiar).
  const [draft, setDraft] = useState(initialPayrollStartDate ?? "");
  // Un solo canal de error: lo que sigue siendo el caso hasta corregirlo.
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(value: string | null) {
    setBusy(true);
    const result = (await setPlatformPayrollStartDateAction({
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
        ? `Se retiró la fecha de inicio de la nómina de ${installationName}.`
        : `Inicio de la nómina de ${installationName}: ${result.data.payroll_start_date}.`,
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
      <label className={labelClass} htmlFor="payroll-start-date">
        Fecha de inicio de la nómina
        <input
          id="payroll-start-date"
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