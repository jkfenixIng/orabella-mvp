"use client";

import { useState, type FormEvent } from "react";

import { Eye, EyeOff } from "lucide-react";

import { Alert } from "@/src/components/ui/lib/alert";
import { cn } from "@/src/components/ui/lib/utils";
import {
  buttonClass,
  inputClass,
  sectionTitleClass,
} from "@/src/shared/lib/ui-styles";

type Step = "login" | "force-change" | "done";

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    success: boolean;
    data?: { must_change_password?: boolean };
    code?: string;
    message?: string;
  } | null;
  return { status: response.status, payload };
}

/** Clase del input con hueco para el toggle de visibilidad (a la derecha). */
const passwordInputClass = cn(inputClass, "w-full pr-10");

/**
 * Toggle de visibilidad de clave (lo llevan los tres campos de clave). El
 * nombre accesible viene del `aria-label` del botón —los iconos van
 * `aria-hidden`, el gráfico no aporta nombre— y `aria-pressed` da el estado:
 * el lector escucha "Mostrar clave, botón, activado" en vez del nombre del
 * icono. La etiqueta describe la ACCIÓN siguiente (mostrar/ocultar), no el
 * atributo actual, así que cambia con el estado.
 */
function passwordToggle(show: boolean, setShow: (value: boolean) => void) {
  return (
    <button
      type="button"
      onClick={() => setShow(!show)}
      aria-label={show ? "Ocultar clave" : "Mostrar clave"}
      aria-pressed={show}
      className="absolute inset-y-0 right-0 flex items-center px-3 text-text-tertiary transition-colors hover:text-text-primary"
    >
      {show ? (
        <EyeOff className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Eye className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [documento, setDocumento] = useState("");
  const [password, setPassword] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [step, setStep] = useState<Step>("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Visibilidad por campo, cada una independiente (defecto: oculta).
  const [showPassword, setShowPassword] = useState(false);
  const [showNueva, setShowNueva] = useState(false);
  const [showConfirmar, setShowConfirmar] = useState(false);

  // Espejo EXACTO de la política del servidor (passwordPolicySchema,
  // src/features/auth/schemas.ts: min(8) + /[A-Za-z]/ + /[0-9]/). Solo pista:
  // acá no se bloquea el envío por ella, la validación que vale sigue siendo
  // la del servidor.
  const nuevaRulesOk =
    nueva.length >= 8 && /[A-Za-z]/.test(nueva) && /[0-9]/.test(nueva);

  // La señal vive solo mientras hay algo que decir: campo vacío -> null (la
  // copia del requisito ya está en la etiqueta) y el `<Alert` de abajo no se
  // renderiza. No alimenta `setError` ni al envío: canal derivado separado.
  const nuevaFeed: string | null =
    nueva.length === 0
      ? null
      : nuevaRulesOk
        ? "Cumple los requisitos: 8+ caracteres, letra y número."
        : "Le falta: 8+ caracteres, letra y número.";

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { payload } = await postJson("/api/v1/auth/login", { documento, password });
      if (!payload?.success) {
        // Error genérico del servidor (sin enumerar usuarios).
        setError(payload?.message ?? "Documento o clave inválidos.");
        return;
      }
      if (payload.data?.must_change_password) {
        // AUTH-01: cambio forzado antes de operar.
        setStep("force-change");
        return;
      }
      window.location.href = next ?? "/";
    } finally {
      setBusy(false);
    }
  }

  async function handleForceChange(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (nueva !== confirmar) {
        setError("La confirmación no coincide.");
        return;
      }
      const { payload } = await postJson("/api/v1/auth/password:change", {
        actual: password,
        nueva,
      });
      if (!payload?.success) {
        setError(payload?.message ?? "No se pudo cambiar la clave.");
        return;
      }
      setPassword("");
      setNueva("");
      setConfirmar("");
      setStep("done");
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <section className="rounded-lg border border-border-color p-6 dark:border-border-color-2">
        <h2 className={sectionTitleClass}>Clave actualizada</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Ya puede operar con su nueva clave.
        </p>
        <a className={cn("mt-4", buttonClass)} href={next ?? "/"}>
          Entrar
        </a>
      </section>
    );
  }

  if (step === "force-change") {
    // Paso forzado (AUTH-01): el panel ámbar escrito a mano (el antipatrón que
    // §9 del estándar prohíbe: estilos fuera de la primitiva) pasa a la
    // variante canónica `warning` —la primitiva deriva el MISMO par
    // bg-warning-light + text-warning, así que el render no cambia de píxeles.
    return (
      <Alert variant="warning">
        <h2 className={sectionTitleClass}>Cambio de clave obligatorio</h2>
        <p>
          Su clave inicial es su número de documento. Debe cambiarla antes de continuar (AUTH-01).
        </p>
        <form onSubmit={handleForceChange} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Nueva clave (8+ caracteres, letra y número)
            <div className="relative">
              <input
                type={showNueva ? "text" : "password"}
                value={nueva}
                onChange={(event) => setNueva(event.target.value)}
                autoComplete="new-password"
                className={passwordInputClass}
              />
              {passwordToggle(showNueva, setShowNueva)}
            </div>
          </label>
          {nuevaFeed ? (
            // ESTADO DERIVADO EN VIVO: se calcula de `nueva` mientras se
            // escribe, no es el desenlace de una acción enviada. Es una PISTA
            // que no bloquea nada —el envío sigue abierto y la validación
            // real es la del servidor—, así que NO va en `destructive`: ese
            // canal queda reservado para los dos fallos confirmados (el
            // desajuste de la confirmación y el rechazo del servidor), que
            // siguen asertivos. Es el mismo caso que el SKU de inventario
            // (`destructive` + `role="status"`), con UNA diferencia
            // deliberada: acá la pista es neutra (puede estar "le falta"
            // como "cumple"), no anuncia un problema, y la variante `info`
            // ya DERIVA `role="status"` (polite) de la primitiva. Resultado:
            // el canal derivado existe y el archivo conserva CERO roles
            // escritos a mano —no hace falta override alguno.
            //
            // Queda condicionado a que haya algo que decir: con el campo
            // vacío no se renderiza nada (criterio VACÍO de la serie: no
            // agregar un anuncio que hoy no existe) y deja de anunciarse
            // sola cuando deja de ser el caso. Distinto de un checklist
            // siempre visible: ese AGREGARÍA un anuncio permanente a la
            // pantalla inicial, que hoy no tiene ninguno.
            <Alert variant="info" className="text-xs">
              {nuevaFeed}
            </Alert>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            Confirmar nueva clave
            <div className="relative">
              <input
                type={showConfirmar ? "text" : "password"}
                value={confirmar}
                onChange={(event) => setConfirmar(event.target.value)}
                autoComplete="new-password"
                className={passwordInputClass}
              />
              {passwordToggle(showConfirmar, setShowConfirmar)}
            </div>
          </label>
          {error ? (
            // ESTADO CONFIRMADO, no derivado en vivo: el desajuste de la
            // confirmación se detecta al enviar el formulario, no mientras se
            // escribe (no hay validación por tecleo en este archivo). Es el
            // desenlace de una acción enviada, así que `destructive` deriva
            // role="alert" asertivo —el mismo anuncio que el `<p>` escribía— y
            // queda al lado del campo que hay que corregir.
            <Alert variant="destructive">{error}</Alert>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className={buttonClass}
          >
            {busy ? "Guardando…" : "Cambiar clave"}
          </button>
        </form>
      </Alert>
    );
  }

  return (
    <form onSubmit={handleLogin} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Número de documento
        <input
          value={documento}
          onChange={(event) => setDocumento(event.target.value)}
          autoComplete="username"
          inputMode="numeric"
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Clave
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className={passwordInputClass}
          />
          {passwordToggle(showPassword, setShowPassword)}
        </div>
      </label>
      {error ? (
        // Mismo caso que el error del cambio forzado: la credencial rechazada
        // es el desenlace de una acción ENVIADA (el navegador ya frena el envío
        // vacío con `required`), no algo que se calcule mientras se teclea. Va
        // como estado confirmado, y `destructive` conserva el anuncio asertivo
        // que el `role="alert"` escribía a mano.
        <Alert variant="destructive">{error}</Alert>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className={buttonClass}
      >
        {busy ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
