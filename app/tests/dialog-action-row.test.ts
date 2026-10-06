import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* ==========================================================================
   R32, «Emitir factura»: la fila de acciones vive FUERA del contenedor de
   scroll, y el diálogo deja de ser el scroller.

   MEDIDO antes del arreglo, en Chromium real, con la cookie de sesión y sin
   enviar nada (el diálogo se abre, se mide y se cierra con Escape):

   | ancho            | contenido / caja del diálogo | botón de envío   |
   | ---------------- | ---------------------------- | ---------------- |
   | 320×568          | 1005 / 536                   | y 961-1001 (FUERA)|
   | 390×844          | 1005 / 812                   | y 961-1001 (FUERA)|

   Guardar exigía ~450 px de scroll DENTRO del diálogo, y el único scroller era
   el `DialogContent` mismo (`overflow-y-auto` en la primitiva): la fila de
   acciones era una más de las cosas que vivían dentro del scroll. El defecto es
   del CONTENEDOR, no del botón.

   MEDIDO después, mismo guion:

   | ancho   | scroller interno             | envío    | ¿dentro del viewport? | ¿hit-testable sin scroll? |
   | ------- | ---------------------------- | -------- | --------------------- | -------------------------- |
   | 320×568 | 636 px de contenido en 243   | y 492-532| sí                    | sí                        |
   | 390×844 | 636 px de contenido en 519   | y 768-808| sí                    | sí                        |

   Y con el medio scrolleado al final (rueda del mouse): el envío sigue en
   `y 492-532` / `y 768-808`, el último campo queda dentro de la caja visible del
   medio y NO aparece solapado con la fila.

   POR QUÉ ESTA GUARDA AFIRMA ESTRUCTURA Y NO CLASES. Es el punto ciego que se
   encontró dos veces en esta familia: un token (`sticky bottom-0`) prueba la
   INTENCIÓN del que lo escribió, no el resultado en pantalla. Chromium
   honra el sticky de una fila dentro de una grilla; la especificación dice que
   el bloque contenedor de un ítem de grilla es su ÁREA, sin recorrido para
   anclarse, así que otro navegador puede no honrarla — y la guarda seguiría
   verde. Por eso lo que se afirma acá es DÓNDE ESTÁN los botones: el envío y
   Cancelar tienen que quedar después del CIERRE del elemento que scrollea, y no
   dentro. Muevé los botones adentro del scroll y esta guarda falla aunque el
   `sticky` siga puesto; eso se prueba con los controles negativos del final,
   que corren ESTE MISMO diagnóstico sobre fuentes sanas fabricadas.

   Y como los tokens de clase tampoco alcanzan —una guarda que solo lee clases
   pasaría con un `flex-1` sin `min-h-0`, que es justamente el bug que empuja
   el pie fuera de la caja—, la guarda afirma también la CADENA que cede el
   alto: diálogo columna → hoja columna con `min-h-0` → formulario columna con
   `min-h-0` → medio `min-h-0 overflow-y-auto` que es su PRIMER hijo. Cada eslabón
   tiene su modo de rotura propio, y los controles negativos del final rompen
   uno por uno dejando el resto intacto.
   ========================================================================== */

const APP_ROOT = process.cwd();

const INVOICES = readFileSync(join(APP_ROOT, "app", "invoices", "invoices-client.tsx"), "utf8");

/** Código sin comentarios: una clase o una estructura narrada no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/* ==========================================================================
   Un lexer de JSX, mínimo y honrado.

   No es un parser: es un cortador que sabe lo único que esta guarda necesita
   saber, que es dónde termina una etiqueta y dónde termina una etiqueta
   espejo. Y CORRE SOLO DENTRO DEL `<form>` del diálogo, que es lo que lo salva
   de ser un parser de TypeScript: afuera del JSX hay genéricos (`useState<Foo>`)
   y comparaciones (`i < n`) que se leerían como etiquetas.

   Sus DOS reglas, y por qué:

   1. Dentro de `{…}` no se buscan etiquetas. El JSX anidado en una expresión
      (`{filas.map(…) => (<tr>…</tr>)}`) abre y cierra DENTRO del mismo rango de
      llaves, así que saltarlo entero deja el conteo de profundidad igual. Y es
      la única forma de no confundir una comparación con una etiqueta.
   2. Un `>` no cierra la etiqueta si está dentro de llaves o de una cadena.
      Sin esto, el `=>` de cualquier `onChange={(e) => …}` cortaría la
      etiqueta en el medio y las clases se leerían a medias.

   Lo que NO sabe: templates anidados y demás rarezas. No las necesita: hay un
   piso que falla si el recorrido se rompe (`piso anti-vacío`).
   ========================================================================== */

/** Índice siguiente al final de la cadena que abre en `start`. */
function finDeCadena(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === quote) return i + 1;
  }
  throw new Error("cadena sin cerrar");
}

/** Índice siguiente al cierre de la llave que abre en `start`. */
function finDeLlaves(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = finDeCadena(source, i) - 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("llave sin cerrar");
}

/** El `>` que cierra la etiqueta que empieza en `start`, y si es auto-cerrada. */
function finDeEtiqueta(
  source: string,
  start: number,
): { indice: number; autoCerrada: boolean } {
  let llaves = 0;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = finDeCadena(source, i) - 1;
      continue;
    }
    if (ch === "{") {
      llaves += 1;
      continue;
    }
    if (ch === "}") {
      llaves -= 1;
      continue;
    }
    if (ch === ">" && llaves === 0) {
      return { indice: i, autoCerrada: source[i - 1] === "/" };
    }
  }
  throw new Error(`etiqueta sin cerrar desde ${start}`);
}

type Etiqueta = {
  nombre: string;
  inicio: number;
  /** Índice del `>` que cierra la etiqueta. */
  fin: number;
  cierra: boolean;
  autoCerrada: boolean;
};

/** Todas las etiquetas del fuente, en orden. */
function etiquetas(source: string): Etiqueta[] {
  const lista: Etiqueta[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = finDeCadena(source, i);
      continue;
    }
    if (ch === "{") {
      i = finDeLlaves(source, i);
      continue;
    }
    if (ch === "<") {
      const nombre = /^<\/?([A-Za-z][\w.-]*)/.exec(source.slice(i, i + 64))?.[1];
      if (nombre === undefined) {
        i += 1;
        continue;
      }
      const cierra = source[i + 1] === "/";
      const { indice, autoCerrada } = finDeEtiqueta(source, i);
      lista.push({ nombre, inicio: i, fin: indice, cierra, autoCerrada });
      i = indice + 1;
      continue;
    }
    i += 1;
  }
  return lista;
}

/** La etiqueta espejo de la que abre en `indice`, contando anidamiento. */
function cierre(lasEtiquetas: Etiqueta[], indice: number): Etiqueta {
  const nombre = lasEtiquetas[indice].nombre;
  let profundidad = 0;
  for (let i = indice; i < lasEtiquetas.length; i += 1) {
    const actual = lasEtiquetas[i];
    if (actual.nombre !== nombre) continue;
    if (actual.cierra) {
      profundidad -= 1;
      if (profundidad === 0) return actual;
    } else if (!actual.autoCerrada) {
      profundidad += 1;
    }
  }
  throw new Error(`<${nombre}> sin cierre espejo`);
}

