import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO `cn` del que `inventory-client.tsx` saca la clase que llega al DOM:
// `twMerge(clsx(...))`. No es una copia de la regla de fusión: es la regla, y
// los tokens que el llamador cite por nombre se resuelven importándolos del
// módulo que los exporta, no transcribiéndolos.
import { cn } from "@/src/components/ui/lib/utils";
import * as uiStyles from "@/src/shared/lib/ui-styles";

/* --------------------------------------------------------------------------
   R19 + R38 en las DOS listas de inventario: la de productos y la del kardex.

   EL DEFECTO, MEDIDO (ver `odd/tasks/auditoria-responsive.md`, R19, R38 y R-b):
   las dos listas eran `<table>` con piso de ancho dentro de un carril de
   `overflow-x-auto` cuyo ancho útil en un teléfono es de ~238 px:

     - productos: `<table className={cn("w-full text-left text-sm",
       "min-w-[760px]")}>` en un carril de 238 px, con las acciones —`Kardex` y
       `Editar`— en la Novena columna;
     - kardex: `<table … "min-w-[520px]">` en un carril de 238 px.

   Con la fila real, la acción de la fila quedaba en la última columna: fuera de
   pantalla en los cuatro anchos angostos, sin `elementFromPoint` que la
   devolviera, y las nueve (o cinco) celdas se leían SIN una sola etiqueta —
   nueve (o cinco) valores sueltos y el «Acciones» del encabezado también
   fuera. La acción es lo que la lista de productos existe para hacer: abrir el
   kardex de una fila.

   LO QUE SE AFIRMA, en los mismos invariantes y por el mismo método de
   `vouchers-row-labels.test.ts` (que es la REFERENCIA: la lista de vales ya lo
   resolvió, y esta no puede inventar un segundo) y de
   `invoice-row-labels.test.ts`:

     1. ABAJO DE `sm`, cada valor apilado lleva su etiqueta visible, y es la
        palabra del encabezado: el vocabulario se escribe una vez.
     2. ARRIBA DE `sm` esas etiquetas no existen —el encabezado ya nombra— y la
        fila sigue siendo la grilla de las NUEVE columnas de productos y de las
        CINCO del kardex, cada una anclada con `sm:col-start-N`, porque el orden
        del DOM es el de la tarjeta móvil.
     3. NADA de lo que decide una fila depende de un gesto horizontal: no hay
        carril de scroll ni piso de ancho inventado en el módulo, y la acción
        vive en su campo envuelto.
     4. La VISIBILIDAD se afirma sobre la clase EFECTIVA —la que sale de `cn`—
        y sobre la cascada a ese ancho, no sobre el token: por eso `hidden`,
        `hidden sm:hidden`, `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden`
        y `sm:block` se acusan uno por uno. `hidden sm:hidden` SOBREVIVE a
        `twMerge`, así que una cuenta por token lo deja pasar.

   LO QUE ESTA GUARDA NO PUEDE VER, DICHO DE ANTEMANO: acá no hay navegador. Se
   afirma lo que el marcado PIDE. No ve un `style` en línea, ni una regla de
   `globals.css`, ni un `hidden` heredado de un ancestro, ni una variante que
   dependa del estado y no del ancho (`hover:`, `dark:`, `group-hover:`), que se
   tratan como inactivas. Lo que se midió en navegador —scroll lateral cero,
   rótulos visibles y la acción respondiendo a `elementFromPoint`— está en el
   informe de la unidad, con lo que esa medición pudo y no pudo cubrir.
   -------------------------------------------------------------------------- */

const CLIENT_PATH = join(process.cwd(), "app", "inventory", "inventory-client.tsx");
const CLIENT = readFileSync(CLIENT_PATH, "utf8");

/** La escala de las nueve columnas de productos, en orden de columna. */
const PRODUCTOS_ESCALA =
  "grid-cols-[minmax(0,0.85fr)_minmax(0,1.3fr)_minmax(0,0.35fr)_minmax(0,0.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,0.85fr)_minmax(5.75rem,1.2fr)]";

/** La escala de las cinco columnas del kardex, en orden de columna. */
const KARDEX_ESCALA =
  "grid-cols-[minmax(8.5rem,1.3fr)_minmax(0,0.6fr)_minmax(0,0.5fr)_minmax(0,1.5fr)_minmax(0,0.9fr)]";

/* --------------------------------------------------------------------------
   Los anclajes: las DOS listas del archivo, en orden de aparición.
   -------------------------------------------------------------------------- */

/** El `<ul>` de cada lista: termina el bloque del encabezado. */
const LIST_ANCHOR = '<ul className="flex flex-col divide-y';

/** El contenedor de cada lista (el que hoy es el carril `overflow-x-auto`). */
const CONTAINER_ANCHOR = '<div className="mt-3';

/** La fila de cada lista: su `<li key={row.id}`. */
const FILA_ANCHOR = /<li\s+key=\{row\.id\}/g;

/** Una etiqueta por palabra: el ancla de los controles negativos. */
interface Ancla {
  /** La palabra del rótulo, con su punto y su espacio: `Nombre: `. */
  etiqueta: string;
  /** La expresión de valor que va justo después del rótulo, en el fuente. */
  valor: string;
}

interface Lista {
  nombre: string;
  escala: string;
  /** Las palabras del encabezado, en orden de COLUMNA. */
  palabras: string[];
  /**
   * La columna que declara cada hoja, en orden del DOM (o sea, el orden en que
   * se lee la tarjeta móvil). Congela que la tarjeta se lea en el orden
   * aprobado y no en el de la grilla.
   */
  orden: number[];
  ancla: Ancla;
  /** La acción de la fila: `undefined` en el kardex, que no tiene acciones. */
  acciones?: string[];
}

const LISTAS: Lista[] = [
  {
    nombre: "productos",
    escala: PRODUCTOS_ESCALA,
    palabras: ["SKU", "Nombre", "Stock", "Mínimo", "Costo", "Venta", "Comisión", "Estado", "Acciones"],
    // Nombre+SKU · Stock+Mínimo · Venta+Costo · Comisión+Estado · Acciones.
    orden: [2, 1, 3, 4, 6, 5, 7, 8, 9],
    ancla: { etiqueta: "Nombre: ", valor: "{row.name}" },
    acciones: ["Kardex", "Editar"],
  },
  {
    nombre: "kardex",
    escala: KARDEX_ESCALA,
    palabras: ["Fecha", "Tipo", "Cantidad", "Motivo", "Quién"],
    // Fecha · Tipo+Cantidad · Quién · Motivo.
    orden: [1, 2, 3, 5, 4],
    ancla: { etiqueta: "Fecha: ", valor: '{new Date(row.created_at).toLocaleString("es-CO")}' },
  },
];

/* --------------------------------------------------------------------------
   Las regiones que se leen del archivo real (o de una copia mutada EN MEMORIA).
   -------------------------------------------------------------------------- */

/** Los índices de `<ul className="flex flex-col divide-y` en el fuente. */
function indicesDeListas(source: string): number[] {
  const found: number[] = [];
  let at = source.indexOf(LIST_ANCHOR);
  while (at >= 0) {
    found.push(at);
    at = source.indexOf(LIST_ANCHOR, at + LIST_ANCHOR.length);
  }
  return found;
}

/** La fila n-ésima (0 = la primera lista). */
function filaN(source: string, n: number): string {
  FILA_ANCHOR.lastIndex = 0;
  let start = -1;
  for (let i = 0; i <= n; i += 1) {
    const match = FILA_ANCHOR.exec(source);
    if (match === null) return "";
    start = match.index;
  }
  const end = source.indexOf("</li>", start);
  return end > start ? source.slice(start, end) : "";
}

/** El contenedor de la lista que abre en `indiceUl`. */
function contenedorDe(source: string, indiceUl: number): number {
  return source.lastIndexOf(CONTAINER_ANCHOR, indiceUl);
}

