import { Skeleton } from "@/src/shared/components/skeleton";

/**
 * Skeleton instantáneo de /payroll (streaming de Next.js).
 * Mismo layout que la página: encabezado + periodos + listado.
 */
export default function PayrollLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex w-full flex-col gap-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-96" />
        </div>
      </header>
      <div role="status" className="flex flex-col gap-4">
        <span className="text-sm text-text-secondary">Cargando…</span>
        <div className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
          <Skeleton className="h-6 w-40" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-10 w-32" />
          </div>
          <Skeleton className="h-10 w-full max-w-xl" />
          <Skeleton className="h-10 w-full max-w-xl" />
        </div>
      </div>
    </main>
  );
}
