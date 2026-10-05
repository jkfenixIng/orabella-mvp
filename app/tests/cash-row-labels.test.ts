import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO módulo del que `cn(...)` saca la clase que llega al DOM. No es una
// copia de la regla de fusión: es la regla.
import { twMerge } from "tailwind-merge";
// Y las clases que el módulo importa del estándar compartido, con su VALOR REAL:
// la guarda no reescribe `px-3 py-2 align-middle`, lo importa.
import {
  mutedTextClass,
  tableCellClass,
  tableHeaderClass,
  tableRowClass,
} from "@/src/shared/lib/ui-styles";

/* --------------------------------------------------------------------------
   R38 — la fila de la lista de caja, apilada, con su etiqueta.

   EL DEFECTO QUE ESTA GUARDA CIERRA, MEDIDO: la tabla de turnos se monta con
   `min-w-[1100px]` y todas sus celdas con `whitespace-nowrap`. En un teléfono
   el carril interior mide 238 px y la tabla 1330: las columnas administrativas
   (Diferencia, Revisada, Justificación) y las acciones de la fila (Recontar,
   Versiones, Ver) quedan de 800 a 1100 px a la derecha del borde de la
   pantalla. La auditoría contó 20 botones de fila fuera de la vista en las
   tablas de admin; esta es la tabla más ancha de la aplicación.

   LO QUE SE AFIRMA, en cuatro invariantes y por fuente (mismo método que
   `invoice-row-labels.test.ts`, `ux-data-table.test.ts` y `no-raw-palette.test.ts`:
   sin DOM, leyendo el archivo real):

     1. ABAJO DE `sm` la fila se apila —una tarjeta por turno— y cada valor lleva
        su etiqueta visible: la del encabezado, la MISMA palabra.
     2. ARRIBA DE `sm` esas etiquetas no existen (el encabezado ya nombra), el
        `nowrap` también no (es lo que empujaba la fila a 1330 px), el piso de
        ancho inventado tampoco, y cada celda vuelve a ocupar su columna.
     3. La acción de la fila está en su PROPIA línea, a lo ancho: no hace falta
        arrastrar para llegar a ella ni queda detrás de un recorte.
     4. La tarjeta esconde por rol EXACTAMENTE lo que esconde el encabezado.

   POR QUÉ LA ETIQUETA ES LA PALABRA DEL ENCABEZADO: el vocabulario se escribe
   una vez —el encabezado— y se lee en los dos lados, así que las dos superficies
   no pueden divergir. Por eso la guarda NO tiene una lista cerrada de palabras:
   lee las del encabezado del archivo real y exige que las etiquetas sean ese
   mismo conjunto, por rol.

   POR QUÉ SIGUE SIENDO UNA `<table>` Y NO UNA `<ul>`: la referencia de facturas
   es una lista que ya era `<ul>`/`<li>`, con nueve columnas fijas que se pinean
   una a una con `sm:col-start-N`. acá hay columnas DINÁMICAS —una por método de
   pago activo— y un piso de ancho declarado para el escritorio: la grilla de la
   referencia no se puede escribir sin inventar la escala por código, y Tailwind
   no compila una clase construida. Lo que se replica no es el vehículo, es el
   contrato: abajo de `sm` una tarjeta rotulada por sus propias etiquetas, arriba
   de `sm` el mismo encabezado y las mismas columnas, y la acción en su línea.

   LO QUE ESTA GUARDA NO PUEDE VER, DICHO DE ANTEMBIO: acá no hay navegador.
   Sólo se afirma lo que el `className` PIDE, resuelto con `twMerge` —el mismo
   módulo del que `cn(...)` saca la clase— y por la cascada a un ancho dado. No
   ve un `style` en línea, ni una regla de `globals.css`, ni un `hidden` heredado
   de un ancestro, ni un contenedor `@media`, ni una variante que dependa del
   estado y no del ancho (`hover:`, `dark:`, `group-hover:`), que se tratan como
   inactivas. Lo que se MIDÓ de verdad —rótulos visibles a 412/390/360/320,
   acciones respondiendo a `document.elementFromPoint`, `scrollWidth ==
   clientWidth`— está en `odd/tasks/auditoria-responsive.md`.
   -------------------------------------------------------------------------- */

const CLIENT_PATH = join(process.cwd(), "app", "cash", "cash-client.tsx");
const CLIENT = readFileSync(CLIENT_PATH, "utf8");

/** Clases del estándar compartido que este módulo importa: valor real, no copia. */
const COMPARTIDAS: Record<string, string> = {
  tableCellClass,
  tableRowClass,
  tableHeaderClass,
  mutedTextClass,
};

/** El texto de la tabla de turnos y el de la fila, con el fuente del que salieron. */
interface Lectura {
  /** El bloque del `<thead>`. */
  header: string;
  /** El bloque del `<tr key={view.shift.id}`. */
  row: string;
  /** El archivo real (o su copia mutada en memoria): de aquí salen las constantes. */
  source: string;
}

/* --------------------------------------------------------------------------
   Las dos regiones que se leen del archivo real.
   -------------------------------------------------------------------------- */

function headerRegion(source: string): string {
  const start = source.indexOf("<thead");
  const end = source.indexOf("</thead>");
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function rowRegion(source: string): string {
  const start = source.search(/<tr\s+key=\{view\.shift\.id\}/);
  if (start < 0) return "";
  const end = source.indexOf("</tr>", start);
  return end > start ? source.slice(start, end) : "";
}

function leer(source: string): Lectura {
  return { header: headerRegion(source), row: rowRegion(source), source };
}

/* --------------------------------------------------------------------------
   Lectores. Una expresión JSX se vacía ANTES de contar etiquetas: dentro de un
   `{...}` hay `=>`, `&&` y `<` que no son markup. Se reemplaza por espacios, así
   los índices NO se mueven y lo que se lee es el markup vivo; cuando hace falta
   el texto de un atributo se corta del fuente CRUDO, a los mismos índices.
   -------------------------------------------------------------------------- */

/**
 * Vacía las expresiones JSX que NO contienen markup, y CONSERVA las que sí.
 *
 * La diferencia con la guarda de facturas: la fila de caja tiene ramas de rol
 * DENTRO (`{isAdmin && (<>…celdas…</>)}`). Vaciarlas a ciegas borraría las siete
 * celdas de admin de la lectura, y una guarda que no puede ver la mitad
 * administrativa de la fila no afirmaría nada sobre ella. Además, vaciar el
 * archivo entero fallaría: `function ShiftsTable({` es JavaScript, no JSX, y
 * su llave abriría el resto del fuente.
 *
 * Se conservan los índices: cada rama devuelve exactamente su largo.
 */
function vaciaExpresiones(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char !== "{") {
      out += char;
      i += 1;
      continue;
    }
    const fin = cierreDeLlave(source, i);
    const interior = source.slice(i + 1, fin);
    out += interior.includes("<")
      ? `{${vaciaExpresiones(interior)}}`
      : " ".repeat(fin - i + 1);
    i = fin + 1;
  }
  return out;
}

