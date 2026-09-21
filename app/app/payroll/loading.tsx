import { Skeleton } from "@/src/shared/components/skeleton";

/**
 * Skeleton instantáneo de /payroll (streaming de Next.js).
 * Mismo layout que la página: encabezado + periodos + vales.
 * El detalle del periodo (ítems + saldos) se carga bajo demanda.
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
        <span className="text-sm text-slate-500 dark:text-slate-400">Cargando…</span>
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      </div>
    </main>
  );
}
