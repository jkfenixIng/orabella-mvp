import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guarda de paleta cruda (WU1).

   Regla: ninguna utilidad de la paleta por defecto de Tailwind (`slate`..
   `rose`, más `bg-white`/`bg-black`) puede aparecer en los `.ts`/`.tsx` de
   producción. El vocabulario canónico es el de `src/styles/design-tokens.css`
   por los tokens que `app/globals.css` expone en `@theme inline`.

   Por qué una guarda y no una convención: la auditoría midió 300 tokens crudos
   en 9 archivos, con 246 en `app/invoices/invoices-client.tsx` (WU5). WU1 limpió
   los que se renderizan en TODAS las rutas (esqueletos, error, 404, theme toggle)
   y WU2 limpió `src/components/ui/lib/combobox.tsx`, que ya usa los mismos tokens
   que sus primitivas hermanas. WU4 bajó su archivo de 246 a 224: las siete
   pastillas de estado que todavía se escribían con la paleta cruda pasaron al
   primitivo `Badge` (variantes `warning`/`success`/`secondary`/`default` y el
   mapeo `invoiceStatusVariant`). WU5 hizo el resto: los 184 tokens de la hoja de
   factura (la hoja, los tres diálogos blancos y `paperInputClass`) se congelaron
   en la familia `--paper-*`, cuyos valores son EXACTAMENTE los que ya
   renderizaban, y quedan 40, que son el cromo de la app: ahí ningún token del
   proyecto tiene el mismo valor en los dos temas. Sin esta guarda el próximo
   archivo reintroduce la paleta cruda y la disparidad se reabre.

   Método: se cuentan TOKENS de clase completos, nunca substrings. Los lotes
   anteriores se quemaron dos veces con grep de substring:
     - `text-text-primary` TERMINA en `text-primary`;
     - `border-border` MATCHEA `border-border-color`.
   Por eso el detector corta la fuente en tokens (whitespace y delimitadores de
   string/JSX) y exige coincidencia completa desde el inicio del token.

   Alcance: solo `.ts`/`.tsx` de producción. Los `.css` quedan afuera
   (design-tokens.css declara tokens `--color-*`, no utilidades) y `tests/`
   también, porque este mismo archivo nombra clases crudas al explicarlas.

   La guarda es honesta, no aspiracional: los ofensores conocidos están en
   ALLOWLIST con el conteo exacto, así que agregar un token crudo a un archivo
   permitido también falla.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** Directorios que no son código de producción (mismo criterio que design-tokens.test.ts). */
/**
 * El walk arranca en la raiz del proyecto. Desde que el proyecto vive en la raiz
 * del repo, esa raiz tambien puede contener checkouts hermanos y estado local
 * (ver `.gitignore`), y ninguno es fuente de este proyecto: `front/` aporta 141
 * archivos `.ts` de otra app que hacian fallar esta guarda por la razon
 * equivocada. Los nombres son de directorio, se comparan por basename.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "tests",
  "front",
  "API",
  "odd",
  "entregables",
  ".agents",
  ".claude",
  ".codegraph",
  ".perxia",
  ".atl",
  ".vitest",
  ".auth",
  "out",
  "dist",
  "build",
  ".angular",
  "coverage",
  "test-results",
  "playwright-report",
  "__pycache__",
]);

/** Ramas de la paleta por defecto de Tailwind v4. */
const PALETTE_RAMPS = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

/** Utilidades de color que Tailwind genera para una rama de paleta. */
const COLOR_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "from",
  "to",
  "via",
  "fill",
  "stroke",
  "divide",
  "outline",
  "accent",
  "caret",
  "decoration",
  "placeholder",
  "shadow",
];

/**
 * `bg-slate-200`, `text-emerald-700`, `hover:bg-slate-100` (la variante se
 * corta antes) y también la forma con alfa, `bg-emerald-900/50`, que es paleta
 * cruda igual. Sin el `(?://[0-9]+)?` esas clases pasarían de largo.
 */
