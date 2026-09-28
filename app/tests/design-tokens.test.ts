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
});
