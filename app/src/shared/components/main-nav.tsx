"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Calculator, House, Package, Receipt, Settings, Wallet, type LucideIcon } from "lucide-react";
import { ThemeToggle } from "@/src/shared/components/theme-toggle";

interface NavLink {
  href: string;
  label: string;
  description: string;
  Icon: LucideIcon;
}

interface NavGroup {
  id: string;
  label: string;
  links: NavLink[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: "operacion",
    label: "Operación",
      links: [
        {
          href: "/invoices",
          label: "Facturación",
          description: "Crear y cobrar facturas",
          Icon: Receipt,
        },
        { href: "/cash", label: "Caja", description: "Turnos y cierre del día", Icon: Wallet },
      ],
  },
  {
    id: "catalogos",
    label: "Catálogos",
      links: [
        {
          href: "/inventory",
          label: "Inventario",
          description: "Productos y existencias",
          Icon: Package,
        },
        {
          href: "/admin",
          label: "Administración",
          description: "Empleados, servicios y precios",
          Icon: Settings,
        },
      ],
  },
  {
    id: "contable",
    label: "Contable",
      links: [
        {
          href: "/payroll",
          label: "Nómina y vales",
          description: "Pagos al personal",
          Icon: Calculator,
        },
      ],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function groupHasActive(pathname: string, group: NavGroup): boolean {
  return group.links.some((link) => isActive(pathname, link.href));
}

export function MainNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV_GROUPS.map((group) => [group.id, groupHasActive(pathname, group)])),
  );

  useEffect(() => {
    setOpenGroups(
      Object.fromEntries(NAV_GROUPS.map((group) => [group.id, groupHasActive(pathname, group)])),
    );
  }, [pathname]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  function toggleGroup(id: string): void {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function handleLogout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Aunque falle la red, se redirige al ingreso: la sesión expira en el servidor.
    } finally {
      setLoggingOut(false);
      router.push("/login");
      router.refresh();
    }
  }

  const homeActive = pathname === "/";

  const accordion = (onNavigate?: () => void) => (
    <nav aria-label="Navegación principal" className="flex flex-col gap-1">
      <Link
        href="/"
        onClick={onNavigate}
        aria-current={homeActive ? "page" : undefined}
        className={
          homeActive
            ? "flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            : "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        }
      >
        <House className="h-4 w-4" aria-hidden="true" />
        Inicio
      </Link>
      {NAV_GROUPS.map((group) => {
        const open = openGroups[group.id] ?? false;
        const active = groupHasActive(pathname, group);
        return (
          <div key={group.id} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`nav-grupo-${group.id}`}
              onClick={() => toggleGroup(group.id)}
              className={
                active
                  ? "flex items-center justify-between rounded-md px-3 py-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
                  : "flex items-center justify-between rounded-md px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }
            >
              <span>{group.label}</span>
              <span aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
                ▾
              </span>
            </button>
            {open && (
              <ul id={`nav-grupo-${group.id}`} className="ml-2 flex flex-col gap-1 border-l border-slate-200 pl-2 dark:border-slate-700">
                {group.links.map((link) => {
                  const linkActive = isActive(pathname, link.href);
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        onClick={onNavigate}
                        aria-current={linkActive ? "page" : undefined}
                        title={link.description}
                        className={
                          linkActive
                            ? "flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                            : "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                        }
                      >
                        <link.Icon className="h-4 w-4" aria-hidden="true" />
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="flex flex-col gap-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      <ThemeToggle />
      <button
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
        aria-label="Cerrar sesión"
        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        {loggingOut ? "Saliendo…" : "Salir"}
      </button>
    </div>
  );

  return (
    <>
      {/* Barra superior: visible en móvil y tableta */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden dark:border-slate-700 dark:bg-slate-900">
        <Link href="/" className="text-lg font-bold" aria-label="Orabella inicio">
          Orabella
        </Link>
        <button
          type="button"
          aria-label={drawerOpen ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={drawerOpen}
          aria-controls="menu-movil"
          onClick={() => setDrawerOpen((prev) => !prev)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium dark:border-slate-700"
        >
          ☰
        </button>
      </header>

      {/* Menú móvil en acordeón */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            id="menu-movil"
            role="dialog"
            aria-modal="true"
            aria-label="Menú principal"
            className="absolute left-0 top-0 flex h-full w-72 flex-col gap-4 overflow-y-auto bg-white p-4 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold">Orabella</span>
              <button
                type="button"
                aria-label="Cerrar menú"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md border border-slate-300 px-3 py-1 text-sm dark:border-slate-700"
              >
                ✕
              </button>
            </div>
            {accordion(() => setDrawerOpen(false))}
            {footer}
          </div>
        </div>
      )}

      {/* Barra lateral: solo escritorio, colapsable */}
      <aside
        aria-label="Barra lateral"
        className={
          sidebarCollapsed
            ? "sticky top-0 hidden h-screen w-16 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-2 lg:flex dark:border-slate-700 dark:bg-slate-900"
            : "sticky top-0 hidden h-screen w-64 flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4 lg:flex dark:border-slate-700 dark:bg-slate-900"
        }
      >
        <div className="flex items-center justify-between gap-2">
          {!sidebarCollapsed && (
            <Link href="/" className="text-lg font-bold" aria-label="Orabella inicio">
              Orabella
            </Link>
          )}
          <button
            type="button"
            aria-label={sidebarCollapsed ? "Ampliar navegación" : "Contraer navegación"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700"
          >
            {sidebarCollapsed ? "»" : "«"}
          </button>
        </div>
        {sidebarCollapsed ? (
          <nav aria-label="Navegación principal" className="flex flex-col gap-1">
            <Link
              href="/"
              aria-label="Inicio"
              aria-current={homeActive ? "page" : undefined}
              className="rounded-md px-3 py-2 text-center text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              ⌂
            </Link>
            {NAV_GROUPS.flatMap((group) =>
              group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-label={link.label}
                  title={`${link.label}: ${link.description}`}
                  aria-current={isActive(pathname, link.href) ? "page" : undefined}
                  className={
                    isActive(pathname, link.href)
                      ? "flex justify-center rounded-md bg-slate-900 px-3 py-2 text-center text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                      : "flex justify-center rounded-md px-3 py-2 text-center text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  }
                >
                  <link.Icon className="h-4 w-4" aria-hidden="true" />
                </Link>
              )),
            )}
          </nav>
        ) : (
          accordion()
        )}
        {!sidebarCollapsed && footer}
      </aside>
    </>
  );
}
