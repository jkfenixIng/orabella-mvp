import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// El MISMO módulo del que `cn(...)` saca la clase que llega al DOM. No es una
// copia de la regla de fusión: es la regla.
import { twMerge } from "tailwind-merge";

/* --------------------------------------------------------------------------
   R38 — la fila de la lista de facturas, apilada, con su etiqueta.

   El defecto que esta guarda cierra: por debajo de `sm` la fila deja de ser
   tabla y se apila —lo que el contrato pide—, pero el encabezado que nombra las
   columnas es `hidden … sm:grid`, así que en un teléfono quedan nueve valores
   desnudos: `#12`, `03/10 16:41`, `Carolina Rojas`, `—`, `—`, `Carolina Rojas`,
   `$120.000`, `Pagada` y los botones. ¿La primera fecha es la de emisión o la de
   cierre? ¿El primer nombre es la vendedora o la que cerró? Ninguna
   instrumentación ve eso: no desborda, nada queda tapado, nada se recorta.

   LO QUE SE AFIRMA, en una sola invariante y por fuente (mismo método que
   `ux-data-table.test.ts` y `no-raw-palette.test.ts`: sin DOM, leyendo el
   archivo real):

     1. ABAJO DE `sm`, cada valor apilado lleva su etiqueta visible —la del
        encabezado, la MISMA palabra, dentro del span del propio valor.
     2. ARRIBA DE `sm`, esas etiquetas no existen: el encabezado ya nombra, y
        dos veces el mismo rótulo es ruido (y `Acciones` se leería dos veces).
     3. ARRIBA DE `sm` la fila no se mueve: nueve columnas en el orden del DOM.
        Como la tarjeta móvil reordena y agrupa para abajo, cada hoja tiene que
        pinear su columna con `sm:col-start-N` explícita. Sin eso, el orden
        visual de escritorio dependería del orden del DOM —y el orden del DOM es
        el de la tarjeta.

   POR QUÉ LA ETIQUETA ES LA PALABRA DEL ENCABEZADO: el vocabulario se escribe
   una vez (el encabezado) y se lee en los dos lados, así que las dos
   superficies no pueden divergir. Por eso la guarda NO tiene una lista de
   palabras: lee las nueve del encabezado del archivo real y exige que las
   etiquetas sean ese mismo conjunto.

   LA LISTA DE FACTURAS ES LA REFERENCIA: las otras cinco (caja, vales, admin,
   inventario, servicios) son `<table>` con carril y tomarán este mismo par
   etiqueta/valor cuando les toque. Por eso el marcado es plano y legible a
   máquina —una hoja por columna, la etiqueta como primer hijo del span del
   valor— y no un componente nuevo: un solo consumidor no da para diseñar una
   abstracción.
   -------------------------------------------------------------------------- */

const CLIENT_PATH = join(process.cwd(), "app", "invoices", "invoices-client.tsx");
const CLIENT = readFileSync(CLIENT_PATH, "utf8");

/** La escala de las nueve columnas: aparece en el encabezado y en la fila. */
const COLUMN_SCALE = "grid-cols-[2.5rem_7.5rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem_minmax(0,1.2fr)_5.5rem_4.5rem_4.5rem]";

/** El `<ul>` de la lista: termina el bloque del encabezado. */
const LIST_ANCHOR = '<ul className="flex flex-col divide-y';

/** El diálogo de detalle abre después de la fila: termina su bloque. */
const DIALOG_ANCHOR = "{detail && detail.invoice.id === row.id && (";

/* --------------------------------------------------------------------------
   Las dos regiones que se leen del archivo real.
   -------------------------------------------------------------------------- */

function headerRegion(source: string): string {
  const start = source.indexOf(COLUMN_SCALE);
  const end = source.indexOf(LIST_ANCHOR);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

/**
 * La fila: su `<li>` (el primero con `key={row.id}`) hasta el diálogo. En un
 * fragmento suelto —el marcado del control negativo— cierra en su `</li>`.
 */
function rowRegion(source: string): string {
  const start = source.search(/<li\s+key=\{row\.id\}/);
  if (start < 0) return "";
  const dialog = source.indexOf(DIALOG_ANCHOR, start);
  const end = dialog >= 0 ? dialog : source.indexOf("</li>", start);
  return end > start ? source.slice(start, end) : "";
}

/* --------------------------------------------------------------------------
   Lectores. Tokens de clase completos y `<span>` balanceados: una etiqueta
   dentro de una hoja no es lo mismo que una etiqueta al lado.
   -------------------------------------------------------------------------- */

/** Las nueve palabras del encabezado, en orden de columna. */
function headerWords(region: string): string[] {
  return [...region.matchAll(/<span(?:\s+className="[^"]*")?\s*>([^<]+)<\/span>/g)].map((match) =>
    match[1].trim(),
  );
}

/**
 * Las expresiones JSX —y con ellas los comentarios `{/* … *\/}`— se vacían
 * ANTES de leer etiquetas: dentro de un `{...}` hay `=>`, `&&` y `<` que no
 * son markup y harían desbalancear el conteo de `<span>`. Se reemplazan por
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

/**
 * Una hoja: un span que pinea su columna de escritorio.
 */
interface SpanNode {
  className: string;
  inner: string;
}

/** Todos los `<span>` de la región, con su clase (vacía si no tiene) y su contenido. */
function allSpans(region: string): SpanNode[] {
  const found: SpanNode[] = [];
  const markup = blankExpressions(region);
  for (const match of markup.matchAll(/<span\b([^>]*)>/g)) {
    const open = match.index + match[0].length;
    const close = matchingClose(markup, open);
    if (close === -1) continue;
    const className = /className="([^"]*)"/.exec(match[1]);
    found.push({ className: className === null ? "" : className[1], inner: markup.slice(open, close) });
  }
  return found;
}