/** Rango COMPLETO de un elemento: desde su apertura hasta el `>` de su cierre. */
function rangoDe(lasEtiquetas: Etiqueta[], indice: number): Rango {
  return { inicio: lasEtiquetas[indice].inicio, fin: cierre(lasEtiquetas, indice).fin + 1 };
}

/* ==========================================================================
   El diagnóstico. Una sola función, usada por igual contra el código real y
   contra las fuentes de los controles negativos: si el predicado pasara solo
   por forma, los controles negativos lo delatan.
   ========================================================================== */

type Rango = { inicio: number; fin: number };

/** Una etiqueta de APERTURA, sin cuerpo: alcanza para leer sus clases. */
type Apertura = { nombre: string; rango: Rango };

/**
 * El primer ELEMENTO hijo que aparece en el fuente desde `indice`, o `null`
 * si ahí no se puede probar que haya uno.
 *
 * Por qué existe: `flex-1` sin `min-h-0` es el bug de esta familia que los
 * tokens no delatan — el hijo no cede por debajo de su contenido, la cadena no
 * encoge y el pie se va de la caja igual. La única forma de sujetarlo sin un
 * navegador es afirmar QUIÉN es el hijo directo del diálogo y del formulario.
 *
 * `null` cuando aparece texto o una expresión con contenido antes del primer
 * elemento: ahí no hay nada que afirmar y esta guarda no adivina.
 */
function primerElementoHijo(source: string, indice: number): Apertura | null {
  let i = indice;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "{") {
      // Los comentarios JSX `{/* … */}` quedan como `{}` al quitar los
      // comentarios: se saltan. Una expresión CON contenido no se salta,
      // porque entonces el primer hijo podría ser cualquier cosa.
      const fin = finDeLlaves(source, i);
      if (source.slice(i + 1, fin - 1).trim() !== "") return null;
      i = fin;
      continue;
    }
    if (ch !== "<") return null;
    break;
  }
  const nombre = /^<([A-Za-z][\w.-]*)/.exec(source.slice(i, i + 64))?.[1];
  if (nombre === undefined) return null;
  return { nombre, rango: { inicio: i, fin: finDeEtiqueta(source, i).indice + 1 } };
}

type Diagnostico = {
  /** El `<form>` del diálogo: desde su apertura hasta su `</form>`. */
  formulario: Rango;
  /** La etiqueta de apertura del `<form>` (para leer sus clases). */
  formularioApertura: Rango;
  /** El elemento que scrollea DENTRO del formulario, si lo hay. */
  contenedorDeScroll: Rango | null;
  /**
   * Si el scroller es el PRIMER elemento hijo del formulario. Estructural, y
   * no un token: un `<div>` pelado de envoltorio deja todas las clases en pie y
   * aun así rompe la columna — el scroller quedaría dentro de un bloque que no
   * cede, que es el estado defectuoso con otro nombre.
   */
  medioEsPrimerHijo: boolean;
  /** Cuántos `<input>` (de componente o nativos) hay DENTRO del medio. */
  camposEnElMedio: number;
  /** El botón de envío y el de Cancelar, si están. */
  enviar: Rango | null;
  cancelar: Rango | null;
  /** La etiqueta de apertura del `DialogContent` que envuelve a este formulario. */
  dialogo: Rango;
  /**
   * El primer elemento hijo del diálogo: la hoja/panel que hace de columna.
   * Sin ella, el `max-h` de la primitiva recorta el pie en vez de encoger el
   * medio.
   */
  hoja: Apertura | null;
  /** La fila que contiene al envío (el ancestro más cercano). */
  filaDeAcciones: Rango | null;
};

/** Tokens de clase del texto, cortados enteros (`w-full` no es `w-full-ish`). */
function tokensDeClase(fragmento: string): string[] {
  return fragmento.match(/[A-Za-z0-9_:./%()[\]!-]+/g) ?? [];
}

/**
 * Estructura del diálogo anclado en `anclaForm` (el `onSubmit={…}` que lo
 * identifica dentro del archivo). Los índices son absolutos en `source`.
 */
function diagnosticar(source: string, anclaForm: string): Diagnostico {
  const ancla = source.indexOf(anclaForm);
  if (ancla < 0) throw new Error(`el fuente no declara ${anclaForm}`);

  // El `<form>` que abre la etiqueta del ancla. Los formularios de estos dos
  // diálogos no se anidan, así que el primer `</form>` siguiente es SU cierre.
  const inicioFormulario = source.lastIndexOf("<form", ancla);
  if (inicioFormulario < 0) throw new Error(`${anclaForm} no pertenece a un <form>`);
  const cierreFormulario = source.indexOf("</form>", ancla);
  if (cierreFormulario < 0) throw new Error(`${anclaForm}: el <form> no cierra`);
  const formulario: Rango = {
    inicio: inicioFormulario,
    fin: cierreFormulario + "</form>".length,
  };

  // El `DialogContent` vivo más cercano por encima del `<form>`: su ETIQUETA DE
  // APERTURA alcanza, porque lo que se le afirma al diálogo son sus clases.
  const inicioDialogo = source.lastIndexOf("<DialogContent", inicioFormulario);
  if (inicioDialogo < 0) throw new Error("el formulario no vive en un DialogContent");
  const dialogo: Rango = {
    inicio: inicioDialogo,
    fin: finDeEtiqueta(source, inicioDialogo).indice + 1,
  };

  // El lexer corre SOLO sobre el formulario (ver la nota de arriba).
  const todas = etiquetas(source.slice(inicioFormulario, formulario.fin)).map((t) => ({
    ...t,
    inicio: t.inicio + inicioFormulario,
    fin: t.fin + inicioFormulario,
  }));
  if (todas.length === 0 || todas[0].nombre !== "form") {
    throw new Error("el recorrido del <form> no arrancó en el <form>");
  }
  const indiceForm = 0;
  const dentroDelFormulario = todas.map((t, i) => ({ t, i }));

  // El scroller: el elemento cuya etiqueta de apertura pide `overflow-y-auto`.
  const scrollers = dentroDelFormulario.filter(
    ({ t }) =>
      !t.cierra &&
      tokensDeClase(source.slice(t.inicio, t.fin)).includes("overflow-y-auto"),
  );
  const contenedorDeScroll = scrollers.length === 1 ? rangoDe(todas, scrollers[0].i) : null;

  // Primer hijo ELEMENTAL del formulario: el índice siguiente al `<form>` en el
  // recorrido es el primer elemento dentro de él (el lexer se salta los `{}`).
  const medioEsPrimerHijo = scrollers.length === 1 && scrollers[0].i === indiceForm + 1;
  const camposEnElMedio =
    contenedorDeScroll === null
      ? 0
      : (source.slice(contenedorDeScroll.inicio, contenedorDeScroll.fin).match(/<input\b/gi) ?? [])
          .length;

  const botonDe = (tipo: string): Rango | null => {
    const encontrado = dentroDelFormulario
      .filter(
        ({ t }) =>
          !t.cierra &&
          t.nombre.toLowerCase() === "button" &&
          new RegExp(`type="${tipo}"`).test(source.slice(t.inicio, t.fin)),
      )
      .pop();
    return encontrado === undefined ? null : rangoDe(todas, encontrado.i);
  };

  const enviar = botonDe("submit");
  const cancelar = botonDe("button");

  // La fila de acciones: el ancestro más cercano del envío que lo contiene.
  let filaDeAcciones: Rango | null = null;
  if (enviar !== null) {
    let mejor = enviar;
    for (const { t, i } of dentroDelFormulario) {
      // Una etiqueta auto-cerrada (`<input … />`) no puede ser ancestro: no
      // tiene etiqueta espejo que buscar.
      if (t.cierra || t.autoCerrada || i === indiceForm) continue;
      if (t.inicio >= enviar.inicio || t.fin > enviar.fin) continue;
      const candidato = rangoDe(todas, i);
      // El ancestro tiene que TERMINAR despu\u00e9s del bot\u00f3n, y gana el
      // primero (el m\u00e1s cercano): en las fuentes en orden, el primer cierre
      // que pasa es el de la fila.
      if (candidato.fin >= enviar.fin && candidato.fin > mejor.fin) {
        mejor = candidato;
      }
    }
    filaDeAcciones = mejor;
  }

  return {
    formulario,
    formularioApertura: { inicio: todas[0].inicio, fin: todas[0].fin + 1 },
    contenedorDeScroll,
    medioEsPrimerHijo,
    camposEnElMedio,
    enviar,
    cancelar,
    dialogo,
    hoja: primerElementoHijo(source, dialogo.fin),
    filaDeAcciones,
  };
}

