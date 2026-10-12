import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Calculator, Package, Receipt, Settings, Ticket, TriangleAlert, Wallet } from "lucide-react";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { countUnreadAlerts } from "@/src/features/alerts/service";
import { listProducts } from "@/src/features/inventory/service";
import { filterLowStock } from "@/src/features/inventory/schemas";
import { homeWelcomeDescription, homeWelcomeTitle } from "./home-copy";

const MODULES = [
  {
    href: "/invoices",
    name: "Facturación",
    purpose: "Cree cuentas y reciba pagos.",
    Icon: Receipt,
    roles: ["admin", "caja", "empleado"],
  },
  {
    href: "/cash",
    name: "Caja",
    purpose: "Abra y cierre turnos y revise el día.",
    Icon: Wallet,
    roles: ["admin", "caja"],
  },
  {
    href: "/inventory",
    name: "Inventario",
    purpose: "Controle existencias y productos con poco stock.",
    Icon: Package,
    roles: ["admin", "caja"],
  },
  {
    href: "/admin",
    name: "Administración",
    purpose: "Configure empleados, impuestos y pagos.",
    Icon: Settings,
    roles: ["admin"],
  },
  {
    href: "/payroll",
    name: "Nómina",
    purpose: "Calcule la nómina del personal.",
    Icon: Calculator,
    roles: ["admin", "empleado"],
  },
  {
    href: "/vales",
    name: "Vales",
    purpose: "Solicite y apruebe vales.",
    Icon: Ticket,
    roles: ["admin", "caja", "empleado"],
  },
  // La tarjeta «Plataforma» se retiró con la capa (decisión del dueño, U12): la
  // fecha de arranque de la nómina ya no se configura en ninguna parte —la
  // declara el PRIMER settlement— así que el inicio no ofrece un módulo vacío.
] as const;

export default async function HomePage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/");

  const visibleModules = MODULES.filter((module) =>
    module.roles.some((role) => session.roles.includes(role)),
  );
  const canSeeInventory = visibleModules.some((module) => module.href === "/inventory");
  const welcomeTitle = homeWelcomeTitle(session.user.full_name);
  const welcomeDescription = homeWelcomeDescription(visibleModules.map((module) => module.name));
  const lowStock = canSeeInventory ? filterLowStock(await listProducts()) : [];
  const isAdmin = session.roles.includes("admin");
  const unreadAlerts = isAdmin ? await countUnreadAlerts("caja").catch(() => 0) : 0;

  return (
    <PageContainer>
      <PageHeader title={welcomeTitle} description={welcomeDescription} />

      {/* Alerta de error: mismo shape que el aviso ámbar canónico, con tokens de error. */}
      {unreadAlerts > 0 ? (
        <section
          aria-label="Alertas de caja"
          className="flex flex-col gap-2 rounded-md bg-error-light px-3 py-2 text-sm font-medium text-error"
        >
          <h2 className="font-semibold">
            Alertas de caja ({unreadAlerts} sin leer)
          </h2>
          <Link
            href="/alerts"
            aria-label="Ver alertas de caja"
            className="mt-1 w-fit rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            Ver alertas
          </Link>
        </section>
      ) : null}

      {/* Aviso ámbar canónico del proyecto (patrón aceptado). */}
      {lowStock.length > 0 ? (
        <section
          aria-label="Alertas de inventario"
          className="flex flex-col gap-2 rounded-md bg-warning-light px-3 py-2 text-sm font-medium text-warning"
        >
          <h2 className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" />
            Poco stock ({lowStock.length})
          </h2>
          <ul className="flex flex-col gap-1">
            {lowStock.slice(0, 5).map((item) => (
              <li key={item.id}>
                {item.name} ({item.sku}): quedan {item.stock_qty}, mínimo {item.min_stock}.
              </li>
            ))}
          </ul>
          <Link
            href="/inventory"
            aria-label="Ver inventario con poco stock"
            className="mt-1 w-fit rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
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
              className="flex flex-col gap-2 rounded-lg border border-border-color p-4 dark:border-border-color-2"
            >
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <module.Icon className="h-5 w-5" aria-hidden="true" />
                {module.name}
              </h2>
              <p className="text-sm text-text-secondary">{module.purpose}</p>
              <Link
                href={module.href}
                aria-label={`Ir a ${module.name}`}
                className="mt-auto inline-block w-fit rounded-md border border-border-color bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover"
              >
                Entrar
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </PageContainer>
  );
}