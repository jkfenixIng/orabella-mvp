import { Skeleton } from "@/src/shared/components/skeleton";

/**
 * Skeleton instantáneo de /login (streaming de Next.js).
 * Mismo layout que la página: encabezado + formulario.
 */
export default function LoginLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-screen max-w-md flex-col gap-6 px-6 py-12"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div role="status" className="flex flex-col gap-3">
        <span className="text-sm text-slate-500 dark:text-slate-400">Cargando…</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </main>
  );
}
