"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  getAlertsAction,
  markAlertReadAction,
} from "@/src/features/alerts/actions";
import type { AlertRow, AlertsResult } from "@/src/features/alerts/service";
import { cn } from "@/src/components/ui/lib/utils";

const sectionClass = cn(
  "rounded-lg border border-border-color bg-surface p-4 shadow-sm",
  "dark:border-border-color-2",
);
const ghostClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  "dark:border-border-color-2 dark:hover:bg-surface-hover",
);
const errorClass = cn("text-sm text-error", "dark:text-error");

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mismatchParts(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const row = item as Record<string, unknown>;
      const code = typeof row.method_code === "string" ? row.method_code : "?";
      return `${code}: declarado ${formatMoney(row.declared as number)}, esperado ${formatMoney(row.expected as number)}`;
    })
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function alertDetail(alert: AlertRow): string {
  const metadata = alert.metadata ?? {};
  if (alert.action === "cash.shift_open_mismatch") {
    const parts = mismatchParts((metadata as Record<string, unknown>).mismatches);
    return `Apertura con diferencias${parts ? `: ${parts}` : ""}.`;
  }
  if (alert.action === "cash.shift_close_mismatch") {
    const parts = mismatchParts((metadata as Record<string, unknown>).method_differences);
    return `Cierre con diferencias${parts ? `: ${parts}` : ""}.`;
  }
  if (alert.action === "auth.login_locked") {
    return "Cuenta bloqueada por intentos fallidos.";
  }
  if (alert.action === "voucher.requested") {
    const meta = metadata as Record<string, unknown>;
    const amount = typeof meta.amount === "number" ? formatMoney(meta.amount) : "monto sin registrar";
    const reasons: string[] = [];
    if (meta.over_day) reasons.push("sobre tope diario");
    if (meta.over_week) reasons.push("sobre tope semanal");
    if (meta.day_not_allowed) reasons.push("día no permitido");
    return `Vale por ${amount} que exige revisión (${reasons.join(", ") || "revise el detalle"}). Acepte o rechace con motivo en Vales.`;
  }
  return `${alert.action} en ${alert.entity}.`;
}

