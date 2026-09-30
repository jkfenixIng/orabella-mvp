import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guardas de contrato de los design tokens (C1-fix).

   Helpers privados de este test:
   - oklch -> sRGB lineal con las matrices de Ottosson;
   - bisección para hallar la chroma máxima que el sRGB puede mostrar, Cmax(L,H);
   - luminancia relativa y contraste según WCAG 2.x.

   Ningún valor de token está hardcodeado: los tokens se leen de los CSS reales.
   Solo son constantes los umbrales (4.5:1 / 3:1 / 1e-6) y las dos superficies
   de tema. Si un token no se puede leer, el test FALLA (no se saltea).
   -------------------------------------------------------------------------- */

type Oklch = { l: number; c: number; h: number };

const APP_ROOT = process.cwd();
const TOKENS_PATH = join(APP_ROOT, "src", "styles", "design-tokens.css");
const GLOBALS_PATH = join(APP_ROOT, "app", "globals.css");
const BUTTON_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "button.tsx");

const TOKENS_CSS = readFileSync(TOKENS_PATH, "utf8");
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");
const BUTTON_TSX = readFileSync(BUTTON_PATH, "utf8");

const AA_TEXT_MIN = 4.5;
const AA_NON_TEXT_MIN = 3;
const GAMUT_TOLERANCE = 1e-6;

/* Paso mínimo de luminancia (oklch L) entre la página y la superficie de un
   control SELECCIONADO. Medido sobre el estado anterior a la regresión: el
   segmento elegido del theme-toggle usaba slate-200 (L 0.929) sobre una página
   neutral-50 (L 0.980), paso 0.051. Con --bg-surface-hover (L 0.960) el paso
   cae a 0.020 y el control deja de leerse. El umbral corta ese caso y no
   obliga a clavar el peldaño exacto. */
const MIN_SURFACE_STEP = 0.04;

// Superficies de tema usadas como fondo de referencia en los contrastes.
const LIGHT_SURFACE: Oklch = { l: 0.98, c: 0, h: 0 };
const DARK_SURFACE: Oklch = { l: 0.17, c: 0, h: 0 };

