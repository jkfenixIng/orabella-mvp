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
                anunció nada. Sigue siendo texto plano y NO se envuelve en
                `Alert`: envolverlo AGREGARÍA un anuncio que hoy no existe.
                Queda comentado y pineado.
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
 * El bloque `<p>` que contiene un texto, desde su etiqueta de apertura hasta el
 * texto. Sirve para los vacíos escritos en varias líneas (la clase va en el
 * `<p>` y el texto dos renglones abajo), donde `linesWith` no alcanza.
 */
function plainTextBlock(source: string, text: string): string {
  const index = source.indexOf(text);
  expect(index, `no se encontró ${text}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf("<p", index);
  expect(open, `<p> de ${text}`).toBeGreaterThan(-1);
  const block = source.slice(open, index + text.length);
  expect(block, `${text} envuelto en Alert`).not.toContain("Alert");
  return block;
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

  it("los siete archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(ADMIN_PAGE_CODE.length, "admin/page.tsx").toBeGreaterThan(1_500);
    expect(CASH_CODE.length, "cash-section.tsx").toBeGreaterThan(4_000);
    expect(EMPLOYEES_CODE.length, "employees-section.tsx").toBeGreaterThan(14_000);
    expect(METHODS_CODE.length, "methods-section.tsx").toBeGreaterThan(3_500);
    expect(TAXES_CODE.length, "taxes-section.tsx").toBeGreaterThan(3_500);
    expect(USERS_CODE.length, "users-section.tsx").toBeGreaterThan(8_000);
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
    const rawWithMentions = [
      CASH_TSX,
      EMPLOYEES_TSX,
      METHODS_TSX,
      TAXES_TSX,
      USERS_TSX,
      VALES_TSX,
    ].filter((raw) => adHocRoles(raw).length > 0);
    expect(rawWithMentions.length, "secciones que citan el rol en comentarios").toBe(6);
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
      [USERS_CODE, '"Usuario creado con su rol."'],
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
  it("cada superficie tiene exactamente un Alert destructivo para su estado de fallo", () => {
    // Un sitio de error por módulo: el fallo al guardar (o la falta de sede en
    // la página). Si apareciera un segundo Alert, el conteo lo delata.
    const expected: Array<[string, string]> = [
      ["app/admin/page.tsx", ADMIN_PAGE_CODE],
      ["app/admin/admin-sections/cash-section.tsx", CASH_CODE],
      ["app/admin/admin-sections/employees-section.tsx", EMPLOYEES_CODE],
      ["app/admin/admin-sections/methods-section.tsx", METHODS_CODE],
      ["app/admin/admin-sections/taxes-section.tsx", TAXES_CODE],
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

  it("el fallo al guardar es estado: Alert destructivo junto al formulario", () => {
    // El Alert envuelve EXACTAMENTE el error de cada sección.
    for (const [path, code] of [
      ["cash-section.tsx", CASH_CODE],
      ["methods-section.tsx", METHODS_CODE],
      ["taxes-section.tsx", TAXES_CODE],
      ["vales-section.tsx", VALES_CODE],
    ] as Array<[string, string]>) {
      expect(code, path).toMatch(/<Alert\s+variant="destructive"[\s\S]{0,40}\{error\}[\s\S]{0,20}<\/Alert>/);
      expect(code, `${path}: useState de error`).toContain(
        "const [error, setError] = useState<string | null>(null)",
      );
    }
    // Los dos que llevan una clase extra la conservan.
    expect(USERS_CODE).toMatch(
      /<Alert\s+variant="destructive"\s+className="mt-3">\s*\{error\}\s*<\/Alert>/,
    );
    expect(EMPLOYEES_CODE).toMatch(
      /<Alert\s+variant="destructive"\s+className="sm:col-span-2">\s*\{error\}\s*<\/Alert>/,
    );
  });

  it("los mensajes de validación que bloquean son estado, no texto suelto", () => {
    const blocking: Array<[string, string]> = [
      [CASH_CODE, '"Indique la nueva base."'],
      [CASH_CODE, '"Indique un valor mayor a 0."'],
      [EMPLOYEES_CODE, '"El correo del empleado es obligatorio para crear su acceso."'],
      [EMPLOYEES_CODE, "`[${created.code}] ${created.message}`"],
      [USERS_CODE, '"Seleccione un rol."'],
      [USERS_CODE, "`[${result.code}] ${result.message}`"],
      [VALES_CODE, '"Elija al menos un día permitido."'],
      [VALES_CODE, '"Indique el tope de al menos un día."'],
      [VALES_CODE, '"Indique un tope diario mayor a 0."'],
      [VALES_CODE, '"Indique un tope semanal mayor a 0."'],
    ];
    for (const [code, text] of blocking) {
      const lines = linesWith(code, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).toMatch(/setError\(/);
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
      [USERS_CODE, "Usuario creado con su rol."],
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
  });

  it("los vacíos de las siete superficies siguen siendo texto plano, no avisos", () => {
    // Describen lo esperado, no bloquean nada y nunca anunciaron nada (no
    // tenían rol): siguen en su clase de texto y NO se envuelven en `Alert`
    // (eso agregaría un anuncio que hoy no existe). Queda pineado.
    const empties: Array<[string, string, string]> = [
      [CASH_CODE, "Aún no hay cajas registradas en esta sede.", "mutedTextClass"],
      [CASH_CODE, "Aún no hay denominaciones registradas.", "mutedTextClass"],
      [METHODS_CODE, "Aún no hay métodos de pago configurados en esta sede.", "mutedTextClass"],
      [TAXES_CODE, "Aún no hay impuestos configurados en esta sede.", "mutedTextClass"],
      [USERS_CODE, "Aún no hay usuarios en esta sede.", "mutedTextClass"],
      [EMPLOYEES_CODE, "Aún no hay empleados en esta sede.", "mutedTextClass"],
      [EMPLOYEES_CODE, "Sin resultados para ese filtro.", "mutedTextClass"],
      [VALES_CODE, "Sin configurar: los vales no tienen límite.", "text-text-secondary"],
    ];
    for (const [code, text, style] of empties) {
      const block = plainTextBlock(code, text);
      expect(block, text).toContain(style);
    }
  });
});
