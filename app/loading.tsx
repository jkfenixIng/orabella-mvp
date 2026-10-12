import { Skeleton } from '@/src/components/ui/lib/skeleton'

export default function HomeLoading() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12" aria-busy="true">
      <span role="status" className="sr-only">Cargando…</span>
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-full max-w-xl" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </main>
  )
}
