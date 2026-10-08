import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfirmDialog,
  FormDialog,
  type FormDialogSize,
} from "@/src/components/ui/lib/form-dialog";

/* --------------------------------------------------------------------------
   Contrato de `FormDialog` / `ConfirmDialog` (WU4a).

   El defecto que esta guarda cierra es doble, y los dos ya ocurrieron:

     1. `app/invoices/invoices-client.tsx` tiene 6 `DialogContent` y 0
        `DialogTitle`. Radix toma el nombre accesible del `DialogTitle`: esos 6
        modales se anuncian sin nombre.
     2. La misma acción construida de dos maneras en el mismo panel: crear/
        editar es un diálogo en `employees-section.tsx` / `users-section.tsx` /
        `vales-section.tsx`, y un formulario inline en `taxes-section.tsx` /
        `methods-section.tsx` / `cash-section.tsx`.

   Método: no hay DOM ni render en este setup (`environment: "node"`). Lo que se
   afirma es de dos clases:
     1. lo que se puede ejecutar de verdad — que el módulo importe y exporte las
        dos primitivas, y que su tabla de anchos coincida con la esperada;
     2. lo que solo se puede leer del fuente — los elementos que la primitiva
        renderiza y el vocabulario de clases, con el archivo real leído por
        `node:fs`.

   Conteo por TOKEN DE CLASE COMPLETO, nunca por substring: este repositorio se
   quemó dos veces con greps de substring (`text-text-primary` TERMINA en
   `text-primary`; `border-border` MATCHEA `border-border-color`). El control
   negativo de esa trampa está al final, explícito.

   Esta guarda NO migra a nadie: los llamadores son otra unidad. Y todavía NO
   incluye la guarda de adopción («ningún `DialogContent` en el árbol sin su
   `DialogTitle`»), que es la continuación natural de `dialogsWithoutTitle`: hoy
   fallaría, porque `invoices-client.tsx` tiene los 6 ofensores que este
   primitivo viene a eliminar. Se agrega cuando esa migración esté hecha; el
   predicado ya está escrito para eso y su control negativo ya está abajo.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const MODULE_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "form-dialog.tsx");
const SOURCE = readFileSync(MODULE_PATH, "utf8");

/** Código sin comentarios: una clase o una etiqueta nombrada al EXPLICAR algo no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CLEAN = stripComments(SOURCE);

/** Cuerpo de un `export function NOMBRE(` hasta el próximo `export` del archivo. */
function exportedBody(source: string, name: string): string {
  const marker = `export function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`el fuente no declara \`${marker}\``);
  }
  const next = source.indexOf("\nexport ", start + marker.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

const FORM_BODY = exportedBody(CLEAN, "FormDialog");
const CONFIRM_BODY = exportedBody(CLEAN, "ConfirmDialog");

/** Cantidad de veces que aparece una etiqueta EXACTA (no un prefijo de otra). */
function countTag(source: string, tag: string): number {
  return source.match(new RegExp(`${tag}\\b`, "g"))?.length ?? 0;
}

/* --------------------------------------------------------------------------
   1. El módulo existe y expone el contrato.
   -------------------------------------------------------------------------- */

const EXPECTED_SIZE_CLASS: Record<FormDialogSize, string> = {
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

/** El mapa `FORM_DIALOG_SIZE_CLASS` del fuente, leído como datos. */
function sizeClassMap(source: string): Record<string, string> {
  const block = stripComments(source).match(/FORM_DIALOG_SIZE_CLASS[^{]*\{([\s\S]*?)\}/);
  if (!block) {
    throw new Error("el fuente no declara `FORM_DIALOG_SIZE_CLASS`");
  }
  const map: Record<string, string> = {};
  for (const entry of block[1].matchAll(/([A-Za-z]+)\s*:\s*'([^']*)'/g)) {
    map[entry[1]] = entry[2];
  }
  return map;
}

describe("el módulo de diálogos", () => {
  it("importa y exporta las dos primitivas", () => {
    expect(typeof FormDialog).toBe("function");
    expect(typeof ConfirmDialog).toBe("function");
  });

  it("es un módulo cliente: hay handlers, no un Server Component", () => {
    expect(SOURCE.startsWith("'use client'")).toBe(true);
  });

  it("mapea los tres tamaños a su ancho, y el default es `lg`", () => {
    // El `Record<FormDialogSize, string>` de arriba es el candado de tipos: si
    // el unión cambia, `tsc --noEmit` falla en esta misma línea.
    expect(sizeClassMap(SOURCE)).toEqual(EXPECTED_SIZE_CLASS);
    expect(CLEAN.match(/\bsize\s*=\s*'([^']*)'/)?.[1]).toBe("lg");
  });
});

/* --------------------------------------------------------------------------
   2. El nombre accesible: cada `DialogContent` lleva su `DialogTitle`.

   El predicado es el que va a necesitar la guarda de adopción, así que no
   cuenta por archivo —un archivo con 2 modales y 2 títulos igualados pasaría—
   sino POR BLOQUE, que es donde el olvido ocurre.
   -------------------------------------------------------------------------- */

/** `DialogContent`s cuyo bloque no contiene un `DialogTitle`. */
function dialogsWithoutTitle(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  for (const segment of clean.split("<DialogContent").slice(1)) {
    const end = segment.indexOf("</DialogContent>");
    const block = end >= 0 ? segment.slice(0, end) : segment;
    if (!/<DialogTitle\b/.test(block)) {
      violations.push("<DialogContent>");
    }
  }
  return violations;
}

describe("todo `DialogContent` de la primitiva se anuncia con nombre", () => {
  it("no deja ningún diálogo sin `DialogTitle`", () => {
    expect(dialogsWithoutTitle(FORM_BODY)).toEqual([]);
    expect(dialogsWithoutTitle(CONFIRM_BODY)).toEqual([]);
    // Y que el predicado no esté bendiciendo un archivo vacío.
    expect(countTag(FORM_BODY, "<DialogContent")).toBe(1);
    expect(countTag(CONFIRM_BODY, "<DialogContent")).toBe(1);
  });
});

/* --------------------------------------------------------------------------
   3-5. Lo que cada primitiva arma por el llamador.
   -------------------------------------------------------------------------- */

describe("`ConfirmDialog`", () => {
  it("explica qué se pierde: lleva `DialogDescription` obligatoria", () => {
    expect(CONFIRM_BODY).toContain("<DialogDescription>");
  });
});

describe("`FormDialog`", () => {
  it("arma su propio `<form>` y es EL quien corta el submit nativo", () => {
    expect(FORM_BODY).toContain("<form onSubmit=");
    expect(FORM_BODY).toContain("event.preventDefault()");
    // El llamador NO recibe el submit crudo: si lo recibiera, `preventDefault`
    // volvería a ser una decisión suya, o sea exactamente lo que hoy se repite
    // (y se olvida) en cada sección.
    expect(FORM_BODY).not.toContain("<form onSubmit={onSubmit}");
  });

  it("renderiza el `Alert` de error y bloquea el envío mientras `busy`", () => {
    expect(FORM_BODY).toContain("<Alert");
    expect(FORM_BODY).toContain('variant="destructive"');
    expect(FORM_BODY).toContain("disabled={busy}");
    // El `disabled` mudo no alcanza: la etiqueta dice qué está pasando.
    expect(FORM_BODY).toContain("{busy ? busyLabel : submitLabel}");
  });

  it("declara la ausencia de descripción en vez de dejarla librada al azar", () => {
    // El opt-out va SOLO en la rama sin descripción. Aplicarlo siempre pisaría
    // el `aria-describedby` que Radix calcula solo cuando la descripción existe.
    expect(CLEAN).toContain('const NO_DESCRIPTION_ATTR = { \'aria-describedby\': undefined }');
    expect(FORM_BODY).toContain("{...(hasDescription ? {} : NO_DESCRIPTION_ATTR)}");
  });
});

/* --------------------------------------------------------------------------
   6. El vocabulario del botón destructivo.

   `ui-styles.ts` no tiene clase de peligro y `globals.css` solo expone
   `--color-error` / `--color-error-600`: el hover se resuelve con opacidad, no
   con un peldaño inventado. `text-white` es la ÚNICA excepción que
   `tests/no-raw-palette.test.ts` sanciona (`SANCTIONED_FLAT_COLORS`).
   -------------------------------------------------------------------------- */

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

/** Mismo criterio que `tests/no-raw-palette.test.ts`, reducido a este archivo. */
const RAW_PALETTE = new RegExp(
  `^(?:${COLOR_UTILITIES.join("|")})-(?:(?:${PALETTE_RAMPS.join("|")})(?:-[0-9]{2,3})?|(?:white|black))(?:/[0-9]+)?$`,
);

const SANCTIONED_FLAT_COLORS = new Set(["text-white"]);

/** Token de clase: variantes (`hover:`), utilidad, y como mucho `/alpha`. */
const CLASS_TOKEN = /[A-Za-z0-9_:./-]+/g;

/** Todos los tokens de clase del fragmento, con su variante, cortados enteros. */
function classTokens(source: string): string[] {
  return stripComments(source).match(CLASS_TOKEN) ?? [];
}

/** Utilidad del token, sin variantes: `dark:hover:bg-slate-800` -> `bg-slate-800`. */
function utilityOf(token: string): string {
  return token.split(":").pop() ?? token;
}

function rawPaletteTokens(source: string): string[] {
  return classTokens(source).filter((token) => {
    const utility = utilityOf(token);
    return RAW_PALETTE.test(utility) && !SANCTIONED_FLAT_COLORS.has(utility);
  });
}

describe("el rojo del destructivo sale de un token del proyecto", () => {
  it("usa `bg-error` + `text-white` y su hover es la opacidad, no un peldaño nuevo", () => {
    expect(CLEAN).toContain("bg-error text-white hover:bg-error hover:opacity-90");
  });

  it("solo lo destructivo usa ese fondo: `default` sigue siendo el botón primario", () => {
    expect(CONFIRM_BODY).toContain("variant === 'destructive'");
    expect(CONFIRM_BODY).toContain("buttonClass");
  });

  it("no introduce ninguna clase de la paleta cruda", () => {
    expect(rawPaletteTokens(CLEAN)).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   8-9. Los dos controles negativos: que la guarda ACUSE, y que mida tokens.

   Sin el primero, un predicado roto que devuelve la lista vacía siempre pasaría
   las nueve afirmaciones anteriores. Sin el segundo, el mismo predicado se
   rompería en silencio con la primera clase que sea substring de otra.
   -------------------------------------------------------------------------- */

describe("control negativo: la guarda de nombre accesible acusa de verdad", () => {
  it("reporta un `DialogContent` sin `DialogTitle`", () => {
    expect(dialogsWithoutTitle("<DialogContent><p>hola</p></DialogContent>")).toEqual([
      "<DialogContent>",
    ]);
  });

  it("cuenta POR BLOQUE: dos modales con un solo título siguen siendo una violación", () => {
    const sample =
      "<DialogContent><DialogTitle>a</DialogTitle></DialogContent>" +
      "<DialogContent><p>sin nombre</p></DialogContent>";
    expect(dialogsWithoutTitle(sample)).toEqual(["<DialogContent>"]);
  });
});

describe("control negativo: los tokens se cuentan enteros, no como substring", () => {
  it("`text-text-primary` no se lee como `text-primary`, ni `border-border` como `border-border-color`", () => {
    const sample = "'text-text-primary border-border-color'";
    expect(classTokens(sample)).toContain("text-text-primary");
    expect(classTokens(sample)).toContain("border-border-color");
    expect(classTokens(sample)).not.toContain("text-primary");
    expect(classTokens(sample)).not.toContain("border-border");
  });

  it("el detector de paleta cruda sí reconoce una clase cruda", () => {
    // Si el detector no acusara esto, la afirmación de arriba sería un sello de goma.
    expect(rawPaletteTokens("'hover:bg-slate-200 bg-black/60'")).toEqual([
      "hover:bg-slate-200",
      "bg-black/60",
    ]);
    // Y `text-white` es la excepción nombrada, no un olvido.
    expect(rawPaletteTokens("'text-white bg-white'")).toEqual(["bg-white"]);
  });
});