/** La lista completa: su contenedor, su encabezado y su `<ul>` entero. */
function listaN(source: string, n: number): string {
  const indices = indicesDeListas(source);
  const indiceUl = indices[n];
  if (indiceUl === undefined) return "";
  const inicio = contenedorDe(source, indiceUl);
  const fin = source.indexOf("</ul>", indiceUl);
  return inicio >= 0 && fin > inicio ? source.slice(inicio, fin + "</ul>".length) : "";
}

/** El bloque del encabezado: el contenedor y el `div` que nombra las columnas. */
function encabezadoN(source: string, n: number): string {
  const indices = indicesDeListas(source);
  const indiceUl = indices[n];
  if (indiceUl === undefined) return "";
  const inicio = contenedorDe(source, indiceUl);
  return inicio >= 0 ? source.slice(inicio, indiceUl) : "";
}

/* --------------------------------------------------------------------------
   Lectores. Tokens de clase completos y `<span>` balanceados: una etiqueta
   dentro de una hoja no es lo mismo que una etiqueta al lado.
   -------------------------------------------------------------------------- */

/**
 * Las expresiones JSX —y con ellas los comentarios `{/* … *\/}`— se vacían
 * ANTES de leer etiquetas: dentro de un `{...}` hay `=>`, `&&` y `<` que no son
 * markup y harían desbalancear el conteo de `<span>`.
 */
function blankExpressions(source: string): string {
  let depth = 0;
  let out = "";
  for (const char of source) {
    if (char === "{") {
      depth += 1;
      out += " ";
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
      out += " ";
    } else {
      out += depth > 0 ? " " : char;
    }
  }
  return out;
}

