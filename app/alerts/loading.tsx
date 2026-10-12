import { Skeleton } from '@/src/components/ui/lib/skeleton'

export default function AlertsLoading() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12" aria-busy="true">
      <span role="status" className="sr-only">Cargando…</span>
      <Skeleton className="h-9 w-36" />
      <Skeleton className="h-5 w-full max-w-lg" />
      <section className="flex flex-col gap-3 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <Skeleton className="h-10 w-full sm:w-72" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    </main>
  )
}
