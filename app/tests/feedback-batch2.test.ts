import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en alertas, vales y nómina (WU-C, lote 2).

   Es el MISMO criterio que ya verificó `services` en WU-B, aplicado a tres
   módulos más. El defecto es idéntico: cada mensaje del módulo es un
   `<p role="status">` (o `role="alert"`) inline y PERSISTENTE, así que
   "Vale aprobado." se queda en pantalla para siempre compitiendo con lo que sí
   importa. Son cosas distintas y merecen canales distintos:

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", "no se pudieron cargar las alertas", "no hay
                caja abierta"): inline, persistente, al lado de la cosa ->
                `Alert`, que deriva el rol ARIA de la variante.
   - EVENTO  -> lo que acaba de pasar ("vale aprobado", "pago registrado"):
                efímero -> `toast`.
   - VACÍO   -> el estado base de una lista o tabla ("Sin vales todavía."):
                describe lo esperado, NO bloquea nada y NUNCA anunció nada.
                Sigue siendo texto plano y NO se envuelve en `Alert`: envolverlo
                AGREGARÍA un anuncio que hoy no existe, o sea un cambio de
                comportamiento fuera de esta unidad. Queda comentado y pineado.

   Un hecho, un canal: nada se anuncia por los dos.

   Offline y sin DOM (`vitest.config.ts` corre `environment: "node"`): lee los
   archivos reales —igual que services-feedback.test.ts y ui-feedback.test.ts—
   y afirma el criterio sobre el texto del código. No hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

const ALERTS_CLIENT_PATH = join(APP_ROOT, "app", "alerts", "alerts-client.tsx");
const ALERTS_PAGE_PATH = join(APP_ROOT, "app", "alerts", "page.tsx");
const VALES_CLIENT_PATH = join(APP_ROOT, "app", "vales", "vouchers-client.tsx");
const VALES_PAGE_PATH = join(APP_ROOT, "app", "vales", "page.tsx");
const PAYROLL_CLIENT_PATH = join(APP_ROOT, "app", "payroll", "payroll-client.tsx");
const PAYROLL_PAGE_PATH = join(APP_ROOT, "app", "payroll", "page.tsx");

const ALERTS_CLIENT_TSX = readFileSync(ALERTS_CLIENT_PATH, "utf8");
const ALERTS_PAGE_TSX = readFileSync(ALERTS_PAGE_PATH, "utf8");
const VALES_CLIENT_TSX = readFileSync(VALES_CLIENT_PATH, "utf8");
const VALES_PAGE_TSX = readFileSync(VALES_PAGE_PATH, "utf8");
const PAYROLL_CLIENT_TSX = readFileSync(PAYROLL_CLIENT_PATH, "utf8");
const PAYROLL_PAGE_TSX = readFileSync(PAYROLL_PAGE_PATH, "utf8");

/**
 * Código sin comentarios: un `role="status"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo criterio que ui-feedback.test.ts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const ALERTS_CLIENT_CODE = stripComments(ALERTS_CLIENT_TSX);
const ALERTS_PAGE_CODE = stripComments(ALERTS_PAGE_TSX);
const VALES_CLIENT_CODE = stripComments(VALES_CLIENT_TSX);
const VALES_PAGE_CODE = stripComments(VALES_PAGE_TSX);
const PAYROLL_CLIENT_CODE = stripComments(PAYROLL_CLIENT_TSX);
const PAYROLL_PAGE_CODE = stripComments(PAYROLL_PAGE_TSX);

/**
 * Roles ad-hoc: cualquier `role=` escrito a mano en el módulo. Los roles de
 * estas vistas los pone la primitiva (`Alert` los deriva de la variante), no la
 * vista. Ojo: los `role="status"` de los archivos loading.tsx NO cuentan —
 * viven fuera de estos seis archivos, son el anuncio legítimo de un esqueleto
 * de carga y esta unidad no los toca.
 */
const AD_HOC_ROLE = /\brole\s*=/g;

function adHocRoles(source: string): string[] {
  return [...source.matchAll(AD_HOC_ROLE)].map((match) => match[0]);
}

/** Las líneas del código que mencionan un texto. */
function linesWith(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text));
}