/** oklch -> sRGB lineal (Ottosson, https://bottosson.github.io/posts/oklab/). */
function oklchToLinearSrgb(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lc = l_ ** 3;
  const mc = m_ ** 3;
  const sc = s_ ** 3;
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

/** ¿La tupla lineal cae dentro del cubo sRGB? Tolerancia configurable. */
function isInSrgbGamut(l: number, c: number, h: number, tolerance = 0): boolean {
  return oklchToLinearSrgb(l, c, h).every(
    (channel) => channel >= -tolerance && channel <= 1 + tolerance,
  );
}

/** Máxima chroma representable en sRGB para un par (L, H). */
function maxChroma(l: number, h: number): number {
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (isInSrgbGamut(l, mid, h)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function luminanceFromLinear([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Luminancia relativa WCAG de un color oklch (canales recortados a sRGB). */
function luminance(token: Oklch): number {
  const linear = oklchToLinearSrgb(token.l, token.c, token.h).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  );
  return luminanceFromLinear(linear as [number, number, number]);
}

/** Razón de contraste WCAG entre dos luminancias relativas. */
function contrastFromLuminance(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(a: Oklch, b: Oklch): number {
  return contrastFromLuminance(luminance(a), luminance(b));
}

/** hex -> sRGB lineal (para tomar el blanco desde globals.css). */
function hexToLinearSrgb(hex: string): [number, number, number] {
  const value = hex.trim().replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear as [number, number, number];
}

/** Lectura plana de bloques `selector { --token: valor; }` (sin anidamiento real). */
function readThemeVars(css: string, selector: string): Map<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = new Map<string, string>();
  const blockRe = /([^{}]*)\{([^{}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(clean)) !== null) {
    // El selector real es lo que sigue al último `;` o `}` previo: así un
    // at-rule previo con comas (p. ej. `@custom-variant`) no contamina el head.
    const head = block[1];
    const selectorPart = head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1);
    const selectors = selectorPart.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) {
      continue;
    }
    const declRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(block[2])) !== null) {
      vars.set(decl[1], decl[2].trim());
    }
  }
  return vars;
}

function parseOklch(value: string | undefined): Oklch | null {
  if (!value) {
    return null;
  }
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (!match) {
    return null;
  }
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

function requireVar(vars: Map<string, string>, name: string, where: string): string {
  const value = vars.get(name);
  expect(value, `${name} debe declararse en ${where}`).toBeDefined();
  return value as string;
}

function oklchToken(vars: Map<string, string>, name: string, where: string): Oklch {
  const raw = requireVar(vars, name, where);
  const token = parseOklch(raw);
  expect(token, `${name} en ${where} debe ser un oklch(...) (valor real: ${raw})`).not.toBeNull();
  return token as Oklch;
}

/** Resuelve `var(--x)` contra una o varias capas de variables. */
function resolveVarToken(raw: string, layers: Array<Map<string, string>>): Oklch {
  const match = /var\(\s*(--[a-zA-Z0-9-]+)\s*\)/.exec(raw);
  expect(match, `se esperaba var(--token), se leyó: ${raw}`).not.toBeNull();
  const name = (match as RegExpExecArray)[1];
  for (const layer of layers) {
    const token = parseOklch(layer.get(name));
    if (token) {
      return token;
    }
  }
  throw new Error(`No se pudo resolver ${name} a un oklch(...) en ${layers.length} capa(s)`);
}

function collectOklchTokens(
  css: string,
): Array<{ selector: string; name: string; token: Oklch }> {
  const collected: Array<{ selector: string; name: string; token: Oklch }> = [];
  for (const selector of [":root", ".dark"]) {
    for (const [name, value] of readThemeVars(css, selector)) {
      const token = parseOklch(value);
      if (token) {
        collected.push({ selector, name, token });
      }
    }
  }
  return collected;
}

const lightVars = readThemeVars(TOKENS_CSS, ":root");
const darkVars = readThemeVars(TOKENS_CSS, ".dark");
// Cascada real: en oscuro rige `.dark` y, si un token no está, cae a `:root`.
const darkTheme = new Map([...lightVars, ...darkVars]);

// El texto de los rellenos sólidos es blanco (`text-white` en button.tsx);
// se toma el blanco de `--background` en globals.css para no hardcodear colores.
const globalsRoot = readThemeVars(GLOBALS_CSS, ":root");
const whiteLuminance = luminanceFromLinear(
  hexToLinearSrgb(requireVar(globalsRoot, "--background", "globals.css :root")),
);
const themeInline = readThemeVars(GLOBALS_CSS, "@theme inline");

/* --------------------------------------------------------------------------
   Pares reales `bg-*-light` + color de texto, leídos de los consumidores (no
   supuestos): las cuatro variantes de src/components/ui/lib/badge.tsx (el par
   ámbar, en la línea 21) y las llamadas a `.bg-*-light` en app/page.tsx:87,106,
   app/cash/cash-client.tsx:747 y app/login/login-form.tsx:99. Desde WU-C la
   nómina y los vales ya no escriben el par ámbar a mano: lo consumen por la
   variante `warning` de src/components/ui/lib/alert.tsx:33.

   En claro el fondo lo da `--color-*-50` y el texto `--color-*-600` (clases
   `.text-*` de design-tokens.css). En oscuro `.dark .bg-*-light` pisa el fondo
   con un literal oklch del propio archivo y `.dark .text-*` usa `--color-*-400`.
   -------------------------------------------------------------------------- */
type StatusPair = {
  label: string;
  ramp: string;
  bg: string;
  fg: string;
  darkBgSelector: string;
  darkTextSelector: string;
};

const STATUS_PAIRS: StatusPair[] = [
  {
    label: "badge default / primary",
    ramp: "--color-primary",
    bg: "--color-primary-50",
    fg: "--color-primary-600",
    darkBgSelector: ".dark .bg-primary-light",
    darkTextSelector: ".dark .text-primary-color",
  },
  {
    label: "badge success / success",
    ramp: "--color-success",
    bg: "--color-success-50",
    fg: "--color-success-600",
    darkBgSelector: ".dark .bg-success-light",
    darkTextSelector: ".dark .text-success",
  },
  {
    label: "aviso ámbar (page.tsx, cash-client.tsx, login-form.tsx, payroll-client.tsx, vouchers-client.tsx)",
    ramp: "--color-warning",
    bg: "--color-warning-50",
    fg: "--color-warning-600",
    darkBgSelector: ".dark .bg-warning-light",
    darkTextSelector: ".dark .text-warning",
  },
  {
    label: "alerta de error (page.tsx:87, badge destructive)",
    ramp: "--color-error",
    bg: "--color-error-50",
    fg: "--color-error-600",
    darkBgSelector: ".dark .bg-error-light",
    darkTextSelector: ".dark .text-error",
  },
];

/** Alias canónicos de shadcn/ui agregados a globals.css: todos referencias vivas. */
const ADDED_ALIASES = [
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--radius",
];

/** Set canónico completo que debe existir (incluye --background/--foreground previos). */
const SHADCN_ALIASES = ["--background", "--foreground", ...ADDED_ALIASES];

/** Capas donde puede declararse un alias, en orden de precedencia real. */
const ALIAS_LAYERS = [globalsRoot, lightVars, darkTheme, themeInline];

/** Familia de radios que Tailwind v4 usa para generar `rounded-*`: no se re-define. */
const RADIUS_FAMILY: Array<[string, string]> = [
  ["--radius-sm", "0.25rem"],
  ["--radius-md", "0.375rem"],
  ["--radius-lg", "0.5rem"],
  ["--radius-xl", "0.75rem"],
  ["--radius-2xl", "1rem"],
  ["--radius-full", "9999px"],
];

/**
 * Lee la última declaración plana (`prop: valor;`) de un bloque por selector exacto.
 * Necesario para `.dark .bg-*-light` / `.dark .text-*`, que declaran propiedades
 * normales y no custom properties.
 */
function readDeclaration(css: string, selector: string, property: string): string | undefined {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /([^{}]*)\{([^{}]*)\}/g;
  const declRe = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`, "g");
  let value: string | undefined;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(clean)) !== null) {
    const head = block[1];
    const selectorPart = head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1);
    const selectors = selectorPart.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) {
      continue;
    }
    declRe.lastIndex = 0;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(block[2])) !== null) {
      value = decl[1].trim();
    }
  }
  return value;
}

/** Igual que oklchToken pero para un literal oklch obtenido con readDeclaration. */
function oklchLiteral(raw: string | undefined, where: string): Oklch {
  expect(raw, `se esperaba una declaración oklch en ${where}`).toBeDefined();
  const token = parseOklch(raw as string);
  expect(token, `${where} debe ser un oklch(...) (valor real: ${raw})`).not.toBeNull();
  return token as Oklch;
}

/**
 * Sigue una cadena `var(--x)` hasta un valor terminal. Ignora las entradas
 * auto-referentes de `@theme inline` (`--color-x: var(--color-x)`), que Tailwind
 * resuelve inline y por eso no son la declaración real del token.
 */
function resolveAlias(name: string, layers: Array<Map<string, string>>): string | null {
  let current = name;
  for (let hop = 0; hop < 8; hop += 1) {
    const raw = layers
      .map((layer) => layer.get(current))
      .find((value) => value !== undefined && value.trim() !== `var(${current})`);
    if (raw === undefined) {
      return null;
    }
    const inner = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/.exec(raw.trim());
    if (!inner) {
      return raw;
    }
    current = inner[1];
  }
  return null;
}

/**
 * Claves canónicas de shadcn/ui declaradas en `@theme inline`. Sin estas claves
 * Tailwind no emite bg-primary, bg-card, text-muted-foreground, border-border,
 * etc., y los componentes del registry (components.json, baseColor slate)
 * quedan sin color.
 */
const CANONICAL_COLOR_KEYS = [
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-secondary-foreground",
  "--color-card",
  "--color-card-foreground",
  "--color-popover",
  "--color-popover-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-destructive",
  "--color-destructive-foreground",
  "--color-border",
  "--color-input",
];

/**
 * El par base del registry (`bg-background` / `text-foreground`), que junto con
 * las 16 claves de arriba son las únicas entradas `--color-*` que existen para
 * los componentes de shadcn. Se cubren aparte —y no dentro de
 * CANONICAL_COLOR_KEYS— porque su valor terminal no es un oklch de
 * design-tokens.css sino el literal hex de `:root` / `.dark` de globals.css:
 * meterlas en el loop de las 16 obligaría a aceptar hex también para ellas, que
 * es justo la laxitud que ese loop existe para impedir.
 */
const BASE_COLOR_KEYS: Array<[key: string, alias: string]> = [
  ["--color-background", "--background"],
  ["--color-foreground", "--foreground"],
];

/**
 * Claves `--color-*` de `@theme inline` que NO son colores del registry: rampa de
 * marca, roles de estado/superficie/texto/borde del proyecto y el anillo de
 * foco. Sirven de complemento explícito en la guarda de cobertura: cualquier
 * clave nueva tiene que caer en una de las tres listas, y con eso una
 * regresión como la de background/foreground (clave canónica ausente, utilidad
 * nunca emitida) falla en vez de pasar desapercibida.
 */
const NON_REGISTRY_COLOR_KEYS = [
  "--color-surface",
  "--color-surface-hover",
  "--color-surface-selected",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-border-color",
  "--color-border-color-2",
  "--color-ring",
  "--color-primary-400",
  "--color-primary-600",
  "--color-primary-700",
  "--color-success",
  "--color-success-400",
  "--color-success-600",
  "--color-warning",
  "--color-warning-400",
  "--color-warning-600",
  "--color-error",
  "--color-error-400",
  "--color-error-600",
];

/** ¿El valor terminal es un color concreto y no otra indirección? */
function isConcreteColor(value: string): boolean {
  const raw = value.trim();
  return (
    /^#[0-9a-f]{3,8}$/i.test(raw) ||
    parseOklch(raw) !== null ||
    /^(?:rgb|rgba|hsl|hsla|oklab|oklch|lab|lch|color)\(/i.test(raw)
  );
}

/**
 * Familias de utilidades que Tailwind deriva de cada clave `--color-*`: el
 * nombre de clase es `<prefijo>-<clave sin el prefijo --color->`.
 */
const COLOR_UTILITY_PREFIXES = [
  "bg",
  "text",
  "border",
  "fill",
  "stroke",
  "outline",
  "ring",
  "divide",
  "accent",
  "caret",
  "decoration",
  "placeholder",
];

/**
 * Clases de las reglas sueltas de un CSS: selector formado por UNA sola clase
 * (`.x`, sin `.dark` delante). Son exactamente las que compiten con una utilidad
 * de `@layer utilities` en igualdad de especificidad y ganan por ir sin capa.
 * Las reglas compuestas (`.dark .x`) son overrides de tema a propósito y quedan
 * fuera de esta lectura.
 */
function bareClassNames(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const block of clean.matchAll(/([^{}]+)\{/g)) {
    for (const part of block[1].split(",")) {
      const single = /^\.([a-zA-Z0-9_-]+)$/.exec(part.trim());
      if (single) {
        names.add(single[1]);
      }
    }
  }
  return [...names].sort();
}

/** Extensiones donde un nombre de clase llega al DOM. */
const CLASS_CONSUMER_EXTENSIONS = [".ts", ".tsx"];
const CLASS_CONSUMER_SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests"]);

/** Contenido de todos los .ts/.tsx de producción, indexado por ruta relativa. */
function readClassConsumers(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!CLASS_CONSUMER_SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      if (CLASS_CONSUMER_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        const path = join(dir, entry.name);
        files.set(path.slice(APP_ROOT.length + 1), readFileSync(path, "utf8"));
      }
    }
  };
  walk(APP_ROOT);
  return files;
}

/**
 * Sigue `var(--x)` y `theme(--x)` (la función de Tailwind v4) hasta el valor
 * terminal. Ignora las entradas auto-referentes de `@theme inline`, que Tailwind
 * resuelve inline y por eso no son la declaración real del token.
 */
function resolveConcrete(name: string, layers: Array<Map<string, string>>): string | null {
  let current = name;
  for (let hop = 0; hop < 8; hop += 1) {
    const raw = layers
      .map((layer) => layer.get(current))
      .find((value) => value !== undefined && value.trim() !== `var(${current})`);
    if (raw === undefined) {
      return null;
    }
    const next = /^(?:var|theme)\(\s*(--[a-zA-Z0-9-]+)\s*\)$/.exec(raw.trim());
    if (!next) {
      return raw.trim();
    }
    current = next[1];
  }
  return null;
}

/**
 * `resolveConcrete` pero exigiendo que el token exista y resuelva: sin esto, un
 * token borrado llegaría como `null` y el test fallaría recién al parsear, con
 * un mensaje que no dice cuál. Igual que `requireVar`, no se saltea: rompe.
 */
function requireResolved(name: string, layers: Array<Map<string, string>>): string {
  const value = resolveConcrete(name, layers);
  expect(value, `${name} debe resolverse a un valor concreto`).not.toBeNull();
  return value as string;
}

/** Los cuatro tintes claros de estado con su peldaño -100 de referencia. */
function lightStatusTints() {
  return STATUS_PAIRS.map(({ label, ramp, bg }) => ({
    label,
    bg,
    hundredName: `${ramp}-100`,
    fifty: oklchToken(lightVars, bg, ":root"),
    hundred: oklchToken(lightVars, `${ramp}-100`, ":root"),
  }));
}

/* --------------------------------------------------------------------------
   Escala de sombras (D6).

   El defecto: el MISMO nombre —`.shadow-sm|md|lg|xl`— estaba declarado dos
   veces, una sin capa en design-tokens.css y otra que Tailwind emite dentro de
   `@layer utilities` desde su tema por defecto. Ganaba la del proyecto, pero por
   ACCIDENTE de cascada (una regla sin capa gana a cualquier capa), no por
   decisión; y la utilidad de Tailwind seguía emitiéndose con la receta del
   registry. Importa ahora que entran componentes del registry: pedir
   `shadow-sm` tiene que dar la identidad del proyecto porque SÍ, no porque la
   regla del proyecto esté escrita en un lugar más fuerte de la cascada.

   La decisión (del dueño) es que ganen los valores del proyecto. Estas guardas
   verifican las tres mitades de esa decisión, y ninguna alcanza sola:
   1. la declaración oficial: `@theme inline` mapea --shadow* a los tokens vivos;
   2. el retiro del duplicado: ninguna regla `.shadow-*` sin capa en
      design-tokens.css, con control negativo del propio lector de clases;
   3. que la colisión fuera real: la receta del registry existe, es OTRA, y la
      declaración oficial resuelve al token del proyecto y no a ella.
   -------------------------------------------------------------------------- */

/** Peldaños de la escala de sombras que el proyecto declara y usa. */
const SHADOW_SCALE = ["sm", "md", "lg", "xl"] as const;

/**
 * El OTRO lado de la colisión: la escala por defecto de sombras de Tailwind.
 * Se lee del paquete instalado (`index.css` es el CSS que resuelve
 * `@import "tailwindcss"`) en vez de transcribirla, para que un cambio de
 * versión de Tailwind vuelva a medir la colisión en lugar de dejar la guarda
 * afirmando algo que ya no es cierto.
 */
const TAILWIND_THEME_PATH = join(APP_ROOT, "node_modules", "tailwindcss", "index.css");
const TAILWIND_THEME_CSS = readFileSync(TAILWIND_THEME_PATH, "utf8");

/**
 * Valor de `--shadow*` en el tema por defecto de Tailwind, o null si ese
 * nombre ya no está declarado allí (la guarda rompe en vez de saltear).
 * Se extrae con una lectura directa y no con `readThemeVars` porque ese helper
 * corta en el primer bloque sin llaves anidadas y el tema de Tailwind contiene
 * `@keyframes` adentro.
 */
function registryShadow(name: string): string | null {
  const match = new RegExp(`(?:^|[;{])\\s*${name}\\s*:\\s*([^;{}]+);`).exec(TAILWIND_THEME_CSS);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

describe("design tokens: guardas de contrato", () => {
  it("ningún token de color pide más chroma de la que el sRGB puede mostrar", () => {
    const outOfGamut = collectOklchTokens(TOKENS_CSS)
      .filter(({ token }) => token.c > maxChroma(token.l, token.h) + GAMUT_TOLERANCE)
      .map(
        ({ selector, name, token }) =>
          `${selector} ${name}: oklch(${token.l} ${token.c} ${token.h}) con Cmax=${maxChroma(
            token.l,
            token.h,
          ).toFixed(4)}`,
      );
    expect(outOfGamut).toEqual([]);
  });

  it("blanco sobre los rellenos sólidos mantiene AA (>= 4.5:1)", () => {
    const fills: Array<{ label: string; token: Oklch }> = [
      { label: ":root primary-600", token: oklchToken(lightVars, "--color-primary-600", ":root") },
      { label: ":root primary-700", token: oklchToken(lightVars, "--color-primary-700", ":root") },
      {
        label: ".dark primary-600",
        token: oklchToken(darkTheme, "--color-primary-600", ".dark"),
      },
      {
        label: ".dark primary-700",
        token: oklchToken(darkTheme, "--color-primary-700", ".dark"),
      },
      { label: ":root error-600", token: oklchToken(lightVars, "--color-error-600", ":root") },
      { label: ".dark error-600", token: oklchToken(darkTheme, "--color-error-600", ".dark") },
    ];
    const failures = fills
      .map(({ label, token }) => ({
        label,
        ratio: contrastFromLuminance(whiteLuminance, luminance(token)),
      }))
      .filter(({ ratio }) => ratio < AA_TEXT_MIN)
      .map(({ label, ratio }) => `${label}: ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("los roles de TEXTO de estado mantienen AA contra la superficie de su tema", () => {
    const roles: Array<{ label: string; token: Oklch; surface: Oklch }> = [
      {
        label: ":root success-600 (texto)",
        token: oklchToken(lightVars, "--color-success-600", ":root"),
        surface: LIGHT_SURFACE,
      },
      {
        label: ":root warning-600 (texto)",
        token: oklchToken(lightVars, "--color-warning-600", ":root"),
        surface: LIGHT_SURFACE,
      },
      {
        label: ":root error-600 (texto)",
        token: oklchToken(lightVars, "--color-error-600", ":root"),
        surface: LIGHT_SURFACE,
      },
      {
        label: ":root primary-600 (texto)",
        token: oklchToken(lightVars, "--color-primary-600", ":root"),
        surface: LIGHT_SURFACE,
      },
      {
        label: ".dark success-400 (texto)",
        token: oklchToken(darkTheme, "--color-success-400", ".dark"),
        surface: DARK_SURFACE,
      },
      {
        label: ".dark warning-400 (texto)",
        token: oklchToken(darkTheme, "--color-warning-400", ".dark"),
        surface: DARK_SURFACE,
      },
      {
        label: ".dark error-400 (texto)",
        token: oklchToken(darkTheme, "--color-error-400", ".dark"),
        surface: DARK_SURFACE,
      },
    ];
    const failures = roles
      .map(({ label, token, surface }) => ({ label, ratio: contrast(token, surface) }))
      .filter(({ ratio }) => ratio < AA_TEXT_MIN)
      .map(({ label, ratio }) => `${label}: ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it("text-tertiary mantiene AA contra la superficie de su tema", () => {
    const light = contrast(oklchToken(lightVars, "--text-tertiary", ":root"), LIGHT_SURFACE);
    const dark = contrast(oklchToken(darkTheme, "--text-tertiary", ".dark"), DARK_SURFACE);
    expect(light).toBeGreaterThanOrEqual(AA_TEXT_MIN);
    expect(dark).toBeGreaterThanOrEqual(AA_TEXT_MIN);
  });

  it("el anillo de foco existe en ambos temas, se expone como --color-ring y contrasta >= 3:1", () => {
    const lightRing = resolveVarToken(
      requireVar(lightVars, "--ring", "design-tokens.css :root"),
      [lightVars],
    );
    const darkRing = resolveVarToken(requireVar(darkVars, "--ring", "design-tokens.css .dark"), [
      darkTheme,
    ]);
    expect(contrast(lightRing, LIGHT_SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT_MIN);
    expect(contrast(darkRing, DARK_SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT_MIN);
    expect(themeInline.get("--color-ring"), "globals.css @theme inline").toBe("var(--ring)");
    expect(BUTTON_TSX).toContain("focus-visible:ring-ring");
  });

  it("los cuatro -50 claros de estado llevan tinte (chroma > 0)", () => {
    const failures = STATUS_PAIRS.map(({ label, bg }) => ({
      label,
      bg,
      token: oklchToken(lightVars, bg, ":root"),
    }))
      .filter(({ token }) => token.c <= 0)
      .map(
        ({ label, bg, token }) =>
          `${label}: ${bg} = oklch(${token.l} ${token.c} ${token.h}) es acromático`,
      );
    expect(failures).toEqual([]);
  });

  it("cada -50 comparte el hue de su rampa y difiere de la superficie neutra y de los otros tres", () => {
    const tints = lightStatusTints();
    const wrongHue = tints
      .filter(({ fifty, hundred }) => fifty.h !== hundred.h)
      .map(({ label, fifty, hundred }) => `${label}: -50 H=${fifty.h} != -100 H=${hundred.h}`);
    expect(wrongHue).toEqual([]);
    const neutral = oklchToken(lightVars, "--color-neutral-50", ":root");
    expect(neutral.c, "--color-neutral-50 sigue siendo la superficie neutra").toBe(0);
    const signatures = tints.map(
      ({ fifty }) => `L${fifty.l} C${fifty.c} H${fifty.h}`,
    );
    expect(new Set(signatures).size, `tintes repetidos: ${signatures.join(", ")}`).toBe(
      tints.length,
    );
  });

  it("cada par real bg-*-light + color de texto cumple AA (>= 4.5:1) en ambos temas", () => {
    const failures: string[] = [];
    for (const pair of STATUS_PAIRS) {
      const lightRatio = contrast(
        oklchToken(lightVars, pair.fg, ":root"),
        oklchToken(lightVars, pair.bg, ":root"),
      );
      if (lightRatio < AA_TEXT_MIN) {
        failures.push(
          `claro ${pair.label}: ${pair.fg} sobre ${pair.bg} = ${lightRatio.toFixed(2)}:1`,
        );
      }
      const darkTextRaw = readDeclaration(TOKENS_CSS, pair.darkTextSelector, "color");
      expect(darkTextRaw, `${pair.darkTextSelector} debe declarar color`).toBeDefined();
      const darkRatio = contrast(
        resolveVarToken(darkTextRaw as string, [darkTheme]),
        oklchLiteral(
          readDeclaration(TOKENS_CSS, pair.darkBgSelector, "background-color"),
          `${pair.darkBgSelector} background-color`,
        ),
      );
      if (darkRatio < AA_TEXT_MIN) {
        failures.push(
          `oscuro ${pair.label}: ${pair.darkTextSelector} sobre ${pair.darkBgSelector} = ${darkRatio.toFixed(2)}:1`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("cada -50 es más claro que el -100 de su rampa (la rampa sigue ordenada)", () => {
    const failures = lightStatusTints()
      .filter(({ fifty, hundred }) => !(fifty.l > hundred.l))
      .map(
        ({ label, bg, hundredName, fifty, hundred }) =>
          `${label}: ${bg} L=${fifty.l} no es más claro que ${hundredName} L=${hundred.l}`,
      );
    expect(failures).toEqual([]);
  });

  it("los alias canónicos de shadcn/ui están declarados y resuelven a tokens del proyecto", () => {
    const unresolved = SHADCN_ALIASES.filter(
      (name) => resolveAlias(name, ALIAS_LAYERS) === null,
    );
    expect(unresolved).toEqual([]);
  });

  it("los alias añadidos son referencias a tokens y no colores literales", () => {
    const literals = ADDED_ALIASES.map((name) => ({
      name,
      value: requireVar(globalsRoot, name, "globals.css :root"),
    }))
      .filter(({ value }) => !/^var\(\s*--[a-zA-Z0-9-]+\s*\)$/.test(value.trim()))
      .map(({ name, value }) => `${name}: ${value}`);
    expect(literals).toEqual([]);
  });

  it("los alias de marca no apuntan a los tokens HSL muertos y estos ya no existen", () => {
    expect(requireVar(globalsRoot, "--primary", "globals.css :root")).toBe(
      "var(--color-primary-600)",
    );
    expect(requireVar(globalsRoot, "--secondary", "globals.css :root")).not.toBe(
      "var(--color-secondary)",
    );
    // `--color-primary: 175 82%` y `--color-secondary: 260 70%` se eliminaron por
    // muertos: cero consumidores, ni siquiera como valor arbitrario de Tailwind.
    expect(lightVars.has("--color-primary"), "design-tokens.css :root").toBe(false);
    expect(lightVars.has("--color-secondary"), "design-tokens.css :root").toBe(false);
    expect(darkVars.has("--color-primary"), "design-tokens.css .dark").toBe(false);
    expect(darkVars.has("--color-secondary"), "design-tokens.css .dark").toBe(false);
  });

  it("la familia --radius-* conserva sus valores y la base --radius solo la referencia", () => {
    for (const [name, value] of RADIUS_FAMILY) {
      expect(requireVar(lightVars, name, "design-tokens.css :root"), name).toBe(value);
    }
    expect(requireVar(globalsRoot, "--radius", "globals.css :root")).toBe("var(--radius-md)");
    // Tailwind deriva `rounded-*` de la familia --radius-*: si @theme la
    // re-declarara, cambiaría toda esquina de la app sin tocar una sola clase.
    const redefined = [...themeInline.keys()].filter((name) => name.startsWith("--radius"));
    expect(redefined).toEqual([]);
  });

  it("las cuatro clases muertas ya no se declaran y ningún .ts/.tsx de producción las usa", () => {
    const deletedClasses = ["text-primary", "text-secondary", "text-tertiary", "bg-primary"];
    const stillDeclared = bareClassNames(TOKENS_CSS).filter((name) =>
      deletedClasses.includes(name),
    );
    expect(stillDeclared, "design-tokens.css").toEqual([]);

    const consumers = readClassConsumers();
    // Sin este piso, un walk roto (p. ej. cwd distinto) haría pasar la guarda sola.
    expect(consumers.size, "archivos .ts/.tsx de producción leídos").toBeGreaterThan(50);
    const usages: string[] = [];
    for (const name of deletedClasses) {
      const re = new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`, "g");
      for (const [path, content] of consumers) {
        if (re.test(content)) {
          usages.push(`${path}: ${name}`);
        }
      }
    }
    expect(usages).toEqual([]);
  });

  it("ninguna clase suelta de design-tokens.css pisa una utilidad de color que Tailwind genera", () => {
    const generated = new Set(
      [...themeInline.keys()]
        .filter((name) => name.startsWith("--color-"))
        .flatMap((name) =>
          COLOR_UTILITY_PREFIXES.map(
            (prefix) => `${prefix}-${name.slice("--color-".length)}`,
          ),
        ),
    );
    const shadowed = bareClassNames(TOKENS_CSS).filter((name) => generated.has(name));
    expect(shadowed).toEqual([]);
  });

  it("la superficie seleccionada restaura el paso de luminancia de la página en ambos temas", () => {
    // La regresión real: el segmento elegido del theme-toggle quedó pintado con
    // --bg-surface-hover y su paso contra la página en claro cayó a 0.020, o sea
    // indistinguible. Este token semántico fija el paso en ~0.050 (el del
    // slate-200 original, 0.051) y no puede volver a encogerse sin romper acá.
    expect(themeInline.get("--color-surface-selected"), "globals.css @theme inline").toBe(
      "var(--bg-surface-selected)",
    );

    const lightRaw = requireResolved("--color-surface-selected", [themeInline, lightVars, darkTheme]);
    const darkRaw = requireResolved("--color-surface-selected", [themeInline, darkTheme, lightVars]);
    const lightSelected = oklchLiteral(lightRaw, "--color-surface-selected (claro)");
    const darkSelected = oklchLiteral(darkRaw, "--color-surface-selected (oscuro)");
    const lightPage = oklchLiteral(
      requireResolved("--bg-surface", [lightVars]),
      "--bg-surface (claro)",
    );
    const darkPage = oklchLiteral(
      requireResolved("--bg-surface", [darkTheme]),
      "--bg-surface (oscuro)",
    );

    // Primero el PASO, que es la propiedad que la regresión rompió; si se mira
    // solo el valor exacto el test se vuelve un candado y no una medición.
    const lightStep = Math.abs(lightSelected.l - lightPage.l);
    const darkStep = Math.abs(darkSelected.l - darkPage.l);
    expect(lightStep, `claro: página ${lightPage.l} -> seleccionado ${lightSelected.l}`)
      .toBeGreaterThanOrEqual(MIN_SURFACE_STEP);
    expect(darkStep, `oscuro: página ${darkPage.l} -> seleccionado ${darkSelected.l}`)
      .toBeGreaterThanOrEqual(MIN_SURFACE_STEP);

    // Y después el valor resuelto PINNEADO en ambos temas: si alguien lo mueve,
    // la tabla de mediciones deja de valer y hay que volver a medir.
    expect(lightRaw, "claro: --color-surface-selected").toBe("oklch(0.93 0 0)");
    expect(darkRaw, "oscuro: --color-surface-selected").toBe("oklch(0.22 0 0)");

    // En claro el token DEBE separarse del hover: es exactamente el bug que este
    // token existe para impedir. En oscuro ambos coinciden a propósito (ahí el
    // paso de 0.050 ya era correcto) y por eso no se compara.
    const lightHover = oklchLiteral(
      requireResolved("--bg-surface-hover", [lightVars]),
      "--bg-surface-hover (claro)",
    );
    expect(lightSelected.l, "claro: seleccionado vs hover").toBeLessThan(lightHover.l);

    // El label del segmento elegido usa `text-text-primary`
    // (src/shared/components/theme-toggle.tsx); debe mantener AA sobre su fondo.
    const lightRatio = contrast(
      lightSelected,
      oklchLiteral(requireResolved("--text-primary", [lightVars]), "--text-primary (claro)"),
    );
    const darkRatio = contrast(
      darkSelected,
      oklchLiteral(requireResolved("--text-primary", [darkTheme]), "--text-primary (oscuro)"),
    );
    expect(lightRatio, `claro: text-primary sobre seleccionado = ${lightRatio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(AA_TEXT_MIN);
    expect(darkRatio, `oscuro: text-primary sobre seleccionado = ${darkRatio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(AA_TEXT_MIN);
  });

  it("el escaneo de candidatos sigue excluyendo la documentación (.md)", () => {
    // D9a: sin `@source`, Tailwind v4 escanea `**/*` desde la raíz del build
    // (`base ?? process.cwd()` en @tailwindcss/postcss), y ahí entraban el
    // README de la app y el de cada feature: una clase nombrada en una nota se
    // emitía y la evidencia "esta utilidad se emite" dejaba de valer. Esta
    // guarda es un TRIPWIRE de texto, no una medición: comprueba que la
    // directiva sigue declarada y que sigue apuntando a los `.md` de todo el
    // checkout. El mecanismo real (que el escáner ya no recorra ningún `.md` y
    // que el CSS emitido no cambie) se verificó con el escáner de PostCSS y con
    // dos builds comparados byte a byte, no acá.
    expect(GLOBALS_CSS, "globals.css").toContain('@source not "../../**/*.md"');
  });

  it("el token de superficie duplicado --bg-surface-2 no existe y --muted conserva su valor", () => {
    // --bg-surface-2 era el mismo color que --bg-surface-hover en los dos temas
    // (en claro los dos se resolvían contra el mismo peldaño con `theme(...)`;
    // en oscuro, el mismo literal oklch(0.22 0 0)) y tenía un solo consumidor:
    // la clave `--muted` de globals.css. Se retiró el nombre duplicado y
    // `--muted` usa el superviviente. La guarda exige las dos mitades: que el
    // duplicado no vuelva, y que el valor RESUELTO de `--muted` no haya
    // cambiado al cambiar de nombre (si el superviviente dejara de resolver,
    // esto falla).
    expect(lightVars.has("--bg-surface-2"), "design-tokens.css :root").toBe(false);
    expect(darkVars.has("--bg-surface-2"), "design-tokens.css .dark").toBe(false);
    expect(requireVar(globalsRoot, "--muted", "globals.css :root")).toBe("var(--bg-surface-hover)");

    const darkLayers = [globalsRoot, darkTheme, themeInline];
    const lightMuted = resolveConcrete("--muted", ALIAS_LAYERS);
    const darkMuted = resolveConcrete("--muted", darkLayers);
    expect(lightMuted, "--muted (claro) debe resolver").not.toBeNull();
    expect(darkMuted, "--muted (oscuro) debe resolver").not.toBeNull();
    expect(lightMuted).toBe(resolveConcrete("--bg-surface-hover", ALIAS_LAYERS));
    expect(darkMuted).toBe(resolveConcrete("--bg-surface-hover", darkLayers));
    expect(parseOklch(lightMuted as string), `claro: ${lightMuted}`).not.toBeNull();
    expect(parseOklch(darkMuted as string), `oscuro: ${darkMuted}`).not.toBeNull();
  });

  it("las dos claves base del registry (background/foreground) existen y resuelven en ambos temas", () => {
    const globalsDark = readThemeVars(GLOBALS_CSS, ".dark");
    const failures: string[] = [];
    for (const [key, alias] of BASE_COLOR_KEYS) {
      const raw = themeInline.get(key);
      if (raw !== `var(${alias})`) {
        failures.push(`${key}: se esperaba var(${alias}), hay ${raw}`);
        continue;
      }
      // Claro: el literal de `:root`; oscuro: el de `.dark`, que es el que gana
      // en la cascada real (globals.css declara `color-scheme` en los dos).
      const light = resolveConcrete(key, [globalsRoot, lightVars, darkTheme, themeInline]);
      const dark = resolveConcrete(key, [
        globalsDark,
        globalsRoot,
        lightVars,
        darkTheme,
        themeInline,
      ]);
      const lightExpected = requireVar(globalsRoot, alias, "globals.css :root");
      const darkExpected = requireVar(globalsDark, alias, "globals.css .dark");
      if (light !== lightExpected) {
        failures.push(`${key}: en claro ${raw} -> ${light ?? "sin resolver"}, se esperaba ${lightExpected}`);
      }
      if (dark !== darkExpected) {
        failures.push(`${key}: en oscuro ${raw} -> ${dark ?? "sin resolver"}, se esperaba ${darkExpected}`);
      }
      if (light !== null && !isConcreteColor(light)) {
        failures.push(`${key}: ${light} no es un color concreto`);
      }
    }
    expect(failures).toEqual([]);
    // El par base no puede repetirse en el loop de las 16 (allí se exige oklch).
    const duplicated = BASE_COLOR_KEYS.map(([key]) => key).filter((key) =>
      CANONICAL_COLOR_KEYS.includes(key),
    );
    expect(duplicated).toEqual([]);
  });

  it("toda clave --color-* de @theme inline está clasificada (ninguna queda sin cubrir)", () => {
    const covered = new Set([
      ...CANONICAL_COLOR_KEYS,
      ...BASE_COLOR_KEYS.map(([key]) => key),
      ...NON_REGISTRY_COLOR_KEYS,
    ]);
    const uncovered = [...themeInline.keys()]
      .filter((name) => name.startsWith("--color-"))
      .filter((name) => !covered.has(name))
      .sort();
    expect(uncovered).toEqual([]);
  });

  it("las 16 claves canónicas están en @theme inline y resuelven a un valor concreto", () => {
    const failures: string[] = [];
    for (const key of CANONICAL_COLOR_KEYS) {
      const raw = themeInline.get(key);
      if (raw === undefined) {
        failures.push(`${key}: no está en globals.css @theme inline`);
        continue;
      }
      if (!/^var\(\s*--[a-zA-Z0-9-]+\s*\)$/.test(raw)) {
        failures.push(`${key}: ${raw} no es una referencia var(--token)`);
        continue;
      }
      const resolved = resolveConcrete(key, ALIAS_LAYERS);
      if (resolved === null || parseOklch(resolved) === null) {
        failures.push(`${key}: ${raw} -> ${resolved ?? "sin resolver"}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("--color-primary sale de la rampa de marca (nunca del token HSL muerto)", () => {
    expect(themeInline.get("--color-primary")).toBe("var(--color-primary-600)");
    const resolved = resolveConcrete("--color-primary", ALIAS_LAYERS);
    expect(resolved).not.toBeNull();
    expect(parseOklch(resolved as string), `resuelto a: ${resolved}`).not.toBeNull();
    expect(resolved).toBe(requireVar(lightVars, "--color-primary-600", ":root"));
    // El token muerto era HSL crudo (`175 82%`), que Tailwind no puede usar.
    expect(resolved as string).not.toMatch(/^\d+(\.\d+)?\s+\d+(\.\d+)?%$/);
    expect(globalsRoot.has("--color-primary"), "globals.css :root").toBe(false);
  });

  it("las claves canónicas que apuntan a un alias de :root lo hacen de verdad", () => {
    const expected: Array<[string, string]> = [
      ["--color-card", "var(--card)"],
      ["--color-card-foreground", "var(--card-foreground)"],
      ["--color-popover", "var(--popover)"],
      ["--color-popover-foreground", "var(--popover-foreground)"],
      ["--color-primary-foreground", "var(--primary-foreground)"],
      ["--color-secondary", "var(--secondary)"],
      ["--color-secondary-foreground", "var(--secondary-foreground)"],
      ["--color-muted", "var(--muted)"],
      ["--color-accent", "var(--accent)"],
      ["--color-accent-foreground", "var(--accent-foreground)"],
      ["--color-destructive", "var(--color-error-600)"],
      ["--color-destructive-foreground", "var(--destructive-foreground)"],
      ["--color-border", "var(--color-border-color)"],
      ["--color-input", "var(--color-border-color)"],
      ["--color-muted-foreground", "var(--color-text-secondary)"],
    ];
    const wrong = expected
      .map(([key, value]) => [key, value, themeInline.get(key)] as const)
      .filter(([, value, raw]) => raw !== value)
      .map(([key, value, raw]) => `${key}: se esperaba ${value}, hay ${raw}`);
    expect(wrong).toEqual([]);
  });

  it("el secundario canónico es una superficie y no el token HSL muerto", () => {
    const resolved = resolveConcrete("--color-secondary", ALIAS_LAYERS);
    expect(resolved).not.toBeNull();
    expect(parseOklch(resolved as string), `resuelto a: ${resolved}`).not.toBeNull();
    // Debe aterrizar en la misma superficie que `--secondary` (--bg-surface-hover),
    // no en el HSL muerto ni en la superficie base.
    expect(resolved).toBe(resolveConcrete("--bg-surface-hover", ALIAS_LAYERS));
    expect(resolved).not.toBe(resolveConcrete("--bg-surface", ALIAS_LAYERS));
    expect(themeInline.get("--color-secondary")).toBe("var(--secondary)");
    expect(themeInline.get("--color-muted-foreground")).toBe("var(--color-text-secondary)");
    expect(themeInline.get("--color-destructive")).toBe("var(--color-error-600)");
  });

  it("la escala de sombras del proyecto es oficial por DECLARACIÓN, no por cascada", () => {
    const failures: string[] = [];
    for (const step of SHADOW_SCALE) {
      const key = `--shadow-${step}`;
      // La mitad que hace la diferencia: la utilidad la emite Tailwind desde su
      // tema, así que lo que Tailwind mira es ESTA clave. Antes no existía y por
      // eso el valor del proyecto llegaba por cascada (o no llegaba nunca).
      if (themeInline.get(key) !== `var(${key})`) {
        const raw = themeInline.get(key) ?? "(ausente)";
        failures.push(
          `${key}: se esperaba var(${key}) en globals.css @theme inline, hay ${raw}`,
        );
        continue;
      }
      // El token tiene que existir en los DOS temas y cambiar entre ellos: si no
      // cambiara, la clave no necesitaría ser `inline`.
      const light = requireVar(lightVars, key, "design-tokens.css :root");
      const dark = requireVar(darkVars, key, "design-tokens.css .dark");
      if (light === dark) {
        failures.push(`${key}: mismo valor en claro y oscuro (${light})`);
      }
    }
    // `shadow` (suelta) no tiene receta propia en el proyecto: se aliasa al sm
    // del proyecto, igual que el registry la aliasa a su propio sm. Sin esto, un
    // componente del registry que pida `shadow` vuelve a salir con el registry.
    if (themeInline.get("--shadow") !== "var(--shadow-sm)") {
      failures.push(
        `--shadow: se esperaba var(--shadow-sm), hay ${themeInline.get("--shadow") ?? "(ausente)"}`,
      );
    }
    expect(failures).toEqual([]);

    // Cobertura: ninguna sombra declarada por el proyecto puede quedar sin
    // puente. Es lo que impide que un --shadow-* nuevo o revivido vuelva a
    // ganar por cascada en vez de por declaración.
    const unmapped = [...lightVars.keys()]
      .filter((name) => name.startsWith("--shadow"))
      .filter((name) => !themeInline.has(name));
    expect(unmapped, "tokens --shadow* de design-tokens.css sin clave en @theme inline").toEqual(
      [],
    );
  });

  it("el duplicado sin capa se retiró: ninguna clase `.shadow-*` compite con la utilidad", () => {
    const declared = bareClassNames(TOKENS_CSS);
    // Control negativo del lector: sobre una muestra sintética que reproduce el
    // patrón retirado, la detección TIENE que dispararse. Sin esto, un lector
    // roto (o un `bareClassNames` que devolviera []) dejaría pasar la aserción
    // de abajo sin haber medido nada.
    expect(bareClassNames(".shadow-sm { box-shadow: var(--shadow-sm); }")).toEqual(["shadow-sm"]);
    // Piso anti-vacío sobre el archivo REAL, la otra mitad del control: el
    // lector sigue viendo las clases sueltas que el archivo sí declara.
    for (const stillThere of ["border-color", "radius-lg", "bg-success-light"]) {
      expect(declared, `${stillThere} debería seguir declarada en design-tokens.css`).toContain(
        stillThere,
      );
    }
    expect(declared.filter((name) => name.startsWith("shadow"))).toEqual([]);

    // El token muerto que duplicaba el nombre de la utilidad: ni en claro ni en
    // oscuro de design-tokens.css, y tampoco mapeado en @theme inline. `shadow-2xl`
    // (la clase) sigue existiendo: lo que se retiró fue el token que nadie leía.
    expect(lightVars.has("--shadow-2xl"), "design-tokens.css :root").toBe(false);
    expect(darkVars.has("--shadow-2xl"), "design-tokens.css .dark").toBe(false);
    expect(themeInline.has("--shadow-2xl"), "globals.css @theme inline").toBe(false);
  });

  it("la declaración oficial resuelve al token del proyecto y NO a la receta del registry", () => {
    // Piso anti-vacío: si el tema de Tailwind no se dejara leer, la medición no
    // valdría nada y el test tiene que romper, no saltear.
    expect(TAILWIND_THEME_CSS.length, "node_modules/tailwindcss/index.css").toBeGreaterThan(
      10_000,
    );

    const failures: string[] = [];
    for (const step of SHADOW_SCALE) {
      const key = `--shadow-${step}`;
      const registry = registryShadow(key);
      if (registry === null) {
        failures.push(`${key}: el tema de Tailwind ya no lo declara; hay que releer esta guarda`);
        continue;
      }
      const light = requireVar(lightVars, key, "design-tokens.css :root");
      const dark = requireVar(darkVars, key, "design-tokens.css .dark");
      // Si la receta del registry fuera igual a la del proyecto en los dos
      // temas, no habría colisión que medir y este test pasaría por trivial.
      if (registry === light && registry === dark) {
        failures.push(
          `${key}: el registry coincide con el proyecto (${registry}); no hay colisión`,
        );
      }
      // La utilidad resuelve por el tema de Tailwind: la clave tiene que llevar
      // al token del proyecto en claro y en oscuro, y nunca a la receta del otro.
      const resolvedLight = resolveConcrete(key, [lightVars, darkTheme, themeInline]);
      const resolvedDark = resolveConcrete(key, [darkTheme, lightVars, themeInline]);
      if (resolvedLight !== light) {
        failures.push(`${key}: en claro resuelve a ${resolvedLight ?? "(nada)"} de ${light}`);
      }
      if (resolvedDark !== dark) {
        failures.push(`${key}: en oscuro resuelve a ${resolvedDark ?? "(nada)"} de ${dark}`);
      }
      if (resolvedLight === registry || resolvedDark === registry) {
        failures.push(`${key}: la utilidad resuelve a la receta del registry (${registry})`);
      }
    }

    // Por qué `--shadow` puede aliasarse a `--shadow-sm` sin inventar un
    // peldaño: en el registry el alias suelto vale exactamente lo mismo que su
    // sm. Medido, no supuesto; si dejaran de coincidir, el puente habría que
    // releerlo.
    const registryAlias = registryShadow("--shadow");
    const registrySm = registryShadow("--shadow-sm");
    expect(registryAlias, "--shadow en el tema de Tailwind").not.toBeNull();
    expect(registrySm, "--shadow-sm en el tema de Tailwind").not.toBeNull();
    expect(registryAlias, "--shadow vs --shadow-sm en el tema de Tailwind").toBe(registrySm);

    expect(failures).toEqual([]);
  });
});
