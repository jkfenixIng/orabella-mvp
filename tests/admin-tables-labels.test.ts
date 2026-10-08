import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO `cn` del que las secciones sacan la clase que llega al DOM:
// `twMerge(clsx(...))`. No es una copia de la regla de fusión: es la regla, y
// los tokens del llamador se resuelven importándolos del módulo que los
// exporta, no transcribiéndolos.
import { cn } from "@/src/components/ui/lib/utils";
import * as uiStyles from "@/src/shared/lib/ui-styles";

/* --------------------------------------------------------------------------
   R4 + R38 en las DOS listas del panel: Empleados y Usuarios.

   EL DEFECTO, MEDIDO (ver `odd/tasks/auditoria-responsive.md`, «Cómo se presenta
   la data» y el hallazgo de `/admin`): las dos secciones renderizaban una
   `<table>` dentro del carril `overflow-x-auto` de `DataTable`. `minWidth="none"`
   no inventa piso, pero las celdas `whitespace-nowrap` de seis y seis columnas
  RAN el ancho mínimo de contenido de la tabla más allá del carril, así que:

     - **20 botones de fila fuera de pantalla** en Empleados y **1** en Usuarios;
     - los enlaces de fila medían ~20 px de alto, bajo el piso duro de 24 px
       (el token compartido `linkButtonClass` ya sube a `min-h-11` por debajo de
       `sm`: el que se mide aquí es el resultado, no el token);
     - las casillas y los radios CRUDOS de estas dos secciones medían ~13×13 px,
       bajo el mismo piso de 24 px.

   LO QUE SE AFIRMA, en invariantes y por fuente. El método es el de
   `vouchers-row-labels.test.ts`, que es la REFERENCIA del patrón (la lista de
   vales ya lo resolvió, y `invoices-client.tsx` antes que ella): esta lista no
   puede inventar un segundo patrón.

     1. ABAJO DE `sm`, cada valor apilado lleva su etiqueta visible, y es la
        palabra del encabezado: el vocabulario se escribe una vez.
     2. ARRIBA DE `sm` esas etiquetas no existen —el encabezado ya nombra— y la
        fila sigue siendo la grilla de las SEIS columnas de hoy, cada una
        anclada con `sm:col-start-N`, en el orden de columnas de hoy, con el
        orden del DOM siendo el de la tarjeta móvil.
     3. NADA de lo que consulta o modifica la fila depende de un gesto
        horizontal, de un `title=` o de un texto cortado.
     4. La VISIBILIDAD se afirma sobre la clase EFECTIVA —la que sale de `cn`— y
        sobre la cascada a ese ancho, no sobre el token: `hidden`,
        `hidden sm:hidden`, `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden` y
        `sm:block` se acusan uno por uno. `hidden sm:hidden` SOBREVIVE a `twMerge`
        (mismo grupo, distinta variante), así que una cuenta por token lo
        declararía sano.
     5. El BLANCO TÁCIL de cada control nativo se afirma como la UNIÓN de su
        caja y la rebanada `::after` de su envoltorio —el mecanismo que ya eligió
        `src/components/ui/lib/checkbox.tsx`—, y esa unión tiene que medir 24×24
        tanto por debajo como por encima de `sm`.

   LO QUE ESTA GUARDA NO PUEDE VER, DICHO DE ANTEMANO: acá no hay navegador. Se
   afirma lo que el marcado PIDE. No ve un `style` en línea, ni una regla de
   `globals.css`, ni un `hidden` heredado de un ancestro, ni una variante que
   dependa del estado y no del ancho (`hover:`, `dark:`, `group-hover:`), que se
   tratan como inactivas. Lo que se midió de verdad —cero de scroll lateral,
   rótulos visibles, acciones respondiendo a `elementFromPoint` y el blanco real
   de un control nativo en los cuatro anchos— está en el informe de la unidad.
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   LAS DOS SUPERFICIES, declaradas. El vocabulario vive acá una sola vez y las
   dos secciones lo repiten: si el encabezado y la fila divergen, la guarda lo
   dice con nombres, no con un «no coincide».
   -------------------------------------------------------------------------- */

interface Seccion {
  /** El archivo real, relativo a `app/app/admin/admin-sections/`. */
  archivo: string;
  /** Cómo se llama la lista en el informe. */
  titulo: string;
  /** Las palabras del encabezado, en orden de columna: el vocabulario. */
  encabezado: string[];
  /**
   * La columna de escritorio que declara cada hoja, EN ORDEN DEL DOM. El orden
   * del DOM es el de la tarjeta móvil; el de las columnas es el de hoy.
   */
  columnasDelDOM: number[];
  /** Las hojas de acción y la palabra que las rotula. */
  acciones: Array<{ rotulo: string; botones: string[] }>;
  /** La escala de las seis columnas, escrita en el encabezado y en la fila. */
  escala: string;
  /** Cuántos controles nativos hay en el archivo (ancla anti-vacío). */
  controlesNativos: number;
}

const SECCIONES: Seccion[] = [
  {
    archivo: "employees-section.tsx",
    titulo: "Empleados",
    encabezado: ["Nombre", "Documento", "Cargo", "Estado", "Ver", "Editar"],
    // 1) Nombre. 2) Documento + Estado. 3) Cargo. 4) Ver + Editar.
    columnasDelDOM: [1, 2, 4, 3, 5, 6],
    acciones: [
      { rotulo: "Ver:", botones: ["Consultar"] },
      { rotulo: "Editar:", botones: ["Editar"] },
    ],
    escala:
      "grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)_minmax(0,1.15fr)_minmax(0,0.60fr)_minmax(0,0.55fr)_minmax(0,0.60fr)]",
    controlesNativos: 3,
  },
  {
    archivo: "users-section.tsx",
    titulo: "Usuarios",
    encabezado: ["Nombre", "Documento", "Actual", "Rol", "Guardar", "Clave"],
    columnasDelDOM: [1, 2, 3, 4, 5, 6],
    acciones: [
      { rotulo: "Guardar:", botones: ["Guardar"] },
      { rotulo: "Clave:", botones: ["Restablecer"] },
    ],
    escala:
      "grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)_minmax(0,0.95fr)_minmax(0,1.60fr)_minmax(0,0.60fr)_minmax(0,0.85fr)]",
    controlesNativos: 1,
  },
];

/** La lista abre con un `<ul>` de filas; ése es el ancla de la región. */
const LIST_ANCHOR = '<ul className="flex flex-col divide-y';

/** El contenedor de la lista abre con esta clase. */
const CONTAINER_ANCHOR = '<div className="mt-3 overflow-hidden';

/** Después de la lista termina la sección. */
const FIN_ANCHOR = "</section>";

/* --------------------------------------------------------------------------
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
   LA CLASE EFECTIVA: la que sale de `cn`, con los tokens del llamador
   resueltos importándolos.

   Una hoja escrita `className="a b hidden"` y la misma escrita
   `className={cn("a b", ghostClass, "hidden")}` llegan al DOM por el mismo
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
 * La expresión JSX que sigue a `className=`, con sus llaves balanceadas.
 * Un `[^)]*` no alcanza: un `cn(` partido en varias líneas y con un token
 * dentro contiene comas y paréntesis que no son del markup.
 */
function expresionDeClase(atributos: string): string | null {
  const marca = atributos.indexOf("className=");
  if (marca < 0) return null;
  const inicio = atributos.indexOf("{", marca);
  if (inicio < 0) return null;
  let depth = 0;
  for (let i = inicio; i < atributos.length; i += 1) {
    if (atributos[i] === "{") depth += 1;
    else if (atributos[i] === "}") {
      depth -= 1;
      if (depth === 0) return atributos.slice(inicio + 1, i);
    }
  }
  return null;
}