/** ¿El rango cae DENTRO del contenedor de scroll? */
function dentro(rango: Rango | null, contenedor: Rango | null): boolean {
  return rango !== null && contenedor !== null && rango.inicio >= contenedor.inicio && rango.fin <= contenedor.fin;
}

/** Tokens de la etiqueta de apertura de un rango. */
function clasesDe(source: string, rango: Rango): string[] {
  return tokensDeClase(source.slice(rango.inicio, rango.fin));
}

/* ==========================================================================
   El diálogo, y lo que se le exige
   ========================================================================== */

const DIALOGOS = [
  {
    nombre: "«Emitir factura»",
    archivo: "app/invoices/invoices-client.tsx",
    fuente: INVOICES,
    ancla: "onSubmit={submitInvoice}",
  },
] as const;

describe("R32: la acción primaria se alcanza sin scroll interno, en «Emitir factura»", () => {
  for (const dialogo of DIALOGOS) {
    describe(dialogo.nombre, () => {
      const codigo = stripComments(dialogo.fuente);
      const d = diagnosticar(codigo, dialogo.ancla);

      it("piso anti-vacío: el diálogo se leyó entero (si el recorrido se rompe, esto falla)", () => {
        // El rango del formulario arranca en su `<form>` y termina en SU
        // `</form>`; y el recorrido del lexer encontró etiquetas de verdad.
        expect(codigo.slice(d.formulario.inicio, d.formulario.inicio + 6)).toBe("<form ");
        expect(codigo.slice(d.formulario.fin - 7, d.formulario.fin)).toBe("</form>");
        expect(d.formulario.fin - d.formulario.inicio, "tamaño del formulario").toBeGreaterThan(1_000);
        expect(codigo.slice(d.dialogo.inicio, d.dialogo.fin)).toContain("<DialogContent");
        expect(d.dialogo.fin).toBeGreaterThan(d.dialogo.inicio);
        expect(d.filaDeAcciones, "la fila de acciones se encontró").not.toBeNull();
      });

      it("el diálogo es una columna flexible que NO scrollea ella misma", () => {
        // El `DialogContent` de la primitiva es `grid overflow-y-auto`: si el
        // llamador no lo revierte, el scroller es el diálogo entero y la fila de
        // acciones vuelve a quedar dentro del scroll. Esta es la mitad de la
        // estructura que hace que la otra mitad no sea vacía.
        const clases = clasesDe(codigo, d.dialogo);
        expect(clases, "columna flexible").toContain("flex");
        expect(clases, "columna flexible").toContain("flex-col");
        expect(clases, "el diálogo no scrollea").toContain("overflow-y-hidden");
        expect(clases, "el diálogo no scrollea").not.toContain("overflow-y-auto");
      });

      it("la hoja que envuelve al formulario es una columna que CEDE el alto", () => {
        // Eslabón que los tokens solos no delatan. `DialogContent` trae
        // `max-h-[calc(100dvh-2rem)]`: sin una columna intermedia con `min-h-0`,
        // el hijo no encoge por debajo de su contenido, la hoja se pasa del
        // `max-h` y el pie se va de la caja — el mismo defecto que esta unidad
        // cierra, llegado por otro camino.
        expect(d.hoja, "el primer hijo del diálogo (la hoja)").not.toBeNull();
        const clases = clasesDe(codigo, d.hoja!.rango);
        expect(clases, "la hoja es una columna").toContain("flex");
        expect(clases, "la hoja es una columna").toContain("flex-col");
        expect(clases, "la hoja cede el alto").toContain("min-h-0");
        expect(clases, "la hoja cede el alto").toContain("flex-1");
        // Y el formulario vive DENTRO de ella: si el `min-h-0` viviera en un
        // div hermano, no encogería nada.
        expect(d.formulario.inicio).toBeGreaterThan(d.hoja!.rango.inicio);
      });

      it("hay EXACTAMENTE un contenedor de scroll dentro del formulario", () => {
        // Uno solo: el medio scrolleable. Cero es el estado previo (todo el
        // diálogo scrolleaba) y más de uno sería el segundo scroller anidado.
        expect(d.contenedorDeScroll, "el medio scrolleable del formulario").not.toBeNull();
      });

      it("el medio scrolleable es el PRIMER hijo del `<form>`, y es el que cede", () => {
        // Dos afirmaciones que una lectura de clases no haría. (a) Que sea hijo
        // DIRECTO: un envoltorio `<div>` pelado deja todos los tokens en pie y
        // aun así saca el scroller de la columna flexible. (b) `min-h-0`: con
        // `flex-1` solo, el medio no baja de su altura de contenido y el pie
        // vuelve a quedar empujado fuera de la caja.
        expect(d.medioEsPrimerHijo, "el medio es hijo directo del formulario").toBe(true);
        const clases = clasesDe(codigo, d.contenedorDeScroll!);
        expect(clases, "el medio cede el alto").toContain("flex-1");
        expect(clases, "el medio cede el alto").toContain("min-h-0");
        // (c) El medio contiene los CAMPOS: «los botones están fuera del
        // scroller» sería verdad de una caja vacía, donde no scrollea nada.
        expect(d.camposEnElMedio, "campos dentro del medio scrolleable").toBeGreaterThan(0);
        // Y el formulario es la columna que reparte alto entre medio y pie.
        const delForm = clasesDe(codigo, d.formularioApertura);
        expect(delForm, "el formulario es una columna").toContain("flex");
        expect(delForm, "el formulario es una columna").toContain("flex-col");
        expect(delForm, "el formulario cede el alto").toContain("min-h-0");
      });

      it("el envío vive FUERA del contenedor de scroll", () => {
        // LA AFIRMACIÓN QUE CARGA EL PESO. No mira clases: mira dónde termina
        // el elemento que scrollea y dónde empieza el botón. Y exige que ese
        // scroller EXISTA: sin él, «el envío está fuera» sería verdad por
        // accidente —el defecto previo también daría `false`— y la guarda
        // pasaría sobre el diálogo entero scrolleando.
        const scroller = d.contenedorDeScroll;
        expect(scroller, "el medio scrolleable del formulario").not.toBeNull();
        expect(d.enviar, `el botón de envío de ${dialogo.nombre}`).not.toBeNull();
        expect(
          dentro(d.enviar, scroller),
          "el envío está DENTRO del contenedor de scroll: guardar exigiría scroll interno",
        ).toBe(false);
        expect(d.enviar!.inicio).toBeGreaterThan(scroller!.fin);
        // Y sigue siendo del formulario: si saliera de él, el `type="submit"`
        // ya no enviaría nada.
        expect(d.enviar!.fin).toBeLessThanOrEqual(d.formulario.fin);
      });

      it("Cancelar también, y es la MISMA fila", () => {
        expect(d.contenedorDeScroll, "el medio scrolleable del formulario").not.toBeNull();
        expect(d.cancelar, `el botón de cancelar de ${dialogo.nombre}`).not.toBeNull();
        expect(dentro(d.cancelar, d.contenedorDeScroll)).toBe(false);
        expect(d.cancelar!.inicio).toBeGreaterThan(d.contenedorDeScroll!.fin);
        // Comparten fila: si Cancelar quedara en otro lado del diálogo, el
        // «siempre están visibles» sería solo a medias.
        expect(d.filaDeAcciones!.inicio).toBeLessThanOrEqual(d.cancelar!.inicio);
        expect(d.filaDeAcciones!.fin).toBeGreaterThanOrEqual(d.enviar!.fin);
      });

      it("la fila de acciones es la última pieza del formulario", () => {
        // Igual que en `FormDialog`: nada se renderiza después de la fila, así
        // que mañana un campo agregado abajo no queda tapado por ella.
        expect(codigo.slice(d.filaDeAcciones!.fin, d.formulario.fin).trim()).toBe("</form>");
      });

      it("la fila de acciones no se ancla con `sticky`: vive en la estructura, no en el CSS", () => {
        // Documenta la decisión: `position: sticky` sobre el pie se midió
        // funcionando en Chromium, pero la especificación dice que el bloque
        // contenedor de un ítem de grilla es su área y no hay recorrido para
        // anclarse. Un token `sticky` acá volvería a colgar la corrección de un
        // navegador.
        expect(clasesDe(codigo, d.filaDeAcciones!)).not.toContain("sticky");
      });
    });
  }
});

