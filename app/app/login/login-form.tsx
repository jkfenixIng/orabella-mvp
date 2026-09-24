"use client";

import { useState, type FormEvent } from "react";

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

export function LoginForm({ next }: { next?: string }) {
  const [documento, setDocumento] = useState("");
  const [password, setPassword] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [step, setStep] = useState<Step>("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <h2 className="text-lg font-semibold">Clave actualizada</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Ya puede operar con su nueva clave.
        </p>
        <a
          className="mt-4 inline-block rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          href={next ?? "/"}
        >
          Entrar
        </a>
      </section>
    );
  }

  if (step === "force-change") {
    // Paso forzado (AUTH-01): se unifica al patrón ámbar canónico de advertencia.
    return (
      <section className="rounded-lg bg-amber-50 p-6 text-amber-800">
        <h2 className="text-lg font-semibold">Cambio de clave obligatorio</h2>
        <p className="mt-2 text-sm">
          Su clave inicial es su número de documento. Debe cambiarla antes de continuar (AUTH-01).
        </p>
        <form onSubmit={handleForceChange} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Nueva clave (8+ caracteres, letra y número)
            <input
              type="password"
              value={nueva}
              onChange={(event) => setNueva(event.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm dark:border-border-color-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Confirmar nueva clave
            <input
              type="password"
              value={confirmar}
              onChange={(event) => setConfirmar(event.target.value)}
              autoComplete="new-password"
              className="rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm dark:border-border-color-2"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {busy ? "Guardando…" : "Cambiar clave"}
          </button>
        </form>
      </section>
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
          className="rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm dark:border-border-color-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Clave
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          className="rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm dark:border-border-color-2"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
      >
        {busy ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
