import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cn } from "@/src/components/ui/lib/utils";

/* ==========================================================================
   Inventario: DOS defectos medidos, una sola guarda.

   DEFECTO 1 — «Crear producto» no se puede guardar sin scroll interno.
   MEDIDO antes del arreglo, en Chromium real, con la cookie de sesión y sin
   enviar nada (el diálogo se abre, se mide y se cierra con Escape):

   | ancho   | contenido / caja del diálogo | scroller interno | envío        |
   | ------- | ---------------------------- | ---------------- | ------------ |
   | 320×568 | 839 / 534                    | NINGUNO           | y 744-788    |
   | 360×740 | 839 / 706                    | NINGUNO           | y 744-788    |
   | 390×844 | 839 / 810                    | NINGUNO           | y 744-788    |

   El `DialogContent` de la primitiva es `grid … overflow-y-auto`: scrollea el
   diálogo ENTERO y la fila de acciones es una más de las cosas que viven
   dentro del scroll. A 320 y a 360 el botón de envío cae FUERA de la caja del
   diálogo —a 360, 744-788 contra una caja que termina en 724— así que guardar
   exigía ~300 px de scroll DENTRO del modal, no un scroll de página.

   DEFECTO 2 — la barra de acciones se esconde detrás del encabezado a 320.
   MEDIDO antes, scrolleando hasta el tope del recorrido útil (`scrollY 400` de
   412 a 320):

   | ancho   | barra         | encabezado | elementFromPoint en el centro de «Crear producto» |
   | ------- | ------------- | ---------- | -------------------------------------------------- |
   | 320×568 | top 0 → 122   | 0 → 63     | `<a>Orabella</a>` del encabezado — NO el botón      |
   | 360×740 | top 107 → 229 | 0 → 63     | el botón (la barra aún no llegó a anclarse)         |
   | 390×844 | top 211 → 333 | 0 → 63     | el botón (ídem)                                     |

   El `sticky top-0` de la barra compite con el `sticky top-0 z-30` del
   encabezado, que es más alto y gana: el botón queda debajo y no es
   clicable. A 360 y 390 no hay recorrido suficiente para llegar a ese estado.

   QUÉ AFIRMA ESTA GUARDA, Y POR QUÉ ESTRUCTURA Y NO CLASES.

   El punto ciego de esta familia se encontró tres veces: un token de clase
   prueba la INTENCIÓN del que lo escribió, no el resultado en pantalla.
   Chromium honra el `sticky` de una fila dentro de una grilla; la
   especificación dice que el bloque contenedor de un ítem de grilla es su ÁREA,
   sin recorrido para anclarse. Por eso lo que se afirma del diálogo es DÓNDE
   están los botones —después del CIERRE del elemento que scrollea, no dentro—
   y no que haya un `sticky`.

   Y donde las clases se FUSIONAN con las de una primitiva, esta guarda no lee
   tokens: calcula el resultado con el MISMO `cn` (twMerge) que usa el
   componente, contra las clases base REALES de `dialog.tsx` leídas del disco.
   Una guarda que sólo mirara el `className` del llamador daría por bueno un
   diálogo sin `overflow-y-hidden` —que es exactamente el estado previous— y
   daría por buena una barra con un `top-0` escondido en una rama de un `cn`.

   La barra, además, no puede cambiar su defensa por la de otro: o el
   desplazamiento se ancla a la ALTURA MEDIDA del encabezado del shell —la
   misma fuente de la que sale la del encabezado, no un segundo número mágico—
   o no se ancla por debajo de `lg`. El criterio acepta las dos formas y
   rechaza todo lo demás.
   ========================================================================== */

const APP_ROOT = process.cwd();
const INVENTARIO = readFileSync(
  join(APP_ROOT, "app", "inventory", "inventory-client.tsx"),
  "utf8",
);
const NAV = readFileSync(
  join(APP_ROOT, "src", "shared", "components", "main-nav.tsx"),
  "utf8",
);
const DIALOG = readFileSync(join(APP_ROOT, "src", "components", "ui", "lib", "dialog.tsx"), "utf8");

/** Anclas del módulo: el formulario de producto y el disparador que lo abre. */
const ANCLA_FORMULARIO = "onSubmit={handleProductSubmit}";
/**
 * El disparador se ancla por la LLAMADA con paréntesis vacío, no por el
 * nombre: la declaración `function startProductDialog(row?: ProductRow)` está
 * más arriba en el archivo, y anclar por el nombre la elegiría en su lugar —
 * o sea, antes de cualquier elemento `sticky`.
 */
const ANCLA_BARRA = "startProductDialog()";

/** Código sin comentarios: una clase o una estructura narrada no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/* ==========================================================================
   Un lexer de JSX, mínimo y honrado (el mismo del guardián hermano
   `dialog-action-row.test.ts`, que es la referencia: este archivo lo adapta al
   diálogo de inventario y le suma el diagnóstico de la barra).

   No es un parser: es un cortador que sabe dónde termina una etiqueta y dónde
   termina una etiqueta espejo. Corre SOLO sobre el rango que se le pide, que
   es lo que lo salva de ser un parser de TypeScript: afuera del JSX hay
   genéricos (`useState<Foo>`) y comparaciones (`i < n`) que se leerían como
   etiquetas.

   Sus DOS reglas: (1) dentro de `{…}` no se buscan etiquetas —el JSX anidado en
   una expresión abre y cierra dentro del mismo rango de llaves, así que
   saltarlo entero deja la profundidad igual—; (2) un `>` no cierra la etiqueta
   si está dentro de llaves o de una cadena, o si no, el `=>` de cualquier
   `onChange` cortaría la etiqueta en el medio.

   Lo que NO sabe: templates anidados y demás rarezas. Hay un piso que falla si
   el recorrido se rompe (los tests «piso anti-vacío»).
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

type Rango = { inicio: number; fin: number };

/** Una etiqueta de APERTURA, sin cuerpo: alcanza para leer sus clases. */
type Apertura = { nombre: string; rango: Rango };

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
   Las clases: NO tokens sueltos, sino el RESULTADO de la fusión.

   `tokensDeClase` corta un texto en palabras, pero una clase que se fusiona con
   la de una primitiva no se puede juzgar token por token: `cn('grid
   overflow-y-auto', 'flex overflow-y-hidden')` deja `flex overflow-y-hidden` y
   no queda rastro del `grid`. Por eso, cuando el atributo es una llamada a
   `cn`, esta guarda extrae los literales de todas sus ramas, los fusiona en
   ORDEN con el mismo `cn` que usa el componente, y afirma sobre el resultado.

   Que se fusionen todas las ramas es deliberado y va para el lado que hace
   fallar la guarda: en un ternario sólo se aplica una, y affirms sobre la
   última hace que un `top-*` escondido en una rama no quede sin ver.
   ========================================================================== */