/** La llave que cierra la que abre en `desde`, saltando las citas. */
function cierreDeLlave(source: string, desde: number): number {
  let depth = 0;
  let cita: string | null = null;
  for (let i = desde; i < source.length; i += 1) {
    const char = source[i];
    if (cita !== null) {
      if (char === cita) cita = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      cita = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/** El valor de `className` de una etiqueta, como expresión: literal (con comillas) o `cn(...)`. */
function claseDe(etiqueta: string): string {
  const match = /className=(?:"([^"]*)"|\{([^{}]*)\})/.exec(etiqueta);
  if (match === null) return "";
  return match[1] !== undefined ? `"${match[1]}"` : match[2].trim();
}

/** Los argumentos de una llamada `cn(...)`, partidos en comas de primer nivel. */
function argumentosDe(expr: string): string[] {
  const dentro = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
  const partes: string[] = [];
  let nivel = 0;
  let actual = "";
  let cita: string | null = null;
  for (const char of dentro) {
    if (cita !== null) {
      actual += char;
      if (char === cita) cita = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      cita = char;
      actual += char;
      continue;
    }
    if ("([{".includes(char)) nivel += 1;
    else if (")]}".includes(char)) nivel -= 1;
    else if (char === "," && nivel === 0) {
      partes.push(actual);
      actual = "";
      continue;
    }
    actual += char;
  }
  if (actual.trim() !== "") partes.push(actual);
  return partes;
}

/**
 * El fuente con los comentarios ESPACIADOS —no borrados, para que los índices
 * no se muevan y el corte siga siendo del mismo byte—.
 *
 * Hace falta porque este módulo EXPLICA el arreglo en prosa y esa prosa nombra
 * las etiquetas: sin esto, `const campoClass` y `<table …>` se encontrarían
 * primero en un comentario —la guarda leería el texto que explica el marcado en
 * vez del marcado—, que es exactamente el modo de fallo que esta guarda quiere
 * no tener.
 */
function sinComentarios(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (bloque) => " ".repeat(bloque.length))
    .replace(/\/\/[^\n]*/g, (linea) => " ".repeat(linea.length));
}

/** El valor de `const NOMBRE = …` en el archivo, o `null` si no existe. */
function definicionDe(source: string, nombre: string): string | null {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nombre)) {
    throw new Error(`«${nombre.slice(0, 120)}» no es un identificador de clase`);
  }
  const limpio = sinComentarios(source);
  const match = new RegExp(`const\\s+${nombre}\\s*=\\s*`).exec(limpio);
  if (match === null) return null;
  const resto = limpio.slice(match.index + match[0].length);
  if (resto.startsWith("cn(")) {
    // `nivel` arranca en 1 por el `(` de `cn(`: el contador empieza DENTRO de la
    // llamada, en el índice 3.
    let nivel = 1;
    for (let i = 3; i < resto.length; i += 1) {
      if (resto[i] === "(") nivel += 1;
      else if (resto[i] === ")") {
        nivel -= 1;
        if (nivel === 0) return resto.slice(0, i + 1);
      }
    }
    return null;
  }
  if (resto.startsWith('"')) return resto.slice(0, resto.indexOf('"', 1) + 1);
  return null;
}

/**
 * LA CLASE EFECTIVA de una expresión de `className`, tal como llega al DOM.
 *
 * Se resuelve recursivamente (constante del módulo → `cn(...)` → constante
 * importada del estándar compartido) y se funde con `twMerge`. Una expresión
 * que no se sepa resolver LANZA: una guarda que se pasa por alto un `className`
 * que no entendió no affirmaría nada sobre él.
 */
function resuelve(source: string, expr: string, profundidad = 0): string {
  if (profundidad > 6) throw new Error(`clase demasiado anidada: ${expr}`);
  const bruto = expr.trim();
  if (bruto.startsWith('"')) return twMerge(bruto.slice(1, bruto.lastIndexOf('"')));
  if (bruto.startsWith("cn(")) {
    return twMerge(
      argumentosDe(bruto)
        .map((argumento) => resuelve(source, argumento, profundidad + 1))
        .join(" "),
    );
  }
  const definicion = definicionDe(source, bruto);
  if (definicion !== null) return resuelve(source, definicion, profundidad + 1);
  const compartida = COMPARTIDAS[bruto];
  if (compartida !== undefined) return twMerge(compartida);
  throw new Error(`no se sabe resolver la clase «${bruto}»`);
}

/* --------------------------------------------------------------------------
   LA CASCADA. Utilidades que compiten por la misma propiedad: dentro de una
   propiedad gana la variante más alta que esté ACTIVA, y a igual variante gana
   la última escrita. Es la cuenta que distingue un `hidden sm:hidden` —que
   sobrevive la fusión porque es el mismo grupo con distinta variante, el caso
   ciego de una guarda que mira tokens— del `hidden sm:block`, que se funde en
   `sm:block` y sí se acusa.
   -------------------------------------------------------------------------- */

/** Los cuatro anchos angostos donde la etiqueta tiene que LEERSE. */
const ANCHOS_MOVILES = [320, 360, 390, 412];

/** Los cuatro anchos anchos donde el encabezado ya la dijo y la etiqueta se va. */
const ANCHOS_ESCRITORIO = [640, 768, 1024, 1440];

/** Utilidades que ponen `display` (sólo `hidden` apaga el elemento). */
const DISPLAY = new Set([
  "block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid",
  "table", "inline-table", "table-row", "table-cell", "table-caption",
  "table-header-group", "table-column-group", "table-column", "table-footer-group",
  "table-row-group", "list-item", "contents", "flow-root", "hidden",
]);

/** Utilidades que ponen `visibility`. */
const VISIBILITY = new Set(["visible", "invisible", "collapse"]);

/** La opacidad que apaga el contenido sin apagar la caja. */
const OPACIDAD = new Set(["opacity-0"]);

/** Recorte visual de 1 px que deja el texto sólo para el lector de pantalla. */
const SR_SOLO = new Set(["sr-only"]);
const NOT_SR_SOLO = new Set(["not-sr-only"]);

/** El recorte que deja el valor truncado con puntos suspensivos. */
const RECORTE = new Set(["truncate", "text-ellipsis", "overflow-hidden"]);

