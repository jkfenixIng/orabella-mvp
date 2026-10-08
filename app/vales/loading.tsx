import { Skeleton } from "@/src/shared/components/skeleton";

/**
 * Skeleton instantáneo de /vales (streaming de Next.js).
 */
export default function ValesLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12"
    >
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div role="status" className="flex flex-col gap-4">
        <span className="text-sm text-text-secondary">Cargando…</span>
        <Skeleton className="h-10 w-full max-w-sm" />
        <div className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      </div>
    </main>
  );
}