const RAW_PALETTE_RAMP = new RegExp(
  `^(?:${COLOR_UTILITIES.join("|")})-(?:${PALETTE_RAMPS.join("|")})(?:-[0-9]{2,3})?(?:/[0-9]+)?$`,
);

/**
 * `white` y `black` no son rampas: son colores planos que Tailwind también
 * genera sin token. Cuentan como crudos en cualquier utilidad —incluido el velo
 * traslúcido `bg-black/60`, cuya parte de color es igual de cruda— con UNA
 * excepción nombrada: `text-white`.
 *
 * `text-white` es el frente sobre rellenos sólidos de marca y quien lo
 * documenta como estándar —`buttonClass` en `src/shared/lib/ui-styles.ts`— lo
 * usa. Marcarlo como violación pondría la guarda en contradicción con la fuente
 * única de estilos compartidos. `text-black` NO tiene esa excepción: se cuenta.
 */
const RAW_WHITE_BLACK = new RegExp(
  `^(?:${COLOR_UTILITIES.join("|")})-(?:white|black)(?:/[0-9]+)?$`,
);

/** La única excepción nombrada de la regla de `white`/`black`. */
const SANCTIONED_FLAT_COLORS = new Set(["text-white"]);

/** Token de clase: variantes (`hover:`), utilidad, y como mucho `/alpha`. */
const CLASS_TOKEN = /[A-Za-z0-9_:./-]+/g;

/** Código sin comentarios: una clase nombrada al EXPLICAR el criterio no es una clase aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Tokens crudos de un fragmento de código, tal como están escritos (con su
 * variante). El `split(":")` final deja la utilidad: las clases de paleta nunca
 * contienen `:`, así que `dark:hover:bg-slate-800` se compara por `bg-slate-800`.
 */
function rawPaletteTokens(source: string): string[] {
  const found: string[] = [];
  for (const line of stripComments(source).split(/\r?\n/)) {
    for (const match of line.matchAll(CLASS_TOKEN)) {
      const token = match[0];
      const utility = token.split(":").pop() ?? token;
      if (RAW_PALETTE_RAMP.test(utility) || RAW_WHITE_BLACK.test(utility)) {
        if (!SANCTIONED_FLAT_COLORS.has(utility)) {
          found.push(token);
        }
      }
    }
  }
  return found;
}

/** Contenido de todos los .ts/.tsx de producción, indexado por ruta relativa. */
function readProductionSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      files.set(path.slice(APP_ROOT.length + 1).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(APP_ROOT);
  return files;
}

/**
 * Ofensores conocidos, con su conteo exacto. Si un archivo permitido suma o
 * pierde un token crudo, el conteo deja de coincidir y la guarda falla: así se
 * obliga a reescribir esta lista en cada unidad que limpia un archivo — WU2 lo
 * hizo con `combobox.tsx` y WU5 con los 184 tokens de la hoja de factura de
 * `invoices-client.tsx`. Lo que queda acá es lo que NO se puede mover sin
 * cambiar píxeles, y cada entrada dice por qué.
 */
const ALLOWLIST = new Map<string, { hits: number; reason: string }>([
  [
    "app/invoices/invoices-client.tsx",
    {
      hits: 40,
      reason:
        "WU5: son los 40 tokens del CROMO de la app (botón de modo cliente, pastilla de comisión, " +
        "tabla de historial y sus botones). Los 184 de la hoja de factura ya no están: se congelaron " +
        "en la familia `--paper-*` (documento, no tema), que renderiza igual en claro y en oscuro, y " +
        "el reemplazo fue de vocabulario, no de píxeles. Estos 40 NO tienen un token del proyecto con " +
        "el MISMO valor en los dos temas (text-slate-500 es #62748e en ambos, text-text-secondary es " +
        "#606060 en claro y #aeaeae en oscuro; bg-white es #ffffff, bg-surface es #f8f8f8/#0f0f0f), y " +
        "son además los únicos del archivo con socio `dark:`. Cambiarlos mueve píxeles: lo decide el " +
        "dueño, no esta unidad. La invariante de la familia del papel se guarda aparte, más abajo.",
    },
  ],
  [
    "src/components/ui/lib/dialog.tsx",
    { hits: 2, reason: "Velo `bg-black/60`: no existe token de velo y no se puede inventar uno." },
  ],
]);