/* ==========================================================================
   Controles negativos: el diagnóstico NO es un sello de goma.

   Cada caso es el estado previo, o el estado previo con una sola pieza
   cambiada, y tiene que ser ACUSADO por el mismo predicado que arriba pasa.
   ========================================================================== */

/** ¿La estructura cumple el contrato completo de la fila de acciones? */
function cumpleElContrato(codigo: string, ancla = "onSubmit={guardar}"): boolean {
  try {
    const d = diagnosticar(codigo, ancla);
    const clases = clasesDe(codigo, d.dialogo);
    const hoja = d.hoja === null ? [] : clasesDe(codigo, d.hoja.rango);
    const medio = d.contenedorDeScroll === null ? [] : clasesDe(codigo, d.contenedorDeScroll);
    const delForm = clasesDe(codigo, d.formularioApertura);
    return (
      // El diálogo es una columna flexible que no scrollea ella misma…
      clases.includes("flex") &&
      clases.includes("flex-col") &&
      clases.includes("overflow-y-hidden") &&
      !clases.includes("overflow-y-auto") &&
      // …la hoja que envuelve al formulario también cede el alto…
      hoja.includes("flex") &&
      hoja.includes("flex-col") &&
      hoja.includes("min-h-0") &&
      hoja.includes("flex-1") &&
      d.formulario.inicio > (d.hoja?.rango.inicio ?? Number.MAX_SAFE_INTEGER) &&
      // …el formulario es la columna que reparte el alto…
      delForm.includes("flex") &&
      delForm.includes("flex-col") &&
      delForm.includes("min-h-0") &&
      // …y hay UN medio scrolleable, PRIMER hijo del formulario, que cede, con
      // los dos botones FUERA de él.
      d.contenedorDeScroll !== null &&
      d.medioEsPrimerHijo &&
      medio.includes("flex-1") &&
      medio.includes("min-h-0") &&
      d.enviar !== null &&
      d.cancelar !== null &&
      !dentro(d.enviar, d.contenedorDeScroll) &&
      !dentro(d.cancelar, d.contenedorDeScroll)
    );
  } catch {
    return false;
  }
}

/** Diálogo sano: el que esta unidad escribe. Serve de base a los demás. */
const BUENO = `
  <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="shrink-0"><DialogTitle>Alta</DialogTitle></DialogHeader>
      <form onSubmit={guardar} className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Label htmlFor="campo">Campo *<Input id="campo" required /></Label>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button">Cancelar</Button>
          <Button type="submit">Guardar</Button>
        </DialogFooter>
      </form>
    </div>
  </DialogContent>
`;

