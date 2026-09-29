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
   mapeo `invoiceStatusVariant`). Los 224 restantes son el cromo del papel de
   factura (impresión, tablas, botones, inputs) y siguen siendo WU5. Sin esta
   guarda el próximo archivo reintroduce la paleta cruda y la disparidad se
   reabre.

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
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests"]);

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
 * obliga a reescribir esta lista cuando WU5 limpie su archivo. WU2 ya limpió
 * `combobox.tsx`, así que no aparece acá y el test genérico lo exige limpio.
 */
const ALLOWLIST = new Map<string, { hits: number; reason: string }>([
  [
    "app/invoices/invoices-client.tsx",
    {
      hits: 224,
      reason:
        "WU5: unidad grande, fuera del alcance de WU1. WU4 ya bajó las pastillas de estado (246 → 224); el resto es el cromo del papel de factura.",
    },
  ],
  [
    "src/components/ui/lib/dialog.tsx",
    { hits: 2, reason: "Velo `bg-black/60`: no existe token de velo y no se puede inventar uno." },
  ],
  [
    "src/shared/components/main-nav.tsx",
    { hits: 1, reason: "Velo `bg-black/40`: mismo caso que dialog.tsx." },
  ],
]);

/** Archivos que WU1 dejó limpios: se afirman uno por uno, no solo por el agregado. */
const WU1_CLEANED = [
  "app/error.tsx",
  "app/not-found.tsx",
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
