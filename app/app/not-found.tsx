import Link from "next/link";

/**
 * Página 404 del App Router (app/app/not-found.tsx).
 * Se muestra cuando una ruta no existe o no hay acceso a ella.
 */
export default function AppNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <h1 className="text-2xl font-semibold">Página no encontrada</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        La sección que buscás no existe o fue movida.
      </p>
      <Link
        href="/"
        className="h-10 inline-flex items-center rounded-md bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
      >
        Volver al inicio
      </Link>
    </main>
  );
}
