import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/src/components/ui/lib/empty-state";

/* --------------------------------------------------------------------------
   Contrato de `EmptyState` (WU6d).

   El defecto que esta guarda cierra todavía no ocurrió, y esa es justo la
   razón de escribirla: el estándar §6 decide que el vacío es MUDO a propósito
   —sin `role` ni `aria-live`—, y la "mejora" obvia de un futuro refactor
   (envolverlo en `Alert`, agregarle `role="status"`) sería un cambio de
   conducta disfrazado de consistencia. Sin esta guarda, nada lo impediría:
   `tests/feedback-batch4.test.ts` pinea los ocho vacíos del panel admin, pero
   nadie pineaba EL PRIMITIVO. Esta es la otra mitad del candado.

   Método: no hay DOM ni render en este setup (`environment: "node"` es el
   default de `vitest.config.ts`). Lo que se afirma es de dos clases:
     1. lo que se puede ejecutar de verdad — el módulo se importa y se
        renderiza a HTML con `react-dom/server` (igual que
        `tests/ux-data-table.test.ts`), y se leen las clases reales;
     2. lo que solo se puede leer del fuente — la ausencia de `role` y de
        `aria-live`, y el vocabulario de clases, con el archivo real leído
        por `node:fs`.

   Conteo por TOKEN DE CLASE COMPLETO, nunca por substring: este repositorio se
   quemó dos veces con greps de substring (`text-text-primary` TERMINA en
   `text-primary`; `border-border` MATCHEA `border-border-color`). El control
   negativo de esa trampa está al final, explícito.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const MODULE_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "empty-state.tsx");
const SOURCE = readFileSync(MODULE_PATH, "utf8");

/** Código sin comentarios: una clase o un atributo nombrados al EXPLICAR algo no están aplicados. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CLEAN = stripComments(SOURCE);

/**
 * El predicado que usa la guarda: los ANUNCIOS que el fuente declara. En este
 * primitivo la dirección compliant es la lista VACÍA —la ausencia de `role` y
 * de `aria-live` ES la decisión (§6 del estándar)—, así que el predicado
 * devuelve lo que SOBRA, y el control negativo del final comprueba que acusa
 * una presencia real en vez de bendecir siempre.
 */
function announcementViolations(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  if (/\brole\s*=/.test(clean)) {
    violations.push("role=");
  }
  if (/aria-live/.test(clean)) {
    violations.push("aria-live");
  }
  return violations;
}

/** Token de clase: variantes (`hover:`), utilidad, y como mucho `/alpha`. */
const CLASS_TOKEN = /[A-Za-z0-9_:./-]+/g;

/** Todos los tokens de clase del fragmento, cortados enteros. */
function classTokens(source: string): string[] {
  return stripComments(source).match(CLASS_TOKEN) ?? [];
}

/** Utilidad del token, sin variantes: `dark:hover:bg-surface` -> `bg-surface`. */
function utilityOf(token: string): string {
  return token.split(":").pop() ?? token;
}

/**
 * Ramas de la paleta por defecto de Tailwind v4. Mismo criterio que
 * `tests/no-raw-palette.test.ts`, reducido a este archivo: ninguna utilidad
 * de color cruda puede aparecer en el primitivo.
 */
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

/** `bg-slate-200`, `text-emerald-700`, con alfa (`bg-black/60`) incluida. */
const RAW_PALETTE = new RegExp(
  `^(?:${COLOR_UTILITIES.join("|")})-(?:(?:${PALETTE_RAMPS.join("|")})(?:-[0-9]{2,3})?|(?:white|black))(?:/[0-9]+)?$`,
);

/** Tokens crudos de un fragmento, comparados ENTEROS (nunca substrings). */
function rawPaletteTokens(source: string): string[] {
  return classTokens(source).filter((token) => RAW_PALETTE.test(utilityOf(token)));
}

/* --------------------------------------------------------------------------
   1. El módulo existe y expone el contrato.
   -------------------------------------------------------------------------- */

