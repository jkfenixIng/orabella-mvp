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
      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 p-1 dark:border-slate-700"
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
            current === option.value
              ? "rounded-md bg-slate-200 px-3 py-1 text-sm text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              : "rounded-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
