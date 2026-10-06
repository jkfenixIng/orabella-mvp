import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Combobox from "@/src/components/ui/lib/combobox";

/* --------------------------------------------------------------------------
   R37 — el `Combobox` se recorta dentro de los diálogos y nunca voltea.

   MEDIDO antes del arreglo (Chromium real, 320x568, diálogo de emisión): el
   borde inferior de la lista quedaba **98 px por debajo** de la caja del
   diálogo que lo recorta, `flippedUp=false`, y las opciones de abajo sólo se
   alcanzaban después de scrollear el DIÁLOGO — porque la propia lista le
   agrega ese rango al scroll. No era inalcanzable: era incómodo. Y el `Select`
   hermano, en el mismo diálogo, sí portalea (`inDialogDom false`): la
   inconsistencia es real y tiene un mecanismo ya escrito en el repo.

   La causa es una sola: `combobox.tsx` montaba la lista `absolute` DENTRO del
   diálogo, con `max-h-[240px]` fijo, sin portal y sin mirar la colisión. Un
   `absolute` dentro de una caja con `overflow` no puede escapar de la caja:
   aunque el `z-index` suba, lo que lo recorta es el ancestro con scroll, no el
   apilamiento.

   El arreglo usa el mecanismo que YA existe en el repo —`Select`:
   `createPortal` + `usePopoverLayer()`— y la cuenta de arriba/abajo se saca de
   una función pura exportada, que es lo que se puede afirmar sin navegador.
   ========================================================================== */

const APP_ROOT = process.cwd();
const COMBOBOX_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "combobox.tsx");
const SELECT_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "select.tsx");
const COMBOBOX = readFileSync(COMBOBOX_PATH, "utf8");

/** Código sin comentarios: un `createPortal` narrado al explicar no está montado. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const COMBOBOX_CODE = stripComments(COMBOBOX);

/* El contrato de la colocación. Se declara acá, no importado, para que la
   guarda pueda FALLAR cuando la función no existe en vez de romper la carga del
   archivo entero: el RED tiene que señalar el defecto, no un error de módulo. */
type PlacementInput = {
  trigger: { top: number; left: number; width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
  maxHeight?: number;
};
type Placement = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  flippedUp: boolean;
};

const placementDe = (
  Combobox as unknown as {
    computeComboboxPlacement?: (input: PlacementInput) => Placement;
  }
).computeComboboxPlacement;

function colocar(input: PlacementInput): Placement {
  if (typeof placementDe !== "function") {
    throw new Error(
      "`combobox.tsx` no exporta `computeComboboxPlacement(input)`: la lista no tiene dónde caerse",
    );
  }
  return placementDe(input);
}

/** ¿La lista cabe entera en la pantalla, sin salirse ni tapar el disparador? */
function cabeEnPantalla(p: Placement, input: PlacementInput): boolean {
  const limite = input.viewport.height - 4;
  if (p.top < 0 || p.top + p.maxHeight > limite) return false;
  const gap = input.gap ?? 4;
  if (p.flippedUp) return p.top + p.maxHeight <= input.trigger.top - gap + 0.001;
  return p.top >= input.trigger.top + input.trigger.height + gap - 0.001;
}