describe("el módulo de estado vacío", () => {
  it("exporta `EmptyState` y renderiza un `<p>` con el texto", () => {
    // `EmptyState` es un `forwardRef`, o sea un objeto exótico de React, no
    // una función llamable: se instancia con `createElement`, no invocándolo.
    const html = renderToStaticMarkup(createElement(EmptyState, null, "Aún no hay empleados."));
    expect(html.startsWith("<p")).toBe(true);
    expect(html).toContain("Aún no hay empleados.");
  });

  it("se presenta con su nombre para las herramientas", () => {
    expect(EmptyState.displayName).toBe("EmptyState");
  });

  it("el render no anuncia nada: ni `role` ni `aria-live` en el HTML real", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, null, "Sin resultados."));
    expect(html).not.toContain("role=");
    expect(html).not.toContain("aria-live");
  });
});

/* --------------------------------------------------------------------------
   2. El vacío es mudo a propósito: el fuente no declara ningún anuncio.
   -------------------------------------------------------------------------- */

describe("`EmptyState` no lleva `role` ni `aria-live`", () => {
  it("la ausencia es la decisión: el predicado no encuentra nada que acusar", () => {
    expect(announcementViolations(CLEAN)).toEqual([]);
  });

  it("el icono decorativo tampoco anuncia: va `aria-hidden`, no con rol", () => {
    expect(CLEAN).toContain('aria-hidden="true"');
  });
});

/* --------------------------------------------------------------------------
   3. El vocabulario: tokens del proyecto, enteros.
   -------------------------------------------------------------------------- */

describe("el apagado del vacío sale de un token del proyecto", () => {
  it("el texto es `text-sm text-text-secondary`, y el icono su medida fija", () => {
    expect(CLEAN).toContain("cn('text-sm text-text-secondary'");
    expect(CLEAN).toContain('"mr-2 inline size-4 align-text-bottom"');
  });

  it("no introduce ninguna clase de la paleta cruda", () => {
    expect(rawPaletteTokens(CLEAN)).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   4-5. Piso anti-vacío y controles negativos: que la guarda ACUSE.
   -------------------------------------------------------------------------- */

describe("el walk leyó el primitivo real (piso anti-vacío)", () => {
  it("el fuente no está vacío y declara clases que el predicado puede ver", () => {
    expect(SOURCE.length).toBeGreaterThan(0);
    expect(classTokens(CLEAN).length).toBeGreaterThan(0);
    expect(CLEAN).toContain("EmptyState");
  });
});

describe("control negativo: la guarda del silencio acusa de verdad", () => {
  it("un `role` agregado al fuente se reporta como violación", () => {
    expect(announcementViolations('<p role="status">hola</p>')).toEqual(["role="]);
  });

  it("un `aria-live` agregado al fuente se reporta como violación", () => {
    expect(announcementViolations('<p aria-live="polite">hola</p>')).toEqual(["aria-live"]);
  });

  it("el detector de paleta cruda sí reconoce una clase cruda en este archivo", () => {
    // Si el detector no acusara esto, la afirmación de arriba sería un sello de goma.
    expect(rawPaletteTokens("'text-slate-500 bg-white'")).toEqual([
      "text-slate-500",
      "bg-white",
    ]);
  });
});

describe("control negativo: los tokens se cuentan enteros, no como substring", () => {
  it("`text-text-secondary` no esconde `text-secondary`, ni `border-border` es `border-border-color`", () => {
    const sample = "'text-text-secondary border-border-color'";
    expect(classTokens(sample)).toContain("text-text-secondary");
    expect(classTokens(sample)).toContain("border-border-color");
    expect(classTokens(sample)).not.toContain("text-secondary");
    expect(classTokens(sample)).not.toContain("border-border");
  });

  it("el piso anti-vacío rechazaría un fuente sin clases", () => {
    // Si `classTokens` devolviera algo para la cadena vacía, el piso de arriba
    // pasaría incluso con el walk roto.
    expect(classTokens("")).toEqual([]);
  });
});