/** Tokens de clase del texto, cortados enteros (`w-full` no es `w-full-ish`). */
function tokensDeClase(fragmento: string): string[] {
  return fragmento.match(/[A-Za-z0-9_:./%()[\]!-]+/g) ?? [];
}

/** El texto de la apertura de la etiqueta que abre en `inicio`. */
function aperturaDe(source: string, inicio: number): string {
  return source.slice(inicio, finDeEtiqueta(source, inicio).indice + 1);
}

/**
 * El `className` EFECTIVO de la apertura que empieza en `inicio`, ya fusionado.
 *
 * Si el atributo es un literal, es ese literal. Si es `cn(…)`, se fusionan sus
 * literales en orden con el mismo `cn` del proyecto. Lo que no es texto (una
 * variable, una llamada) no se puede evaluar sin ejecutar el componente: no se
 * inventa nada, y el piso anti-vacío de cada test avisa si el recorrido se
 * rompió.
 */
function classNameEfectivo(source: string, inicio: number): string {
  const apertura = aperturaDe(source, inicio);
  const atributo = /className=(?=\{)/.exec(apertura);
  if (atributo === null) {
    const literal = /className="([^"]*)"/.exec(apertura);
    return literal === null ? "" : cn(literal[1]);
  }
  const desde = apertura.indexOf("{", atributo.index);
  const expresion = apertura.slice(desde + 1, finDeEtiqueta(source, inicio).indice);
  const literales = [...expresion.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  return cn(...literales);
}

/** Las clases base REALES del `DialogContent` de la primitiva, leídas del disco. */
function clasesBaseDeDialogContent(): string {
  const desde = DIALOG.indexOf("const DialogContent = React.forwardRef");
  if (desde < 0) throw new Error("dialog.tsx no declara DialogContent");
  const base = /className=\{cn\(\s*'([^']+)'/.exec(DIALOG.slice(desde));
  if (base === null) throw new Error("no se pudo leer el className base de DialogContent");
  return base[1];
}

/* ==========================================================================
   Diagnóstico del DIÁLOGO, anclado en el `onSubmit` del formulario de producto.
   ========================================================================== */

type Diagnostico = {
  formulario: Rango;
  formularioApertura: Rango;
  /** El elemento que scrollea DENTRO del formulario, si hay exactamente uno. */
  contenedorDeScroll: Rango | null;
  /** Si el scroller es el PRIMER elemento hijo del formulario. */
  medioEsPrimerHijo: boolean;
  /** Cuántos campos (`<input`, de componente o nativos) hay DENTRO del medio. */
  camposEnElMedio: number;
  enviar: Rango | null;
  cancelar: Rango | null;
  /** La apertura del `DialogContent` vivo que envuelve a este formulario. */
  dialogo: Apertura;
  /** El primer elemento hijo del diálogo: la hoja que hace de columna. */
  hoja: Apertura | null;
  /** La fila que contiene al envío (el ancestro más cercano). */
  filaDeAcciones: Rango | null;
};

