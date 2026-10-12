import { Skeleton } from "@/src/components/ui/lib/skeleton";

/** Loading state for /vales: header, caps, filters and the voucher list. */
export default function ValesLoading() {
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <span role="status" className="sr-only">Cargando…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <section className="flex flex-col gap-3 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-10 w-32" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-2/3" />
      </section>
    </main>
  );
}
