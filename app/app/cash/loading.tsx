import { Skeleton } from "@/src/shared/components/skeleton";

/**
 * Skeleton instantáneo de /cash (streaming de Next.js).
 * Mismo layout que la página: encabezado + turno + día + historial.
 * La página entra solo con registros + turno abierto + día; el
 * historial se carga bajo demanda con el filtro.
 */
export default function CashLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex w-full flex-col gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-4 w-80" />
        </div>
      </header>
      <div role="status" className="flex flex-col gap-4">
        <span className="text-sm text-text-secondary">Cargando…</span>
        <div className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-1/2" />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </div>
    </main>
  );
}
