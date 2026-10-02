"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MainNav } from "@/src/shared/components/main-nav";

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
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
