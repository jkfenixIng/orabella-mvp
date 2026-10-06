"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Bell, Calculator, House, Package, Receipt, Settings, Sparkles, Ticket, Wallet, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/src/components/ui/lib/dialog";
import { ThemeToggle } from "@/src/shared/components/theme-toggle";

interface NavLink {
  href: string;
  label: string;
  description: string;
  Icon: LucideIcon;
  roles: string[];
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
          roles: ["admin", "caja", "empleado"],
        },
        { href: "/cash", label: "Caja", description: "Turnos y cierre del día", Icon: Wallet, roles: ["admin", "caja"] },
        {
          href: "/vales",
          label: "Vales",
          description: "Vales para empleados",
          Icon: Ticket,
          roles: ["admin", "caja", "empleado"],
        },
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
          roles: ["admin", "caja"],
        },
        {
          href: "/services",
          label: "Servicios",
          description: "Qué se brinda y a qué precio",
          Icon: Sparkles,
          roles: ["admin", "caja"],
        },
      ],
  },
  {
    id: "contable",
    label: "Contable",
      links: [
        {
          href: "/payroll",
          label: "Nómina",
          description: "Pagos al personal",
          Icon: Calculator,
          roles: ["admin", "empleado"],
        },
      ],
  },
  {
    id: "control",
    label: "Control",
      links: [
        {
          href: "/admin",
          label: "Administración",
          description: "Empleados, servicios y precios",
          Icon: Settings,
          roles: ["admin"],
        },
        {
          href: "/alerts",
          label: "Alertas",
          description: "Desajustes de caja y cuentas bloqueadas",
          Icon: Bell,
          roles: ["admin"],
        },
      ],
  },
  // El grupo «Instalación» se retiró con la capa de plataforma (decisión del
  // dueño, U12): su única entrada era `/plataforma`, que ya no tiene nada que
  // configurar. Un grupo sin enlaces no se deja declarado: el filtro fail-closed
  // de abajo lo escondería, y un nav que nombra una superficie muerta miente.
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function groupHasActive(pathname: string, group: NavGroup): boolean {
  return group.links.some((link) => isActive(pathname, link.href));
}

/**
 * Sello de marca junto al wordmark "Orabella". Es decorativo: el texto contiguo
 * ya nombra la marca, así que va `aria-hidden` y el `alt` queda para impresión
 * o CSS caído. Dos decisiones deliberadas:
 *   - `border border-border-color-2` es el borde del sistema: en claro el disco
 *     blanco del sello se despega de la superficie, y el mismo token sirve en
 *     oscuro sin variante `dark:`.
 *   - el redondeo usa la clase `radius-full` de `design-tokens.css`, no la
 *     utilidad `rounded-full`: en este archivo esa utilidad es la firma de
 *     pastilla que vigila `badge-adoption.test.ts` (allowlist de 1: el contador
 *     de alertas), y un logo no debe mover ese conteo.
 */
function SealMark() {
  return (
    <img
      src="/orabella-logo.png"
      alt="Orabella"
      width={28}
      height={28}
      className="h-7 w-7 shrink-0 border border-border-color-2 radius-full"
      aria-hidden="true"
    />
  );
}