/**
 * La clase efectiva del elemento, desde los atributos de su apertura.
 *
 * Las TRES formas que usa el repo salen por el mismo `cn`: el literal
 * `className="…"`, la llamada `className={cn(…)}` —con un token del llamador o
 * sin él— y la plantilla `` className={`${token} …`} ``. Una forma que NO se
 * sepa resolver LANZA, en vez de devolver `""`: devolver `""` declararía sano un
 * `className` que la guarda nunca leyó, que es la forma más silenciosa de
 * mentir.
 */
function resolverClase(atributos: string): string {
  const literal = /className="([^"]*)"/.exec(atributos);
  if (literal !== null) return cn(literal[1]);
  const expresion = expresionDeClase(atributos);
  if (expresion === null) return "";
  const llamada = /^cn\(([\s\S]*)\)$/.exec(expresion.trim());
  if (llamada !== null) {
    const piezas = argumentosDeCn(llamada[1]!).map((arg) => {
      const cadena = /^"([\s\S]*)"$/.exec(arg);
      if (cadena !== null) return cadena[1]!;
      const token = TOKENS[arg];
      if (token === undefined) {
        throw new Error(`la guarda no sabe resolver el token \`${arg}\` de un cn()`);
      }
      return token;
    });
    return cn(...piezas);
  }
  const plantilla = /^`([\s\S]*)`$/.exec(expresion.trim());
  if (plantilla !== null) {
    const interpolaciones = [...plantilla[1]!.matchAll(/\$\{([^}]*)\}/g)];
    const piezas = interpolaciones.map((match) => {
      const nombre = (match[1] ?? "").trim();
      const token = TOKENS[nombre];
      if (token === undefined) {
        throw new Error(`la guarda no sabe resolver el token \`${nombre}\` de una plantilla`);
      }
      return token;
    });
    return cn(plantilla[1]!.replace(/\$\{[^}]*\}/g, " "), ...piezas);
  }
  throw new Error(`la guarda no sabe resolver el className \`${expresion.trim()}\``);
}

/* --------------------------------------------------------------------------
   Lectores. Tokens de clase completos y `<span>` balanceados: una etiqueta
   dentro de una hoja no es lo mismo que una etiqueta al lado.
   -------------------------------------------------------------------------- */

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

/**
 * Los comentarios se vacían conservando la LONGITUD, por el mismo motivo: un
 * `// min-w-[760px]` o un `<input type="checkbox">` escrito en la prosa no es
 * markup, y el detector de pisos no puede leer su propia explicación.
 */
function blankComments(source: string): string {
  let out = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const dos = source.slice(i, i + 2);
    if (!inLine && !inBlock && dos === "/*") {
      inBlock = true;
      out += "  ";
      i += 1;
      continue;
    }
    if (!inLine && !inBlock && dos === "//") {
      inLine = true;
      out += "  ";
      i += 1;
      continue;
    }
    if (inBlock && dos === "*/") {
      inBlock = false;
      out += "  ";
      i += 1;
      continue;
    }
    if (inLine && source[i] === "\n") inLine = false;
    out += inLine || inBlock ? (source[i] === "\n" ? "\n" : " ") : source[i];
  }
  return out;
}

/** El markup legible: sin comentarios y sin expresiones, con los índices vivos. */
function markupVivo(source: string): string {
  return blankComments(blankExpressions(source));
}

/**
 * El índice del `>` que CIERRA la etiqueta que abre en `desde`, saltando el que
 * vive dentro de una expresión de atributo.
 *
 * Hace falta porque `checked={sel === option.value}` lleva un `>` que NO cierra
 * nada: es el operador de comparación de JavaScript. Un `[^>]*` torpe cortaría
 * la etiqueta ahí y leería un `<input>` sin `type`, que es el modo por el que
 * un escáner de controles declara «no hay controles» sobre un archivo que sí los
 * tiene —y un `flatMap` sobre una lista vacía devuelve `[]`, que parece verde.
 */
function cierreDeTag(markup: string, desde: number): number {
  let depth = 0;
  for (let i = desde + 1; i < markup.length; i += 1) {
    const char = markup[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === ">" && depth === 0) return i;
  }
  return -1;
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
   * `<span>`) y ver lo que hay dentro de una condición —los botones de
   * `Restablecer`/`Confirmar` viven en un `? :`—.
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
 * (reemplaza uno por uno), así que el markup vivo se puede leer con los mismos
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
   Las regiones, leídas del archivo real.
   -------------------------------------------------------------------------- */

/** El bloque del encabezado: el contenedor y el `div` que nombra las columnas. */
function headerRegion(source: string): string {
  const lista = source.indexOf(LIST_ANCHOR);
  if (lista < 0) return "";
  const inicio = source.lastIndexOf(CONTAINER_ANCHOR, lista);
  return inicio < 0 ? "" : source.slice(inicio, lista);
}