export function AlertsClient({ initial }: { initial: AlertsResult }) {
  const [result, setResult] = useState<AlertsResult>(initial);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [module, setModule] = useState<"caja" | "acceso" | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isViewPending, startViewTransition] = useTransition();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const router = useRouter();

  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));

  function fetchAlerts(page: number, unread: boolean, mod: "caja" | "acceso" | undefined): void {
    startViewTransition(async () => {
      setBusy(true);
      try {
        const fetched: ActionResult<AlertsResult> = await getAlertsAction({
          unreadOnly: unread,
          page,
          module: mod,
        });
        if (!fetched.success) {
          setError(fetched.message);
          return;
        }
        setError(null);
        setResult(fetched.data);
        setUnreadOnly(unread);
        setModule(mod);
      } finally {
        setBusy(false);
      }
    });
  }

  async function handleMarkRead(id: string): Promise<void> {
    if (reviewNote.trim() === "") {
      setError("La justificación es obligatoria.");
      return;
    }
    setBusy(true);
    try {
      const marked: ActionResult<{ id: string }> = await markAlertReadAction(id, reviewNote.trim());
      if (!marked.success) {
        setError(marked.message);
        return;
      }
      setError(null);
      setReviewingId(null);
      setReviewNote("");
      fetchAlerts(result.page, unreadOnly, module);
      // La insignia del menú vive en el layout (servidor): refrescarla.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}

      <section className={sectionClass} aria-busy={isViewPending}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-600 dark:text-slate-300">Estado:</span>
          <button
            type="button"
            className={ghostClass}
            aria-pressed={!unreadOnly}
            disabled={busy || isViewPending}
            onClick={() => fetchAlerts(1, false, module)}
          >
            Todas
          </button>
          <button
            type="button"
            className={ghostClass}
            aria-pressed={unreadOnly}
            disabled={busy || isViewPending}
            onClick={() => fetchAlerts(1, true, module)}
          >
            Sin leer
          </button>
          <span className="ml-2 text-sm text-slate-600 dark:text-slate-300">Módulo:</span>
          <button
            type="button"
            className={ghostClass}
            aria-pressed={module === undefined}
            disabled={busy || isViewPending}
            onClick={() => fetchAlerts(1, unreadOnly, undefined)}
          >
            Todos
          </button>
          <button
            type="button"
            className={ghostClass}
            aria-pressed={module === "caja"}
            disabled={busy || isViewPending}
            onClick={() => fetchAlerts(1, unreadOnly, "caja")}
          >
            Caja
          </button>
          <button
            type="button"
            className={ghostClass}
            aria-pressed={module === "acceso"}
            disabled={busy || isViewPending}
            onClick={() => fetchAlerts(1, unreadOnly, "acceso")}
          >
            Acceso
          </button>
        </div>

        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {result.alerts.map((alert) => (
            <li
              key={alert.id}
              className={
                alert.is_read
                  ? "border-t border-slate-200 pt-2 dark:border-slate-700"
                  : "border-t border-slate-200 pt-2 font-medium dark:border-slate-700"
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {!alert.is_read && <span aria-hidden="true">● </span>}
                  {formatDateTime(alert.created_at)} · {alertDetail(alert)}
                </span>
                {!alert.is_read && reviewingId !== alert.id && (
                  <button
                    type="button"
                    className={ghostClass}
                    disabled={busy || isViewPending}
                    onClick={() => {
                      setReviewingId(alert.id);
                      setReviewNote("");
                    }}
                  >
                    Revisar
                  </button>
                )}
              </div>
              <p className="mt-1 text-slate-600 dark:text-slate-300">
                {alert.user_name ?? "Usuario no registrado"}
              </p>
              {alert.is_read ? (
                <p className="mt-1 text-slate-600 dark:text-slate-300">
                  Revisada{alert.reviewed_by_name ? ` por ${alert.reviewed_by_name}` : ""}
                  {alert.review_note ? `: «${alert.review_note}»` : ""}.
                </p>
              ) : (
                reviewingId === alert.id && (
                  <form
                    className="mt-2 flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleMarkRead(alert.id);
                    }}
                  >
                    <label className="flex flex-col gap-1 text-sm">
                      Justificación (queda en la traza)
                      <textarea
                        className="rounded-md border border-border-color bg-surface px-3 py-2 text-sm dark:border-border-color-2"
                        value={reviewNote}
                        onChange={(event) => setReviewNote(event.target.value)}
                        placeholder="Qué pasó y qué se habló"
                        rows={2}
                      />
                    </label>
                    <div className="flex gap-2">
                      <button type="submit" className={ghostClass} disabled={busy || isViewPending}>
                        Guardar revisión
                      </button>
                      <button
                        type="button"
                        className={ghostClass}
                        onClick={() => {
                          setReviewingId(null);
                          setReviewNote("");
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                )
              )}
            </li>
          ))}
          {result.alerts.length === 0 && (
            <li className="text-slate-600 dark:text-slate-300">Sin alertas.</li>
          )}
        </ul>

        {pageCount > 1 && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <button
              type="button"
              className={ghostClass}
              disabled={result.page <= 1 || busy || isViewPending}
              onClick={() => fetchAlerts(result.page - 1, unreadOnly, module)}
            >
              Anterior
            </button>
            <span className="text-slate-600 dark:text-slate-300">
              Página {result.page} de {pageCount} ({result.total} alertas)
            </span>
            <button
              type="button"
              className={ghostClass}
              disabled={result.page >= pageCount || busy || isViewPending}
              onClick={() => fetchAlerts(result.page + 1, unreadOnly, module)}
            >
              Siguiente
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
