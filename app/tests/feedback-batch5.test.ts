import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en facturación y login (WU-C, lote 5).

   Es el MISMO criterio que ya verificaron `services` (WU-B), `alertas`, `vales`
   y `nómina` (lote 2), `inventario` (lote 3) y el panel admin (lote 4), aplicado
   a los dos módulos de este lote: `app/invoices/` (la vista con más portadores
   de rol escritos a mano de la app: diez) y `app/login/`.

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", "Agregue al menos un ítem a la factura."):
                inline, persistente, al lado de la cosa -> `Alert`, que deriva el
                rol ARIA de la variante (`destructive` -> asertivo, el mismo
                anuncio que el marcado escribía a mano).
   - ESTADO CONFIRMADO al hacer clic -> la guarda de caja de facturación
                (`blockNotice`) no es un fallo del usuario: es la precondición
                pendiente que ya estaba en ámbar, así que la variante deliberada
                es `warning`, que además deriva `alert` (asertivo): el clic ya
                ocurrió y hay que enterarse. Mismo tratamiento que la
                precondición de vales (mismo texto de turno, mismo archivo de
                origen en el criterio).
   - ESTADO DERIVADO EN VIVO -> el mismo bloqueo de caja cuando NADIE envió una
                acción (`shiftBlockReason` a secas): conserva la presentación
                `Alert variant="warning"` pero pasa `role="status"` explícito
                (polite). Es exactamente la distinción que el marcado anterior ya
                hacía con `role={blockNotice ? "alert" : "status"}`, ahora con una
                sola ARIA por clase de mensaje. Mismo criterio de rol que los dos
                avisos de nómina y el del SKU de inventario.
   - EVENTO  -> lo que acaba de pasar ("Factura #12 Pagada.", "Cobro completo:
                factura pagada.", "Comisión pagada desde la caja del turno."):
                efímero -> `toast`.
   - VACÍO   -> el estado base de una lista o tabla ("Sin facturas para estos
                filtros.", "Sin impuestos.", "Sin cobro registrado (Emitida).",
                "Sin ítems. Agregue al menos uno para emitir."): describe lo
                esperado, NO bloquea nada y NUNCA anunció nada. Sigue siendo
                texto plano y NO se envuelve en `Alert`: envolverlo AGREGARÍA un
                anuncio que hoy no existe. Queda comentado y pineado.

   Login entra con una decisión explícita, ahora con CUATRO Alert:

   - DOS FALLOS CONFIRMADOS (credencial rechazada, confirmación que no
     coincide): `destructive`, no validaciones derivadas en vivo. El envío no
     se valida mientras se teclea —la presencia la frena el navegador con
     `required`—, así que `destructive` conserva el anuncio asertivo que el
     `role="alert"` escribía a mano.
   - UN ESTADO CONFIRMADO POR POLÍTICA: el paso AUTH-01 (cambio forzado de
     clave) era una sección ámbar escrita a mano con el par
     `bg-warning-light` + `text-warning` —el antipatrón que §9 del estándar
     prohíbe: estilos fuera de la primitiva—. Es exactamente el par que
     deriva la variante `warning`, así que ahora lo consume por la primitiva:
     mismo render, una sola ARIA por clase de mensaje.
   - UN ESTADO DERIVADO EN VIVO: la pista de requisitos de la clave nueva (8+
     caracteres, letra y número) se calcula de `nueva` mientras se escribe.
     Es una PISTA: no bloquea el envío (la validación real sigue siendo el
     Zod del servidor, `changePasswordSchema`) y puede decir "le falta" como
     "cumple", así que NO va en `destructive` —ese canal queda reservado para
     los dos fallos confirmados—. Va como `Alert variant="info"`: el par
     neutro de marca, y `info` DERIVA `role="status"` (polite) en la
     primitiva, de modo que el canal derivado no necesita ningún rol escrito
     a mano y el archivo conserva CERO overrides. Es el mismo caso que el
     SKU de inventario (`destructive` + `role="status"`), con una variante
     neutral porque acá no bloquea. Y queda condicionado: con el campo vacío
     no se renderiza nada (criterio VACÍO: no agregar un anuncio que hoy no
     existe); un checklist siempre visible sería un anuncio permanente que
     la pantalla de hoy no tiene. Si la pista llegara a BLOQUEAR el envío
     (disabled o return), la guarda de abajo la acusa: tendría que decidir
     variante y rol de nuevo.

   CARRY-OVER DEL LOTE 6: este lote declaró como superficie los portadores de rol
   y dejó afuera, por eso mismo, un aviso SIN rol que sí es un mensaje del
   criterio: el recargo del cobro en edición (`!feeOk`). Es ESTADO DERIVADO EN
   VIVO —se calcula del método elegido mientras el usuario edita, y bloquea el
   guardado— así que el lote 6 lo convierte en `Alert variant="destructive"
   role="status"` (polite) conservando el `text-xs` y la copia. Se pinea al final
   de este archivo, junto al resto de la superficie que lo contiene.

   ARIA ESTRUCTURAL: quedan dos `role="group"` con su `aria-label` (el
   conmutador de modo de comisión del ítem y la rejilla de tipo de ítem). No son
   mensajes: agrupan botones y siguen pineados acá para que nadie los confunda
   con el defecto que esta unidad elimina.

   Un hecho, un canal: nada se anuncia por los dos.

   Offline y sin DOM (`vitest.config.ts` corre `environment: "node"`): lee los
   archivos reales —igual que services-feedback.test.ts y los lotes 2, 3 y 4— y
   afirma el criterio sobre el texto del código. No hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

const INVOICES_CLIENT_PATH = join(APP_ROOT, "app", "invoices", "invoices-client.tsx");
const INVOICES_PAGE_PATH = join(APP_ROOT, "app", "invoices", "page.tsx");
const LOGIN_FORM_PATH = join(APP_ROOT, "app", "login", "login-form.tsx");

const INVOICES_CLIENT_TSX = readFileSync(INVOICES_CLIENT_PATH, "utf8");
const INVOICES_PAGE_TSX = readFileSync(INVOICES_PAGE_PATH, "utf8");
const LOGIN_FORM_TSX = readFileSync(LOGIN_FORM_PATH, "utf8");

/**
 * Código sin comentarios: un `role="alert"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo stripper que el resto de la serie.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const INVOICES_CLIENT_CODE = stripComments(INVOICES_CLIENT_TSX);
const INVOICES_PAGE_CODE = stripComments(INVOICES_PAGE_TSX);
const LOGIN_FORM_CODE = stripComments(LOGIN_FORM_TSX);

/**
 * Las tres superficies de esta unidad. Ojo: los `role="status"` de
 * `app/invoices/loading.tsx` y `app/login/loading.tsx` NO entran — viven fuera
 * de estos tres archivos, son el anuncio legítimo de un esqueleto de carga y
 * esta unidad no los toca (se pinean más abajo para que siga siendo así).
 */
const MODULES: Array<[string, string]> = [
  ["app/invoices/invoices-client.tsx", INVOICES_CLIENT_CODE],
  ["app/invoices/page.tsx", INVOICES_PAGE_CODE],
  ["app/login/login-form.tsx", LOGIN_FORM_CODE],
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
 * (`<Alert variant="warning" role="status"`), que es la forma que usan nómina e
 * inventario para el aviso derivado en vivo. El ancla es exacta y local: un
 * `role="status"` sobre un `<p>` a 600 caracteres del `<Alert` NO pasa, y una
 * variante que no sea de aviso o de error tampoco (un `success` ya deriva
 * `status`; escribirlo sería redundante, no una decisión).
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
 * ¿El texto sale por el canal efímero? Busca el literal y mira hacia atrás
 * desde el `;` anterior: en las llamadas multilínea (`toast.success(` + ternario)
 * el `toast.success(` queda dos o tres renglones arriba del texto, así que
 * `linesWith` no alcanza. Acotado al enunciado para que el toast de un evento
 * anterior no preste su canal al siguiente.
 */
function toastWraps(source: string, text: string): boolean {
  return statementWraps(source, text, "toast.success(");
}

/**
 * ¿El enunciado que contiene el texto pasa por esa llamada? Para los mensajes
 * que se arman con un ternario dentro de un setter (`setCommissionError(` +
 * ternario), el setter queda dos renglones arriba del literal y `linesWith` no
 * alcanza: se acota al enunciado, desde el `;` anterior.
 */
function statementWraps(source: string, text: string, needle: string): boolean {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const statementStart = source.lastIndexOf(";", index);
  return source.slice(statementStart + 1, index).includes(needle);
}

/**
 * El bloque de texto plano que contiene un texto, desde su etiqueta de apertura
 * hasta el texto. Sirve para los vacíos escritos en varias líneas (la clase va
 * en el `<p>`/`<li>`/`<td>` y el texto un renglón abajo).
 */
function plainTextBlock(source: string, text: string, opener: string): string {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf(opener, index);
  expect(open, `${opener} de ${text}`).toBeGreaterThan(-1);
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
 * `<Alert`: en el lote anterior un `variant="warning"` suelto matcheó la
 * etiqueta de un `Badge` de inventario en vez de un aviso, y el primer intento
 * pasó por bueno sin serlo. Acá no hay `Badge`, pero el detector no depende de
 * eso.
 */
function alertsWithVariant(source: string, variant: "warning" | "destructive" | "info"): number {
  const re = new RegExp(`<Alert\\s+variant="${variant}"`, "g");
  return [...source.matchAll(re)].length;
}

/**
 * ¿Cuántos `Alert` de aviso o error llevan el override `role="status"` escrito
 * a mano? Se exige que el atributo venga INMEDIATAMENTE después de la variante y
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
    // La forma exacta que esta unidad deja en facturación.
    expect(handWrittenMessageRoles('<Alert variant="warning" role="status">x</Alert>')).toEqual([]);
    expect(handWrittenMessageRoles('<Alert variant="destructive" role="status">x</Alert>')).toEqual([]);
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
    // Los dos `role="group"` que facturación conserva agrupan botones.
    expect(handWrittenMessageRoles('<div role="group" aria-label="Tipo de ítem">x</div>')).toEqual([]);
    expect(adHocRoles('<div role="group" aria-label="Tipo de ítem">x</div>')).toHaveLength(1);
  });

  it("el detector de `Alert` está anclado a `<Alert`: una etiqueta cualquiera no cuenta", () => {
    // La regresión concreta del lote 2: un `variant="warning"` suelto matcheaba
    // la etiqueta de un `Badge` en vez de un aviso.
    expect(alertsWithVariant('<Alert variant="warning">x</Alert>', "warning")).toBe(1);
    expect(alertsWithVariant('<Badge variant="warning">Bajo mínimo</Badge>', "warning")).toBe(0);
    expect(alertsWithVariant('<Alert variant="destructive">x</Alert>', "warning")).toBe(0);
    // El canal derivado del login es `info`: el detector también lo cuenta.
    expect(alertsWithVariant('<Alert variant="info" className="text-xs">x</Alert>', "info")).toBe(1);
    expect(alertsWithVariant('<Alert variant="warning">x</Alert>', "info")).toBe(0);
    // El conteo de aperturas también exige la etiqueta completa.
    expect(alertOpenerCount('<Badge variant="warning">x</Badge>')).toBe(0);
    expect(alertOpenerCount('<Alert variant="destructive">x</Alert>')).toBe(1);
    // Y el override deliberado se detecta solo pegado a la variante.
    expect(alertsWithExplicitStatusRole('<Alert variant="warning" role="status">x</Alert>')).toBe(1);
    expect(alertsWithExplicitStatusRole('<Alert variant="warning">x</Alert>')).toBe(0);
  });

  it("el detector del canal efímero reconoce el toast multilínea y no lo presta al vecino", () => {
    const multilinea = "x();\n  toast.success(\n    a ? `uno` : `dos`,\n  );\n";
    expect(toastWraps(multilinea, "`dos`")).toBe(true);
    const sinToast = "setError(`uno`);\n  setError(`dos`);\n";
    expect(toastWraps(sinToast, "`dos`")).toBe(false);
  });

  it("los tres archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(INVOICES_CLIENT_CODE.length, "invoices-client.tsx").toBeGreaterThan(130_000);
    expect(INVOICES_PAGE_CODE.length, "invoices/page.tsx").toBeGreaterThan(2_500);
    expect(LOGIN_FORM_CODE.length, "login/login-form.tsx").toBeGreaterThan(5_000);
    // Anclas de contenido: el cliente es enorme, así que se anclan las tres
    // piezas que esta unidad toca (los dos bloques de estado de caja, el error
    // compartido y los dos eventos de facturas), no solo la firma del módulo.
    expect(INVOICES_CLIENT_CODE).toContain("export function InvoicesClient(props: InvoicesClientProps)");
    expect(INVOICES_CLIENT_CODE).toContain("const shiftBlockReason: string | null = !shiftKnown");
    expect(INVOICES_CLIENT_CODE).toContain("function passShiftGate(): boolean {");
    expect(INVOICES_CLIENT_CODE).toContain("async function confirmCommissionPayment() {");
    expect(INVOICES_CLIENT_CODE).toContain("const [error, setError] = useState<string | null>(null)");
    expect(INVOICES_PAGE_CODE).toContain("export default async function InvoicesPage()");
    expect(LOGIN_FORM_CODE).toContain("export function LoginForm({ next }: { next?: string })");
    expect(LOGIN_FORM_CODE).toContain("async function handleForceChange(event: FormEvent) {");
  });
});

/* ==========================================================================
   Roles ad-hoc: lo que queda, y por qué es legítimo
   ========================================================================== */
describe("facturación y login: no queda ningún portador de mensaje ad-hoc", () => {
  it("ningún mensaje conserva un rol escrito a mano fuera de la primitiva", () => {
    for (const [path, code] of MODULES) {
      // `destructive`/`warning` derivan el rol; el único rol explícito admitido
      // es el override polite pegado a la variante, que se pinea abajo.
      expect(handWrittenMessageRoles(code), `role de mensaje en ${path}`).toEqual([]);
      // Ni un `role="alert"` asertivo suelto: los asertivos los pone la
      // variante, no la vista.
      expect(code, `role="alert" en ${path}`).not.toMatch(/role="alert"/);
    }
  });

  it("en facturación no queda ni un rol condicional: la decisión pasó a la primitiva", () => {
    // El marcado elegía el rol según el origen del aviso
    // (`role={blockNotice ? "alert" : "status"}`). Ese ternario se fue: la
    // variante dice el tono y el único override escrito a mano es el polite.
    expect(INVOICES_CLIENT_CODE).not.toMatch(/role=\{/);
  });

  it("los seis roles que quedan en el cliente están justificados: dos `group` y cuatro overrides", () => {
    // La guarda es enumerativa a propósito: un séptimo rol, o un tercer `group`
    // sin `aria-label`, no tiene excusa y rompe el conteo.
    expect(adHocRoles(INVOICES_CLIENT_CODE), "roles escritos a mano").toHaveLength(6);
    // Cuatro son el override DELIBERADO del estado derivado en vivo: los tres
    // del bloqueo de caja y el recargo del cobro en edición (carry-over del
    // lote 6).
    expect(alertsWithExplicitStatusRole(INVOICES_CLIENT_CODE)).toBe(4);
    // Los otros dos son ARIA ESTRUCTURAL de una agrupación de botones.
    expect([...INVOICES_CLIENT_CODE.matchAll(/role="group"/g)]).toHaveLength(2);
    expect(INVOICES_CLIENT_CODE).toMatch(/role="group"\s+aria-label=\{props\.ariaLabel\}/);
    expect(INVOICES_CLIENT_CODE).toMatch(/role="group" aria-label="Tipo de ítem"/);
  });

  it("la página y el login no tienen un solo `role=` escrito a mano", () => {
    expect(adHocRoles(INVOICES_PAGE_CODE), "role= en app/invoices/page.tsx").toEqual([]);
    expect(adHocRoles(LOGIN_FORM_CODE), "role= en app/login/login-form.tsx").toEqual([]);
  });

  it("los dos esqueletos de carga quedan intactos: su `role=\"status\"` es del esqueleto", () => {
    // No son mensajes ad-hoc: anuncian que la pantalla todavía está cargando.
    // Están FUERA de los tres archivos de esta unidad y por eso el detector no
    // los ve; se leen igual para que nadie los confunda con el defecto.
    const loadingFiles = [
      join(APP_ROOT, "app", "invoices", "loading.tsx"),
      join(APP_ROOT, "app", "login", "loading.tsx"),
    ];
    for (const path of loadingFiles) {
      const code = stripComments(readFileSync(path, "utf8"));
      expect(code, path).toMatch(/role="status"/);
      expect(code, path).toContain("Cargando…");
      // Siguen siendo esqueletos, no mensajes de error o de éxito.
      expect(code, path).not.toContain("<Alert");
    }
  });
});

/* ==========================================================================
   Las tres superficies: lo efímero va por el toast (evento)
   ========================================================================== */
describe("facturación: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(INVOICES_CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    // El Toaster ya está montado una sola vez en app/layout.tsx (ui-feedback.test.ts).
    expect(INVOICES_CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it("los cinco eventos de facturación salen por el canal efímero", () => {
    // Las cinco llamadas: edición guardada, emisión, anulación, cobro y pago de
    // comisión. Cuatro arman la copia con un ternario, así que el literal no
    // comparte renglón con `toast.success(`; se afirma el enunciado completo.
    const eventos: string[] = [
      "actualizada (nuevo total",
      "actualizada (total intacto",
      "status.toLowerCase()",
      "anulada (stock revertido).",
      '"Cobro completo: factura pagada."',
      "Porción registrada. Saldo:",
      '"Comisión pagada desde la caja del turno."',
      "comisiones pagadas desde la caja del turno.",
    ];
    for (const text of eventos) {
      expect(toastWraps(INVOICES_CLIENT_CODE, text), text).toBe(true);
    }
    // Y no hay llamadas de más: si alguien dejara un evento por estado, el
    // conteo de abajo seguiría cuadrando pero el literal de la lista no tendría
    // su `toast.success(` y fallaría arriba.
    expect([...INVOICES_CLIENT_CODE.matchAll(/toast\.success\(/g)]).toHaveLength(5);
    expect([...INVOICES_CLIENT_CODE.matchAll(/toast\./g)]).toHaveLength(5);
  });

  it("el aviso de éxito dejó de ser estado: ya no hay `notice` ni setNotice", () => {
    // El estado `notice` y sus tres resets se retiran con el último `<p>`; la
    // mención que queda en el código está en un comentario que explica el
    // cambio, y el stripper la deja fuera.
    expect(INVOICES_CLIENT_CODE).not.toMatch(/setNotice/);
    expect(INVOICES_CLIENT_CODE).not.toMatch(/\bnotice\b/);
    // Las clases del estado de éxito/error quedaron sin consumidor.
    expect(INVOICES_CLIENT_CODE).not.toMatch(/okClass/);
    expect(INVOICES_CLIENT_CODE).not.toMatch(/errorClass/);
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    for (const [path, code] of MODULES) {
      expect(code, `${path}: toast de fallo`).not.toMatch(/toast\.(error|warning|info)\(/);
    }
  });

  it("el login no tiene eventos: sus dos mensajes son fallos confirmados", () => {
    // Decisión deliberada de esta unidad: no hay nada que "acaba de pasar" en
    // login-form.tsx —el cambio de clave exitoso reemplaza la pantalla entera,
    // no es un aviso—, así que no importa el canal efímero. Si alguien metiera
    // un toast acá, lo más probable es que esté corriendo un fallo al canal de
    // los eventos, y esta guarda lo delata.
    expect(LOGIN_FORM_CODE).not.toMatch(/\btoast\b/);
    expect(LOGIN_FORM_CODE).not.toMatch(SONNER_TOAST_IMPORT);
  });

  it("la página es Server Component: no tiene eventos y no puede importar toast", () => {
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(INVOICES_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(INVOICES_PAGE_CODE).not.toMatch(SONNER_TOAST_IMPORT);
    expect(INVOICES_PAGE_CODE).not.toMatch(/\btoast\b/);
  });
});

/* ==========================================================================
   Las tres superficies: lo persistente va por Alert (estado)
   ========================================================================== */
describe("facturación y login: lo persistente va por Alert (estado)", () => {
  it("el cliente tiene once Alert, todos de aviso o de error", () => {
    // Siete destructivos (el error compartido arriba del listado y dentro de cada
    // formulario, más la validación de edición, la del ítem, la del pago de
    // comisión y el recargo del cobro en edición del carry-over del lote 6) y
    // cuatro de aviso (las dos caras del bloqueo de caja, en el formulario de
    // emisión, el encabezado y el detalle). Si apareciera un Alert de más, o
    // alguien cambiara una variante, el conteo lo delata.
    expect(INVOICES_CLIENT_CODE).toMatch(ALERT_IMPORT);
    expect(alertOpenerCount(INVOICES_CLIENT_CODE)).toBe(11);
    expect(alertsWithVariant(INVOICES_CLIENT_CODE, "destructive")).toBe(7);
    expect(alertsWithVariant(INVOICES_CLIENT_CODE, "warning")).toBe(4);
    // Ni `info` ni `success` como `Alert`: nada se confirma por estado (eso es
    // evento y va por toast) y no hay datos de color neutro que anunciar.
    expect(INVOICES_CLIENT_CODE).not.toMatch(/<Alert\s+variant="info"/);
    expect(INVOICES_CLIENT_CODE).not.toMatch(/<Alert\s+variant="success"/);
  });

  it("el error compartido es estado: Alert destructivo arriba del listado y dentro de cada formulario", () => {
    // El mismo `error` se muestra en tres sitios: la vista de fondo (arriba,
    // después de la Card), el formulario de emisión y las operaciones del
    // detalle. Todos asertivos por la variante.
    expect(INVOICES_CLIENT_CODE).toMatch(/<Alert variant="destructive">\{error\}<\/Alert>/);
    // Dos de los tres comparten renglón; el del detalle lleva su margen.
    expect(linesWith(INVOICES_CLIENT_CODE, '<Alert variant="destructive">{error}</Alert>')).toHaveLength(2);
    expect(linesWith(INVOICES_CLIENT_CODE, '<Alert variant="destructive" className="mt-2">')).toHaveLength(1);
    expect(linesWith(INVOICES_CLIENT_CODE, "{error}")).toHaveLength(3);
    // Ninguno quedó como `<p>` con la clase de error suelta.
    expect(INVOICES_CLIENT_CODE).not.toMatch(/<p role="alert"/);
    expect(INVOICES_CLIENT_CODE).not.toMatch(/<p role="status"/);
  });

  it("las tres validaciones restantes son el mismo estado destructivo", () => {
    // Edición, ítem y comisión: el fallo confirmado conserva el aviso al lado
    // del formulario que lo produjo.
    for (const text of ["{editError}", "{itemError}", "{commissionError}"]) {
      const lines = linesWith(INVOICES_CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).toMatch(/<Alert variant="destructive">/);
    }
    // Los textos que los alimentan salen del estado, no del marcado: se afirma
    // el enunciado (dos de ellos arman la copia en un ternario dentro del
    // setter) y no solo el renglón del literal.
    const validaciones: Array<[string, string]> = [
      ['"Agregue al menos un ítem a la factura."', "setError("],
      ['"Indique el motivo de anulación."', "setError("],
      ['"Elija el producto."', "setItemError("],
      ['"Cantidad inválida."', "setItemError("],
      ['"No se pudo pagar la comisión."', "setCommissionError("],
    ];
    for (const [copy, setter] of validaciones) {
      const lines = linesWith(INVOICES_CLIENT_CODE, copy);
      expect(lines, copy).toHaveLength(1);
      expect(statementWraps(INVOICES_CLIENT_CODE, copy, setter), copy).toBe(true);
    }
  });

  it("el bloqueo de caja derivado en vivo conserva la presentación pero anuncia polite", () => {
    // ESTADO DERIVADO EN VIVO: `shiftBlockReason` no es el desenlace de una
    // acción enviada —es el estado del turno mientras nadie lo abra—, así que
    // los tres sitios donde se muestra pasan `role="status"` explícito. Es la
    // distinción que el marcado ya hacía con
    // `role={blockNotice ? "alert" : "status"}`, ahora con una sola ARIA por
    // clase de mensaje: el mismo tratamiento que nómina e inventario.
    const sitios = [
      /<Alert variant="warning" role="status">\s*\{shiftBlockReason\}\s*<\/Alert>/,
      /<Alert variant="warning" role="status" className="mt-3">\s*\{shiftBlockReason\}\s*<\/Alert>/,
      /<Alert variant="warning" role="status" className="mt-2">\s*\{shiftBlockReason\}\s*<\/Alert>/,
    ];
    for (const sitio of sitios) {
      expect(INVOICES_CLIENT_CODE, String(sitio)).toMatch(sitio);
    }
    // CONTROL NEGATIVO: el override no se aplicó en bloque. De los siete fallos
    // destructivos, seis quedan sin rol explícito —o sea asertivos— y solo el
    // aviso derivado en vivo del recargo (carry-over del lote 6) lleva el
    // polite: si alguien pasara `role="status"` a todos, el conteo pasaría de 1
    // a 7 y fallaría.
    expect([...INVOICES_CLIENT_CODE.matchAll(/<Alert variant="destructive" role="status"/g)]).toHaveLength(1);
    expect(alertsWithExplicitStatusRole(INVOICES_CLIENT_CODE)).toBe(4);
  });

  it("el clic que la guarda frena es un estado confirmado y sigue asertivo", () => {
    // `blockNotice` lo pone `passShiftGate()` cuando el usuario hizo clic y la
    // puerta de caja se cerró. Es el mismo texto que el estado derivado, pero
    // acá el clic YA ocurrió: `warning` deriva `alert` (asertivo) y NO lleva el
    // override polite.
    expect(INVOICES_CLIENT_CODE).toMatch(
      /<Alert variant="warning" className="mt-3">\s*\{blockNotice\}\s*<\/Alert>/,
    );
    expect(INVOICES_CLIENT_CODE).toMatch(/setBlockNotice\(shiftBlockReason\)/);
    expect(linesWith(INVOICES_CLIENT_CODE, "{blockNotice}")).toHaveLength(1);
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(INVOICES_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(INVOICES_PAGE_CODE).toMatch(
      /<Alert variant="destructive">El usuario no tiene sede asignada\.<\/Alert>/,
    );
    expect(alertsWithVariant(INVOICES_PAGE_CODE, "destructive")).toBe(1);
    expect(alertsWithExplicitStatusRole(INVOICES_PAGE_CODE)).toBe(0);
  });

  it("el login decide: dos fallos confirmados, el paso AUTH-01 y una pista derivada", () => {
    // La decisión explícita de esta unidad, actualizada (WU7). Los dos fallos
    // no son avisos derivados en vivo: el formulario no valida el envío
    // mientras se teclea —la presencia de documento y clave la frena el
    // navegador con `required`— y el texto solo existe después de enviar. Es
    // el desenlace de una acción enviada, así que `destructive` conserva el
    // mismo anuncio asertivo que el `role="alert"` escribía a mano.
    expect(LOGIN_FORM_CODE).toMatch(ALERT_IMPORT);
    // Cuatro Alert: los dos fallos confirmados (destructive), el paso AUTH-01
    // (warning) y la pista de requisitos (info). Antes de WU7 eran dos: el
    // paso AUTH-01 era una sección ámbar a mano sin Alert y la pista no
    // existía. Si aparece un Alert de más, el conteo lo delata.
    expect(alertOpenerCount(LOGIN_FORM_CODE)).toBe(4);
    expect(alertsWithVariant(LOGIN_FORM_CODE, "destructive")).toBe(2);
    // El panel ámbar a mano (§9: estilos fuera de la primitiva) se migró a la
    // variante canónica `warning`: antes de WU7 este conteo era 0 y el par
    // bg-warning-light + text-warning se escribía a mano.
    expect(alertsWithVariant(LOGIN_FORM_CODE, "warning")).toBe(1);
    // El canal derivado en vivo es SEPARADO de los dos fallos confirmados y
    // único: una sola pista, con la variante neutra de marca (info).
    expect(alertsWithVariant(LOGIN_FORM_CODE, "info")).toBe(1);
    // El override polite escrito a mano sigue en CERO —también para el canal
    // derivado—: `info` ya deriva `role="status"` en la primitiva, así que
    // escribirlo sería redundante y no es una decisión. La guarda PISA que el
    // archivo no acumule overrides por inercia: si mañana un canal nuevo
    // necesita un rol explícito, tiene que venir con su justificación aquí.
    expect(alertsWithExplicitStatusRole(LOGIN_FORM_CODE)).toBe(0);
    // La pista se DERIVA de `nueva` y solo existe cuando hay algo que decir:
    // es `null` con el campo vacío y el `<Alert` que la muestra queda
    // condicionado (criterio VACÍO: no se anuncia lo que no existe).
    expect(LOGIN_FORM_CODE).toMatch(/const nuevaFeed: string \| null =/);
    // VACÍO pineado con dientes: con el campo vacío la señal es `null` (nada
    // que decir, nada que anunciar). Sin este ancla, `? "siempre visible"`
    // pasaba la guarda y el hint se anunciaba en la pantalla inicial vacía.
    expect(LOGIN_FORM_CODE).toMatch(/nueva\.length === 0\s*\?\s*null/);
    expect(LOGIN_FORM_CODE).toMatch(/\{nuevaFeed \? \(/);
    // La pista no bloquea el envío (es un HINT; la validación real es el Zod
    // del servidor): ni el botón ni el handler la consultan.
    expect(LOGIN_FORM_CODE, "pista bloqueando el botón").not.toMatch(/disabled=\{[^}]*nueva/);
    const handlerStart = LOGIN_FORM_CODE.indexOf("async function handleForceChange");
    const handlerBody = LOGIN_FORM_CODE.slice(handlerStart, LOGIN_FORM_CODE.indexOf("if (step === \"done\")"));
    expect(handlerBody, "pista bloqueando el envío").not.toContain("nuevaRulesOk");
    expect(handlerBody, "pista bloqueando el envío").not.toContain("nuevaFeed");
    // Las dos copias fijas siguen ahí, y las dos salen del mismo estado `error`.
    for (const copy of ['"Documento o clave inválidos."', '"La confirmación no coincide."', '"No se pudo cambiar la clave."']) {
      const lines = linesWith(LOGIN_FORM_CODE, copy);
      expect(lines, copy).toHaveLength(1);
      expect(lines[0], copy).toMatch(/setError\(/);
    }
    // Sin validación por tecleo del ERROR: ningún `onChange` lo toca. La pista
    // de arriba es otro canal (se pina condicional y polito, no por `error`).
    for (const line of LOGIN_FORM_CODE.split("\n").filter((l) => l.includes("setError("))) {
      expect(line, line).not.toMatch(/onChange/);
    }
  });

  it("los tres campos de clave conservan sus atributos de registro y su toggle", () => {
    // Toggle de visibilidad en los TRES campos (login, nueva, confirmar):
    // un solo helper, tres llamadas. El `{` ancla a las LLAMADAS (`{passwordToggle(`)
    // y deja fuera la definición (`function passwordToggle(`): sin el ancla el
    // conteo daba 4 en código sano y la guarda fallaba sin haber defecto.
    // Si alguien borra un toggle, el conteo lo delata; los iconos van
    // `aria-hidden` y el nombre accesible viene
    // del `aria-label` del botón (con `aria-pressed` para el estado).
    expect([...LOGIN_FORM_CODE.matchAll(/\{passwordToggle\(show/g)]).toHaveLength(3);
    expect(LOGIN_FORM_CODE).toMatch(/aria-pressed=\{show\}/);
    expect(LOGIN_FORM_CODE).toMatch(/aria-hidden="true"/);
    expect(LOGIN_FORM_CODE).toMatch(/import \{ Eye, EyeOff \} from "lucide-react"/);
    // Atributos de registro intactos (el spec e2e de Playwright pina los dos
    // `required` del paso login; acá se asegura a nivel fuente).
    expect([...LOGIN_FORM_CODE.matchAll(/\brequired\b/g)]).toHaveLength(2);
    expect([...LOGIN_FORM_CODE.matchAll(/autoComplete="new-password"/g)]).toHaveLength(2);
    expect(LOGIN_FORM_CODE).toContain('autoComplete="current-password"');
    expect(LOGIN_FORM_CODE).toContain('autoComplete="username"');
    // La pista habla de los requisitos EXACTOS del servidor (no inveta uno).
    expect(LOGIN_FORM_CODE).toContain("8+ caracteres, letra y número");
    expect(LOGIN_FORM_CODE).toMatch(/nueva\.length >= 8 && \/\[A-Za-z\]\/\.test\(nueva\) && \/\[0-9\]\/\.test\(nueva\)/);
  });
});

/* ==========================================================================
   El texto visible no cambió (cambia el canal, no la copia)
   ========================================================================== */
describe("facturación y login: el texto visible no cambió", () => {
  it("las copias de las tres superficies siguen ahí, palabra por palabra", () => {
    const copias: string[] = [
      "Factura #${result.data.invoice.consecutive_number} actualizada (nuevo total",
      "Factura #${result.data.invoice.consecutive_number} actualizada (total intacto",
      "Factura #${result.data.invoice.consecutive_number} ${result.data.invoice.status.toLowerCase()}.",
      "Factura #${result.data.invoice.consecutive_number} anulada (stock revertido).",
      "Cobro completo: factura pagada.",
      "Porción registrada. Saldo: ${formatMoney(result.data.remaining)}.",
      "Comisión pagada desde la caja del turno.",
      "comisiones pagadas desde la caja del turno.",
      "No hay caja abierta: abre tu turno para emitir o editar.",
      "La caja abierta es de otro turno: solo quien abrió el turno o un administrador puede emitir o editar.",
      "Agregue al menos un ítem a la factura.",
      "Descuento inválido.",
      "Indique el motivo de anulación.",
      "Monto de la porción inválido.",
      "Las porciones de pago deben ser mayores a 0.",
      "Elija el producto.",
      "Elija el servicio.",
      "Describa el ítem personalizado.",
      "Elija el empleado que atiende.",
      "Cantidad inválida.",
      "Precio inválido.",
      "Indique el valor de la comisión.",
      "Indique el porcentaje para este ítem.",
      "No se pudo pagar la comisión.",
      "No se pudieron calcular las comisiones pendientes.",
      "Sin facturas para estos filtros.",
      "Sin ítems. Agregue al menos uno para emitir.",
      "Sin impuestos.",
      "Sin cobro registrado (Emitida).",
    ];
    for (const text of copias) {
      expect(INVOICES_CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(INVOICES_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(INVOICES_PAGE_CODE, "página: encabezado").toContain("Facturas, impuestos y cobros.");
    for (const text of [
      "Documento o clave inválidos.",
      "La confirmación no coincide.",
      "No se pudo cambiar la clave.",
      "Su clave inicial es su número de documento. Debe cambiarla antes de continuar (AUTH-01).",
    ]) {
      expect(LOGIN_FORM_CODE, `login: ${text}`).toContain(text);
    }
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(INVOICES_CLIENT_CODE).not.toContain("Factura emitida.");
    expect(INVOICES_CLIENT_CODE).not.toContain("El cobro se registró.");
    expect(INVOICES_CLIENT_CODE).not.toContain("Sin facturas registradas.");
    expect(INVOICES_PAGE_CODE).not.toContain("Sin sede asignada.");
    expect(LOGIN_FORM_CODE).not.toContain("Credenciales incorrectas.");
    expect(LOGIN_FORM_CODE).not.toContain("Las claves no coinciden.");
  });

  it("los cuatro vacíos del cliente siguen siendo texto plano, no avisos", () => {
    // Describen el estado base, no bloquean nada y nunca anunciaron nada (no
    // tenían rol): siguen en su clase de texto y NO se envuelven en `Alert`
    // —envolverlos AGREGARÍA el anuncio que hoy no existe—. Queda pineado.
    const vacios: Array<[string, string, string]> = [
      // Los tres de la hoja pasaron a `text-paper-ink-muted` (WU5): mismo color, #62748e en claro y oscuro.
      ["Sin facturas para estos filtros.", "li", "px-3 py-4 text-sm text-text-secondary"],
      ["Sin ítems. Agregue al menos uno para emitir.", "td", "px-3 py-4 text-center text-sm text-paper-ink-muted"],
      ["Sin impuestos.", "li", "text-paper-ink-muted"],
      ["Sin cobro registrado (Emitida).", "li", "text-paper-ink-muted"],
    ];
    for (const [text, opener, style] of vacios) {
      expect(plainTextBlock(INVOICES_CLIENT_CODE, text, `<${opener}`), text).toContain(style);
    }
  });

  it("el texto de la pantalla de clave cambiada sigue siendo contenido, no un aviso", () => {
    // El paso "done" reemplaza la pantalla entera: es el CONTENIDO, no un
    // mensaje que aparezca y se vaya. Nunca llevó rol y no se envuelve en
    // `Alert` ni se convierte en toast; queda pineado para que no se toque por
    // inercia.
    expect(plainTextBlock(LOGIN_FORM_CODE, "Ya puede operar con su nueva clave.", "<p")).toContain(
      "text-text-secondary",
    );
    expect(LOGIN_FORM_CODE).toContain("Clave actualizada");
  });
});

/* ==========================================================================
   Carry-over del lote 6: el recargo del cobro en edición (derivado en vivo)
   ========================================================================== */
describe("facturación: el recargo del cobro en edición es estado derivado en vivo", () => {
  it("el aviso sin rol pasó a ser `Alert` destructivo con override polite", () => {
    // `feeOk` se calcula del método elegido mientras el usuario edita el cobro
    // (`feePct === payment.fee_percent`), no es el desenlace de una acción
    // enviada, y bloquea el guardado. Es el MISMO caso que los tres avisos del
    // turno de arriba: `role="status"` explícito (polite) para no interrumpir a
    // quien está eligiendo.
    expect(INVOICES_CLIENT_CODE).toMatch(/const feeOk = feePct === Number\(payment\.fee_percent \?\? 0\);/);
    expect(INVOICES_CLIENT_CODE).toMatch(
      /<Alert variant="destructive" role="status" className="text-xs">\s*Cambia el recargo: el total no cuadraría\.\s*<\/Alert>/,
    );
    // La copia es la misma y el `text-xs` se conservó: el aviso va pegado al
    // campo, no como bloque de página.
    expect(INVOICES_CLIENT_CODE).toContain("Cambia el recargo: el total no cuadraría.");
    // El `<p>` crudo con la clase de rojo suelta ya no existe.
    expect(INVOICES_CLIENT_CODE).not.toContain("text-xs font-medium text-red-700");
  });

  it("control negativo: no se aplicó en bloque ni se perdió el aviso", () => {
    // Si el aviso desapareciera, el bloqueo del recargo quedaría mudo.
    expect(INVOICES_CLIENT_CODE).toMatch(/\{!feeOk && \(/);
    // Y no se reescribió la copia.
    expect(INVOICES_CLIENT_CODE).not.toContain("Cambia el recargo: el total cuadraría.");
    expect(INVOICES_CLIENT_CODE).not.toContain("El recargo no coincide.");
    // Ni se le pasó el override polite a los fallos confirmados: solo hay UN
    // destructivo con `role="status"` en todo el cliente, y es este.
    expect([...INVOICES_CLIENT_CODE.matchAll(/<Alert variant="destructive" role="status"/g)]).toHaveLength(1);
    expect(alertsWithVariant(INVOICES_CLIENT_CODE, "destructive")).toBe(7);
  });
});
