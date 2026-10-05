import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO módulo del que `src/components/ui/lib/utils.ts` importa el `twMerge`
// que usa `cn(...)`. No es una copia de la regla de fusión: es la regla.
import { twMerge } from "tailwind-merge";
import {
  buttonClass,
  ghostClass,
  inputClass,
  labelClass,
  linkButtonClass,
} from "@/src/shared/lib/ui-styles";
import { buttonVariants } from "@/src/components/ui/lib/button";

/* --------------------------------------------------------------------------
   R22, R14 y R13 — el piso táctil de los tokens compartidos.

   MEDIDO en Chromium real antes del arreglo (320 y 1024, sesión con datos):

   | Qué                        | Medido | Piso del repo          |
   | --------------------------- | ------ | ---------------------- |
   | Campo de login              | 14 px / 38 px | 16 px (zoom iOS) y 44 px |
   | Campo de formulario (inventario) | 14 px / 40 px | ídem           |
   | Botón primario              | 36 px  | 44 px móvil            |
   | Botón ghost                 | 38 px  | 44 px móvil            |
   | Botón de icono              | 40 px  | 44 px móvil            |
   | Casilla                     | 16×16  | 24×24 (piso duro)      |
   | Botón subrayado             | 20 px  | 44 px móvil            |

   Y a 1024: 22 elementos interactivos, LOS 22 bajo 44. El piso no es un
   problema de ancho: es una decisión de densidad. Por eso el arreglo de esta
   unidad es SOLO por debajo de `sm` (el estándar llama 44 px «objetivo táctil
   MÓVIL», `docs/ux-ui-standard.md` §8) y el costo de cambiar la densidad de
   escritorio se reporta aparte, para que el dueño lo decida.

   POR QUÉ ESTA GUARDA NO ES UN GREP DE TOKENS. El punto ciego de la familia
   ya salió dos veces hoy: un token presente prueba la INTENCIÓN, no el
   RESULTADO. Acá la clase del token se mezcla con la clase del llamador (y con
   la de la primitiva que la envuelve, `Input`) con el mismo `tailwind-merge`
   que usa el código, así que la cuenta se hace sobre la clase EFECTIVA, y el
   criterio se calcula como lo calcula el navegador: tamaño de fuente, alto de
   línea, padding, borde, `height` y `min-height`. Abajo de `sm` se exige el
   piso; desde `sm` se exige EXACTAMENTE el número de hoy.

   LA CALIBRACIÓN ESTÁ MEDIDA, NO INVENTADA: `cajaDe` tiene que reproducir los
   números que Chromium midió con las clases de ANTES (`ANTES_*`), y eso se
   afirma con literales. Si el modelo no los reproduce, las ocho afirmaciones
   siguientes no probarian nada.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const INPUT_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "input.tsx");
const CHECKBOX_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "checkbox.tsx");

const INPUT_SOURCE = readFileSync(INPUT_PATH, "utf8");
const CHECKBOX_SOURCE = readFileSync(CHECKBOX_PATH, "utf8");

/** Código sin comentarios: una clase narrada al EXPLICAR no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * El primer literal de clase de un `cn(` en el fuente: la clase BASE que la
 * primitiva impone antes de fusionar la que llega por prop. Es el orden real
 * de `tailwind-merge` (primero la base, después el llamador), y el orden
 * importa: el llamador gana en el mismo grupo.
 */
function cnFirstLiteral(source: string): string {
  const clean = stripComments(source);
  const start = clean.indexOf("cn(");
  if (start < 0) throw new Error("el fuente no usa `cn(`");
  const literal = clean.slice(start).match(/'([^']*)'|"([^"]*)"/);
  const value = literal?.[1] ?? literal?.[2];
  if (!value) throw new Error("el `cn(` no tiene un literal de clase");
  return value;
}

