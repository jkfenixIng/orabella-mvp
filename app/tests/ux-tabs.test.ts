import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  resolveTabNavigation,
  tabPanelId,
  tabTriggerId,
} from "@/src/components/ui/lib/tabs";

/* --------------------------------------------------------------------------
   Contrato de `Tabs` (U-tabs).

   El defecto que esta guarda cierra: `app/admin/admin-tabs.tsx:57-65` declaraba
   `role="tablist"` + `role="tab"` + `aria-selected` sin `role="tabpanel"`, sin
   `aria-controls`, sin `tabIndex` rotativo y sin flechas. Un rol a medias es
   peor que ninguno: promete un contrato que no cumple.

   Método: no hay DOM ni render en este setup (`environment: "node"`). Lo que se
   afirma es de dos clases:
     1. lo que se puede ejecutar de verdad — las funciones puras exportadas
        (`resolveTabNavigation`, los ids cruzados) y la existencia de los cuatro
        componentes;
     2. lo que solo se puede leer del fuente — los atributos ARIA, las teclas y
        el vocabulario de clases, con el archivo real leído por `node:fs`.

   Conteo por TOKEN DE CLASE COMPLETO, nunca por substring: este repositorio se
   quemó dos veces con greps de substring (`text-text-primary` TERMINA en
   `text-primary`; `border-border` MATCHEA `border-border-color`). El control
   negativo de esa trampa está más abajo, explícito.

   Este archivo NO afirma nada sobre `admin-tabs.tsx`: esa migración es otra
   unidad.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const TABS_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "tabs.tsx");
const SOURCE = readFileSync(TABS_PATH, "utf8");

/** Código sin comentarios: una clase nombrada al EXPLICAR algo no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/* --------------------------------------------------------------------------
   Atributos: el contrato ARIA completo, no la mitad.
   -------------------------------------------------------------------------- */

const ARIA_CONTRACTS = [
  'role="tablist"',
  'role="tab"',
  'role="tabpanel"',
  "aria-selected",
  "aria-controls",
  "aria-labelledby",
  "tabIndex",
] as const;

/**
 * El predicado que usa la guarda. Devuelve los contratos que FALTAN: la forma
 * importa porque así el control negativo del final puede comprobar que detecta
 * una ausencia real y no una lista vacía de un sello de goma.
 */
function missingAriaContracts(source: string): string[] {
  const clean = stripComments(source);
  return ARIA_CONTRACTS.filter((contract) => !clean.includes(contract));
}

const NAVIGATION_KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"] as const;

/** Teclas de navegación ausentes del fuente (como literal entre comillas). */
function missingNavigationKeys(source: string): string[] {
  const clean = stripComments(source);
  return NAVIGATION_KEYS.filter((key) => !clean.includes(`'${key}'`));
}

/* --------------------------------------------------------------------------
   Vocabulario de clases.

   La primitiva declara TODO su vocabulario visual en constantes `*_CLASS` de una
   sola línea. Congelar el mapa entero —y no unas clases sueltas— es lo que hace
   que un restyle silencioso falle: agregar, quitar, reordenar o renombrar una
   clase, o cambiar un token por otro, rompe acá. Y como el mapa se afirma
   completo, el vocabulario queda CERRADO: no puede entrar un color que no esté
   en la lista.
   -------------------------------------------------------------------------- */

/** Constantes `NOMBRE_CLASS = 'clases'` del fuente, por nombre. */
function declaredClasses(source: string): Record<string, string> {
  const pattern = /const\s+([A-Z][A-Z0-9_]*_CLASS)\s*=\s*\n?\s*'([^']*)'/g;
  const declared: Record<string, string> = {};
  for (const match of stripComments(source).matchAll(pattern)) {
    declared[match[1]] = match[2];
  }
  return declared;
}

/** Tokens de clase completos, con su variante (`dark:bg-surface`). */
function tokensOf(classes: string): string[] {
  return classes.trim().split(/\s+/);
}

/** Todos los tokens del vocabulario declarado, en orden de aparición. */
function declaredClassTokens(source: string): string[] {
  return Object.values(declaredClasses(source)).flatMap(tokensOf);
}