/**
 * Cuerpo de una función de primer nivel del componente (2 espacios de sangría).
 * Se busca por firma y se corta en su llave de cierre, así `show()` se puede
 * afirmar sin recortar por cantidad de caracteres.
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `no se encontró ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end === -1 ? source.length : end);
}

const ALERT_IMPORT = /import\s*\{\s*Alert\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/alert["']/;
const SONNER_TOAST_IMPORT = /import\s*\{\s*toast\s*\}\s*from\s*["']sonner["']/;

/**
 * ¿El texto aparece DENTRO de una llamada a `show(` y sólo allí? Es el único
 * camino de éxito de una acción en estos módulos; afirmarlo así evita depender
 * de en qué renglón quedó el ternario que arma el texto.
 */
function insideShowCall(source: string, text: string): boolean {
  const index = source.indexOf(text);
  if (index === -1) return false;
  const open = source.lastIndexOf("show(", index);
  if (open === -1) return false;
  // Sin frontera de sentencia entre la apertura de `show(` y el texto: si la
  // hubiera, el texto estaría en otra llamada (un setError, por ejemplo).
  return !/[;{}]/.test(source.slice(open + "show(".length, index));
}

/** El `show()` que ambos clientes comparten: éxito -> toast, fallo -> estado. */
function expectShowRoutesOkToToast(clientCode: string, where: string): void {
  const show = functionBody(clientCode, "function show<T>");
  // El ÉXITO de una acción es un EVENTO: efímero, no un texto pegado.
  expect(show, `${where}: show() desemboca en toast.success`).toMatch(/toast\.success\(okText\)/);
  // El FALLO de una acción es ESTADO: persiste mientras el problema exista.
  expect(show, `${where}: show() guarda el fallo como estado`).toMatch(/setError\(/);
}

/**
 * ¿Cuántos `Alert` de esta variante llevan el override `role="status"` escrito
 * a mano? Se exige que el atributo venga INMEDIATAMENTE después de la variante
 * (es la forma en que está escrito el marcado): así un `role="status"` a 600
 * caracteres de distancia no pasa por vecino.
 */
function alertsWithExplicitStatusRole(
  source: string,
  variant: "destructive" | "warning",
): number {
  const re = new RegExp(`<Alert\\s+variant="${variant}"\\s+role="status"`, "g");
  return [...source.matchAll(re)].length;
}

/* ==========================================================================
   El detector mismo (control negativo compartido por los tres módulos)
   ========================================================================== */
describe("detector de roles ad-hoc: no es un sello de goma", () => {
  it("marca las dos formas que el repositorio tenía escritas y respeta comentarios", () => {
    const fijo = `<p role="status">ok</p><div role="alert">err</div>`;
    const condicional = `<p role={message.kind === "error" ? "alert" : "status"}>x</p>`;
    expect(adHocRoles(fijo)).toHaveLength(2);
    expect(adHocRoles(condicional)).toHaveLength(1);
    // El stripper no borra código real: solo comentarios.
    expect(stripComments(fijo)).toBe(fijo);
    expect(adHocRoles(stripComments(`/* role="status" */ // role="alert"`))).toEqual([]);
  });

  it("el detector de 'dentro de show()' distingue el éxito del fallo", () => {
    const source = `setError("boom");\n      show(result, "listo");`;
    expect(insideShowCall(source, "listo")).toBe(true);
    expect(insideShowCall(source, "boom")).toBe(false);
    expect(insideShowCall(source, "no-existe")).toBe(false);
  });

  it("los seis archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(ALERTS_CLIENT_CODE.length, "alerts-client.tsx").toBeGreaterThan(4_000);
    expect(ALERTS_PAGE_CODE.length, "alerts/page.tsx").toBeGreaterThan(300);
    expect(VALES_CLIENT_CODE.length, "vouchers-client.tsx").toBeGreaterThan(10_000);
    expect(VALES_PAGE_CODE.length, "vales/page.tsx").toBeGreaterThan(600);
    expect(PAYROLL_CLIENT_CODE.length, "payroll-client.tsx").toBeGreaterThan(20_000);
    expect(PAYROLL_PAGE_CODE.length, "payroll/page.tsx").toBeGreaterThan(500);
    // Anclas de contenido: confirman que leímos los archivos correctos.
    expect(ALERTS_CLIENT_CODE).toContain("export function AlertsClient");
    expect(ALERTS_PAGE_CODE).toContain("export default async function AlertsPage");
    expect(VALES_CLIENT_CODE).toContain("export function VouchersClient");
    expect(VALES_PAGE_CODE).toContain("export default async function ValesPage");
    expect(PAYROLL_CLIENT_CODE).toContain("export function PayrollClient");
    expect(PAYROLL_PAGE_CODE).toContain("export default async function PayrollPage");
  });

  it("no queda ningún rol ad-hoc en los seis archivos", () => {
    const modules: Array<[string, string]> = [
      ["app/alerts/alerts-client.tsx", ALERTS_CLIENT_CODE],
      ["app/alerts/page.tsx", ALERTS_PAGE_CODE],
      ["app/vales/page.tsx", VALES_PAGE_CODE],
      ["app/payroll/page.tsx", PAYROLL_PAGE_CODE],
    ];
    for (const [path, code] of modules) {
      expect(adHocRoles(code), `role= en ${path}`).toEqual([]);
    }
    // Excepción DELIBERADA: nómina escribe dos roles a mano. Son el override
    // `role="status"` de los dos avisos de rango, que se derivan en vivo del
    // formulario y por eso anuncian `polite` (test dedicado más abajo).
    // Cualquier otro `role=` sigue siendo el defecto que esta guarda caza.
    expect(adHocRoles(PAYROLL_CLIENT_CODE), "excepción deliberada").toEqual(["role=", "role="]);
    expect(
      [...PAYROLL_CLIENT_CODE.matchAll(/<Alert variant="destructive" role="status">/g)],
    ).toHaveLength(2);
    // Excepción DELIBERADA (vales): UN `role="status"` explícito sobre el
    // aviso previo del fuera de rango, que se deriva en vivo del formulario
    // (empleado + monto) y por eso anuncia `polite` (test dedicado más
    // abajo). Cualquier otro `role=` en vales sigue siendo el defecto que
    // esta guarda caza.
    expect(adHocRoles(VALES_CLIENT_CODE), "excepción deliberada (vales)").toEqual(["role="]);
    expect(
      [...VALES_CLIENT_CODE.matchAll(/<Alert variant="warning" role="status">/g)],
    ).toHaveLength(1);
  });
});