describe("R37: la lista del combobox se coloca donde hay lugar y se porta al body", () => {
  it("la lista se monta en un portal, como el `Select` hermano", () => {
    // MEDIDO antes: `inDialogDom true` en el combobox y `false` en el `Select`
    // del mismo diálogo. El recorte venía de la caja con scroll del diálogo,
    // no del z-index, así que sin portal no hay arreglo posible.
    expect(COMBOBOX_CODE).toMatch(/createPortal/);
    expect(COMBOBOX_CODE).toMatch(/from\s*["']react-dom["']/);
    // Y la lista, no el disparador: el disparador tiene que quedarse en el
    // formulario, que es lo que lo hace flakey con un portal.
    const portal = COMBOBOX_CODE.indexOf("createPortal(");
    const listbox = COMBOBOX_CODE.indexOf('role="listbox"');
    expect(portal, "el `createPortal` envuelve al listbox").toBeGreaterThan(-1);
    expect(listbox, "la lista declara `role=\"listbox\"`").toBeGreaterThan(-1);
    expect(portal, "el portal se abre antes de la lista").toBeLessThan(listbox);
  });

  it("usa el MISMO apilamiento del diálogo, no un `z-50` fijo", () => {
    // El precedente del repo es `select.tsx:81-89`: `usePopoverLayer()` del
    // diálogo, que sube el popover por encima del contenido del diálogo abierto
    // y lo deja por debajo del overlay del siguiente
    // (`tests/dialog-layer.test.ts`). Un `z-50` escrito a mano es exactamente
    // lo que esa primitiva existe para reemplazar.
    expect(COMBOBOX_CODE).toMatch(/usePopoverLayer/);
    expect(COMBOBOX_CODE).toMatch(/from\s*["']\.\/dialog["']/);
    expect(COMBOBOX_CODE).toMatch(/zIndex:\s*popoverZ/);
    expect(stripComments(readFileSync(SELECT_PATH, "utf8"))).toMatch(/usePopoverLayer/);
  });

  it("la posición de la lista la calcula la función, no un `absolute` pegado al disparador", () => {
    // El estado previo: `absolute inset-x-0 top-full z-50 mt-1` con
    // `max-h-[240px]`. Un `absolute` dentro de la caja del diálogo no puede
    // escapar de ella; y un alto fijo no puede saber cuánto hay.
    expect(COMBOBOX_CODE).not.toContain("inset-x-0 top-full");
    expect(COMBOBOX_CODE).not.toContain("max-h-[240px]");
    // `fixed` (no `absolute`): es lo que saca la lista del flujo de la caja con
    // scroll. Y las coordenadas vienen de la cuenta, no de un borde de la caja.
    expect(COMBOBOX_CODE).not.toMatch(/\babsolute\b/);
    expect(COMBOBOX_CODE).toMatch(/className="fixed\b/);
    expect(COMBOBOX_CODE).toMatch(
      /style=\{\{[\s\S]*?top:\s*placement\.top[\s\S]*?left:\s*placement\.left[\s\S]*?width:\s*placement\.width[\s\S]*?maxHeight:\s*placement\.maxHeight[\s\S]*?zIndex:\s*popoverZ/,
    );
    expect(COMBOBOX_CODE).toMatch(/computeComboboxPlacement\(/);
  });

  it("la lista portalada vuelve a ser clicable dentro de un diálogo", () => {
    // MEDIDO en Chromium, y esto NO lo habría visto ninguna guarda de fuente:
    // al abrir un diálogo Radix le pone `pointer-events: none` al `body` para
    // bloquear el scroll de fondo. La lista, que antes vivía DENTRO del
    // diálogo, no lo heredaba; being hija directa del `body` sí. Resultado: la
    // lista se veía perfecta pero `elementFromPoint` en una opción devolvía el
    // diálogo y el clic no seleccionaba nada. Es el mismo
    // `pointerEvents: 'auto'` que escribe el `Content` del `Select` de Radix.
    expect(COMBOBOX_CODE).toMatch(/pointerEvents:\s*["']auto["']/);
  });

  it("se reposiciona cuando la página se mueve, en vez de quedar despegada", () => {
    // Un `fixed` calculado una sola vez se queda clavado en el sitio viejo en
    // cuanto scrollea el diálogo: el arreglo de R37 no puede ser «quitar el
    // recorte» y dejar el control flotando.
    expect(COMBOBOX_CODE).toMatch(/addEventListener\(\s*["']scroll["']/);
    expect(COMBOBOX_CODE).toMatch(/addEventListener\(\s*["']resize["']/);
  });

  it("el clic afuera sigue cerrando, y el de la lista ya no lo cuenta como afuera", () => {
    // El `pointerdown` que cierra mira si el destino está DENTRO del
    // contenedor. Con la lista en el portal deja de estarlo, así que el
    // guardián tiene que mirar también el nodo de la lista: sin esto, elegir
    // una opción la cerraría antes del `click` y no seleccionaría nada.
    const handler = COMBOBOX_CODE.match(/function onPointerDown[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(handler, "el guardián de clic afuera existe").not.toBe("");
    expect(handler, "mira el contenedor del disparador").toMatch(/containerRef\.current/);
    expect(handler, "mira la lista portaleada").toMatch(/listRef\.current/);
    // Y el nodo que mira es el que está en el portal, no otro `div`.
    const portal = COMBOBOX_CODE.slice(COMBOBOX_CODE.indexOf("createPortal("));
    expect(portal.slice(0, portal.indexOf("document.body"))).toMatch(/ref=\{listRef\}/);
  });
});

describe("R37: la colocación se calcula como la calcula el navegador", () => {
  it("el caso MEDIDO a 320: la lista se da vuelta y no se sale", () => {
    // 320x568, disparador pegado al pliegue dentro del diálogo de emisión.
    const input: PlacementInput = {
      trigger: { top: 500, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    const p = colocar(input);
    expect(p.flippedUp, "con 24 px abajo y 496 arriba, tiene que voltear").toBe(true);
    expect(cabeEnPantalla(p, input), "la lista no se sale de la pantalla").toBe(true);
    expect(p.maxHeight, "el alto lo limita el espacio real, no una constante").toBeLessThanOrEqual(240);
  });

  it("con espacio de sobra abajo NO voltea: la lista se abre hacia abajo", () => {
    // El otro extremo: voltear siempre sería un defecto propio, tan visible
    // como el que se arregla.
    const input: PlacementInput = {
      trigger: { top: 100, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    const p = colocar(input);
    expect(p.flippedUp).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(input.trigger.top + input.trigger.height);
    expect(cabeEnPantalla(p, input)).toBe(true);
  });

  it("con poco lugar en los dos lados, el alto es el que hay y nunca negativo", () => {
    const input: PlacementInput = {
      trigger: { top: 300, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    const p = colocar(input);
    expect(p.maxHeight).toBeGreaterThan(0);
    expect(p.maxHeight).toBeLessThanOrEqual(240);
    expect(cabeEnPantalla(p, input)).toBe(true);
  });

  it("el ancho es el del disparador y queda dentro de la pantalla", () => {
    const angosto: PlacementInput = {
      trigger: { top: 60, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    expect(colocar(angosto).width).toBe(288);

    // Un disparador que se sale por la derecha (carril con scroll) no puede
    // empujar la lista fuera de la pantalla.
    const alBorde: PlacementInput = {
      trigger: { top: 60, left: 280, width: 120, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    const p = colocar(alBorde);
    expect(p.left + p.width).toBeLessThanOrEqual(320);
    expect(cabeEnPantalla(p, alBorde)).toBe(true);
  });

  it("el alto que recibe la cuenta es el MEDIDO del disparador, no una constante", () => {
    // El piso táctil sube el disparador de 40 a 44 px POR DEBAJO de `sm`, y la
    // cuenta de la colocación se alimenta con `rect.height`: por eso el caso
    // medido a 320 se vuelve a afirmar con 44 sin tocar
    // `computeComboboxPlacement`. Si algún día la lista usara un alto fijo de
    // 40, esta guarda se caería.
    expect(COMBOBOX_CODE).toMatch(/height:\s*rect\.height/);

    // El caso MEDIDO a 320, con el disparador ya arreglado: sigue volteando y
    // sigue cabiendo, con 4 px menos de espacio real.
    const medido: PlacementInput = {
      trigger: { top: 500, left: 16, width: 288, height: 44 },
      viewport: { width: 320, height: 568 },
    };
    const con44 = colocar(medido);
    expect(con44.flippedUp, "con 20 px abajo y 496 arriba, también voltea").toBe(true);
    expect(cabeEnPantalla(con44, medido), "y la lista no se sale de la pantalla").toBe(true);
    expect(con44.maxHeight, "el alto lo limita el espacio real, no una constante").toBe(240);

    // Y cuando el disparador es más alto, la cuenta se mueve con él: 4 px más
    // abajo, el mismo alto (el tope de 240 manda igual) y sigue cabiendo.
    const holgado: PlacementInput = {
      trigger: { top: 100, left: 16, width: 288, height: 44 },
      viewport: { width: 320, height: 568 },
    };
    const a40 = colocar({ ...holgado, trigger: { ...holgado.trigger, height: 40 } });
    const a44 = colocar(holgado);
    expect(a40.flippedUp, "con lugar de sobra no voltea").toBe(false);
    expect(a44.flippedUp).toBe(false);
    expect(a44.top, "la lista abre 4 px más abajo").toBe(a40.top + 4);
    expect(a44.maxHeight, "y el tope de 240 px manda igual").toBe(a40.maxHeight);
    expect(cabeEnPantalla(a44, holgado)).toBe(true);
  });

  it("el hueco con el disparador se respeta en las dos direcciones", () => {
    const input: PlacementInput = {
      trigger: { top: 500, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    };
    const p = colocar(input);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(input.trigger.top);
  });

  it("el tope de 240 px se respeta en un viewport alto: la lista no se estira", () => {
    const input: PlacementInput = {
      trigger: { top: 100, left: 16, width: 288, height: 40 },
      viewport: { width: 1440, height: 2000 },
    };
    expect(colocar(input).maxHeight).toBe(240);
  });

  it("devuelve exactamente las cinco propiedades del contrato", () => {
    const p = colocar({
      trigger: { top: 100, left: 16, width: 288, height: 40 },
      viewport: { width: 320, height: 568 },
    });
    expect(Object.keys(p).sort()).toEqual([
      "flippedUp",
      "left",
      "maxHeight",
      "top",
      "width",
    ]);
  });
});

describe("control negativo: la colocación de ANTES no pasa ninguna de estas cuentas", () => {
  /** Lo que hacía el `absolute inset-x-0 top-full` con `max-h-[240px]`. */
  function antes(input: PlacementInput): Placement {
    const gap = input.gap ?? 4;
    return {
      top: input.trigger.top + input.trigger.height + gap,
      left: input.trigger.left,
      width: input.trigger.width,
      maxHeight: 240,
      flippedUp: false,
    };
  }

  const casoMedido: PlacementInput = {
    trigger: { top: 500, left: 16, width: 288, height: 40 },
    viewport: { width: 320, height: 568 },
  };

  it("la de antes se sale de la pantalla: 98 px medidos son 584 − 486", () => {
    const p = antes(casoMedido);
    expect(p.flippedUp).toBe(false);
    // 500 + 40 + 4 = 544 de tope, + 240 de alto = 784 contra 568 de pantalla.
    expect(p.top + p.maxHeight).toBe(784);
    expect(p.top + p.maxHeight).toBeGreaterThan(casoMedido.viewport.height);
    expect(cabeEnPantalla(p, casoMedido)).toBe(false);
  });

  it("y con el mismo disparador, la de ahora sí cabe", () => {
    expect(cabeEnPantalla(colocar(casoMedido), casoMedido)).toBe(true);
  });

  it("una función que nunca voltea es un defecto, no una solución", () => {
    // Si `flippedUp` fuera siempre `false`, las tres cuentas de arriba pasarían
    // en un viewport alto y el defecto volvería en un teléfono. Se comprueba
    // con el caso en el que voltear es obligatorio.
    expect(antes(casoMedido).flippedUp).toBe(false);
    expect(colocar(casoMedido).flippedUp).toBe(true);
  });
});