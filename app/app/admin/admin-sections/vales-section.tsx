"use client";

import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/lib/dialog";
import { setVoucherLimitsAction } from "@/src/features/payroll/actions";
import type { VoucherSettingsRow } from "@/src/features/payroll/service";
import {
  buttonClass,
  errorClass,
  ghostClass,
  inputClass,
  labelClass,
  okClass,
  sectionClass,
  sectionTitleClass,
  stackClass,
} from "../admin-styles";
import { formatMoney, toNumber, type ActionResult } from "../admin-shared";

/** Días ISO (1=lunes…7=domingo) con su nombre corto. */
const DAY_NAMES: Array<{ day: number; label: string }> = [
  { day: 1, label: "Lun" },
  { day: 2, label: "Mar" },
  { day: 3, label: "Mié" },
  { day: 4, label: "Jue" },
  { day: 5, label: "Vie" },
  { day: 6, label: "Sáb" },
  { day: 7, label: "Dom" },
];
const ALL_DAYS = DAY_NAMES.map((entry) => entry.day);

type VoucherDaysMode = "all" | "custom";
type VoucherCapsMode = "none" | "daily" | "weekly" | "both";
type VoucherPerDayMode = "same" | "custom";

const VOUCHER_CAPS_OPTIONS: Array<{ value: VoucherCapsMode; label: string }> = [
  { value: "none", label: "Sin topes" },
  { value: "daily", label: "Tope diario" },
  { value: "weekly", label: "Tope semanal" },
  { value: "both", label: "Diario y semanal" },
];

/** Payload con el contrato de voucherLimitsSchema (payroll/schemas.ts). */
interface VoucherLimitsPayload {
  max_per_day: number | null;
  max_per_week: number | null;
  allowed_days: number[];
  per_day_limits: Array<{ day: number; amount: number }>;
}

function voucherDaysMode(initial: VoucherSettingsRow | null): VoucherDaysMode {
  const days = initial?.allowed_days;
  return days && days.length > 0 && days.length < 7 ? "custom" : "all";
}

function voucherSelectedDays(initial: VoucherSettingsRow | null): number[] {
  const days = initial?.allowed_days;
  if (!days || days.length === 0 || days.length >= 7) return [...ALL_DAYS];
  return [...days].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
}

function voucherCapsMode(initial: VoucherSettingsRow | null): VoucherCapsMode {
  const hasDay =
    Number(initial?.max_per_day ?? 0) > 0 || Object.keys(initial?.per_day_limits ?? {}).length > 0;
  const hasWeek = Number(initial?.max_per_week ?? 0) > 0;
  if (hasDay && hasWeek) return "both";
  if (hasDay) return "daily";
  if (hasWeek) return "weekly";
  return "none";
}

function voucherPerDayMode(initial: VoucherSettingsRow | null): VoucherPerDayMode {
  return initial?.per_day_limits && Object.keys(initial.per_day_limits).length > 0 ? "custom" : "same";
}

function voucherPerDayValues(initial: VoucherSettingsRow | null): Record<number, string> {
  const map: Record<number, string> = {};
  for (const [day, amount] of Object.entries(initial?.per_day_limits ?? {})) {
    const numericDay = Number(day);
    if (numericDay >= 1 && numericDay <= 7) map[numericDay] = String(amount);
  }
  return map;
}

/** Etiquetas cortas de los días; null, vacío o los 7 = "todos". */
function voucherDayLabels(days: number[] | null | undefined): string {
  if (!days || days.length === 0 || days.length >= 7) return "todos";
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => DAY_NAMES[day - 1]?.label ?? String(day))
    .join(", ");
}

/** Resumen legible de una configuración guardada. */
function describeVoucherSettings(row: VoucherSettingsRow): string {
  const parts: string[] = [];
  const perDayEntries = Object.entries(row.per_day_limits ?? {});
  if (perDayEntries.length > 0) {
    parts.push(
      `por día ${perDayEntries
        .map(([day, amount]) => `${DAY_NAMES[Number(day) - 1]?.label ?? day} ${formatMoney(amount)}`)
        .join(", ")}`,
    );
  }
  const day = Number(row.max_per_day ?? 0);
  const week = Number(row.max_per_week ?? 0);
  if (day > 0) parts.push(`diario ${formatMoney(day)}`);
  if (week > 0) parts.push(`semanal ${formatMoney(week)}`);
  return `Días: ${voucherDayLabels(row.allowed_days)} · ${parts.length > 0 ? parts.join(" · ") : "sin topes"}`;
}