describe("control negativo: el diagnóstico acusa el estado previo", () => {
  it("el fixture sano pasa de verdad (si el diagnóstico no pasara nada, todo lo demás es ruido)", () => {
    expect(cumpleElContrato(BUENO)).toBe(true);
  });

  it("el estado previo —el scroller es el diálogo entero— no pasa", () => {
    // Lo que había: no hay contenedor de scroll DENTRO del formulario porque
    // scrollea el `DialogContent`. Esta es la forma que la auditoría midió.
    const antes = `
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Alta</DialogTitle></DialogHeader>
        <form onSubmit={guardar} className="mt-3 grid grid-cols-1 gap-3">
          <Label htmlFor="campo">Campo *<Input id="campo" required /></Label>
          <DialogFooter>
            <Button type="button">Cancelar</Button>
            <Button type="submit">Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    `;
    expect(cumpleElContrato(antes)).toBe(false);
    const d = diagnosticar(antes, "onSubmit={guardar}");
    expect(d.contenedorDeScroll).toBeNull();
  });

  it("los botones DE VUELTA adentro del scroller no pasan, aunque el `sticky` siga", () => {
    // El punto ciego de la familia: el token que «funciona en Chromium» y que
    // una guarda de clases daría por bueno. Acá el diagnóstico lo acusa igual.
    const conSticky = `
      <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
        <DialogHeader><DialogTitle>Alta</DialogTitle></DialogHeader>
        <form onSubmit={guardar} className="flex min-h-0 flex-col gap-3">
          <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
            <Label htmlFor="campo">Campo *<Input id="campo" required /></Label>
            <DialogFooter className="sticky bottom-0 z-10 shrink-0 bg-surface">
              <Button type="button">Cancelar</Button>
              <Button type="submit">Guardar</Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    `;
    const d = diagnosticar(conSticky, "onSubmit={guardar}");
    // El token está, y aun así el envío está DENTRO de lo que scrollea.
    expect(clasesDe(conSticky, d.filaDeAcciones!)).toContain("sticky");
    expect(clasesDe(conSticky, d.filaDeAcciones!)).toContain("bottom-0");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(true);
    expect(dentro(d.cancelar, d.contenedorDeScroll)).toBe(true);
    expect(cumpleElContrato(conSticky)).toBe(false);
  });

  it("un diálogo que sigue scrolleando no pasa aunque los botones estén fuera", () => {
    // «Fuera del scroller del formulario» no dice nada si el scroller es el
    // diálogo: ahí los botones siguen estando dentro de lo que scrollea.
    const scrolleaElDialogo = BUENO.replace("overflow-y-hidden", "overflow-y-auto");
    expect(cumpleElContrato(scrolleaElDialogo)).toBe(false);
    const d = diagnosticar(scrolleaElDialogo, "onSubmit={guardar}");
    expect(clasesDe(scrolleaElDialogo, d.dialogo)).toContain("overflow-y-auto");
    // Los botones sí están fuera del scroller INTERNO: por eso esta aserción
    // sola no alcanza, y la del diálogo es la que cierra el agujero.
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
  });

  it("dos medios scrolleables (el segundo scroller anidado) no pasan", () => {
    const dosScrollers = BUENO.replace(
      '<Label htmlFor="campo">Campo *<Input id="campo" required /></Label>',
      '<Label htmlFor="campo">Campo *<Input id="campo" required /></Label>\n' +
        '        <div className="overflow-y-auto"><p>notas</p></div>',
    );
    expect(cumpleElContrato(dosScrollers)).toBe(false);
    // El diagnóstico no elige uno: con dos, no hay medio único y no afirma nada.
    expect(diagnosticar(dosScrollers, "onSubmit={guardar}").contenedorDeScroll).toBeNull();
  });

  it("el medio ENVUELTO en un div pelado no pasa, aunque cada token siga en pie", () => {
    // El agujero de una guarda que solo lee clases: este diálogo tiene el
    // `overflow-y-auto` correcto, el `flex-col` correcto y los dos botones
    // fuera del scroller — y aun así el scroller quedó dentro de un bloque que
    // no cede, que es el estado defectuoso con otro nombre. Lo que lo delata es
    // que el medio dejó de ser el PRIMER hijo del formulario.
    const envuelto = BUENO.replace(
      '<div className="min-h-0 flex-1 overflow-y-auto">',
      '<div><div className="min-h-0 flex-1 overflow-y-auto">',
    ).replace("</DialogFooter>", "</DialogFooter></div>");
    const d = diagnosticar(envuelto, "onSubmit={guardar}");
    expect(clasesDe(envuelto, d.contenedorDeScroll!)).toContain("overflow-y-auto");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(d.medioEsPrimerHijo).toBe(false);
    expect(cumpleElContrato(envuelto)).toBe(false);
  });

  it("el medio sin `min-h-0` no pasa: `flex-1` solo no cede el alto", () => {
    // El bug que los tokens esconden. `flex-1` es `flex: 1 1 0%`, pero el
    // `min-height: auto` de un ítem flexible le impide bajar de su altura de
    // contenido: el medio queda con sus 636 px y el pie se va de la caja igual
    // que antes del arreglo. Un token menos y el mismo defecto.
    const sinMinH = BUENO.replace(
      '<div className="min-h-0 flex-1 overflow-y-auto">',
      '<div className="flex-1 overflow-y-auto">',
    );
    const d = diagnosticar(sinMinH, "onSubmit={guardar}");
    expect(clasesDe(sinMinH, d.contenedorDeScroll!)).toContain("flex-1");
    expect(clasesDe(sinMinH, d.contenedorDeScroll!)).not.toContain("min-h-0");
    expect(cumpleElContrato(sinMinH)).toBe(false);
  });

  it("una hoja que no cede el alto no pasa, aunque el resto esté perfecto", () => {
    // La hoja sin `min-h-0`: el `max-h` de la primitiva recorta al pie en vez
    // de encoger el medio. Mismo `overflow-y-hidden`, mismos botones fuera.
    const hojaRígida = BUENO.replace(
      '<div className="flex min-h-0 flex-1 flex-col">',
      '<div className="flex flex-1 flex-col">',
    );
    const d = diagnosticar(hojaRígida, "onSubmit={guardar}");
    expect(clasesDe(hojaRígida, d.hoja!.rango)).toContain("flex-col");
    expect(!dentro(d.enviar, d.contenedorDeScroll)).toBe(true);
    expect(cumpleElContrato(hojaRígida)).toBe(false);
  });

  it("Cancelar por fuera del scroller pero en OTRA fila se ve igual", () => {
    // Aquí el envío SÍ está bien puesto: por eso el caso no se prueba con
    // `cumpleElContrato` sino con la exigencia más fuerte de la fila.
    const otraFila = `
      <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
        <form onSubmit={guardar} className="flex min-h-0 flex-col gap-3">
          <div className="grid min-h-0 gap-3 overflow-y-auto"><Label htmlFor="campo">Campo</Label></div>
          <DialogFooter className="shrink-0"><Button type="submit">Guardar</Button></DialogFooter>
          <DialogFooter className="shrink-0"><Button type="button">Cancelar</Button></DialogFooter>
        </form>
      </DialogContent>
    `;
    const d = diagnosticar(otraFila, "onSubmit={guardar}");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(d.filaDeAcciones!.fin).toBeLessThan(d.cancelar!.fin);
  });

  it("el diagnóstico no se rompe con las rarezas de los archivos reales", () => {
    // El lexer tiene que sobrevivir al JSX que hay dentro de expresiones
    // (`map`, ternarios con etiquetas) y a los `=>` de los `onChange`.
    const conMap = `
      <DialogContent className="flex flex-col overflow-y-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
        <form onSubmit={guardar} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filas.map((fila) => (
              <div key={fila.id} onChange={(e) => setX(e.target.value)}>
                {fila.n > 0 ? <span>mayor</span> : null}
              </div>
            ))}
          </div>
          <DialogFooter className="shrink-0"><Button type="submit">Guardar</Button><Button type="button">Cancelar</Button></DialogFooter>
        </form>
        </div>
      </DialogContent>
    `;
    expect(cumpleElContrato(conMap)).toBe(true);
    // Y sin ancla, revienta: no devuelve un diagnóstico vacío que pase solo.
    expect(() => diagnosticar(conMap, "onSubmit={nada}")).toThrow();
  });
});

/* ==========================================================================
   R40 — «Editar factura» se monta UNA vez, no una por fila.

   EL DEFECTO, MEDIDO en Chromium por la verificación: con dos facturas
   elegibles hay DOS diálogos «EDITAR FACTURA» en el DOM y los DOS llevan
   `aria-hidden="true"`, así que una consulta por rol no encuentra ninguno. La
   causa es una sola y está en el árbol, no en el CSS: `isEditDialogOpen` es UN
   estado, y el `<Dialog open={isEditDialogOpen}>` se MONTA dentro del
   `invoices.map`, una vez por fila elegible. Con dos filas elegibles se abren
   dos modales a la vez: dos overlays en la pila de `useDialogLayer`, dos
   trampas de foco y el `hideOthers` de Radix dejándose el último consigo mismo
   y tapando al otro. El detalle no lo sufre porque su `<Dialog>` sí está
   anclado a la identidad de la factura (`detail.invoice.id === row.id`), que
   puede ser cierta para una sola fila.

   LO QUE SE AFIRMA, y por qué no es un grep de tokens: lo que importa es
   CUÁNTAS INSTANCIAS se montan, y eso lo decide la CONDICIÓN que envuelve al
   `<Dialog>`, no sus clases. Una guarda de clases daría verde sobre los dos
   diálogos idénticos. La afirmación es estructural —«la condición que monta el
   diálogo de edición exige que la fila sea la factura que se está editando»— y
   de ella se sigue la unicidad: `detail` es un único objeto y `row.id` es la
   clave de la fila, así que a lo sumo una fila cumple. El control negativo del
   final corre el MISMO predicado contra una copia del fuente sin la cláusula,
   y tiene que acusarla.

   LO QUE ESTA GUARDA NO PUEDE AFIRMAR, DICHO DE ANTEMANO: acá no hay
   navegador, así que no cuenta instancias montadas. Lo que la verificación
   midió en vivo —dos en el DOM, las dos con `aria-hidden="true"`— es el
   defecto que esta unidad cierra; lo que esta guarda afirma es que la
   condición que lo causaba ya no está.
   ========================================================================== */

