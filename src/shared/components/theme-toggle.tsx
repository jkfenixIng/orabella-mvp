"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  THEME_COOKIE_NAME,
  parseThemePreference,
  type ThemePreference,
} from "@/src/shared/lib/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" },
  { value: "system", label: "Sistema" },
];

function writeThemeCookie(value: ThemePreference): void {
  document.cookie = `${THEME_COOKIE_NAME}=${value}; path=/; max-age=31536000; SameSite=Lax`;
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const current = parseThemePreference(theme) ?? "system";

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-border-color p-1 dark:border-border-color-2"
      role="group"
      aria-label="Tema de la aplicación"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={current === option.value}
          onClick={() => {
            setTheme(option.value);
            writeThemeCookie(option.value);
          }}
          className={
            // El segmento elegido se pinta como superficie SELECCIONADA
            // (`bg-surface-selected`) y el resto como texto secundario. El
            // segmento elegido NO puede usar `bg-surface-hover`: ese peldaño
            // (L 0.96 en claro) queda a 0.020 de la página (L 0.98) y el estado
            // activo se vuelve indistinguible. `bg-surface-selected` mantiene el
            // paso en 0.050 en claro y 0.050 en oscuro. Ambos tokens se
            // invierten solos en `.dark`, así que no llevan `dark:`.
            current === option.value
              ? "rounded-md bg-surface-selected px-3 py-1 text-sm text-text-primary"
              : "rounded-md px-3 py-1 text-sm text-text-secondary hover:bg-surface-hover"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