export function ValesSection({ initial }: { initial: VoucherSettingsRow | null }) {
  const [settings, setSettings] = useState(initial);
  const [daysMode, setDaysMode] = useState<VoucherDaysMode>(() => voucherDaysMode(initial));
  const [selectedDays, setSelectedDays] = useState<number[]>(() => voucherSelectedDays(initial));
  const [capsMode, setCapsMode] = useState<VoucherCapsMode>(() => voucherCapsMode(initial));
  const [perDayMode, setPerDayMode] = useState<VoucherPerDayMode>(() => voucherPerDayMode(initial));
  const [maxDay, setMaxDay] = useState(() => (initial?.max_per_day ? String(initial.max_per_day) : ""));
  const [maxWeek, setMaxWeek] = useState(() => (initial?.max_per_week ? String(initial.max_per_week) : ""));
  const [perDayValues, setPerDayValues] = useState<Record<number, string>>(() => voucherPerDayValues(initial));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<VoucherLimitsPayload | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasDaily = capsMode === "daily" || capsMode === "both";
  const hasWeekly = capsMode === "weekly" || capsMode === "both";
  // Días a los que aplica el tope propio: los indicados, o todos si no hay restricción.
  const perDayDays = daysMode === "custom" ? [...selectedDays].sort((a, b) => a - b) : [...ALL_DAYS];

  function applySettings(row: VoucherSettingsRow) {
    setSettings(row);
    setDaysMode(voucherDaysMode(row));
    setSelectedDays(voucherSelectedDays(row));
    setCapsMode(voucherCapsMode(row));
    setPerDayMode(voucherPerDayMode(row));
    setMaxDay(row.max_per_day ? String(row.max_per_day) : "");
    setMaxWeek(row.max_per_week ? String(row.max_per_week) : "");
    setPerDayValues(voucherPerDayValues(row));
  }

  /** Vista previa viva de lo que quedará configurado al guardar. */
  function previewDraft(): string {
    const dayText = daysMode === "all" ? "todos" : voucherDayLabels(selectedDays);
    const parts: string[] = [];
    if (hasDaily && perDayMode === "custom") {
      const rows = perDayDays
        .map((day) => ({ day, value: toNumber(perDayValues[day] ?? "") }))
        .filter((row): row is { day: number; value: number } => row.value !== null && row.value > 0);
      if (rows.length > 0) {
        parts.push(
          `Por día: ${rows
            .map((row) => `${DAY_NAMES[row.day - 1]?.label ?? row.day} ${formatMoney(row.value)}`)
            .join(", ")}`,
        );
      }
    } else if (hasDaily) {
      const value = toNumber(maxDay);
      if (value !== null && value > 0) parts.push(`Diario: ${formatMoney(value)}`);
    }
    if (hasWeekly) {
      const value = toNumber(maxWeek);
      if (value !== null && value > 0) parts.push(`Semanal: ${formatMoney(value)}`);
    }
    const capsText = parts.length > 0 ? parts.join(" · ") : "Sin topes: los vales no tienen límite.";
    return `Días: ${dayText} · ${capsText}`;
  }

  /** Valida y arma el payload respetando el contrato de voucherLimitsSchema. */
  function buildPayload(): VoucherLimitsPayload | null {
    setError(null);
    setNotice(null);
    const days = daysMode === "all" ? [...ALL_DAYS] : [...selectedDays].sort((a, b) => a - b);
    if (days.length === 0) {
      setError("Elija al menos un día permitido.");
      return null;
    }
    let maxPerDay: number | null = null;
    let maxPerWeek: number | null = null;
    const perDayLimits: Array<{ day: number; amount: number }> = [];
    if (hasDaily) {
      if (perDayMode === "custom") {
        for (const day of perDayDays) {
          const raw = (perDayValues[day] ?? "").trim();
          if (raw === "") continue;
          const value = toNumber(raw);
          if (value === null || value < 0) {
            setError(`Tope inválido para ${DAY_NAMES[day - 1]?.label ?? day}.`);
            return null;
          }
          if (value > 0) perDayLimits.push({ day, amount: value });
        }
        if (perDayLimits.length === 0) {
          setError("Indique el tope de al menos un día.");
          return null;
        }
      } else {
        const value = toNumber(maxDay);
        if (value === null || value <= 0) {
          setError("Indique un tope diario mayor a 0.");
          return null;
        }
        maxPerDay = value;
      }
    }
    if (hasWeekly) {
      const value = toNumber(maxWeek);
      if (value === null || value <= 0) {
        setError("Indique un tope semanal mayor a 0.");
        return null;
      }
      maxPerWeek = value;
    }
    // Regla: con tope propio por día, el tope diario general queda nulo (lo reemplaza).
    return {
      max_per_day: maxPerDay,
      max_per_week: maxPerWeek,
      allowed_days: days,
      per_day_limits: perDayLimits,
    };
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = buildPayload();
    if (payload === null) return;
    setPending(payload);
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (pending === null) return;
    setBusy(true);
    const result: ActionResult<VoucherSettingsRow> = await setVoucherLimitsAction(pending);
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      setConfirmOpen(false);
      setPending(null);
      return;
    }
    applySettings(result.data);
    setNotice("Configuración de vales actualizada.");
    setConfirmOpen(false);
    setPending(null);
  }

  function closeConfirm() {
    if (busy) return;
    setConfirmOpen(false);
    setPending(null);
  }

  return (
    <div className={stackClass}>
      <section className={sectionClass} aria-label="Configuración de vales">
        <h2 className={sectionTitleClass}>Configuración de vales</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {settings
            ? `Actual: ${describeVoucherSettings(settings)}.`
            : "Sin configurar: los vales no tienen límite."}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Días permitidos</legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="vales-dias"
                  checked={daysMode === "all"}
                  onChange={() => setDaysMode("all")}
                />
                Todos los días
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="vales-dias"
                  checked={daysMode === "custom"}
                  onChange={() => setDaysMode("custom")}
                />
                Días indicados
              </label>
            </div>
            {daysMode === "custom" ? (
              <div className="flex flex-wrap gap-3">
                {DAY_NAMES.map((entry) => (
                  <label key={entry.day} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedDays.includes(entry.day)}
                      onChange={(event) =>
                        setSelectedDays((prev) =>
                          event.target.checked
                            ? [...new Set([...prev, entry.day])].sort((a, b) => a - b)
                            : prev.filter((day) => day !== entry.day),
                        )
                      }
                    />
                    {entry.label}
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Topes</legend>
            <div className="flex flex-wrap gap-4">
              {VOUCHER_CAPS_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="vales-topes"
                    checked={capsMode === option.value}
                    onChange={() => setCapsMode(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {hasWeekly ? (
            <label className={`${labelClass} max-w-xs`}>
              Tope por semana
              <input
                value={maxWeek}
                onChange={(event) => setMaxWeek(event.target.value)}
                placeholder="500000"
                inputMode="decimal"
                className={inputClass}
              />
            </label>
          ) : null}

          {hasDaily ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium">Tope por día</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="vales-tope-dia"
                    checked={perDayMode === "same"}
                    onChange={() => setPerDayMode("same")}
                  />
                  Mismo tope para todos los días
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="vales-tope-dia"
                    checked={perDayMode === "custom"}
                    onChange={() => setPerDayMode("custom")}
                  />
                  Tope propio por día
                </label>
              </div>
              {perDayMode === "same" ? (
                <label className={`${labelClass} max-w-xs`}>
                  Tope diario
                  <input
                    value={maxDay}
                    onChange={(event) => setMaxDay(event.target.value)}
                    placeholder="200000"
                    inputMode="decimal"
                    className={inputClass}
                  />
                </label>
              ) : perDayDays.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {perDayDays.map((day) => (
                    <label key={day} className={labelClass}>
                      {DAY_NAMES[day - 1]?.label ?? day}
                      <input
                        value={perDayValues[day] ?? ""}
                        onChange={(event) =>
                          setPerDayValues((prev) => ({ ...prev, [day]: event.target.value }))
                        }
                        placeholder="200000"
                        inputMode="decimal"
                        className={inputClass}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-secondary">
                  Elija al menos un día permitido para definir su tope.
                </p>
              )}
            </fieldset>
          ) : null}

          <div className="flex flex-col gap-1 rounded-md border border-border-color bg-surface-hover p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Vista previa
            </p>
            <p className="text-sm text-text-primary">{previewDraft()}</p>
          </div>

          {error ? (
            <p role="alert" className={errorClass}>
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className={okClass}>
              {notice}
            </p>
          ) : null}

          <div>
            <button type="submit" disabled={busy} className={buttonClass}>
              {busy ? "Guardando…" : "Guardar configuración"}
            </button>
          </div>
        </form>
      </section>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Guardar configuración de vales</DialogTitle>
          </DialogHeader>
          <p className="mt-2 text-sm text-text-secondary">
            ¿Está seguro de guardar la configuración de vales? Esta acción reemplaza los topes y días
            vigentes.
          </p>
          <p className="mt-2 rounded-md border border-border-color bg-surface-hover px-3 py-2 text-sm text-text-primary">
            {previewDraft()}
          </p>
          <DialogFooter className="mt-4">
            <button
              type="button"
              onClick={closeConfirm}
              disabled={busy}
              className={ghostClass}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className={buttonClass}
            >
              {busy ? "Guardando…" : "OK"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
