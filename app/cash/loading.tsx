import { Skeleton } from "@/src/components/ui/lib/skeleton";

/** Loading state for /cash: header, current shift, day view and history. */
export default function CashLoading() {
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <span role="status" className="sr-only">Cargando…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <section className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-10 w-32" />
      </section>
      <section className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-1/2" />
      </section>
      <section className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-5 w-3/4" />
      </section>
    </main>
  );
}
