import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO `cn` del que `services-client.tsx` saca la clase que llega al DOM:
// `twMerge(clsx(...))`. No es una copia de la regla de fusión: es la regla, y
// los tokens del llamador se resuelven importándolos del módulo que los
// exporta, no transcribiéndolos.
import { cn } from "@/src/components/ui/lib/utils";
import * as uiStyles from "@/src/shared/lib/ui-styles";

/* --------------------------------------------------------------------------
   R19 + R4 + R38 en la lista de servicios: la fila del catálogo, apilada y con
   su etiqueta, y su acción al alcance del dedo.

   EL DEFECTO, MEDIDO (ver `odd/tasks/auditoria-responsive.md`, R19 y la tabla
   «Confirmado con número»): la lista era una `<table className="min-w-[640px]">`
   dentro de un carril de `overflow-x-auto` cuyo ancho útil en un teléfono es de
   222 a 308 px. Con filas reales, la última columna —`Acciones`, con el único
   `Editar` de la fila— queda SIEMPRE fuera: son los **4 botones fuera** que
   contó la medición, y no hay ningún gesto horizontal corto que los traiga sin
   arrastrar el carril entero. Encima, y por el mismo carril, las cinco celdas
   se leían como cinco valores sueltos («Corte de cabello», «$ 35.000»,
   «30–60 min», «Activo», «Editar») sin que nada dijera cuál era cuál.

   LO QUE SE AFIRMA, en cuatro invariantes y por fuente (el método de
   `vouchers-row-labels.test.ts` y `invoice-row-labels.test.ts`, que son la
   REFERENCIA de este patrón: la lista de vales y la de facturas ya lo
   resolvieron, y esta no puede inventar un segundo):

     1. ABAJO DE `sm`, cada valor apilado lleva su etiqueta visible, y es la
        palabra del encabezado: el vocabulario se escribe una vez.
     2. ARRIBA DE `sm` esas etiquetas no existen —el encabezado ya nombra— y la
        fila sigue siendo la grilla de las CINCO columnas de hoy, cada una
        anclada con `sm:col-start-N`, porque el orden del DOM es el de la
        tarjeta móvil.
     3. NADA de lo que decide una edición depende de un gesto horizontal, de un
        `title=` o de un texto cortado: la acción vive en su campo, se
        envuelve, y no hay carril de scroll ni piso de ancho inventado.
     4. La VISIBILIDAD se afirma sobre la clase EFECTIVA —la que sale de `cn`— y
        sobre la cascada a ese ancho, no sobre el token: por eso `hidden`,
        `hidden sm:hidden`, `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden` y
        `sm:block` se acusan uno por uno.

   LO QUE ESTA GUARDA NO PUEDE VER, DICHO DE ANTEMANO: acá no hay navegador. Se
   afirma lo que el marcado PIDE. No ve un `style` en línea, ni una regla de
   `globals.css`, ni un `hidden` heredado de un ancestro, ni una variante que
   dependa del estado y no del ancho (`hover:`, `dark:`, `group-hover:`), que se
   tratan como inactivas. Lo que se midió de verdad —cero de scroll lateral, cinco
   rótulos visibles y `Editar` respondiendo a `elementFromPoint` en los cuatro
   anchos— está en el informe de la unidad.
   -------------------------------------------------------------------------- */

const CLIENT_PATH = join(process.cwd(), "app", "services", "services-client.tsx");
const CLIENT = readFileSync(CLIENT_PATH, "utf8");

/** La escala de las cinco columnas: la declaran el encabezado y la fila. */
const COLUMN_SCALE =
  "grid-cols-[minmax(0,1.5fr)_minmax(0,0.85fr)_minmax(0,0.75fr)_minmax(0,0.6fr)_minmax(0,0.85fr)]";

/** El `<ul>` de la lista: termina el bloque del encabezado. */
const LIST_ANCHOR = '<ul className="flex flex-col divide-y';

/** La `</Card>` que cierra el catálogo: termina el bloque de la lista. */
const CARD_ANCHOR = "</Card>";

/* --------------------------------------------------------------------------
   Las regiones que se leen del archivo real.
   -------------------------------------------------------------------------- */

/** El bloque del encabezado: el contenedor y el `div` que nombra las columnas. */
function headerRegion(source: string): string {
  const lista = source.indexOf(LIST_ANCHOR);
  if (lista < 0) return "";
  const inicio = source.lastIndexOf('<div className="mt-4', lista);
  return inicio < 0 ? "" : source.slice(inicio, lista);
}

/** El bloque de la lista: el contenedor, el encabezado y el `<ul>` entero. */
function listRegion(source: string): string {
  const lista = source.indexOf(LIST_ANCHOR);
  if (lista < 0) return "";
  const inicio = source.lastIndexOf('<div className="mt-4', lista);
  const fin = source.indexOf(CARD_ANCHOR, lista);
  return inicio >= 0 && fin > inicio ? source.slice(inicio, fin) : "";
}

