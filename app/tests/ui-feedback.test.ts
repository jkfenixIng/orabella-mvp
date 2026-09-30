import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_ROLE_BY_VARIANT,
  DEFAULT_ALERT_VARIANT,
  alertRole,
  alertVariants,
  type AlertVariant,
} from "@/src/components/ui/lib/alert";

/* --------------------------------------------------------------------------
   Contrato de las dos primitivas de feedback (WU-A).

   Son los dos canales de un mismo problema: el Alert es el mensaje inline que
   PERSISTE, el toast de sonner es el efímero que reemplaza a los textos de
   éxito que hoy quedan pegados en pantalla para siempre.

   Este test es offline y sin DOM (`vitest.config.ts` corre `environment: "node"`):
   lee los archivos reales —igual que design-tokens.test.ts y hardening.test.ts—
   e importa el módulo de Alert para afirmar su política de rol, que es una
   función pura. No hay un solo valor de color hardcodeado: los tokens se leen
   de los CSS reales.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const TOKENS_PATH = join(APP_ROOT, "src", "styles", "design-tokens.css");
const GLOBALS_PATH = join(APP_ROOT, "app", "globals.css");
const ALERT_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "alert.tsx");
const SONNER_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "sonner.tsx");
const LAYOUT_PATH = join(APP_ROOT, "app", "layout.tsx");
const PKG_PATH = join(APP_ROOT, "package.json");
const LOCK_PATH = join(APP_ROOT, "package-lock.json");

const TOKENS_CSS = readFileSync(TOKENS_PATH, "utf8");
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");
const ALERT_TSX = readFileSync(ALERT_PATH, "utf8");
const SONNER_TSX = readFileSync(SONNER_PATH, "utf8");
const LAYOUT_TSX = readFileSync(LAYOUT_PATH, "utf8");

/** Código sin comentarios: evita que un `role="status"` mencionado en la
 *  documentación cuente como si fuera un rol aplicado en el JSX. */
const ALERT_CODE = ALERT_TSX.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** El selector real de un bloque es lo que sigue al último `;` o `}` previo:
 *  así un at-rule anterior con comas no contamina el head. */
function selectorOf(head: string): string[] {
  const part = head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1);
  return part.split(",").map((piece) => piece.trim());
}

/** Cuerpos de las reglas cuyo selector es exactamente `selector`. */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const block of stripComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (selectorOf(block[1]).includes(selector)) {
      bodies.push(block[2]);
    }
  }
  return bodies;
}

/** Declaraciones `--token: valor;` de un selector (bloques planos). */
function blockVars(css: string, selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const body of ruleBodies(css, selector)) {
    for (const decl of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      vars.set(decl[1], decl[2].trim());
    }
  }
  return vars;
}

/** Clases sueltas `.x` declaradas en el CSS (las compuestas `.dark .x` van aparte). */
function bareClasses(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    for (const piece of block[1].split(",")) {
      const single = /^\.([a-zA-Z0-9_-]+)$/.exec(piece.trim());
      if (single) {
        names.add(single[1]);
      }
    }
  }
  return names;
}

/** Clases que reciben un override de tema: selectores `.dark .x`. */
function darkOverrideClasses(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    for (const piece of block[1].split(",")) {
      const themed = /^\.dark \.([a-zA-Z0-9_-]+)$/.exec(piece.trim());
      if (themed) {
        names.add(themed[1]);
      }
    }
  }
  return names;
}

/** Claves de `@theme inline` en globals.css: son las que Tailwind convierte en
 *  utilidades (`--color-success` -> `text-success`, `bg-success`, ...). */
function themeInlineKeys(css: string): Set<string> {
  const block = /@theme\s+inline\s*\{([^}]*)\}/.exec(stripComments(css));
  expect(block, "@theme inline en globals.css").not.toBeNull();
  const keys = new Set<string>();
  for (const decl of (block as RegExpExecArray)[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    keys.add(decl[1]);
  }
  return keys;
}

/** Prefijos de utilidad de color que Tailwind deriva de cada clave --color-*. */
const COLOR_UTILITY_PREFIXES = ["bg", "text", "border"];

const rootVars = blockVars(TOKENS_CSS, ":root");
const darkVars = blockVars(TOKENS_CSS, ".dark");
// Cascada real del tema oscuro: gana `.dark` y, si un token no está, cae a `:root`.
const darkCascade = new Map([...rootVars, ...darkVars]);
const globalsRootVars = blockVars(GLOBALS_CSS, ":root");
const globalsDarkVars = blockVars(GLOBALS_CSS, ".dark");
const themeKeys = themeInlineKeys(GLOBALS_CSS);

