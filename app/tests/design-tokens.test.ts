import { readFileSync } from "node:fs";
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
   supuestos): las cuatro variantes de src/components/ui/lib/badge.tsx y las
   llamadas a `.bg-*-light` en app/page.tsx:87,106, app/cash/cash-client.tsx:747,
   app/login/login-form.tsx:99, app/payroll/payroll-client.tsx:1142 y
   app/vales/vouchers-client.tsx:346,351.

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

  it("los alias de marca no apuntan a los tokens HSL muertos y estos quedan intactos", () => {
    expect(requireVar(globalsRoot, "--primary", "globals.css :root")).toBe(
      "var(--color-primary-600)",
    );
    expect(requireVar(globalsRoot, "--secondary", "globals.css :root")).not.toBe(
      "var(--color-secondary)",
    );
    expect(requireVar(lightVars, "--color-primary", "design-tokens.css :root")).toBe("175 82%");
    expect(requireVar(lightVars, "--color-secondary", "design-tokens.css :root")).toBe(
      "260 70%",
    );
  });

  it("la familia --radius-* conserva sus valores y la base --radius solo la referencia", () => {
    for (const [name, value] of RADIUS_FAMILY) {
      expect(requireVar(lightVars, name, "design-tokens.css :root"), name).toBe(value);
    }
    expect(requireVar(globalsRoot, "--radius", "globals.css :root")).toBe("var(--radius-md)");
  });
});