/** La fila: su `<li>` hasta su `</li>`. */
function rowRegion(source: string): string {
  const start = source.search(/<li\s+key=\{row\.id\}/);
  if (start < 0) return "";
  const end = source.indexOf("</li>", start);
  return end > start ? source.slice(start, end) : "";
}

/* --------------------------------------------------------------------------
   Lectores. Tokens de clase completos y `<span>` balanceados: una etiqueta
   dentro de una hoja no es lo mismo que una etiqueta al lado.
   -------------------------------------------------------------------------- */

/** Las cinco palabras del encabezado, en orden de columna. */
function headerWords(region: string): string[] {
  return [...region.matchAll(/<span(?:\s+className="[^"]*")?\s*>([^<]+)<\/span>/g)].map((match) =>
    match[1].trim(),
  );
}

/**
 * Las expresiones JSX —y con ellas los comentarios `{/* … *\/}`— se vacían
 * ANTES de leer etiquetas: dentro de una `{...}` hay `=>`, `&&` y `<` que no son
 * markup y harían desbalancear el conteo de `<span>`. Se reemplazan por
 * espacios, así los índices no se mueven y lo que se lee es el markup vivo.
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
  className: string;
  /** El contenido con las expresiones JSX vaciadas: para Reconocer un rótulo. */
  inner: string;
  /**
   * El MISMO contenido, sin vaciar. Hace falta para dos cosas que el vaciado
   * borra: afirmar que la etiqueta ABRE la hoja (`{…}` al principio no es
   * `<span>`) y ver lo que hay dentro de una condición —el botón `Editar` vive
   * en un `&&`—.
   */
  rawInner: string;
  /** El índice del `<span>` que lo envuelve, o -1. */
  parent: number;
  /** La región VIVA de la que se leyó, y el rango del contenido dentro de ella. */
  raw: string;
  start: number;
  end: number;
}

/**
 * Todos los `<span>` de la región: su clase EFECTIVA (resuelta con el mismo `cn`
 * que usa el componente, incluyendo los tokens que el llamador cite por nombre),
 * su contenido y su padre, para que una hoja no se cuente dos veces por vivir
 * dentro de otra.
 *
 * `blankExpressions` conserva la LONGITUD y la posición de cada carácter
 * (reemplaza uno por uno), así que el marcado vivo se puede leer con los mismos
 * índices que el markup sin expresiones: los ATRIBUTOS se leen del fuente real —
  y por eso se sigue viendo el `className={cn(…)}` que un `{` había vaciado—.
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
   `cn(...)`. Por eso los identificadores que aparecen como argumento de un
   `cn` se resuelven contra el módulo que los exporta (`ui-styles`), y todo
   pasa por ese mismo `cn` antes de leerse: lo que se compara es lo que el
   navegador recibe, no lo que está escrito en la primera comilla.
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

/**
 * La clase efectiva del elemento, desde los atributos de su apertura.
 * `className="…"` y `className={cn(…)}` salen por el mismo `cn`.
 */
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
 * otra hoja —la descripción del servicio y el botón `Editar` son contenido del
 * renglón, no columnas nuevas de la fila.
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
 * valor. Se lee del markup CRUDO —no de la lista de `<span>`— para que «la
 * etiqueta es el primer elemento que hay» no se confunda con «es el primer
 * `<span>` que se encuentra», que también pasa con el rótulo corrido al final:
 * un `{…}` de valor vacío antes del rótulo es exactamente lo que deja el
 * vacío, y por eso la cuenta es sobre el fuente vivo.
 */
const ETIQUETA_ABRE = /^\s*<span\b[^>]*className=("[^"]*"|\{[^)]*\})\s*>\s*[^<>{}]+:\s*<\/span>/;

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
 * `max-sm:` pesa −640 y sólo por debajo de 640 —el signo de «escondida justo en
 * el teléfono». Una variante que NO sea de ancho no es una decisión de ancho:
 * se trata como inactiva, y por eso es un límite declarado de esta cuenta.
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
   corren contra el marcado viejo y tienen que acusarlo.
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

/** La hoja de ESTADO: la que dice «Estado: ». */
function estadoDe(region: string): SpanNode | undefined {
  return valueSpans(region).find((leaf) => labelOf(leaf)?.inner.trim() === "Estado:");
}

/** La columna que declara cada hoja, en el orden en que el DOM las declara. */
function declaredColumns(region: string): number[] {
  return valueSpans(region).map((leaf) => Number(/sm:col-start-(\d)/.exec(leaf.className)?.[1]));
}

/** Los `title=` de una región: dato que en un teléfono no existe (R25/R26). */
function titulosDe(region: string): string[] {
  return [...blankExpressions(region).matchAll(/title=/g)].map((match) => match[0]);
}