/**
 * El primer ELEMENTO hijo que aparece en el fuente desde `indice`, o `null` si
 * no se puede probar que haya uno.
 *
 * Por qué existe: `flex-1` sin `min-h-0` es el bug de esta familia que los
 * tokens no delatan —el hijo no cede por debajo de su contenido, la cadena no
 * encoge y el pie se va de la caja igual—. La única forma de sujetarlo sin un
 * navegador es afirmar QUIÉN es el hijo directo del diálogo y del formulario.
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
      // Un comentario JSX `{/* … */}` queda como `{}` al quitar comentarios:
      // se salta. Una expresión CON contenido no se salta, porque entonces el
      // primer hijo podría ser cualquier cosa.
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

function diagnosticar(source: string, anclaForm: string): Diagnostico {
  const ancla = source.indexOf(anclaForm);
  if (ancla < 0) throw new Error(`el fuente no declara ${anclaForm}`);

  // El `<form>` que abre la etiqueta del ancla. Estos formularios no se anidan,
  // así que el primer `</form>` siguiente es SU cierre.
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
  const dialogo: Apertura = {
    nombre: "DialogContent",
    rango: { inicio: inicioDialogo, fin: finDeEtiqueta(source, inicioDialogo).indice + 1 },
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

  // El scroller: el elemento cuya apertura pide `overflow-y-auto`.
  const scrollers = todas
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) =>
        !t.cierra &&
        tokensDeClase(source.slice(t.inicio, t.fin)).includes("overflow-y-auto"),
    );
  const contenedorDeScroll = scrollers.length === 1 ? rangoDe(todas, scrollers[0].i) : null;
  const medioEsPrimerHijo = scrollers.length === 1 && scrollers[0].i === indiceForm + 1;
  const camposEnElMedio =
    contenedorDeScroll === null
      ? 0
      : (source
          .slice(contenedorDeScroll.inicio, contenedorDeScroll.fin)
          .match(/<input\b/gi) ?? []).length;

  const botonDe = (tipo: string): Rango | null => {
    const encontrado = todas
      .map((t, i) => ({ t, i }))
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
    let mejor: Rango | null = null;
    for (const { t, i } of todas.map((t, i) => ({ t, i }))) {
      // Una etiqueta auto-cerrada (`<input … />`) no puede ser ancestro: no
      // tiene etiqueta espejo que buscar.
      if (t.cierra || t.autoCerrada || i === indiceForm) continue;
      if (t.inicio >= enviar.inicio || t.fin > enviar.fin) continue;
      const candidato = rangoDe(todas, i);
      // Ancestro = termina en el envío o después. Y gana el MÁS CERCANO, o
      // sea el de menor cierre: elegir el mayor devolvería la hoja o el propio
      // scroller, y «la fila de acciones» dejaría de ser la fila.
      if (candidato.fin < enviar.fin) continue;
      if (mejor === null || candidato.fin < mejor.fin) mejor = candidato;
    }
    // Sin ancestro, la «fila» es el propio botón: el piso de la última pieza
    // del formulario falla y avisa, en vez de pasar por lo de siempre.
    filaDeAcciones = mejor ?? enviar;
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
    hoja: primerElementoHijo(source, dialogo.rango.fin),
    filaDeAcciones,
  };
}

/** ¿El rango cae DENTRO del contenedor de scroll? */
function dentro(rango: Rango | null, contenedor: Rango | null): boolean {
  return (
    rango !== null &&
    contenedor !== null &&
    rango.inicio >= contenedor.inicio &&
    rango.fin <= contenedor.fin
  );
}

/** Tokens de la apertura de un rango. */
function clasesDe(source: string, rango: Rango): string[] {
  return tokensDeClase(source.slice(rango.inicio, rango.fin));
}

/** El `className` EFECTIVO (fusionado con `cn`) de la apertura de un rango. */
function clasesEfectivasDe(source: string, rango: Rango): string[] {
  return tokensDeClase(classNameEfectivo(source, rango.inicio));
}

/* ==========================================================================
   Diagnóstico de la BARRA de acciones.

   Se la localiza por el disparador del diálogo de producto
   (`startProductDialog`): el elemento `sticky` que lo contiene es la barra.
   Anclar por la acción —y no por la posición en el archivo— evita que una
   segunda barra pegada más abajo se confunda con ésta, y evita el error
   simétrico de anclar por el texto «Crear producto», que también es la etiqueta
   del botón de envío del diálogo.
   ========================================================================== */

type Barra = {
  rango: Rango;
  /** Tokens del `className` ya fusionado. */
  clases: string[];
  /** El valor del `top` en línea, si el elemento declara uno. */
  topEnLinea: string | null;
  /** La constante que nombra la variable CSS del desplazamiento. */
  variableOffset: { nombre: string; valor: string } | null;
  /** La SENTENCIA que ASIGNA esa variable, tal como está escrita. */
  sentenciaOffset: string | null;
  /** El selector con el que se busca el encabezado del shell. */
  selector: string | null;
};

/**
 * La barra se localiza por el disparador del diálogo de producto
 * (`startProductDialog()`): el elemento anclado por encima de él es la barra.
 * Anclar por la acción —y no por la posición en el archivo— evita que una
 * segunda barra pegada más abajo se confunda con ésta, y evita el error
 * simétrico de anclar por el texto «Crear producto», que también es la etiqueta
 * del botón de envío del diálogo.
 *
 * POR QUÉ AQUÍ NO CORRE EL LEXER DE JSX: la barra vive dentro de un
 * `{props.canWrite ? ( … ) : null}`, o sea que cualquier corte del fuente la
 * deja dentro de llaves abiertas y `finDeLlaves` revienta con «llave sin
 * cerrar» —un fallo del guard, no del código vigilado—. El lexer sí es seguro
 * dentro del `<form>`, que es donde corre. Acá basta con otra cosa: toda
 * APERTURA cuya etiqueta cierra antes del disparador, leída con
 * `finDeEtiqueta`, que es un recorrido acotado y no arrastra llaves abiertas.
 * De esas, la barra es la ÚNICA anclada: si aparecen dos, la guarda no elige
 * —falla y obliga a decidir cuál es—.
 */
function diagnosticarBarra(source: string): Barra {
  const disparador = source.indexOf(ANCLA_BARRA);
  if (disparador < 0) throw new Error(`el fuente no declara ${ANCLA_BARRA}`);

  const ancladas: Apertura[] = [];
  for (let i = 0; ; ) {
    const siguiente = source.indexOf("<", i);
    if (siguiente < 0 || siguiente >= disparador) break;
    const nombre = /^<([A-Za-z][\w.-]*)/.exec(source.slice(siguiente, siguiente + 64));
    if (nombre === null) {
      i = siguiente + 1;
      continue;
    }
    let fin: number;
    try {
      fin = finDeEtiqueta(source, siguiente).indice;
    } catch {
      i = siguiente + 1;
      continue;
    }
    if (fin < disparador) {
      ancladas.push({ nombre: nombre[1], rango: { inicio: siguiente, fin: fin + 1 } });
    }
    i = fin + 1;
  }

  // `sticky` cuenta con o sin variante: la forma «sólo en escritorio» se ancla
  // con `lg:sticky`, y esa barra también es la que hay que vigilar.
  const ancladasDeLaBarra = ancladas.filter((a) => {
    const clases = tokensDeClase(source.slice(a.rango.inicio, a.rango.fin));
    return clases.some((c) => c === "sticky" || c.endsWith(":sticky"));
  });
  if (ancladasDeLaBarra.length !== 1) {
    throw new Error(
      `se esperaba UNA barra anclada por encima de ${ANCLA_BARRA} y hay ${ancladasDeLaBarra.length}`,
    );
  }
  const rango = ancladasDeLaBarra[0].rango;

  const apertura = source.slice(rango.inicio, rango.fin);
  const top = /top:\s*"([^"]*)"/.exec(apertura);

  // La constante que nombra la variable CSS del desplazamiento: tiene que
  // existir UNA y la referencia en línea tiene que apuntar a ESE valor, no a
  // otro nombre.
  const constante = /const\s+(\w+)\s*=\s*"(--[\w-]+)"\s*;/.exec(source);

  // El selector con el que se busca el encabezado a medir: un literal en la
  // llamada, o la constante que la llamada nombra (que es lo que hace el
  // módulo, para que el selector no viva repetido).
  const selectorEnLiteral = /querySelector(?:All)?(?:<[^>]*>)?\(\s*"([^"]+)"/.exec(source);
  const usoDeConstante = /querySelector(?:All)?(?:<[^>]*>)?\(\s*(\w+)\s*\)/.exec(source);
  const definicion =
    usoDeConstante === null
      ? null
      : new RegExp(`const\\s+${usoDeConstante[1]}\\s*=\\s*"([^"]*)"`).exec(source);
  const selector =
    selectorEnLiteral?.[1] ?? definicion?.[1] ?? null;

  // La SENTENCIA que asigna la variable: la llamada y las dos líneas siguientes.
  // No se intenta parsear la expresión —con `[^)]*` se cortaría en el primer
  // `)` de un `Math.ceil(…)` y se perdería justo lo que hay que comprobar— sino
  // leer la ventana en la que está escrita y exigir que ahí se vea la MEDIDA.
  const llamada = /setProperty\(\s*\w+\s*,/.exec(source);
  const sentenciaOffset =
    llamada === null
      ? null
      : source
          .slice(llamada.index, llamada.index + 200)
          .split("\n")
          .slice(0, 3)
          .join("\n");

  return {
    rango,
    clases: tokensDeClase(classNameEfectivo(source, rango.inicio)),
    topEnLinea: top === null ? null : top[1],
    variableOffset:
      constante === null ? null : { nombre: constante[1], valor: constante[2] },
    sentenciaOffset,
    selector,
  };
}

