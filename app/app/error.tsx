"use client";

import { useEffect } from "react";

/**
 * Boundary de error del App Router (app/app/error.tsx).
 * Se muestra ante un fallo de render en cualquier ruta hija.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Registro mínimo en consola para diagnóstico local.
    // eslint-disable-next-line no-console
    console.error("AppError:", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold">Algo salió mal</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Ocurrió un error inesperado al cargar esta sección. Podés intentarlo de nuevo.
      </p>
      <button
        type="button"
        onClick={reset}
        className="h-10 rounded-md bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
      >
        Reintentar
      </button>
    </main>
  );
}