/* --------------------------------------------------------------------------
   El detector de pisos de ancho: tokens COMPLETOS, nunca substrings. Este repo
   se quemó dos veces con grep de substring; `min-w-[640px]0` no es un piso.
   Los comentarios se borran antes, como en el detector de
   `ux-data-table.test.ts`: este arreglo EXPLICITA el piso que se está pagando
   (`min-w-[640px]`) en el comentario que cuenta por qué la lista ya no es tabla,
   y un detector que lo leyera como aplicado estaría probing lo contrario.
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
   El archivo real.
   -------------------------------------------------------------------------- */

const HEADER = headerRegion(CLIENT);
const LIST = listRegion(CLIENT);
const ROW = rowRegion(CLIENT);
const WORDS = headerWords(HEADER);
const ROW_VALUES = valueSpans(ROW);

/* --------------------------------------------------------------------------
   El anclaje de los controles negativos: la etiqueta del «Servicio», tal como
   está en la fila real. Con ella se MUTA UNA COPIA DEL FUENTE EN MEMORIA —el
   archivo del repositorio no se toca, ni para escribir ni para dejar rastro— y
   esa copia pasa por la cadena completa de la guarda: `rowRegion` →
   `blankExpressions` → predicados. Un control que sólo mutara el tramo ya
   extraído no probaría que los anclajes siguen leyéndolo.
   -------------------------------------------------------------------------- */

/** La apertura y la clase efectiva de la etiqueta del «Servicio», y su rango. */
function etiquetaServicio(source: string): { desde: number; hasta: number; clase: string } {
  const texto = source.indexOf(">Servicio: </span>");
  if (texto < 0) throw new Error("la fila no abre con la etiqueta `Servicio: `");
  const desde = source.lastIndexOf("<span", texto);
  const clase = resolverClase(source.slice(desde, texto));
  if (clase === "") throw new Error("la etiqueta del «Servicio» no declara `className`");
  return { desde, hasta: texto + ">Servicio: </span>".length, clase };
}

/** El fuente real con la etiqueta del «Servicio» sustituida por otro markup. */
function sustituirEtiquetaServicio(fuente: string, nuevo: string): string {
  const { desde, hasta } = etiquetaServicio(fuente);
  return fuente.slice(0, desde) + nuevo + fuente.slice(hasta);
}

/** El fuente real con la etiqueta del «Servicio» corrida al final de su línea. */
function moverEtiquetaAlFinal(fuente: string): string {
  const { desde, hasta, clase } = etiquetaServicio(fuente);
  const valor = "{row.name}";
  const enValor = fuente.indexOf(valor, hasta);
  if (enValor < 0) throw new Error("la fila no declara `{row.name}`");
  return (
    fuente.slice(0, desde) +
    fuente.slice(hasta, enValor + valor.length) +
    `<span className="${clase}">Servicio: </span>` +
    fuente.slice(enValor + valor.length)
  );
}

/** La fila que la guarda lee de un FUENTE mutado en memoria. */
function filaDe(mutacion: (fuente: string) => string): string {
  const fuente = mutacion(CLIENT);
  if (fuente === CLIENT) throw new Error("la mutación no cambió el fuente");
  const fila = rowRegion(fuente);
  if (fila.length === 0) throw new Error("la fila mutada no se leyó");
  if (fila === ROW) throw new Error("la mutación no cayó dentro de la fila");
  return fila;
}

/** La fila con la etiqueta del «Servicio» sustituida por el markup dado. */
function filaConEtiqueta(markup: string): string {
  return filaDe((fuente) => sustituirEtiquetaServicio(fuente, markup));
}

/** La fila con la clase de la etiqueta del «Servicio» sustituida por `clase`. */
function filaConClaseDeEtiqueta(clase: string): string {
  return filaConEtiqueta(`<span className="${clase}">Servicio: </span>`);
}

/** La fila a la que se le borró la etiqueta del «Servicio». */
function filaSinEtiqueta(): string {
  return filaConEtiqueta("");
}

/** La fila con la etiqueta del «Servicio» corrida al FINAL de su línea. */
function filaConEtiquetaAlFinal(): string {
  return filaDe(moverEtiquetaAlFinal);
}