/** La clase del `CheckboxPrimitive.Root`: la constante que el `cn(...)` recibe. */
function checkboxRootClass(): string {
  const clean = stripComments(CHECKBOX_SOURCE);
  const declaration = clean.match(/const CHECKBOX_ROOT_CLASS\s*=\s*'([^']*)'/);
  if (!declaration) throw new Error("`checkbox.tsx` no declara `const CHECKBOX_ROOT_CLASS = '…'`");
  // Y que la raíz la monte de verdad: una constante correcta que nadie usa es
  // una constante decorativa, y la guarda tiene que decir eso, no el token.
  const root = clean.match(/<CheckboxPrimitive\.Root[\s\S]*?className=\{cn\(CHECKBOX_ROOT_CLASS/);
  if (!root) throw new Error("el `CheckboxPrimitive.Root` no usa `CHECKBOX_ROOT_CLASS`");
  return declaration[1];
}

/* ==========================================================================
   La caja efectiva: el criterio, no el token.
   ========================================================================== */

/** Escala tipográfica de Tailwind v4 (px de fuente / px de interlineado). */
const TEXTO: Record<string, { px: number; lh: number }> = {
  xs: { px: 12, lh: 16 },
  sm: { px: 14, lh: 20 },
  base: { px: 16, lh: 24 },
  lg: { px: 18, lh: 28 },
  xl: { px: 20, lh: 28 },
  "2xl": { px: 24, lh: 32 },
};

/** Las variantes que dependen del ANCHO de pantalla (el resto no restringe). */
const ANCHO: Record<string, { min?: number; max?: number }> = {
  sm: { min: 640 },
  md: { min: 768 },
  lg: { min: 1024 },
  xl: { min: 1280 },
  "2xl": { min: 1536 },
  "max-sm": { max: 639 },
  "max-md": { max: 767 },
  "max-lg": { max: 1023 },
  "max-xl": { max: 1279 },
  "max-2xl": { max: 1535 },
};

const ESPACIO = 4; // 1 === 0.25rem en la escala de Tailwind

type Caja = {
  fuente: number;
  interlineado: number;
  paddingY: number;
  /** Ancho del BORDE por lado (0 si la caja no tiene borde). */
  borde: number;
  alto: number | null;
  altoMin: number | null;
  ancho: number | null;
  anchoMin: number | null;
  display: string | null;
  /** Cuánto crece el ÁREA TÁCTIL por eje: el `::after` que se sale de la caja. */
  hitInset: number;
};

/** ¿Este token aplica a este ancho de pantalla? */
function activoEn(token: string, vw: number): boolean {
  const partes = token.split(":");
  for (let i = 0; i < partes.length - 1; i += 1) {
    const v = ANCHO[partes[i]];
    if (!v) continue;
    if (v.min !== undefined && vw < v.min) return false;
    if (v.max !== undefined && vw > v.max) return false;
  }
  return true;
}

function rem(valor: string): number {
  return Number(valor) * ESPACIO;
}

/**
 * La caja que el navegador pinta con ESTA clase a ESTE ancho, deduciendo una
 * propiedad por vez. Las utilidades que no se understands no tocan nada: el
 * objetivo es calcular alto y tipografía, no simular Tailwind entero.
 */
function cajaDe(clase: string, vw: number): Caja {
  const caja: Caja = {
    fuente: 16,
    interlineado: 24,
    paddingY: 0,
    borde: 0,
    alto: null,
    altoMin: null,
    ancho: null,
    anchoMin: null,
    display: null,
    hitInset: 0,
  };
  for (const token of clase.split(/\s+/).filter(Boolean)) {
    if (!activoEn(token, vw)) continue;
    const partes = token.split(":");
    const base = partes[partes.length - 1];
    const esAfter = partes.slice(0, -1).includes("after");

    const texto = base.match(/^text-(xs|sm|base|lg|xl|2xl)$/);
    if (texto) {
      caja.fuente = TEXTO[texto[1]].px;
      caja.interlineado = TEXTO[texto[1]].lh;
    }
    const py = base.match(/^py-(\d+(?:\.\d+)?)$/);
    if (py) caja.paddingY = rem(py[1]);
    if (base === "border") caja.borde = 1;
    const borde = base.match(/^border-(\d)$/);
    if (borde) caja.borde = Number(borde[1]);
    const h = base.match(/^h-(\d+(?:\.\d+)?)$/);
    if (h) caja.alto = rem(h[1]);
    const mh = base.match(/^min-h-(\d+(?:\.\d+)?)$/);
    if (mh) caja.altoMin = rem(mh[1]);
    const w = base.match(/^w-(\d+(?:\.\d+)?)$/);
    if (w) caja.ancho = rem(w[1]);
    const mw = base.match(/^min-w-(\d+(?:\.\d+)?)$/);
    if (mw) caja.anchoMin = rem(mw[1]);
    if (["flex", "inline-flex", "block", "inline-block", "inline", "grid"].includes(base)) {
      caja.display = base;
    }
    // `after:-inset-1.5`: el pseudo-elemento que se sale de la caja y agranda el
    // blanco táctil SIN cambiar lo que se ve. Es el mecanismo de R13.
    if (esAfter) {
      const inset = base.match(/^-?inset-(\d+(?:\.\d+)?)$/);
      if (inset) caja.hitInset = rem(inset[1]);
    }
  }
  return caja;
}

/**
 * El alto final, como lo resuelve el CSS con `box-sizing: border-box`:
 *
 *  1. `height` explícito manda sobre el contenido (el `py-2` no se le suma);
 *  2. si no hay `height`, la caja es `interlineado + 2·paddingY + 2·borde`;
 *  3. `min-height` le gana a las dos — es lo que levanta el piso móvil.
 *
 * El punto 3 es el que hace que `min-h-11` sobre un `h-10` produzca 44 y no
 * 40, y es la razón de que el arreglo no pueda ser «cambiar el `h-10`».
 */
function altoDe(clase: string, vw: number): number {
  const caja = cajaDe(clase, vw);
  const conPadding =
    caja.display === "inline"
      ? caja.interlineado + 2 * caja.borde
      : caja.interlineado + 2 * caja.borde + 2 * caja.paddingY;
  return Math.max(caja.alto ?? conPadding, caja.altoMin ?? 0);
}


/**
 * El ÁREA TÁCTIL del control, en px por eje: la caja visible más lo que se
 * le agrega con el pseudo-elemento. Es el número contra el que se mide R13.
 *
 * MEDIDO, y no teórico: el `::after` con `inset` negativo se posiciona contra
 * la CAJA DE RELLENO, o sea la caja de borde MENOS el borde. Con `h-4 w-4
 * border` (16 px) y `after:-inset-1` (4 px) el hit real fue de 22 px por eje,
 * no 24: 16 − 2 + 8 = 22. El hit es la UNIÓN de la caja de borde (que sin
 * `::after` ya es 16, borde incluido) y la del pseudo, así que es el MAYOR de
 * las dos. Por eso `-inset-1` no alcanzaba y el token lleva `-inset-1.5`:
 * 16 − 2 + 12 = 26 px medidos.
 */
function hitAreaDe(clase: string, vw: number): { ancho: number; alto: number } {
  const caja = cajaDe(clase, vw);
  const union = (lado: number) => Math.max(lado, lado - 2 * caja.borde + 2 * caja.hitInset);
  return {
    ancho: union(Math.max(caja.ancho ?? 0, caja.anchoMin ?? 0)),
    alto: union(Math.max(caja.alto ?? 0, caja.altoMin ?? 0)),
  };
}

/* ==========================================================================
   Controles negativos: el modelo tiene que reproducir lo MEDIDO.

   Estas clases son las de ANTES del arreglo, literales. Los números de la
   derecha son los que Chromium midió en vivo. Si el modelo no los reproduce,
   las afirmaciones de piso que siguen no prueban nada: prueban una regla
   inventada que casualmente coincide.
   ========================================================================== */

const ANTES_INPUT =
  "rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm";
const ANTES_INPUT_PRIMITIVE =
  "flex h-10 w-full items-center rounded-lg border bg-surface px-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none";
const ANTES_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm";
const ANTES_GHOST =
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm";
const ANTES_ICON = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium h-10 w-10";
const ANTES_CHECKBOX = "peer h-4 w-4 shrink-0 rounded-[4px] border border-border-color bg-surface";
const ANTES_LINK = "text-sm font-medium underline";

describe("calibración: el modelo reproduce los números MEDIDOS del estado previo", () => {
  it("el campo de login medía 14 px de fuente y 38 px de alto", () => {
    expect(cajaDe(ANTES_INPUT, 320).fuente).toBe(14);
    expect(altoDe(ANTES_INPUT, 320)).toBe(38);
  });

  it("el campo de formulario medía 14 px de fuente y 40 px de alto", () => {
    const fusionado = twMerge(ANTES_INPUT_PRIMITIVE, ANTES_INPUT);
    expect(cajaDe(fusionado, 320).fuente).toBe(14);
    expect(altoDe(fusionado, 320)).toBe(40);
  });

  it("los botones medían 36 (primario), 38 (ghost) y 40 (icono)", () => {
    expect(altoDe(ANTES_BUTTON, 320)).toBe(36);
    expect(altoDe(ANTES_GHOST, 320)).toBe(38);
    expect(altoDe(ANTES_ICON, 320)).toBe(40);
  });

  it("la casilla medía 16×16 de área táctil y el subrayado 20 px de alto", () => {
    expect(hitAreaDe(ANTES_CHECKBOX, 320)).toEqual({ ancho: 16, alto: 16 });
    expect(altoDe(ANTES_LINK, 320)).toBe(20);
  });
});

/* ==========================================================================
   R22 — el campo: 16 px de tipografía y el piso táctil, SOLO abajo de `sm`.
   ========================================================================== */

describe("R22: el campo compartido llega a 16 px y al piso táctil por debajo de `sm`", () => {
  it("la clase del token, sola, sube a 16 px y a 44 px por debajo de `sm`", () => {
    // MEDIDO antes: 14 px / 38 px. El umbral de 16 px es el que dispara el
    // zoom de iOS al enfocar, y el zoom mueve el layout mientras se escribe.
    expect(cajaDe(inputClass, 320).fuente, "fuente a 320").toBeGreaterThanOrEqual(16);
    expect(altoDe(inputClass, 320), "alto a 320").toBeGreaterThanOrEqual(44);
  });

  it("el tipo de campo que la aplicación usa de verdad llega igual", () => {
    // La clase del token casi nunca llega sola: `Input` la envuelve con su
    // PROPIA base (`h-10 text-sm`), y ahí es donde el arreglo se puede perder.
    // Se mezcla con el mismo `twMerge` y en el mismo orden que el componente.
    const conPrimitiva = twMerge(cnFirstLiteral(INPUT_SOURCE), inputClass);
    expect(cajaDe(conPrimitiva, 320).fuente, "fuente a 320 con la primitiva").toBeGreaterThanOrEqual(16);
    expect(altoDe(conPrimitiva, 320), "alto a 320 con la primitiva").toBeGreaterThanOrEqual(44);
  });

  it("y con las clases que los llamadores le suman de verdad", () => {
    // Los dos únicos `cn(inputClass, …)` del repo. Un token arreglado que
    // estos dos borran es un arreglo que no existe.
    for (const llamador of ["flex-1", "w-full pr-10"]) {
      const fusionado = twMerge(inputClass, llamador);
      expect(cajaDe(fusionado, 320).fuente, `fuente a 320 con \`${llamador}\``).toBeGreaterThanOrEqual(16);
      expect(altoDe(fusionado, 320), `alto a 320 con \`${llamador}\``).toBeGreaterThanOrEqual(44);
    }
  });

  it("desde `sm` la densidad de escritorio NO cambia: 14 px y el alto de hoy", () => {
    expect(cajaDe(inputClass, 1024).fuente, "fuente a 1024").toBe(14);
    expect(altoDe(inputClass, 1024), "alto del campo pelado a 1024").toBe(38);
    const conPrimitiva = twMerge(cnFirstLiteral(INPUT_SOURCE), inputClass);
    expect(altoDe(conPrimitiva, 1024), "alto del campo con `Input` a 1024").toBe(40);
  });
});

/* ==========================================================================
   R14 — los botones: 44 px por debajo de `sm`, escritorio intacto.
   ========================================================================== */

describe("R14: los botones compartidos llegan al piso táctil por debajo de `sm`", () => {
  it("el primario y el ghost llegan a 44 px abajo de `sm`", () => {
    // MEDIDO antes: 36 y 38. Contra el objetivo móvil de 44 (§8 del estándar).
    expect(altoDe(buttonClass, 320), "primario a 320").toBeGreaterThanOrEqual(44);
    expect(altoDe(ghostClass, 320), "ghost a 320").toBeGreaterThanOrEqual(44);
  });

  it("el escritorio de esos dos no se mueve: 36 y 38, como hoy", () => {
    expect(altoDe(buttonClass, 1024)).toBe(36);
    expect(altoDe(ghostClass, 1024)).toBe(38);
  });

  it("los tamaños de la primitiva `Button` llegan a 44×44 abajo de `sm`", () => {
    // MEDIDO antes: `default` 40, `sm` 36 y `icon` 40×40.
    const default_ = buttonVariants({ variant: "default" });
    const sm = buttonVariants({ variant: "default", size: "sm" });
    const icon = buttonVariants({ variant: "default", size: "icon" });

    expect(altoDe(default_, 320), "default a 320").toBeGreaterThanOrEqual(44);
    expect(altoDe(sm, 320), "sm a 320").toBeGreaterThanOrEqual(44);
    const hitIcon = hitAreaDe(icon, 320);
    expect(hitIcon.alto, "icon a 320").toBeGreaterThanOrEqual(44);
    expect(hitIcon.ancho, "icon a 320").toBeGreaterThanOrEqual(44);
  });

  it("`lg` y `xl` ya llegaban: la guarda no les exige nada nuevo", () => {
    expect(altoDe(buttonVariants({ size: "lg" }), 320)).toBeGreaterThanOrEqual(44);
    expect(altoDe(buttonVariants({ size: "xl" }), 320)).toBeGreaterThanOrEqual(48);
  });

  it("la densidad de escritorio de la primitiva no se toca", () => {
    expect(altoDe(buttonVariants({ variant: "default" }), 1024)).toBe(40);
    expect(altoDe(buttonVariants({ variant: "default", size: "sm" }), 1024)).toBe(36);
    expect(hitAreaDe(buttonVariants({ variant: "default", size: "icon" }), 1024)).toEqual({
      ancho: 40,
      alto: 40,
    });
  });

  it("el piso móvil no lo puede tumbar un `h-*` del llamador, pero el escritorio sí lo sigue", () => {
    // Abajo de `sm` el piso es un PISO: `min-height` le gana a `height` en el
    // CSS, así que un `h-8` del llamador no puede dejar el botón en 32 px con
    // el dedo. Esa es toda la razón de usar `min-h-*` y no `h-*`.
    //
    // Arriba de `sm` no hay `min-height` declarado, así que el llamador manda
    // entero: la densidad de escritorio sigue siendo suya. Y hoy no hay ningún
    // llamador que pase un alto (`Button` con `size` es 1 de 19 usos y ninguno
    // fija `h-*`), así que esto no le quita nada a nadie.
    const conAlto = twMerge(buttonVariants({ variant: "default" }), "h-8");
    expect(altoDe(conAlto, 320), "abajo de `sm` el piso aguanta").toBe(44);
    expect(altoDe(conAlto, 1024), "arriba de `sm` manda el llamador").toBe(32);
  });
});

/* ==========================================================================
   R13 — la casilla y el botón subrayado.
   ========================================================================== */

describe("R13: la casilla y el botón subrayado se pueden tocar", () => {
  it("el área táctil de la casilla llega a 24×24 en TODOS los anchos", () => {
    // MEDIDO antes: 16×16. 24 px es el piso DURO del repo (WCAG 2.5.8, AA,
    // `docs/ux-ui-standard.md` §8) y no tiene excepción de escritorio: por eso
    // aquí no hay `sm:` — agrandar el blanco no cambia ni un píxel de lo que
    // se ve, así que no hay densidad de escritorio que pagar.
    const hit = hitAreaDe(checkboxRootClass(), 320);
    expect(hit.ancho, "ancho táctil de la casilla").toBeGreaterThanOrEqual(24);
    expect(hit.alto, "alto táctil de la casilla").toBeGreaterThanOrEqual(24);
    expect(hitAreaDe(checkboxRootClass(), 1024)).toEqual(hit);
  });

  it("la casilla NO se ve más grande: la caja visible sigue en 16×16", () => {
    // El arreglo agranda el blanco, no el control. Si esto falla, se está
    // arreglando el síntoma feo en vez del difícil.
    const caja = cajaDe(checkboxRootClass(), 1024);
    expect(caja.ancho).toBe(16);
    expect(caja.alto).toBe(16);
  });

  it("el botón subrayado llega al piso móvil sin cambiar el escritorio", () => {
    // MEDIDO antes: 20 px de alto, y el censo lo cuenta 20 veces en Empleados,
    // 50 en Roles, 22 en Caja, 15 en Vales, 6 en Métodos y 2 en Impuestos.
    // El token se arregla UNA vez y los 115 usos los reciben.
    expect(altoDe(linkButtonClass, 320), "subrayado a 320").toBeGreaterThanOrEqual(44);
    expect(altoDe(linkButtonClass, 1024), "subrayado a 1024").toBe(20);
  });

  it("el subrayado sigue siendo un enlace de texto: conserva el subrayado y el tamaño", () => {
    expect(linkButtonClass).toContain("underline");
    expect(cajaDe(linkButtonClass, 1024).fuente).toBe(14);
  });
});

/* ==========================================================================
   Controles negativos de las guards de arriba.
   ========================================================================== */

describe("control negativo: el modelo acusa los defectos medidos", () => {
  it("un `text-xs` del llamador se lleva el piso de tipografía si la primitiva no lo declara", () => {
    // El punto ciego de la familia, reproducido a propósito: si el token
    // dependiera de `text-sm` solo, esta fusión lo rompería y el token
    //seguiría estando en el archivo. Por eso la guarda mira la clase
    // efectiva y no la presencia del token.
    const roto = twMerge(ANTES_INPUT_PRIMITIVE, "text-xs px-3 py-2");
    expect(cajaDe(roto, 320).fuente).toBe(12);
    expect(cajaDe(roto, 320).fuente).toBeLessThan(16);
  });

  it("`max-sm:min-h-11` no toca el escritorio: la variante se apaga a 640", () => {
    // Abajo de `sm`: `text-sm` + `min-h-11` → 44. Desde `sm`: `text-base` entra
    // (16 px de fuente, 24 de interlineado) y el `min-h` desaparece, así que
    // el alto vuelve a ser el de la caja: 24 + 16 de padding = 40. Ese 40 es el
    // número que NO tiene que cambiar la densidad de escritorio.
    const clase = "py-2 text-sm max-sm:min-h-11 sm:text-base";
    expect(altoDe(clase, 320)).toBe(44);
    expect(altoDe(clase, 1024)).toBe(40);
    expect(cajaDe(clase, 320).fuente).toBe(14);
    expect(cajaDe(clase, 1024).fuente).toBe(16);
  });

  it("`min-h-11` sin `max-sm:` sí cambia el escritorio, y por eso no alcanza", () => {
    expect(altoDe("py-2 text-sm min-h-11", 1024)).toBe(44);
    expect(altoDe("py-2 text-sm min-h-11", 1024)).not.toBe(38);
  });

  it("un pseudo-elemento que se sale DE VERDAD suma hit; uno decorativo, no", () => {
    // El número de la primera fila es el MEDIDO en Chromium con `-inset-1`: 22,
    // no 24, porque el pseudo se apoya en la caja de relleno (16 − 2 del
    // borde). Por eso el token lleva `-inset-1.5` y esta guarda exige 24, no 22.
    expect(hitAreaDe("h-4 w-4 border after:-inset-1", 1024)).toEqual({ ancho: 22, alto: 22 });
    expect(hitAreaDe("h-4 w-4 border after:-inset-1.5", 1024)).toEqual({ ancho: 26, alto: 26 });
    expect(hitAreaDe("h-4 w-4 after:absolute", 1024)).toEqual({ ancho: 16, alto: 16 });
    expect(hitAreaDe("h-4 w-4 before:-inset-1", 1024)).toEqual({ ancho: 16, alto: 16 });
  });

  it("el checkbox de ANTES no pasa la guarda de hit area", () => {
    expect(hitAreaDe(ANTES_CHECKBOX, 1024)).toEqual({ ancho: 16, alto: 16 });
    expect(hitAreaDe(ANTES_CHECKBOX, 1024).alto).toBeLessThan(24);
  });

  it("`twMerge` conserva las dos mitades de un token con variante", () => {
    // El token de `inputClass` se escribe en UNA llamada a `cn`, o sea pasa por
    // `twMerge` como todo lo demás: si `sm:text-sm` no sobreviviera, el
    // escritorio quedaría en 16 px y la densidad del escritorio se iría sin
    // que ninguna guarda lo viera.
    const token = "text-base sm:text-sm px-3 py-2";
    expect(twMerge(token)).toBe(token);
    expect(twMerge(token).split(" ")).toEqual(["text-base", "sm:text-sm", "px-3", "py-2"]);
  });
});

/* ==========================================================================
   Lo que este archivo NO puede afirmar, dicho de antemano.
   ========================================================================== */

describe("alcance declarado", () => {
  it("el piso duro de 24 px de la casilla es el del estándar, no el de WCAG medido acá", () => {
    // No hay navegador en este entorno (`environment: "node"`). El HIT AREA
    // real de la casilla —que incluye lo que el navegador cuenta como área
    // táctil del `::after`— se midió aparte en Chromium; acá se afirma el
    // MECANISMO (caja 16 + inset 4 = 24), no el resultado del motor.
    expect(cajaDe(ANTES_CHECKBOX, 1024).hitInset).toBe(0);
  });

  it("el tamaño de la etiqueta no participa del alto del control", () => {
    // `labelClass` es texto que envuelve al control: no aporta alto al campo.
    // Se deja escrita para que nadie la cuente como parte del piso.
    expect(labelClass).toContain("text-sm");
    expect(cajaDe(labelClass, 320).paddingY).toBe(0);
  });

  it("el ancho del botón de icono no se afirma: se afirma el hit area", () => {
    // El ancho de un botón de icono lo fija `w-*`, no el texto: por eso la
    // cuenta del hit area lee la caja y no estima la etiqueta.
    const hit = hitAreaDe(buttonVariants({ size: "icon" }), 320);
    expect(hit.ancho).toBe(hit.alto);
  });
});