import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en el panel admin (WU-C, lote 4).

   Es el MISMO criterio que ya verificaron `services` (WU-B), `alertas`, `vales`
   y `nómina` (lote 2) e `inventario` (lote 3), aplicado a la última tanda de
   mensajes ad-hoc: `app/admin/page.tsx` y las seis secciones de
   `app/admin/admin-sections/`. Cada mensaje era un `<p role="status">` o
   `role="alert"` inline y PERSISTENTE, así que "Base actualizada." se quedaba en
   pantalla para siempre compitiendo con lo que sí importa.

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", "Indique la nueva base."): inline, persistente,
                al lado de la cosa -> `Alert`, que deriva el rol ARIA de la
                variante (`destructive` -> asertivo, el mismo anuncio que el
                marcado escribía a mano).
   - EVENTO  -> lo que acaba de pasar ("Base actualizada.", "Usuario creado con
                su rol."): efímero -> `toast`.
   - VACÍO   -> el estado base de una lista o tabla ("Aún no hay usuarios en
                esta sede."): describe lo esperado, NO bloquea nada y NUNCA
                anunció nada. Los cuatro vacíos de `taxes`, `methods` y `cash`
                migraron a `EmptyState`, que sigue siendo texto apagado y NO
                lleva `role` ni `aria-live`: envolverlo en `Alert` AGREGARÍA un
                anuncio que hoy no existe. Queda comentado y pineado.

   DÓNDE SE PINTA EL ESTADO DE UN FALLO AL GUARDAR. El criterio de arriba no
   cambió; cambió dónde se ve, porque el alta de impuestos, métodos y
   denominaciones migró de un formulario pegado a la lista a un `FormDialog`
   (estándar §1). El `Alert` que la sección pintaba a mano lo muestra ahora el
   DIÁLOGO, adentro, y la sección no se inventa un segundo aviso. Por eso la
   guarda dejó de contar `<Alert>` y cuenta CANALES: un canal por estado de
   fallo —inline o del diálogo— y nunca los dos, que era el "un hecho, un
   canal" de §1 medido sobre el estado que lo anuncia.
   - DERIVADO EN VIVO -> un aviso que se CALCULA del formulario mientras el
                usuario escribe, no el desenlace de una acción enviada: conserva
                la presentación `Alert` pero pasa `role="status"` explícito
                (polite). En el panel hoy NO hay ninguno; se pinea el hecho, no
                se inventa el caso.

   Un hecho, un canal: nada se anuncia por los dos.

   Offline y sin DOM (`vitest.config.ts` corre `environment: "node"`): lee los
   archivos reales —igual que services-feedback.test.ts y los lotes 2 y 3— y
   afirma el criterio sobre el texto del código. No hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

const ADMIN_PAGE_PATH = join(APP_ROOT, "app", "admin", "page.tsx");
const SECTION_DIR = join(APP_ROOT, "app", "admin", "admin-sections");

const ADMIN_PAGE_TSX = readFileSync(ADMIN_PAGE_PATH, "utf8");
const CASH_TSX = readFileSync(join(SECTION_DIR, "cash-section.tsx"), "utf8");
const EMPLOYEES_TSX = readFileSync(join(SECTION_DIR, "employees-section.tsx"), "utf8");
const METHODS_TSX = readFileSync(join(SECTION_DIR, "methods-section.tsx"), "utf8");
const TAXES_TSX = readFileSync(join(SECTION_DIR, "taxes-section.tsx"), "utf8");
const USERS_TSX = readFileSync(join(SECTION_DIR, "users-section.tsx"), "utf8");
const VALES_TSX = readFileSync(join(SECTION_DIR, "vales-section.tsx"), "utf8");

/**
 * Código sin comentarios: un `role="alert"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo stripper que el resto de la serie.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const ADMIN_PAGE_CODE = stripComments(ADMIN_PAGE_TSX);
const CASH_CODE = stripComments(CASH_TSX);
const EMPLOYEES_CODE = stripComments(EMPLOYEES_TSX);
const METHODS_CODE = stripComments(METHODS_TSX);
const TAXES_CODE = stripComments(TAXES_TSX);
const USERS_CODE = stripComments(USERS_TSX);
const VALES_CODE = stripComments(VALES_TSX);

/**
 * Las siete superficies de esta unidad. Ojo: `app/admin/admin-tabs.tsx` NO está
 * en la lista y por eso no entra en las guardas de rol — sus `role="tablist"` y
 * `role="tab"` son ARIA ESTRUCTURAL legítima de un tablist, no mensajes
 * ad-hoc, y esta unidad no lo toca.
 */
const MODULES: Array<[string, string]> = [
  ["app/admin/page.tsx", ADMIN_PAGE_CODE],
  ["app/admin/admin-sections/cash-section.tsx", CASH_CODE],
  ["app/admin/admin-sections/employees-section.tsx", EMPLOYEES_CODE],
  ["app/admin/admin-sections/methods-section.tsx", METHODS_CODE],
  ["app/admin/admin-sections/taxes-section.tsx", TAXES_CODE],
  ["app/admin/admin-sections/users-section.tsx", USERS_CODE],
  ["app/admin/admin-sections/vales-section.tsx", VALES_CODE],
];

/**
 * Roles ad-hoc: el ATRIBUTO `role` escrito a mano en el JSX (`role="status"` o
 * `role={...}`). Los roles de estas vistas los pone la primitiva (`Alert` los
 * deriva de la variante), no la vista.
 *
 * Dos precisiones que el panel obligó a agregar sobre el detector del resto de
 * la serie (`\brole\s*=`):
 *  - el valor tiene que arrancar con comilla o llave, para no confundir el
 *    atributo con una variable local llamada `role` (`const role =
 *    selected[row.id] ?? null` en usuarios, que elige el rol de la fila);
 *  - y la aparición no puede venir precedida de `const`/`let`/`var`, para no
 *    confundirla con una declaración con inicializador entre comillas.
 * Sin esas dos precisiones el panel daría un falso positivo; con ellas sigue
 * cazando las dos formas reales (rol fijo y rol condicional).
 */
const AD_HOC_ROLE = /\brole\s*=\s*["'{]/g;

function adHocRoles(source: string): string[] {
  return [...source.matchAll(AD_HOC_ROLE)]
    .filter((match) => {
      const declaration = source.slice(0, match.index).match(/(\w+)\s*$/);
      return !(declaration && ["const", "let", "var"].includes(declaration[1]));
    })
    .map((match) => match[0]);
}

/** Las líneas del código que mencionan un texto. */
function linesWith(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text));
}

/**
 * El bloque del placeholder vacío, desde la etiqueta que lo abre hasta el
 * texto. Sirve para los vacíos escritos en varias líneas (la clase va en la
 * apertura y el texto dos renglones abajo), donde `linesWith` no alcanza.
 *
 * Acepta las DOS formas que dejó la migración a `EmptyState`: el `<p …>` que
 * sigue escrito a mano y el `<EmptyState …>` del primitivo. Se elige la
 * apertura MÁS CERCANA al texto, y como `EmptyState` RENDERIZA un `<p>`, el
 * `<p>` anterior en el archivo siempre queda más lejos: el máximo de los dos
 * `lastIndexOf` da la apertura correcta en los dos casos. Lo que se afirma del
 * bloque es el mismo en los dos: el vacío NO se envuelve en `Alert`.
 */
function plainTextBlock(source: string, text: string): string {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const open = Math.max(
    source.lastIndexOf("<p", index),
    source.lastIndexOf("<EmptyState", index),
  );
  expect(open, `<p> o <EmptyState> de ${text}`).toBeGreaterThan(-1);
  const block = source.slice(open, index + text.length);
  expect(block, `${text} envuelto en Alert`).not.toContain("Alert");
  return block;
}

/**
 * Los ESTADOS DE FALLO declarados en el módulo: un `useState<string | null>`
 * cuyo nombre es el de un error. El nombre importa porque la misma forma la
 * tienen `editingId`, `busyId` y `confirmResetId`, que no son estados de
 * fallo; se distinguen por el sufijo, y ese sufijo es justo lo que el código
 * nuevo tuvo que dejar de asumir como siempre `error`.
 */
function errorStates(source: string): string[] {
  return [...source.matchAll(/const\s*\[\s*(\w*[Ee]rror\w*)\s*,\s*set\w+\s*\]\s*=\s*useState<string\s*\|\s*null>/g)]
    .map((match) => match[1]);
}

/**
 * Dónde se anuncia un estado de fallo: en un `Alert` inline de la sección, o
 * en la prop `error` de un `FormDialog` (que la pinta como
 * `Alert variant="destructive"` adentro — ver `tests/ux-dialog.test.ts`).
 *
 * Devuelve TODOS los canales que encuentra, no el primero: el invariante que
 * se afirma arriba es que hay exactamente uno, así que un segundo canal tiene
 * que poder verse.
 */
function errorChannels(source: string, state: string): string[] {
  const channels: string[] = [];
  if (new RegExp(`<Alert\\s+variant="destructive"[^>]*>\\s*\\{${state}\\}`).test(source)) {
    channels.push("Alert");
  }
  if (new RegExp(`error=\\{${state}\\}`).test(source)) {
    channels.push("FormDialog");
  }
  return channels;
}

/** Cuántos `Alert` abre el módulo (para que el conteo no se vuelva decorativo). */
function alertOpenerCount(source: string): number {
  return [...source.matchAll(/<Alert\b/g)].length;
}

/**
 * Cuántos `Alert` de esta variante abre el módulo. El detector está ANCLADO a
 * `<Alert`: el primer intento del lote anterior falló porque un
 * `variant="warning"` suelto matcheaba la etiqueta de un `Badge` de inventario
 * en vez de un aviso. Acá no hay `Badge`, pero el detector no depende de eso.
 */
function alertsWithVariant(source: string, variant: "destructive" | "warning"): number {
  const re = new RegExp(`<Alert\\s+variant="${variant}"`, "g");
  return [...source.matchAll(re)].length;
}

/**
 * ¿Cuántos `Alert` de aviso o error llevan el override `role="status"` escrito
 * a mano? Se exige que el atributo venga INMEDIATAMENTE después de la variante:
 * así un `role="status"` a 600 caracteres de distancia no pasa por vecino.
 */
function alertsWithExplicitStatusRole(source: string): number {
  return [...source.matchAll(/<Alert\s+variant="(?:destructive|warning)"\s+role="status"/g)].length;
}

const ALERT_IMPORT = /import\s*\{\s*Alert\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/alert["']/;
const FORM_DIALOG_MODULE = /from\s*["']@\/src\/components\/ui\/lib\/form-dialog["']/;
const EMPTY_STATE_MODULE = /from\s*["']@\/src\/components\/ui\/lib\/empty-state["']/;
const SONNER_TOAST_IMPORT = /import\s*\{\s*toast\s*\}\s*from\s*["']sonner["']/;

/* ==========================================================================
   El detector mismo (control negativo)
   ========================================================================== */
describe("detector del panel admin: no es un sello de goma", () => {
  it("marca las dos formas que el repositorio tenía escritas y respeta comentarios", () => {
    const fijo = `<p role="status">ok</p><div role="alert">err</div>`;
    const condicional = `<p role={message.kind === "error" ? "alert" : "status"}>x</p>`;
    expect(adHocRoles(fijo)).toHaveLength(2);
    expect(adHocRoles(condicional)).toHaveLength(1);
    // El stripper no borra código real: solo comentarios.
    expect(stripComments(fijo)).toBe(fijo);
    expect(adHocRoles(stripComments(`/* role="status" */ // role="alert"`))).toEqual([]);
  });

  it("el detector de `Alert` está anclado a `<Alert`: un Badge no cuenta", () => {
    // La regresión concreta del lote anterior: un `variant="warning"` suelto
    // matcheaba la etiqueta de un `Badge` en vez de un aviso.
    expect(alertsWithVariant('<Alert variant="warning">x</Alert>', "warning")).toBe(1);
    expect(alertsWithVariant('<Badge variant="warning">Bajo mínimo</Badge>', "warning")).toBe(0);
    expect(alertsWithVariant('<Alert variant="destructive">x</Alert>', "warning")).toBe(0);
    // El conteo de aperturas también exige la etiqueta completa.
    expect(alertOpenerCount('<Badge variant="warning">x</Badge>')).toBe(0);
    expect(alertOpenerCount('<Alert variant="destructive">x</Alert>')).toBe(1);
    // Y el override deliberado se detecta solo pegado a la variante.
    expect(alertsWithExplicitStatusRole('<Alert variant="destructive" role="status">x</Alert>')).toBe(1);
    expect(alertsWithExplicitStatusRole('<Alert variant="destructive">x</Alert>')).toBe(0);
  });

  it("el detector de roles distingue el atributo de una variable local llamada `role`", () => {
    // El panel tiene `const role = selected[row.id] ?? null` (usuarios): es una
    // variable, no ARIA. El detector exige comilla o llave después del `=`.
    expect(adHocRoles("const role = selected[row.id] ?? null;")).toEqual([]);
    expect(adHocRoles('role="status"')).toHaveLength(1);
    expect(adHocRoles("role={kind === 'error' ? 'alert' : 'status'}")).toHaveLength(1);
    expect(adHocRoles("const role = 'admin';")).toEqual([]);
  });

  it("el detector de canales acusa el error nuevo: un estado en dos canales, o en ninguno", () => {
    // Tras la migración a `FormDialog` el fallo posible ya no es "un segundo
    // `<Alert>`" sino dos cosas distintas: un estado pintado por la sección Y
    // pasado al diálogo (el mismo hecho dicho dos veces), y un estado que no
    // llega a ningún canal (un fallo que no se lee). El detector tiene que
    // ver las dos.
    const dosCanales = 'const [error, setError] = useState<string | null>(null);<FormDialog error={error} /><Alert variant="destructive">{error}</Alert>';
    expect(errorStates(dosCanales)).toEqual(["error"]);
    expect(errorChannels(dosCanales, "error")).toEqual(["Alert", "FormDialog"]);
    const sinCanal = "const [error, setError] = useState<string | null>(null);";
    expect(errorChannels(sinCanal, "error")).toEqual([]);
    // Y el estado que NO es de fallo no entra: `editingId` tiene la misma forma
    // de `useState` y no puede contarse como un canal de error.
    expect(
      errorStates("const [editingId, setEditingId] = useState<string | null>(null);const [busy, setBusy] = useState(false);"),
    ).toEqual([]);
  });

  it("los siete archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(ADMIN_PAGE_CODE.length, "admin/page.tsx").toBeGreaterThan(1_500);
    expect(CASH_CODE.length, "cash-section.tsx").toBeGreaterThan(4_000);
    expect(EMPLOYEES_CODE.length, "employees-section.tsx").toBeGreaterThan(14_000);
    expect(METHODS_CODE.length, "methods-section.tsx").toBeGreaterThan(3_500);
    expect(TAXES_CODE.length, "taxes-section.tsx").toBeGreaterThan(3_500);
    expect(USERS_CODE.length, "users-section.tsx").toBeGreaterThan(7_000);
    expect(VALES_CODE.length, "vales-section.tsx").toBeGreaterThan(11_000);
    // Anclas de contenido: confirman que leímos los archivos correctos.
    expect(ADMIN_PAGE_CODE).toContain("export default async function AdminPage");
    expect(CASH_CODE).toContain("export function CashSection");
    expect(EMPLOYEES_CODE).toContain("export function EmployeesSection");
    expect(METHODS_CODE).toContain("export function MethodsSection");
    expect(TAXES_CODE).toContain("export function TaxesSection");
    expect(USERS_CODE).toContain("export function UsersSection");
    expect(VALES_CODE).toContain("export function ValesSection");
  });

  it("el stripper es quien evita el falso positivo de los comentarios que explican el criterio", () => {
    // Los archivos crudos SÍ mencionan el rol: está en los comentarios que
    // explican por qué `destructive` deriva `role="alert"`. Si el stripper
    // dejara de funcionar, la guarda de "ningún rol ad-hoc" fallaría sola y este
    // test documenta por qué eso sería un falso positivo, no una regresión.
    const SECCIONES: Array<[string, string]> = [
      ["cash-section.tsx", CASH_TSX],
      ["employees-section.tsx", EMPLOYEES_TSX],
      ["methods-section.tsx", METHODS_TSX],
      ["taxes-section.tsx", TAXES_TSX],
      ["users-section.tsx", USERS_TSX],
      ["vales-section.tsx", VALES_TSX],
    ];
    // Las tres que aún escriben un Alert propio explican el criterio al lado
    // del markup, y por eso citan el rol en un comentario. `taxes`, `methods`
    // y `employees` ya NO escriben un Alert: quedó adentro de `FormDialog`, así
    // que la explicación del criterio vive en la primitiva y no en la sección
    // (el comentario de employees se fue con el Alert que explicaba).
    expect(
      SECCIONES.filter(([, raw]) => adHocRoles(raw).length > 0).map(([name]) => name),
      "secciones que citan el rol en comentarios",
    ).toEqual(["cash-section.tsx", "users-section.tsx", "vales-section.tsx"]);
    expect(adHocRoles(TAXES_TSX).length, "taxes-section.tsx crudo").toBe(0);
    expect(adHocRoles(CASH_TSX).length, "cash-section.tsx crudo").toBeGreaterThan(0);
    expect(adHocRoles(CASH_CODE), "cash-section.tsx sin comentarios").toEqual([]);
    // Y el stripper no borra código real: solo comentarios.
    expect(stripComments('<p role="status">ok</p>')).toBe('<p role="status">ok</p>');
  });

  it("no queda ningún rol ad-hoc en las siete superficies", () => {
    for (const [path, code] of MODULES) {
      expect(adHocRoles(code), `role= en ${path}`).toEqual([]);
    }
  });
});

/* ==========================================================================
   Admin: lo efímero va por el toast (evento)
   ========================================================================== */
describe("admin: lo efímero va por el toast (evento)", () => {
  it("las secciones con eventos importan el toast de sonner y NO montan un segundo Toaster", () => {
    for (const [path, code] of MODULES) {
      // La página es Server Component: no tiene eventos y por eso no importa toast.
      if (path === "app/admin/page.tsx") continue;
      expect(code, `${path}: import de toast`).toMatch(SONNER_TOAST_IMPORT);
      // El Toaster ya está montado una sola vez en app/layout.tsx.
      expect(code, `${path}: segundo Toaster`).not.toMatch(/<Toaster\b/);
    }
  });

  it("los diez textos de evento salen por el canal efímero", () => {
    // Se busca el literal ENTRE COMILLAS: es el texto que se le pasa al toast, y
    // así una copia larga que lo contenga por casualidad no cuenta como segunda
    // ocurrencia. El alta del empleado es la excepción estructural: arma el
    // texto con un ternario y un sufijo, así que se afirma el renglón del toast.
    const events: Array<[string, string]> = [
      [CASH_CODE, '"Base actualizada."'],
      [CASH_CODE, '"Denominación agregada."'],
      [CASH_CODE, '"Denominación actualizada."'],
      [CASH_CODE, '"Denominación eliminada."'],
      [METHODS_CODE, '"Método actualizado."'],
      [METHODS_CODE, '"Método creado."'],
      [TAXES_CODE, '"Impuesto actualizado."'],
      [TAXES_CODE, '"Impuesto creado."'],
      [USERS_CODE, "`Clave de ${row.full_name} restablecida a su documento; deberá cambiarla al entrar.`"],
      [USERS_CODE, "`Rol de ${row.full_name} actualizado.`"],
      [VALES_CODE, '"Configuración de vales actualizada."'],
      [EMPLOYEES_CODE, '"Empleado actualizado."'],
      [EMPLOYEES_CODE, '"Empleado creado."'],
    ];
    for (const [code, text] of events) {
      const lines = linesWith(code, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).toMatch(/toast\.success\(/);
    }
    // Los dos sufijos de la copia del alta siguen viajando con el evento.
    for (const suffix of [
      " El usuario ya existía y quedó vinculado.",
      " Usuario creado (clave inicial: su documento).",
    ]) {
      expect(EMPLOYEES_CODE, suffix).toContain(suffix);
    }
  });

  it("el aviso de éxito dejó de ser estado: ya no hay `notice` ni setNotice", () => {
    for (const [path, code] of MODULES) {
      expect(code, `${path}: setNotice`).not.toMatch(/setNotice/);
      expect(code, `${path}: notice`).not.toMatch(/\bnotice\b/);
    }
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    for (const [path, code] of MODULES) {
      expect(code, `${path}: toast de fallo`).not.toMatch(/toast\.(error|warning)\(/);
    }
  });

  it("la página servidor no tiene eventos: no importa toast ni puede", () => {
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(ADMIN_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(ADMIN_PAGE_CODE).not.toMatch(SONNER_TOAST_IMPORT);
    expect(ADMIN_PAGE_CODE).not.toMatch(/\btoast\b/);
  });
});

/* ==========================================================================
   Admin: lo persistente va por Alert (estado)
   ========================================================================== */
describe("admin: lo persistente va por Alert (estado)", () => {
  it("un canal por estado de fallo, y es el de estado: inline o el del diálogo", () => {
    // El invariante que sobrevive a la migración a `FormDialog`, medido sobre
    // el ESTADO que se anuncia y no sobre la etiqueta que lo pinta: cada estado
    // de fallo se anuncia por EXACTAMENTE un canal. Antes era "un Alert por
    // módulo"; ahora es "un canal por estado", que además delata el error
    // nuevo: un estado del diálogo pintado también como Alert en la sección
    // (dos canales para un hecho), o un estado sin ningún canal (un fallo que
    // no se lee).
    let estados = 0;
    for (const [path, code] of MODULES) {
      for (const state of errorStates(code)) {
        estados += 1;
        const channels = errorChannels(code, state);
        expect(channels, `${path}: ${state} se anuncia por ${channels.length} canales`).toHaveLength(1);
        // El canal del diálogo solo vale si el diálogo ES la primitiva: un
        // `error={x}` pasado a otra cosa no sería un estado de estado.
        if (channels[0] === "FormDialog") {
          expect(code, `${path}: ${state} por un form-dialog`).toMatch(FORM_DIALOG_MODULE);
          expect(code, `${path}: ${state} por un <FormDialog>`).toMatch(/<FormDialog\b/);
        }
      }
    }
    // Piso anti-vacío: si el detector dejara de encontrar estados, la guarda
    // de arriba pasaría sola. Son ocho: los seis módulos cliente declaran al
    // menos uno, y `cash-section.tsx` declara TRES (base, alta del diálogo y
    // acciones de fila) donde antes había uno solo compartido.
    expect(estados, "estados de fallo declarados").toBe(8);
  });

  it("las tres superficies que escriben su propio Alert lo hacen una sola vez y con ninguna otra variante", () => {
    // Las que NO migraron al diálogo: la página, usuarios y vales. `employees`
    // migró: su error de alta lo muestra el `FormDialog`, y esta cuenta (una
    // apertura, una variante) pasó a ser la guarda del grupo de abajo.
    // Aquí la cuenta de `<Alert` sigue siendo la guarda, sin cambios.
    const expected: Array<[string, string]> = [
      ["app/admin/page.tsx", ADMIN_PAGE_CODE],
      ["app/admin/admin-sections/users-section.tsx", USERS_CODE],
      ["app/admin/admin-sections/vales-section.tsx", VALES_CODE],
    ];
    for (const [path, code] of expected) {
      expect(code, `${path}: import de Alert`).toMatch(ALERT_IMPORT);
      expect(alertOpenerCount(code), `${path}: Alert`).toBe(1);
      expect(alertsWithVariant(code, "destructive"), `${path}: destructivo`).toBe(1);
      // Ninguna variante de aviso ni de éxito: no hay precondiciones pendientes
      // en el panel que merezcan `warning`, y nada se confirma por estado.
      expect(alertsWithVariant(code, "warning"), `${path}: warning`).toBe(0);
      expect(code, `${path}: info`).not.toMatch(/<Alert\s+variant="info"/);
      expect(code, `${path}: success`).not.toMatch(/<Alert\s+variant="success"/);
    }
  });

  it("impuestos, métodos y empleados: el error del alta lo muestra el diálogo, y la sección no escribe ninguno", () => {
    // Antes contaban UN Alert. Ahora cuentan CERO, y por eso la cuenta sola ya
    // no prueba nada: la afirmación fuerte es la positiva del cableado —
    // `error={error}` le llega al `FormDialog`— más la negativa de que la
    // sección conserve un segundo aviso del mismo estado.
    for (const [path, code] of [
      ["app/admin/admin-sections/methods-section.tsx", METHODS_CODE],
      ["app/admin/admin-sections/taxes-section.tsx", TAXES_CODE],
      ["app/admin/admin-sections/employees-section.tsx", EMPLOYEES_CODE],
    ] as Array<[string, string]>) {
      expect(code, `${path}: sin Alert propio`).not.toMatch(ALERT_IMPORT);
      expect(alertOpenerCount(code), `${path}: Alert`).toBe(0);
      expect(alertsWithVariant(code, "destructive"), `${path}: destructivo`).toBe(0);
      expect(code, `${path}: el error va al FormDialog`).toMatch(
        /<FormDialog\b[\s\S]*?\berror=\{error\}/,
      );
      expect(code, `${path}: el formulario inline ya no está`).not.toMatch(/<form\b/);
    }
  });

  it("caja: tres superficies de acción y tres canales, ninguno compartido", () => {
    // La base es un ajuste POR FILA (inline, con su `Alert` al lado); el alta
    // es un formulario (diálogo, con su error adentro); activar/desactivar y la
    // baja confirmada son de fila (inline, con el `Alert` de la lista). Los dos
    // `Alert` que quedan están cada uno atado a UN estado, y el tercero al
    // diálogo: por eso la cuenta es 2 y no 1, y por eso se afirma cada atadura.
    expect(CASH_CODE, "import de Alert").toMatch(ALERT_IMPORT);
    expect(alertOpenerCount(CASH_CODE), "Alert").toBe(2);
    expect(alertsWithVariant(CASH_CODE, "destructive"), "destructivo").toBe(2);
    expect(alertsWithVariant(CASH_CODE, "warning"), "warning").toBe(0);
    expect(CASH_CODE).toMatch(/<Alert\s+variant="destructive"[^>]*>\s*\{baseError\}\s*<\/Alert>/);
    expect(CASH_CODE).toMatch(
      /<Alert\s+variant="destructive"[^>]*>\s*\{denominationError\}\s*<\/Alert>/,
    );
    expect(CASH_CODE, "el error del alta va al FormDialog").toMatch(
      /<FormDialog\b[\s\S]*?\berror=\{addError\}/,
    );
    // La baja es destructiva e irreversible: la fila NO la dispara, solo abre
    // la confirmación, y el `delete` queda detrás del `onConfirm` del diálogo.
    // Antes era un segundo clic en `Eliminar`, sin preguntar nada.
    expect(CASH_CODE, "la baja se dispara desde un click de la fila").not.toMatch(
      /onClick=\{[^}]*removeDenomination/,
    );
    expect(CASH_CODE, "la fila abre la confirmación").toMatch(/onClick=\{\(\) => openDelete\(/);
    const onConfirm = CASH_CODE.indexOf("onConfirm={");
    expect(onConfirm, "ConfirmDialog sin onConfirm").toBeGreaterThan(-1);
    expect(
      CASH_CODE.slice(onConfirm, CASH_CODE.indexOf("/>", onConfirm)),
      "el onConfirm no borra la denominación",
    ).toContain("removeDenomination(");
    // Y la baja se llama en UN solo lugar: si alguien la cablea también en la
    // fila, el conteo sube y esta guarda lo delata.
    expect(CASH_CODE.match(/removeDenomination\(/g) ?? []).toHaveLength(2);
    expect(CASH_CODE, "baja sin ConfirmDialog").toMatch(/<ConfirmDialog\b/);
    // Y no quedó el `error` compartido de antes, que pintaba el fallo de la
    // base dentro de la sección de denominaciones.
    expect(CASH_CODE, "estado de error único").not.toMatch(/const \[error, setError\]/);
  });

  it("el fallo al guardar es estado: Alert destructivo junto al formulario, o adentro del diálogo", () => {
    // Las cuatro que migraron al diálogo: el estado de ESE formulario se lo
    // pasa la sección a `FormDialog`, que lo pinta como
    // `Alert variant="destructive"` adentro. Antes la affirmación era que el
    // `Alert` LITERAL estuviera en la sección; ahora es que el estado llegue al
    // diálogo y que la sección NO lo pinte además por su cuenta.
    for (const [path, code, state] of [
      ["taxes-section.tsx", TAXES_CODE, "error"],
      ["methods-section.tsx", METHODS_CODE, "error"],
      ["cash-section.tsx", CASH_CODE, "addError"],
      ["employees-section.tsx", EMPLOYEES_CODE, "error"],
    ] as Array<[string, string, string]>) {
      // El setter se deriva del nombre del estado (`error` -> `setError`).
      const setter = `set${state[0]?.toUpperCase()}${state.slice(1)}`;
      expect(code, `${path}: useState de error`).toContain(
        `const [${state}, ${setter}] = useState<string | null>(null)`,
      );
      expect(code, `${path}: el error llega al diálogo`).toMatch(
        new RegExp(`<FormDialog\\b[\\s\\S]*?\\berror=\\{${state}\\}`),
      );
      expect(code, `${path}: Alert del mismo estado en la sección`).not.toMatch(
        new RegExp(`<Alert\\s+variant="destructive"[^>]*>\\s*\\{${state}\\}`),
      );
    }
    // `vales-section.tsx` no migró: conserva su `Alert` literal, y `users` el
    // suyo con la clase extra que ya tenía (su confirmar y su guardar son
    // acciones sobre el estado de la propia sección, no de un formulario).
    expect(VALES_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,40}\{error\}[\s\S]{0,20}<\/Alert>/,
    );
    expect(VALES_CODE).toContain("const [error, setError] = useState<string | null>(null)");
    expect(USERS_CODE).toMatch(
      /<Alert\s+variant="destructive"\s+className="mt-3">\s*\{error\}\s*<\/Alert>/,
    );
  });

  it("los mensajes de validación que bloquean son estado, no texto suelto", () => {
    const blocking: Array<[string, string]> = [
      [CASH_CODE, '"Indique la nueva base."'],
      [CASH_CODE, '"Indique un valor mayor a 0."'],
      [EMPLOYEES_CODE, '"El correo del empleado es obligatorio para crear su acceso."'],
      [EMPLOYEES_CODE, "`[${created.code}] ${created.message}`"],
      [USERS_CODE, '"Seleccione un rol."'],
      [VALES_CODE, '"Elija al menos un día permitido."'],
      [VALES_CODE, '"Indique el tope de al menos un día."'],
      [VALES_CODE, '"Indique un tope diario mayor a 0."'],
      [VALES_CODE, '"Indique un tope semanal mayor a 0."'],
    ];
    for (const [code, text] of blocking) {
      const lines = linesWith(code, text);
      expect(lines, text).toHaveLength(1);
      // El setter ya no se llama siempre `setError`: caja tiene un estado por
      // superficie (`setBaseError`, `setAddError`, `setDenominationError`). Lo
      // que se sigue exigiendo es lo importante — el mensaje de bloqueo va a
      // un ESTADO de error, no a texto suelto ni a un toast— y ese es el
      // prefijo `set…Error(`.
      expect(lines[0], text).toMatch(/set[A-Za-z]*Error\(/);
    }
    // El tope inválido se arma con el nombre del día: mismo canal.
    expect(VALES_CODE).toMatch(/setError\(`Tope inválido para \$\{DAY_NAMES\[day - 1\]\?\.label \?\? day\}\.`\)/);
    // Y las clases sueltas del estado de éxito/error se fueron con los `<p>`.
    for (const [path, code] of MODULES) {
      expect(code, `${path}: okClass`).not.toMatch(/okClass/);
      expect(code, `${path}: errorClass`).not.toMatch(/errorClass/);
    }
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(ADMIN_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(ADMIN_PAGE_CODE).toMatch(
      /<Alert variant="destructive">El usuario no tiene sede asignada\.<\/Alert>/,
    );
    expect(ADMIN_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(ADMIN_PAGE_CODE).not.toMatch(/\btoast\b/);
  });

  it("ningún aviso del panel es derivado en vivo, así que ninguno fuerza un rol a mano", () => {
    // "Donde aplique": hoy NINGÚN mensaje del panel se calcula del formulario
    // mientras se escribe. Los avisos de validación (caja, usuarios, vales,
    // empleados) se disparan al ENVIAR, o sea son fallos confirmados y quedan
    // asertivos por la variante. Se pinea el hecho: si aparece un derivado en
    // vivo, tiene que venir con `role="status"` (polite) —nunca con un
    // `role="alert"` a mano— y esta guarda lo obliga a decidirlo.
    for (const [path, code] of MODULES) {
      expect(adHocRoles(code), `role= en ${path}`).toEqual([]);
      expect(alertsWithExplicitStatusRole(code), `override polite en ${path}`).toBe(0);
    }
  });
});

/* ==========================================================================
   Admin: el texto visible no cambió (cambia el canal, no la copia)
   ========================================================================== */
describe("admin: el texto visible no cambió (cambia el canal, no la copia)", () => {
  it("las copias de las siete superficies siguen ahí, palabra por palabra", () => {
    const copies: Array<[string, string]> = [
      [CASH_CODE, "Base actualizada."],
      [CASH_CODE, "Denominación agregada."],
      [CASH_CODE, "Denominación actualizada."],
      [CASH_CODE, "Denominación eliminada."],
      [CASH_CODE, "Indique la nueva base."],
      [CASH_CODE, "Indique un valor mayor a 0."],
      [METHODS_CODE, "Método actualizado."],
      [METHODS_CODE, "Método creado."],
      [TAXES_CODE, "Impuesto actualizado."],
      [TAXES_CODE, "Impuesto creado."],
      [USERS_CODE, "Clave de ${row.full_name} restablecida a su documento; deberá cambiarla al entrar."],
      [USERS_CODE, "Rol de ${row.full_name} actualizado."],
      [USERS_CODE, "Seleccione un rol."],
      [EMPLOYEES_CODE, "Empleado actualizado."],
      [EMPLOYEES_CODE, "Empleado creado."],
      [EMPLOYEES_CODE, "El correo del empleado es obligatorio para crear su acceso."],
      [VALES_CODE, "Configuración de vales actualizada."],
      [VALES_CODE, "Elija al menos un día permitido."],
      [VALES_CODE, "Indique el tope de al menos un día."],
      [VALES_CODE, "Indique un tope diario mayor a 0."],
      [VALES_CODE, "Indique un tope semanal mayor a 0."],
    ];
    for (const [code, text] of copies) {
      expect(code, text).toContain(text);
    }
    expect(ADMIN_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(ADMIN_PAGE_CODE, "página: encabezado").toContain(
      "Empleados, impuestos y métodos de pago de su sede.",
    );
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(CASH_CODE).not.toContain("Base de caja actualizada.");
    expect(METHODS_CODE).not.toContain("Método guardado.");
    expect(TAXES_CODE).not.toContain("Impuesto guardado.");
    expect(USERS_CODE).not.toContain("Usuario guardado.");
    expect(EMPLOYEES_CODE).not.toContain("Empleado guardado.");
    expect(VALES_CODE).not.toContain("Vales actualizados.");
    expect(ADMIN_PAGE_CODE).not.toContain("Sin sede asignada.");
    // El diálogo muerto de "Nuevo usuario" de `users-section.tsx` se ELIMINÓ:
    // `setCreateOpen` solo se llamaba con `false`, así que ese `Dialog` nunca
    // pudo abrir y su alta duplicaba la que `employees-section.tsx` hace con su
    // checkbox "Crear usuario de acceso". La copia, su toast y la acción van
    // con él: se afirman AUSENTES en usuarios y presentes solo en el empleado.
    expect(USERS_CODE).not.toContain("Usuario creado con su rol.");
    expect(USERS_CODE).not.toContain("Nuevo usuario");
    expect(USERS_CODE).not.toMatch(/adminCreateUserAction/);
    expect(EMPLOYEES_CODE).toMatch(/adminCreateUserAction/);
  });

  it("los vacíos de las siete superficies siguen siendo el baseline mudo: sin Alert y sin anuncio", () => {
    // Describen lo esperado, no bloquean nada y nunca anunció nada (no
    // tenían rol): los ocho ya son `EmptyState`, que sigue siendo texto
    // apagado y NO lleva `role` ni `aria-live`. Se afirman igual en todos:
    // la apertura que corresponde, el espaciado que ya tenía, y —esto es lo
    // que el helper existe para proteger— NUNCA un `Alert` ni un `aria-live`.
    // Envolverlos en `Alert` agregaría un anuncio que hoy no existe.
    const empties: Array<[string, string, string, string]> = [
      [CASH_CODE, "Aún no hay cajas registradas en esta sede.", "<EmptyState", "mt-2"],
      [CASH_CODE, "Aún no hay denominaciones registradas.", "<EmptyState", "mt-3"],
      [METHODS_CODE, "Aún no hay métodos de pago configurados en esta sede.", "<EmptyState", "mt-2"],
      [TAXES_CODE, "Aún no hay impuestos configurados en esta sede.", "<EmptyState", "mt-2"],
      [USERS_CODE, "Aún no hay usuarios en esta sede.", "<EmptyState", "mt-2"],
      [EMPLOYEES_CODE, "Aún no hay empleados en la instalación.", "<EmptyState", "mt-2"],
      [EMPLOYEES_CODE, "Sin resultados para ese filtro.", "<EmptyState", "mt-2"],
      [VALES_CODE, "Sin configurar: los vales no tienen límite.", "<EmptyState", "mt-1"],
    ];
    for (const [code, text, opener, style] of empties) {
      const block = plainTextBlock(code, text);
      expect(block, `${text}: apertura`).toContain(opener);
      expect(block, `${text}: clase`).toContain(style);
      // El vacío es mudo a propósito: sin `role` ni `aria-live` hay nada que
      // un lector de pantalla anuncie. El `Alert` ya lo pineó `plainTextBlock`.
      expect(block, `${text}: anuncia`).not.toMatch(/aria-live|\brole\s*=/);
    }
    // Los ocho toman el primitivo, no una copia de su estilo. Y los que además
    // pezcan de TODO `Alert` (impuestos, métodos y empleados, que ya no
    // escriben ninguno) no pueden importarlo: caja conserva el suyo para las
    // dos acciones de fila, y usuarios y vales para sus errores de fila y
    // de guardado.
    for (const [code, text, sinAlert] of [
      [CASH_CODE, "Aún no hay cajas registradas en esta sede.", false],
      [CASH_CODE, "Aún no hay denominaciones registradas.", false],
      [METHODS_CODE, "Aún no hay métodos de pago configurados en esta sede.", true],
      [TAXES_CODE, "Aún no hay impuestos configurados en esta sede.", true],
      [USERS_CODE, "Aún no hay usuarios en esta sede.", false],
      [EMPLOYEES_CODE, "Aún no hay empleados en la instalación.", true],
    ] as Array<[string, string, boolean]>) {
      expect(code, `${text}: import de EmptyState`).toMatch(EMPTY_STATE_MODULE);
      if (sinAlert) {
        expect(code, `${text}: sin Alert`).not.toMatch(ALERT_IMPORT);
      }
    }
  });
});

/* ==========================================================================
   Admin: las dos listas ya no son tablas
   ========================================================================== */
describe("admin: las listas de empleados y usuarios ya no son tablas", () => {
  it("ninguna vuelve a una tabla a mano ni inventa un piso", () => {
    // Historia, para que se entienda por qué este bloque cambió dos veces: las
    // dos tablas del panel vivían en `<div className="overflow-x-auto">` +
    // `<table className="min-w-full text-left text-sm">` escritos a mano;
    // después pasaron por el primitivo `DataTable` con piso `none`; y con R-e3
    // dejaron de ser tablas: debajo de `sm` son la tarjeta con etiquetas y
    // arriba una grilla con cada valor anclado por `sm:col-start-N`.
    //
    // La ESTRUCTURA de la tarjeta la afirma `admin-tables-labels.test.ts`. Lo
    // que este bloque defiende es lo que no puede volver: una tabla a mano y un
    // piso inventado (la escala está pineada en `ux-data-table.test.ts`).
    for (const [path, code] of [
      ["app/admin/admin-sections/employees-section.tsx", EMPLOYEES_CODE],
      ["app/admin/admin-sections/users-section.tsx", USERS_CODE],
    ] as Array<[string, string]>) {
      expect(code, `${path}: tabla a mano ya no está`).not.toMatch(/<table\b/);
      expect(code, `${path}: piso inventado`).not.toMatch(/min-w-\[/);
    }
    // `vales-section.tsx` no tiene tabla: nada que migrar, y no debe
    // importar el primitivo para fingir que sí.
    expect(VALES_CODE).not.toMatch(/<table\b/);
    expect(VALES_CODE).not.toMatch(/from\s*["']@\/src\/components\/ui\/lib\/data-table["']/);
  });
});
