import { Skeleton } from "@/src/shared/components/skeleton";
import { hintTextClass, sectionClass } from "./admin-styles";

/**
 * Skeleton instantáneo de /admin (streaming de Next.js).
 * Mismo layout que la página: encabezado + 4 tabs + tarjeta de tabla.
 */
export default function AdminLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex w-full flex-col gap-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
      </header>
      <div role="status" className="flex flex-col gap-4">
        <span className={hintTextClass}>Cargando…</span>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className={`flex flex-col gap-2 ${sectionClass}`}>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      </div>
    </main>
  );
}