/** Un envoltorio de línea: se borra de la grilla de arriba con `sm:contents`. */
function isWrapper(node: SpanNode): boolean {
  return /(^|\s)sm:contents(\s|$)/.test(node.className);
}

/**
 * Una etiqueta es un span de texto que termina en dos puntos —«Estado: »—.
 * Que termine en dos puntos es lo que la distingue de un valor de texto plano
 * (el `#` que precede al número de factura).
 */
function isLabel(node: SpanNode): boolean {
  return /^\s*[^<>{}]+:\s*$/.test(node.inner);
}

/** Las hojas de valor: ni envoltorio de línea ni etiqueta. Son las nueve. */
function valueSpans(region: string): SpanNode[] {
  return allSpans(region).filter((node) => !isWrapper(node) && !isLabel(node));
}

/** La etiqueta de una hoja, si la tiene. */
function labelOf(leaf: SpanNode): SpanNode | undefined {
  return allSpans(leaf.inner).find(isLabel);
}

/** El primer elemento `<span>` que hay dentro de una hoja: la etiqueta, si abre la línea. */
function firstChildOf(leaf: SpanNode): SpanNode | undefined {
  return allSpans(leaf.inner)[0];
}

/**
 * La etiqueta ABRE el markup de la hoja: ni al lado de la hoja, ni después del
 * valor (`#12ID:`). Se lee del markup crudo —no de la lista de `<span>`— para
 * que «la etiqueta es el primer elemento que hay» no se confunda con «la
 * etiqueta es el primer span que se encuentra», que también pasa con el
 * rótulo corrido al final.
 */
const ETIQUETA_ABRE =
  /^\s*<span\b[^>]*className="[^"]*"[^>]*>\s*[^<>{}]+:\s*<\/span>/;

/* ==========================================================================
   LA CLASE EFECTIVA, NO EL TOKEN.

   Esta guarda nació mirando TOKENS, y un token no puede ver la cascada. La
   cuenta es esta: la lista de la etiqueta era
   `font-sans font-medium text-text-secondary sm:hidden` —contiene `sm:hidden`—,
   así que el criterio de «está escondida arriba de `sm`» pasaba; y agregar un
   `hidden` pelado a esa misma lista la deja escondida en TODOS los anchos,
   incluido el teléfono, donde la etiqueta es lo único que dice qué valor es.
   Lo mismo con `sr-only`, con `invisible`, con `opacity-0`, y con
   `max-sm:hidden` —que no es ni el mismo token: es «escondida justo en el
   teléfono», el ancho donde tiene que verse.

   Por eso, para la VISIBILIDAD, esto mezcla la lista con `twMerge` —el mismo
   módulo del que `cn(...)` saca la clase que llega al DOM— y después resuelve
   la cascada como la resuelve el CSS a un ancho dado: dentro de una PROPIEDAD
   gana la variante más alta que esté ACTIVA, y a igual variante gana la última
   que se escribió. Un `sm:hidden sm:block` se funde en `sm:block` y se acusa;
   un `hidden sm:hidden` sobrevive la fusión (son el mismo grupo con distinta
   variante, que es justo el caso ciego) y lo acusa la cascada, porque a 390 px
   el único `display` activo es el `hidden` pelado.

   LO QUE ESTA GUARDA NO PUEDE VER, DICHO DE ANTEMBIO: acá no hay navegador.
   Sólo se afirma lo que el `className` PIDE. No ve un `style` en línea, ni una
   regla de `globals.css`, ni un `hidden` heredado de un ancestro, ni un
   contenedor `@media` — y tampoco una variante que dependa del estado y no del
   ancho (`hover:`, `dark:`, `group-hover:`), que se tratan como inactivas. Lo
   que se midió de verdad —nueve rótulos visibles a 412/390/360/320 y
   `display:none` a 1024— está en `odd/tasks/auditoria-responsive.md`.
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
 *
 * Sin variante pesa 0. `sm:` pesa 640 y sólo pesa si el viewport ya llegó a
 * 640. `max-sm:` pesa −640 y sólo pesa por debajo de 640 — es el signo de
 * «escondida justo en el teléfono». Una variante que no sea de ancho
 * (`hover:`, `dark:`, `group-hover:`, un arbitrario) NO es una decisión de
 * ancho: se trata como inactiva, y por eso es un límite declarado de esta
 * cuenta, no un accidente.
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
 * Es el predicado del contrato de visibilidad: se lee de la clase EFECTIVA
 * (la que sale de `twMerge`) y de la cascada a ese ancho, no del token tal
 * cual. Lo que apaga un elemento en Tailwind son cuatro vías y están las
 * cuatro: `display:none` (`hidden`, con o sin variante), `visibility:hidden`
 * (`invisible`, `collapse`), `opacity:0`, y el recorte de `sr-only`.
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

/* --------------------------------------------------------------------------
   El predicado del contrato. Son FUNCIONES, no `expect` sueltos: al final se
   corren contra el marcado viejo, y tienen que acusarlo.
   -------------------------------------------------------------------------- */

