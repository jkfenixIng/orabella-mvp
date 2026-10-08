import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en caja (WU-C, lote 6).

   Es el MISMO criterio que ya verificaron `services` (WU-B), `alertas`, `vales`
   y `nómina` (lote 2), `inventario` (lote 3), el panel admin (lote 4) y
   `facturación` + `login` (lote 5), aplicado al último módulo con roles
   ad-hoc: `app/cash/` (el monolito del cierre de turno). Cierra además el
   carry-over que el lote 5 dejó fuera de su alcance declarado: el aviso de
   recargo de facturación que no tenía rol (se pinea en feedback-batch5.test.ts).

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", el fallo al abrir o cerrar turno): inline,
                persistente, arriba de las secciones -> `Alert`, que deriva el
                rol ARIA de la variante (`destructive` -> asertivo, el mismo
                anuncio que el marcado escribía a mano).
   - EVENTO  -> lo que acaba de pasar ("Turno abierto con base $…", "Turno
                cerrado.", "Cierre con diferencias: …", "Vista del día
                actualizada.", "Historial … actualizado."): efímero -> `toast`.
                Ocho copias distintas salen por DOS llamadas, porque todas
                pasan por el embudo `showResult` (una sola puerta de éxito).
   - VACÍO   -> el estado base de una tabla o de una lista ("Sin turnos este
                día.", "Sin turnos en el rango.", "Sin vales este día."):
                describe lo esperado, NO bloquea nada y NUNCA anunció nada.
                Sigue siendo texto plano y NO se envuelve en `Alert`: envolverlo
                AGREGARÍA un anuncio que hoy no existe. Queda comentado y
                pineado.
   - DERIVADO EN VIVO -> un aviso CALCULADO del formulario mientras el usuario
                escribe, no el desenlace de una acción enviada: conserva la
                presentación `Alert` pero pasa `role="status"` explícito
                (polite). En caja hoy NO hay ninguno —el diálogo no compara los
                conteos contra nada hasta que se envía— y se pinea el hecho, no
                se inventa el caso. Mismo trato que el panel admin en el lote 4.

   DOS MENSAJES QUE NO SON NINGUNA DE LAS CATEGORÍAS: "Solo quien abrió el turno
   puede cerrarlo." y "Solo admin o caja pueden abrir turnos." no son avisos de
   un hecho ni de un bloqueo con contrato: son la EXPLICACIÓN de por qué el
   botón no está (texto de sección, en `mutedTextClass`, sin rol desde siempre).
   Convertirlos en `Alert` agregaría un anuncio y un color que el diseño no
   tiene; se pinean como texto plano para que nadie los envuelva por inercia.

   Un hecho, un canal: nada se anuncia por los dos.

   ACOPLE E2E: `tests/e2e/cash.spec.ts` era el ÚNICO spec del repo atado al
   MECANISMO del aviso (`p[role="status"]` con `hasText`, cinco veces). Con los
   avisos en el toast ese selector no matchea nada, así que la spec se ancla en
   la bandeja accesible de sonner (rol `region` con nombre "Notifications …") y
   conserva las MISMAS afirmaciones de texto. Ese acople se pinea acá: es la
   única guarda offline que impide que alguien vuelva al selector viejo.

   Offline y sin DOM (`vitest.config.ts` corre `environment: "node"`): lee los
   archivos reales —igual que services-feedback.test.ts y los lotes 2 a 5— y
   afirma el criterio sobre el texto del código. No hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

const CASH_CLIENT_PATH = join(APP_ROOT, "app", "cash", "cash-client.tsx");
const CASH_PAGE_PATH = join(APP_ROOT, "app", "cash", "page.tsx");
const CASH_SPEC_PATH = join(APP_ROOT, "tests", "e2e", "cash.spec.ts");

const CASH_CLIENT_TSX = readFileSync(CASH_CLIENT_PATH, "utf8");
const CASH_PAGE_TSX = readFileSync(CASH_PAGE_PATH, "utf8");
const CASH_SPEC_TS = readFileSync(CASH_SPEC_PATH, "utf8");

/**
 * Código sin comentarios: un `role="alert"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo stripper que el resto de la serie.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CASH_CLIENT_CODE = stripComments(CASH_CLIENT_TSX);
const CASH_PAGE_CODE = stripComments(CASH_PAGE_TSX);
const CASH_SPEC_CODE = stripComments(CASH_SPEC_TS);

/**
 * Las dos superficies de esta unidad. Ojo: `app/cash/loading.tsx` NO entra — su
 * `role="status"` es el anuncio legítimo de un esqueleto de carga y esta unidad
 * no lo toca (se pinea más abajo para que siga siendo así).
 */
const MODULES: Array<[string, string]> = [
  ["app/cash/cash-client.tsx", CASH_CLIENT_CODE],
  ["app/cash/page.tsx", CASH_PAGE_CODE],
];

/**
 * Roles ad-hoc: el ATRIBUTO `role` escrito a mano en el JSX (`role="x"` o
 * `role={...}`). Los roles de estas vistas los pone la primitiva (los deriva de
 * la variante) o los pone ARIA estructural. Es el detector amplio de la serie:
 * obliga a enumerar TODOS los roles que quedan y a justificar cada uno.
 */
const AD_HOC_ROLE = /\brole\s*=\s*["'{]/g;

/**
 * Roles de MENSAJE escritos a mano que NO son el override deliberado de la
 * primitiva: `role="status"`/`role="alert"` sobre cualquier etiqueta, o el rol
 * condicional `role={...}` (el que elegía el rol según el origen del aviso).
 * `role="group"` no entra: agrupa botones, no anuncia un mensaje.
 */
const HAND_WRITTEN_MESSAGE_ROLE = /\brole\s*=\s*(\{[^}]*\}|["'](?:status|alert)["'])/g;

/**
 * La ÚNICA excepción: `role="status"` pegado a la variante de un `<Alert`
 * (`<Alert variant="destructive" role="status"`), que es la forma que usan
 * nómina, inventario y facturación para el aviso derivado en vivo. El ancla es
 * exacta y local: un `role="status"` sobre un `<p>` a 600 caracteres del
 * `<Alert` NO pasa, y una variante que no sea de aviso o de error tampoco (un
 * `success` ya deriva `status`; escribirlo sería redundante, no una decisión).
 */
const ALERT_VARIANT_PREFIX = /<Alert\s+variant="(?:warning|destructive)"\s+$/;

function handWrittenMessageRoles(source: string): string[] {
  return [...source.matchAll(HAND_WRITTEN_MESSAGE_ROLE)]
    .filter((match) => !ALERT_VARIANT_PREFIX.test(source.slice(Math.max(0, match.index - 80), match.index)))
    .map((match) => match[0]);
}

function adHocRoles(source: string): string[] {
  return [...source.matchAll(AD_HOC_ROLE)].map((match) => match[0]);
}

/** Las líneas del código que mencionan un texto. */
function linesWith(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text));
}

/**
 * ¿El enunciado que contiene el texto pasa por esa llamada? Se acota desde el
 * `;` anterior: en las llamadas multilínea (`toast.success(` + template) el
 * literal no comparte renglón con la llamada, y en el embudo (`showResult(`)
 * tampoco alcanza mirar solo la línea.
 */
function statementWraps(source: string, text: string, needle: string): boolean {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const statementStart = source.lastIndexOf(";", index);
  return source.slice(statementStart + 1, index).includes(needle);
}

/**
 * ¿El evento sale por el canal efímero? En caja casi todos los eventos pasan
 * por el embudo `showResult(result, okText)` —que es el que llama a
 * `toast.success(okMessage)`— y el cierre con diferencias llama al toast
 * directo. Los dos son el mismo canal; el detector acepta las dos formas.
 */
function eventWraps(source: string, text: string): boolean {
  return statementWraps(source, text, "showResult(") || statementWraps(source, text, "toast.success(");
}

/**
 * El bloque de texto plano que contiene un texto, desde su etiqueta de apertura
 * hasta el texto. Sirve para los vacíos escritos en varias líneas (la clase va
 * en el `<p>`/`<td>` y el texto un renglón abajo).
 */
function plainTextBlock(source: string, text: string, opener: string): string {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf(opener, index);
  expect(open, `${opener} de ${text}`).toBeGreaterThan(-1);
  // El opener no puede estar DENTRO de un `Alert` todavía abierto: mirar solo
  // hacia adelante desde la etiqueta más cercana se deja engañar por
  // `<Alert><p>texto</p></Alert>` (el `<p>` no menciona `Alert`).
  const before = source.slice(0, open);
  expect(before.lastIndexOf("<Alert") > before.lastIndexOf("</Alert>"), `${text} dentro de un Alert abierto`).toBe(false);
  const block = source.slice(open, index + text.length);
  expect(block, `${text} envuelto en Alert`).not.toContain("Alert");
  expect(block, `${text} con rol ad-hoc`).not.toMatch(/\brole=/);
  return block;
}

/** Cuántos `Alert` abre el módulo (para que el conteo no se vuelva decorativo). */
function alertOpenerCount(source: string): number {
  return [...source.matchAll(/<Alert\b/g)].length;
}

/**
 * Cuántos `Alert` de esa variante abre el módulo. El detector está ANCLADO a
 * `<Alert`: en el lote 2 un `variant="warning"` suelto matcheó la etiqueta de un
 * `Badge` de inventario en vez de un aviso, y el primer intento pasó por bueno
 * sin serlo. Acá no hay `Badge`, pero el detector no depende de eso.
 */
function alertsWithVariant(source: string, variant: "warning" | "destructive"): number {
  const re = new RegExp(`<Alert\\s+variant="${variant}"`, "g");
  return [...source.matchAll(re)].length;
}

/**
 * ¿Cuántos `Alert` de aviso o error llevan el override `role="status"` escrito a
 * mano? Se exige que el atributo venga INMEDIATAMENTE después de la variante y
 * antes del `>`: así un `role="status"` a 600 caracteres de distancia no pasa
 * por vecino.
 */
function alertsWithExplicitStatusRole(source: string): number {
  return [...source.matchAll(/<Alert\s+variant="(?:warning|destructive)"\s+role="status"/g)].length;
}

const ALERT_IMPORT = /import\s*\{\s*Alert\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/alert["']/;
const SONNER_TOAST_IMPORT = /import\s*\{\s*toast\s*\}\s*from\s*["']sonner["']/;

/* ==========================================================================
   El detector mismo (control negativo)
   ========================================================================== */
describe("detector de roles y de Alert: no es un sello de goma", () => {
  it("marca las tres formas que el repositorio tenía escritas y respeta comentarios", () => {
    const fijo = `<p role="status">ok</p><div role="alert">err</div>`;
    const condicional = `<p role={blockNotice ? "alert" : "status"}>x</p>`;
    expect(handWrittenMessageRoles(fijo)).toHaveLength(2);
    expect(handWrittenMessageRoles(condicional)).toHaveLength(1);
    // El stripper no borra código real: solo comentarios.
    expect(stripComments(fijo)).toBe(fijo);
    expect(handWrittenMessageRoles(stripComments(`/* role="status" */ // role="alert"`))).toEqual([]);
  });

  it("el override deliberado de la primitiva NO es un rol ad-hoc; uno lejano sí", () => {
    // La forma exacta que el carry-over de facturación deja (lote 5/6).
    expect(handWrittenMessageRoles('<Alert variant="destructive" role="status">x</Alert>')).toEqual([]);
    expect(handWrittenMessageRoles('<Alert variant="warning" role="status">x</Alert>')).toEqual([]);
    // El ancla es local: si el rol se despega de la apertura del `Alert`, el
    // detector lo vuelve a cazar (no se lo lleva puesto por vecindad difusa).
    expect(
      handWrittenMessageRoles('<Alert variant="warning" className="x">\n  texto\n</Alert>\n<p role="status">x</p>'),
    ).toHaveLength(1);
    // Un `role="alert"` sobre un `<p>` vuelve a ser el defecto, y el condicional
    // también: es el que elegía el rol según el origen del aviso.
    expect(handWrittenMessageRoles('<p role="alert">x</p>')).toHaveLength(1);
    expect(handWrittenMessageRoles('<p role={blockNotice ? "alert" : "status"}>x</p>')).toHaveLength(1);
  });

  it("`role=\"group\"` es ARIA estructural, no un mensaje: el detector de mensajes no lo toca", () => {
    // Caja no tiene agrupaciones con rol, pero el detector no debe confundirlas
    // si algún día aparecen (el tablist del panel admin es el caso real).
    expect(handWrittenMessageRoles('<div role="group" aria-label="Métodos">x</div>')).toEqual([]);
    expect(adHocRoles('<div role="group" aria-label="Métodos">x</div>')).toHaveLength(1);
    expect(handWrittenMessageRoles('<div role="tablist">x</div>')).toEqual([]);
  });

  it("el detector de `Alert` está anclado a `<Alert`: una etiqueta cualquiera no cuenta", () => {
    // La regresión concreta del lote 2: un `variant="warning"` suelto matcheaba
    // la etiqueta de un `Badge` en vez de un aviso.
    expect(alertsWithVariant('<Alert variant="destructive">x</Alert>', "destructive")).toBe(1);
    expect(alertsWithVariant('<Badge variant="destructive">Anulada</Badge>', "destructive")).toBe(0);
    expect(alertsWithVariant('<Alert variant="destructive">x</Alert>', "warning")).toBe(0);
    // El conteo de aperturas también exige la etiqueta completa.
    expect(alertOpenerCount('<Badge variant="destructive">x</Badge>')).toBe(0);
    expect(alertOpenerCount('<Alert variant="destructive">x</Alert>')).toBe(1);
    // Y el override deliberado se detecta solo pegado a la variante.
    expect(alertsWithExplicitStatusRole('<Alert variant="destructive" role="status">x</Alert>')).toBe(1);
    expect(alertsWithExplicitStatusRole('<Alert variant="destructive">x</Alert>')).toBe(0);
  });

  it("el detector del canal efímero reconoce el embudo, el toast multilínea y no lo presta al vecino", () => {
    // El embudo de caja: la copia entra por `showResult(`.
    const embudo = "x();\n  showResult(result, `Turno cerrado.`);\n  setError(null);\n";
    expect(eventWraps(embudo, "`Turno cerrado.`")).toBe(true);
    // El cierre con diferencias llama al toast directo, en varias líneas.
    const multilinea = "x();\n  toast.success(\n    `Cierre con diferencias: ${parts}.`,\n  );\n";
    expect(eventWraps(multilinea, "`Cierre con diferencias: ${parts}.`")).toBe(true);
    // Y un aviso que NO sale por ninguno de los dos canales no se lleva el canal
    // prestado por vecindad.
    const sinCanal = "setError(`uno`);\n  setError(`dos`);\n";
    expect(eventWraps(sinCanal, "`dos`")).toBe(false);
  });

  it("el detector de vacíos rechaza un vacío envuelto en Alert o con rol", () => {
    // Control negativo del pin de los vacíos: si el detector no distinguiera un
    // `Alert` de un texto plano, las guardas de abajo pasarían por buenas sin
    // verificar nada.
    expect(() => plainTextBlock('<Alert variant="info"><p>Sin turnos este día.</p></Alert>', "Sin turnos este día.", "<p")).toThrow();
    expect(() => plainTextBlock('<p role="status">Sin turnos este día.</p>', "Sin turnos este día.", "<p")).toThrow();
    expect(plainTextBlock('<p className="text-text-secondary">Sin turnos este día.</p>', "Sin turnos este día.", "<p")).toContain(
      "text-text-secondary",
    );
  });

  it("los dos archivos y la spec se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(CASH_CLIENT_CODE.length, "cash-client.tsx").toBeGreaterThan(25_000);
    expect(CASH_PAGE_CODE.length, "cash/page.tsx").toBeGreaterThan(2_500);
    expect(CASH_SPEC_CODE.length, "tests/e2e/cash.spec.ts").toBeGreaterThan(3_000);
    // Anclas de contenido: el cliente es grande, así que se anclan las piezas
    // que esta unidad toca (el embudo de resultado, el cierre con diferencias y
    // el error compartido), no solo la firma del módulo.
    expect(CASH_CLIENT_CODE).toContain("export function CashClient(props: CashClientProps)");
    expect(CASH_CLIENT_CODE).toContain("function showResult<T>(result: ActionResult<T>, okMessage: string)");
    expect(CASH_CLIENT_CODE).toContain("async function handleClose(event: FormEvent)");
    expect(CASH_CLIENT_CODE).toContain("const [error, setError] = useState<string | null>(null)");
    expect(CASH_PAGE_CODE).toContain("export default async function CashPage()");
    expect(CASH_SPEC_CODE).toContain('test("caja abre y cierra un turno @changed"');
  });
});

/* ==========================================================================
   Roles ad-hoc: lo que queda, y por qué es legítimo
   ========================================================================== */
describe("caja: no queda ningún portador de mensaje ad-hoc", () => {
  it("ningún mensaje conserva un rol escrito a mano fuera de la primitiva", () => {
    for (const [path, code] of MODULES) {
      expect(handWrittenMessageRoles(code), `role de mensaje en ${path}`).toEqual([]);
      // Ni un `role="alert"` asertivo suelto: los asertivos los pone la
      // variante, no la vista.
      expect(code, `role="alert" en ${path}`).not.toMatch(/role="alert"/);
    }
  });

  it("no queda ni un rol condicional ni un solo `role=` en el código (los del comentario no cuentan)", () => {
    for (const [path, code] of MODULES) {
      expect(code, `role={ en ${path}`).not.toMatch(/role=\{/);
      // Enumerativo a propósito: el `<p role="alert">` y el `<p role="status">`
      // se fueron, y cualquier rol nuevo tiene que venir con su justificación.
      expect(adHocRoles(code), `roles escritos a mano en ${path}`).toEqual([]);
    }
    // Los únicos `role=` que quedan en el TEXTO de los archivos están en los
    // comentarios que explican el criterio; el stripper los deja fuera.
    expect(CASH_CLIENT_TSX).toMatch(/<p role="status">/);
    expect(CASH_CLIENT_TSX).toMatch(/<p role="alert">/);
    expect(CASH_PAGE_TSX).toMatch(/role="alert"/);
  });

  it("el esqueleto de carga queda intacto: su `role=\"status\"` es del esqueleto", () => {
    // No es un mensaje ad-hoc: anuncia que la pantalla todavía está cargando.
    // Está FUERA de los dos archivos de esta unidad y por eso el detector no lo
    // ve; se lee igual para que nadie lo confunda con el defecto.
    const loadingPath = join(APP_ROOT, "app", "cash", "loading.tsx");
    const code = stripComments(readFileSync(loadingPath, "utf8"));
    expect(code, loadingPath).toMatch(/role="status"/);
    expect(code, loadingPath).toContain("Cargando…");
    // Sigue siendo un esqueleto, no un mensaje de error o de éxito.
    expect(code, loadingPath).not.toContain("<Alert");
  });
});

/* ==========================================================================
   Las dos superficies: lo efímero va por el toast (evento)
   ========================================================================== */
describe("caja: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(CASH_CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    // El Toaster ya está montado una sola vez en app/layout.tsx (ui-feedback.test.ts).
    expect(CASH_CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it("los ocho eventos de caja salen por el canal efímero", () => {
    // Apertura (tres desenlaces), cierre (tres), vista del día e historial.
    const eventos: string[] = [
      "Turno abierto con base ${formatMoney(shift.opening_base)}.",
      "Turno abierto. Primera apertura: el conteo inicial quedó registrado.",
      "Turno abierto con diferencias registradas.",
      "Turno cerrado.",
      "Turno cerrado. Base ${formatMoney(row.base_left)} · sobre ${formatMoney(envelope)}.",
      "Cierre con diferencias: ${parts.join(\" · \")}. Sobre ${formatMoney(envelope)}. Se informó a los administradores.",
      "Vista del día actualizada.",
      "Historial ${histDesde} … ${histHasta} actualizado.",
    ];
    for (const text of eventos) {
      expect(eventWraps(CASH_CLIENT_CODE, text), text).toBe(true);
    }
    // Ocho copias, DOS llamadas: seis pasan por el embudo `showResult` y el
    // cierre con diferencias llama al toast directo. Si alguien dejara un evento
    // por estado, el literal de la lista no tendría su canal y fallaría arriba.
    expect([...CASH_CLIENT_CODE.matchAll(/toast\.success\(/g)]).toHaveLength(2);
    expect([...CASH_CLIENT_CODE.matchAll(/toast\./g)]).toHaveLength(2);
    // El embudo es UNA puerta: `showResult` solo llama al toast cuando hay copia
    // de éxito (los `showResult(result, "")` de las ramas de fallo no lo tocan).
    expect(CASH_CLIENT_CODE).toMatch(/toast\.success\(okMessage\)/);
    expect(CASH_CLIENT_CODE).toMatch(/if \(okMessage\) \{/);
    // Las dos llamadas con copia vacía existen: el guard no es decorativo.
    expect(linesWith(CASH_CLIENT_CODE, 'showResult(result, "");')).toHaveLength(2);
  });

  it("el aviso de éxito dejó de ser estado: ya no hay `notice` ni setNotice", () => {
    // El estado `notice` y su reset se retiran con el último `<p>`; la mención
    // que queda en el código está en un comentario que explica el cambio, y el
    // stripper la deja fuera.
    expect(CASH_CLIENT_CODE).not.toMatch(/setNotice/);
    expect(CASH_CLIENT_CODE).not.toMatch(/\bnotice\b/);
    // Las clases del estado de éxito/error quedaron sin consumidor.
    expect(CASH_CLIENT_CODE).not.toMatch(/okClass/);
    expect(CASH_CLIENT_CODE).not.toMatch(/errorClass/);
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    for (const [path, code] of MODULES) {
      expect(code, `${path}: toast de fallo`).not.toMatch(/toast\.(error|warning|info)\(/);
    }
  });

  it("la página es Server Component: no tiene eventos y no puede importar toast", () => {
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(CASH_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(CASH_PAGE_CODE).not.toMatch(SONNER_TOAST_IMPORT);
    expect(CASH_PAGE_CODE).not.toMatch(/\btoast\b/);
  });
});

/* ==========================================================================
   Las dos superficies: lo persistente va por Alert (estado)
   ========================================================================== */
describe("caja: lo persistente va por Alert (estado)", () => {
  it("el cliente tiene un solo Alert, destructivo: el error compartido", () => {
    // Un solo mensaje persistente en todo el cliente (el fallo de abrir o cerrar
    // el turno). Si apareciera un Alert de más, o alguien cambiara la variante,
    // el conteo lo delata.
    expect(CASH_CLIENT_CODE).toMatch(ALERT_IMPORT);
    expect(alertOpenerCount(CASH_CLIENT_CODE)).toBe(1);
    expect(alertsWithVariant(CASH_CLIENT_CODE, "destructive")).toBe(1);
    expect(alertsWithVariant(CASH_CLIENT_CODE, "warning")).toBe(0);
    // Ni `info` ni `success` como `Alert`: nada se confirma por estado (eso es
    // evento y va por toast) y no hay datos de color neutro que anunciar.
    expect(CASH_CLIENT_CODE).not.toMatch(/<Alert\s+variant="info"/);
    expect(CASH_CLIENT_CODE).not.toMatch(/<Alert\s+variant="success"/);
  });

  it("el error es estado: Alert destructivo arriba de las secciones, y no un `<p>` con la clase suelta", () => {
    expect(CASH_CLIENT_CODE).toMatch(/<Alert variant="destructive">\{error\}<\/Alert>/);
    // El mismo `error` se muestra en UN solo sitio (el cliente es un monolito de
    // una sola vista; los diálogos no tienen su propio bloque de error).
    expect(linesWith(CASH_CLIENT_CODE, "{error}")).toHaveLength(1);
    // Y el fallo de una acción alimenta ese estado, sin prefijo agregado: la
    // copia visible es la del servidor.
    expect(CASH_CLIENT_CODE).toMatch(/setError\(result\.message\)/);
    // Ninguno quedó como `<p>` con la clase de error suelta.
    expect(CASH_CLIENT_CODE).not.toMatch(/<p role="alert"/);
    expect(CASH_CLIENT_CODE).not.toMatch(/<p role="status"/);
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(CASH_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(CASH_PAGE_CODE).toMatch(
      /<Alert variant="destructive">El usuario no tiene sede asignada\.<\/Alert>/,
    );
    expect(alertsWithVariant(CASH_PAGE_CODE, "destructive")).toBe(1);
    expect(alertsWithExplicitStatusRole(CASH_PAGE_CODE)).toBe(0);
  });

  it("no hay ningún aviso DERIVADO EN VIVO en caja: se pinea el hecho, no se inventa el caso", () => {
    // El diálogo de caja no valida mientras se teclea: los conteos por
    // denominación y los totales digitales no se comparan contra nada hasta que
    // el usuario envía (`closeCashTotal()` corre en el submit, no en el
    // `onChange`). Por eso el override polite no aparece acá. Si algún día
    // aparece un aviso calculado del formulario, `role="status"` es obligatorio
    // y esta guarda —que hoy exige 0— lo delata.
    expect(alertsWithExplicitStatusRole(CASH_CLIENT_CODE)).toBe(0);
    expect(alertsWithExplicitStatusRole(CASH_PAGE_CODE)).toBe(0);
    // Ningún `onChange` toca el error ni el toast: no hay canal derivado en vivo.
    for (const line of CASH_CLIENT_CODE.split("\n").filter((l) => l.includes("setError("))) {
      expect(line, line).not.toMatch(/onChange/);
    }
    for (const line of CASH_CLIENT_CODE.split("\n").filter((l) => l.includes("toast."))) {
      expect(line, line).not.toMatch(/onChange/);
    }
  });
});

/* ==========================================================================
   Vacíos y texto de sección: deliberados, sin rol y sin `Alert`
   ========================================================================== */
describe("caja: los vacíos y el texto de sección siguen siendo deliberados", () => {
  it("los tres vacíos siguen siendo texto plano, no avisos", () => {
    // Describen el estado base, no bloquean nada y nunca anunciaron nada (no
    // tenían rol): siguen en su clase de texto y NO se envuelven en `Alert`
    // —envolverlos AGREGARÍA el anuncio que hoy no existe—. Queda pineado.
    // La tabla comparte el mismo `<td>` para vista del día e historial: la copia
    // llega por la prop `emptyText`, así que se afirma la celda y sus dos copias.
    expect(plainTextBlock(CASH_CLIENT_CODE, "{emptyText}", "<td")).toContain("text-text-secondary");
    expect(CASH_CLIENT_CODE).toContain('emptyText="Sin turnos este día."');
    expect(CASH_CLIENT_CODE).toContain('emptyText="Sin turnos en el rango."');
    expect(plainTextBlock(CASH_CLIENT_CODE, "Sin vales este día.", "<p")).toContain("mutedTextClass");
  });

  it("los dos mensajes de sección no son avisos: explican por qué falta el botón", () => {
    // No son el desenlace de una acción ni un bloqueo derivado del formulario:
    // son la razón visible de que el botón no esté, en texto atenuado y sin rol
    // desde siempre. Se pinean para que nadie los envuelva en `Alert` por
    // inercia (agregaría un anuncio y un color que el diseño no tiene).
    expect(plainTextBlock(CASH_CLIENT_CODE, "Solo quien abrió el turno puede cerrarlo.", "<p")).toContain(
      "mutedTextClass",
    );
    expect(plainTextBlock(CASH_CLIENT_CODE, "Solo admin o caja pueden abrir turnos.", "<p")).toContain(
      "mutedTextClass",
    );
    // Y el estado base del turno es contenido, no un aviso.
    expect(plainTextBlock(CASH_CLIENT_CODE, "No hay un turno abierto.", "<p")).toContain("<p>");
  });
});

/* ==========================================================================
   El texto visible no cambió (cambia el canal, no la copia)
   ========================================================================== */
describe("caja: el texto visible no cambió", () => {
  it("las copias de las dos superficies siguen ahí, palabra por palabra", () => {
    const copias: string[] = [
      "Turno abierto con base ${formatMoney(shift.opening_base)}.",
      "Turno abierto. Primera apertura: el conteo inicial quedó registrado.",
      "Turno abierto con diferencias registradas.",
      "Turno cerrado.",
      "Turno cerrado. Base ${formatMoney(row.base_left)} · sobre ${formatMoney(envelope)}.",
      "Cierre con diferencias: ${parts.join(\" · \")}. Sobre ${formatMoney(envelope)}. Se informó a los administradores.",
      "Vista del día actualizada.",
      "Historial ${histDesde} … ${histHasta} actualizado.",
      "No hay un turno abierto.",
      "Solo quien abrió el turno puede cerrarlo.",
      "Solo admin o caja pueden abrir turnos.",
      "Sin turnos este día.",
      "Sin turnos en el rango.",
      "Sin vales este día.",
      "¿Está seguro de cerrar?",
      "Después del cierre ya no podrá modificarlo.",
      "Cierra este turno como administrador.",
      "Cuente billetes y monedas por denominación y declare los totales digitales.",
      "Justificación de la revisión",
      "Total en vales:",
      "Acumulado (",
    ];
    for (const text of copias) {
      expect(CASH_CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(CASH_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(CASH_PAGE_CODE, "página: encabezado").toContain("Turnos, pagos por método y cierres de caja.");
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(CASH_CLIENT_CODE).not.toContain("Turno abierto correctamente.");
    expect(CASH_CLIENT_CODE).not.toContain("El turno se cerró.");
    expect(CASH_CLIENT_CODE).not.toContain("Sin turnos registrados.");
    expect(CASH_CLIENT_CODE).not.toContain("No hay turnos abiertos.");
    expect(CASH_PAGE_CODE).not.toContain("Sin sede asignada.");
    expect(CASH_PAGE_CODE).not.toContain("El usuario no tiene una sede.");
  });
});

/* ==========================================================================
   El acople con la spec e2e: el único del repo atado al mecanismo
   ========================================================================== */
describe("el acople con la spec e2e de caja", () => {
  it("los cinco avisos ya no se buscan como `p[role=\"status\"]`", () => {
    // La spec afirmaba el MECANISMO (`p[role="status"]` con `hasText`, cinco
    // veces) y no el texto. Con los avisos en el toast ese selector no matchea
    // nada: se ancla en la bandeja accesible de sonner y se conserva el texto.
    expect(CASH_SPEC_CODE).not.toMatch(/role=/);
    expect([...CASH_SPEC_CODE.matchAll(/p\[role="status"\]/g)]).toHaveLength(0);
    // El selector nuevo es por rol/nombre accesible, no por clase ni atributo
    // interno de sonner: si alguien vuelve a un `[data-sonner-toast]` o a una
    // `.clase`, esta guarda lo delata.
    expect(CASH_SPEC_CODE).toMatch(/getByRole\("region", \{ name: \/notifications\/i \}\)/);
    expect(CASH_SPEC_CODE).not.toMatch(/data-sonner-toast/);
    expect(CASH_SPEC_CODE).not.toMatch(/\.sonner/);
  });

  it("las cinco afirmaciones conservan su texto y toman el toast más nuevo", () => {
    // Las MISMAS dos afirmaciones de texto que había antes, cinco veces.
    expect([...CASH_SPEC_CODE.matchAll(/getByText\(\/turno abierto\/i\)/g)]).toHaveLength(2);
    expect([...CASH_SPEC_CODE.matchAll(/getByText\(\/turno cerrado\|cierre con diferencias\/i\)/g)]).toHaveLength(3);
    // Y las cinco van dentro de la bandeja y con `.first()`: sonner antepone
    // cada toast, así que el primero del DOM es el último en llegar.
    expect([...CASH_SPEC_CODE.matchAll(/avisos\(page\)\.getByText\(/g)]).toHaveLength(5);
    expect([...CASH_SPEC_CODE.matchAll(/avisos\(page\)\.getByText\([^)]*\)\.first\(\)\)\.toBeVisible/g)]).toHaveLength(5);
  });

  it("el resto del acople no cambió: el turno sigue esperándose por su texto de página", () => {
    // `No hay un turno abierto.` y `Sin turnos este día.` NO son avisos: siguen
    // siendo texto de la página y la spec los sigue buscando así.
    expect([...CASH_SPEC_CODE.matchAll(/getByText\("No hay un turno abierto\."\)/g)]).toHaveLength(4);
    expect(CASH_SPEC_CODE).toContain('getByText("Sin turnos este día.")');
    // El acople con la base de datos no se tocó: mismo skip por backend de
    // pruebas y mismo estado de sesión.
    expect(CASH_SPEC_CODE).toContain('test.skip(process.env.E2E_BACKEND !== "test"');
    expect(CASH_SPEC_CODE).toContain('test.use({ storageState: "./tests/e2e/.auth/user.json" });');
  });
});
