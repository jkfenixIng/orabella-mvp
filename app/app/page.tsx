import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Calculator, Package, Receipt, Settings, TriangleAlert, Wallet } from "lucide-react";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listProducts } from "@/src/features/inventory/service";
import { filterLowStock } from "@/src/features/inventory/schemas";

const MODULES = [
  {
    href: "/invoices",
    name: "Facturación",
    purpose: "Cree las cuentas de sus clientes y reciba pagos en efectivo, tarjeta o mezcla de ambos.",
    Icon: Receipt,
    roles: ["admin", "caja", "empleado"],
  },
  {
    href: "/cash",
    name: "Caja",
    purpose: "Abra y cierre turnos, registre movimientos y consulte el arqueo del día.",
    Icon: Wallet,
    roles: ["admin", "caja"],
  },
  {
    href: "/inventory",
    name: "Inventario",
    purpose: "Controle los productos de la tienda: existencias, entradas, salidas y alertas de poco stock.",
    Icon: Package,
    roles: ["admin", "caja"],
  },
  {
    href: "/admin",
    name: "Administración",
    purpose: "Gestione empleados, servicios, precios, impuestos y formas de pago de su sede.",
    Icon: Settings,
    roles: ["admin"],
  },
  {
    href: "/payroll",
    name: "Nómina y vales",
    purpose: "Calcule la nómina del personal desde la facturación y controle vales y aprobaciones.",
    Icon: Calculator,
    roles: ["admin", "empleado"],
  },
] as const;

export default async function HomePage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/");
  const sedeId = session.user.sede_id;

  const visibleModules = MODULES.filter((module) =>
    module.roles.some((role) => session.roles.includes(role)),
  );
  const canSeeInventory = visibleModules.some((module) => module.href === "/inventory");
  const lowStock = sedeId && canSeeInventory ? filterLowStock(await listProducts(sedeId)) : [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <header>
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Bienvenido a</p>
        <h1 className="mt-1 text-3xl font-bold">Orabella</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          El sistema de su negocio de belleza: ventas, caja, inventario y personal en un solo lugar.
          Elija un módulo para empezar.
        </p>
      </header>

      {lowStock.length > 0 ? (
        <section
          aria-label="Alertas de inventario"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-800 dark:text-amber-200">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" />
            Poco stock ({lowStock.length})
          </h2>
          <ul className="flex flex-col gap-1 text-sm text-amber-900 dark:text-amber-100">
            {lowStock.slice(0, 5).map((item) => (
              <li key={item.id}>
                {item.name} ({item.sku}): quedan {item.stock_qty}, mínimo {item.min_stock}.
              </li>
            ))}
          </ul>
          <Link
            href="/inventory"
            aria-label="Ver inventario con poco stock"
            className="mt-1 w-fit rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            Ver inventario
          </Link>
        </section>
      ) : null}

      <section aria-label="Módulos del sistema">
        <ul className="grid gap-4 sm:grid-cols-2">
          {visibleModules.map((module) => (
            <li
              key={module.href}
              className="flex flex-col gap-2 rounded-lg border border-slate-300 p-4 dark:border-slate-700"
            >
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <module.Icon className="h-5 w-5" aria-hidden="true" />
                {module.name}
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">{module.purpose}</p>
              <Link
                href={module.href}
                aria-label={`Ir a ${module.name}`}
                className="mt-auto inline-block w-fit rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              >
                Entrar
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}