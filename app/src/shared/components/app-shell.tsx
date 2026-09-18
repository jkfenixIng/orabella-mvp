"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MainNav } from "@/src/shared/components/main-nav";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isLogin = pathname === "/login" || pathname.startsWith("/login/");

  if (isLogin) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen lg:flex">
      <MainNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