const declaredClasses = bareClasses(TOKENS_CSS);
const darkClasses = darkOverrideClasses(TOKENS_CSS);

// Utilidades que Tailwind SÍ genera desde el puente @theme: no están escritas
// como `.clase` en design-tokens.css, pero existen igual.
const generatedUtilities = new Set(
  [...themeKeys]
    .filter((name) => name.startsWith("--color-"))
    .flatMap((name) =>
      COLOR_UTILITY_PREFIXES.map(
        (prefix) => `${prefix}-${name.slice("--color-".length)}`,
      ),
    ),
);

/**
 * De dónde sale una clase de color del vocabulario del proyecto, o `null` si no
 * existe. Las dos fuentes son reales: design-tokens.css declara los tintes
 * `.bg-*-light` a mano, y Tailwind genera `.text-success`/`.text-error` desde
 * las claves `--color-*` de `@theme inline` (el propio archivo de tokens lo
 * documenta: esas tres utilidades se borraron de ahí justamente porque
 * Tailwind ya las emite). Cualquier combinación que no resuelva en ninguna de
 * las dos es una clase muerta.
 */
function classSource(className: string): "declarada" | "tailwind" | null {
  if (declaredClasses.has(className)) {
    return "declarada";
  }
  if (generatedUtilities.has(className)) {
    return "tailwind";
  }
  return null;
}

const VARIANTS: AlertVariant[] = ["success", "warning", "destructive", "info"];

/** Pareja (fondo, texto) que cada variante DEBE usar, con su rampa de tokens. */
const VARIANT_STATUS_CLASSES: Record<
  AlertVariant,
  { bg: string; text: string; ramp: string }
> = {
  success: { bg: "bg-success-light", text: "text-success", ramp: "--color-success" },
  warning: { bg: "bg-warning-light", text: "text-warning", ramp: "--color-warning" },
  destructive: { bg: "bg-error-light", text: "text-error", ramp: "--color-error" },
  info: { bg: "bg-primary-light", text: "text-primary-color", ramp: "--color-primary" },
};

/** Extensiones donde un componente puede quedar montado en un render. */
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SOURCE_SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "tests"]);

/** Todos los .ts/.tsx de producción, con ruta relativa normalizada a `/`. */
function productionSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        const path = join(dir, entry.name);
        files.set(
          path.slice(APP_ROOT.length + 1).split("\\").join("/"),
          readFileSync(path, "utf8"),
        );
      }
    }
  };
  walk(APP_ROOT);
  return files;
}