/**
 * Archivos que WU1 dejó limpios: se afirman uno por uno, no solo por el agregado.
 *
 * `main-nav.tsx` entra acá con la unidad de las primitivas responsivas (R2): su
 * velo `bg-black/40` estaba en la lista permitida de más abajo, y al migrar el
 * cajón a la primitiva `Dialog` el velo dejó de ser suyo —lo pinta
 * `DialogContent`. La lista no se relajó: el archivo pasó de «1 token crudo
 * declarado» a CERO, y ahora lo cubre la misma regla que a los demás.
 */
const WU1_CLEANED = [
  "app/error.tsx",
  "app/not-found.tsx",
  "src/shared/components/main-nav.tsx",
  "src/shared/components/skeleton.tsx",
  "src/shared/components/theme-toggle.tsx",
];

const SOURCES = readProductionSources();

describe("detector de paleta cruda: no es un sello de goma", () => {
  it("detecta una clase cruda y no una cadena vacía de control", () => {
    expect(rawPaletteTokens('className="text-slate-500 dark:bg-slate-700"')).toEqual([
      "text-slate-500",
      "dark:bg-slate-700",
    ]);
  });

  it("una cadena solo de tokens no produce ningún hallazgo", () => {
    const tokens = [
      "text-text-primary",
      "text-text-secondary",
      "text-text-tertiary",
      "border-border-color",
      "border-border-color-2",
      "bg-surface",
      "bg-surface-hover",
      "bg-primary-600",
      "text-primary-color",
      "text-success",
      "bg-error-light",
      "ring-ring",
      // El borde negativo: `border-border` matchea como substring de
      // `border-border-color`, y `text-text-primary` termina en `text-primary`.
      "border-border",
      "text-primary",
    ].join(" ");
    expect(rawPaletteTokens(`className="${tokens}"`)).toEqual([]);
  });

  it("no cuenta una clase nombrada en un comentario", () => {
    expect(rawPaletteTokens('// bg-slate-200 estaba acá\n/* text-slate-500 */')).toEqual([]);
  });

  it("no cuenta un identificador que solo CONTIENE una clase cruda", () => {
    // Sin coincidencia completa desde el inicio del token, `my-bg-slate-200` y
    // `bg-slate-2000` (cuatro dígitos, no es un peldaño) serían falsos positivos.
    expect(rawPaletteTokens("const my_bg_slate_200 = 1; my-bg-slate-200 bg-slate-2000")).toEqual(
      [],
    );
  });

  it("el velo traslúcido cuenta como color crudo", () => {
    expect(rawPaletteTokens('className="fixed inset-0 bg-black/60"')).toEqual(["bg-black/60"]);
  });

  it("una rampa con alfa también cuenta", () => {
    expect(rawPaletteTokens('className="bg-emerald-900/50 bg-slate-900/30"')).toEqual([
      "bg-emerald-900/50",
      "bg-slate-900/30",
    ]);
  });

  it("`text-white` no cuenta: es el frente de los rellenos sólidos de marca", () => {
    expect(rawPaletteTokens('className="bg-primary-600 text-white"')).toEqual([]);
  });

  it("la excepción de `white`/`black` es exactamente una: `text-white`", () => {
    // `text-black` y `border-white` son igual de crudos y SÍ se cuentan; si la
    // excepción se ensanchara a toda la familia, estos dos pasarían de largo.
    expect(rawPaletteTokens('className="text-black border-white"')).toEqual([
      "text-black",
      "border-white",
    ]);
  });
});