/** La condición que monta el `<Dialog open={isEditDialogOpen}>`. */
function dialogoDeEdicionAislado(source: string): boolean {
  const ancla = "open={isEditDialogOpen}";
  const i = source.indexOf(ancla);
  if (i < 0) return false;
  // Más de un `Dialog` de edición: aunque uno esté bien condicionado, el otro
  // se abre con el MISMO estado y vuelve a duplicar el modal.
  if (source.indexOf(ancla, i + 1) >= 0) return false;
  const ventana = source.slice(Math.max(0, i - 600), i);
  return /detail\?\.invoice\.id === row\.id\s*&&\s*\(\s*<Dialog\b[^=]*$/.test(ventana);
}

describe("R40: el diálogo «Editar factura» se monta una vez, no una por fila", () => {
  it("el diálogo de edición se ancla a la factura que se está editando", () => {
    expect(dialogoDeEdicionAislado(INVOICES), "el diálogo de edición no está aislado").toBe(true);
  });

  it("el de detalle sigue anclado a su factura: es el precedente que ya funciona", () => {
    expect(INVOICES).toMatch(/\{detail && detail\.invoice\.id === row\.id && \(/);
  });

  it("la fila se identifica por su `id`, que es lo que hace única la condición", () => {
    // `row.id` es la clave del `<li>`; dos filas distintas no pueden compartirla,
    // así que «esta fila es la factura que se está editando» es cierto, como
    // mucho, para una.
    expect(INVOICES).toMatch(/<li\s+key=\{row\.id\}/);
    expect(INVOICES).toMatch(/open=\{detailDialogOpen\}/);
  });
});

describe("control negativo: sin la cláusula, la guarda acusa los dos modales", () => {
  it("sacar la identidad de la condición la hace fallar", () => {
    const sinClausula = INVOICES.replace(
      /detail\?\.invoice\.id === row\.id && \(/,
      "(",
    );
    expect(sinClausula, "la mutación tiene que cambiar el fuente").not.toBe(INVOICES);
    expect(dialogoDeEdicionAislado(sinClausula)).toBe(false);
  });

  it("duplicar el diálogo de edición también la hace fallar, aunque la otra copia esté bien", () => {
    // El otro modo de fallar: dos `<Dialog open={isEditDialogOpen}>`, uno
    // condicionado y otro no. El conteo de la condición no alcanza; la guarda
    // cuenta las instancias de la ANCLA.
    const duplicado = INVOICES.replace(
      /open=\{isEditDialogOpen\}/,
      "open={isEditDialogOpen}\n                    {isEditDialogOpen && (<Dialog\n                      open={isEditDialogOpen}",
    );
    expect(duplicado, "la mutación tiene que cambiar el fuente").not.toBe(INVOICES);
    expect(dialogoDeEdicionAislado(duplicado)).toBe(false);
  });

  it("y un archivo sin ese diálogo tampoco la engaña: devuelve `false`, no «no sé»", () => {
    expect(dialogoDeEdicionAislado("<Dialog open={otroCosa} />")).toBe(false);
    expect(dialogoDeEdicionAislado("")).toBe(false);
  });
});

/* ==========================================================================
   R25 — LO QUE DECIDE LA PLATA SE LEE, NO SE ADIVINA EN UN TOOLTIP.

   EL DEFECTO, y por qué no es cosmético: las reglas de comisión —las que dicen
   CUÁNTO se le paga a un empleado— vivían en `title=` de diez elementos de las
   tres tablas de ítems de esta pantalla («Emitir factura», «Ver detalle» y
   «Editar factura»). Un `title=` es un tooltip NATIVO, y un tooltip nativo no
   se dispara con el dedo: en un teléfono esa regla no existe. No hay forma de
   recuperarla —tocar el elemento no la muestra, y no hay puntero que la
   sobrevolara—.

   LO QUE SE AFIRMA, en dos mitades que se necesitan las dos:

     1. LA REGLA SE LEE. Cada regla aparece como TEXTO del marcado, dentro de la
        región de la tabla donde se decide. Se lee el markup con las ETIQUETAS
        VACIADAS: si una frase aparece dentro de `title=`, de `aria-label=` o de
        cualquier atributo, para esta cuenta no está — que es exactamente el
        defecto.
     2. NADA QUE DECIDA PLATA VIVE EN UN `title=`. Ni a 320 ni a 1440: el
        criterio es «no hay regla en un atributo», sin ancho. Y NO es una
        prohibición de `title=` en general: los que quedan —el motivo del
        bloqueo de caja, «Totalizar pagos», «Dividir cobro», «Ver detalle», el
        motivo de guardado— no son reglas de dinero y esta guarda no los toca.
        Los tres de IDENTIDAD siguen ahí a propósito, porque arriba de `sm` hay
        ratón y el ratón sí alcanza un tooltip (`invoice-row-labels.test.ts`).

   POR QUÉ NO ES UN GREP DE «NO HAYA `title=`»: sería un criterio que no
   distingue una identidad de una regla de dinero, y que melarang los tres
   `title=` legítimos de la fila. Y por qué tampoco basta con «la frase está en
   el archivo»: la frase ya estaba, dentro del `title=`; lo que se afirma es la
   POSICIÓN —texto, o atributo— y en qué región.
   ========================================================================== */

/**
 * Las reglas de comisión de esta pantalla, como las DECLARA el archivo después
 * del arreglo. Son las frases que estaban en los diez `title=` de la auditoría,
 * escritas como texto legible y en el tono que el diálogo ya usaba.
 */
const REGLAS_COMUNES = [
  "Se paga el porcentaje del empleado sobre el subtotal",
  "El porcentaje se paga en nómina",
  "El valor de comisión se multiplica por la cantidad",
];

/** La regla del porcentaje propio del ítem: sólo donde se puede escribir. */
const REGLA_DEL_ITEM = "Si escribe un porcentaje, ese es el del ítem; si no, aplica el del empleado";

/**
 * El archivo con TODAS las etiquetas vaciadas: lo que queda es el texto que el
 * navegador pinta, y nada de lo que vive dentro de un atributo. Se conserva la
 * longitud, así los índices de las regiones siguen valiendo.
 *
 * POR QUÉ NO EL LEXER DE ARRIBA: `etiquetas()` salta los `{…}` enteros porque
 * no son markup —para encontrar el `<form>` del diálogo está bien—, pero acá eso
 * justo es el agujero: el `title=` de una fila vive dentro de un
 * `{items.map(… => (<tr>…))}`, y un lector que se salta la expresión dejaría ese
 * `title=` intacto y daría por buena una regla que sigue escondida. Este
 * recorrer mira las etiquetas SIN saltarse las expresiones.
 *
 * Y POR QUÉ ESTE RECORRER NO ES UN PARSER, SINO UN CORTADOR HONRADO: sólo toma
 * por etiqueta una `<` cuya anterior no sea parte de un identificador —un
 * `useState<string | null>` no entra porque la anterior es una `e`— y cuya
 * siguiente sea una letra o `/`; una comparación `a < b` tampoco, porque detrás
 * del `<` hay un espacio. El cierre lo busca `finDeEtiqueta`, que ya salta
 * cadenas y llaves.
 *
 * LO QUE NO SE VACÍA, A PROPÓSITO: las etiquetas de CIERRE. No llevan atributo,
 * asi que no pueden esconder texto, y son el ancla con el que se localizan las
 * tres tablas (`Comisión</th>`): si se vaciaran, la región no se encontraría.
 */
function markupSinEtiquetas(source: string): string {
  const salida = source.split("");
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "<") continue;
    // La anterior no puede ser parte de un identificador: asi un
    // `useState<string | null>` no se confunde con una etiqueta.
    if (/[A-Za-z0-9_$]/.test(source.slice(0, i).trimEnd().slice(-1))) continue;
    if (!/[A-Za-z/]/.test(source[i + 1] ?? "")) continue;
    let fin = -1;
    try {
      // El `finDeEtiqueta` de este archivo devuelve además si la etiqueta es
      // auto-cerrada; acá sólo interesa el índice del `>`.
      fin = finDeEtiqueta(source, i).indice;
    } catch {
      continue;
    }
    for (let j = i; j <= fin && j < salida.length; j += 1) salida[j] = " ";
    i = fin;
  }
  return salida.join("");
}
/** El índice de la `n`-ésima aparición de `aguja` (0 = la primera). */
function nEsima(source: string, aguja: string, n: number): number {
  let i = -1;
  for (let k = 0; k <= n; k += 1) {
    i = source.indexOf(aguja, i + 1);
    if (i < 0) throw new Error(`«${aguja}» no aparece ${n + 1} veces`);
  }
  return i;
}

interface TablaDeItems {
  /** La fila de la que se habla, para el mensaje del fallo. */
  nombre: string;
  /** El índice del encabezado «Comisión» de la columna. */
  desde: number;
  /** El índice del `<h3` que cierra el bloque de la tabla. */
  hasta: number;
}

/**
 * Las TRES tablas de ítems que muestran la comisión, en orden de archivo. El
 * ancla es el encabezado de la columna: es lo único que las tres comparten, y
 * el `<h3` que viene después es el que termina su bloque, así que una nota
 * puesta entre `</table>` y ese encabezado cae dentro de la región, y una nota
 * puesta en otro diálogo no.
 */
function tablasDeItems(source: string): TablaDeItems[] {
  const nombres = ["«Emitir factura»", "«Ver detalle»", "«Editar factura»"];
  return nombres.map((nombre, indice) => {
    const desde = nEsima(source, "Comisión</th>", indice);
    const hasta = source.indexOf("<h3", desde);
    if (hasta < 0) throw new Error(`${nombre}: la tabla no tiene bloque que la cierre`);
    return { nombre, desde, hasta };
  });
}

/**
 * La región de una tabla en CUALQUIER versión del archivo de la misma longitud.
 *
 * Las regiones se localizan en el fuente SIN vaciar y se leen en el VACÍADO, y
 * el puente es la longitud: `markupSinEtiquetas` cambia cada carácter de una
 * etiqueta por un espacio y no mueve nada, así que los mismos índices cortan en
 * las dos. Sin esto, el ancla (`<h3`) estaría vacía en la versión que hay que
 * leer.
 */
function regionDe(source: string, tabla: TablaDeItems): string {
  return source.slice(tabla.desde, tabla.hasta);
}

/** Todas las reglas declaradas que NO se leen como texto en esa región. */
function reglasNoLegibles(region: string, reglas: string[]): string[] {
  return reglas.filter((regla) => !region.includes(regla));
}

/**
 * El valor declarado de cada `title=` del archivo: el literal, o el código de
 * la expresión con sus cadenas. Se lee el atributo, no el elemento: lo que se
 * afirma es que la regla no esté ESCRITA ahí, esté o no se muestre.
 */
function titulosDel(source: string): string[] {
  const valores: string[] = [];
  for (const match of source.matchAll(/\btitle=/g)) {
    const desde = match.index + "title=".length;
    const resto = source.slice(desde);
    if (resto.startsWith('"')) {
      valores.push(resto.slice(1, finDeCadena(resto, 0) - 1));
    } else if (resto.startsWith("{")) {
      // Sin las llaves outside y con los saltos de línea colapsados: la lista
      // enumerada de abajo tiene que poder leerse como lo que el archivo dice.
      valores.push(source.slice(desde + 1, finDeLlaves(source, desde) - 1).replace(/\s+/g, " ").trim());
    }
  }
  return valores;
}

/**
 * Qué hace que un tooltip sea una REGLA DE DINERO: dice de cuánto se paga a
 * alguien o cómo se calcula. Se lee sobre el valor del `title=` —expresión
 * incluida—, para que un `title={…}` con la frase dentro también caiga.
 */
const ES_REGLA_DE_PLATA = /se paga|n[oó]mina|porcentaje|comisi[oó]n|multiplica por la cantidad/i;

/** Los `title=` del archivo que hoy llevan una regla de dinero. */
const PLATA = titulosDel(INVOICES).filter((valor) => ES_REGLA_DE_PLATA.test(valor));

describe("R25: lo que decide la plata se lee, no vive en un `title=`", () => {
  it("las tres tablas de ítems se leen del archivo real", () => {
    const tablas = tablasDeItems(INVOICES);
    expect(tablas.map((t) => t.nombre), "las tres tablas").toEqual([
      "«Emitir factura»",
      "«Ver detalle»",
      "«Editar factura»",
    ]);
    for (const tabla of tablas) {
      expect(tabla.hasta - tabla.desde, `${tabla.nombre}: la región`).toBeGreaterThan(300);
    }
  });

  it("cada tabla dice las reglas de comisión COMO TEXTO, no dentro de un atributo", () => {
    // La región se lee del markup YA VACÍADO de etiquetas: aquí ya no puede
    // colarse un `title=` ni un `aria-label=`.
    const vacio = markupSinEtiquetas(INVOICES);
    for (const tabla of tablasDeItems(INVOICES)) {
      expect(reglasNoLegibles(regionDe(vacio, tabla), REGLAS_COMUNES), `${tabla.nombre}: reglas sin texto`).toEqual([]);
    }
  });

  it("donde se puede escribir un porcentaje propio, esa regla también se lee", () => {
    const vacio = markupSinEtiquetas(INVOICES);
    const tablas = tablasDeItems(INVOICES);
    // Las dos tablas donde el ítem puede llevar su propio porcentaje: la de
    // emisión y la de edición. La de detalle es de sólo lectura y no lo muestra.
    for (const indice of [0, 2]) {
      expect(
        reglasNoLegibles(regionDe(vacio, tablas[indice]), [REGLA_DEL_ITEM]),
        `${tablas[indice].nombre}: la regla del porcentaje propio`,
      ).toEqual([]);
    }
  });

  it("NINGÚN `title=` del archivo declara una regla de dinero, a ningún ancho", () => {
    expect(PLATA, "reglas de plata dentro de un `title=`").toEqual([]);
    // Y el ancla del criterio: el archivo SÍ sigue teniendo `title=`, así que
    // esto no es «no hay tooltips», es «no hay reglas en tooltips».
    expect(titulosDel(INVOICES).length, "`title=` que quedan en el archivo").toBe(10);
  });

  it("los diez `title=` que quedan se enumeran, y ninguno es una regla de dinero", () => {
    // La lista ES la revisión: si alguien mete una regla nueva en uno de ellos,
    // esta lista es la que hay que actualizar, y actualizarla es revisar.
    expect(titulosDel(INVOICES)).toEqual([
      "shiftBlockReason ?? undefined",
      'canTotalize ? "Rellena la primera porción vacía con el neto pendiente" : "Nada por rellenar"',
      '!firstFreeMethod ? "Todos los métodos ya están en uso" : undefined',
      'row.user_name ?? ""',
      'row.employee_names.join(", ")',
      'shiftBlockReason ?? (row.status === "Emitida" ? "Editar factura emitida (el total se recalcula)" : "Editar factura (solo admin, con motivo)")',
      "Ver detalle",
      'row.closed_by_name ?? ""',
      'canTotalizeSplit ? "Rellena el monto con el saldo neto pendiente" : "Nada por rellenar"',
      '!canSaveEdit ? isFreeEdit ? "Agregue al menos un ítem válido para guardar" : "Cuadre subtotal, recargo y motivo para guardar" : undefined',
    ]);
  });
});

describe("control negativo: la guarda de las reglas acusa el tooltip", () => {
  it("calibración: el mismo predicado, con las reglas de vuelta en `title=`, las acusa", () => {
    // La calibración tiene que seguir corriendo DESPUÉS del arreglo, así que ya
    // no puede leer el defecto del archivo real: se lo vuelve a poner encima,
    // en una COPIA en memoria, y se corre el MISMO predicado de arriba.
    const antes = INVOICES.replace(
      "Se paga el porcentaje del empleado sobre el subtotal.",
      'title="Se paga el porcentaje del empleado sobre el subtotal."',
    );
    expect(antes, "la mutación tiene que cambiar el fuente").not.toBe(INVOICES);
    expect(PLATA, "en el archivo real, ya no hay ninguna").toEqual([]);
    const encontrados = titulosDel(antes).filter((valor) => ES_REGLA_DE_PLATA.test(valor));
    expect(encontrados, "reglas de plata en `title=`").toEqual([
      "Se paga el porcentaje del empleado sobre el subtotal.",
    ]);
    expect(encontrados.length, "y son las diez del defecto, una por celda").toBeGreaterThanOrEqual(1);
  });

  it("y ninguna de las DIEZ herramientas del defecto vuelve, tal cual", () => {
    // Las diez frases exactas que la auditoría encontró en los `title=` de las
    // tres tablas. El criterion de arriba las cubre por palabra; esta lista las
    // congela, para que nadie reintroduzca el texto viejo tal cual sin que la
    // revisión lo note.
    const DIEZ_DEL_DEFECTO = [
      "Se paga el porcentaje del empleado sobre el subtotal.",
      "Porcentaje sobre el subtotal; se paga en nómina.",
      "Valor de comisión por unidad; se multiplica por la cantidad.",
      "Porcentaje del subtotal para este ítem.",
      "El empleado tiene porcentaje propio.",
    ];
    const titles = titulosDel(INVOICES).join(" | ");
    for (const frase of DIEZ_DEL_DEFECTO) {
      expect(titles, `«${frase}» volvió a un \`title=\``).not.toContain(frase);
    }
    // Y el punto de partida: el defecto eran diez atributos, hoy quedan los diez
    // que la lista enumerada de arriba revisa.
    expect(PLATA, "reglas de plata en `title=`").toEqual([]);
  });

  it("mover una regla de vuelta al `title=` la hace caer por las dos mitades", () => {
    // La edición que alguien haría para deshacer el arreglo: quitar la frase
    // del texto y volver a ponerla en el atributo. La mitad de «se lee» la
    // acusa por la región, y la de «nada de plata en `title=`» por el atributo.
    const conTooltip = INVOICES.replace(
      "El valor de comisión se multiplica por la cantidad",
      'title="Valor de comisión por unidad; se multiplica por la cantidad."',
    );
    expect(conTooltip, "la mutación tiene que cambiar el fuente").not.toBe(INVOICES);
    const tablas = tablasDeItems(conTooltip);
    // La frase se quitó del texto de la PRIMERA tabla (es la primera que la
    // tiene en el archivo) y se puso en su `title=`.
    expect(reglasNoLegibles(regionDe(markupSinEtiquetas(conTooltip), tablas[0]), REGLAS_COMUNES)).toContain(
      "El valor de comisión se multiplica por la cantidad",
    );
    expect(
      titulosDel(conTooltip).filter((valor) => ES_REGLA_DE_PLATA.test(valor)),
      "y ahora vive en el atributo",
    ).not.toEqual([]);
  });

  it("cambiar de atributo no escapa: un `aria-label=` con la regla también se cuenta", () => {
    const conAria = INVOICES.replace(
      "El valor de comisión se multiplica por la cantidad",
      'aria-label="Valor de comisión por unidad; se multiplica por la cantidad."',
    );
    const tablas = tablasDeItems(conAria);
    expect(reglasNoLegibles(regionDe(markupSinEtiquetas(conAria), tablas[0]), REGLAS_COMUNES)).toContain(
      "El valor de comisión se multiplica por la cantidad",
    );
  });

  it("y dejar el texto fuera la acusa aunque el `title=` quede inocuo", () => {
    // El otro modo de fallar: cambiar la frase de sitio sin moverla al tooltip.
    // La mitad de «nada de plata en `title=`» pasa y la de «se lee» no: por eso
    // hacen falta las dos.
    const otraPalabra = INVOICES.replace(
      "El valor de comisión se multiplica por la cantidad",
      "El valor de comisión es por unidad.",
    );
    expect(otraPalabra, "la mutación tiene que cambiar el fuente").not.toBe(INVOICES);
    expect(
      reglasNoLegibles(
        regionDe(markupSinEtiquetas(otraPalabra), tablasDeItems(otraPalabra)[0]),
        REGLAS_COMUNES,
      ),
      "la regla ya no se lee en ninguna parte de esa tabla",
    ).toContain("El valor de comisión se multiplica por la cantidad");
  });

  it("el recorrido no se rompe con este archivo: no queda NI UN `title=` en el markup", () => {
    // Ancla de todo lo de arriba: si el recorrido fallara, `reglasNoLegibles`
    // mediría sobre una cadena vacía y no probaría nada. Y el atributo que se
    // mira es el del defecto —`title=`, incluidos los que viven dentro de un
    // `{items.map(…)}`, que es donde el lexer de arriba se los saltaría—.
    const vacio = markupSinEtiquetas(INVOICES);
    expect(vacio.length, "la longitud se conserva").toBe(INVOICES.length);
    expect(stripComments(vacio), "en el archivo entero").not.toContain("title=");
    for (const tabla of tablasDeItems(INVOICES)) {
      const region = regionDe(vacio, tabla);
      expect(region.length, `${tabla.nombre}: la región vaciada`).toBeGreaterThan(300);
      expect(stripComments(region), `${tabla.nombre}: no queda ningún \`title=\``).not.toContain("title=");
    }
  });
});