/** El bloque de la lista: el contenedor, el encabezado y el `<ul>` entero. */
function listRegion(source: string): string {
  const lista = source.indexOf(LIST_ANCHOR);
  if (lista < 0) return "";
  const inicio = source.lastIndexOf(CONTAINER_ANCHOR, lista);
  const fin = source.indexOf(FIN_ANCHOR, lista);
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
   LAS HOJAS DE VALOR Y SUS RÓTULOS.
   -------------------------------------------------------------------------- */

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
 * otra hoja —el chip de estado y los botones son contenido del renglón, no
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
 * valor. Se lee del markup CRUDO —no de la lista de `<span>`— para que «la
 * etiqueta es el primer elemento que hay» no se confunda con «es el primer
 * `<span>` que se encuentra», que también pasa con el rótulo corrido al final.
 */
const ETIQUETA_ABRE = /^\s*<span\b[^>]*className=("[^"]*"|\{[^)]*\})\s*>\s*[^<>{}]+:\s*<\/span>/;

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

/** La hoja que dice «rotulo». */
function hojaDe(region: string, rotulo: string): SpanNode | undefined {
  return valueSpans(region).find((leaf) => labelOf(leaf)?.inner.trim() === rotulo);
}

/** Los `title=` de una región: dato que en un teléfono no existe (R25/R26). */
function titulosDe(region: string): string[] {
  // Sin vaciar expresiones: `title={row.full_name}` es markup de atributo, y un
  // vaciado por llaves lo escondería —justo el tooltip que este criterio caza.
  return [...blankComments(region).matchAll(/(^|[\s{])title\s*=/g)].map((match) => match[1]);
}

/** Las palabras del encabezado, en orden de columna. */
function headerWords(region: string): string[] {
  return [...region.matchAll(/<span(?:\s+className="[^"]*")?\s*>([^<]+)<\/span>/g)].map((match) =>
    match[1].trim(),
  );
}

/** La clase efectiva del encabezado: el `div` marcado `aria-hidden`. */
function claseDelEncabezado(region: string): string {
  const marca = region.indexOf('aria-hidden="true"');
  if (marca < 0) throw new Error("el encabezado no se marca `aria-hidden`");
  const fin = region.indexOf(">", marca);
  const clase = resolverClase(region.slice(marca, fin));
  if (clase === "") throw new Error("el encabezado no declara `className`");
  return clase;
}

/* --------------------------------------------------------------------------
   El detector de pisos de ancho: tokens COMPLETOS, nunca substrings. Este repo
   se quemó dos veces con grep de substring; `min-w-[760px]0` no es un piso.
   Los comentarios se borran antes, como en `ux-data-table.test.ts`: un piso
   EXPLICADO en el comentario que cuenta por qué la lista ya no es tabla no está
   aplicado.
   -------------------------------------------------------------------------- */

const CLASS_TOKEN = /[A-Za-z0-9_:./[\]%-]+/g;
const INVENTED_MIN_WIDTH = /^min-w-\[\d+px\]$/;

function inventedMinWidths(source: string): string[] {
  const found: string[] = [];
  for (const match of markupVivo(source).matchAll(CLASS_TOKEN)) {
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
   EL BLANCO TÁCIL DE LOS CONTROLES NATIVOS (criterio 5).

   MEDIDO en Chromium sobre la base con datos: `input[type=checkbox]` y
   `input[type=radio]` SIN estilo miden 13×13 px, contra el piso DURO de 24×24
   del repo (WCAG 2.5.8 AA, `docs/ux-ui-standard.md` §8).

   EL MECANISMO NO SE INVENTA AQUÍ: es el que ya eligió
   `src/components/ui/lib/checkbox.tsx` —agrandar el blanco y no la caja visible
   con una rebanada `::after` que se sale de la caja—, con la diferencia que
   mide el tipo de elemento: un `<input>` es un elemento REEMPLAZADO y no
   dibuja pseudo-elementos, así que la rebanada va en el ENVOLTORIO, que además
   es lo que activa el control (la activación por `<label>` no depende del
   pseudo-elemento). Por eso el predicado exige las TRES cosas del
   envoltorio —`relative`, `after:absolute` y una rebanada `after:-inset-*`— y
   no basta el token de la rebanada.
   -------------------------------------------------------------------------- */

/** La caja del control nativo sin estilo, en px. Medida, no inventada. */
const NATIVE_PX = 13;

/** El piso duro del repo para un blanco táctil, en px. */
const PISO_PX = 24;

/** La escala de espaciado de Tailwind: `1` = 0.25rem = 4 px. */
const PX_POR_UNIDAD = 4;

interface Rebanada {
  /** El token tal como se escribió. */
  token: string;
  /** Recorrido a la derecha y a la izquierda, en px. */
  x: number;
  /** Recorrido arriba y abajo, en px. */
  y: number;
  /** La variante de ancho, si la tiene: una rebanada con variante NO es el piso. */
  variante: string | null;
}

/**
 * La rebanada `::after` que declara una clase efectiva, o `null` si no declara
 * ninguna. Se casa el token COMPLETO (`after:-inset-1.5`), nunca un substring:
 * `after:-inset-1.5` no es `after:-inset-1`, y `after:-inset-x-1` no es
 * `-inset-1`.
 *
 * EL ORDEN DE LAS VARIANTES ES EL DE TAILWIND, Y POR ESO EL GRUPO IMPORTA:
 * `sm:after:-inset-1.5` apila de AFUERA hacia adentro, así que la variante de
 * ANCHO es la primera (`m[1]`) y `after:` es la de pseudo-elemento. Leer el
 * grupo equivocado —o leer ninguno— dejaría pasar un `max-sm:after:-inset-1.5`
 * sin Slash, que es justo el token que la primitiva NO lleva a propósito.
 */
function rebanadaDe(className: string): Rebanada | null {
  for (const token of cn(className).split(/\s+/).filter(Boolean)) {
    const m = /^(?:([a-z0-9-]+):)?after:(?:([a-z0-9-]+):)?-inset(-[xy])?-(\d+(?:\.\d+)?)$/.exec(token);
    if (m === null) continue;
    // La escala de Tailwind escribe sus pasos de forma CANÓNICA: `1.5`, no
    // `1.50`. Un token con ceros de más no es un token, y aceptarlo haría que
    // esta cuenta declarara sano un `after:-inset-1.50` que el CSS nunca aplica.
    if (String(Number(m[4])) !== m[4]) continue;
    const px = Number(m[4]) * PX_POR_UNIDAD;
    const eje = m[3] ?? "";
    return {
      token,
      x: eje === "-y" ? 0 : px,
      y: eje === "-x" ? 0 : px,
      variante: m[1] ?? null,
    };
  }
  return null;
}

/** Las variantes que SÍ son de ancho: las que la cascada de esta guarda conoce. */
const VARIANTES_DE_ANCHO = /^(max-)?(sm|md|lg|xl|2xl)$/;

interface ControlNativo {
  tipo: "checkbox" | "radio";
  /** La clase efectiva del `<input>`: la que llega al DOM. */
  clase: string;
  /** La clase efectiva del `<label>` que lo envuelve, o `null` si no hay. */
  envoltorio: string | null;
  /** El texto del envoltorio: sin él no hay «rótulo + control» que leer. */
  rotulo: string;
  /**
   * Que el envoltorio PINTE algo junto al control. El texto puede venir de una
   * expresión —`{option.label}` en la lista de roles—, así que la cuenta mira
   * que haya contenido, no que haya una cadena literal: exigir la cadena sería
   * exigir una constante de copy que nadie necesita.
   */
  conTexto: boolean;
  /** El índice del `<input>` en el fuente real, para mutarlo. */
  indice: number;
}

/**
 * Los controles nativos de un archivo y el envoltorio `<label>` de cada uno.
 *
 * Un solo recorrido: la pila de `<label>` abiertos y, en cada `<input>` de tipo
 * `checkbox`/`radio`, el de arriba es el que lo envuelve. Se lee el fuente con
 * los COMENTARIOS vaciados (un `<input>` en la prosa no es un control) pero con
 * las expresiones VIVAS, porque los controles de estas secciones viven dentro de
 * un `.map(...)`; el corte de cada etiqueta lo hace `cierreDeTag`, que salta el
 * `>` de las expresiones de atributo.
 */
function nativeControls(source: string): ControlNativo[] {
  const markup = blankComments(source);
  const pila: Array<{ apertura: string; desde: number }> = [];
  const controles: ControlNativo[] = [];
  for (const match of markup.matchAll(/<label\b|<\/label>|<input\b/g)) {
    const etiqueta = match[0];
    if (etiqueta === "</label>") {
      pila.pop();
      continue;
    }
    const fin = cierreDeTag(markup, match.index);
    if (fin === -1) continue;
    const apertura = markup.slice(match.index, fin + 1);
    if (etiqueta === "<label") {
      pila.push({ apertura, desde: match.index });
      continue;
    }
    const tipo = /\btype="(checkbox|radio)"/.exec(apertura)?.[1];
    if (tipo === undefined) continue;
    const envoltorio = pila[pila.length - 1];
    let rotulo = "";
    let conTexto = false;
    if (envoltorio !== undefined) {
      const cierre = markup.indexOf("</label>", match.index);
      const contenido = markup.slice(envoltorio.desde + envoltorio.apertura.length, cierre);
      rotulo = blankExpressions(contenido)
        .replace(/<[^>]*>/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      conTexto = rotulo !== "" || /\{[^{}]+\}/.test(contenido);
    }
    controles.push({
      tipo: tipo as "checkbox" | "radio",
      clase: resolverClase(apertura),
      envoltorio: envoltorio === undefined ? null : resolverClase(envoltorio.apertura),
      rotulo,
      conTexto,
      indice: match.index,
    });
  }
  return controles;
}

/** Clases que deformarían el control o lo sacarían de juego. */
const DEFORMES = [
  { patron: /(^|\s)appearance-none(\s|$)/, motivo: "dejaría de verse como el control nativo del sistema" },
  { patron: /(^|\s)(?:[a-z0-9-]+:)?scale-\d/, motivo: "escalar el control cambia lo que se ve y su lugar en el flujo" },
  { patron: /(^|\s)(?:[a-z0-9-]+:)?[hw]-\d/, motivo: "fijar `h`/`w` en el nativo lo deforma" },
  { patron: /(^|\s)(?:[a-z0-9-]+:)?pointer-events-none(\s|$)/, motivo: "el control dejaría de recibir el toque" },
];

/**
 * Las fallas de BLANCO TÁCIL de un control nativo, por criterio. Cada criterio
 * falla por su cuenta, y ninguno se conforma con el token: se lee la unión
 * efectiva de la caja del control y la rebanada que declara su envoltorio.
 */
function blancoTactilFallas(control: ControlNativo): string[] {
  const fallas: string[] = [];
  const donde = `${control.tipo} «${control.rotulo || "rótulo de una expresión"}»`;
  for (const vw of ANCHOS_MOVILES) {
    const causa = tokenQueEsconde(control.clase, vw);
    if (causa !== "") fallas.push(`${donde}: a ${vw}px el control lo esconde \`${causa}\``);
  }
  for (const { patron, motivo } of DEFORMES) {
    for (const token of cn(control.clase).split(/\s+/).filter(Boolean)) {
      if (patron.test(token)) fallas.push(`${donde}: \`${token}\` — ${motivo}`);
    }
  }
  if (control.envoltorio === null) {
    fallas.push(`${donde}: no está dentro de un <label>, así que su rebanada no sería activable`);
    return fallas;
  }
  if (!control.conTexto) {
    fallas.push(`${donde}: el envoltorio no pinta nada junto al control`);
  }
  for (const vw of ANCHOS_MOVILES) {
    const causa = tokenQueEsconde(control.envoltorio, vw);
    if (causa !== "") fallas.push(`${donde}: a ${vw}px el envoltorio lo esconde \`${causa}\``);
  }
  const tokens = cn(control.envoltorio).split(/\s+/).filter(Boolean);
  if (!tokens.includes("relative")) {
    fallas.push(`${donde}: el envoltorio no es \`relative\`, así que el ::after no se mide contra él`);
  }
  if (!tokens.some((token) => /^((?:[a-z0-9-]+):)?after:absolute$/.test(token))) {
    fallas.push(`${donde}: el envoltorio no declara \`after:absolute\``);
  }
  const rebanada = rebanadaDe(control.envoltorio);
  if (rebanada === null) {
    fallas.push(`${donde}: el envoltorio no declara una rebanada \`after:-inset-*\``);
    return fallas;
  }
  if (rebanada.variante !== null) {
    fallas.push(
      VARIANTES_DE_ANCHO.test(rebanada.variante)
        ? `${donde}: la rebanada \`${rebanada.token}\` sólo aplica \`${rebanada.variante}:\`: el piso de ${PISO_PX} px es duro y no tiene excepción de escritorio`
        : `${donde}: la rebanada \`${rebanada.token}\` depende de \`${rebanada.variante}:\`, que es un estado y no el ancho: el \`::after\` no está dibujado siempre`,
    );
  }
  const ancho = NATIVE_PX + 2 * rebanada.x;
  const alto = NATIVE_PX + 2 * rebanada.y;
  if (ancho < PISO_PX || alto < PISO_PX) {
    fallas.push(
      `${donde}: el blanco táctil mide ${ancho}×${alto} px (la unión de su caja de ${NATIVE_PX}×${NATIVE_PX} con la rebanada \`${rebanada.token}\`), bajo el piso de ${PISO_PX}`,
    );
  }
  return fallas;
}

/** Las fallas de blanco táctil de un archivo entero, una por control. */
function blancosTactilesFallas(source: string): string[] {
  return nativeControls(source).flatMap((control) => blancoTactilFallas(control));
}

/* --------------------------------------------------------------------------
   El archivo real, leído de a uno.
   -------------------------------------------------------------------------- */

const FUENTES = SECCIONES.map((seccion) => ({
  seccion,
  fuente: readFileSync(
    join(process.cwd(), "app", "admin", "admin-sections", seccion.archivo),
    "utf8",
  ),
}));

/* --------------------------------------------------------------------------
   La fila que la guarda lee de un FUENTE mutado en memoria —el archivo del
   repositorio no se toca, ni para escribir ni para dejar rastro— y esa copia
   pasa por la cadena completa: `rowRegion` → `blankExpressions` → predicados.
   Una mutación que sólo tocara el tramo ya extraído no probaría que los
   anclajes siguen leyéndolo.
   -------------------------------------------------------------------------- */

function filaDe(fuente: string, mutacion: (texto: string) => string): string {
  const texto = mutacion(fuente);
  if (texto === fuente) throw new Error("la mutación no cambió el fuente");
  const fila = rowRegion(texto);
  if (fila.length === 0) throw new Error("la fila mutada no se leyó");
  return fila;
}

/* ==========================================================================
   0. ANTI-VACÍO: las regiones se leen del archivo real.
   ========================================================================== */

describe("las dos listas del panel: anti-vacío", () => {
  it.each(SECCIONES.map((seccion) => [seccion.titulo, seccion.archivo] as const))(
    "%s: el archivo, el encabezado, la lista y la fila se leyeron de verdad",
    (_titulo, archivo) => {
      const fuente = FUENTES.find((entrada) => entrada.seccion.archivo === archivo)?.fuente ?? "";
      expect(fuente.length, "el archivo").toBeGreaterThan(8_000);
      expect(headerRegion(fuente).length, "bloque del encabezado").toBeGreaterThan(300);
      expect(listRegion(fuente).length, "bloque de la lista").toBeGreaterThan(1_000);
      expect(rowRegion(fuente).length, "bloque de la fila").toBeGreaterThan(800);
      expect(headerRegion(fuente), "el encabezado se abre en grilla arriba de `sm`").toContain("sm:grid");
      expect(rowRegion(fuente), "la fila se abre en grilla de seis columnas").toContain("sm:grid-cols-[");
      expect(fuente, "la lista es una lista, no una tabla").not.toMatch(/<table\b/);
    },
  );

  it.each(SECCIONES.map((seccion) => [seccion.titulo, seccion.archivo] as const))(
    "%s: la fila es una tarjeta abajo y una grilla de seis arriba, sin carril de scroll",
    (_titulo, archivo) => {
      const fila = rowRegion(FUENTES.find((e) => e.seccion.archivo === archivo)?.fuente ?? "");
      expect(fila).toMatch(/<li[\s\S]*?className="flex flex-col[^"]*sm:grid sm:grid-cols-\[/);
      const vivo = markupVivo(fila);
      expect(vivo, "carril horizontal en la tarjeta").not.toMatch(/overflow-x/);
      expect(vivo, "piso de ancho inventado en la tarjeta").not.toMatch(/min-w-\[\d+px\]/);
    },
  );

  it.each(SECCIONES.map((seccion) => [seccion.titulo, seccion.archivo] as const))(
    "%s: la lista ya no es una tabla con carril, y el módulo no inventa pisos de ancho",
    (_titulo, archivo) => {
      const fuente = FUENTES.find((e) => e.seccion.archivo === archivo)?.fuente ?? "";
      const lista = listRegion(fuente);
      expect(lista, "la lista ya no abre un carril").not.toMatch(/overflow-x/);
      expect(lista, "la lista ya no es una tabla").not.toMatch(/<table\b/);
      expect(inventedMinWidths(fuente), "pisos inventados en el módulo").toEqual([]);
    },
  );
});

/* ==========================================================================
   1. CADA VALOR APILADO DICE QUÉ ES (R38).
   ========================================================================== */

describe.each(SECCIONES)("$titulo: cada valor apilado dice qué es", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";
  const FILA = rowRegion(fuente);
  const HOJAS = valueSpans(FILA);

  it("las seis líneas abren con su etiqueta, y en el teléfono esa etiqueta se lee", () => {
    expect(lineasInvisiblesEnElTelefono(FILA), "las seis líneas del teléfono").toEqual([]);
    expect(HOJAS, "hojas de valor por columna").toHaveLength(6);
    expect(
      HOJAS.filter((hoja) => isLabel(firstChildOf(hoja) ?? ({ inner: "" } as SpanNode))),
      "las seis líneas abren con su rótulo",
    ).toHaveLength(6);
  });

  it("la etiqueta es la palabra del encabezado: las dos superficies no divergen", () => {
    expect(headerWords(headerRegion(fuente)), "las palabras del encabezado").toEqual(seccion.encabezado);
    expect(labelledWords(FILA).slice().sort(), "las seis etiquetas").toEqual(seccion.encabezado.slice().sort());
  });

  it("la etiqueta vive dentro del span del valor, no al lado", () => {
    for (const hoja of HOJAS) {
      // Lo que este criterio afirma es la POSICIÓN: la etiqueta abre el markup
      // de la hoja. La otra mitad —que el `className` trajera `sm:hidden`— es un
      // token, y un token pasa con `hidden sm:hidden`; esa mitad vive, como
      // efecto, en los dos criterios de visibilidad.
      expect(hoja.rawInner, "la etiqueta abre el span del valor").toMatch(ETIQUETA_ABRE);
      expect(allSpans(hoja.rawInner).filter(isLabel), hoja.className).toHaveLength(1);
    }
  });

  it("los botones de la fila NO son columnas: son contenido de su renglón", () => {
    // Sin esta regla, una hoja podría «colarse» como columna nueva y la
    // equivalencia de escritorio dejaría de ser la de hoy. Y el orden que se
    // afirma es el del DOM —el de la tarjeta móvil—, derivado de las columnas
    // declaradas, no una tercera lista escrita a mano.
    for (const accion of seccion.acciones) {
      for (const boton of accion.botones) {
        expect(FILA, `«${boton}» está en la fila`).toContain(boton);
      }
    }
    expect(
      HOJAS.map((hoja) => labelOf(hoja)?.inner.trim()),
      "orden de rótulos, en orden del DOM",
    ).toEqual(seccion.columnasDelDOM.map((columna) => `${seccion.encabezado[columna - 1]}:`));
  });
});

/* ==========================================================================
   2. LA ETIQUETA DESAPARECE ARRIBA DE `sm`.
   ========================================================================== */

describe.each(SECCIONES)("$titulo: la etiqueta desaparece arriba de `sm`", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";
  const FILA = rowRegion(fuente);

  it("las seis se apagan arriba de `sm`: el encabezado ya nombró cada columna", () => {
    expect(labelsVisibleOnDesktop(FILA), "etiquetas que se verían en escritorio").toEqual([]);
    expect(labelledWords(FILA), "las seis etiquetas siguen estando").toHaveLength(6);
  });

  it("el encabezado, en cambio, se apaga abajo de `sm`: es su contraparte", () => {
    // La otra mitad del mismo contrato: si el encabezado también se viera en el
    // teléfono, la fila leería sus rótulos DOS veces (y «Acciones» dos veces,
    // que es peor).
    const clase = claseDelEncabezado(headerRegion(fuente));
    for (const vw of ANCHOS_MOVILES) {
      expect(tokenQueEsconde(clase, vw), `abajo de \`sm\` (${vw})`).toBe("hidden");
    }
    for (const vw of ANCHOS_ESCRITORIO) {
      expect(tokenQueEsconde(clase, vw), `arriba de \`sm\` (${vw})`).toBe("");
    }
  });
});

/* ==========================================================================
   3. ARRIBA DE `sm` LA GRILLA DE SEIS COLUMNAS NO SE MOVIDÓ.
   ========================================================================== */

describe.each(SECCIONES)("$titulo: arriba de `sm` la grilla no se movió", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";
  const FILA = rowRegion(fuente);
  const HOJAS = valueSpans(FILA);

  it("cada hoja pinea su columna, y son las seis, una vez cada una", () => {
    expect(unpinnedLeaves(FILA)).toEqual([]);
    expect(
      HOJAS.map((hoja) => Number(/sm:col-start-(\d)/.exec(hoja.className)?.[1])).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("el orden del DOM es el de la tarjeta móvil, y el agrupado es explícito", () => {
    // Si alguien volviera a poner las hojas en orden de columna, la tarjeta
    // móvil leería los valores en otro orden: esta guarda lo congela.
    expect(
      HOJAS.map((hoja) => Number(/sm:col-start-(\d)/.exec(hoja.className)?.[1])),
      "columnas declaradas, en orden del DOM",
    ).toEqual(seccion.columnasDelDOM);
    // Y las cuatro líneas de la tarjeta son envoltorios que se borran de la
    // grilla de arriba con `sm:contents`.
    expect(allSpans(FILA).filter(isWrapper), "envoltorios sm:contents").toHaveLength(4);
  });

  it("la escala de las seis columnas es la misma en el encabezado y en la fila", () => {
    expect((headerRegion(fuente).match(literal(seccion.escala)) ?? []).length, "en el encabezado").toBe(1);
    expect((FILA.match(literal(seccion.escala)) ?? []).length, "en la fila").toBe(1);
  });
});

/* ==========================================================================
   4. LA ACCIÓN DE LA FILA ESTÁ EN SU CAMPO.
   ========================================================================== */

describe.each(SECCIONES)("$titulo: la acción se alcanza sin arrastrar", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";
  const FILA = rowRegion(fuente);

  it.each(seccion.acciones.map((accion) => [accion.rotulo, accion] as const))(
    "la hoja «%s» contiene su acción, y se envuelve",
    (_rotulo, accion) => {
      const hoja = hojaDe(FILA, accion.rotulo);
      expect(hoja, `la hoja «${accion.rotulo}»`).toBeDefined();
      const marcada = (hoja as SpanNode).rawInner;
      for (const boton of accion.botones) {
        expect(marcada, `«${boton}» está en su hoja`).toContain(boton);
      }
      // Los botones de fila toman el token COMPARTIDO, que es el que sube a
      // `min-h-11` por debajo de `sm`: el piso de 44 px llega por el token, y lo
      // que se midió en el navegador es el resultado.
      expect(marcada, "el botón toma el token compartido").toContain("linkButtonClass");
    },
  );

  it("las hojas de acción se envuelven: los botones no empujan la fila", () => {
    for (const accion of seccion.acciones) {
      const hoja = hojaDe(FILA, accion.rotulo) as SpanNode;
      const tokens = hoja.className.split(/\s+/);
      expect(tokens, `«${accion.rotulo}»`).toContain("flex-wrap");
      expect(tokens, `«${accion.rotulo}»`).not.toContain("whitespace-nowrap");
      expect(hoja.className, `«${accion.rotulo}»`).not.toMatch(/overflow-x/);
    }
  });

  it("ningún dato de la fila vive en un tooltip ni sale cortado", () => {
    // R25/R26 con el criterio del dueño: el `title=` no existe con el dedo, así
    // que un dato que sólo se recupera ahí es un dato que en un teléfono no se
    // puede leer. Y `truncate` corta la identidad de la fila.
    expect(titulosDe(FILA), "title= en la fila").toEqual([]);
    for (const hoja of valueSpans(FILA)) {
      expect(hoja.className.split(/\s+/), `«${hoja.className}»`).not.toContain("truncate");
    }
  });
});

/* ==========================================================================
   5. EL BLANCO TÁCIL DE LOS CONTROLES NATIVOS.
   ========================================================================== */

describe.each(SECCIONES)("$titulo: el blanco táctil de los controles nativos", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";

  it("todos los controles nativos del archivo llegan a 24 px de blanco", () => {
    expect(blancosTactilesFallas(fuente), `controles nativos de ${seccion.archivo}`).toEqual([]);
  });

  it("el archivo declara los controles nativos que la cuenta espera", () => {
    // Ancla anti-vacío: un `flatMap` sobre una lista vacía también devuelve
    // `[]`, así que sin este conteo el criterio de arriba no probaría nada.
    const controles = nativeControls(fuente);
    expect(controles.length, "controles nativos").toBe(seccion.controlesNativos);
    expect(controles.filter((control) => control.tipo === "checkbox").length, "casillas").toBe(
      seccion.archivo === "employees-section.tsx" ? 2 : 0,
    );
    expect(controles.filter((control) => control.tipo === "radio").length, "radios").toBe(
      seccion.archivo === "employees-section.tsx" ? 1 : 1,
    );
  });

  it("cada control se lee con su envoltorio y su rótulo: el escáner no está vacío", () => {
    for (const control of nativeControls(fuente)) {
      expect(control.envoltorio, `${control.tipo}: envoltorio`).not.toBeNull();
      expect(control.conTexto, `${control.tipo}: pinta algo junto al control`).toBe(true);
    }
  });
});

/* ==========================================================================
   6. EL PREDICADO NO ES UN SELLO DE GOMA.

   Acá se corre el MISMO predicado contra el marcado de ANTES del arreglo y
   tiene que acusarlo; y contra mutaciones del fuente real, una por criterio.
   ========================================================================== */

/** La fila que las dos secciones renderizaban: `<td>` dentro del carril. */
const MARKUP_ANTES_EMPLEADOS = `<tr key={row.id} className={tableRowClass}>
  <td className="max-w-48 truncate whitespace-nowrap py-1 pr-3" title={row.full_name}>
    {row.full_name}
  </td>
  <td className="whitespace-nowrap py-1 pr-3">{row.document}</td>
  <td className="whitespace-nowrap py-1 pr-3">{row.position ?? "—"}</td>
  <td className="whitespace-nowrap py-1 pr-3">{row.is_active ? "Activo" : "Inactivo"}</td>
  <td className="whitespace-nowrap py-1 pr-3">
    <button type="button" onClick={() => setDialog({ mode: "view", id: row.id })} className={linkButtonClass}>
      Consultar
    </button>
  </td>
  <td className="whitespace-nowrap py-1 pr-3">
    <button type="button" onClick={() => openEdit(row)} className={linkButtonClass}>Editar</button>
  </td>
</tr>`;

/** Una fila YA apilada pero SIN rótulos: la migración a medias. */
const MARKUP_ANTES_CARD = `<li key={row.id} className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
  <span className="break-words text-sm font-medium text-text-primary">Andrés Quintero</span>
  <span className="text-sm text-text-primary">10000001</span>
  <span className="text-sm text-text-primary">Estilista</span>
  <span className="text-sm text-text-primary">Activo</span>
  <span className="flex flex-wrap items-center gap-2">
    <button type="button" className={linkButtonClass}>Consultar</button>
    <button type="button" className={linkButtonClass}>Editar</button>
  </span>
</li>`;

describe("el predicado no es un sello de goma", () => {
  it("la fila VIEJA —`<td>` en un carril— no tiene ni una hoja que rotular", () => {
    // Y AQUÍ ESTÁ EL PUNTO CIEGO DE ESTA FAMILIA, DICHO DE ANTEMANO: sobre el
    // markup viejo, `valueSpans` devuelve CERO hojas, así que TODOS los
    // predicados de hoja devolverían `[]` y la guarda pasaría sin mirar nada. Lo
    // que lo caza no es un predicado, es la PUERTA DE NO VACUIDAD: seis hojas,
    // seis rótulos, seis columnas. Por eso hay una, y por eso se afirma.
    expect(valueSpans(MARKUP_ANTES_EMPLEADOS), "hojas de la fila vieja").toHaveLength(0);
    expect(labelledWords(MARKUP_ANTES_EMPLEADOS), "rótulos de la fila vieja").toEqual([]);
    expect(unpinnedLeaves(MARKUP_ANTES_EMPLEADOS), "pines de la fila vieja").toEqual([]);
    expect(titulosDe(MARKUP_ANTES_EMPLEADOS), "el `title=` que sí tenía").toHaveLength(1);
    // La puerta: la fila vieja NO tiene las seis hojas que el contrato exige.
    expect(valueSpans(MARKUP_ANTES_EMPLEADOS)).not.toHaveLength(6);
  });

  it("una fila apilada SIN rótulos se acusa hoja por hoja", () => {
    const hojas = valueSpans(MARKUP_ANTES_CARD);
    expect(hojas.length, "hojas de la tarjeta a medias").toBeGreaterThan(0);
    expect(unlabelledLeaves(MARKUP_ANTES_CARD), "valores sin etiqueta").toHaveLength(hojas.length);
    expect(labelledWords(MARKUP_ANTES_CARD), "rótulos").toEqual([]);
    expect(unpinnedLeaves(MARKUP_ANTES_CARD)).toEqual([
      `${hojas.length} hojas sin sm:col-start-N`,
      `${hojas.length} hojas sin sm:row-start-1`,
    ]);
    for (const fallo of lineasInvisiblesEnElTelefono(MARKUP_ANTES_CARD)) {
      expect(fallo).toContain("no abre con su propia etiqueta");
    }
  });

  it("el detector de pisos no confunde un token que CONTIENE un piso", () => {
    expect(inventedMinWidths('className="min-w-[760px]"'), "piso real").toEqual(["min-w-[760px]"]);
    expect(inventedMinWidths('className={cn("min-w-[760px]0")}'), "no es un piso").toEqual([]);
    expect(inventedMinWidths("const xmin-w-[760px] = 1; min-w-[760px]0"), "ni estos").toEqual([]);
    expect(inventedMinWidths('className="w-full min-w-full"'), "min-w-full no se inventa").toEqual([]);
    expect(inventedMinWidths("// min-w-[760px]\n/* min-w-[999px] */"), "en la prosa").toEqual([]);
  });

  it("las dos secciones no dejan el carril del primitivo, y no inventan un piso", () => {
    // Ancla del control de arriba: el arreglo saca el carril `overflow-x-auto`
    // que arrastraba las veinte acciones de Empleados, y lo que lo sostenía eran
    // `whitespace-nowrap` sobre celdas de contenido largo —no un `min-w-[Npx]`,
    // que estas dos secciones nunca tuvieron: iban por `minWidth="none"`. Por eso
    // la deuda que se paga acá NO es un piso, es el carril, y el detector de
    // pisos tiene que seguir en cero.
    for (const entrada of FUENTES) {
      expect(inventedMinWidths(entrada.fuente), `${entrada.seccion.archivo}: pisos`).toEqual([]);
      expect(listRegion(entrada.fuente), `${entrada.seccion.archivo}: carril`).not.toMatch(/overflow-x/);
      expect(rowRegion(entrada.fuente), `${entrada.seccion.archivo}: carril en la fila`).not.toMatch(/overflow-x/);
    }
  });
});

/* --------------------------------------------------------------------------
   LA ETIQUETA QUE SE APAGA EN EL FONDO.

   Estos son los controles que una guarda de TOKENS no tiene, y son la razón de
   afirmar el resultado: la cuenta que sólo miraba «trae `sm:hidden`» quedaba
   verde con `hidden sm:hidden` en la misma fila —el rótulo invisible en el
   teléfono, que es el defecto entero—. Cada mutación de acá es la edición que
   alguien haría en el archivo, aplicada a una COPIA en memoria.
   -------------------------------------------------------------------------- */

describe.each(SECCIONES)("$titulo: la etiqueta que se apaga en el fondo se acusa", (seccion) => {
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";

  /**
   * La primera hoja de la fila, con su rótulo, LEÍDA DENTRO del test.
   *
   * Nada de esto puede LANZARSE al COLECTAR el suite: con el markup viejo —una
   * `<table>` de `<td>`— no hay ninguna hoja que leer, y una excepción al
   * coleccionarse metería los CERO tests de rojo en vez de un fallo que dice
   * qué falta. Acá la falta se reporta como fallo del test que la pidió.
   */
  function primeraHoja(): { hoja: SpanNode; rotulo: string; etiqueta: SpanNode } {
    const hoja = valueSpans(rowRegion(fuente))[0];
    if (hoja === undefined) {
      throw new Error(`${seccion.archivo}: la fila no abre con ninguna hoja de valor rotulada`);
    }
    const etiqueta = labelOf(hoja);
    if (etiqueta === undefined) {
      throw new Error(`${seccion.archivo}: la primera hoja de la fila no tiene rótulo`);
    }
    return { hoja, rotulo: etiqueta.inner, etiqueta };
  }

  /** La fila con la clase de esa etiqueta sustituida por `clase`. */
  function filaConClaseDeEtiqueta(clase: string): string {
    const { rotulo } = primeraHoja();
    const desde = fuente.indexOf(`>${rotulo}</span>`);
    if (desde < 0) throw new Error(`la fila no abre con la etiqueta \`${rotulo}\``);
    const apertura = fuente.lastIndexOf("<span", desde);
    return filaDe(fuente, (texto) => {
      const largo = `>${rotulo}</span>`.length;
      return (
        texto.slice(0, apertura) +
        `<span className="${clase}">${rotulo}</span>` +
        texto.slice(desde + largo)
      );
    });
  }

  it("un `hidden` pelado en la etiqueta la esconde en los cuatro anchos del teléfono", () => {
    const { hoja, rotulo } = primeraHoja();
    const fila = filaConClaseDeEtiqueta(`${hoja.className.replace(/sm:hidden/g, "")} hidden`);
    expect(lineasInvisiblesEnElTelefono(fila), "la etiqueta colapsada").toEqual(
      ANCHOS_MOVILES.map((vw) => `«${rotulo.trim()}» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el mismo defecto NO se ve desde el escritorio: `sm:hidden` sigue
    // apagándola arriba, que es por eso que la cuenta por token quedaba verde.
    expect(labelsVisibleOnDesktop(fila), "arriba de `sm` sigue apagada").toEqual([]);
  });

  it("`hidden sm:hidden` —que SOBREVIVE a la fusión— también se acusa en el teléfono", () => {
    const { hoja, rotulo } = primeraHoja();
    // El punto ciego exacto: `cn` (= `twMerge`) no funde `hidden` con
    // `sm:hidden` (mismo grupo, distinta variante), así que los dos tokens llegan
    // al DOM. La cuenta por cascada es la que lo encuentra.
    expect(cn(`${hoja.className} hidden sm:hidden`).split(/\s+/)).toEqual(
      expect.arrayContaining(["hidden", "sm:hidden"]),
    );
    const fila = filaConClaseDeEtiqueta(`${hoja.className} hidden sm:hidden`);
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `«${rotulo.trim()}» a ${vw}px: la esconde \`hidden\``),
    );
  });

  it("`sr-only`, `invisible`, `opacity-0` y `max-sm:hidden` apagan igual, cada uno", () => {
    const { hoja, rotulo } = primeraHoja();
    const esperado: Array<[string, string]> = [
      ["sr-only", "sr-only"],
      ["invisible", "invisible"],
      ["opacity-0", "opacity-0"],
      ["max-sm:hidden", "max-sm:hidden"],
    ];
    for (const [utilidad, culpable] of esperado) {
      expect(
        lineasInvisiblesEnElTelefono(filaConClaseDeEtiqueta(`${hoja.className} ${utilidad}`)),
        `la etiqueta con \`${utilidad}\``,
      ).toEqual(ANCHOS_MOVILES.map((vw) => `«${rotulo.trim()}» a ${vw}px: la esconde \`${culpable}\``));
    }
  });

  it("arriba de `sm`, una etiqueta que vuelve a verse se acusa en los cuatro anchos", () => {
    // La edición: `sm:hidden sm:block`. `cn` la funde en `sm:block` —no hay dos
    // clases, hay una que gana— y la cascada la encuentra prendida.
    const { hoja, rotulo } = primeraHoja();
    const fila = filaConClaseDeEtiqueta(`${hoja.className} sm:block`);
    expect(labelsVisibleOnDesktop(fila)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«${rotulo.trim()}» se ve a ${vw}px`),
    );
  });

  it("la clase FUNDIDA de un `cn` con un token del llamador también se lee", () => {
    // Una etiqueta escrita `className={cn("…", tableHeaderClass, "hidden")}` no
    // es un caso teórico: es lo que pasa cuando una hoja hereda una clase
    // compartida. Si la guarda leyera sólo la primera cadena del `cn`, no vería
    // el `hidden` que llega por el token.
    const { hoja, rotulo } = primeraHoja();
    const clase = hoja.className.replace(/sm:hidden/g, "");
    const fila = filaDe(fuente, (texto) => {
      const desde = texto.indexOf(`>${rotulo}</span>`);
      const apertura = texto.lastIndexOf("<span", desde);
      const largo = `>${rotulo}</span>`.length;
      return (
        texto.slice(0, apertura) +
        `<span className={cn("${clase}", tableHeaderClass, "hidden")}>${rotulo}</span>` +
        texto.slice(desde + largo)
      );
    });
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `«${rotulo.trim()}» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el token compartido se resuelve de verdad: `tableHeaderClass` entra al DOM.
    expect(TOKENS.tableHeaderClass, "el token del llamador se importó").toContain("bg-surface-hover");
  });

  it("un `hidden` en la HOJA, no en la etiqueta, también se acusa: el valor no está", () => {
    // Una etiqueta perfecta no dice nada si el valor que rotula se apagó. El
    // fallo se cuenta como «el valor de «…»», no como un rótulo roto. Y la
    // edición se hace sobre la APERTURA de ESA hoja —`hoja.start` es el
    // contenido, y el `<span` de la hoja está justo antes—: mutar el primer
    // `className` de la fila habría apagado el ENVOLTORIO, que es otro
    // criterio, y esta prueba pasaría sin probar el suyo.
    const { hoja, rotulo } = primeraHoja();
    const fila = filaDe(fuente, (texto) => {
      const actual = rowRegion(texto);
      const inicio = texto.indexOf(actual);
      const apertura = actual.lastIndexOf("<span", hoja.start);
      const largo = actual.indexOf(">", apertura) + 1;
      const oculta = actual.slice(apertura, largo).replace('className="', 'className="hidden ');
      if (oculta === actual.slice(apertura, largo)) {
        throw new Error("la hoja no abre con un `className` literal");
      }
      const mutada =
        actual.slice(0, apertura) + oculta + actual.slice(largo);
      return texto.slice(0, inicio) + mutada + texto.slice(inicio + actual.length);
    });
    expect(
      valueSpans(fila)[0]?.className,
      "la hoja quedó apagada, no el envoltorio",
    ).toContain("hidden");
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual(
      ANCHOS_MOVILES.map((vw) => `el valor de «${rotulo.trim()}» a ${vw}px: lo esconde \`hidden\``),
    );
  });

  it("quitarle la etiqueta a una línea se acusa por esa línea, no por las otras cinco", () => {
    const { rotulo } = primeraHoja();
    const fila = filaDe(fuente, (texto) => {
      const desde = texto.indexOf(`>${rotulo}</span>`);
      const apertura = texto.lastIndexOf("<span", desde);
      const largo = `>${rotulo}</span>`.length;
      return texto.slice(0, apertura) + texto.slice(desde + largo);
    });
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual([
      expect.stringContaining("no abre con su propia etiqueta"),
    ]);
    expect(unlabelledLeaves(fila), "una hoja sin etiqueta").toHaveLength(1);
    expect(labelledWords(fila), "cinco etiquetas de seis").toHaveLength(5);
  });

  it("correr la etiqueta del principio de la línea se acusa aunque siga siendo la suya", () => {
    // La edición: el rótulo se mueve después del valor. Sigue siendo una
    // etiqueta, sigue con la palabra del encabezado, sigue `sm:hidden`… y la
    // línea se lee sin decir qué es. Sólo lo caza el criterio de posición.
    const { hoja, rotulo } = primeraHoja();
    const fila = filaDe(fuente, (texto) => {
      const desde = texto.indexOf(hoja.raw);
      const apertura = hoja.rawInner.indexOf("<span");
      const cierre = hoja.rawInner.indexOf("</span>", apertura) + "</span>".length;
      const etiqueta = hoja.rawInner.slice(apertura, cierre);
      const resto = hoja.rawInner.replace(etiqueta, "");
      return texto.slice(0, desde) + hoja.raw.replace(hoja.rawInner, `${resto}${etiqueta}`) + texto.slice(desde + hoja.raw.length);
    });
    expect(labelledWords(fila), "el rótulo sigue siendo el mismo").toHaveLength(6);
    expect(lineasInvisiblesEnElTelefono(fila), "y la etiqueta sigue prendida").toEqual([]);
    expect(
      valueSpans(fila)
        .filter((hoja) => !ETIQUETA_ABRE.test(hoja.rawInner))
        .map((hoja) => labelOf(hoja)?.inner.trim()),
      "hojas que ya no abren con su rótulo",
    ).toEqual([`${rotulo.trim()}`]);
  });

  it("un `title=` en la fila se acusa: el dato que sólo vive en el tooltip", () => {
    const conTooltip = filaDe(fuente, (texto) => {
      const desde = texto.indexOf(valueSpans(rowRegion(texto))[0].raw);
      const hoja = valueSpans(rowRegion(texto))[0].raw;
      return texto.slice(0, desde) + hoja.replace('<span className="', '<span title="Andrés Quintero (04)" className="') + texto.slice(desde + hoja.length);
    });
    expect(titulosDe(conTooltip), "el title= se coló en la fila").toHaveLength(1);
  });

  it("la clase de la etiqueta que estas cuentas están leyendo es la del archivo", () => {
    // Ancla de los controles de arriba: si el archivo dejara de rotular la
    // primera hoja, o de declarar la clase de SU etiqueta, estos controles no
    // probarian nada. Y la clase que se lee es la del RÓTULO, no la de la hoja:
    // la hoja se apaga en otro criterio distinto.
    const { etiqueta } = primeraHoja();
    expect(etiqueta.className.split(/\s+/)).toEqual(expect.arrayContaining(["sm:hidden"]));
    expect(tokenQueEsconde(etiqueta.className, 390), "en el teléfono").toBe("");
    expect(tokenQueEsconde(etiqueta.className, 1024), "en el escritorio").toBe("sm:hidden");
  });
});

/* --------------------------------------------------------------------------
   EL BLANCO TÁCIL QUE SE CAE: las cinco mutaciones del criterio 5, una por
   criterio, sobre una COPIA en memoria del archivo real.
   -------------------------------------------------------------------------- */

describe("el blanco táctil de los controles nativos se acusa cuando se cae", () => {
  const seccion = SECCIONES[1]!; // Usuarios: un radio por fila, el caso de la lista.
  const fuente = FUENTES.find((e) => e.seccion.archivo === seccion.archivo)?.fuente ?? "";

  /** El archivo con la clase del `<label>` del radio sustituida por `clase`. */
  function fuenteConEnvoltorio(clase: string): string {
    const control = nativeControls(fuente)[0]!;
    const apertura = fuente.lastIndexOf("<label", control.indice);
    const largo = fuente.indexOf(">", apertura) + 1;
    const original = fuente.slice(apertura, largo);
    const sustituto = original.replace(/className="([^"]*)"/, `className="${clase}"`);
    if (sustituto === original) throw new Error("el envoltorio del radio no declara `className`");
    return fuente.slice(0, apertura) + sustituto + fuente.slice(largo);
  }

  it("el archivo real ya pasa: el control de la lista llega a 24 px", () => {
    const control = nativeControls(fuente)[0]!;
    expect(blancoTactilFallas(control), "el radio de la lista").toEqual([]);
    expect(blancosTactilesFallas(fuente), "todo el archivo").toEqual([]);
    expect(rebanadaDe(control.envoltorio ?? ""), "la rebanada declarada").toEqual({
      token: "after:-inset-1.5",
      x: 6,
      y: 6,
      variante: null,
    });
    expect(NATIVE_PX + 2 * 6).toBeGreaterThanOrEqual(PISO_PX);
  });

  it("una rebanada más chica se acusa: la unión no llega al piso", () => {
    // La edición: `after:-inset-1` son 4 px por lado, o sea 13 + 8 = 21 px. Por
    // eso la primitiva usa `-inset-1.5`: la cuenta no es la intuitiva.
    const mutado = fuenteConEnvoltorio("relative flex items-center gap-1 after:absolute after:-inset-1");
    expect(blancosTactilesFallas(mutado)).toEqual([
      expect.stringContaining("el blanco táctil mide 21×21 px"),
    ]);
  });

  it("un envoltorio que no es `relative` se acusa: el `::after` no se mide contra él", () => {
    const mutado = fuenteConEnvoltorio("flex items-center gap-1 after:absolute after:-inset-1.5");
    expect(blancosTactilesFallas(mutado)).toEqual([
      expect.stringContaining("el envoltorio no es `relative`"),
    ]);
  });

  it("una rebanada con variante se acusa: el piso es duro y no tiene excepción", () => {
    const mutado = fuenteConEnvoltorio(
      "relative flex items-center gap-1 after:absolute max-sm:after:-inset-1.5",
    );
    expect(blancosTactilesFallas(mutado)).toEqual([
      expect.stringContaining("el piso de 24 px es duro y no tiene excepción de escritorio"),
    ]);
  });

  it("una rebanada a un solo eje se acusa en ese eje", () => {
    const mutado = fuenteConEnvoltorio("relative flex items-center gap-1 after:absolute after:-inset-y-1.5");
    expect(blancosTactilesFallas(mutado)).toEqual([
      expect.stringContaining("el blanco táctil mide 13×25 px"),
    ]);
  });

  it("control oculto o deformado se acusa aunque la rebanada esté bien", () => {
    const fuenteOculta = fuente.replace(
      /<input\s+type="radio"/,
      '<input className="sr-only" type="radio"',
    );
    expect(blancosTactilesFallas(fuenteOculta).filter((falla) => falla.includes("sr-only")).length).toBe(ANCHOS_MOVILES.length);
    const deformado = fuente.replace(
      /<input\s+type="radio"/,
      '<input className="appearance-none scale-150 h-3 w-3" type="radio"',
    );
    const fallas = blancosTactilesFallas(deformado);
    expect(fallas.some((falla) => falla.includes("dejaría de verse como el control nativo"))).toBe(true);
    expect(fallas.some((falla) => falla.includes("escalar el control"))).toBe(true);
    expect(fallas.some((falla) => falla.includes("fijar `h`/`w` en el nativo lo deforma"))).toBe(true);
  });

  it("el detector de rebanada casa el token COMPLETO, no un substring", () => {
    expect(rebanadaDe("relative after:absolute after:-inset-1.5"), "rebanada real").toEqual({
      token: "after:-inset-1.5",
      x: 6,
      y: 6,
      variante: null,
    });
    expect(rebanadaDe("after:-inset-1.50"), "no es un token de Tailwind").toBeNull();
    expect(rebanadaDe("after:inset-1.5"), "hacia adentro no agranda").toBeNull();
    expect(rebanadaDe("after:-inset-x-2"), "sólo el eje X").toEqual({ token: "after:-inset-x-2", x: 8, y: 0, variante: null });
    expect(rebanadaDe("sm:after:-inset-1.5"), "con variante de ancho").toEqual({ token: "sm:after:-inset-1.5", x: 6, y: 6, variante: "sm" });
    expect(rebanadaDe("hover:after:-inset-1.5"), "con variante de estado").toEqual({ token: "hover:after:-inset-1.5", x: 6, y: 6, variante: "hover" });
    expect(rebanadaDe("relative after:absolute"), "sin rebanada").toBeNull();
  });

  it("el escáner de controles no cuenta un `<input>` de otro tipo", () => {
    const conTexto = fuente.replace(/<input\s+type="radio"/, '<input type="text"');
    expect(nativeControls(conTexto), "el radio se volvió un campo de texto").toHaveLength(0);
  });
});
