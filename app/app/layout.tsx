import type { Metadata } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/src/shared/components/theme-provider";
import { AppShell } from "@/src/shared/components/app-shell";
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

  return (
    <html lang="es" className={initialClass} suppressHydrationWarning>
      <body>
        <Script id="orabella-theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
