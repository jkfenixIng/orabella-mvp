function Placeholder({ className }: { className: string }) {
  return <div aria-hidden="true" className={`rounded-md bg-surface-hover motion-safe:animate-pulse ${className}`} />;
}

/** Instant /inventory skeleton: header, toolbar, list and pager. */
export default function InventoryLoading() {
  return (
    <main aria-busy="true" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <div className="space-y-2">
        <Placeholder className="h-9 w-48" />
        <Placeholder className="h-4 w-80 max-w-full" />
      </div>
      <div role="status" className="space-y-3 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <span className="text-sm text-text-secondary">Cargando…</span>
        <Placeholder className="h-11 w-full" />
        <Placeholder className="h-40 w-full" />
        <Placeholder className="h-8 w-full" />
      </div>
    </main>
  );
}