/* ==========================================================================
   El contrato, en una sola función por unidad, para que los controles negativos
   corran EXACTAMENTE el mismo predicado que el código real.
   ========================================================================== */

/** El diálogo cumple la cadena que cede el alto y deja los botones fuera. */
function cumpleElContratoDelDialogo(source: string, ancla = ANCLA_FORMULARIO): boolean {
  try {
    const d = diagnosticar(source, ancla);
    const dialogo = cn(clasesBaseDeDialogContent(), classNameEfectivo(source, d.dialogo.rango.inicio));
    const clasesDialogo = tokensDeClase(dialogo);
    const hoja = d.hoja === null ? [] : clasesEfectivasDe(source, d.hoja.rango);
    const medio = d.contenedorDeScroll === null ? [] : clasesDe(source, d.contenedorDeScroll);
    const delForm = clasesEfectivasDe(source, d.formularioApertura);
    const fila = d.filaDeAcciones === null ? [] : clasesEfectivasDe(source, d.filaDeAcciones);
    return (
      // El diálogo es una columna flexible que NO scrollea ella misma…
      clasesDialogo.includes("flex") &&
      clasesDialogo.includes("flex-col") &&
      clasesDialogo.includes("overflow-y-hidden") &&
      !clasesDialogo.includes("overflow-y-auto") &&
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
      // los dos botones FUERA de él…
      d.contenedorDeScroll !== null &&
      d.medioEsPrimerHijo &&
      medio.includes("flex-1") &&
      medio.includes("min-h-0") &&
      d.camposEnElMedio > 0 &&
      d.enviar !== null &&
      d.cancelar !== null &&
      !dentro(d.enviar, d.contenedorDeScroll) &&
      !dentro(d.cancelar, d.contenedorDeScroll) &&
      d.enviar.inicio > d.contenedorDeScroll.fin &&
      d.cancelar.inicio > d.contenedorDeScroll.fin &&
      d.enviar.fin <= d.formulario.fin &&
      // …la fila es la última pieza del formulario…
      source.slice(d.filaDeAcciones!.fin, d.formulario.fin).trim() === "</form>" &&
      // …y no se ancla con `sticky`.
      !fila.includes("sticky")
    );
  } catch {
    return false;
  }
}

/**
 * La barra cumple el contrato del defecto 2, en una de las dos formas
 * permitidas. Devuelve cuál, para que los tests puedan nombrarla.
 */
