import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

/* --------------------------------------------------------------------------
   El predicado del contrato. Es una FUNCIÓN, no un `expect` suelto: al final
   se corre contra el marcado viejo, y tiene que acusarlo.
   -------------------------------------------------------------------------- */

/** Hojas apiladas que no dicen qué valor es el que muestran. */
function unlabelledLeaves(region: string): string[] {
  return valueSpans(region)
    .filter((leaf) => labelOf(leaf) === undefined)
    .map((leaf) => leaf.className || "(sin clase)");
}

/** Etiquetas que se verían TAMBIÉN arriba de `sm`, duplicando el encabezado. */
function labelsVisibleOnDesktop(region: string): string[] {
  return valueSpans(region)
    .map((leaf) => labelOf(leaf))
    .filter((label): label is SpanNode => label !== undefined)
    .filter((label) => !/(^|\s)sm:hidden(\s|$)/.test(label.className))
    .map((label) => label.inner.trim());
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
  it("las nueve hojas llevan etiqueta", () => {
    expect(unlabelledLeaves(ROW)).toEqual([]);
    expect(ROW_VALUES, "hojas de valor por columna").toHaveLength(9);
  });

  it("la etiqueta es la palabra del encabezado: las dos superficies no divergen", () => {
    expect(labelledWords(ROW), "las nueve etiquetas").toEqual(
      expect.arrayContaining(WORDS),
    );
    expect(labelledWords(ROW).slice().sort(), "las nueve etiquetas").toEqual(WORDS.slice().sort());
  });

  it("la etiqueta vive dentro del span del valor, no al lado", () => {
    for (const leaf of ROW_VALUES) {
      expect(leaf.inner, "la etiqueta abre el span del valor").toMatch(
        /^\s*<span\b[^>]*className="[^"]*\bsm:hidden\b/,
      );
      // Y la hoja no tiene dos rótulos: uno, el suyo.
      expect(allSpans(leaf.inner).filter(isLabel), leaf.className).toHaveLength(1);
    }
  });
});

describe("la etiqueta desaparece arriba de `sm`", () => {
  it("las nueve son `sm:hidden`: arriba el encabezado ya nombró cada columna", () => {
    expect(labelsVisibleOnDesktop(ROW)).toEqual([]);
  });

  it("el control negativo: quitarle `sm:hidden` a una etiqueta se acusa", () => {
    const sinVariante = ROW.replace(/(^|[\s"])sm:hidden(?=[\s"])/, "$1");
    expect(sinVariante, "el archivo real declara la variante").not.toBe(ROW);
    expect(labelsVisibleOnDesktop(sinVariante)).toEqual(["ID:"]);
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