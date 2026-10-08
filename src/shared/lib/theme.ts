/**
 * Theme preference shared between server (cookie SSR) and client.
 *
 * Single source of truth:
 * - Cookie `orabella-theme` (light | dark | system) read in SSR and by the
 *   blocking inline script before first paint (no flash, NFR-06).
 * - `next-themes` persists to localStorage under the same key as fallback.
 */

const THEME_PREFERENCE = {
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
} as const;

export type ThemePreference =
  (typeof THEME_PREFERENCE)[keyof typeof THEME_PREFERENCE];

export const THEME_COOKIE_NAME = "orabella-theme";
export const THEME_STORAGE_KEY = "orabella-theme";

export function parseThemePreference(value: unknown): ThemePreference | undefined {
  if (
    value === THEME_PREFERENCE.LIGHT ||
    value === THEME_PREFERENCE.DARK ||
    value === THEME_PREFERENCE.SYSTEM
  ) {
    return value;
  }
  return undefined;
}

/**
 * Blocking script inlined in <head> (strategy beforeInteractive).
 * Runs before first paint: cookie -> localStorage -> OS preference.
 */
export const themeInitScript = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE_NAME}=([^;]*)/);var t=m?decodeURIComponent(m[1]):null;if(t!=="light"&&t!=="dark"&&t!=="system"){try{t=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){t=null}}var d=t==="dark"||t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})();`;
