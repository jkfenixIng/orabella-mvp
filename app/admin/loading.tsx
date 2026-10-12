import { Skeleton } from "@/src/components/ui/lib/skeleton";
import { sectionClass } from "./admin-styles";

/** Loading state for /admin: header, tabs and the active section. */
export default function AdminLoading() {
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <span role="status" className="sr-only">Cargando…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-28" />
      </div>
      <div className={`flex flex-col gap-2 ${sectionClass}`}>
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    </main>
  );
}
