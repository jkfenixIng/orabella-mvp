function Placeholder({ className }: { className: string }) {
  return <div aria-hidden="true" className={`rounded-md bg-surface-hover motion-safe:animate-pulse ${className}`} />;
}

export default function ServicesLoading() {
  return (
    <main aria-busy="true" className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-12">
      <div className="space-y-2">
        <Placeholder className="h-9 w-40" />
        <Placeholder className="h-4 w-72 max-w-full" />
      </div>
      <div role="status" className="space-y-3 rounded-lg border border-border-color p-4 dark:border-border-color-2">
        <span className="text-sm text-text-secondary">Cargando…</span>
        <Placeholder className="h-11 w-full" />
        <Placeholder className="h-36 w-full" />
        <Placeholder className="h-8 w-full" />
      </div>
    </main>
  );
}