/** El `white-space` que impide el renglón: fue lo que empujó la fila a 1330 px. */
const ESPACIO = new Set([
  "whitespace-normal", "whitespace-nowrap", "whitespace-pre", "whitespace-pre-line",
  "whitespace-pre-wrap", "whitespace-break-spaces",
]);

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
 *
 * Sin variante pesa 0. `sm:` pesa 640 y sólo pesa si el viewport ya llegó a
 * 640. `max-sm:` pesa −640 y sólo pesa por debajo de 640 — es el signo de
 * «escondida justo en el teléfono», el ancho donde tiene que verse. Una variante
 * que no sea de ancho (`hover:`, `dark:`, `group-hover:`, un arbitrario) NO es
 * una decisión de ancho: se trata como inactiva, y por eso es un límite
 * declarado de esta cuenta, no un accidente.
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
 * la cascada a ese ancho, no del token tal cual. Lo que apaga un elemento en
 * Tailwind son cuatro vías y están las cuatro: `display:none` (`hidden`, con o
 * sin variante), `visibility:hidden` (`invisible`, `collapse`), `opacity:0` y el
 * recorte de `sr-only`.
 */
function tokenQueEsconde(className: string, vw: number): string {
  const tokens = twMerge(className).split(/\s+/).filter(Boolean);
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

/** El token de `width` que GANA a ese ancho (`w-…` es el único prefijo así). */
function anchoActivo(tokens: string[], vw: number): string {
  let elegido = "";
  for (const token of tokens) {
    if (baseName(token).startsWith("w-") && peso(token, vw) !== null) elegido = token;
  }
  return elegido;
}

/** El token de `min-width` que GANA a ese ancho, o `""`. */
function pisoActivo(tokens: string[], vw: number): string {
  let elegido = "";
  for (const token of tokens) {
    if (baseName(token).startsWith("min-w-") && peso(token, vw) !== null) elegido = token;
  }
  return elegido;
}

/**
 * La apertura de un elemento por su clase efectiva (la `<table>`, el `<thead>`).
 *
 * Se lee del fuente CRUDO y no del vaciado, porque estas dos etiquetas no viven
 * dentro de un JSX con expresiones contenidas: su `className` es un literal o un
 * `cn(...)`, y un `>` dentro de ese `cn(...)` —o un `fn(a > b ? c : d)`— haría
 * que `resuelve` LANZARA en vez de pasar en silencio.
 */
function claseDeElemento(source: string, patron: RegExp): string {
  const match = patron.exec(sinComentarios(source));
  if (match === null) return "";
  const expr = claseDe(match[0]);
  // Sin `className` no hay nada que apague el elemento: eso es un hecho que la
  // cascada va a decir, no una razón para lanzar.
  return expr === "" ? "" : resuelve(source, expr);
}

/* --------------------------------------------------------------------------
   La fila: sus celdas, la etiqueta de cada una y su clase EFECTIVA.
   -------------------------------------------------------------------------- */

interface Campo {
  /** La clase EFECTIVA de la celda (lo que llega al DOM). */
  clase: string;
  /** La apertura cruda de la celda: de aquí sale si lleva `title=`. */
  apertura: string;
  /** El markup del interior: la etiqueta y el valor. */
  inner: string;
  /** Dónde abre el interior, en índices del fuente. */
  contenido: number;
  /** Dónde abre la celda, en índices del fuente. */
  inicio: number;
}

function camposDe(lectura: Lectura): Campo[] {
  const markup = vaciaExpresiones(lectura.row);
  const campos: Campo[] = [];
  for (const match of markup.matchAll(/<td\b([^>]*)>/g)) {
    const contenido = match.index + match[0].length;
    const cerrado = markup.indexOf("</td>", contenido);
    if (cerrado === -1) continue;
    const apertura = lectura.row.slice(match.index, contenido);
    if (claseDe(apertura) === "") throw new Error(`la celda de ${match.index} no declara className`);
    campos.push({
      clase: resuelve(lectura.source, claseDe(apertura)),
      apertura,
      // El interior se lee del CRUDO, no del vaciado: el rótulo tiene que ABRIR la
      // línea, y vaciar el valor lo dejaría en el sitio aunque estuviera al final.
      inner: lectura.row.slice(contenido, cerrado),
      contenido,
      inicio: match.index,
    });
  }
  // La celda del método vive dentro de un `{methodCols.map(…)}`, que SÍ contiene
  // markup y por eso sobrevive al vaciado. Se lee del CRUDO, porque su etiqueta
  // es una expresión —`{method.name}`— y el vaciado la volvería espacios: es la
  // misma expresión que la del encabezado, y por eso no puede divergir.
  const metodo = campoDeMetodo(lectura);
  if (metodo !== undefined) {
    const i = campos.findIndex((campo) => campo.inicio === metodo.inicio);
    if (i === -1) campos.push(metodo);
    else campos[i] = metodo;
  }
  return campos;
}

/**
 * Una etiqueta ABRE el markup de la celda y termina en dos puntos —«Apertura: »—.
 * Que abra el markup es lo que la distingue de un valor suelto (`#12` pelado) y
 * que termine en dos puntos es lo que la distingue de un envoltorio
 * `inline-flex` que sólo lleva botones. La columna dinámica trae la misma
 * forma con la MISMA expresión que su encabezado: `{method.name}`.
 */
const ETIQUETA_ABRE = /^\s*<span\b([^>]*)>\s*(\{method\.name\}|[^\s<>{}][^<>{}]*?)\s*:\s*<\/span>/;

interface Etiqueta {
  /** La expresión de `className` que recibe la etiqueta. */
  expr: string;
  /** La clase EFECTIVA de la etiqueta. */
  clase: string;
  /** La palabra, sin los dos puntos. */
  palabra: string;
}

function etiquetaDe(campo: Campo, lectura: Lectura): Etiqueta | undefined {
  const match = ETIQUETA_ABRE.exec(campo.inner);
  if (match === null) return undefined;
  const desde = campo.contenido + match.index;
  const cruda = lectura.row.slice(desde, desde + match[0].length);
  return {
    expr: claseDe(cruda),
    clase: resuelve(lectura.source, claseDe(cruda)),
    palabra: match[2].trim(),
  };
}

/**
 * LA COLUMNA DINÁMICA: la celda del método de pago, que vive dentro de un
 * `{methodCols.map(…)}` y por eso no está en el markup. Se lee del fuente CRUDO
 * —su etiqueta es una expresión, no texto— y su palabra es la MISMA expresión
 * que la del encabezado: el vocabulario de esa columna no puede divergir porque
 * es el mismo identificador.
 */
function campoDeMetodo(lectura: Lectura): Campo | undefined {
  const match = /<td\b[^>]*key=\{method\.id\}[^>]*>/.exec(lectura.row);
  if (match === null) return undefined;
  const contenido = match.index + match[0].length;
  const cerrado = lectura.row.indexOf("</td>", contenido);
  if (cerrado === -1) return undefined;
  return {
    clase: resuelve(lectura.source, claseDe(match[0])),
    apertura: match[0],
    inner: lectura.row.slice(contenido, cerrado),
    contenido,
    inicio: match.index,
  };
}

/** La palabra de la columna dinámica, tal como la escriben las dos superficies. */
const PALABRA_METODO = "{method.name}";

/** Los rangos del fuente que abre `{isAdmin && (`, con su paréntesis de cierre. */
function rangosDeAdmin(region: string): Array<[number, number]> {
  const rangos: Array<[number, number]> = [];
  const patron = /\{\s*isAdmin\s*&&\s*\(/g;
  for (let match = patron.exec(region); match !== null; match = patron.exec(region)) {
    let depth = 0;
    let cita: string | null = null;
    let i = match.index + match[0].length - 1;
    for (; i < region.length; i += 1) {
      const char = region[i];
      if (cita !== null) {
        if (char === cita) cita = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        cita = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    rangos.push([match.index, i]);
  }
  return rangos;
}

function dentroDe(rangos: Array<[number, number]>, indice: number): boolean {
  return rangos.some(([desde, hasta]) => indice >= desde && indice <= hasta);
}

/* --------------------------------------------------------------------------
   LO DECLARADO. Estas dos listas son el contrato de la fila, escrito donde se
   puede leer: el orden en que se lee la tarjeta en el teléfono y el orden de
   columnas del escritorio. La guarda los afirma contra el archivo real, así que
   cambiar un orden es un cambio deliberado y no un accidente del marcado.

   LA PRIORIDAD DEL TELÉFONO, y por qué: `Apertura` y `Abrió` abren porque sin
   ellos no se sabe QUÉ turno es; `Estado`, `Base inicial`, `Base final` y
   `Vales` son la plata —qué había, qué quedó, qué salió por vales—; `Cerró` y
   `Justificación` bajan porque sólo tienen sentido en un turno ya cerrado; y
   `Reconteo` es la acción, al final, en su propia línea.

   LA PARIDAD POR ROL: `Ventas`, `Efectivo`, los métodos, `Diferencia`,
   `Revisada`, `Justificación` y `Reconteo` son de admin HOY en el escritorio, y
   la tarjeta no muestra ni uno solo a un no-admin. Ampliarlo o quitarlo sería un
   cambio de permisos, no de presentación: la guarda lo rechaza en las dos
   superficies a la vez.
   -------------------------------------------------------------------------- */

const SOLO_ADMIN = new Set([
  "Ventas", "Efectivo", "Diferencia", "Revisada", "Justificación", "Reconteo",
]);

/** El orden de lectura de la tarjeta móvil. */
const ORDEN_MOVIL = [
  "Apertura", "Abrió", "Estado", "Base inicial", "Base final", "Vales", "Cerró",
  "Ventas", "Efectivo", PALABRA_METODO, "Diferencia", "Revisada", "Justificación", "Reconteo",
];

/** El orden de columnas del escritorio: el de siempre, sin cambios. */
const ORDEN_ESCRITORIO = [
  "Apertura", "Estado", "Abrió", "Cerró", "Base inicial",
  "Ventas", "Efectivo", PALABRA_METODO,
  "Vales", "Base final",
  "Diferencia", "Revisada", "Justificación", "Reconteo",
];

/** Lo que ve un NO admin: el mismo conjunto en las dos superficies. */
const COMUNES = ORDEN_MOVIL.filter(
  (palabra) => !SOLO_ADMIN.has(palabra) && palabra !== PALABRA_METODO,
);

/** Las palabras del encabezado del archivo real, en orden de columna y con su rol. */
function palabrasDeEncabezado(lectura: Lectura): Array<{ palabra: string; admin: boolean }> {
  const markup = vaciaExpresiones(lectura.header);
  const rangos = rangosDeAdmin(lectura.header);
  const palabras: Array<{ palabra: string; admin: boolean }> = [];
  for (const match of markup.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)) {
    const desde = match.index + match[0].indexOf(">") + 1;
    const crudo = lectura.header.slice(desde, desde + match[2].length);
    const palabra = /\{method\.name\}/.test(crudo) ? PALABRA_METODO : crudo.trim();
    if (palabra === "") continue;
    // Una columna cuyo rótulo es una expresión que no es el nombre del método
    // es una columna que esta guarda no puede leer: se declara, no se adivina.
    if (palabra.includes("{") && palabra !== PALABRA_METODO) continue;
    palabras.push({ palabra, admin: dentroDe(rangos, match.index) });
  }
  return palabras;
}

/** Las palabras que la tarjeta rotula, en orden de lectura y con su rol. */
function palabrasDeFila(lectura: Lectura): Array<{ palabra: string; admin: boolean }> {
  const rangos = rangosDeAdmin(lectura.row);
  return camposDe(lectura)
    .map((campo) => ({ campo, etiqueta: etiquetaDe(campo, lectura) }))
    .filter((hoja): hoja is { campo: Campo; etiqueta: Etiqueta } => hoja.etiqueta !== undefined)
    .map(({ campo, etiqueta }) => ({
      palabra: etiqueta.palabra,
      admin: dentroDe(rangos, campo.inicio),
    }));
}

/** El conjunto de palabras de una superficie, con el rol marcado: `admin:Palabra`. */
function conjunto(lectura: Lectura): Set<string> {
  return new Set(
    palabrasDeFila(lectura).map(({ palabra, admin }) => (admin ? `admin:${palabra}` : palabra)),
  );
}

function conjuntoDeEncabezado(lectura: Lectura): Set<string> {
  return new Set(
    palabrasDeEncabezado(lectura).map(({ palabra, admin }) =>
      admin ? `admin:${palabra}` : palabra,
    ),
  );
}

/* --------------------------------------------------------------------------
   El predicado del contrato. Son FUNCIONES, no `expect` sueltos: al final se
   corren contra el marcado viejo y contra mutaciones en memoria, y tienen que
   acusarlos.
   -------------------------------------------------------------------------- */

/** Celdas apiladas que no dicen qué valor es el que muestran. */
function sinEtiqueta(lectura: Lectura): string[] {
  return camposDe(lectura)
    .filter((campo) => etiquetaDe(campo, lectura) === undefined)
    .map((campo) => campo.clase);
}

/**
 * Etiquetas que NO se leen en el teléfono. Dos criterios, y cada uno falla por
 * su cuenta:
 *
 *   1. la línea no abre con SU etiqueta —si se quita, o se corre del principio,
 *      el renglón queda `200.000` solo o `200.000Base inicial:` pegado—;
 *   2. la etiqueta tiene una clase que la apaga a ese ancho —`hidden`,
 *      `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden`: el rótulo está en el
 *      fuente y no se lee, que es el defecto que una guarda de tokens no veía.
 */
function etiquetasApagadasEnElTelefono(lectura: Lectura): string[] {
  const fallos: string[] = [];
  for (const campo of camposDe(lectura)) {
    const etiqueta = etiquetaDe(campo, lectura);
    if (etiqueta === undefined) {
      fallos.push(`${campo.clase}: la línea no abre con su propia etiqueta`);
      continue;
    }
    for (const vw of ANCHOS_MOVILES) {
      const causa = tokenQueEsconde(etiqueta.clase, vw);
      if (causa !== "") fallos.push(`«${etiqueta.palabra}» a ${vw}px: la esconde \`${causa}\``);
    }
  }
  return fallos;
}

/** El VALOR que la etiqueta rotula, apagado en el teléfono: un rótulo perfecto no dice nada sin él. */
function valoresApagadosEnElTelefono(lectura: Lectura): string[] {
  const fallos: string[] = [];
  for (const campo of camposDe(lectura)) {
    const etiqueta = etiquetaDe(campo, lectura);
    if (etiqueta === undefined) continue;
    for (const vw of ANCHOS_MOVILES) {
      const causa = tokenQueEsconde(campo.clase, vw);
      if (causa !== "") fallos.push(`el valor de «${etiqueta.palabra}» a ${vw}px: lo esconde \`${causa}\``);
    }
  }
  return fallos;
}

/** Etiquetas que se verían ARRIBA de `sm`: el encabezado ya nombró cada columna. */
function etiquetasVisiblesEnEscritorio(lectura: Lectura): string[] {
  const fallos: string[] = [];
  for (const campo of camposDe(lectura)) {
    const etiqueta = etiquetaDe(campo, lectura);
    if (etiqueta === undefined) continue;
    for (const vw of ANCHOS_ESCRITORIO) {
      if (tokenQueEsconde(etiqueta.clase, vw) === "") {
        fallos.push(`«${etiqueta.palabra}» se ve a ${vw}px`);
      }
    }
  }
  return fallos;
}

/**
 * El `white-space: nowrap` en el teléfono. Es lo que midió la auditoría: con
 * `nowrap` en todas las celdas la tabla midió 1330 px dentro de un carril de
 * 238. Arriba de `sm` es correcto —el dinero y las fechas no se parten— y por
 * eso lo que se exige es la VARIANTE, no la ausencia.
 */
function nowrapEnElTelefono(lectura: Lectura): string[] {
  const fallos: string[] = [];
  for (const campo of camposDe(lectura)) {
    const tokens = twMerge(campo.clase).split(/\s+/).filter(Boolean);
    const nombre = etiquetaDe(campo, lectura)?.palabra ?? "(sin etiqueta)";
    for (const vw of ANCHOS_MOVILES) {
      const espacio = ganador(tokens, ESPACIO, vw);
      if (espacio !== null && espacio.base === "whitespace-nowrap") {
        fallos.push(`${nombre} a ${vw}px: \`${espacio.token}\``);
      }
    }
  }
  return fallos;
}

/** Celdas con el ancho de la tarjeta puesto por encima de `sm`: arriba manda la tabla. */
function anchosFijosEnEscritorio(lectura: Lectura): string[] {
  const fallos: string[] = [];
  for (const campo of camposDe(lectura)) {
    const tokens = twMerge(campo.clase).split(/\s+/).filter(Boolean);
    const nombre = etiquetaDe(campo, lectura)?.palabra ?? "(sin etiqueta)";
    for (const vw of ANCHOS_ESCRITORIO) {
      const ancho = anchoActivo(tokens, vw);
      if (ancho !== "" && baseName(ancho) !== "w-auto") fallos.push(`${nombre} a ${vw}px: \`${ancho}\``);
    }
  }
  return fallos;
}

/** El piso de ancho inventado activo en el teléfono: eso es el carril horizontal. */
function pisoEnElTelefono(lectura: Lectura): string[] {
  const tokens = twMerge(claseDeElemento(lectura.source, /<table\b[^>]*>/)).split(/\s+/);
  const fallos: string[] = [];
  for (const vw of ANCHOS_MOVILES) {
    const piso = pisoActivo(tokens, vw);
    if (piso !== "" && baseName(piso) !== "min-w-full") fallos.push(`a ${vw}px: \`${piso}\``);
  }
  return fallos;
}

/** El encabezado, que es el que nombra: abajo se apaga, arriba se ve. */
function encabezadoInvertido(lectura: Lectura): string[] {
  const clase = claseDeElemento(lectura.source, /<thead\b[^>]*>/);
  const fallos: string[] = [];
  for (const vw of ANCHOS_MOVILES) {
    if (tokenQueEsconde(clase, vw) === "") fallos.push(`el encabezado se ve a ${vw}px`);
  }
  for (const vw of ANCHOS_ESCRITORIO) {
    if (tokenQueEsconde(clase, vw) !== "") fallos.push(`el encabezado se apaga a ${vw}px`);
  }
  return fallos;
}

/** La acción de la fila: su celda, a lo ancho y sin recorte. */
function accionAlcanzableEnElTelefono(lectura: Lectura): string[] {
  const campos = camposDe(lectura);
  const accion = campos[campos.length - 1];
  if (accion === undefined) return ["la fila no tiene celdas"];
  const etiqueta = etiquetaDe(accion, lectura);
  if (etiqueta === undefined || etiqueta.palabra !== "Reconteo") {
    return [`la última celda no es la acción: «${etiqueta?.palabra ?? "(sin etiqueta)"}»`];
  }
  const fallos: string[] = [];
  const tokens = twMerge(accion.clase).split(/\s+/).filter(Boolean);
  for (const vw of ANCHOS_MOVILES) {
    const ancho = anchoActivo(tokens, vw);
    if (ancho === "" || baseName(ancho) !== "w-full") fallos.push(`a ${vw}px: la acción mide \`${ancho || "(auto)"}\``);
    const corte = activo(tokens, RECORTE, vw);
    if (corte !== "") fallos.push(`a ${vw}px: la acción se recorta con \`${corte}\``);
  }
  return fallos;
}

/** La tarjeta y el encabezado esconden lo MISMO tras el rol de admin. */
function paridadDeRol(lectura: Lectura): string[] {
  const tarjeta = conjunto(lectura);
  const encabezado = conjuntoDeEncabezado(lectura);
  const fallos: string[] = [];
  for (const palabra of encabezado) {
    if (!tarjeta.has(palabra)) fallos.push(`el encabezado declara «${palabra}» y la tarjeta no lo rotula`);
  }
  for (const palabra of tarjeta) {
    if (!encabezado.has(palabra)) fallos.push(`la tarjeta rotula «${palabra}» y el encabezado no lo declara`);
  }
  return fallos;
}

/** Un rótulo que el encabezado no dice: el vocabulario divergió. */
function vocabularioDivergente(lectura: Lectura): string[] {
  const declaradas = new Set(palabrasDeEncabezado(lectura).map(({ palabra }) => palabra));
  return palabrasDeFila(lectura)
    .map(({ palabra }) => palabra)
    .filter((palabra) => !declaradas.has(palabra));
}

/* --------------------------------------------------------------------------
   El archivo real.
   -------------------------------------------------------------------------- */

const LECTURA = leer(CLIENT);
const CAMPOS = camposDe(LECTURA);

/* --------------------------------------------------------------------------
   El anclaje de los controles negativos: se MUTA UNA COPIA DEL FUENTE EN
   MEMORIA —el archivo del repositorio no se toca, ni para escribir ni para dejar
   rastro— y esa copia pasa por la cadena completa de la guarda: regiones →
   campos → clases efectivas → predicados.
   -------------------------------------------------------------------------- */

/** El fuente real con un `const` sustituido por otro `cn("…")`. */
function conClase(nombre: string, clase: string): string {
  const patron = new RegExp(`(const\\s+${nombre}\\s*=\\s*)cn\\([^;]*?\\);`);
  if (!patron.test(CLIENT)) throw new Error(`el fuente no declara \`${nombre}\` como \`cn(...)\``);
  return CLIENT.replace(patron, `$1cn("${clase}");`);
}

/** La lectura de un FUENTE mutado en memoria, con la mutación comprobada. */
function lecturaDe(mutacion: (fuente: string) => string, opciones: { fila?: boolean } = {}): Lectura {
  const fuente = mutacion(CLIENT);
  if (fuente === CLIENT) throw new Error("la mutación no cambió el fuente");
  const lectura = leer(fuente);
  if (lectura.row.length === 0) throw new Error("la fila mutada no se leyó");
  // Con `fila` se exige además que la mutación haya caído DENTRO de la fila, que
  // es lo que separa «cambié una constante de clase» de «cambié el marcado».
  if (opciones.fila === true && lectura.row === LECTURA.row) {
    throw new Error("la mutación no cayó dentro de la fila");
  }
  return lectura;
}

/** La etiqueta literal de una palabra, tal como está en la fila real. */
function literalDeEtiqueta(palabra: string): string {
  return `<span className={campoLabelClass}>${palabra}: </span>`;
}

/** La fila a la que se le borró la etiqueta de una palabra. */
function sinPalabra(palabra: string): Lectura {
  const literal = literalDeEtiqueta(palabra);
  return lecturaDe((fuente) => {
    if (!rowRegion(fuente).includes(literal)) throw new Error(`la fila no rotula «${palabra}»`);
    return fuente.replace(literal, "");
  }, { fila: true });
}

/** La fila con la etiqueta de una palabra corrida al final de su celda. */
function conPalabraAlFinal(palabra: string): Lectura {
  const literal = literalDeEtiqueta(palabra);
  return lecturaDe((fuente) => {
    const region = rowRegion(fuente);
    const desde = region.indexOf(literal);
    if (desde === -1) throw new Error(`la fila no rotula «${palabra}»`);
    const celda = region.indexOf("</td>", desde + literal.length);
    if (celda === -1) throw new Error(`«${palabra}» no tiene celda`);
    const cuerpo = region.slice(desde + literal.length, celda);
    return fuente.replace(
      region,
      region.slice(0, desde) + cuerpo + literal + region.slice(celda),
    );
  }, { fila: true });
}

/** La fila con el rótulo de una palabra cambiado por otro que el encabezado no dice. */
function conPalabraDistinta(palabra: string, otra: string): Lectura {
  return lecturaDe((fuente) => {
    const literal = literalDeEtiqueta(palabra);
    if (!rowRegion(fuente).includes(literal)) throw new Error(`la fila no rotula «${palabra}»`);
    return fuente.replace(literal, literalDeEtiqueta(otra));
  }, { fila: true });
}

/* ==========================================================================
   1. Abajo de `sm`: una tarjeta por turno, con su etiqueta en cada valor
   ========================================================================== */

describe("caja: la fila de turnos se apila y cada valor dice qué es (R38)", () => {
  it("las dos regiones y sus celdas se leen del archivo real", () => {
    expect(LECTURA.header.length, "bloque del encabezado").toBeGreaterThan(300);
    expect(LECTURA.row.length, "bloque de la fila").toBeGreaterThan(500);
    expect(CAMPOS.length, "celdas de la fila (13 fijas + la dinámica)").toBe(
      ORDEN_MOVIL.length,
    );
  });

  it("las catorce columnas del encabezado siguen ahí, en el orden de siempre", () => {
    expect(palabrasDeEncabezado(LECTURA).map(({ palabra }) => palabra)).toEqual(ORDEN_ESCRITORIO);
  });

  it("la columna dinámica se rotula con el nombre del método, como su encabezado", () => {
    const metodo = campoDeMetodo(LECTURA);
    expect(metodo, "la celda del método de pago").toBeDefined();
    expect(etiquetaDe(metodo as Campo, LECTURA)?.palabra).toBe(PALABRA_METODO);
    expect(LECTURA.row.match(/\{method\.name\}/g), "la etiqueta de la fila").toHaveLength(1);
    expect(LECTURA.header.match(/\{method\.name\}/g), "la del encabezado").toHaveLength(1);
  });

  it("cada valor apilado abre con su etiqueta, y en el teléfono esa etiqueta se lee", () => {
    expect(sinEtiqueta(LECTURA), "celdas sin etiqueta").toEqual([]);
    expect(etiquetasApagadasEnElTelefono(LECTURA), "rótulos que no se leen").toEqual([]);
  });

  it("la etiqueta que rotula también se ve: un rótulo perfecto no dice nada sin su valor", () => {
    expect(valoresApagadosEnElTelefono(LECTURA), "valores apagados").toEqual([]);
  });

  it("todas las etiquetas comparten la misma clase, declarada una vez", () => {
    const exprs = new Set(
      camposDe(LECTURA)
        .map((campo) => etiquetaDe(campo, LECTURA))
        .filter((etiqueta): etiqueta is Etiqueta => etiqueta !== undefined)
        .map((etiqueta) => etiqueta.expr),
    );
    expect([...exprs], "las expresiones de className de las etiquetas").toEqual(["campoLabelClass"]);
  });

  it("ninguna etiqueta sale de la lista de palabras del encabezado", () => {
    // El otro modo de fallar: rotular la fila con un rótulo que el encabezado
    // no dice («Vendedor» donde arriba dice «Abrió»).
    expect(vocabularioDivergente(LECTURA)).toEqual([]);
  });
});

/* ==========================================================================
   2. Arriba de `sm`: el encabezado manda y el escritorio queda como estaba
   ========================================================================== */

describe("caja: arriba de `sm` la etiqueta se va y la tabla no se movió", () => {
  it("las catorce etiquetas se apagan arriba de `sm`", () => {
    expect(etiquetasVisiblesEnEscritorio(LECTURA), "rótulos en escritorio").toEqual([]);
  });

  it("el encabezado es el que nombra las columnas: abajo se apaga, arriba se ve", () => {
    expect(encabezadoInvertido(LECTURA)).toEqual([]);
  });

  it("el `whitespace-nowrap` de las celdas es de escritorio, no del teléfono", () => {
    expect(nowrapEnElTelefono(LECTURA), "nowrap en el teléfono").toEqual([]);
  });

  it("arriba de `sm` ninguna celda conserva el ancho de la tarjeta", () => {
    expect(anchosFijosEnEscritorio(LECTURA), "celdas con ancho fijo en escritorio").toEqual([]);
  });

  it("el piso de ancho del escritorio no existe en el teléfono", () => {
    expect(pisoEnElTelefono(LECTURA), "piso en el teléfono").toEqual([]);
    // Y arriba sigue declarado: el escritorio conserva su carril.
    const tabla = twMerge(claseDeElemento(LECTURA.source, /<table\b[^>]*>/)).split(/\s+/);
    expect(pisoActivo(tabla, 1024), "el piso a 1024").not.toBe("");
    expect(pisoActivo(tabla, 390), "el piso a 390").toBe("");
  });

  it("la tarjeta no abre un carril horizontal propio", () => {
    expect(vaciaExpresiones(LECTURA.row), "carril dentro de la tarjeta").not.toMatch(/overflow-x/);
  });
});

/* ==========================================================================
   3. La acción de la fila, y lo que ve cada rol
   ========================================================================== */

describe("caja: la acción de la fila y la paridad por rol", () => {
  it("la acción está en su propia línea, a lo ancho y sin recorte", () => {
    expect(accionAlcanzableEnElTelefono(LECTURA)).toEqual([]);
    const accion = CAMPOS[CAMPOS.length - 1];
    expect(accion.inner, "los botones de la acción").toMatch(/Recontar|Versiones/);
    expect(etiquetaDe(accion, LECTURA)?.palabra, "la última celda").toBe("Reconteo");
  });

  it("la tarjeta y el encabezado esconden lo MISMO tras el rol de admin", () => {
    expect(paridadDeRol(LECTURA)).toEqual([]);
    const fila = palabrasDeFila(LECTURA);
    expect(
      fila.filter(({ admin }) => !admin).map(({ palabra }) => palabra),
      "lo que ve un no-admin",
    ).toEqual(COMUNES);
    expect(
      fila.filter(({ admin }) => admin).map(({ palabra }) => palabra),
      "lo que ve el admin",
    ).toEqual(ORDEN_MOVIL.filter((palabra) => SOLO_ADMIN.has(palabra) || palabra === PALABRA_METODO));
  });

  it("el orden de lectura de la tarjeta es el declarado, no el del escritorio", () => {
    expect(palabrasDeFila(LECTURA).map(({ palabra }) => palabra)).toEqual(ORDEN_MOVIL);
    expect(ORDEN_MOVIL).not.toEqual(ORDEN_ESCRITORIO);
  });

  it("la tarjeta no pierde ninguna columna: la densidad es declarada, no accidental", () => {
    const tarjeta = new Set(palabrasDeFila(LECTURA).map(({ palabra }) => palabra));
    expect(ORDEN_ESCRITORIO.filter((palabra) => !tarjeta.has(palabra))).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   EL CONTROL NEGATIVO DEL PREDICADO: el marcado VIEJO, tal como estaba antes
   del arreglo (tabla con piso, celdas con `nowrap`, valores sin etiqueta).
   -------------------------------------------------------------------------- */

const MARKUP_ANTES = `<tr key={view.shift.id} className={tableRowClass}>
  <td className={shiftCellClass}>{formatDateTime(view.shift.opened_at)}</td>
  <td className={shiftCellClass}>{view.shift.status}</td>
  <td className={cn(shiftCellClass, "max-w-48 truncate")} title={view.abierto_por ?? undefined}>
    {view.abierto_por ?? "—"}
  </td>
  <td className={shiftCellClass}>{formatMoney(view.shift.opening_base)}</td>
  <td className={shiftCellClass}>
    {!isClosed ? "—" : view.recount ? (
      <span className="inline-flex items-center gap-2">
        <span className="font-medium text-warning">Recontado</span>
        <button type="button" className="underline" onClick={() => onShowVersions(view)}>
          Versiones
        </button>
      </span>
    ) : (
      <button type="button" className="underline" onClick={() => onRecount(view)}>
        Recontar
      </button>
    )}
  </td>
</tr>
`;

describe("el predicado no es un sello de goma", () => {
  it("el marcado viejo —valores sin etiqueta, con `nowrap` y con piso— se acusa", () => {
    const vieja: Lectura = { header: LECTURA.header, row: MARKUP_ANTES, source: CLIENT };
    expect(sinEtiqueta(vieja, ).length, "celdas sin etiqueta").toBe(5);
    const fallos = etiquetasApagadasEnElTelefono(vieja);
    expect(fallos).toHaveLength(5);
    for (const fallo of fallos) expect(fallo).toContain("no abre con su propia etiqueta");
    expect(nowrapEnElTelefono(vieja), "nowrap").toHaveLength(20);
    expect(etiquetasVisiblesEnEscritorio(vieja), "no hay rótulo que apagar").toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   LA ETIQUETA QUE SE APAGA EN EL FONDO. Estos controles son la razón de
   reescribir la cuenta: una guarda que afirma que la etiqueta «traía
   `sm:hidden»» mira un TOKEN, y un token pasa con `hidden sm:hidden` en la misma
   lista: el rótulo invisible en los cuatro anchos del teléfono y el archivo
   verde. Cada mutación de acá es la edición que alguien haría en
   `cash-client.tsx`, aplicada a una COPIA en memoria.
   -------------------------------------------------------------------------- */

describe("caja: la etiqueta que se apaga en el fondo se acusa", () => {
  const ETIQUETA_BASE = "font-medium text-text-secondary";

  it("un `hidden` pelado en la etiqueta la esconde en los cuatro anchos del teléfono", () => {
    // La edición: `className="… text-text-secondary sm:hidden hidden"`.
    const fila = lecturaDe(() => conClase("campoLabelClass", `${ETIQUETA_BASE} sm:hidden hidden`));
    const palabra = etiquetaDe(CAMPOS[0], LECTURA)?.palabra ?? "Apertura";
    expect(etiquetasApagadasEnElTelefono(fila)).toEqual(
      CAMPOS.flatMap((campo) =>
        ANCHOS_MOVILES.map(
          (vw) => `«${etiquetaDe(campo, LECTURA)?.palabra ?? palabra}» a ${vw}px: la esconde \`hidden\``,
        ),
      ),
    );
    expect(etiquetasApagadasEnElTelefono(fila)).toHaveLength(CAMPOS.length * 4);
    expect(etiquetasVisiblesEnEscritorio(fila), "arriba de `sm` sigue apagada").toEqual([]);
  });

  it("`sr-only`, `invisible` y `opacity-0` apagan igual, y cada uno se acusa", () => {
    for (const utilidad of ["sr-only", "invisible", "opacity-0"]) {
      const fila = lecturaDe(() => conClase("campoLabelClass", `${ETIQUETA_BASE} sm:hidden ${utilidad}`));
      const fallos = etiquetasApagadasEnElTelefono(fila);
      expect(fallos.length, `la etiqueta con \`${utilidad}\``).toBe(CAMPOS.length * 4);
      for (const fallo of fallos) expect(fallo).toContain(`\`${utilidad}\``);
    }
  });

  it("un `max-sm:hidden` —«escondida justo en el teléfono»— también se acusa", () => {
    const fila = lecturaDe(() =>
      conClase("campoLabelClass", `${ETIQUETA_BASE} sm:hidden max-sm:hidden`),
    );
    expect(etiquetasApagadasEnElTelefono(fila)[0]).toBe(
      `«Apertura» a ${ANCHOS_MOVILES[0]}px: la esconde \`max-sm:hidden\``,
    );
    expect(etiquetasVisiblesEnEscritorio(fila), "arriba de `sm` la apaga el `sm:hidden` de verdad").toEqual([]);
  });

  it("arriba de `sm`, una etiqueta que vuelve a verse se acusa en los cuatro anchos", () => {
    // La edición: `sm:hidden sm:block`. `twMerge` la funde en `sm:block` —no hay
    // dos clases, hay una que gana— y la cascada la encuentra prendida.
    const fila = lecturaDe(() => conClase("campoLabelClass", `${ETIQUETA_BASE} sm:block`));
    expect(etiquetasVisiblesEnEscritorio(fila)).toEqual(
      CAMPOS.flatMap((campo) =>
        ANCHOS_ESCRITORIO.map((vw) => `«${etiquetaDe(campo, LECTURA)?.palabra}» se ve a ${vw}px`),
      ),
    );
  });

  it("apagar el VALOR de una línea se acusa aunque su rótulo siga perfecto", () => {
    const fila = lecturaDe(() =>
      conClase(
        "campoClass",
        "w-full min-w-0 whitespace-normal py-1 sm:table-cell sm:w-auto sm:whitespace-nowrap hidden",
      ),
    );
    expect(valoresApagadosEnElTelefono(fila).length, "valores apagados").toBeGreaterThan(0);
    expect(etiquetasApagadasEnElTelefono(fila), "las etiquetas siguen bien").toEqual([]);
  });

  it("quitarle la etiqueta a una línea se acusa por esa línea, no por las otras", () => {
    const fila = sinPalabra("Estado");
    expect(sinEtiqueta(fila)).toHaveLength(1);
    expect(etiquetasApagadasEnElTelefono(fila)).toEqual([
      expect.stringContaining("la línea no abre con su propia etiqueta"),
    ]);
    expect(etiquetasVisiblesEnEscritorio(fila), "las otras siguen apagadas arriba").toEqual([]);
  });

  it("correr la etiqueta del principio de la línea se acusa aunque siga siendo la suya", () => {
    // La edición: el rótulo se mueve después del valor. Sigue siendo una
    // etiqueta, sigue con la palabra del encabezado, sigue `sm:hidden`… y la
    // línea se lee `$ 200.000Base inicial:`. Sólo lo caza el criterio de posición.
    const fila = conPalabraAlFinal("Base inicial");
    expect(sinEtiqueta(fila), "ya no abre con su rótulo").toHaveLength(1);
    expect(etiquetasVisiblesEnEscritorio(fila), "y el resto sigue igual").toEqual([]);
  });

  it("un rótulo inventado —«Vendedor» donde el encabezado dice «Abrió»— se acusa", () => {
    const fila = conPalabraDistinta("Abrió", "Vendedor");
    expect(vocabularioDivergente(fila)).toEqual(["Vendedor"]);
    // Y la comparación que hace la guarda real lo rechaza:
    expect(vocabularioDivergente(LECTURA), "el archivo real no diverge").toEqual([]);
  });

  it("devolver una columna de admin a la tarjeta la acusa en las dos superficies", () => {
    // La edición: el `isAdmin` del segundo grupo pasa a ser otra condición, así
    // que la tarjeta rotula esas columnas para todo el mundo mientras el
    // encabezado se las sigue escondiendo.
    const fila = lecturaDe((fuente) => {
      // Se renombra SÓLO la primera rama de admin DE LA FILA (la segunda del
      // encabezado no se toca): la tarjeta rotula esas columnas para todo el
      // mundo mientras el encabezado se las sigue escondiendo.
      const region = rowRegion(fuente);
      const base = fuente.indexOf(region);
      const patron = /\{\s*isAdmin\s*&&\s*\(/g;
      const primera = patron.exec(region);
      if (primera === null) throw new Error("la fila no declara la rama de admin");
      const desde = base + primera.index;
      return (
        fuente.slice(0, desde) +
        "{permisoLegacy && (" +
        fuente.slice(desde + primera[0].length)
      );
    }, { fila: true });
    expect(paridadDeRol(fila)).toContain("la tarjeta rotula «Ventas» y el encabezado no lo declara");
    expect(paridadDeRol(LECTURA), "el archivo real sí está en paridad").toEqual([]);
  });

  it("recortar la acción por arriba la acusa: alcanzable no es lo mismo que visible", () => {
    const fila = lecturaDe(() =>
      conClase(
        "accionesClass",
        "flex w-full flex-wrap items-center gap-2 py-1 whitespace-normal sm:table-cell sm:w-auto sm:whitespace-nowrap truncate",
      ),
    );
    expect(accionAlcanzableEnElTelefono(fila)).toHaveLength(ANCHOS_MOVILES.length);
  });

  it("el `className` de la etiqueta es el que estas cuentas están leyendo", () => {
    const etiqueta = etiquetaDe(CAMPOS[0], LECTURA);
    expect(etiqueta?.expr, "la expresión").toBe("campoLabelClass");
    expect(etiqueta?.palabra).toBe("Apertura");
    expect(tokenQueEsconde(etiqueta?.clase ?? "", 390), "en el teléfono").toBe("");
    expect(tokenQueEsconde(etiqueta?.clase ?? "", 1024), "en el escritorio").toBe("sm:hidden");
  });
});