describe("paleta cruda: importa el conteo de tokens, no los substrings", () => {
  it("el walk leyó los archivos de producción (piso anti-vacío)", () => {
    // Sin este piso, un walk roto (p. ej. cwd distinto) haría pasar la guarda sola.
    expect(SOURCES.size, "archivos .ts/.tsx de producción leídos").toBeGreaterThan(100);
  });

  it("ningún archivo fuera de la lista permitida usa la paleta cruda", () => {
    const offenders: string[] = [];
    for (const [path, source] of SOURCES) {
      if (ALLOWLIST.has(path)) {
        continue;
      }
      const hits = rawPaletteTokens(source);
      if (hits.length > 0) {
        offenders.push(`${path}: ${[...new Set(hits)].sort().join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("los archivos permitidos tienen exactamente los tokens crudos declarados", () => {
    const failures: string[] = [];
    for (const [path, { hits: expected }] of ALLOWLIST) {
      const source = SOURCES.get(path);
      if (source === undefined) {
        failures.push(`${path}: permitido pero no existe (entrada muerta)`);
        continue;
      }
      const found = rawPaletteTokens(source).length;
      if (found !== expected) {
        failures.push(`${path}: se esperaban ${expected} tokens crudos, hay ${found}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("los archivos que WU1 limpió no tienen ningún token crudo", () => {
    for (const path of WU1_CLEANED) {
      const source = SOURCES.get(path);
      expect(source, `${path} existe en el walk`).toBeDefined();
      expect([path, ...rawPaletteTokens(source ?? "")]).toEqual([path]);
    }
  });
});

/* --------------------------------------------------------------------------
   Familia del papel (WU5): DOCUMENTO, no superficie del tema.

   La hoja de factura se muestra como papel blanco con tinta oscura en los DOS
   temas, así que sus colores no pueden invertirse. WU5 los congeló en la familia
   `--paper-*` de design-tokens.css con los valores exactos que la hoja ya
   renderizaba con la paleta cruda (los 184 tokens que salieron de
   `app/invoices/invoices-client.tsx`), y expuso el puente `--color-paper-*`.
   Los tokens y las claves se clasifican a mano desde design-tokens.test.ts: el
   papel se declara deliberadamente fuera del registry.

   Acá se protege UNA sola invariante —el papel no se temiza— por los dos únicos
   caminos que existen para romperla:
     1. declarar un bloque `.dark` con un `--paper-*`;
     2. darle a un `--paper-*` un valor `var(--token-de-tema)`.
   Ninguno de los dos se detecta por convención: hay que leer el CSS real, igual
   que el resto de estas guardas.
   -------------------------------------------------------------------------- */
const TOKENS_PATH = join(APP_ROOT, "src", "styles", "design-tokens.css");
const GLOBALS_PATH = join(APP_ROOT, "app", "globals.css");
const PAPER_PREFIX = "--paper-";
/** 18 valores distintos en la hoja, 18 tokens: uno por valor, sin duplicar. */
const PAPER_TOKEN_COUNT = 18;
const TOKENS_CSS = readFileSync(TOKENS_PATH, "utf8");
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");

/**
 * Declaraciones `--x: valor;` de los bloques cuyo selector es exactamente
 * `selector`. Misma lectura que design-tokens.test.ts: los bloques no anidan
 * (salvo una media query que no declara tokens), así que alcanza con cortar
 * por llaves y quedarse con el selector real, el que sigue al último `}`.
 */
function themeVars(css: string, selector: string): Map<string, string> {
  const vars = new Map<string, string>();
  const blockRe = /([^{}]*)\{([^{}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(stripComments(css))) !== null) {
    const head = block[1];
    const selectorPart = head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1);
    if (!selectorPart.split(",").map((part) => part.trim()).includes(selector)) {
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

/** Tokens del papel que se temizan: redefinidos en `.dark` o resueltos por `var()`. */
function paperThemeViolations(tokensCss: string): string[] {
  const violations: string[] = [];
  for (const name of themeVars(tokensCss, ".dark").keys()) {
    if (name.startsWith(PAPER_PREFIX)) {
      violations.push(`${name}: el papel se redefine en .dark`);
    }
  }
  for (const [name, value] of themeVars(tokensCss, ":root")) {
    if (name.startsWith(PAPER_PREFIX) && /var\(/.test(value)) {
      violations.push(`${name}: toma su valor de otro token (${value})`);
    }
  }
  return violations;
}

/** Claves `--color-paper-*` de `@theme inline` y a qué token apuntan. */
function paperBridges(css: string): Map<string, string> {
  const block = /@theme\s+inline\s*\{([^}]*)\}/.exec(stripComments(css));
  expect(block, "@theme inline en globals.css").not.toBeNull();
  const bridges = new Map<string, string>();
  for (const decl of (block as RegExpExecArray)[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (decl[1].startsWith("--color-paper-")) {
      bridges.set(decl[1], decl[2].trim());
    }
  }
  return bridges;
}

const PAPER_VARS = new Map(
  [...themeVars(TOKENS_CSS, ":root")].filter(([name]) => name.startsWith(PAPER_PREFIX)),
);

describe("familia del papel: documento, no superficie del tema", () => {
  it("son 18 tokens, uno por valor (ningún color repetido bajo dos nombres)", () => {
    // Piso anti-vacío: si la lectura del CSS real se rompe, esta guarda pasaría sola.
    expect(PAPER_VARS.size, "tokens --paper-* leídos del CSS real").toBeGreaterThan(0);
    expect(PAPER_VARS.size, "tokens --paper-* en :root").toBe(PAPER_TOKEN_COUNT);
    const values = [...PAPER_VARS.values()];
    expect(new Set(values).size, `valores repetidos: ${values.join(", ")}`).toBe(values.length);
  });

  it("ningún --paper-* se temiza: ni bloque .dark, ni valor tomado de otro token", () => {
    expect(paperThemeViolations(TOKENS_CSS)).toEqual([]);
    const notLiteral = [...PAPER_VARS.values()].filter((value) => !/^#[0-9a-f]{6}$/i.test(value));
    expect(notLiteral, "los valores deben ser literales hex fijos").toEqual([]);
  });

  it("el detector no es un sello de goma: un `.dark` o un `var()` lo hacen fallar", () => {
    expect(paperThemeViolations(":root { --paper-ink: #0f172b; }")).toEqual([]);
    const conDark = paperThemeViolations(
      ":root { --paper-ink: #0f172b; }\n.dark { --paper-ink: #ffffff; }",
    );
    expect(conDark, "un .dark que redefine el papel").toHaveLength(1);
    expect(conDark[0]).toContain("--paper-ink");
    const conVar = paperThemeViolations(":root { --paper-ink: var(--text-primary); }");
    expect(conVar, "un papel que toma su valor del tema").toHaveLength(1);
    expect(conVar[0]).toContain("var(--text-primary)");
  });

  it("cada token del papel tiene su clave --color-paper-* y apunta a él, y a nadie más", () => {
    const bridges = paperBridges(GLOBALS_CSS);
    const failures: string[] = [];
    for (const name of PAPER_VARS.keys()) {
      const key = `--color-${name.slice(2)}`;
      const value = bridges.get(key);
      if (value !== `var(${name})`) {
        failures.push(`${key}: se esperaba var(${name}), hay ${value}`);
      }
    }
    if (bridges.size !== PAPER_VARS.size) {
      failures.push(`puentes --color-paper-*: ${bridges.size}, tokens del papel: ${PAPER_VARS.size}`);
    }
    expect(failures).toEqual([]);
  });
});