describe("la lista de servicios: anti-vacío", () => {
  it("las dos regiones se leen del archivo real", () => {
    expect(HEADER.length, "bloque del encabezado").toBeGreaterThan(300);
    expect(LIST.length, "bloque de la lista").toBeGreaterThan(800);
    expect(ROW.length, "bloque de la fila").toBeGreaterThan(800);
    expect(HEADER, "el encabezado se abre en grilla arriba de `sm`").toContain("sm:grid");
    expect(ROW, "la fila se abre en grilla de cinco columnas").toContain("sm:grid-cols-[");
  });

  it("el encabezado sigue siendo el que nombra las cinco columnas, y sólo arriba de `sm`", () => {
    expect(WORDS, "las cinco palabras del encabezado").toEqual([
      "Servicio",
      "Precio",
      "Duración",
      "Estado",
      "Acciones",
    ]);
  });

  it("la fila es una tarjeta abajo y una grilla de cinco arriba, sin carril de scroll", () => {
    expect(ROW).toMatch(/<li[\s\S]*?className="flex flex-col[^"]*sm:grid sm:grid-cols-\[/);
    const vivo = blankExpressions(ROW);
    expect(vivo, "carril horizontal en la tarjeta").not.toMatch(/overflow-x/);
    expect(vivo, "piso de ancho inventado en la tarjeta").not.toMatch(/min-w-\[\d+px\]/);
  });

  it("la lista ya no es una tabla con carril, y el módulo no inventa pisos de ancho", () => {
    // La forma anterior era `<div className="overflow-x-auto">` +
    // `<table className={cn("w-full text-left text-sm", "min-w-[640px]")}>`: 640
    // px de contenido en un carril de 222-308 px. La primera mitad de esta
    // afirmación es la que se midió; la segunda es la deuda que este arreglo
    // paga en el detector de `ux-data-table.test.ts`.
    expect(LIST, "la lista ya no abre un carril").not.toMatch(/overflow-x/);
    expect(LIST, "la lista ya no es una tabla").not.toMatch(/<table\b/);
    expect(inventedMinWidths(CLIENT), "pisos inventados en el módulo").toEqual([]);
  });

  it("el estado vacío y el alta siguen siendo los de hoy: el arreglo es sólo la fila", () => {
    // El vacío lo leyó el dueño primero («Aún no hay servicios…») y el botón
    // «Nuevo servicio» es el camino de alta: no se tocan.
    expect(CLIENT).toMatch(
      /<p className="text-sm text-text-tertiary">Aún no hay servicios en esta sede\.<\/p>/,
    );
    expect(CLIENT).toMatch(/<Button type="button" onClick=\{openCreate\} className="whitespace-nowrap">/);
  });
});

describe("cada valor apilado dice qué es (R38)", () => {
  it("las cinco líneas abren con su etiqueta, y en el teléfono esa etiqueta se lee", () => {
    expect(lineasInvisiblesEnElTelefono(ROW), "las cinco líneas del teléfono").toEqual([]);
    expect(unlabelledLeaves(ROW), "valores sin etiqueta").toEqual([]);
    expect(ROW_VALUES, "hojas de valor por columna").toHaveLength(5);
    expect(
      ROW_VALUES.filter((leaf) => labelOf(leaf) !== undefined),
      "las cinco líneas abren con su rótulo",
    ).toHaveLength(5);
  });

  it("la etiqueta es la palabra del encabezado: las dos superficies no divergen", () => {
    expect(labelledWords(ROW), "las cinco etiquetas").toEqual(expect.arrayContaining(WORDS));
    expect(labelledWords(ROW).slice().sort(), "las cinco etiquetas").toEqual(WORDS.slice().sort());
  });

  it("la etiqueta vive dentro del span del valor, no al lado", () => {
    for (const leaf of ROW_VALUES) {
      // Lo que este criterio afirma es la POSICIÓN: la etiqueta abre el markup
      // de la hoja. La otra mitad —que el `className` trajera `sm:hidden`— es un
      // token, y un token pasa con `hidden sm:hidden`; esa mitad vive, como
      // efecto, en los dos criterios de visibilidad.
      expect(leaf.rawInner, "la etiqueta abre el span del valor").toMatch(ETIQUETA_ABRE);
      expect(allSpans(leaf.rawInner).filter(isLabel), leaf.className).toHaveLength(1);
    }
  });

  it("la descripción y el botón NO son columnas: son contenido del renglón", () => {
    // La descripción cuelga de la hoja del «Servicio» y el `Editar` cuelga de la
    // de «Acciones». Sin esta regla, una hoja podría «colarse» como columna
    // nueva y la equivalencia de escritorio dejaría de ser la de hoy.
    expect(ROW_VALUES.map((leaf) => labelOf(leaf)?.inner.trim()), "orden de rótulos").toEqual([
      "Servicio:",
      "Precio:",
      "Estado:",
      "Duración:",
      "Acciones:",
    ]);
    const servicio = ROW_VALUES[0];
    expect(servicio.rawInner, "la descripción vive en la hoja del servicio").toContain(
      "text-xs text-text-tertiary",
    );
  });
});