function formaDeLaBarra(source: string): "medida" | "solo-escritorio" | null {
  try {
    const b = diagnosticarBarra(source);
    const clases = b.clases;

    // FORMA B — no se ancla por debajo de `lg`: ningún `sticky` sin variante,
    // y el desplazamiento, si lo hay, es de variante. Con esto la barra nunca
    // compite con el encabezado, que es `lg:hidden`.
    const sinStickyPlano = !clases.some((c) => c === "sticky");
    if (sinStickyPlano && b.topEnLinea === null && b.sentenciaOffset === null) {
      return "solo-escritorio";
    }

    // FORMA A — el desplazamiento es la ALTURA MEDIDA del encabezado del shell:
    // (a) ninguna clase `top-*` pelada —el desplazamiento no puede ser un
    //     número escrito a mano—, (b) el `top` en línea referencia una variable
    //     CSS SIN valor de reserva (un `, 0px` de reserva es el defecto
    //     exacto: fail-open), (c) la referencia apunta a la variable que el
    //     archivo nombra en una sola constante, (d) esa variable se ASIGNA desde
    //     un rectángulo medido, y (e) lo medido es el encabezado `sticky` del
    //     shell, no el `<header>` del título de página —que no se ancla y no
    //     mide lo que hay que librar—.
    const referencia = /^var\(\s*(--[\w-]+)\s*\)$/.exec(b.topEnLinea ?? "");
    const sinTopLiteral = !clases.some((c) => c.startsWith("top-"));
    const mide =
      b.sentenciaOffset !== null &&
      b.sentenciaOffset.includes("getBoundingClientRect") &&
      b.sentenciaOffset.includes("height") &&
      !/["'`]\s*[\d.]+\s*px/.test(b.sentenciaOffset);
    const selectorEsElEncabezado =
      b.selector !== null && b.selector.includes("header") && b.selector.includes("sticky");
    // Que el selector diga «sticky» y no sólo «header» es lo que impide medir
    // el `<header>` del título de página: ese no se ancla y su altura no es la
    // que hay que librar. Que ese encabezado exista, sea `sticky` y esté
    // oculto en escritorio lo comprueba el piso anti-vacío de arriba, leyendo
    // `main-nav.tsx`: acá, sobre un fixture, no hay shell que mirar.
    if (
      sinTopLiteral &&
      referencia !== null &&
      b.variableOffset !== null &&
      referencia[1] === b.variableOffset.valor &&
      source.includes(`setProperty(${b.variableOffset.nombre},`) &&
      mide &&
      selectorEsElEncabezado
    ) {
      return "medida";
    }
    return null;
  } catch {
    return null;
  }
}

/* ==========================================================================
   El código real.
   ========================================================================== */

const CODIGO = stripComments(INVENTARIO);
const D = diagnosticar(CODIGO, ANCLA_FORMULARIO);

describe("inventario: la acción primaria de «Crear producto» se alcanza sin scroll interno", () => {
  it("piso anti-vacío: el diálogo se leyó entero (si el recorrido se rompe, esto falla)", () => {
    expect(CODIGO.length, "inventory-client.tsx").toBeGreaterThan(15_000);
    expect(CODIGO.slice(D.formulario.inicio, D.formulario.inicio + 6)).toBe("<form ");
    expect(CODIGO.slice(D.formulario.fin - 7, D.formulario.fin)).toBe("</form>");
    expect(D.formulario.fin - D.formulario.inicio, "tamaño del formulario").toBeGreaterThan(1_000);
    expect(CODIGO.slice(D.dialogo.rango.inicio, D.dialogo.rango.fin)).toContain("<DialogContent");
    expect(D.dialogo.rango.fin).toBeGreaterThan(D.dialogo.rango.inicio);
    expect(D.filaDeAcciones, "la fila de acciones se encontró").not.toBeNull();
    // Y el ancla es la del formulario de PRODUCTO, no el del movimiento: el
    // movimiento declara otro `onSubmit` y sus campos son otros. Se afirma por
    // el CAMPO, no por la posición en el archivo (el handler del movimiento se
    // declara antes que el formulario de producto).
    expect(CODIGO.slice(D.formulario.inicio, D.formulario.fin)).toContain('id="product-sku"');
    expect(CODIGO.slice(D.formulario.inicio, D.formulario.fin)).not.toContain(
      "handleMovementSubmit",
    );
  });

  it("el diálogo es una columna flexible que NO scrollea ella misma", () => {
    // FUSIÓN REAL, no tokens: se lee la clase base de `dialog.tsx` del disco y
    // se fusiona con la del llamador usando el mismo `cn`. La primitiva es
    // `grid … overflow-y-auto`: si el llamador no lo revierte en la fusión, el
    // scroller es el diálogo entero y la fila de acciones vuelve a quedar
    // dentro del scroll.
    const fusionado = cn(clasesBaseDeDialogContent(), classNameEfectivo(CODIGO, D.dialogo.rango.inicio));
    const clases = tokensDeClase(fusionado);
    expect(clases, "columna flexible").toContain("flex");
    expect(clases, "columna flexible").toContain("flex-col");
    expect(clases, "el diálogo no scrollea").toContain("overflow-y-hidden");
    expect(clases, "el diálogo no scrollea").not.toContain("overflow-y-auto");
    // Que la base de la primitiva siga siendo la que se leyó es lo que da
    // sentido a la aserción de arriba: si `dialog.tsx` dejara de traer
    // `overflow-y-auto`, la fusión ya no lo traería y el `hidden` del
    // llamador pasa a ser lo único que protege el scroll.
    expect(clasesBaseDeDialogContent()).toContain("overflow-y-auto");
  });

  it("la hoja que envuelve al formulario es una columna que CEDE el alto", () => {
    // Eslabón que los tokens solos no delatan. `DialogContent` trae
    // `max-h-[calc(100dvh-2rem)]`: sin una columna intermedia con `min-h-0` el
    // hijo no encoge por debajo de su contenido, la hoja se pasa del `max-h` y
    // el pie se va de la caja — el mismo defecto, llegado por otro camino—.
    expect(D.hoja, "el primer hijo del diálogo (la hoja)").not.toBeNull();
    const clases = clasesEfectivasDe(CODIGO, D.hoja!.rango);
    expect(clases, "la hoja es una columna").toContain("flex");
    expect(clases, "la hoja es una columna").toContain("flex-col");
    expect(clases, "la hoja cede el alto").toContain("min-h-0");
    expect(clases, "la hoja cede el alto").toContain("flex-1");
    // Y el formulario vive DENTRO de ella: si el `min-h-0` viviera en un div
    // hermano, no encogería nada.
    expect(D.formulario.inicio).toBeGreaterThan(D.hoja!.rango.inicio);
  });

  it("hay EXACTAMENTE un contenedor de scroll dentro del formulario", () => {
    // Uno solo: el medio scrolleable. Cero es el estado previo (todo el
    // diálogo scrolleaba) y más de uno sería el segundo scroller anidado.
    expect(D.contenedorDeScroll, "el medio scrolleable del formulario").not.toBeNull();
  });

  it("el medio scrolleable es el PRIMER hijo del `<form>`, y es el que cede", () => {
    // (a) Que sea hijo DIRECTO: un envoltorio `<div>` pelado deja todos los
    // tokens en pie y aun así saca el scroller de la columna flexible.
    // (b) `min-h-0`: con `flex-1` solo el medio no baja de su altura de
    // contenido y el pie vuelve a quedar fuera de la caja.
    // (c) Que el medio CONTENGA los campos: «los botones están fuera del
    // scroller» sería verdad de una caja vacía, donde no scrollea nada.
    expect(D.medioEsPrimerHijo, "el medio es hijo directo del formulario").toBe(true);
    const clases = clasesDe(CODIGO, D.contenedorDeScroll!);
    expect(clases, "el medio cede el alto").toContain("flex-1");
    expect(clases, "el medio cede el alto").toContain("min-h-0");
    expect(D.camposEnElMedio, "campos dentro del medio scrolleable").toBeGreaterThan(3);
    // Y el formulario es la columna que reparte el alto entre medio y pie.
    const delForm = clasesEfectivasDe(CODIGO, D.formularioApertura);
    expect(delForm, "el formulario es una columna").toContain("flex");
    expect(delForm, "el formulario es una columna").toContain("flex-col");
    expect(delForm, "el formulario cede el alto").toContain("min-h-0");
  });

  it("el envío vive FUERA del contenedor de scroll", () => {
    // LA AFIRMACIÓN QUE CARGA EL PESO. No mira clases: mira dónde termina el
    // elemento que scrollea y dónde empieza el botón. Y exige que ese scroller
    // EXISTA: sin él, «el envío está fuera» sería verdad por accidente —el
    // defecto previo también daría `false`— y la guarda pasaría sobre el
    // diálogo entero scrolleando.
    const scroller = D.contenedorDeScroll;
    expect(scroller, "el medio scrolleable del formulario").not.toBeNull();
    expect(D.enviar, "el botón de envío").not.toBeNull();
    expect(
      dentro(D.enviar, scroller),
      "el envío está DENTRO del contenedor de scroll: guardar exigiría scroll interno",
    ).toBe(false);
    expect(D.enviar!.inicio).toBeGreaterThan(scroller!.fin);
    // Y sigue siendo del formulario: si saliera de él, el `type="submit"` ya no
    // enviaría nada.
    expect(D.enviar!.fin).toBeLessThanOrEqual(D.formulario.fin);
  });

  it("Cancelar también, y es la MISMA fila", () => {
    expect(D.contenedorDeScroll, "el medio scrolleable del formulario").not.toBeNull();
    expect(D.cancelar, "el botón de cancelar").not.toBeNull();
    expect(dentro(D.cancelar, D.contenedorDeScroll)).toBe(false);
    expect(D.cancelar!.inicio).toBeGreaterThan(D.contenedorDeScroll!.fin);
    // Comparten fila: si Cancelar quedara en otro lado, el «siempre están
    // visibles» sería solo a medias.
    expect(D.filaDeAcciones!.inicio).toBeLessThanOrEqual(D.cancelar!.inicio);
    expect(D.filaDeAcciones!.fin).toBeGreaterThanOrEqual(D.enviar!.fin);
  });

  it("la fila de acciones es la última pieza del formulario", () => {
    // Nada se renderiza después de la fila, así que mañana un campo agregado
    // abajo no queda tapado por ella.
    expect(CODIGO.slice(D.filaDeAcciones!.fin, D.formulario.fin).trim()).toBe("</form>");
  });

  it("la fila de acciones no se ancla con `sticky`: vive en la estructura, no en el CSS", () => {
    // Documenta la decisión: `position: sticky` sobre el pie se midió
    // funcionando en Chromium, pero la especificación dice que el bloque
    // contenedor de un ítem de grilla es su área y no hay recorrido para
    // anclarse. Un token `sticky` acá volvería a colgar la corrección de un
    // navegador.
    expect(clasesEfectivasDe(CODIGO, D.filaDeAcciones!)).not.toContain("sticky");
  });
});

/* ==========================================================================
   Defecto 2: la barra no compite con el encabezado.
   ========================================================================== */

describe("inventario: la barra de acciones no se esconde detrás del encabezado", () => {
  it("piso anti-vacío: la barra se localizó y se leyó el shell", () => {
    const b = diagnosticarBarra(CODIGO);
    expect(CODIGO.indexOf(ANCLA_BARRA), "el disparador del diálogo").toBeGreaterThan(0);
    expect(b.rango.fin, "rango de la barra").toBeGreaterThan(b.rango.inicio);
    expect(b.clases.length, "clases de la barra").toBeGreaterThan(3);
    // El shell se leyó de verdad: hay un encabezado `sticky` y está oculto en
    // escritorio, que es lo que hace que arriba de `lg` no haya nada que librar.
    expect(NAV, "main-nav.tsx").toContain("sticky top-0 z-30");
    expect(NAV).toMatch(/<header[^>]*className="[^"]*sticky[^"]*lg:hidden[^"]*"/);
  });

  it("el desplazamiento NO es un número escrito a mano", () => {
    // La base del defecto: `sticky top-0` hace que la barra se ancle en 0, que
    // es justo donde está el encabezado. Un `top-[63px]` escrito a mano sería
    // el mismo error con otro número: se rompe el día que el encabezado cambie
    // de alto (padding, tipografía, un botón más).
    const b = diagnosticarBarra(CODIGO);
    expect(
      b.clases.filter((c) => c.startsWith("top-")),
      "ninguna clase `top-*` en la barra",
    ).toEqual([]);
  });

  it("la barra se ancla a la ALTURA MEDIDA del encabezado, o no se ancla por debajo de `lg`", () => {
    // Las dos formas aceptadas, y sólo dos:
    //   "medida"           — el `top` sale de una variable CSS que el archivo
    //                         ASIGNA con el alto MEDIDO del encabezado del
    //                         shell, sin valor de reserva.
    //   "solo-escritorio"  — no hay `sticky` sin variante: arriba de `lg` el
    //                         encabezado no existe, así que la barra compite
    //                         con nada.
    expect(
      formaDeLaBarra(CODIGO),
      "la barra cumple el contrato del desplazamiento",
    ).not.toBeNull();
  });

  it("el desplazamiento falla CERRADO: sin la variable no hay anclaje, y sin reserva no hay `top: 0`", () => {
    // La reserva `var(--x, 0px)` es el fallo abierto exacto: si la variable no
    // está, el navegador usa 0 y la barra vuelve debajo del encabezado. La
    // forma elegida se queda sin valor calculado —`top: auto`, que no se
    // ancla— hasta que hay una medición.
    const b = diagnosticarBarra(CODIGO);
    expect(b.topEnLinea, "el `top` en línea de la barra").not.toBeNull();
    expect(b.topEnLinea, "sin valor de reserva en el `var()`").toMatch(/^var\(\s*--[\w-]+\s*\)$/);
    // Y la variable se escribe desde una MEDIDA, no desde una constante.
    expect(b.sentenciaOffset, "la sentencia que asigna la variable").not.toBeNull();
    expect(b.sentenciaOffset!).toContain("getBoundingClientRect");
    expect(b.sentenciaOffset!).toContain("height");
    // Y lo medido es el ENCABEZADO ANCLADO, no el `<header>` del título de la
    // página: ese no se ancla y mediría lo que no hay que librar.
    expect(b.selector, "el selector del encabezado").toBe("header.sticky");
  });
});

/* ==========================================================================
   Controles negativos: el diagnóstico NO es un sello de goma.
   ========================================================================== */

/** Diálogo sano: el que esta unidad escribe. Serve de base a los demás. */
const BUENO = `
  <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="shrink-0"><DialogTitle>Crear producto</DialogTitle></DialogHeader>
      <form onSubmit={handleProductSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Label htmlFor="a">SKU *<Input id="a" required /></Label>
            <Label htmlFor="b">Nombre *<Input id="b" required /></Label>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button">Cancelar</Button>
          <Button type="submit">Crear producto</Button>
        </DialogFooter>
      </form>
    </div>
  </DialogContent>
`;

describe("control negativo del diálogo: el diagnóstico acusa el estado previo", () => {
  it("el fixture sano pasa de verdad (si el diagnóstico no pasara nada, el resto es ruido)", () => {
    expect(cumpleElContratoDelDialogo(BUENO)).toBe(true);
  });

  it("el estado previo —el scroller es el diálogo entero— no pasa", () => {
    // Lo que había: no hay contenedor de scroll DENTRO del formulario porque
    // scrollea el `DialogContent`. Esta es la forma que la auditoría midió
    // (839 px de contenido en una caja de 534, y el scroller interno: NINGUNO).
    const antes = `
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Crear producto</DialogTitle></DialogHeader>
        <form onSubmit={handleProductSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label htmlFor="a">SKU *<Input id="a" required /></Label>
          <Label htmlFor="b">Nombre *<Input id="b" required /></Label>
          <DialogFooter className="sm:col-span-2">
            <Button type="button">Cancelar</Button>
            <Button type="submit">Crear producto</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    `;
    expect(cumpleElContratoDelDialogo(antes)).toBe(false);
    const d = diagnosticar(antes, ANCLA_FORMULARIO);
    expect(d.contenedorDeScroll, "scroller interno del estado previo").toBeNull();
    // Y el detalle que lo vuelve indefendible: el `DialogContent` FUSIONADO
    // sigue scrolleando. Una guarda que sólo leyera el `className` del
    // llamador vería `max-w-2xl` y no encontraría nada que objetar.
    const fusionado = cn(clasesBaseDeDialogContent(), classNameEfectivo(antes, d.dialogo.rango.inicio));
    expect(tokensDeClase(fusionado)).toContain("overflow-y-auto");
  });

  it("los botones DE VUELTA adentro del scroller no pasan, aunque el `sticky` siga", () => {
    // El punto ciego de la familia: el token que «funciona en Chromium» y que
    // una guarda de clases daría por bueno. El diagnóstico lo acusa igual.
    const conSticky = `
      <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0"><DialogTitle>Crear producto</DialogTitle></DialogHeader>
          <form onSubmit={handleProductSubmit} className="flex min-h-0 flex-col">
            <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
              <Label htmlFor="a">SKU *<Input id="a" required /></Label>
              <DialogFooter className="sticky bottom-0 z-10 shrink-0 bg-surface">
                <Button type="button">Cancelar</Button>
                <Button type="submit">Crear producto</Button>
              </DialogFooter>
            </div>
          </form>
        </div>
      </DialogContent>
    `;
    const d = diagnosticar(conSticky, ANCLA_FORMULARIO);
    expect(clasesEfectivasDe(conSticky, d.filaDeAcciones!)).toContain("sticky");
    expect(clasesEfectivasDe(conSticky, d.filaDeAcciones!)).toContain("bottom-0");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(true);
    expect(dentro(d.cancelar, d.contenedorDeScroll)).toBe(true);
    expect(cumpleElContratoDelDialogo(conSticky)).toBe(false);
  });

  it("un diálogo que sigue scrolleando no pasa aunque los botones estén fuera", () => {
    const scrolleaElDialogo = BUENO.replace("overflow-y-hidden", "overflow-y-auto");
    expect(cumpleElContratoDelDialogo(scrolleaElDialogo)).toBe(false);
    // Los botones sí están fuera del scroller INTERNO: por eso esa aserción
    // sola no alcanza, y la del diálogo es la que cierra el agujero. Y se ve
    // únicamente al FUSIONAR con la base de la primitiva.
    const d = diagnosticar(scrolleaElDialogo, ANCLA_FORMULARIO);
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(
      tokensDeClase(cn(clasesBaseDeDialogContent(), classNameEfectivo(scrolleaElDialogo, d.dialogo.rango.inicio))),
    ).toContain("overflow-y-auto");
  });

  it("dos medios scrolleables (el segundo scroller anidado) no pasan", () => {
    const dos = BUENO.replace(
      "</div>\n        <DialogFooter",
      '<div className="overflow-y-auto"><p>notas</p></div></div>\n        <DialogFooter',
    );
    expect(cumpleElContratoDelDialogo(dos)).toBe(false);
    expect(diagnosticar(dos, ANCLA_FORMULARIO).contenedorDeScroll).toBeNull();
  });

  it("el medio ENVUELTO en un div pelado no pasa, aunque cada token siga en pie", () => {
    const envuelto = BUENO.replace(
      '<div className="min-h-0 flex-1 overflow-y-auto">',
      '<div><div className="min-h-0 flex-1 overflow-y-auto">',
    ).replace("</DialogFooter>", "</DialogFooter></div>");
    const d = diagnosticar(envuelto, ANCLA_FORMULARIO);
    expect(clasesDe(envuelto, d.contenedorDeScroll!)).toContain("overflow-y-auto");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(d.medioEsPrimerHijo).toBe(false);
    expect(cumpleElContratoDelDialogo(envuelto)).toBe(false);
  });

  it("el medio sin `min-h-0` no pasa: `flex-1` solo no cede el alto", () => {
    const sinMinH = BUENO.replace(
      '<div className="min-h-0 flex-1 overflow-y-auto">',
      '<div className="flex-1 overflow-y-auto">',
    );
    const d = diagnosticar(sinMinH, ANCLA_FORMULARIO);
    expect(clasesDe(sinMinH, d.contenedorDeScroll!)).toContain("flex-1");
    expect(clasesDe(sinMinH, d.contenedorDeScroll!)).not.toContain("min-h-0");
    expect(cumpleElContratoDelDialogo(sinMinH)).toBe(false);
  });

  it("una hoja que no cede el alto no pasa, aunque el resto esté perfecto", () => {
    const hojaRígida = BUENO.replace(
      '<div className="flex min-h-0 flex-1 flex-col">',
      '<div className="flex flex-1 flex-col">',
    );
    const d = diagnosticar(hojaRígida, ANCLA_FORMULARIO);
    expect(clasesEfectivasDe(hojaRígida, d.hoja!.rango)).toContain("flex-col");
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(cumpleElContratoDelDialogo(hojaRígida)).toBe(false);
  });

  it("una fila de acciones que NO es la última pieza del formulario no pasa", () => {
    // El detalle que sostiene lo de «no tapa el último campo»: con algo
    // renderizado después de la fila, ese algo queda debajo de los botones.
    const campoAbajo = BUENO.replace(
      "        </DialogFooter>\n      </form>",
      '        </DialogFooter>\n        <Input id="tarde" required />\n      </form>',
    );
    expect(campoAbajo, "el fixture tiene el campo agregado abajo").not.toBe(BUENO);
    expect(cumpleElContratoDelDialogo(campoAbajo)).toBe(false);
  });

  it("Cancelar por fuera del scroller pero en OTRA fila se ve igual", () => {
    const otraFila = `
      <DialogContent className="max-w-2xl flex flex-col overflow-y-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <form onSubmit={handleProductSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto"><Label htmlFor="a">SKU *<Input id="a" required /></Label></div>
            <DialogFooter className="shrink-0"><Button type="submit">Crear producto</Button></DialogFooter>
            <DialogFooter className="shrink-0"><Button type="button">Cancelar</Button></DialogFooter>
          </form>
        </div>
      </DialogContent>
    `;
    const d = diagnosticar(otraFila, ANCLA_FORMULARIO);
    expect(dentro(d.enviar, d.contenedorDeScroll)).toBe(false);
    expect(d.filaDeAcciones!.fin).toBeLessThan(d.cancelar!.fin);
  });

  it("el diagnóstico no se rompe con las rarezas de los archivos reales", () => {
    // El lexer tiene que sobrevivir al JSX dentro de expresiones (`map`,
    // ternarios con etiquetas) y a los `=>` de los `onChange`.
    const conMap = `
      <DialogContent className="flex flex-col overflow-y-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <form onSubmit={handleProductSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filas.map((fila) => (
                <div key={fila.id} onChange={(e) => setX(e.target.value)}>
                  {fila.n > 0 ? <span>mayor</span> : null}
                  <Input id="campo" required />
                </div>
              ))}
            </div>
            <DialogFooter className="shrink-0"><Button type="submit">Crear producto</Button><Button type="button">Cancelar</Button></DialogFooter>
          </form>
        </div>
      </DialogContent>
    `;
    expect(cumpleElContratoDelDialogo(conMap)).toBe(true);
    expect(() => diagnosticar(conMap, "onSubmit={nada}")).toThrow();
  });
});

/* ==========================================================================
   Controles negativos de la BARRA: cada forma de reincidir en el defecto 2.
   ========================================================================== */

/** Barra sana en forma medida: el desplazamiento viene del encabezado. */
const BARRA_MEDIDA = `
  const SHELL_HEADER_OFFSET_VAR = "--shell-header-height";
  const SHELL_HEADER_SELECTOR = "header.sticky";
  function useShellHeaderOffset(barra) {
    const encabezado = document.querySelector(SHELL_HEADER_SELECTOR);
    barra.current.style.setProperty(SHELL_HEADER_OFFSET_VAR, \`\${Math.ceil(encabezado.getBoundingClientRect().height)}px\`);
  }
  <div
    ref={barra}
    style={{ top: "var(--shell-header-height)" }}
    className="sticky z-10 flex flex-wrap gap-2 rounded-lg border p-3"
  >
    <Button type="button" onClick={() => startProductDialog()}>Crear producto</Button>
    <Button type="button">Registrar movimiento</Button>
  </div>
`;

describe("control negativo de la barra: cada reincidencia del defecto 2 se acusa", () => {
  it("el fixture sano pasa de verdad (si el predicado no pasara nada, el resto es ruido)", () => {
    expect(formaDeLaBarra(BARRA_MEDIDA)).toBe("medida");
  });

  it("el estado previo —`sticky top-0`— no pasa: la barra compite con el encabezado", () => {
    const antes = `
      <div className="sticky top-0 z-10 flex flex-wrap gap-2 rounded-lg border p-3">
        <Button type="button" onClick={() => startProductDialog()}>Crear producto</Button>
      </div>
    `;
    const b = diagnosticarBarra(antes);
    expect(b.clases).toContain("sticky");
    expect(b.clases).toContain("top-0");
    expect(formaDeLaBarra(antes)).toBeNull();
  });

  it("un desplazamiento de ALTURA FIJA no pasa, aunque el número sea el correcto hoy", () => {
    // El mismo defecto con otro número: se rompe el día que el encabezado
    // cambie de alto, que es exactamente lo que no se debe cablear a mano.
    const magico = BARRA_MEDIDA.replace(
      'style={{ top: "var(--shell-header-height)" }}',
      'style={{ top: 63 }}',
    ).replace('className="sticky z-10', 'className="sticky top-[63px] z-10');
    expect(formaDeLaBarra(magico)).toBeNull();
    expect(diagnosticarBarra(magico).clases).toContain("top-[63px]");
  });

  it("una RESERVA en el `var()` no pasa: es el fallo abierto del mismo defecto", () => {
    // `var(--x, 0px)`: si la variable no está —todavía no se midió, o el
    // encabezado no se encontró— el desplazamiento usado es 0 y la barra vuelve
    // debajo del encabezado. La forma correcta no lleva reserva.
    const conReserva = BARRA_MEDIDA.replace(
      'var(--shell-header-height)"',
      'var(--shell-header-height, 0px)"',
    );
    expect(formaDeLaBarra(conReserva)).toBeNull();
    expect(diagnosticarBarra(conReserva).topEnLinea).toContain(",");
  });

  it("una variable ASSIGNADA con un número escrito a mano no pasa", () => {
    const aPez = BARRA_MEDIDA.replace(
      /barra\.current\.style\.setProperty\(SHELL_HEADER_OFFSET_VAR, [^\n]*\);/,
      'barra.current.style.setProperty(SHELL_HEADER_OFFSET_VAR, "63px");',
    );
    expect(aPez, "el fixture cambió de verdad").not.toBe(BARRA_MEDIDA);
    expect(formaDeLaBarra(aPez)).toBeNull();
    expect(diagnosticarBarra(aPez).sentenciaOffset!).not.toContain("getBoundingClientRect");
  });

  it("medir el `<header>` equivocado no pasa: el del título de página no se ancla", () => {
    // `header` a secas también trae el `<header>` de `PageHeader` (el título
    // de la pantalla), que no está anclado y cuya altura no es la que hay que
    // librar. El selector tiene que decir «el que se ancla».
    const equivocado = BARRA_MEDIDA.replace(
      "document.querySelector(SHELL_HEADER_SELECTOR)",
      'document.querySelector("header")',
    );
    expect(formaDeLaBarra(equivocado)).toBeNull();
    expect(diagnosticarBarra(equivocado).selector).toBe("header");
  });

  it("anclarse sólo en escritorio SÍ pasa: es la otra forma permitida", () => {
    // Arriba de `lg` el encabezado no existe (`lg:hidden`), así que no hay con
    // quién competir y la barra puede anclarse a 0. Ningún `sticky` sin
    // variante: es la condición de esta forma.
    const soloEscritorio = `
      <div className="relative z-10 flex flex-wrap gap-2 rounded-lg border p-3 lg:sticky lg:top-0">
        <Button type="button" onClick={() => startProductDialog()}>Crear producto</Button>
      </div>
    `;
    expect(formaDeLaBarra(soloEscritorio)).toBe("solo-escritorio");
    // Y con un `sticky` pelado vuelve a ser el defecto: compite con el
    // encabezado justo en los anchos donde el encabezado existe.
    const pelado = soloEscritorio.replace("lg:sticky", "sticky");
    expect(formaDeLaBarra(pelado)).toBeNull();
  });

  it("una barra que no se ancla no se diagnostica como sana por accidente", () => {
    // Sin `sticky` no hay barra que Diagnosticar: el predicado devuelve null en
    // vez de approving un caso que no se midió.
    const sinSticky = `
      <div className="flex flex-wrap gap-2 rounded-lg border p-3">
        <Button type="button" onClick={() => startProductDialog()}>Crear producto</Button>
      </div>
    `;
    expect(() => diagnosticarBarra(sinSticky)).toThrow();
    expect(formaDeLaBarra(sinSticky)).toBeNull();
  });
});