/**
 * Hojas apiladas que no dicen qué valor es el que muestran.
 *
 * Ya NO se afirma sobre el archivo real: sola —«existe un span que parece una
 * etiqueta»— no puede caerse mientras las otras afirmaciones sigan verdes, y
 * por eso era adorno. Sobre el archivo real la afirmación es
 * `lineasInvisiblesEnElTelefono`; aquí sigue sirviendo para los controles
 * negativos, donde sí tiene que devolver algo.
 */
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
 *      el renglón queda `#12` solo o `#12ID:` pegado al número—;
 *   2. la etiqueta tiene una clase que la apaga en ese ancho —`hidden`,
 *      `sr-only`, `invisible`, `opacity-0`, `max-sm:hidden`—: el rótulo está
 *      en el fuente y no se lee, que es el defecto que la versión anterior de
 *      esta guarda no veía;
 *   3. el VALOR tiene una clase que lo apaga en ese ancho: una etiqueta
 *      perfecta no dice nada si el valor que rotula no está.
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
 *
 * Antes esto era «el `className` trae `sm:hidden`», un token. Ahora es la
 * cuenta: a 640 y más, la etiqueta tiene que quedar apagada por la cascada de
 * su clase efectiva. Un `sm:block`, un `sm:flex` o un `sm:contents` agregado
 * al lado del `sm:hidden` se funden y se acusa; un `hidden` pelado la apaga
 * arriba… y también abajo, que es lo que caza el criterio del teléfono.
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

/* --------------------------------------------------------------------------
   El archivo real.
   -------------------------------------------------------------------------- */

const HEADER = headerRegion(CLIENT);
const ROW = rowRegion(CLIENT);
const WORDS = headerWords(HEADER);
const ROW_VALUES = valueSpans(ROW);

/* --------------------------------------------------------------------------
   El anclaje de los controles negativos: la etiqueta del `#`, tal como está en
   la fila real. Con ella se MUTA una COPIA DEL FUENTE EN MEMORIA —el archivo
   del repositorio no se toca, ni para escribir ni para dejar rastro— y esa
   copia pasa por la cadena completa de la guarda: `rowRegion` →
   `blankExpressions` → predicados. Un control que sólo mutara el tramo ya
   extraído no probaría que los anclajes siguen leyéndolo.
   -------------------------------------------------------------------------- */

/** La apertura y la clase de la etiqueta del `#`, y el rango de su markup. */
function etiquetaId(source: string): { desde: number; hasta: number; clase: string } {
  const texto = source.indexOf(">ID: </span>");
  if (texto < 0) throw new Error("la fila no abre con la etiqueta `ID: `");
  const desde = source.lastIndexOf("<span", texto);
  const clase = /className="([^"]*)"/.exec(source.slice(desde, texto));
  if (clase === null) throw new Error("la etiqueta del `#` no declara `className`");
  return { desde, hasta: texto + ">ID: </span>".length, clase: clase[1] };
}

/** El fuente real con la etiqueta del `#` sustituida por otro markup. */
function sustituirEtiquetaId(fuente: string, nuevo: string): string {
  const { desde, hasta } = etiquetaId(fuente);
  return fuente.slice(0, desde) + nuevo + fuente.slice(hasta);
}