/** El `</span>` que cierra el `<span>` abierto justo antes de `from`. */
function matchingClose(source: string, from: number): number {
  let depth = 1;
  const tags = /<span\b[^>]*>|<\/span>/g;
  tags.lastIndex = from;
  for (let match = tags.exec(source); match !== null; match = tags.exec(source)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

interface SpanNode {
  /** La clase EFECTIVA, resuelta con el mismo `cn` que usa el componente. */
  className: string;
  /** El contenido con las expresiones JSX vaciadas: para reconocer un rótulo. */
  inner: string;
  /** El MISMO contenido, sin vaciar: para ver lo que hay dentro de un `&&`. */
  rawInner: string;
  /** El índice del `<span>` que lo envuelve, o -1. */
  parent: number;
  /** La región VIVA de la que se leyó, y el rango del contenido en ella. */
  raw: string;
  start: number;
  end: number;
}

/**
 * Todos los `<span>` de la región: su clase efectiva, su contenido y su padre,
 * para que una hoja no se cuente dos veces por vivir dentro de otra.
 */
function allSpans(region: string): SpanNode[] {
  const found: SpanNode[] = [];
  const markup = blankExpressions(region);
  const stack: number[] = [];
  for (const match of markup.matchAll(/<span\b([^>]*)>|<\/span>/g)) {
    if (match[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const open = match.index + match[0].length;
    const close = matchingClose(markup, open);
    if (close === -1) continue;
    found.push({
      className: resolverClase(region.slice(match.index + "<span".length, open)),
      inner: markup.slice(open, close),
      rawInner: region.slice(open, close),
      parent: stack.length === 0 ? -1 : stack[stack.length - 1],
      raw: region,
      start: open,
      end: close,
    });
    stack.push(found.length - 1);
  }
  return found;
}

/* --------------------------------------------------------------------------
   LA CLASE EFECTIVA: la que sale de `cn`, con los tokens del llamador
   resueltos importándolos.

   Una hoja escrita `className="a b hidden"` y la misma escrita
   `className={cn("a b", tableCellClass, "hidden")}` llegan al DOM por el mismo
   `cn(...)`. Por eso los identificadores que aparecen como argumento de un `cn`
   se resuelven contra el módulo que los exporta (`ui-styles`), y todo pasa por
   ese mismo `cn` antes de leerse: lo que se compara es lo que el navegador
   recibe, no lo que está escrito en la primera comilla.
   -------------------------------------------------------------------------- */

/** Los tokens compartidos que una hoja puede citar por nombre. */
const TOKENS: Record<string, string> = Object.fromEntries(
  Object.entries(uiStyles as Record<string, string>).filter(
    ([, value]) => typeof value === "string",
  ),
);

/** Los argumentos de nivel superior de un `cn(...)`, sin partir cadenas. */
function argumentosDeCn(cuerpo: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let actual = "";
  for (const char of cuerpo) {
    if (char === "(" || char === "{" || char === "[") depth += 1;
    if (char === ")" || char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(actual);
      actual = "";
      continue;
    }
    actual += char;
  }
  args.push(actual);
  return args.map((arg) => arg.trim()).filter((arg) => arg !== "");
}

/** La clase efectiva del elemento, desde los atributos de su apertura. */
function resolverClase(atributos: string): string {
  const literal = /className="([^"]*)"/.exec(atributos);
  if (literal !== null) return cn(literal[1]);
  const llamada = /className=\{cn\(([^)]*)\)\}/.exec(atributos);
  if (llamada === null) return "";
  const piezas = argumentosDeCn(llamada[1]).map((arg) => {
    const cadena = /^"([\s\S]*)"$/.exec(arg);
    if (cadena !== null) return cadena[1];
    const token = TOKENS[arg];
    if (token === undefined) {
      throw new Error(`la guarda no sabe resolver el token \`${arg}\` de un cn()`);
    }
    return token;
  });
  return cn(...piezas);
}

/** La clase efectiva del encabezado: el `div` marcado `aria-hidden`. */
function claseDelEncabezado(region: string): string {
  const marca = region.indexOf('aria-hidden="true"');
  if (marca < 0) throw new Error("el encabezado no se marca `aria-hidden`");
  const cierre = region.indexOf(">", marca);
  const clase = /className=("[^"]*"|\{[^)]*\})/.exec(region.slice(marca, cierre));
  if (clase === null) throw new Error("el encabezado no declara `className`");
  return resolverClase(`className=${clase[1]}`);
}

/** Las palabras del encabezado, en orden de columna. */
function headerWords(region: string): string[] {
  return [...region.matchAll(/<span(?:\s+className="[^"]*")?\s*>([^<]+)<\/span>/g)].map((match) =>
    match[1].trim(),
  );
}

/** Un envoltorio de línea: se borra de la grilla de arriba con `sm:contents`. */
function isWrapper(node: SpanNode): boolean {
  return /(^|\s)sm:contents(\s|$)/.test(node.className);
}

/**
 * Una etiqueta es un span de texto que termina en dos puntos —«Estado: »—.
 * Que termine en dos puntos es lo que la distingue de un valor de texto plano.
 */
function isLabel(node: SpanNode): boolean {
  return /^\s*[^<>{}]+:\s*$/.test(node.inner);
}

/**
 * Las hojas de VALOR: ni envoltorio de línea ni etiqueta, y sin vivir dentro de
 * otra hoja —el chip «Bajo mínimo» y los botones son contenido del renglón, no
 * columnas nuevas de la fila.
 */
function valueSpans(region: string): SpanNode[] {
  const found = allSpans(region);
  return found.filter((node) => {
    if (isWrapper(node) || isLabel(node)) return false;
    for (let padre = node.parent; padre >= 0; padre = found[padre].parent) {
      if (!isWrapper(found[padre]) && !isLabel(found[padre])) return false;
    }
    return true;
  });
}

/** Los `<span>` que hay DENTRO de una hoja, leídos de su markup vivo. */
function spansDe(leaf: SpanNode): SpanNode[] {
  return allSpans(leaf.raw.slice(leaf.start, leaf.end));
}

/** La etiqueta de una hoja, si la tiene. */
function labelOf(leaf: SpanNode): SpanNode | undefined {
  return spansDe(leaf).find(isLabel);
}

/** El primer elemento `<span>` dentro de una hoja: la etiqueta, si abre la línea. */
function firstChildOf(leaf: SpanNode): SpanNode | undefined {
  return spansDe(leaf)[0];
}

/**
 * La etiqueta ABRE el markup de la hoja: ni al lado de la hoja, ni después del
 * valor. Se lee del markup CRUDO para que «la etiqueta es el primer elemento que
 * hay» no se confunda con «es el primer `<span>` que se encuentra».
 */
const ETIQUETA_ABRE = /^\s*<span\b[^>]*className=("[^"]*"|\{[^)]*\})\s*>\s*[^<>{}]+:\s*<\/span>/;

/** Una hoja vacía, para comparar sin construir un `SpanNode` falso. */
const HOJA_VACIA: SpanNode = {
  className: "",
  inner: "",
  rawInner: "",
  parent: -1,
  raw: "",
  start: 0,
  end: 0,
};

/* ==========================================================================
   LA CASCADA, A UN ANCHO DADO.

   Lo que esta guarda afirma de la visibilidad es el EFECTO, no el token: la
   lista de la etiqueta se fusiona con `cn` y después se resuelve como la
   resuelve el CSS a ese ancho —dentro de una PROPIEDAD gana la variante más
   alta que esté ACTIVA, y a igual variante gana la última escrita—. Un
   `sm:hidden sm:block` se funde en `sm:block` y se acusa; un `hidden sm:hidden`
   sobrevive a la fusión (mismo grupo, distinta variante: el caso ciego) y lo
   acusa la cascada, porque en el teléfono el único `display` activo es el
   `hidden` pelado.
   ========================================================================== */

/** Los cuatro anchos angostos donde la etiqueta tiene que LEERSE. */
const ANCHOS_MOVILES = [320, 360, 390, 412];

/** Los cuatro anchos anchos donde el encabezado ya la dijo y la etiqueta se va. */
const ANCHOS_ESCRITORIO = [640, 768, 1024, 1440];

/** Utilidades que ponen `display` (sólo `hidden` apaga el elemento). */
const DISPLAY = new Set([
  "block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid",
  "table", "inline-table", "table-row", "table-cell", "table-caption",
  "list-item", "contents", "flow-root", "hidden",
]);

/** Utilidades que ponen `visibility`. */
const VISIBILITY = new Set(["visible", "invisible", "collapse"]);

/** La opacidad que apaga el contenido sin apagar la caja. */
const OPACIDAD = new Set(["opacity-0"]);

/** Recorte visual de 1 px que deja el texto sólo para el lector de pantalla. */
const SR_SOLO = new Set(["sr-only"]);
const NOT_SR_SOLO = new Set(["not-sr-only"]);

/** Los cortes de Tailwind, en px: los mismos que el CSS final. */
const BREAKPOINTS: Record<string, number> = {
  sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536,
};

/** El nombre de la utilidad: el token sin su variante. */
function baseName(token: string): string {
  const corte = token.indexOf(":");
  return corte === -1 ? token : token.slice(corte + 1);
}

/**
 * El PESO de un token a ese ancho, o `null` cuando su variante no está activa.
 * Sin variante pesa 0; `sm:` pesa 640 y sólo si el viewport ya llegó a 640;
 * `max-sm:` pesa −640 y sólo por debajo de 640. Una variante que NO sea de
 * ancho no es una decisión de ancho: se trata como inactiva, y por eso es un
 * límite declarado de esta cuenta.
 */
function peso(token: string, vw: number): number | null {
  const corte = token.indexOf(":");
  if (corte === -1) return 0;
  const variante = token.slice(0, corte);
  if (variante.startsWith("max-")) {
    const bp = BREAKPOINTS[variante.slice(4)];
    if (bp === undefined) return null;
    return vw < bp ? -bp : null;
  }
  const bp = BREAKPOINTS[variante];
  if (bp === undefined) return null;
  return vw >= bp ? bp : null;
}

/** La utilidad de ese grupo que GANA a ese ancho, con su token. */
function ganador(
  tokens: string[],
  grupo: Set<string>,
  vw: number,
): { token: string; base: string } | null {
  let elegido: { token: string; base: string } | null = null;
  let mejor = Number.NEGATIVE_INFINITY;
  for (const token of tokens) {
    const nombre = baseName(token);
    if (!grupo.has(nombre)) continue;
    const p = peso(token, vw);
    // `p === mejor` se queda: a igual variante gana la última escrita, como en
    // el CSS. Un token de variante MENOR no le gana a uno ya activo.
    if (p === null || p < mejor) continue;
    elegido = { token, base: nombre };
    mejor = p;
  }
  return elegido;
}

/** El último token de ese grupo que está ACTIVO a ese ancho, o `""`. */
function activo(tokens: string[], grupo: Set<string>, vw: number): string {
  let elegido = "";
  for (const token of tokens) {
    if (grupo.has(baseName(token)) && peso(token, vw) !== null) elegido = token;
  }
  return elegido;
}

/**
 * El token que deja INVISIBLE el elemento a ese ancho, o `""` si se ve.
 *
 * Es el predicado del contrato de visibilidad: se lee de la clase EFECTIVA y de
 * la cascada a ese ancho. Lo que apaga un elemento en Tailwind son cuatro vías y
 * están las cuatro: `display:none` (`hidden`, con o sin variante),
 * `visibility:hidden` (`invisible`, `collapse`), `opacity:0` y el recorte de
 * `sr-only`.
 */
function tokenQueEsconde(className: string, vw: number): string {
  const tokens = cn(className).split(/\s+/).filter(Boolean);
  const display = ganador(tokens, DISPLAY, vw);
  if (display?.base === "hidden") return display.token;
  const visibility = ganador(tokens, VISIBILITY, vw);
  if (visibility !== null && visibility.base !== "visible") return visibility.token;
  const opacidad = ganador(tokens, OPACIDAD, vw);
  if (opacidad !== null) return opacidad.token;
  const recorte = activo(tokens, SR_SOLO, vw);
  if (recorte !== "" && activo(tokens, NOT_SR_SOLO, vw) === "") return recorte;
  return "";
}

/* --------------------------------------------------------------------------
   Los predicados del contrato. Son FUNCIONES, no `expect` sueltos: al final se
   corren contra el marcado viejo y contra mutaciones del fuente real, y tienen
   que acusar cada criterio por su cuenta.
   -------------------------------------------------------------------------- */

/** Hojas apiladas que no dicen qué valor es el que muestran. */
function unlabelledLeaves(region: string): string[] {
  return valueSpans(region)
    .filter((leaf) => labelOf(leaf) === undefined)
    .map((leaf) => leaf.className || "(sin clase)");
}

/**
 * Líneas de la tarjeta que, en el teléfono, NO se leen como «rótulo + valor».
 *
 * Son tres criterios distintos, y cada uno falla por su cuenta:
 *
 *   1. la línea no abre con SU etiqueta —si se quita, o se corre del principio,
 *      el renglón queda el valor solo, o el rótulo pegado al valor—;
 *   2. la etiqueta tiene una clase que la apaga a ese ancho —`hidden`,
 *      `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden`—: el rótulo está en
 *      el fuente y no se lee, que es el defecto entero;
 *   3. el VALOR tiene una clase que lo apaga a ese ancho: una etiqueta perfecta
 *      no dice nada si el valor que rotula no está.
 */
function lineasInvisiblesEnElTelefono(region: string): string[] {
  const fallos: string[] = [];
  for (const leaf of valueSpans(region)) {
    const columna = leaf.className || "(sin clase)";
    const primera = firstChildOf(leaf);
    if (primera === undefined || !isLabel(primera)) {
      fallos.push(`${columna}: la línea no abre con su propia etiqueta`);
      continue;
    }
    const rotulo = primera.inner.trim();
    for (const vw of ANCHOS_MOVILES) {
      const causa = tokenQueEsconde(primera.className, vw);
      if (causa !== "") fallos.push(`«${rotulo}» a ${vw}px: la esconde \`${causa}\``);
    }
    for (const vw of ANCHOS_MOVILES) {
      const causa = tokenQueEsconde(leaf.className, vw);
      if (causa !== "") fallos.push(`el valor de «${rotulo}» a ${vw}px: lo esconde \`${causa}\``);
    }
  }
  return fallos;
}

/**
 * Etiquetas que se verían ARRIBA de `sm`: el encabezado ya nombró cada columna.
 * Se afirma la cascada de la clase efectiva, no el token `sm:hidden`.
 */
function labelsVisibleOnDesktop(region: string): string[] {
  const fallos: string[] = [];
  for (const leaf of valueSpans(region)) {
    const label = labelOf(leaf);
    if (label === undefined) continue;
    for (const vw of ANCHOS_ESCRITORIO) {
      if (tokenQueEsconde(label.className, vw) === "") {
        fallos.push(`«${label.inner.trim()}» se ve a ${vw}px`);
      }
    }
  }
  return fallos;
}

/**
 * Hojas que no declaran su columna de escritorio. También acusa las columnas
 * repetidas: con `sm:col-start` explícito, un duplicado es un empujón.
 */
function unpinnedLeaves(region: string): string[] {
  const found = valueSpans(region);
  const columns = found.map((leaf) => /sm:col-start-(\d)/.exec(leaf.className)?.[1]);
  const pinned = columns.filter((column) => column !== undefined);
  const failures: string[] = [];
  const withoutColumn = found.length - pinned.length;
  if (withoutColumn > 0) failures.push(`${withoutColumn} hojas sin sm:col-start-N`);
  const repeated = pinned.length - new Set(pinned).size;
  if (repeated > 0) failures.push(`${repeated} columnas repetidas`);
  const withoutRow = found.filter(
    (leaf) => !/(^|\s)sm:row-start-1(\s|$)/.test(leaf.className),
  ).length;
  if (withoutRow > 0) failures.push(`${withoutRow} hojas sin sm:row-start-1`);
  return failures;
}

/** Las palabras rotuladas por las hojas de una región, en orden de aparición. */
function labelledWords(region: string): string[] {
  return valueSpans(region)
    .map((leaf) => labelOf(leaf)?.inner.trim().replace(/:$/, "") ?? "")
    .filter((word) => word !== "");
}

/** La hoja de ACCIONES: la que dice «Acciones: ». */
function accionesDe(region: string): SpanNode | undefined {
  return valueSpans(region).find((leaf) => labelOf(leaf)?.inner.trim() === "Acciones:");
}

/** Los `title=` de una región: dato que en un teléfono no existe (R25/R26). */
function titulosDe(region: string): string[] {
  return [...blankExpressions(region).matchAll(/title=/g)].map((match) => match[0]);
}

/* --------------------------------------------------------------------------
   El detector de pisos de ancho: tokens COMPLETOS, nunca substrings. Este repo
   se quemó dos veces con grep de substring; `min-w-[760px]0` no es un piso.
   Los comentarios se borran antes, como en el detector de
   `ux-data-table.test.ts`: este arreglo EXPLICITA el piso que se está pagando
   (`min-w-[760px]` y `min-w-[520px]`) en el comentario que cuenta por qué la
   lista ya no es tabla, y un detector que lo leyera como aplicado estaría
   probing lo contrario.
   -------------------------------------------------------------------------- */

const CLASS_TOKEN = /[A-Za-z0-9_:./[\]%-]+/g;
const INVENTED_MIN_WIDTH = /^min-w-\[\d+px\]$/;

/** Código sin comentarios: un piso nombrado al EXPLICARLO no está aplicado. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function inventedMinWidths(source: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(source).matchAll(CLASS_TOKEN)) {
    const utility = match[0].split(":").pop() ?? match[0];
    if (INVENTED_MIN_WIDTH.test(utility)) found.push(utility);
  }
  return found;
}

/** Un `RegExp` que casa el texto LITERAL, escapando sus metacaracteres. */
function literal(texto: string): RegExp {
  return new RegExp(texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/* --------------------------------------------------------------------------
   El archivo real: las dos listas.
   -------------------------------------------------------------------------- */

const REGIONES = LISTAS.map((def, n) => ({
  def,
  bloque: listaN(CLIENT, n),
  encabezado: encabezadoN(CLIENT, n),
  fila: filaN(CLIENT, n),
}));

const [PRODUCTOS, KARDEX] = REGIONES;

/* --------------------------------------------------------------------------
   El anclaje de los controles negativos: la etiqueta de la hoja marcada, tal
   como está en la fila real. Con ella se MUTA UNA COPIA DEL FUENTE EN MEMORIA
   —el archivo del repositorio no se toca, ni para escribir ni para dejar rastro—
   y esa copia pasa por la cadena completa de la guarda: `listaN` → `filaN` →
   `blankExpressions` → predicados. Un control que sólo mutara el tramo ya
   extraído no probaría que los anclajes siguen leyéndolo.
   -------------------------------------------------------------------------- */

/** La apertura y la clase efectiva de una etiqueta, y su rango en el fuente. */
function rangoDeEtiqueta(
  fuente: string,
  palabra: string,
): { desde: number; hasta: number; clase: string } {
  const texto = fuente.indexOf(`>${palabra}</span>`);
  if (texto < 0) throw new Error(`la fila no abre con la etiqueta \`${palabra}\``);
  const desde = fuente.lastIndexOf("<span", texto);
  const clase = resolverClase(fuente.slice(desde, texto));
  if (clase === "") throw new Error(`la etiqueta de «${palabra}» no declara \`className\``);
  return { desde, hasta: texto + `>${palabra}</span>`.length, clase };
}

/** El fuente real con esa etiqueta sustituida por otro markup. */
function sustituirEtiqueta(fuente: string, palabra: string, nuevo: string): string {
  const { desde, hasta } = rangoDeEtiqueta(fuente, palabra);
  return fuente.slice(0, desde) + nuevo + fuente.slice(hasta);
}

/** El fuente real con esa etiqueta corrida al final de su línea. */
function moverEtiquetaAlFinal(fuente: string, ancla: Ancla): string {
  const { desde, hasta, clase } = rangoDeEtiqueta(fuente, ancla.etiqueta);
  const enValor = fuente.indexOf(ancla.valor, hasta);
  if (enValor < 0) throw new Error(`la fila no declara \`${ancla.valor}\``);
  return (
    fuente.slice(0, desde) +
    fuente.slice(hasta, enValor + ancla.valor.length) +
    `<span className="${clase}">${ancla.etiqueta}</span>` +
    fuente.slice(enValor + ancla.valor.length)
  );
}

/** La fila n-ésima que la guarda lee de un FUENTE mutado en memoria. */
function filaMutada(n: number, mutacion: (fuente: string) => string): string {
  const fuente = mutacion(CLIENT);
  if (fuente === CLIENT) throw new Error("la mutación no cambió el fuente");
  const fila = filaN(fuente, n);
  if (fila.length === 0) throw new Error("la fila mutada no se leyó");
  if (fila === filaN(CLIENT, n)) throw new Error("la mutación no cayó dentro de la fila");
  return fila;
}

/** La fila n con la etiqueta del ancla sustituida por el markup dado. */
function filaConEtiqueta(n: number, nuevo: string): string {
  const palabra = LISTAS[n].ancla.etiqueta;
  return filaMutada(n, (fuente) => sustituirEtiqueta(fuente, palabra, nuevo));
}

/** La fila n con la clase de esa etiqueta sustituida por `clase`. */
function filaConClaseDeEtiqueta(n: number, clase: string): string {
  const palabra = LISTAS[n].ancla.etiqueta;
  return filaConEtiqueta(n, `<span className="${clase}">${palabra}</span>`);
}

/** La fila n a la que se le borró esa etiqueta. */
function filaSinEtiqueta(n: number): string {
  return filaConEtiqueta(n, "");
}

/** La fila n con esa etiqueta corrida al FINAL de su línea. */
function filaConEtiquetaAlFinal(n: number): string {
  return filaMutada(n, (fuente) => moverEtiquetaAlFinal(fuente, LISTAS[n].ancla));
}

/* ==========================================================================
   1. LAS DOS REGIONES SE LEEN DEL ARCHIVO REAL (anti-vacío)
   ========================================================================== */

describe("inventario: las dos listas se leen del archivo real", () => {
  it("el archivo leído es el cliente de inventario, con sus dos listas", () => {
    expect(CLIENT.length, "inventory-client.tsx").toBeGreaterThan(20_000);
    expect(CLIENT).toContain("export function InventoryClient");
    expect(indicesDeListas(CLIENT), "las dos listas (`<ul>` de tarjeta)").toHaveLength(2);
    expect(filaN(CLIENT, 0), "primera fila").not.toBe("");
    expect(filaN(CLIENT, 1), "segunda fila").not.toBe("");
    // Y el lector no es un sello de goma: una tercera lista NO existe, así que
    // no puede devolver una región.
    expect(filaN(CLIENT, 2), "una tercera lista").toBe("");
    expect(listaN(CLIENT, 2), "una tercera lista").toBe("");
  });

  it("cada lista trae su encabezado, su contenedor y su fila", () => {
    for (const region of REGIONES) {
      const { def, bloque, encabezado, fila } = region;
      expect(bloque.length, `${def.nombre}: bloque de la lista`).toBeGreaterThan(800);
      expect(encabezado.length, `${def.nombre}: bloque del encabezado`).toBeGreaterThan(300);
      expect(fila.length, `${def.nombre}: bloque de la fila`).toBeGreaterThan(800);
      expect(encabezado, `${def.nombre}: el encabezado se abre en grilla arriba de \`sm\``).toContain(
        "sm:grid",
      );
      expect(fila, `${def.nombre}: la fila se abre en grilla arriba de \`sm\``).toContain(
        "sm:grid-cols-[",
      );
      expect(encabezado, `${def.nombre}: el encabezado se marca \`aria-hidden\``).toContain(
        'aria-hidden="true"',
      );
    }
  });

  it("el encabezado de cada lista sigue siendo el que nombra sus columnas", () => {
    for (const region of REGIONES) {
      expect(headerWords(region.encabezado), `${region.def.nombre}: encabezado`).toEqual(
        region.def.palabras,
      );
    }
  });
});

/* ==========================================================================
   2. LA LISTA YA NO ES UNA TABLA CON CARRIL (R19/R4)
   ========================================================================== */

describe("inventario: la lista ya no es una tabla con carril", () => {
  it("ninguna de las dos listas abre un carril ni es una `<table>`", () => {
    for (const region of REGIONES) {
      expect(region.bloque, `${region.def.nombre}: carril horizontal`).not.toMatch(/overflow-x/);
      expect(region.bloque, `${region.def.nombre}: tabla`).not.toMatch(/<table\b/);
      expect(region.fila, `${region.def.nombre}: piso en la fila`).not.toMatch(/min-w-\[\d+px\]/);
    }
  });

  it("el módulo no inventa ningún piso de ancho", () => {
    // La forma anterior era `<table className={cn("w-full text-left text-sm",
    // "min-w-[760px]")}>` en productos y `min-w-[520px]` en el kardex. Es la
    // deuda que este arreglo paga en el detector de `ux-data-table.test.ts`.
    expect(inventedMinWidths(CLIENT), "pisos inventados en el módulo").toEqual([]);
  });

  it("el contenedor de la lista recorta en vez de abrir un carril de scroll", () => {
    // `overflow-hidden` es lo que hoy es el carril: sin él, un `min-w` o un
    // `grid-cols-[…]` que no entre empujaría la página de costado (R23).
    for (const region of REGIONES) {
      expect(region.bloque, `${region.def.nombre}: el contenedor`).toContain("overflow-hidden");
      expect(region.bloque, `${region.def.nombre}: el contenedor`).toContain("rounded-lg");
    }
  });

  it("los estados vacíos siguen siendo texto plano de la lista", () => {
    // Los congeló `feedback-batch3.test.ts`: convertirlos en un `Alert` los
    // volvería anuncios. Se afirma que no cambió de canal al cambiar el marcado
    // de las listas.
    expect(CLIENT).toMatch(
      /<p className="mt-3 text-sm text-text-tertiary">Sin productos para esta búsqueda\.<\/p>/,
    );
    expect(CLIENT).toMatch(
      /<p className="mt-3 text-sm text-text-tertiary">Sin movimientos registrados\.<\/p>/,
    );
  });
});

/* ==========================================================================
   3. CADA VALOR APILADO DICE QUÉ ES (R38)
   ========================================================================== */

describe("inventario: cada valor apilado dice qué es (R38)", () => {
  it("las nueve y las cinco líneas abren con su etiqueta, legible en el teléfono", () => {
    for (const region of REGIONES) {
      const { def: lista, fila } = region;
      const hojas = valueSpans(fila);
      expect(hojas, `${lista.nombre}: hojas de valor`).toHaveLength(lista.palabras.length);
      expect(
        hojas.filter((leaf) => isLabel(firstChildOf(leaf) ?? HOJA_VACIA)),
        `${lista.nombre}: líneas que abren con su rótulo`,
      ).toHaveLength(lista.palabras.length);
      expect(lineasInvisiblesEnElTelefono(fila), `${lista.nombre}: líneas del teléfono`).toEqual([]);
      expect(unlabelledLeaves(fila), `${lista.nombre}: valores sin etiqueta`).toEqual([]);
    }
  });

  it("la etiqueta es la palabra del encabezado: las dos superficies no divergen", () => {
    for (const region of REGIONES) {
      const { def: lista, fila } = region;
      // Las dos comparaciones: el juego COMPLETO y la cantidad. Comparar sólo
      // el juego dejaría pasar una etiqueta repetida en lugar de una faltante.
      expect(labelledWords(fila).slice().sort(), `${lista.nombre}: las etiquetas`).toEqual(
        lista.palabras.slice().sort(),
      );
      expect(labelledWords(fila), `${lista.nombre}: una etiqueta por columna`).toHaveLength(
        lista.palabras.length,
      );
    }
  });

  it("la etiqueta vive dentro de la hoja del valor, no al lado", () => {
    for (const region of REGIONES) {
      for (const leaf of valueSpans(region.fila)) {
        // Lo que este criterio afirma es la POSICIÓN: la etiqueta abre el markup
        // de la hoja. La otra mitad —que el `className` trajera `sm:hidden`— es
        // un token, y un token pasa con `hidden sm:hidden`; esa mitad vive,
        // como efecto, en los criterios de visibilidad.
        expect(leaf.rawInner, `${region.def.nombre}: ${leaf.className}`).toMatch(ETIQUETA_ABRE);
        expect(allSpans(leaf.rawInner).filter(isLabel), leaf.className).toHaveLength(1);
      }
    }
  });

  it("la tarjeta móvil se lee en el orden aprobado, no en el de la grilla", () => {
    // Si alguien volviera a poner las hojas en orden de columna, la tarjeta
    // móvil leería el SKU antes del nombre, o el motivo antes de quién lo hizo.
    for (const region of REGIONES) {
      expect(
        valueSpans(region.fila).map((leaf) => Number(/sm:col-start-(\d)/.exec(leaf.className)?.[1])),
        `${region.def.nombre}: columnas declaradas, en orden del DOM`,
      ).toEqual(region.def.orden);
    }
  });

  it("el chip «Bajo mínimo» y los botones NO son columnas: son contenido del renglón", () => {
    // Sin esta regla, una hoja podría «colarse» como columna nueva y la
    // equivalencia de escritorio dejaría de ser la de hoy.
    for (const region of REGIONES) {
      const textos = valueSpans(region.fila).map((leaf) =>
        leaf.rawInner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
      );
      expect(textos, `${region.def.nombre}: el chip y los botones no se contaron`).toHaveLength(
        region.def.palabras.length,
      );
    }
    expect(PRODUCTOS.fila, "el chip vive dentro de la hoja del nombre").toMatch(
      /<span className="break-words[\s\S]*?Nombre: <\/span>[\s\S]*?\{row\.name\}[\s\S]*?<Badge[\s\S]*?Bajo mínimo[\s\S]*?<\/span>/,
    );
  });
});

/* ==========================================================================
   4. LA ETIQUETA DESAPARECE ARRIBA DE `sm`
   ========================================================================== */

describe("inventario: la etiqueta desaparece arriba de `sm`", () => {
  it("las nueve y las cinco se apagan arriba de `sm`: el encabezado ya nombró", () => {
    for (const region of REGIONES) {
      expect(labelsVisibleOnDesktop(region.fila), `${region.def.nombre}: rótulos de escritorio`).toEqual(
        [],
      );
      expect(labelledWords(region.fila), `${region.def.nombre}: las etiquetas siguen estando`).toHaveLength(
        region.def.palabras.length,
      );
    }
  });

  it("el encabezado, en cambio, se apaga abajo de `sm`: es su contraparte", () => {
    // La otra mitad del mismo contrato: si el encabezado también se viera en el
    // teléfono, la fila leería sus rótulos DOS veces.
    for (const region of REGIONES) {
      const clase = claseDelEncabezado(region.encabezado);
      for (const vw of ANCHOS_MOVILES) {
        expect(tokenQueEsconde(clase, vw), `${region.def.nombre}: abajo de \`sm\` a ${vw}px`).toBe("hidden");
      }
      for (const vw of ANCHOS_ESCRITORIO) {
        expect(tokenQueEsconde(clase, vw), `${region.def.nombre}: arriba de \`sm\` a ${vw}px`).toBe("");
      }
    }
  });

  it("el control negativo: quitarle `sm:hidden` a una etiqueta se acusa", () => {
    const sinVariante = PRODUCTOS.fila.replace(/(^|[\s"])sm:hidden(?=[\s"])/, "$1");
    expect(sinVariante, "el archivo real declara la variante").not.toBe(PRODUCTOS.fila);
    expect(labelsVisibleOnDesktop(sinVariante)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«${LISTAS[0].ancla.etiqueta.trim()}» se ve a ${vw}px`),
    );
  });
});

/* ==========================================================================
   5. ARRIBA DE `sm` LA GRILLA NO SE MOVIDÓ
   ========================================================================== */

describe("inventario: arriba de `sm` la grilla no se movió", () => {
  it("cada hoja pinea su columna, y son todas, una vez cada una", () => {
    for (const region of REGIONES) {
      const { def: lista, fila } = region;
      expect(unpinnedLeaves(fila), `${lista.nombre}: pineo`).toEqual([]);
      expect(
        valueSpans(fila)
          .map((leaf) => Number(/sm:col-start-(\d)/.exec(leaf.className)?.[1]))
          .sort((a, b) => a - b),
        `${lista.nombre}: las columnas, ordenadas`,
      ).toEqual(lista.palabras.map((_, i) => i + 1));
    }
  });

  it("la escala de columnas es la misma en el encabezado y en la fila", () => {
    for (const region of REGIONES) {
      const { def: lista } = region;
      expect((region.encabezado.match(literal(lista.escala)) ?? []).length, `${lista.nombre}: encabezado`).toBe(1);
      expect((region.fila.match(literal(lista.escala)) ?? []).length, `${lista.nombre}: fila`).toBe(1);
    }
  });

  it("las líneas de la tarjeta son envoltorios que se borran de la grilla de arriba", () => {
    for (const region of REGIONES) {
      const { def: lista, fila } = region;
      // Un envoltorio por línea: 5 en productos (Nombre, Stock, Venta,
      // Comisión, Acciones) y 4 en el kardex. La hoja `Acciones` se cuenta
      // aparte porque es su propio campo.
      const envolturas = allSpans(fila).filter(isWrapper);
      expect(envolturas.length, `${lista.nombre}: envoltorios sm:contents`).toBeGreaterThanOrEqual(
        lista.acciones === undefined ? 4 : 5,
      );
      for (const envoltura of envolturas) {
        expect(envoltura.rawInner.trim().length, `${lista.nombre}: envoltorio`).toBeGreaterThan(50);
      }
    }
  });
});

/* ==========================================================================
   6. LA ACCIÓN DE LA FILA ESTÁ EN SU CAMPO Y SE ALCANZA SIN ARRASTRAR
   ========================================================================== */

describe("inventario: la acción de la fila se alcanza sin arrastrar", () => {
  it("las dos acciones viven dentro de la hoja que dice «Acciones»", () => {
    const hoja = accionesDe(PRODUCTOS.fila);
    expect(hoja, "la hoja de acciones").toBeDefined();
    const marcada = (hoja as SpanNode).rawInner;
    for (const accion of LISTAS[0].acciones as string[]) {
      expect(marcada, `«${accion}» está en la hoja de acciones`).toContain(accion);
    }
    // Y el kardex NO tiene acciones: no inventa un campo que no existe.
    expect(accionesDe(KARDEX.fila), "el kardex no declara acciones").toBeUndefined();
  });

  it("el campo de acciones se envuelve: los botones no empujan la fila", () => {
    const hoja = accionesDe(PRODUCTOS.fila) as SpanNode;
    // `flex-wrap` es lo que impide el desbordamiento horizontal cuando aparecen
    // los dos botones; el `sm:contents` del envoltorio lo devuelve a la grilla.
    expect(hoja.className.split(/\s+/)).toContain("flex-wrap");
    expect(hoja.className.split(/\s+/)).not.toContain("whitespace-nowrap");
    expect(hoja.className).not.toMatch(/overflow-x/);
  });

  it("ningún dato de las dos filas vive en un tooltip ni sale cortado", () => {
    // R25/R26 con el criterio del dueño: el `title=` no existe con el dedo, así
    // que un dato que sólo se recupera ahí es un dato que en un teléfono no se
    // puede leer. Y `truncate` corta la identidad de la fila.
    for (const region of REGIONES) {
      expect(titulosDe(region.fila), `${region.def.nombre}: title=`).toEqual([]);
      for (const leaf of valueSpans(region.fila)) {
        expect(leaf.className.split(/\s+/), `${region.def.nombre}: «${leaf.className}»`).not.toContain(
          "truncate",
        );
      }
    }
  });
});

/* ==========================================================================
   7. EL PREDICADO NO ES UN SELLO DE GOMA: EL MARCADO VIEJO SE ACUSA
   ========================================================================== */

/**
 * El marcado anterior, escrito con el mismo LECTOR (una fila de `<li>` con sus
 * celdas peladas): nueve valores sin etiqueta y sin pineo, con los botones en
 * un renglón suelto. No es una `<table>` porque el lector de la guarda cuenta
 * hojas de valor, no celdas: el defecto que se acusa es el de la fila apilada
 * sin rótulos (R38), que es el mismo de hoy con la tabla.
 */
const PRODUCTOS_ANTES = `<li key={row.id} className="border-t border-border-color">
  <span className="px-3 py-2 align-middle font-mono">SH-001</span>
  <span className="px-3 py-2 align-middle">Shampoo profesional {alertIds.has(row.id) ? <span className="rounded-full px-2 py-0.5 text-xs font-semibold">Bajo mínimo</span> : null}</span>
  <span className="px-3 py-2 align-middle">12</span>
  <span className="px-3 py-2 align-middle">5</span>
  <span className="px-3 py-2 align-middle">$ 25.000</span>
  <span className="px-3 py-2 align-middle">$ 35.000</span>
  <span className="px-3 py-2 align-middle">$ 5.000</span>
  <span className="px-3 py-2 align-middle">Activo</span>
  <span className="px-3 py-2 align-middle"><span className="flex flex-wrap gap-2"><span className="inline-flex items-center justify-center gap-2">Kardex</span></span></span>
</li>`;

const KARDEX_ANTES = `<li key={row.id} className="border-t border-border-color">
  <span className="px-3 py-2 align-middle">4/10/2026, 4:45:00 p. m.</span>
  <span className="px-3 py-2 align-middle font-mono">IN</span>
  <span className="px-3 py-2 align-middle">12</span>
  <span className="px-3 py-2 align-middle">Compra a proveedor</span>
  <span className="px-3 py-2 align-middle">Carolina Rojas</span>
</li>`;

describe("el predicado no es un sello de goma", () => {
  it("el marcado viejo de productos —nueve valores sin etiqueta y sin pineo— se acusa", () => {
    const vieja = filaN(PRODUCTOS_ANTES, 0);
    expect(vieja.length, "la región vieja se leyó").toBeGreaterThan(200);
    expect(valueSpans(vieja), "hojas de la fila vieja").toHaveLength(9);
    expect(unlabelledLeaves(vieja), "valores sin etiqueta").toHaveLength(9);
    expect(labelledWords(vieja), "etiquetas del marcado viejo").toEqual([]);
    expect(unpinnedLeaves(vieja), "hojas sin pineo").toEqual([
      "9 hojas sin sm:col-start-N",
      "9 hojas sin sm:row-start-1",
    ]);
    expect(labelsVisibleOnDesktop(vieja), "el viejo tampoco rotula arriba").toEqual([]);
    expect(lineasInvisiblesEnElTelefono(vieja), "líneas sin rótulo visible").toHaveLength(9);
    for (const fallo of lineasInvisiblesEnElTelefono(vieja)) {
      expect(fallo).toContain("no abre con su propia etiqueta");
    }
    expect(accionesDe(vieja), "la hoja de acciones del viejo").toBeUndefined();
  });

  it("el marcado viejo del kardex —cinco valores sin etiqueta y sin pineo— se acusa", () => {
    const vieja = filaN(KARDEX_ANTES, 0);
    expect(vieja.length, "la región vieja se leyó").toBeGreaterThan(100);
    expect(valueSpans(vieja), "hojas de la fila vieja").toHaveLength(5);
    expect(unlabelledLeaves(vieja), "valores sin etiqueta").toHaveLength(5);
    expect(unpinnedLeaves(vieja), "hojas sin pineo").toEqual([
      "5 hojas sin sm:col-start-N",
      "5 hojas sin sm:row-start-1",
    ]);
    expect(lineasInvisiblesEnElTelefono(vieja), "líneas sin rótulo visible").toHaveLength(5);
  });

  it("el chip y los botones de la fila vieja no se contaron como columnas", () => {
    // `valueSpans` tiene que excluir lo que vive DENTRO de una hoja: si no, el
    // chip y cada botón entrarían como columnas y la equivalencia de escritorio
    // mentiría.
    const textos = valueSpans(filaN(PRODUCTOS_ANTES, 0)).map((leaf) =>
      leaf.rawInner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
    );
    expect(textos).toEqual([
      "SH-001",
      "Shampoo profesional {alertIds.has(row.id) ? Bajo mínimo : null}",
      "12",
      "5",
      "$ 25.000",
      "$ 35.000",
      "$ 5.000",
      "Activo",
      "Kardex",
    ]);
  });

  it("una etiqueta con palabra inventada también se acusa: el vocabulario diverge", () => {
    const inventada = filaN(
      PRODUCTOS_ANTES.replace(
        "Shampoo profesional ",
        '<span className="font-sans font-medium text-text-secondary sm:hidden">Solicitante: </span>Shampoo profesional',
      ),
      0,
    );
    expect(labelledWords(inventada)).toEqual(["Solicitante"]);
    // Es decir: la comparación que hace la guarda real la rechaza.
    expect(labelledWords(inventada).slice().sort()).not.toEqual(
      LISTAS[0].palabras.slice().sort(),
    );
    expect(LISTAS[0].palabras).not.toContain("Solicitante");
  });
});

/* ==========================================================================
   8. LA ETIQUETA QUE SE APAGA EN EL FONDO (el punto ciego de la familia)
   ========================================================================== */

describe("la etiqueta que se apaga en el fondo se acusa", () => {
  it("un `hidden` pelado en la etiqueta la esconde en los cuatro anchos del teléfono", () => {
    for (let n = 0; n < LISTAS.length; n += 1) {
      const fila = filaConClaseDeEtiqueta(n, `${rangoDeEtiqueta(CLIENT, LISTAS[n].ancla.etiqueta).clase} hidden`);
      expect(lineasInvisiblesEnElTelefono(fila), `${LISTAS[n].nombre}: la etiqueta colapsada`).toEqual(
        ANCHOS_MOVILES.map((vw) => `«${LISTAS[n].ancla.etiqueta.trim()}» a ${vw}px: la esconde \`hidden\``),
      );
      // Y el mismo defecto NO se ve desde el escritorio: `sm:hidden` sigue
      // apagándola arriba, que es por eso que la cuenta por token quedaba verde.
      expect(labelsVisibleOnDesktop(fila), `${LISTAS[n].nombre}: arriba de \`sm\` sigue apagada`).toEqual([]);
    }
  });

  it("`hidden sm:hidden` —que SOBREVIVE a la fusión— también se acusa en el teléfono", () => {
    // El punto ciego exacto: `cn` (= `twMerge`) no funde `hidden` con
    // `sm:hidden` (mismo grupo, distinta variante), así que los dos tokens llegan
    // al DOM. La cuenta por cascada es la que lo encuentra.
    for (let n = 0; n < LISTAS.length; n += 1) {
      const base = rangoDeEtiqueta(CLIENT, LISTAS[n].ancla.etiqueta).clase;
      const fila = filaConClaseDeEtiqueta(n, `${base} hidden sm:hidden`);
      expect(lineasInvisiblesEnElTelefono(fila), `${LISTAS[n].nombre}: \`hidden sm:hidden\``).toEqual(
        ANCHOS_MOVILES.map((vw) => `«${LISTAS[n].ancla.etiqueta.trim()}» a ${vw}px: la esconde \`hidden\``),
      );
    }
  });

  it("`sr-only`, `invisible`, `opacity-0` y `max-sm:hidden` apagan igual, cada uno", () => {
    const base = rangoDeEtiqueta(CLIENT, LISTAS[0].ancla.etiqueta).clase;
    const esperado: [string, string][] = [
      ["sr-only", "sr-only"],
      ["invisible", "invisible"],
      ["opacity-0", "opacity-0"],
      ["max-sm:hidden", "max-sm:hidden"],
    ];
    for (const [utilidad, culpable] of esperado) {
      expect(
        lineasInvisiblesEnElTelefono(filaConClaseDeEtiqueta(0, `${base} ${utilidad}`)),
        `la etiqueta con \`${utilidad}\``,
      ).toEqual(ANCHOS_MOVILES.map((vw) => `«${LISTAS[0].ancla.etiqueta.trim()}» a ${vw}px: la esconde \`${culpable}\``));
    }
  });

  it("arriba de `sm`, una etiqueta que vuelve a verse se acusa en los cuatro anchos", () => {
    // La edición: `sm:hidden sm:block`. `cn` la funde en `sm:block` —no hay dos
    // clases, hay una que gana— y la cascada la encuentra prendida.
    const base = rangoDeEtiqueta(CLIENT, LISTAS[1].ancla.etiqueta).clase;
    const fila = filaConClaseDeEtiqueta(1, `${base} sm:block`);
    expect(labelsVisibleOnDesktop(fila)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«${LISTAS[1].ancla.etiqueta.trim()}» se ve a ${vw}px`),
    );
  });

  it("la clase FUNDIDA de un `cn` con un token del llamador también se lee", () => {
    // Una hoja escrita `className={cn("…", mutedTextClass)}` no es un caso
    // teórico: es lo que pasa cuando una hoja hereda una clase compartida. Si la
    // guarda leyera sólo la primera cadena del `cn`, no vería el `hidden` que
    // llega por el token.
    const base = rangoDeEtiqueta(CLIENT, LISTAS[0].ancla.etiqueta).clase;
    const fila = filaConEtiqueta(
      0,
      `<span className={cn("${base}", mutedTextClass, "hidden")}>${LISTAS[0].ancla.etiqueta}</span>`,
    );
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `«${LISTAS[0].ancla.etiqueta.trim()}» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el token compartido se resuelve de verdad: `mutedTextClass` entra al DOM.
    expect(TOKENS.mutedTextClass, "el token del llamador se importó").toContain("text-sm");
  });

  it("un `hidden` en la HOJA, no en la etiqueta, también se acusa: el valor no está", () => {
    // Una etiqueta perfecta no dice nada si el valor que rotula se apagó. El
    // fallo se cuenta como «el valor de «Nombre:»», no como un rótulo roto.
    const fila = filaMutada(0, (fuente) =>
      fuente.replace(
        'className="break-words text-sm text-text-primary sm:col-start-2',
        'className="break-words text-sm text-text-primary hidden sm:col-start-2',
      ),
    );
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `el valor de «Nombre:» a ${vw}px: lo esconde \`hidden\``),
    );
  });

  it("quitarle la etiqueta a una línea se acusa por esa línea, no por las otras", () => {
    for (let n = 0; n < LISTAS.length; n += 1) {
      const fila = filaSinEtiqueta(n);
      expect(lineasInvisiblesEnElTelefono(fila), `${LISTAS[n].nombre}`).toEqual([
        expect.stringContaining("no abre con su propia etiqueta"),
      ]);
      expect(unlabelledLeaves(fila), `${LISTAS[n].nombre}: una hoja sin etiqueta`).toHaveLength(1);
      expect(labelledWords(fila), `${LISTAS[n].nombre}: una etiqueta menos`).toHaveLength(
        LISTAS[n].palabras.length - 1,
      );
    }
  });

  it("correr la etiqueta del principio de la línea se acusa aunque siga siendo la suya", () => {
    // La edición: el rótulo se mueve después del valor. Sigue siendo una
    // etiqueta, sigue con la palabra del encabezado, sigue `sm:hidden`… y la
    // línea se lee sin decir qué es. Sólo lo caza el criterio de posición.
    for (let n = 0; n < LISTAS.length; n += 1) {
      const fila = filaConEtiquetaAlFinal(n);
      expect(labelledWords(fila), `${LISTAS[n].nombre}: el rótulo sigue siendo el mismo`).toHaveLength(
        LISTAS[n].palabras.length,
      );
      expect(lineasInvisiblesEnElTelefono(fila), `${LISTAS[n].nombre}: y sigue prendida`).toEqual([]);
      expect(
        valueSpans(fila)
          .filter((leaf) => !ETIQUETA_ABRE.test(leaf.rawInner))
          .map((leaf) => labelOf(leaf)?.inner.trim()),
        `${LISTAS[n].nombre}: hojas que ya no abren con su rótulo`,
      ).toEqual([LISTAS[n].ancla.etiqueta.trim()]);
    }
  });

  it("despinear una columna se acusa: la equivalencia de escritorio se rompe", () => {
    // La edición: se le quita `sm:col-start-3` a la hoja del stock. La grilla de
    // arriba ya no es la de hoy, y sin pineo el valor cae donde toque.
    const fila = filaMutada(0, (fuente) =>
      fuente.replace("sm:col-start-3 sm:row-start-1", "sm:row-start-1"),
    );
    expect(unpinnedLeaves(fila)).toEqual(["1 hojas sin sm:col-start-N"]);
  });

  it("un `title=` en la fila se acusa: el dato que sólo vive en el tooltip", () => {
    const conTooltip = filaMutada(0, (fuente) =>
      fuente.replace('<span className="break-words', '<span title="Shampoo" className="break-words'),
    );
    expect(titulosDe(conTooltip), "el title= se coló en la fila").toHaveLength(1);
  });

  it("el `className` de la etiqueta del ancla es el que estas cuentas están leyendo", () => {
    // Ancla de los controles de arriba: si el archivo dejara de rotular, o de
    // declarar su clase, estos controles no estarían probando nada.
    for (let n = 0; n < LISTAS.length; n += 1) {
      const clase = rangoDeEtiqueta(CLIENT, LISTAS[n].ancla.etiqueta).clase;
      expect(clase.split(/\s+/)).toEqual(expect.arrayContaining(["sm:hidden"]));
      expect(tokenQueEsconde(clase, 390), `${LISTAS[n].nombre}: en el teléfono`).toBe("");
      expect(tokenQueEsconde(clase, 1024), `${LISTAS[n].nombre}: en el escritorio`).toBe("sm:hidden");
    }
  });

  it("el detector de pisos no confunde un token que CONTIENE un piso", () => {
    expect(inventedMinWidths('className="min-w-[760px]"'), "piso real").toEqual(["min-w-[760px]"]);
    expect(inventedMinWidths('className={cn("min-w-[760px]0")}'), "no es un piso").toEqual([]);
    expect(inventedMinWidths("const xmin-w-[760px] = 1; min-w-[760px]0"), "ni estos").toEqual([]);
    expect(inventedMinWidths('className="w-full min-w-full"'), "min-w-full no se inventa").toEqual([]);
    expect(inventedMinWidths('className="min-w-[10rem]"'), "rem no es el formato inventado").toEqual([]);
    // Y un piso sólo EXPLICADO no está aplicado: el arreglo cuenta por qué se
    // quitó el piso, y el detector no puede leer su propia explicación.
    expect(inventedMinWidths("// min-w-[760px]\n/* min-w-[999px] */"), "en un comentario").toEqual([]);
  });

  it("el comentario que explica el arreglo nombra los pisos que ya no están", () => {
    // Ancla del control de arriba: si los pisos se fueran de los comentarios,
    // el detector dejaría de distinguir «explicado» de «aplicado» sin que nadie
    // lo note.
    expect(CLIENT).toMatch(/min-w-\[760px\]/);
    expect(CLIENT).toMatch(/min-w-\[520px\]/);
    expect(inventedMinWidths(CLIENT), "y sin embargo no queda ninguno aplicado").toEqual([]);
  });

  it("las utilidades que la cascada mira son las cuatro vías de apagado", () => {
    // El detector de visibilidad no puede ser un sello de goma: se afirma sobre
    // clases que la propia cuenta declara ocultables.
    expect(tokenQueEsconde("sm:hidden", 390)).toBe("");
    expect(tokenQueEsconde("hidden", 390)).toBe("hidden");
    expect(tokenQueEsconde("hidden sm:hidden", 390)).toBe("hidden");
    expect(tokenQueEsconde("sr-only", 390)).toBe("sr-only");
    expect(tokenQueEsconde("sr-only not-sr-only", 390)).toBe("");
    expect(tokenQueEsconde("invisible", 390)).toBe("invisible");
    expect(tokenQueEsconde("visible", 390)).toBe("");
    expect(tokenQueEsconde("opacity-0", 390)).toBe("opacity-0");
    expect(tokenQueEsconde("max-sm:hidden", 390)).toBe("max-sm:hidden");
    expect(tokenQueEsconde("max-sm:hidden", 640)).toBe("");
    expect(tokenQueEsconde("hidden md:flex", 700)).toBe("hidden");
    expect(tokenQueEsconde("hidden md:flex", 800)).toBe("");
    // Y una variante que NO es de ancho no decide nada a ese ancho.
    expect(tokenQueEsconde("dark:hidden", 390)).toBe("");
  });
});
