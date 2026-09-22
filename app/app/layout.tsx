import type { Metadata } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/src/shared/components/theme-provider";
import { AppShell } from "@/src/shared/components/app-shell";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { countUnreadAlerts } from "@/src/features/alerts/service";
import {
  parseThemePreference,
  themeInitScript,
  THEME_COOKIE_NAME,
} from "@/src/shared/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orabella MVP",
  description: "Sistema operativo del negocio de belleza: acceso, admin, inventario, factura, caja y nómina.",
};

interface RootLayoutProps {
  children: ReactNode;
}

export default async function RootLayout({ children }: RootLayoutProps) {
  const cookieStore = await cookies();
  const preference = parseThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value);
  // Cookie SSR: fix the class on <html> before streaming so the client
  // never flashes the opposite theme. "system"/missing is resolved
  // pre-paint by the blocking script below.
  const initialClass = preference === "dark" ? "dark" : undefined;
  // Roles for menu visibility (fail closed: no session means no entries).
  // Login pages skip the nav entirely, so this only feeds MainNav.
  const session = await getSessionUser(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  const roles = session?.roles ?? [];
  const alertsUnread =
    session && roles.includes("admin") && session.user.sede_id
      ? await countUnreadAlerts(session.user.sede_id).catch(() => 0)
      : 0;

  return (
    <html lang="es" className={initialClass} suppressHydrationWarning>
      <body>
        <Script id="orabella-theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <ThemeProvider>
          <AppShell roles={roles} userName={session?.user.full_name ?? null} alertsUnread={alertsUnread}>
            {children}
          </AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