/** El fuente real con la etiqueta del `#` corrida al final de su línea. */
function moverEtiquetaIdAlFinal(fuente: string): string {
  const { desde, hasta, clase } = etiquetaId(fuente);
  const valor = "{row.consecutive_number}";
  const enValor = fuente.indexOf(valor, hasta);
  if (enValor < 0) throw new Error("la fila no declara `{row.consecutive_number}`");
  return (
    fuente.slice(0, desde) +
    fuente.slice(hasta, enValor + valor.length) +
    `<span className="${clase}">ID: </span>` +
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

/** La fila con la clase de la etiqueta del `#` sustituida por `clase`. */
function filaConEtiqueta(clase: string): string {
  return filaDe((fuente) => sustituirEtiquetaId(fuente, `<span className="${clase}">ID: </span>`));
}

/** La fila a la que se le borró la etiqueta del `#`. */
function filaSinEtiqueta(): string {
  return filaDe((fuente) => sustituirEtiquetaId(fuente, ""));
}

/** La fila con la etiqueta del `#` corrida al FINAL de su línea. */
function filaConEtiquetaAlFinal(): string {
  return filaDe(moverEtiquetaIdAlFinal);
}

describe("la lista de facturas: anti-vacío", () => {
  it("las dos regiones se leen del archivo real", () => {
    expect(HEADER.length, "bloque del encabezado").toBeGreaterThan(200);
    expect(ROW.length, "bloque de la fila").toBeGreaterThan(500);
    expect(HEADER).toContain("sm:grid");
    expect(ROW).toContain("sm:grid-cols-");
  });

  it("el encabezado sigue siendo el que nombra las nueve columnas, y sólo arriba de `sm`", () => {
    expect(WORDS, "las nueve palabras del encabezado").toHaveLength(9);
    // Abajo de `sm` el encabezado no se ve: por eso la fila necesita su etiqueta.
    expect(CLIENT).toMatch(/className="hidden grid-cols-\[2\.5rem[^\n]*\bsm:grid\b/);
  });

  it("la fila sigue siendo una tarjeta abajo y una grilla de nueve arriba", () => {
    expect(ROW).toMatch(/<li[\s\S]*?className="flex flex-col[^"]*sm:grid sm:grid-cols-\[/);
    // Y la tarjeta no abre un carril horizontal: se apila, no se scrollea.
    const vivo = blankExpressions(ROW);
    expect(vivo, "carril horizontal en la tarjeta").not.toMatch(/overflow-x/);
    expect(vivo, "piso de ancho inventado en la tarjeta").not.toMatch(/min-w-\[\d+px\]/);
  });
});

describe("cada valor apilado dice qué es (R38)", () => {
  it("las nueve líneas abren con su etiqueta, y en el teléfono esa etiqueta se lee", () => {
    // Éste era un adorno: «cada hoja tiene un span que se parece a una
    // etiqueta» no puede fallar mientras las otras afirmaciones del archivo
    // sigan verdes. Ahora afirma el EFECTO, por línea: la etiqueta abre la
    // línea, y ni la etiqueta ni el valor que rotula se apagan en ninguno de
    // los cuatro anchos angostos. Sacar la etiqueta, correrla de sitio o
    // pegarle un `hidden` la hacen fallar —cada una por su cuenta.
    expect(lineasInvisiblesEnElTelefono(ROW), "las nueve líneas del teléfono").toEqual([]);
    expect(ROW_VALUES, "hojas de valor por columna").toHaveLength(9);
    expect(
      ROW_VALUES.filter((leaf) => isLabel(firstChildOf(leaf) ?? { className: "", inner: "" })),
      "las nueve líneas abren con su rótulo",
    ).toHaveLength(9);
  });

  it("la etiqueta es la palabra del encabezado: las dos superficies no divergen", () => {
    expect(labelledWords(ROW), "las nueve etiquetas").toEqual(
      expect.arrayContaining(WORDS),
    );
    expect(labelledWords(ROW).slice().sort(), "las nueve etiquetas").toEqual(WORDS.slice().sort());
  });

  it("la etiqueta vive dentro del span del valor, no al lado", () => {
    for (const leaf of ROW_VALUES) {
      // Lo que este criterio afirma es la POSICIÓN, y la posición no la daba
      // ninguna clase: la etiqueta abre el markup de la hoja. La otra mitad
      // del criterio anterior —que el `className` trajera `sm:hidden`— era un
      // token, y un token pasa con `hidden sm:hidden`; esa mitad vive ahora,
      // como efecto, en los dos criterios de visibilidad.
      expect(leaf.inner, "la etiqueta abre el span del valor").toMatch(ETIQUETA_ABRE);
      // Y la hoja no tiene dos rótulos: uno, el suyo.
      expect(allSpans(leaf.inner).filter(isLabel), leaf.className).toHaveLength(1);
    }
  });
});

describe("la etiqueta desaparece arriba de `sm`", () => {
  it("las nueve se apagan arriba de `sm`: el encabezado ya nombró cada columna", () => {
    // Éste también era adorno, por la misma razón: la mitad del criterio
    // viejo —«trae `sm:hidden`»— la implicaba el regex de la posición, así
    // que no podía caerse. Ahora se afirma el resultado: a 640, 768, 1024 y
    // 1440 la cascada de la clase efectiva de cada etiqueta la tiene que
    // apagar. Un `sm:block`/`sm:flex` pegado al `sm:hidden` se funde con él y
    // se cae acá.
    expect(labelsVisibleOnDesktop(ROW), "etiquetas que se verían en escritorio").toEqual([]);
    expect(labelledWords(ROW), "las nueve etiquetas siguen estando").toHaveLength(9);
  });

  it("el control negativo: quitarle `sm:hidden` a una etiqueta se acusa", () => {
    const sinVariante = ROW.replace(/(^|[\s"])sm:hidden(?=[\s"])/, "$1");
    expect(sinVariante, "el archivo real declara la variante").not.toBe(ROW);
    expect(labelsVisibleOnDesktop(sinVariante)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«ID:» se ve a ${vw}px`),
    );
  });
});

describe("arriba de `sm` la grilla de nueve columnas no se movió", () => {
  it("cada hoja pinea su columna, y son las nueve, una vez cada una", () => {
    expect(unpinnedLeaves(ROW)).toEqual([]);
    expect(ROW_VALUES.map((leaf) => Number(/sm:col-start-(\d)/.exec(leaf.className)?.[1])).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
  });

  it("el orden del DOM es el de la tarjeta móvil, no el de la grilla", () => {
    // Si alguien volviera a poner las hojas en orden de columna, la tarjeta
    // móvil leería Fecha antes que Total: esta guarda lo congela al revés.
    expect(ROW_VALUES.map((leaf) => Number(/sm:col-start-(\d)/.exec(leaf.className)?.[1]))).not.toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    // Y el agrupado es explícito: seis renglones, seis envoltorios que se
    // borran de la grilla de arriba.
    expect(allSpans(ROW).filter(isWrapper), "envoltorios sm:contents").toHaveLength(6);
    // Los botones no se van del borde de la pantalla: se envuelven.
    expect(ROW).toMatch(/className="flex flex-wrap items-center gap-1[^"]*sm:contents"/);
  });
});

/* --------------------------------------------------------------------------
   EL CONTROL NEGATIVO DEL PREDICADO.

   Sin esto, las guardas de arriba pasarían con un archivo vacío o con un
   marcado cualquier cosa. Acá se corre el MISMO predicado contra el marcado
   anterior al arreglo —nueve spans desnudos, sin etiqueta y sin pineo— y tiene
   que acusarlo.
   -------------------------------------------------------------------------- */

const MARKUP_ANTES = `<li
  key={row.id}
  className="flex flex-col gap-1 px-3 py-2.5 sm:grid sm:grid-cols-[2.5rem_7.5rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem_minmax(0,1fr)_5.5rem_4.5rem_4.5rem] sm:items-center sm:gap-2"
>
  <span className="font-mono text-sm font-semibold text-slate-700 dark:text-slate-300">
    #{row.consecutive_number}
  </span>
  <span className="whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">{fecha}</span>
  <span className="truncate text-sm text-slate-600 dark:text-slate-300">{row.user_name ?? "—"}</span>
  <span className="truncate text-sm text-slate-600 dark:text-slate-300">{row.closed_by_name ?? "—"}</span>
  <span className="whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">{cerrada}</span>
  <span className="truncate text-sm text-slate-600 dark:text-slate-300">{empleados}</span>
  <span className="whitespace-nowrap text-sm font-medium text-slate-900 sm:text-right dark:text-slate-100">{total}</span>
  <span>
    <Badge variant={invoiceStatusVariant(row.status)}>{row.status}</Badge>
  </span>
  <span className="flex items-center gap-1 sm:justify-center">{botones}</span>
</li>
`;

describe("el predicado no es un sello de goma", () => {
  it("el marcado viejo —nueve valores sin etiqueta y sin pineo— se acusa", () => {
    const hojaVieja = rowRegion(MARKUP_ANTES);
    expect(hojaVieja.length, "la región vieja se leyó").toBeGreaterThan(200);
    expect(unlabelledLeaves(hojaVieja), "valores sin etiqueta").toHaveLength(9);
    expect(labelledWords(hojaVieja), "etiquetas del marcado viejo").toEqual([]);
    expect(unpinnedLeaves(hojaVieja), "hojas sin pineo").toEqual([
      "9 hojas sin sm:col-start-N",
      "9 hojas sin sm:row-start-1",
    ]);
    // Y el criterio nuevo también lo acusa, línea por línea: si pasara sobre
    // el marcado viejo, no probaría nada sobre el actual.
    expect(lineasInvisiblesEnElTelefono(hojaVieja), "líneas sin rótulo visible").toHaveLength(9);
    for (const fallo of lineasInvisiblesEnElTelefono(hojaVieja)) {
      expect(fallo).toContain("no abre con su propia etiqueta");
    }
  });

  it("una etiqueta con palabra inventada también se acusa: el vocabulario diverge", () => {
    // El otro modo de fallar: rotular la fila, pero con un rótulo que el
    // encabezado no dice («Vendedor» donde arriba dice «Abrió»).
    const inventada = rowRegion(
      MARKUP_ANTES.replace(
        '#{row.consecutive_number}',
        '<span className="sm:hidden">Vendedor: </span>#{row.consecutive_number}',
      ),
    );
    expect(labelledWords(inventada)).toEqual(["Vendedor"]);
    // Es decir: la comparación que hace la guarda real la rechaza.
    expect(labelledWords(inventada).slice().sort()).not.toEqual(WORDS.slice().sort());
    expect(WORDS).not.toContain("Vendedor");
  });
});

/* --------------------------------------------------------------------------
   LA ETIQUETA QUE SE APAGA EN EL FONDO.

   Estos son los controles que la versión anterior de la guarda NO tenía, y son
   la razón de haberla reescrito: la versión vieja afirmaba que la etiqueta
   «traía `sm:hidden`», y con `hidden sm:hidden` en la misma lista el rótulo
   quedaba invisible en el teléfono —el defecto entero— mientras el archivo
   seguía verde. Cada mutación de acá es la edición que alguien haría en
   `invoices-client.tsx`, aplicada a una COPIA de la fila en memoria.
   -------------------------------------------------------------------------- */

describe("la etiqueta que se apaga en el fondo se acusa", () => {
  it("un `hidden` pelado en la etiqueta la esconde en los cuatro anchos del teléfono", () => {
    // La edición: `className="… text-text-secondary sm:hidden hidden"`.
    const fila = filaConEtiqueta(`${etiquetaId(ROW).clase} hidden`);
    expect(lineasInvisiblesEnElTelefono(fila), "la etiqueta colapsada").toEqual(
      ANCHOS_MOVILES.map((vw) => `«ID:» a ${vw}px: la esconde \`hidden\``),
    );
    // Y el mismo defecto NO se ve desde el escritorio: `sm:hidden` sigue
    // apagándola arriba, que es por eso que la versión vieja quedaba verde.
    expect(labelsVisibleOnDesktop(fila), "arriba de `sm` sigue apagada").toEqual([]);
  });

  it("`sr-only`, `invisible` y `opacity-0` apagan igual, y cada uno se acusa", () => {
    const base = etiquetaId(ROW).clase;
    const esperado: [string, string][] = [
      ["sr-only", "sr-only"],
      ["invisible", "invisible"],
      ["opacity-0", "opacity-0"],
    ];
    for (const [utilidad, culpable] of esperado) {
      expect(
        lineasInvisiblesEnElTelefono(filaConEtiqueta(`${base} ${utilidad}`)),
        `la etiqueta con \`${utilidad}\``,
      ).toEqual(ANCHOS_MOVILES.map((vw) => `«ID:» a ${vw}px: la esconde \`${culpable}\``));
    }
  });

  it("un `max-sm:hidden` —«escondida justo en el teléfono»— también se acusa", () => {
    // La edición que ni siquiera comparte token con el `sm:hidden` del
    // encabezado: en el teléfono gana, y el teléfono es donde tiene que verse.
    const fila = filaConEtiqueta(`${etiquetaId(ROW).clase} max-sm:hidden`);
    expect(lineasInvisiblesEnElTelefono(fila)[0]).toBe(
      `«ID:» a ${ANCHOS_MOVILES[0]}px: la esconde \`max-sm:hidden\``,
    );
    expect(lineasInvisiblesEnElTelefono(fila), "y también en los otros tres").toHaveLength(4);
    // Arriba de `sm` la apaga el `sm:hidden` de verdad, así que el criterio
    // de escritorio no la ve: por eso el defecto es de la otra mitad.
    expect(labelsVisibleOnDesktop(fila)).toEqual([]);
  });

  it("arriba de `sm`, una etiqueta que vuelve a verse se acusa en los cuatro anchos", () => {
    // La edición: `sm:hidden sm:block`. `twMerge` la funde en `sm:block` —no
    // hay dos clases, hay una que gana— y la cascada la encuentra prendida.
    const fila = filaConEtiqueta(`${etiquetaId(ROW).clase} sm:block`);
    expect(labelsVisibleOnDesktop(fila)).toEqual(
      ANCHOS_ESCRITORIO.map((vw) => `«ID:» se ve a ${vw}px`),
    );
  });

  it("quitarle la etiqueta a una línea se acusa por esa línea, no por las otras ocho", () => {
    const fila = filaSinEtiqueta();
    expect(lineasInvisiblesEnElTelefono(fila)).toEqual([
      expect.stringContaining("no abre con su propia etiqueta"),
    ]);
    expect(unlabelledLeaves(fila), "una hoja sin etiqueta").toHaveLength(1);
    expect(labelledWords(fila), "ocho etiquetas de nueve").toHaveLength(8);
  });

  it("correr la etiqueta del principio de la línea se acusa aunque siga siendo la suya", () => {
    // La edición: el rótulo se mueve después del `#`. Sigue siendo una
    // etiqueta, sigue con la palabra del encabezado, sigue `sm:hidden`… y la
    // línea se lee `#12ID:`. Sólo lo caza el criterio de posición.
    const fila = filaConEtiquetaAlFinal();
    // Sigue siendo la misma etiqueta, con la misma palabra y el mismo
    // `sm:hidden`… y la línea se lee `#12ID:`.
    expect(labelledWords(fila), "el rótulo sigue siendo el mismo").toHaveLength(9);
    expect(lineasInvisiblesEnElTelefono(fila), "y la etiqueta sigue prendida").toEqual([]);
    // Lo único que la delata es la posición, y es lo que afirma el criterio.
    expect(
      valueSpans(fila)
        .filter((leaf) => !ETIQUETA_ABRE.test(leaf.inner))
        .map((leaf) => leaf.className),
      "hojas que ya no abren con su rótulo",
    ).toHaveLength(1);
  });

  it("el `className` de la etiqueta del `#` es el que estas cuentas están leyendo", () => {
    // Ancla de los controles de arriba: si el archivo dejara de rotular el `#`,
    // o de declarar su clase, estos controles no estarían probando nada.
    expect(etiquetaId(ROW).clase.split(/\s+/)).toEqual(
      expect.arrayContaining(["sm:hidden"]),
    );
    expect(tokenQueEsconde(etiquetaId(ROW).clase, 390), "en el teléfono").toBe("");
    expect(tokenQueEsconde(etiquetaId(ROW).clase, 1024), "en el escritorio").toBe("sm:hidden");
  });
});

/* --------------------------------------------------------------------------
   R26 — LA IDENTIDAD NO VIVE SÓLO EN EL TOOLTIP.

   El defecto: los tres nombres de la fila —quién abrió, quién cerró y los
   empleados— llevan `truncate` + `title=`. La fila es una tarjeta angosta, así
   que el nombre se CORTA y la única forma de leerlo entero es el tooltip… que
   es un `title=` nativo, y un `title=` nativo NO SE DISPARA CON EL DEDO. En un
   teléfono, esa identidad no existe.

   LA DECISIÓN, Y POR QUÉ NO ES UNA PROHIBICIÓN DE `title=`: abajo de `sm` el
   nombre SE ENVUELVE y se lee entero; desde `sm` el `truncate` + `title=` se
   quedan, porque arriba hay ratón y el ratón sí alcanza un tooltip. Por eso esta
   guarda NO prohíbe `title=`: le pide a cada nombre que, en el ancho donde no
   hay puntero, la caja se lea completa.

   LA CLASE, Y POR QUÉ NO BASTABA EL TOKEN: la cuenta es la del CSS —dentro de
   una propiedad gana la utilidad que el motor emite ÚLTIMA, y ese orden es el
   de las variantes, con las `max-*` al final—, leída sobre la clase EFECTIVA
   (la de `twMerge`, que es la regla de `cn`). Un token suelto no la vería:
   `truncate` seguiría en la lista y el nombre seguiría cortado. Lo que se
   afirma es el `white-space` que gana a cada ancho.
   -------------------------------------------------------------------------- */

/** Las utilidades que ponen `white-space`, y qué ponen. */
const BLANCO: Record<string, "normal" | "nowrap"> = {
  "whitespace-normal": "normal",
  "whitespace-nowrap": "nowrap",
};

/** El peso de emisión de una variante; las `max-*` van al final de la hoja. */
const ORDEN_VARIANTE: Record<string, number> = {
  sm: 100,
  md: 200,
  lg: 300,
  xl: 400,
  "2xl": 500,
  "max-2xl": 600,
  "max-xl": 700,
  "max-lg": 800,
  "max-md": 900,
  "max-sm": 1000,
};

/**
 * El `white-space` que GANA a ese ancho, deducido de la clase efectiva.
 *
 * `truncate` no está en el grupo de `white-space` (en Tailwind v4 es la
 * utilidad de `text-overflow`, y trae `overflow: hidden; text-overflow:
 * ellipsis; white-space: nowrap`), así que `twMerge` no lo funde con un
 * `whitespace-*`: los dos sobreviven en la hoja y decide el ORDEN de emisión.
 * Por eso `truncate` pesa 0 —es una utilidad pelada— y un `max-sm:` pesa más
 * que cualquier pelada, que es lo que lo hace ganarle por debajo de 640 sin
 * tocar el escritorio.
 */
function blancoDe(clase: string, vw: number): "normal" | "nowrap" | "" {
  let elegido: "normal" | "nowrap" | "" = "";
  let mejor = Number.NEGATIVE_INFINITY;
  for (const token of twMerge(clase).split(/\s+/).filter(Boolean)) {
    const base = baseName(token);
    if (base !== "truncate" && !(base in BLANCO)) continue;
    const corte = token.indexOf(":");
    let peso: number | null = 0;
    if (corte !== -1) {
      const pesoVariante = ORDEN_VARIANTE[token.slice(0, corte)];
      const bp = BREAKPOINTS[token.slice(0, corte).startsWith("max-")
        ? token.slice(4, corte)
        : token.slice(0, corte)];
      if (pesoVariante === undefined || bp === undefined) continue;
      const activa = token.slice(0, corte).startsWith("max-") ? vw < bp : vw >= bp;
      if (!activa) continue;
      peso = pesoVariante;
    }
    if (peso < mejor) continue;
    elegido = base === "truncate" ? "nowrap" : BLANCO[base];
    mejor = peso;
  }
  return elegido;
}

/** Las hojas de la fila que recortan: hoy son las tres identidades. */
function identidades(region: string): SpanNode[] {
  return valueSpans(region).filter((hoja) => /(^|\s)truncate(\s|$)/.test(hoja.className));
}

/** La etiqueta de apertura de la hoja, con todos sus atributos. */
function aperturaDe(hoja: SpanNode, region: string): string {
  const clase = region.indexOf(`className="${hoja.className}"`);
  if (clase < 0) throw new Error(`la hoja \`${hoja.className.slice(0, 24)}…\` no se reencontró`);
  // El `<span` puede estar en la línea de arriba: se busca hacia atrás.
  const inicio = region.lastIndexOf("<span", clase);
  if (inicio < 0) throw new Error("la hoja no vive en un `span`");
  return region.slice(inicio, region.indexOf(">", clase) + 1);
}

/**
 * Identidades que en el teléfono NO se leen enteras: el `white-space` que gana
 * deja la línea en `nowrap`, o sea que el nombre se recorta.
 */
function identidadesCortadas(region: string): string[] {
  const fallos: string[] = [];
  for (const hoja of identidades(region)) {
    for (const vw of ANCHOS_MOVILES) {
      if (blancoDe(hoja.className, vw) !== "normal") {
        fallos.push(`${hoja.className.slice(0, 26)}… a ${vw}px: \`${blancoDe(hoja.className, vw) || "sin white-space"}\``);
      }
    }
  }
  return fallos;
}

describe("R26: la identidad no vive sólo en el tooltip donde no hay puntero", () => {
  it("las tres identidades de la fila son las que esta guarda mira", () => {
    // Ancla: si la fila dejara de recortar, esta cuenta no miraría nada. Las
    // tres son «Abrió», «Empleados» y «Cerró», y las tres conservan su `title=`
    // para el ancho con ratón.
    expect(identidades(ROW).map((hoja) => labelOf(hoja)?.inner.trim()), "las tres").toEqual([
      "Abrió:",
      "Empleados:",
      "Cerró:",
    ]);
  });

  it("abajo de `sm` las tres se ENVUELVEN: el nombre se lee entero sin puntero", () => {
    expect(identidadesCortadas(ROW), "identidades recortadas en el teléfono").toEqual([]);
  });

  it("arriba de `sm` no se mueven: `truncate` manda y el `title=` sigue de áncora", () => {
    // El escritorio es la densidad de hoy y no se toca. Lo que se afirma es que
    // la variante que envuelve NO sube: arriba gana `truncate`.
    for (const hoja of identidades(ROW)) {
      for (const vw of ANCHOS_ESCRITORIO) {
        expect(blancoDe(hoja.className, vw), `${hoja.className.slice(0, 26)}… a ${vw}px`).toBe("nowrap");
      }
      expect(aperturaDe(hoja, ROW), "el `title=` se conserva").toMatch(/\btitle=/);
    }
  });

  it("el arreglo NO es una prohibición de `title=`: los tres lo conservan", () => {
    // Si alguien «arregla» R26 borrando los `title=` de arriba, esta guarda lo
    // delata: el `title=` del escritorio es legítmo —ahí hay ratón— y quitarlo
    // sería perder información sin ganar nada.
    for (const hoja of identidades(ROW)) {
      expect(aperturaDe(hoja, ROW), `el \`title=\` de ${hoja.className.slice(0, 20)}…`).toContain("title=");
    }
  });

  it("el control negativo: quitarle el `max-sm:whitespace-normal` se acusa en los cuatro anchos", () => {
    // La edición que hace el defecto de nuevo, y que un token no vería: el
    // `truncate` sigue ahí, la lista sigue teniendo lo que tenía, y sin embargo
    // el nombre vuelve a quedar en una sola línea cortada.
    // SIN la `g`: se le quita el `max-sm:whitespace-normal` a la PRIMERA
    // identidad y se deja las otras dos como están, para que el recuento del
    // fallo demuestre que la guarda acusa hoja por hoja.
    const sinEnvolver = ROW.replace(/(^|[\s"])max-sm:whitespace-normal(?=[\s"])/, "$1");
    expect(sinEnvolver, "la mutación tiene que cambiar el fuente").not.toBe(ROW);
    expect(blancoDe(identidades(sinEnvolver)[0].className, 390), "vuelve el recorte").toBe("nowrap");
    expect(identidadesCortadas(sinEnvolver)).toHaveLength(ANCHOS_MOVILES.length);
  });

  it("y el `nowrap` pelado se acusa igual: envolver no es lo mismo que recortar", () => {
    // La otra forma de escribir lo mismo: sin el `truncate` pero con un
    // `whitespace-nowrap` pelado. El nombre no se recorta… pero tampoco se
    // envuelve, y en una tarjeta angosta se sale.
    const nowrapPelado = ROW.replace(
      /(^|\s)max-sm:whitespace-normal(\s|$)/,
      "$1whitespace-nowrap$2",
    );
    expect(nowrapPelado, "la mutación tiene que cambiar el fuente").not.toBe(ROW);
    expect(identidadesCortadas(nowrapPelado)).toHaveLength(ANCHOS_MOVILES.length);
  });
});