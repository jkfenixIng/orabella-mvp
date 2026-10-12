"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { findNavLocation, MainNav } from "@/src/shared/components/main-nav";

interface AppShellProps {
  children: ReactNode;
  roles: string[];
  userName: string | null;
  alertsUnread: number;
}

export function AppShell({ children, roles, userName, alertsUnread }: AppShellProps) {
  const pathname = usePathname();
  const isLogin = pathname === "/login" || pathname.startsWith("/login/");

  if (isLogin) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen lg:flex">
      <MainNav roles={roles} userName={userName} alertsUnread={alertsUnread} />
      <div className="min-w-0 flex-1">
        <Breadcrumbs pathname={pathname} />
        {children}
      </div>
    </div>
  );
}

/** Spanish location trail derived from MainNav metadata; hidden on Home and unknown routes. */
function Breadcrumbs({ pathname }: { pathname: string }) {
  const location = findNavLocation(pathname);
  if (!location) return null;
  return (
    <nav aria-label="Ruta de navegación" className="border-b border-border-color px-4 py-2 sm:px-6 dark:border-border-color-2">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
        <li>
          <Link href="/" className="rounded-sm hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
            Inicio
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>{location.group.label}</li>
        <li aria-hidden="true">/</li>
        <li>
          <span aria-current="page" className="font-medium text-text-primary">
            {location.link.label}
          </span>
        </li>
      </ol>
    </nav>
  );
}