export function MainNav({ roles, userName, alertsUnread }: { roles: string[]; userName: string | null; alertsUnread: number }) {
  const pathname = usePathname();
  const router = useRouter();
  // Fail closed: without roles only Inicio is visible.
  const visibleGroups: NavGroup[] = NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.filter((link) => link.roles.some((role) => roles.includes(role))),
  })).filter((group) => group.links.length > 0);
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

  // El cajón es de móvil y tableta. Antes el velo y el panel llevaban `lg:hidden`
  // y con eso se iban solos al pasar a escritorio; con la primitiva hay que
  // cerrar el diálogo, porque aunque el panel se esconda el velo y el bloqueo de
  // scroll seguirían activos sobre la barra lateral. Abrir el menú a 390 y girar
  // el teléfono era el camino.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = (event: MediaQueryList | MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false);
    };
    closeOnDesktop(desktop);
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

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
            ? "flex items-center gap-2 rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white"
            : "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
        }
      >
        <House className="h-4 w-4" aria-hidden="true" />
        Inicio
      </Link>
      {visibleGroups.map((group) => {
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
                  ? "flex items-center justify-between rounded-md px-3 py-2 text-sm font-semibold text-text-primary"
                  : "flex items-center justify-between rounded-md px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-hover"
              }
            >
              <span>{group.label}</span>
              <span aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
                ▾
              </span>
            </button>
            {open && (
              <ul id={`nav-grupo-${group.id}`} className="ml-2 flex flex-col gap-1 border-l border-border-color-2 pl-2">
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
                            ? "flex items-center gap-2 rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white"
                            : "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
                        }
                      >
                        <link.Icon className="h-4 w-4" aria-hidden="true" />
                        {link.label}
                        {link.href === "/alerts" && alertsUnread > 0 && (
                          <span className="ml-auto rounded-full bg-error px-2 py-0.5 text-xs font-bold text-white">
                            {alertsUnread}
                          </span>
                        )}
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
    <div className="flex flex-col gap-3 border-t border-border-color-2 pt-3">
      <ThemeToggle />
      {userName && (
        <p className="truncate px-1 text-xs text-text-tertiary" title={userName}>
          En sesión:{" "}
          <span className="font-medium text-text-primary">{userName}</span>
        </p>
      )}
      <button
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
        aria-label="Cerrar sesión"
        className="rounded-md border border-border-color px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50"
      >
        {loggingOut ? "Saliendo…" : "Salir"}
      </button>
    </div>
  );

  return (
    <>
      {/* Barra superior: visible en móvil y tableta */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border-color bg-surface px-4 py-3 lg:hidden dark:border-border-color-2">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold"
          aria-label="Orabella inicio"
        >
          <SealMark />
          Orabella
        </Link>
        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogTrigger
            asChild
            className="h-auto bg-transparent px-3 shadow-none"
          >
            <button
              type="button"
              aria-label={drawerOpen ? "Cerrar menú" : "Abrir menú"}
              aria-controls="menu-movil"
              /* MEDIDO a 320: 38 px de alto, contra el objetivo táctil de 44
                 (`docs/ux-ui-standard.md` §8). La clase que llega a este botón
                 son TRES listas —la base del `DialogTrigger` por `cn`, la del
                 llamador (`h-auto bg-transparent px-3 shadow-none`) y esta, que
                 el `Slot` de Radix pega encima sin fusionar—, así que el piso
                 se pone AQUÍ y no en el token: es lo único que sobrevive a las
                 tres.

                 `max-sm:min-h-11` y no `min-h-11`: abajo de 640 el `min-height`
                 le gana al `height`, así que ni el `h-auto` de la primitiva lo
                 puede tumbar; desde 640 no hay `min-height` declarado y el
                 escritorio queda en los 38 px de siempre. El ANCHO se queda en
                 el que da el contenido (38,58 px medidos) porque el hallazgo es
                 de alto y cambiarlo ensancharía la barra superior del shell. */
              className="rounded-md border border-border-color px-3 py-2 text-sm font-medium max-sm:min-h-11"
            >
              ☰
            </button>
          </DialogTrigger>

          {/*
            R2: el cajón ES `Dialog`, no un `role="dialog"` escrito a mano.

            Medido en Chromium a 320/360/390 con el menú abierto: Escape no lo
            cerraba, el duodécimo Tab aterrizaba en un input DETRÁS del velo, el
            fondo seguía scrolleando (`scrollTo(0,400)` → `scrollY=400`) y al
            cerrar el foco quedaba en `BODY`. La causa era una sola:
            `aria-modal="true"` es una DECLARACIÓN, no un comportamiento. Le
            promete al lector de pantalla que lo de atrás está muerto y no lo
            está, que es justo por lo que el foco se escapa. La primitiva ya
            tenía la trampa de foco, la tecla Escape, el bloqueo de scroll y el
            apilado de z-index que comparte con `Select` y `Combobox`.

            Lo que NO cambia es la geometría: `w-72` (288 px) y el panel pegado
            a la izquierda, que R27 midió y que nunca fue el defecto. Lo que sí
            cambia es el velo, que pasa a ser el de `DialogContent` (`bg-black/60`
            con desenfoque en vez de `bg-black/40`), porque el velo también es
            de la primitiva.

            El `max-h-none` del panel anula la `max-h` de la primitiva
            (`max-h-[calc(100dvh-2rem)]`): un cajón va de borde a borde, y con
            2 rem menos se veía una franja de fondo abajo.
          */}
          <DialogContent
            id="menu-movil"
            className="left-0 top-0 flex h-full max-h-none w-72 max-w-72 translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-none border-0 border-r border-border-color p-4 shadow-xl"
          >
            <DialogTitle className="sr-only">Menú principal</DialogTitle>
            {/* R-C: el cierre del cajón lo monta `DialogContent` (la primitiva),
                así que acá NO va una segunda ✕. Tenía una propia en este
                encabezado, y con las dos el panel mostraba dos cierres en el
                mismo borde: uno por la primitiva y otro por esta línea. */}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-lg font-bold">
                <SealMark />
                Orabella
              </span>
            </div>
            {accordion(() => setDrawerOpen(false))}
            {footer}
          </DialogContent>
        </Dialog>
      </header>

      {/* Barra lateral: solo escritorio, colapsable */}
      <aside
        aria-label="Barra lateral"
        className={
          sidebarCollapsed
            ? "sticky top-0 hidden h-screen w-16 flex-col gap-4 overflow-y-auto border-r border-border-color bg-surface p-2 lg:flex dark:border-border-color-2"
            : "sticky top-0 hidden h-screen w-64 flex-col gap-4 overflow-y-auto border-r border-border-color bg-surface p-4 lg:flex dark:border-border-color-2"
        }
      >
        <div className="flex items-center justify-between gap-2">
          {!sidebarCollapsed && (
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold"
              aria-label="Orabella inicio"
            >
              <SealMark />
              Orabella
            </Link>
          )}
          <button
            type="button"
            aria-label={sidebarCollapsed ? "Ampliar navegación" : "Contraer navegación"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            className="rounded-md border border-border-color px-2 py-1 text-sm"
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
              className="rounded-md px-3 py-2 text-center text-sm text-text-secondary hover:bg-surface-hover"
            >
              ⌂
            </Link>
            {visibleGroups.flatMap((group) =>
              group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-label={link.label}
                  title={`${link.label}: ${link.description}`}
                  aria-current={isActive(pathname, link.href) ? "page" : undefined}
                  className={
                    isActive(pathname, link.href)
                      ? "flex justify-center rounded-md bg-primary-600 px-3 py-2 text-center text-sm font-medium text-white"
                      : "flex justify-center rounded-md px-3 py-2 text-center text-sm text-text-secondary hover:bg-surface-hover"
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
