import { ThemeToggle } from "@/src/shared/components/theme-toggle";

const MODULES = [
  { code: "T2 · Auth", text: "login por documento, roles, bloqueo, recuperación" },
  { code: "T3 · Admin", text: "empleados, servicios, impuestos, métodos de pago" },
  { code: "T4 · Inventario", text: "productos, kardex, alertas, búsqueda" },
  { code: "T5 · Factura", text: "factura interna, consecutivo por sede, cobro dividido" },
  { code: "T6 · Caja", text: "multi-turno, base encadenada, arqueo, vista del día" },
  { code: "T7 · Nómina/vales", text: "periodos, cálculo desde facturación, topes y aprobación" },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Orabella MVP</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Fundación lista (T1): Next.js 15 + React 19 + Supabase + modo oscuro
            sin flash + API-first.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <section className="rounded-lg border border-slate-300 p-4 dark:border-slate-700">
        <h2 className="text-lg font-semibold">Salud de la API</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Route Handler versionado, respuesta con Zod:
        </p>
        <a
          className="mt-2 inline-block text-sm font-medium text-slate-900 underline dark:text-slate-100"
          href="/api/v1/health"
        >
          GET /api/v1/health
        </a>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Orden de construcción (T1 → T7)</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {MODULES.map((module) => (
            <li
              key={module.code}
              className="rounded-lg border border-slate-300 p-3 text-sm dark:border-slate-700"
            >
              <span className="font-semibold">{module.code}:</span> {module.text}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