/* ==========================================================================
   Alertas
   ========================================================================== */
describe("alertas: el fallo es estado, y no hay evento que inventar", () => {
  it("el fallo al cargar o revisar es estado: Alert destructivo arriba de la bandeja", () => {
    expect(ALERTS_CLIENT_CODE).toMatch(ALERT_IMPORT);
    // El Alert envuelve EXACTAMENTE el error de la bandeja.
    expect(ALERTS_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{error\}[\s\S]{0,40}<\/Alert>/,
    );
    expect(ALERTS_CLIENT_CODE).toContain("const [error, setError] = useState<string | null>(null)");
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(ALERTS_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(ALERTS_PAGE_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}El usuario no tiene sede asignada\.[\s\S]{0,40}<\/Alert>/,
    );
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(ALERTS_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(ALERTS_PAGE_CODE).not.toContain("sonner");
    expect(ALERTS_PAGE_CODE).not.toMatch(/\btoast\b/);
  });

  it("el módulo no tiene ningún texto de evento: no se inventa un toast", () => {
    // Decisión, no olvido: revisar una alerta no confirma nada al usuario —
    // la alerta sale de la lista, y eso ya es la señal. No hay copia de éxito
    // que mover al canal efímero, así que el módulo NO importa toast.
    expect(ALERTS_CLIENT_CODE).not.toMatch(/toast\./);
    expect(ALERTS_CLIENT_CODE).not.toMatch(SONNER_TOAST_IMPORT);
  });

  it("un hecho, un canal: el error no se anuncia además por toast", () => {
    expect(ALERTS_CLIENT_CODE).not.toMatch(/toast\.(error|warning|success)\(/);
  });

  it("el vacío de la bandeja sigue siendo texto de lista, no un aviso", () => {
    const lines = linesWith(ALERTS_CLIENT_CODE, "Sin alertas.");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("Alert");
    // Nunca anunció nada (no tenía rol) y vive donde iría la lista: no compite
    // con ningún mensaje, así que no se convierte en Alert.
    expect(lines[0]).toContain("mutedTextClass");
  });

  it("el texto visible no cambió (cambia el canal, no la copia)", () => {
    for (const text of [
      "La justificación es obligatoria.",
      "Sin alertas.",
    ]) {
      expect(ALERTS_CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(ALERTS_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(ALERTS_PAGE_CODE, "página: encabezado").toContain(
      "Desajustes de caja y cuentas bloqueadas de su sede.",
    );
    // Control negativo del "contiene": no se reescribió la copia.
    expect(ALERTS_CLIENT_CODE).not.toContain("Alerta revisada.");
    expect(ALERTS_PAGE_CODE).not.toContain("Sin sede asignada.");
  });
});

/* ==========================================================================
   Vales
   ========================================================================== */
describe("vales: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(VALES_CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    // El Toaster ya está montado una sola vez en app/layout.tsx (ui-feedback.test.ts).
    expect(VALES_CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it("los cuatro textos de evento salen por el canal efímero", () => {
    // Se busca el literal ENTRE COMILLAS: es el texto que se le pasa a `show`,
    // y así una copia larga que lo contenga por casualidad no cuenta como
    // segunda ocurrencia.
    for (const text of [
      '"Vale aprobado: dentro de rango se generó directo con su método de pago."',
      '"Vale pendiente: fuera de rango (día o topes), el admin debe autorizarlo."',
      '"Vale aprobado. Su alerta quedó resuelta."',
      '"Vale rechazado. Su alerta quedó resuelta."',
    ]) {
      const lines = linesWith(VALES_CLIENT_CODE, text);
      // Exactamente una línea por texto: aparece como argumento de `show(...)`,
      // el único camino de éxito — que desemboca en el toast, no en un `<p>`.
      expect(lines, text).toHaveLength(1);
      expect(insideShowCall(VALES_CLIENT_CODE, text), text).toBe(true);
    }
    expectShowRoutesOkToToast(VALES_CLIENT_CODE, "vales");
  });

  it("el mensaje persistente dejó de existir como estado genérico", () => {
    expect(VALES_CLIENT_CODE).not.toMatch(/setMessage/);
    expect(VALES_CLIENT_CODE).not.toMatch(/kind:\s*"(ok|error)"/);
    expect(VALES_CLIENT_CODE).toContain("const [error, setError] = useState<string | null>(null)");
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    expect(VALES_CLIENT_CODE).not.toMatch(/toast\.(error|warning)\(/);
  });
});

describe("vales: lo persistente va por Alert (estado)", () => {
  it("los fallos de acción y de validación son estado: Alert destructivo", () => {
    expect(VALES_CLIENT_CODE).toMatch(ALERT_IMPORT);
    expect(VALES_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{error\}[\s\S]{0,40}<\/Alert>/,
    );
    const lines = linesWith(VALES_CLIENT_CODE, "Elija el empleado e indique un monto mayor a 0.");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/setError\(/);
  });

  it("'sin configurar' y 'sin caja' bloquean la solicitud: Alert de aviso, no de error", () => {
    // No son fallos: son precondiciones que el usuario (o un admin) tiene que
    // resolver para poder solicitar. `warning` es la variante honesta y además
    // conserva el par de tokens que el marcado ya escribía a mano
    // (`bg-warning-light` + `text-warning`).
    const notConfigured = linesWith(
      VALES_CLIENT_CODE,
      "Los vales no están configurados: un administrador debe definir topes y días permitidos antes de solicitar.",
    );
    expect(notConfigured).toHaveLength(1);
    expect(VALES_CLIENT_CODE).toMatch(
      /<Alert\s+variant="warning"[\s\S]{0,200}Los vales no están configurados:[\s\S]{0,160}<\/Alert>/,
    );
    const shift = linesWith(VALES_CLIENT_CODE, "{shiftBlockReason}");
    expect(shift).toHaveLength(1);
    const before = VALES_CLIENT_CODE.slice(0, VALES_CLIENT_CODE.indexOf("{shiftBlockReason}"));
    expect(before.slice(before.lastIndexOf("<Alert")).slice(0, 120)).toContain('variant="warning"');
  });

  it("los dos avisos de bloqueo de la solicitud son ESTADO, no texto suelto", () => {
    // Antes eran `<p role="status">` con el tinte ámbar escrito a mano: el mismo
    // rol que un `warning` de la primitiva deriva, sin escribirlo.
    expect(VALES_CLIENT_CODE).not.toMatch(/bg-warning-light/);
    expect(VALES_CLIENT_CODE).not.toMatch(/\bwarning-light\b[\s\S]{0,10}role/);
  });

  it("sin métodos arqueables no se puede elegir método: Alert destructivo en el modal", () => {
    expect(VALES_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,200}No hay métodos de pago arqueables activos: configúrelos antes de solicitar vales\.[\s\S]{0,40}<\/Alert>/,
    );
  });

  it("el motivo de rechazo faltante es estado del modal: Alert destructivo", () => {
    expect(VALES_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{reviewError\}[\s\S]{0,40}<\/Alert>/,
    );
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(VALES_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(VALES_PAGE_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}El usuario no tiene sede asignada\.[\s\S]{0,40}<\/Alert>/,
    );
    expect(VALES_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(VALES_PAGE_CODE).not.toMatch(/\btoast\b/);
  });
});

describe("vales: el texto visible no cambió (cambia el canal, no la copia)", () => {
  it("las dos copias del módulo siguen ahí, palabra por palabra", () => {
    for (const text of [
      "Elija el empleado e indique un monto mayor a 0.",
      "Elija el método de pago por el que saldrá el dinero.",
      "El motivo del rechazo es requerido.",
      "Los vales no están configurados: un administrador debe definir topes y días permitidos antes de solicitar.",
      "No hay métodos de pago arqueables activos: configúrelos antes de solicitar vales.",
      "No hay caja abierta: abre tu turno para solicitar vales.",
      "Sin vales todavía.",
      "Sin vales para estos filtros.",
    ]) {
      expect(VALES_CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(VALES_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(VALES_PAGE_CODE, "página: encabezado").toContain(
      "La caja abre el vale al empleado con topes por día y semana, días permitidos y revisión del admin.",
    );
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(VALES_CLIENT_CODE).not.toContain("Vale emitido.");
    expect(VALES_CLIENT_CODE).not.toContain("Vales actualizados.");
    expect(VALES_PAGE_CODE).not.toContain("Sin sede asignada.");
  });

  it("los dos vacíos de la tabla siguen siendo texto plano, no avisos", () => {
    // `Sin vales todavía.` es el estado base de la lista y `Sin vales para
    // estos filtros.` es el mismo caso con filtros puestos: describen lo
    // esperado, no bloquean nada y nunca anunciaron nada. Siguen en texto
    // terciario y NO se envuelven en `Alert` (eso agregaría el anuncio).
    for (const text of ["Sin vales todavía.", "Sin vales para estos filtros."]) {
      const lines = linesWith(VALES_CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).not.toContain("Alert");
      expect(lines[0], text).toContain("text-text-tertiary");
    }
  });
});

/* ==========================================================================
   Vales: el fuera de rango avisa ANTES de crearse (V1).

   El defecto era de previsión: un vale sobre el tope (o en día no permitido)
   se creaba sin aviso y el usuario se enteraba después, cuando ya estaba
   pendiente en revisión del admin. La foresight usa lo que la pantalla YA
   tiene (topes de `settings` + acumulados de los `vouchers` cargados, misma
   función pura de elegibilidad que el servicio): sin llamada nueva, sin
   cambio de contrato, sin cambiar el veredicto — solo se anticipa.

   Dos superficies, una por momento (tabla §1 del estándar):
   - Mientras se escribe -> señal derivada en vivo: presentación `Alert` con
     `role="status"` EXPLÍCITO (polite). `warning` derivaría `alert`
     (asertivo) e interrumpir un cálculo en curso es el sobreanuncio que el
     estándar prohíbe. Solo existe cuando hay algo que decir.
   - Al enviar fuera de rango -> `ConfirmDialog` (confirmación en proceso
     delicado) cuya descripción dice la consecuencia: nacerá PENDIENTE en
     revisión del admin. En rango el envío sigue directo, como antes.
   ========================================================================== */
describe("vales: el fuera de rango avisa antes de crearse (V1)", () => {
  /**
   * El aviso previo, recortado a su construcción: desde
   * `const voucherReviewNotice` hasta el cierre de su IIFE. Así los
   * `return null` se afirman sobre el constructor y no sobre todo el archivo.
   */
  function reviewNotice(): string {
    const start = VALES_CLIENT_CODE.indexOf("const voucherReviewNotice = ");
    expect(start, "constructor del aviso previo").toBeGreaterThan(-1);
    const end = VALES_CLIENT_CODE.indexOf("})();", start);
    expect(end, "cierre del constructor del aviso previo").toBeGreaterThan(start);
    return VALES_CLIENT_CODE.slice(start, end);
  }

  it("el aviso previo existe y es polite por decisión explícita, no por defecto", () => {
    // Se pinea el atributo ESCRITO, no el rol derivado: si alguien borra el
    // `role="status"` "porque el warning ya avisa", el aviso pasaría a
    // asertivo e interrumpiría a quien teclea, y esto acusa.
    const lines = linesWith(VALES_CLIENT_CODE, '<Alert variant="warning" role="status">');
    expect(lines).toHaveLength(1);
    expect(alertsWithExplicitStatusRole(VALES_CLIENT_CODE, "warning")).toBe(1);
    // CONTROL NEGATIVO: el detector discrimina la variante (heredado del pin
    // de nómina): un `status` sobre otra variante no cuenta como este aviso.
    expect(alertsWithExplicitStatusRole(VALES_CLIENT_CODE, "destructive")).toBe(0);
  });

  it("el aviso solo aparece cuando hay algo que decir", () => {
    // Render condicional: con el aviso en `null` no se renderiza nada (ni un
    // Alert vacío ni texto suelto).
    expect(VALES_CLIENT_CODE).toMatch(
      /\{\s*voucherReviewNotice\s*&&\s*\(\s*<Alert\s+variant="warning"\s+role="status">/,
    );
    const notice = reviewNotice();
    // Sin nada que decir: sin configurar, sin empleado, sin monto válido o
    // en rango. Cada `return null` es un caso que apaga el aviso.
    for (const guard of [
      "if (!configured) return null",
      "if (!voucherEmployee) return null",
      "if (requested === null || requested <= 0) return null",
      "if (!overCap && !eligibility.dayNotAllowed) return null",
    ]) {
      expect(notice, guard).toContain(guard);
    }
  });

  it("el aviso dice la consecuencia explícita: pendiente en revisión del admin", () => {
    const notice = reviewNotice();
    // Las tres formas (tope, día, ambas) terminan en la misma consecuencia.
    // Se pinea el literal COMPLETO de cada una: un `toContain("pendiente")`
    // pasaría con cualquier mención casual y sería decorativo.
    for (const copy of [
      '"Este vale supera el tope vigente: nacerá pendiente y el admin debe autorizarlo."',
      '"Hoy no es un día permitido para vales: este vale nacerá pendiente y el admin debe autorizarlo."',
      '"Este vale supera el tope vigente y hoy no es un día permitido: nacerá pendiente y el admin debe autorizarlo."',
    ]) {
      expect(notice, copy).toContain(copy);
    }
  });

  it("el fuera de rango se confirma: la consecuencia va en la descripción", () => {
    // Superficie (tabla §1): confirmar algo delicado -> `ConfirmDialog` con
    // título + descripción; el cuerpo dice la consecuencia, no "¿seguro?".
    expect(VALES_CLIENT_CODE).toMatch(
      /import\s*\{\s*ConfirmDialog\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/form-dialog["']/,
    );
    const dialogs = linesWith(VALES_CLIENT_CODE, "<ConfirmDialog");
    expect(dialogs).toHaveLength(1);
    expect(VALES_CLIENT_CODE).toContain('title="Solicitar vale fuera de rango"');
    expect(VALES_CLIENT_CODE).toMatch(
      /<ConfirmDialog[\s\S]{0,600}description=\{voucherReviewNotice\}/,
    );
    expect(VALES_CLIENT_CODE).toContain('confirmLabel="Solicitar igual"');
    // Control negativo del "¿seguro?": no hay copia genérica de confirmación.
    expect(VALES_CLIENT_CODE).not.toContain("¿Seguro?");
  });

  it("la puerta: el submit decide, solo el confirmado envía", () => {
    const decide = functionBody(VALES_CLIENT_CODE, "async function handleRequestVoucher");
    // Fuera de rango: abre la confirmación y vuelve sin enviar.
    expect(decide).toContain("if (voucherReviewNotice !== null && !outOfRangeConfirmOpen) {");
    expect(decide).toContain("setOutOfRangeConfirmOpen(true)");
    // En rango: camino directo al envío, como antes.
    expect(decide).toContain("await submitVoucherRequest(amount)");
    // El que decide NO llama a la acción: el envío vive solo en el confirmado.
    expect(decide).not.toContain("requestVoucherAction");
    const sender = functionBody(VALES_CLIENT_CODE, "async function submitVoucherRequest");
    expect(sender).toContain("requestVoucherAction({");
  });

  it("en rango el envío no cambió: misma acción, mismo payload", () => {
    const sender = functionBody(VALES_CLIENT_CODE, "async function submitVoucherRequest");
    for (const line of [
      "idempotency_key: voucherKey,",
      "employee_id: voucherEmployee,",
      "amount,",
      "method_code: voucherMethod,",
      "observation: voucherNote || undefined,",
    ]) {
      expect(sender, line).toContain(line);
    }
    // El desenlace tampoco: el diálogo se cierra y la lista se refresca.
    expect(sender).toContain("closeCreateDialog();");
    expect(sender).toContain("await refreshVouchers();");
  });
});

/* ==========================================================================
   Nómina
   ========================================================================== */
describe("nómina: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(PAYROLL_CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it("los cinco textos de evento salen por el canal efímero", () => {
    // El alta del período es la excepción estructural: no pasa por `show()`
    // porque la acción tiene dos desenlaces, así que llama al toast directo.
    const direct = linesWith(PAYROLL_CLIENT_CODE, '"Periodo abierto y calculado."');
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatch(/toast\.success\(/);

    // Se busca el literal ENTRE COMILLAS: "Periodo cerrado." aparece además
    // dentro de la copia larga del detalle cerrado ("Periodo cerrado. La
    // liquidación quedó registrada."), que no es un mensaje.
    for (const text of [
      '"Borrador recalculado: vales pendientes/aprobados quedaron descontados."',
      '"Pago registrado."',
      '"Periodo cerrado."',
      '"Borrador borrado."',
    ]) {
      const lines = linesWith(PAYROLL_CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(insideShowCall(PAYROLL_CLIENT_CODE, text), text).toBe(true);
    }
    expectShowRoutesOkToToast(PAYROLL_CLIENT_CODE, "nómina");
  });

  it("el mensaje persistente dejó de existir como estado genérico", () => {
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/setMessage/);
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/kind:\s*"(ok|error)"/);
    expect(PAYROLL_CLIENT_CODE).toContain("const [error, setError] = useState<string | null>(null)");
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/toast\.(error|warning)\(/);
  });
});

describe("nómina: lo persistente va por Alert (estado)", () => {
  it("los fallos de acción y de validación de pago son estado: Alert destructivo", () => {
    expect(PAYROLL_CLIENT_CODE).toMatch(ALERT_IMPORT);
    expect(PAYROLL_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{error\}[\s\S]{0,40}<\/Alert>/,
    );
    for (const text of [
      "Agregue al menos una porción de pago.",
      "Complete el método y un monto mayor a 0 en cada porción.",
    ]) {
      const lines = linesWith(PAYROLL_CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).toMatch(/setError\(/);
    }
  });

  it("el cálculo fallido tras abrir el período es estado: el período igual quedó creado", () => {
    expect(PAYROLL_CLIENT_CODE).toContain(
      "Periodo abierto, pero el cálculo falló — ${calculated.code}: ${calculated.message}",
    );
    expect(PAYROLL_CLIENT_CODE).toMatch(/setError\(\s*`Periodo abierto, pero el cálculo falló/);
  });

  it("los tres avisos del diálogo de apertura son estado: Alert destructivo", () => {
    // Los dos primeros se calculan en vivo (rango inválido / solape) y el
    // tercero viene de la acción (`openError`). Antes convivían un `<p>` sin rol
    // y un `<p role="alert">`: ahora los tres son el mismo canal.
    expect(PAYROLL_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"\s+role="status">\s*La fecha final no puede ser anterior a la inicial\./,
    );
    expect(PAYROLL_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"\s+role="status"[\s\S]{0,200}Ajuste las fechas\.[\s\S]{0,40}<\/Alert>/,
    );
    expect(PAYROLL_CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{openError\}[\s\S]{0,40}<\/Alert>/,
    );
    // Ningún aviso del diálogo quedó como `<p>` con la clase de error suelta.
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/<p className=\{errorClass\}/);
  });

  it("solo los dos avisos derivados en vivo anuncian `polite`: los fallos confirmados siguen asertivos", () => {
    // Los dos avisos de rango se DERIVAN del formulario mientras se escriben
    // las fechas; una región asertiva que interrumpe a quien teclea es el
    // antipatrón de sobreanuncio. Conservan la presentación `destructive` (el
    // par de tokens del error, que es lo que bloquea) pero pasan `role="status"`
    // explícito, que gana sobre el rol derivado de la variante.
    expect(alertsWithExplicitStatusRole(PAYROLL_CLIENT_CODE, "destructive")).toBe(2);

    // CONTROL NEGATIVO 1: el override no se aplicó en bloque. Los fallos
    // confirmados de una acción enviada (`{error}` arriba y `{openError}` en el
    // diálogo) quedan sin rol explícito, o sea asertivos: el usuario tiene que
    // enterarse antes de navegar. Si alguien pasara `role="status"` a todos los
    // Alert destructivos, este `toContain` seguiría verde y el conteo de arriba
    // pasaría a 4 y fallaría.
    for (const committed of [
      '<Alert variant="destructive">{error}</Alert>',
      '<Alert variant="destructive">{openError}</Alert>',
    ]) {
      const lines = linesWith(PAYROLL_CLIENT_CODE, committed);
      expect(lines, committed).toHaveLength(1);
      expect(lines[0], committed).not.toContain('role="status"');
    }

    // CONTROL NEGATIVO 2: el detector discrimina. No se conforma con encontrar
    // un `variant="destructive"` cualquiera ni con un `role="status"` lejano.
    expect(
      alertsWithExplicitStatusRole('<Alert variant="destructive" role="status">x</Alert>', "destructive"),
    ).toBe(1);
    expect(
      alertsWithExplicitStatusRole('<Alert variant="destructive">x</Alert>', "destructive"),
    ).toBe(0);
    expect(
      alertsWithExplicitStatusRole(
        '<Alert variant="warning" role="status">x</Alert>',
        "destructive",
      ),
    ).toBe(0);
  });

  it("los pendientes de pago bloquean el cierre: Alert de aviso con la lista adentro", () => {
    // No es un error: es un estado pendiente que hay que resolver antes de
    // cerrar. `warning` (asertivo) es la variante deliberada para algo que
    // frena la acción siguiente; el par de tokens es el mismo que el marcado
    // ya usaba (`bg-warning-light` + `text-warning`).
    expect(PAYROLL_CLIENT_CODE).toMatch(
      /<Alert\s+variant="warning"[\s\S]{0,400}Pendientes de pago \(\$\{pendingItems\.length\}\): páguelos todos antes de cerrar la nómina\.[\s\S]{0,900}<\/Alert>/,
    );
    expect(PAYROLL_CLIENT_CODE).not.toMatch(/bg-warning-light/);
    // La lista de pendientes sigue adentro del aviso, no se perdió.
    expect(PAYROLL_CLIENT_CODE).toContain("{employeeName(item.employee_id)} — {formatMoney(item.remaining)}");
    expect(PAYROLL_CLIENT_CODE).toContain(
      "y ${pendingItems.length - PENDING_VISIBLE_LIMIT} más (vea la columna Saldo de la tabla).",
    );
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(PAYROLL_PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(PAYROLL_PAGE_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}El usuario no tiene sede asignada\.[\s\S]{0,40}<\/Alert>/,
    );
    expect(PAYROLL_PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(PAYROLL_PAGE_CODE).not.toMatch(/\btoast\b/);
  });
});

describe("nómina: el texto visible no cambió (cambia el canal, no la copia)", () => {
  it("las dos copias del módulo siguen ahí, palabra por palabra", () => {
    for (const text of [
      "Agregue al menos una porción de pago.",
      "Complete el método y un monto mayor a 0 en cada porción.",
      "Indique el rango del período.",
      "La fecha final no puede ser anterior a la inicial.",
      "Ajuste las fechas.",
      "Aún no hay empleados en la instalación: créelos en /admin antes de liquidar.",
      "Sin periodos todavía.",
      "Sin períodos todavía: este será el primero.",
    ]) {
      expect(PAYROLL_CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(PAYROLL_PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");

    // U15: la instalación es de UNA sede y su palabra es «instalación» (decisión
    // del dueño, 2026-10-04). Este vacío nombra la planta, y `fetchEmployees`
    // (`admin/service.ts`) la lee ENTERA, sin predicado de sede: «en la sede»
    // nombraba un alcance que la consulta no aplica. Es la misma corrección que
    // ya recibió el vacío gemelo de admin (`employees-section.tsx`: «Aún no hay
    // empleados en la instalación.»).
    //
    // CONTROL NEGATIVO: la forma vieja no sobrevive en ninguna parte del
    // cliente, ni como texto ni dentro de otra frase.
    expect(PAYROLL_CLIENT_CODE).not.toContain("Aún no hay empleados en la sede");
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(PAYROLL_CLIENT_CODE).not.toContain("Período abierto y calculado.");
    expect(PAYROLL_CLIENT_CODE).not.toContain("Pago guardado.");
    expect(PAYROLL_PAGE_CODE).not.toContain("Sin sede asignada.");
  });

  it("los tres vacíos del módulo siguen siendo texto plano, no avisos", () => {
    for (const text of [
      "Aún no hay empleados en la instalación: créelos en /admin antes de liquidar.",
      "Sin periodos todavía.",
      "Sin períodos todavía: este será el primero.",
    ]) {
      const lines = linesWith(PAYROLL_CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).not.toContain("Alert");
    }
  });
});