/** Cuántas veces aparece cada token completo del vocabulario declarado. */
function classTokenCounts(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of declaredClassTokens(source)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

const EXPECTED_CLASSES: Record<string, string> = {
  TABS_ROOT_CLASS: "flex flex-col",
  TABS_LIST_CLASS:
    "inline-flex flex-wrap items-center gap-1 rounded-lg border border-border-color bg-surface p-1 dark:border-border-color-2",
  TABS_TRIGGER_CLASS:
    "inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  TABS_TRIGGER_ACTIVE_CLASS: "bg-surface-selected text-text-primary font-medium shadow-sm",
  TABS_TRIGGER_INACTIVE_CLASS: "text-text-secondary hover:bg-surface-hover",
};

/**
 * Tokens de color del proyecto, con su conteo exacto. Los nombres se afirman
 * ENTEROS: `bg-surface` y `bg-surface-selected` son tokens distintos y
 * `hover:bg-surface-hover` conserva su variante, que es parte del contrato.
 */
const EXPECTED_COLOR_TOKEN_COUNTS: Record<string, number> = {
  "bg-surface": 1,
  "border-border-color": 1,
  "dark:border-border-color-2": 1,
  "bg-surface-selected": 1,
  "text-text-primary": 1,
  "text-text-secondary": 1,
  "hover:bg-surface-hover": 1,
  "focus-visible:ring-ring": 1,
};

/* --------------------------------------------------------------------------
   Controles negativos (fuentes de muestra que NO pasan).
   -------------------------------------------------------------------------- */

/** Cumple los seis contratos ARIA menos uno: le falta el panel. */
const SAMPLE_WITHOUT_PANEL = `
export function Sample() {
  return (
    <div role="tablist" aria-label="x">
      <button type="button" role="tab" aria-selected aria-controls="p" tabIndex={0} />
      <div aria-labelledby="t" />
    </div>
  );
}
`;

/** Maneja una sola de las cuatro teclas de navegación. */
const SAMPLE_WITH_ONE_KEY = `
function handleKeyDown(name) {
  if (name === 'ArrowRight') return 1;
  return null;
}
`;

describe("Tabs: la primitiva existe y exporta el juego completo", () => {
  it("exporta los cuatro componentes", () => {
    expect(typeof Tabs).toBe("function");
    expect(typeof TabsList).toBe("function");
    expect(typeof TabsTrigger).toBe("function");
    expect(typeof TabsPanel).toBe("function");
  });
});

describe("Tabs: contrato ARIA declarado en el fuente", () => {
  it("declara los siete contratos (incluido el panel, que era la mitad que faltaba)", () => {
    expect(missingAriaContracts(SOURCE)).toEqual([]);
  });

  it("el `tablist` lleva nombre accesible y orientación", () => {
    const clean = stripComments(SOURCE);
    expect(clean).toContain("aria-label={label}");
    expect(clean).toContain('aria-orientation="horizontal"');
  });

  it("el tabIndex es rotativo y es el único tab stop del fuente", () => {
    const clean = stripComments(SOURCE);
    expect(clean).toContain("tabIndex={isActive ? 0 : -1}");
    // Si aparece otro `tabIndex=`, el juego dejó de tener un solo punto de
    // tabulación: se cuenta el atributo entero, no el nombre suelto.
    expect(clean.match(/tabIndex=/g) ?? []).toHaveLength(1);
  });

  it("pestaña y panel se resuelven mutuamente por id, no por HTML a mano", () => {
    const clean = stripComments(SOURCE);
    expect(clean).toContain("id={tabTriggerId(baseId, value)}");
    expect(clean).toContain("aria-controls={tabPanelId(baseId, value)}");
    expect(clean).toContain("id={tabPanelId(baseId, value)}");
    expect(clean).toContain("aria-labelledby={tabTriggerId(baseId, value)}");
  });

  it("el panel inactivo no se renderiza", () => {
    expect(stripComments(SOURCE)).toContain("if (activeValue !== value) return null");
  });
});

describe("Tabs: navegación por teclado", () => {
  it("las cuatro teclas del patrón están manejadas", () => {
    expect(missingNavigationKeys(SOURCE)).toEqual([]);
  });

  it("ArrowRight avanza y envuelve en el final", () => {
    expect(resolveTabNavigation("ArrowRight", 0, 3)).toBe(1);
    expect(resolveTabNavigation("ArrowRight", 2, 3)).toBe(0);
  });

  it("ArrowLeft retrocede y envuelve en el principio", () => {
    expect(resolveTabNavigation("ArrowLeft", 2, 3)).toBe(1);
    expect(resolveTabNavigation("ArrowLeft", 0, 3)).toBe(2);
  });

  it("Home va al primero y End al último, con seis pestañas", () => {
    expect(resolveTabNavigation("Home", 4, 6)).toBe(0);
    expect(resolveTabNavigation("End", 0, 6)).toBe(5);
  });

  it("un tablist de una sola pestaña no mueve el foco a ningún lado", () => {
    expect(resolveTabNavigation("ArrowRight", 0, 1)).toBe(0);
    expect(resolveTabNavigation("ArrowLeft", 0, 1)).toBe(0);
  });

  it("un tablist vacío no navega", () => {
    expect(resolveTabNavigation("ArrowRight", 0, 0)).toBeNull();
    expect(resolveTabNavigation("Home", 0, 0)).toBeNull();
  });

  it("otra tecla no navega: `null`, así el manejador no corta su comportamiento", () => {
    // `Tab` es el caso que importa: interceptarlo encerraría el foco en el
    // tablist. `ArrowDown`/`ArrowUp` pertenecen al patrón VERTICAL, no a este.
    for (const key of [
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Tab",
      "Escape",
      "a",
      " ",
      "Homex",
      "ArrowRightx",
    ]) {
      expect(resolveTabNavigation(key, 1, 3), `tecla ${JSON.stringify(key)}`).toBeNull();
    }
  });

  it("el foco y la activación salen del mismo gesto: el manejador enfoca y activa", () => {
    const clean = stripComments(SOURCE);
    expect(clean).toContain("target.focus()");
    expect(clean).toContain("target.click()");
  });
});

describe("Tabs: ids cruzados de pestaña y panel", () => {
  it("derivan el uno del otro con la misma base", () => {
    expect(tabTriggerId("tabs-base", "empleados")).toBe("tabs-base-tab-empleados");
    expect(tabPanelId("tabs-base", "empleados")).toBe("tabs-base-panel-empleados");
    expect(tabTriggerId("tabs-base", "empleados")).not.toBe(
      tabPanelId("tabs-base", "empleados"),
    );
  });

  it("no se cruzan entre pestañas distintas", () => {
    const ids = ["empleados", "roles", "caja"].flatMap((value) => [
      tabTriggerId("b", value),
      tabPanelId("b", value),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Tabs: vocabulario de clases congelado", () => {
  it("el mapa completo de clases es exactamente el esperado", () => {
    expect(declaredClasses(SOURCE)).toEqual(EXPECTED_CLASSES);
  });

  it("cada token de color aparece la cantidad exacta de veces esperada", () => {
    const counts = classTokenCounts(SOURCE);
    for (const [token, expected] of Object.entries(EXPECTED_COLOR_TOKEN_COUNTS)) {
      expect(counts.get(token) ?? 0, token).toBe(expected);
    }
  });

  it("el conteo es por token completo y no por substring", () => {
    const counts = classTokenCounts(SOURCE);
    // Los dos casos que ya quemaron al repositorio: si esto midiera substrings,
    // `text-primary` daría 1 (por `text-text-primary`) y `border-border` daría 1
    // (por `border-border-color-2`), o sea la guarda afirmaría algo falso.
    expect(counts.get("text-primary") ?? 0).toBe(0);
    expect(counts.get("border-border") ?? 0).toBe(0);
    expect(counts.get("bg-surface-hover") ?? 0).toBe(0);
    expect(counts.get("bg-surface")).toBe(1);
    expect(counts.get("text-text-primary")).toBe(1);
    expect(counts.get("border-border-color")).toBe(1);
  });

  it("el trigger lleva el objetivo táctil de 44 px y el resto no lo arrastra", () => {
    const classes = declaredClasses(SOURCE);
    expect(tokensOf(classes.TABS_TRIGGER_CLASS)).toContain("min-h-11");
    for (const name of [
      "TABS_ROOT_CLASS",
      "TABS_LIST_CLASS",
      "TABS_TRIGGER_ACTIVE_CLASS",
      "TABS_TRIGGER_INACTIVE_CLASS",
    ]) {
      expect(tokensOf(classes[name]), name).not.toContain("min-h-11");
    }
  });

  it("el foco visible del trigger usa el anillo del sistema, en 2 px", () => {
    const trigger = tokensOf(declaredClasses(SOURCE).TABS_TRIGGER_CLASS);
    expect(trigger).toContain("focus-visible:ring-2");
    expect(trigger).toContain("focus-visible:ring-ring");
  });

  it("el segmento activo usa el token de superficie seleccionada", () => {
    const active = tokensOf(declaredClasses(SOURCE).TABS_TRIGGER_ACTIVE_CLASS);
    expect(active).toContain("bg-surface-selected");
    expect(active).toContain("text-text-primary");
    // `bg-surface-hover` en el activo es la regresión medida: en claro queda a
    // 0.020 de la página y el estado elegido se vuelve indistinguible.
    expect(active).not.toContain("bg-surface-hover");
  });
});

describe("Tabs: los predicados de la guarda no son un sello de goma", () => {
  it("un fuente sin `role=\"tabpanel\"` se reporta como violación", () => {
    expect(missingAriaContracts(SAMPLE_WITHOUT_PANEL)).toEqual(['role="tabpanel"']);
  });

  it("un fuente vacío reporta los siete contratos faltantes", () => {
    expect(missingAriaContracts("")).toEqual([...ARIA_CONTRACTS]);
  });

  it("un fuente con una sola tecla reporta las otras tres", () => {
    expect(missingNavigationKeys(SAMPLE_WITH_ONE_KEY)).toEqual([
      "ArrowLeft",
      "Home",
      "End",
    ]);
  });
});