describe("la etiqueta desaparece arriba de `sm`", () => {
  it("las cinco se apagan arriba de `sm`: el encabezado ya nombró cada columna", () => {
    expect(labelsVisibleOnDesktop(ROW), "etiquetas que se verían en escritorio").toEqual([]);
    expect(labelledWords(ROW), "las cinco etiquetas siguen estando").toHaveLength(5);
  });

  it("el encabezado, en cambio, se apaga abajo de `sm`: es su contraparte", () => {
    // La otra mitad del mismo contrato: si el encabezado también se viera en el
    // teléfono, la fila leería sus rótulos DOS veces (y «Acciones» dos veces,
    // que es peor).
    const clase = claseDelEncabezado(HEADER);
    expect(tokenQueEsconde(clase, 390), "abajo de `sm`").toBe("hidden");
    expect(tokenQueEsconde(clase, 412), "abajo de `sm`").toBe("hidden");
    expect(tokenQueEsconde(clase, 640), "arriba de `sm`").toBe("");
    expect(tokenQueEsconde(clase, 1024), "arriba de `sm`").toBe("");
  });

  it("el control negativo: quitarle `sm:hidden` a una etiqueta se acusa", () => {
    const sinVariante = ROW.replace(/(^|[\s"])sm:hidden(?=[\s"])/, "$1");
    expect(sinVariante, "el archivo real declara la variante").not.toBe(ROW);
    expect(labelsVisibleOnDesktop(sinVariante)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«Servicio:» se ve a ${vw}px`),
    );
  });
});

describe("arriba de `sm` la grilla de cinco columnas no se movió", () => {
  it("cada hoja pinea su columna, y son las cinco, una vez cada una", () => {
    expect(unpinnedLeaves(ROW)).toEqual([]);
    expect(declaredColumns(ROW).slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("el orden del DOM es el de la tarjeta móvil, y el agrupado es explícito", () => {
    // PRIORIDAD DE LA TARJETA — lo que hay que ver para editar un servicio:
    // 1. QUÉ servicio es (Servicio): sin nombre no hay edición.
    // 2. CUÁNTO cuesta y SI se ofrece (Precio + Estado): el precio es lo que se
    //    cotiza en el mostrador y el estado decide si se puede cobrar.
    // 3. CUÁNTO dura (Duración): se consulta al agendar, no al cobrar.
    // 4. LA ACCIÓN (Acciones): su propio renglón, envuelta, sin gesto horizontal.
    // Si alguien volviera a poner las hojas en orden de columna, la tarjeta
    // móvil leería Duración antes que Estado: esta guarda lo congela al revés.
    expect(declaredColumns(ROW), "columnas declaradas, en orden del DOM").toEqual([1, 2, 4, 3, 5]);
    // Y las cuatro líneas de la tarjeta son envoltorios que se borran de la
    // grilla de arriba con `sm:contents`.
    expect(allSpans(ROW).filter(isWrapper), "envoltorios sm:contents").toHaveLength(4);
  });

  it("la escala de las cinco columnas es la misma en el encabezado y en la fila", () => {
    expect((HEADER.match(literal(COLUMN_SCALE)) ?? []).length, "en el encabezado").toBe(1);
    expect((ROW.match(literal(COLUMN_SCALE)) ?? []).length, "en la fila").toBe(1);
  });
});

describe("la acción de la fila está en su campo y se alcanza sin arrastrar", () => {
  it("«Editar» vive dentro de la hoja que dice «Acciones»", () => {
    const hoja = accionesDe(ROW);
    expect(hoja, "la hoja de acciones").toBeDefined();
    const marcada = (hoja as SpanNode).rawInner;
    expect(marcada, "«Editar» está en la hoja de acciones").toContain("Editar");
    expect(marcada, "y es el único control de la fila").toMatch(/<Button\b/);
    // Y el único: una segunda acción en otra hoja sería una columna nueva.
    expect((ROW.match(/<Button\b/g) ?? []).length, "controles en la fila").toBe(1);
  });

  it("el campo de acciones se envuelve: el botón no empuja la fila", () => {
    const hoja = accionesDe(ROW) as SpanNode;
    // `flex flex-wrap` es lo que impide el desbordamiento horizontal; el
    // `sm:contents` del envoltorio lo devuelve a la grilla de arriba.
    expect(hoja.className.split(/\s+/)).toContain("flex-wrap");
    expect(hoja.className.split(/\s+/)).not.toContain("whitespace-nowrap");
    expect(hoja.className).not.toMatch(/overflow-x/);
  });

  it("el estado se lee, y el control que lo cambia se sigue tocando desde la tarjeta", () => {
    // HOY la lista no tiene un interruptor de fila: `Estado` es texto y lo que
    // activa o desactiva un servicio es la casilla «Activo» del formulario, que
    // se abre desde el `Editar` de la fila. El contrato que se afirma es que ese
    // camino sigue íntegro y alcanzable: el único control de la fila es `Editar`,
    // está en la hoja de acciones, y el formulario conserva la casilla.
    const estado = estadoDe(ROW);
    expect(estado, "la hoja de estado").toBeDefined();
    expect((estado as SpanNode).rawInner, "el valor del estado").toContain(
      'row.is_active ? "Activo" : "Inactivo"',
    );
    expect((estado as SpanNode).rawInner, "sin interruptor suelto en la fila").not.toMatch(
      /onCheckedChange|<Checkbox/,
    );
    expect(CLIENT, "la casilla «Activo» del formulario sigue existiendo").toMatch(
      /onCheckedChange=\{\(checked: boolean \| "indeterminate"\) =>/,
    );
  });

  it("ningún dato de la fila vive en un tooltip ni sale cortado", () => {
    // R25/R26 con el criterio del dueño: el `title=` no existe con el dedo, así
    // que un dato que sólo se recupera ahí es un dato que en un teléfono no se
    // puede leer. Y `truncate` corta la identidad de la fila.
    expect(titulosDe(ROW), "title= en la fila").toEqual([]);
    for (const leaf of ROW_VALUES) {
      expect(leaf.className.split(/\s+/), `«${leaf.className}»`).not.toContain("truncate");
    }
  });
});

/* --------------------------------------------------------------------------
   EL CONTROL NEGATIVO DEL PREDICADO.

   Sin esto, las guardas de arriba pasarían con un archivo vacío o con un
   marcado cualquier cosa. Acá se corre el MISMO predicado contra el marcado
   anterior al arreglo —cinco valores desnudos, sin etiqueta y sin pineo— y tiene
   que acusarlo.
   -------------------------------------------------------------------------- */

const MARKUP_ANTES = `<li
  key={row.id}
  className="border-t border-border-color dark:border-border-color-2"
>
  <span className="px-3 py-2 font-medium">Corte de cabello</span>
  <span className="px-3 py-2">$ 35.000</span>
  <span className="px-3 py-2">{row.duracion_min}–{row.duracion_max} min</span>
  <span className="px-3 py-2">{row.is_active ? "Activo" : "Inactivo"}</span>
  <span className="px-3 py-2"><button type="button">Editar</button></span>
</li>
`;

describe("el predicado no es un sello de goma", () => {
  it("el marcado viejo —cinco valores sin etiqueta y sin pineo— se acusa", () => {
    const hojaVieja = rowRegion(MARKUP_ANTES);
    expect(hojaVieja.length, "la región vieja se leyó").toBeGreaterThan(200);
    expect(valueSpans(hojaVieja), "hojas de la fila vieja").toHaveLength(5);
    expect(unlabelledLeaves(hojaVieja), "valores sin etiqueta").toHaveLength(5);
    expect(labelledWords(hojaVieja), "etiquetas del marcado viejo").toEqual([]);
    expect(unpinnedLeaves(hojaVieja), "hojas sin pineo").toEqual([
      "5 hojas sin sm:col-start-N",
      "5 hojas sin sm:row-start-1",
    ]);
    expect(labelsVisibleOnDesktop(hojaVieja), "el viejo tampoco rotula arriba").toEqual([]);
    expect(lineasInvisiblesEnElTelefono(hojaVieja), "líneas sin rótulo visible").toHaveLength(5);
    for (const fallo of lineasInvisiblesEnElTelefono(hojaVieja)) {
      expect(fallo).toContain("no abre con su propia etiqueta");
    }
    expect(accionesDe(hojaVieja), "la hoja de acciones del viejo").toBeUndefined();
    expect(titulosDe(hojaVieja), "el viejo tampoco tenía tooltips").toEqual([]);
  });

  it("la hoja del botón de la fila vieja no se contó como columna", () => {
    // `valueSpans` tiene que excluir lo que vive DENTRO de una hoja: si no, la
    // descripción y el botón entrarían como columnas y la equivalencia de
    // escritorio mentiría.
    const textos = valueSpans(rowRegion(MARKUP_ANTES)).map((leaf) =>
      leaf.rawInner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
    );
    // OJO: es `rawInner`, así que las expresiones JSX NO están vaciadas — por eso
    // la duración se lee con sus llaves. Vaciarlas sería leer otro documento.
    expect(textos).toEqual([
      "Corte de cabello",
      "$ 35.000",
      "{row.duracion_min}–{row.duracion_max} min",
      "{row.is_active ? \"Activo\" : \"Inactivo\"}",
      "Editar",
    ]);
  });

  it("una etiqueta con palabra inventada también se acusa: el vocabulario diverge", () => {
    const inventada = rowRegion(
      MARKUP_ANTES.replace(
        "Corte de cabello",
        '<span className="font-medium text-text-secondary sm:hidden">Producto: </span>Corte de cabello',
      ),
    );
    expect(labelledWords(inventada)).toEqual(["Producto"]);
    // Es decir: la comparación que hace la guarda real la rechaza.
    expect(labelledWords(inventada).slice().sort()).not.toEqual(WORDS.slice().sort());
    expect(WORDS).not.toContain("Producto");
  });
});

/* --------------------------------------------------------------------------
   LA ETIQUETA QUE SE APAGA EN EL FONDO.

   Estos son los controles que una guarda de TOKENS no tiene, y son la razón de
   afirmar el resultado: la cuenta que sólo miraba «trae `sm:hidden`» quedaba
   verde con `hidden sm:hidden` en la misma lista —el rótulo invisible en el
   teléfono, que es el defecto entero—. Cada mutación de acá es la edición que
   alguien haría en `services-client.tsx`, aplicada a una COPIA en memoria.
   -------------------------------------------------------------------------- */

describe("la etiqueta que se apaga en el fondo se acusa", () => {
  it("un `hidden` pelado en la etiqueta la esconde en los cuatro anchos del teléfono", () => {
    const fila = filaConClaseDeEtiqueta(`${etiquetaServicio(ROW).clase} hidden`);
    expect(lineasInvisiblesEnElTelefono(fila), "la etiqueta colapsada").toEqual(
      ANCHOS_MOVILES.map((vw) => `«Servicio:» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el mismo defecto NO se ve desde el escritorio: `sm:hidden` sigue
    // apagándola arriba, que es por eso que la cuenta por token quedaba verde.
    expect(labelsVisibleOnDesktop(fila), "arriba de `sm` sigue apagada").toEqual([]);
  });

  it("`hidden sm:hidden` —que SOBREVIVE a la fusión— también se acusa en el teléfono", () => {
    // El punto ciego exacto: `cn` (= `twMerge`) no funde `hidden` con
    // `sm:hidden` (mismo grupo, distinta variante), así que los dos tokens llegan
    // al DOM. La cuenta por cascada es la que lo encuentra.
    const fila = filaConClaseDeEtiqueta(`${etiquetaServicio(ROW).clase} hidden sm:hidden`);
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `«Servicio:» a ${vw}px: la esconde \`hidden\``),
    );
  });

  it("`sr-only`, `invisible`, `opacity-0` y `max-sm:hidden` apagan igual, cada uno", () => {
    const base = etiquetaServicio(ROW).clase;
    const esperado: [string, string][] = [
      ["sr-only", "sr-only"],
      ["invisible", "invisible"],
      ["opacity-0", "opacity-0"],
      ["max-sm:hidden", "max-sm:hidden"],
    ];
    for (const [utilidad, culpable] of esperado) {
      expect(
        lineasInvisiblesEnElTelefono(filaConClaseDeEtiqueta(`${base} ${utilidad}`)),
        `la etiqueta con \`${utilidad}\``,
      ).toEqual(ANCHOS_MOVILES.map((vw) => `«Servicio:» a ${vw}px: la esconde \`${culpable}\``));
    }
  });

  it("arriba de `sm`, una etiqueta que vuelve a verse se acusa en los cuatro anchos", () => {
    // La edición: `sm:hidden sm:block`. `cn` la funde en `sm:block` —no hay dos
    // clases, hay una que gana— y la cascada la encuentra prendida.
    const fila = filaConClaseDeEtiqueta(`${etiquetaServicio(ROW).clase} sm:block`);
    expect(labelsVisibleOnDesktop(fila)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«Servicio:» se ve a ${vw}px`),
    );
  });

  it("la clase FUNDIDA de un `cn` con un token del llamador también se lee", () => {
    // Una hoja escrita `className={cn("…", tableCellClass)}` no es un caso
    // teórico: es lo que pasa cuando una hoja hereda una clase compartida. Si
    // la guarda leyera sólo la primera cadena del `cn`, no vería el `hidden`
    // que llega por el token.
    const clase = etiquetaServicio(ROW).clase;
    const fila = filaConEtiqueta(
      `<span className={cn("${clase}", tableCellClass, "hidden")}>Servicio: </span>`,
    );
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `«Servicio:» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el token compartido se resuelve de verdad: `tableCellClass` entra al DOM.
    expect(TOKENS.tableCellClass, "el token del llamador se importó").toContain("align-middle");
  });

  it("un `hidden` en la HOJA, no en la etiqueta, también se acusa: el valor no está", () => {
    // Una etiqueta perfecta no dice nada si el valor que rotula se apagó. El
    // fallo se cuenta como «el valor de «Servicio:»», no como un rótulo roto.
    const fila = filaDe((fuente) =>
      fuente.replace(
        'className="break-words text-sm font-medium text-text-primary sm:col-start-1',
        'className="break-words text-sm font-medium text-text-primary hidden sm:col-start-1',
      ),
    );
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `el valor de «Servicio:» a ${vw}px: lo esconde \`hidden\``),
    );
  });

  it("quitarle la etiqueta a una línea se acusa por esa línea, no por las otras cuatro", () => {
    const fila = filaSinEtiqueta();
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual([
      expect.stringContaining("no abre con su propia etiqueta"),
    ]);
    expect(unlabelledLeaves(fila), "una hoja sin etiqueta").toHaveLength(1);
    expect(labelledWords(fila), "cuatro etiquetas de cinco").toHaveLength(4);
  });

  it("correr la etiqueta del principio de la línea se acusa aunque siga siendo la suya", () => {
    // La edición: el rótulo se mueve después del valor. Sigue siendo una
    // etiqueta, sigue con la palabra del encabezado, sigue `sm:hidden`… y la
    // línea se lee sin decir qué es. Sólo lo caza el criterio de posición.
    const fila = filaConEtiquetaAlFinal();
    expect(labelledWords(fila), "el rótulo sigue siendo el mismo").toHaveLength(5);
    expect(lineasInvisiblesEnElTelefono(fila), "y la etiqueta sigue prendida").toEqual([]);
    expect(
      valueSpans(fila)
        .filter((leaf) => !ETIQUETA_ABRE.test(leaf.rawInner))
        .map((leaf) => labelOf(leaf)?.inner.trim()),
      "hojas que ya no abren con su rótulo",
    ).toEqual(["Servicio:"]);
  });

  it("un `title=` en la fila se acusa: el dato que sólo vive en el tooltip", () => {
    const conTooltip = filaDe((fuente) =>
      fuente.replace(
        '<span className="break-words',
        '<span title="Corte de cabello" className="break-words',
      ),
    );
    expect(titulosDe(conTooltip), "el title= se coló en la fila").toHaveLength(1);
  });

  it("una columna repetida se acusa: con `sm:col-start-N` un duplicado es un empujón", () => {
    // La edición: la Duración se ancla a la columna del Servicio. Las cinco
    // hojas siguen declarando una columna y ninguna se apaga, así que sólo el
    // criterio de EQUIVALENCIA lo nota —y es el que impide que la grilla de
    // arriba sea una lista más o menos parecida a la de hoy.
    const fila = filaDe((fuente) =>
      fuente.replace("sm:col-start-3 sm:row-start-1", "sm:col-start-1 sm:row-start-1"),
    );
    expect(unpinnedLeaves(fila)).toEqual(["1 columnas repetidas"]);
    // Y las otras dos afirmaciones siguen en pie: el fallo es de pineo, no de
    // rótulo ni de visibilidad.
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual([]);
    expect(labelledWords(fila)).toHaveLength(5);
  });

  it("perder un `sm:contents` se acusa: esa línea se sale de la grilla de arriba", () => {
    // La edición: uno de los cuatro envoltorios deja de borrarse de la grilla.
    // Abajo de `sm` el renglón se sigue leyendo, así que el defecto de
    // escritorio es el que cuenta: lo delata el número de envoltorios.
    const fila = filaDe((fuente) =>
      fuente.replace(
        '<span className="flex items-center gap-2 sm:contents">\n                      <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-3',
        '<span className="flex items-center gap-2">\n                      <span className="whitespace-nowrap text-sm text-text-primary sm:col-start-3',
      ),
    );
    expect(allSpans(fila).filter(isWrapper), "envoltorios que quedaron").toHaveLength(3);
    expect(allSpans(ROW).filter(isWrapper), "en el archivo real").toHaveLength(4);
    // Y tampoco hace falta esperar al escritorio para notarlo: el envoltorio sin
    // `sm:contents` pasa a ser una HOJA más, y una hoja sin rótulo se acusa por
    // el mismo criterio de R38.
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual([
      "flex items-center gap-2: la línea no abre con su propia etiqueta",
    ]);
    expect(lineasInvisiblesEnElTelefono(ROW), "en el archivo real").toEqual([]);
  });

  it("el `className` de la etiqueta del «Servicio» es el que estas cuentas están leyendo", () => {
    // Ancla de los controles de arriba: si el archivo dejara de rotular el
    // servicio, o de declarar su clase, estos controles no estarían probando nada.
    const clase = etiquetaServicio(ROW).clase;
    expect(clase.split(/\s+/)).toEqual(expect.arrayContaining(["sm:hidden"]));
    expect(tokenQueEsconde(clase, 390), "en el teléfono").toBe("");
    expect(tokenQueEsconde(clase, 1024), "en el escritorio").toBe("sm:hidden");
  });

  it("el detector de pisos no confunde un token que CONTIENE un piso", () => {
    expect(inventedMinWidths('className="min-w-[640px]"'), "piso real").toEqual(["min-w-[640px]"]);
    expect(inventedMinWidths('className={cn("min-w-[640px]0")}'), "no es un piso").toEqual([]);
    expect(inventedMinWidths("const xmin-w-[640px] = 1; min-w-[640px]0"), "ni estos").toEqual([]);
    expect(inventedMinWidths('className="w-full min-w-full"'), "min-w-full no se inventa").toEqual([]);
    // Y un piso sólo EXPLICADO no está aplicado: el arreglo cuenta por qué se
    // quitó el piso, y el detector no puede leer su propia explicación.
    expect(inventedMinWidths("// min-w-[640px]\n/* min-w-[999px] */"), "en un comentario").toEqual([]);
  });

  it("el comentario que explica el arreglo nombra el piso que ya no está", () => {
    // Ancla del control de arriba: si el piso se fuera de acá, el detector
    // dejaría de distinguir «explicado» de «aplicado» sin que nadie lo note.
    expect(CLIENT).toMatch(/min-w-\[640px\]/);
    expect(inventedMinWidths(CLIENT), "y sin embargo no queda ninguno aplicado").toEqual([]);
  });
});