describe("Alert: clases de estado del vocabulario del proyecto", () => {
  it("cada variante usa su pareja (fondo tenue + texto fuerte) y ninguna otra", () => {
    for (const variant of VARIANTS) {
      const classes = alertVariants({ variant }).split(/\s+/);
      const { bg, text } = VARIANT_STATUS_CLASSES[variant];
      expect(classes, `variante ${variant}`).toContain(bg);
      expect(classes, `variante ${variant}`).toContain(text);
    }
  });

  it("las ocho clases resuelven a algo declarado, y el resolver no es un sello de goma", () => {
    // Pisos: si el walk o el parseo se rompen, la guarda no debe pasar sola.
    // design-tokens.css declara 17 clases sueltas hoy (21 hasta D6, que retiro
    // las 4 reglas .shadow-* sin capa del duplicado de sombras); el piso queda
    // apenas debajo para no volverse una fecha de vencimiento si se borra una
    // muerta. Este numero NO dice nada de las clases de estado: las aserciones
    // semanticas de abajo son las que las exigen.
    expect(declaredClasses.size, "clases sueltas en design-tokens.css").toBeGreaterThanOrEqual(16);
    expect(generatedUtilities.size, "utilidades derivadas de @theme inline").toBeGreaterThan(20);

    for (const variant of VARIANTS) {
      const { bg, text } = VARIANT_STATUS_CLASSES[variant];
      expect(classSource(bg), bg).not.toBeNull();
      expect(classSource(text), text).not.toBeNull();
    }

    // Control negativo: una clase inexistente NO resuelve.
    expect(classSource("bg-not-a-real-tint")).toBeNull();
    expect(classSource("text-not-a-real-role")).toBeNull();

    // Y queda escrito de dónde sale cada una: los tintes están a mano en
    // design-tokens.css; los roles de texto los genera Tailwind.
    expect(classSource("bg-success-light")).toBe("declarada");
    expect(classSource("text-success")).toBe("tailwind");
    expect(classSource("text-primary-color")).toBe("declarada");
  });

  it("cada clase de estado tiene su override en .dark (sin él quedaría casi blanca en oscuro)", () => {
    for (const variant of VARIANTS) {
      const { bg, text } = VARIANT_STATUS_CLASSES[variant];
      expect(darkClasses.has(bg), `.dark .${bg}`).toBe(true);
      expect(darkClasses.has(text), `.dark .${text}`).toBe(true);
    }
  });

  it("los tokens detrás de esas clases existen, y el fondo oscuro es literal (no el -50)", () => {
    for (const variant of VARIANTS) {
      const { bg, text, ramp } = VARIANT_STATUS_CLASSES[variant];

      // Claro: `.bg-*-light` apunta al peldaño -50 del :root.
      expect(ruleBodies(TOKENS_CSS, `.${bg}`).join(" "), `.${bg}`).toContain(
        `var(${ramp}-50)`,
      );
      expect(rootVars.has(`${ramp}-50`), `${ramp}-50 en :root`).toBe(true);

      // Oscuro: el fondo se pisa con un literal oklch propio. Apuntarlo al
      // peldaño -50 (que NO se invierte) dejaría el aviso blanco sobre oscuro.
      expect(ruleBodies(TOKENS_CSS, `.dark .${bg}`).join(" "), `.dark .${bg}`).toMatch(
        /background-color:\s*oklch\(/,
      );

      // Oscuro: el rol de texto usa una variable que existe en la cascada.
      const darkText = ruleBodies(TOKENS_CSS, `.dark .${text}`).join(" ");
      const darkTextToken = /var\((--[a-zA-Z0-9-]+)\)/.exec(darkText)?.[1];
      expect(darkTextToken, `.dark .${text} debe usar var(--token)`).toBeDefined();
      expect(darkCascade.has(darkTextToken as string), darkTextToken as string).toBe(true);
    }
  });

  it("el default de cva y la constante exportada son el mismo", () => {
    expect(alertVariants({})).toBe(alertVariants({ variant: DEFAULT_ALERT_VARIANT }));
    expect(DEFAULT_ALERT_VARIANT).toBe("info");
  });
});

describe("Alert: política de rol ARIA", () => {
  it("success/info son educados (status) y warning/destructive son asertivos (alert)", () => {
    expect(ALERT_ROLE_BY_VARIANT).toEqual({
      success: "status",
      info: "status",
      warning: "alert",
      destructive: "alert",
    });
    for (const variant of VARIANTS) {
      const role = alertRole(variant);
      expect(role, `rol de ${variant}`).toBe(ALERT_ROLE_BY_VARIANT[variant]);
      expect(["status", "alert"], `rol de ${variant}`).toContain(role);
    }
  });

  it("el split asertivo/educado es real: hay dos roles, no uno para todo", () => {
    const roles = new Set(VARIANTS.map((variant) => alertRole(variant)));
    expect([...roles].sort()).toEqual(["alert", "status"]);
  });

  it("el rol explícito gana sobre el derivado de la variante", () => {
    expect(alertRole("destructive", "status")).toBe("status");
    expect(alertRole("info", "alert")).toBe("alert");
    expect(alertRole("warning", "status")).toBe("status");
  });

  it("sin variante cae al default y nunca devuelve undefined", () => {
    expect(alertRole(undefined)).toBe(ALERT_ROLE_BY_VARIANT[DEFAULT_ALERT_VARIANT]);
    expect(alertRole(null)).toBe(ALERT_ROLE_BY_VARIANT[DEFAULT_ALERT_VARIANT]);
    expect(alertRole(undefined)).toBe("status");
  });

  it("el componente aplica alertRole() en el JSX, no un role= fijo", () => {
    expect(ALERT_CODE).toMatch(/role=\{alertRole\(/);
    expect(ALERT_CODE).not.toMatch(/role="(status|alert)"/);
    // El icono no es adorno: sin él la única señal sería el color (WCAG 1.4.1).
    expect(ALERT_CODE).toMatch(/aria-hidden="true"/);
  });
});

describe("toast: dependencia y montaje único", () => {
  it("sonner está en dependencies y el lockfile concuerda con el rango", () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range = pkg.dependencies?.sonner;
    expect(range, "package.json dependencies.sonner").toBeTruthy();
    expect(pkg.devDependencies?.sonner, "sonner no puede ser devDependency").toBeUndefined();

    const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
      packages?: Record<string, { version?: string; dev?: boolean }>;
    };
    const entry = lock.packages?.["node_modules/sonner"];
    expect(entry, "package-lock.json node_modules/sonner").toBeDefined();
    expect(entry?.version, "versión pinneada").toMatch(/^\d+\.\d+\.\d+/);
    expect(entry?.dev, "sonner no puede ser dev").toBeFalsy();
    // package.json y lockfile tienen que hablar del mismo major.
    const major = (range as string).replace(/^[^0-9]*/, "").split(".")[0];
    expect(entry?.version?.split(".")[0], "major del lockfile vs package.json").toBe(major);
  });

  it("Toaster se monta exactamente una vez en toda la app", () => {
    const sources = productionSources();
    // Sin este piso, un walk roto (p. ej. cwd distinto) haría pasar la guarda sola.
    expect(sources.size, "archivos .ts/.tsx de producción leídos").toBeGreaterThan(50);

    const mounts = [...sources.entries()]
      .map(([path, content]) => ({
        path,
        count: (content.match(/<Toaster\b/g) ?? []).length,
      }))
      .filter(({ count }) => count > 0);

    // Un segundo mount duplica cada toast: es un bug real, no una preferencia.
    expect(mounts).toEqual([{ path: "app/layout.tsx", count: 1 }]);
  });

  it("el Toaster vive dentro de ThemeProvider (su useTheme() necesita el contexto)", () => {
    const providerOpen = LAYOUT_TSX.indexOf("<ThemeProvider");
    const mount = LAYOUT_TSX.indexOf("<Toaster");
    const providerClose = LAYOUT_TSX.indexOf("</ThemeProvider>");
    expect(providerOpen, "<ThemeProvider en layout.tsx").toBeGreaterThan(-1);
    expect(providerClose, "</ThemeProvider> en layout.tsx").toBeGreaterThan(-1);
    expect(mount, "<Toaster en layout.tsx").toBeGreaterThan(providerOpen);
    expect(providerClose).toBeGreaterThan(mount);
  });

  it("el tema del Toaster sale de next-themes y no de una constante", () => {
    expect(SONNER_TSX).toMatch(/^['"]use client['"]/m);
    expect(SONNER_TSX).toMatch(
      /import\s*\{[^}]*useTheme[^}]*\}\s*from\s*['"]next-themes['"]/,
    );
    expect(SONNER_TSX).toMatch(
      /const\s*\{\s*theme\s*=\s*['"]system['"]\s*\}\s*=\s*useTheme\(\)/,
    );
    expect(SONNER_TSX).toMatch(/theme=\{theme as ToasterProps\[['"]theme['"]\]\}/);
    expect(SONNER_TSX).not.toMatch(/^\s*theme=\{?['"](light|dark)['"]/m);
  });

  it("las variables de color del Toaster son tokens del proyecto, no literales", () => {
    const style = /style=\{\s*\{([\s\S]*?)\}\s*as CSSProperties\s*\}/.exec(SONNER_TSX)?.[1];
    expect(style, "style del registry").toBeTruthy();

    const expected: Record<string, string> = {
      "--normal-bg": "--bg-surface",
      "--normal-text": "--text-primary",
      "--normal-border": "--color-border-color",
      "--border-radius": "--radius",
    };
    const cascade = new Map([
      ...darkCascade,
      ...globalsRootVars,
      ...globalsDarkVars,
      ...[...themeKeys].map((key) => [key, "declarado en @theme inline"] as [string, string]),
    ]);

    for (const [prop, token] of Object.entries(expected)) {
      expect(style as string, `${prop}`).toContain(`'${prop}': 'var(${token})'`);
      expect(cascade.has(token), `${token} existe en la cascada`).toBe(true);
    }
    // Sin colores crudos: el toast tiene que seguir el tema, no fijar su paleta.
    expect(style as string).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\bhsla?\(|\boklch\(|\brgba?\(/);
  });

  it("cada tipo de toast trae su icono de lucide (no depende solo del color)", () => {
    expect(SONNER_TSX).toMatch(/from\s*['"]lucide-react['"]/);
    for (const type of ["success", "info", "warning", "error", "loading"]) {
      expect(SONNER_TSX, `icons.${type}`).toMatch(new RegExp(`\\b${type}:\\s*<`));
    }
  });
});
