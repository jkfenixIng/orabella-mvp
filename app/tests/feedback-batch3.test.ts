import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en inventario (WU-C, lote 3).

   Es el MISMO criterio que ya verificaron `services` (WU-B) y `alertas`,
   `vales` y `nómina` (lote 2), aplicado al último módulo que quedaba con los
   mensajes ad-hoc: cada texto de inventario era un `<p role="status">` o
   `role="alert"` inline y PERSISTENTE, así que "Producto creado." se quedaba en
   pantalla para siempre compitiendo con lo que sí importa.

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", "no se pudieron cargar los productos",
                "Este SKU ya existe en otro producto."): inline, persistente, al
                lado de la cosa -> `Alert`, que deriva el rol ARIA de la
                variante (`destructive` -> asertivo, el mismo anuncio que el
                marcado escribía a mano).
   - EVENTO  -> lo que acaba de pasar ("Producto creado.", "Movimiento
                registrado…"): efímero -> `toast`.
   - VACÍO   -> el estado base de una lista o tabla ("Sin productos para esta
                búsqueda."): describe lo esperado, NO bloquea nada y NUNCA
                anunció nada. Sigue siendo texto plano y NO se envuelve en
                `Alert`: envolverlo AGREGARÍA un anuncio que hoy no existe.
                Queda comentado y pineado.

   Un hecho, un canal: nada se anuncia por los dos.

   Offline y sin DOM (`vitest.config.ts` corre `environment: "node"`): lee los
   archivos reales —igual que services-feedback.test.ts y
   feedback-batch2.test.ts— y afirma el criterio sobre el texto del código. No
   hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

const CLIENT_PATH = join(APP_ROOT, "app", "inventory", "inventory-client.tsx");
const PAGE_PATH = join(APP_ROOT, "app", "inventory", "page.tsx");

const CLIENT_TSX = readFileSync(CLIENT_PATH, "utf8");
const PAGE_TSX = readFileSync(PAGE_PATH, "utf8");

/**
 * Código sin comentarios: un `role="alert"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo criterio que el resto de la serie.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CLIENT_CODE = stripComments(CLIENT_TSX);
const PAGE_CODE = stripComments(PAGE_TSX);

/**
 * Roles ad-hoc: cualquier `role=` escrito a mano en el módulo. Los roles de
 * estas vistas los pone la primitiva (`Alert` los deriva de la variante), no la
 * vista. Ojo: el `role="status"` de `app/inventory/loading.tsx` NO cuenta —
 * vive fuera de estos dos archivos, es el anuncio legítimo de un esqueleto de
 * carga y esta unidad no lo toca.
 */
const AD_HOC_ROLE = /\brole\s*=/g;

function adHocRoles(source: string): string[] {
  return [...source.matchAll(AD_HOC_ROLE)].map((match) => match[0]);
}

/** Las líneas del código que mencionan un texto. */
function linesWith(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text));
}

/** Cuántos `Alert` abre el módulo (para que el conteo no se vuelva decorativo). */
function alertOpenerCount(source: string): number {
  return [...source.matchAll(/<Alert\b/g)].length;
}

const ALERT_IMPORT = /import\s*\{\s*Alert\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/alert["']/;
const SONNER_TOAST_IMPORT = /import\s*\{\s*toast\s*\}\s*from\s*["']sonner["']/;

/* ==========================================================================
   El detector mismo (control negativo)
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

  it("el módulo explica el criterio en comentarios, y el stripper es quien evita el falso positivo", () => {
    // El archivo crudo SÍ menciona el rol: está en los comentarios que explican
    // por qué `destructive` ya deriva `role="alert"`. Si el stripper dejara de
    // funcionar, la guarda de "ningún rol ad-hoc" fallaría sola y este test
    // documenta por qué eso sería un falso positivo, no una regresión.
    expect(adHocRoles(CLIENT_TSX).length, "menciones en comentarios").toBeGreaterThan(0);
    expect(adHocRoles(CLIENT_CODE)).toEqual([]);
  });

  it("los dos archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(CLIENT_CODE.length, "inventory-client.tsx").toBeGreaterThan(15_000);
    expect(PAGE_CODE.length, "inventory/page.tsx").toBeGreaterThan(1_000);
    // Anclas de contenido: confirman que leímos los archivos correctos.
    expect(CLIENT_CODE).toContain("export function InventoryClient");
    expect(PAGE_CODE).toContain("export default async function InventoryPage");
  });

  it("no queda ningún rol ad-hoc en los dos archivos", () => {
    const modules: Array<[string, string]> = [
      ["app/inventory/inventory-client.tsx", CLIENT_CODE],
      ["app/inventory/page.tsx", PAGE_CODE],
    ];
    for (const [path, code] of modules) {
      expect(adHocRoles(code), `role= en ${path}`).toEqual([]);
    }
  });
});

/* ==========================================================================
   Inventario: lo efímero va por el toast (evento)
   ========================================================================== */
describe("inventario: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    // El Toaster ya está montado una sola vez en app/layout.tsx (ui-feedback.test.ts).
    expect(CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it("el alta de producto y el movimiento salen por el canal efímero", () => {
    // El alta tiene dos desenlaces y por eso es un ternario dentro de la
    // llamada: se busca cada literal ENTRE COMILLAS y ambos caen en la misma
    // línea del `toast.success`.
    for (const text of ['"Producto actualizado."', '"Producto creado."']) {
      const lines = linesWith(CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).toMatch(/toast\.success\(/);
    }
    // El movimiento lleva el stock en la copia: mismo canal.
    const movement = linesWith(CLIENT_CODE, "Movimiento registrado. Stock actual:");
    expect(movement).toHaveLength(1);
    expect(movement[0]).toMatch(/toast\.success\(/);
  });

  it("el aviso de éxito dejó de ser estado: ya no hay `notice` ni setNotice", () => {
    expect(CLIENT_CODE).not.toMatch(/setNotice/);
    expect(CLIENT_CODE).not.toMatch(/\bnotice\b/);
    // La clase del estado de éxito quedó sin consumidor: se fue con el `<p>`.
    expect(CLIENT_CODE).not.toMatch(/okClass/);
  });

  it("un hecho, un canal: los fallos NO se anuncian además por toast", () => {
    expect(CLIENT_CODE).not.toMatch(/toast\.(error|warning)\(/);
  });
});

/* ==========================================================================
   Inventario: lo persistente va por Alert (estado)
   ========================================================================== */
describe("inventario: lo persistente va por Alert (estado)", () => {
  it("el fallo al cargar o guardar es estado: Alert destructivo arriba del listado", () => {
    expect(CLIENT_CODE).toMatch(ALERT_IMPORT);
    expect(CLIENT_CODE).toMatch(/<Alert variant="destructive">\{error\}<\/Alert>/);
    expect(CLIENT_CODE).toContain(
      "const [error, setError] = useState<string | null>(null)",
    );
  });

  it("los dos fallos de los modales son el mismo estado, dentro de cada formulario", () => {
    // El `error` es compartido: se muestra arriba del listado y también dentro
    // del modal que esté abierto, ocupando las dos columnas del grid.
    const inDialogs = linesWith(
      CLIENT_CODE,
      '<Alert variant="destructive" className="sm:col-span-2">',
    );
    expect(inDialogs).toHaveLength(2);
    // Ninguno quedó como `<p>` con la clase de error suelta.
    expect(CLIENT_CODE).not.toMatch(/<p className=\{errorClass\}/);
    expect(CLIENT_CODE).not.toMatch(/errorClass/);
  });

  it("'este SKU ya existe' bloquea el alta: Alert destructivo junto al campo", () => {
    // ESTADO derivado del formulario: mientras el SKU esté tomado el botón
    // Guardar queda deshabilitado, así que el aviso sigue siendo el caso.
    // `destructive` deriva el mismo `role="alert"` asertivo que el
    // `<span role="alert">` escribía a mano: cambia el canal visual, no el
    // anuncio.
    const sku = linesWith(CLIENT_CODE, "Este SKU ya existe en otro producto.");
    expect(sku).toHaveLength(1);
    expect(CLIENT_CODE).toMatch(
      /<Alert variant="destructive" className="text-xs">\s*Este SKU ya existe en otro producto\./,
    );
  });

  it("no se inventaron avisos: el módulo tiene exactamente cuatro Alert, todos destructivos", () => {
    // Uno por el error de carga/guardado arriba, dos por el mismo error dentro
    // de cada modal y uno por el SKU tomado. Si apareciera un quinto (o alguien
    // cambiara una variante), el conteo lo delata.
    expect(alertOpenerCount(CLIENT_CODE)).toBe(4);
    expect([...CLIENT_CODE.matchAll(/<Alert\b/g)]).toHaveLength(4);
    expect([...CLIENT_CODE.matchAll(/variant="destructive"/g)]).toHaveLength(4);
    // Ni un `warning` ni un `info` ni un `success` de `Alert` por acá: no hay
    // precondiciones pendientes en este módulo que merezcan la variante de
    // aviso (el único `warning` del archivo es el `Badge` de "Bajo mínimo",
    // que no es un mensaje).
    expect(CLIENT_CODE).not.toMatch(/<Alert\s+variant="warning"/);
    expect(CLIENT_CODE).not.toMatch(/<Alert\s+variant="info"/);
    expect(CLIENT_CODE).not.toMatch(/<Alert\s+variant="success"/);
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(PAGE_CODE).toMatch(
      /<Alert variant="destructive">El usuario no tiene sede asignada\.<\/Alert>/,
    );
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(PAGE_CODE).not.toMatch(/\btoast\b/);
    expect(adHocRoles(PAGE_CODE)).toEqual([]);
  });
});

/* ==========================================================================
   Inventario: el texto visible no cambió (cambia el canal, no la copia)
   ========================================================================== */
describe("inventario: el texto visible no cambió (cambia el canal, no la copia)", () => {
  it("las copias del módulo siguen ahí, palabra por palabra", () => {
    for (const text of [
      "Producto actualizado.",
      "Producto creado.",
      "Movimiento registrado. Stock actual:",
      "Este SKU ya existe en otro producto.",
      "Sin productos para esta búsqueda.",
      "Sin coincidencias.",
      "Sin movimientos registrados.",
      "Buscar por nombre o SKU",
      "Código único por sede (p. ej. SH-001 para shampoo).",
    ]) {
      expect(CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(PAGE_CODE, "página: encabezado").toContain(
      "Productos, stock, kardex y alertas de mínimo de su sede.",
    );
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(CLIENT_CODE).not.toContain("Producto guardado.");
    expect(CLIENT_CODE).not.toContain("Inventario actualizado.");
    expect(PAGE_CODE).not.toContain("Sin sede asignada.");
  });

  it("los tres vacíos siguen siendo texto plano, no avisos", () => {
    // Describen lo esperado, no bloquean nada y nunca anunciaron nada: siguen
    // en su clase de texto terciario/secundario y NO se envuelven en `Alert`
    // (eso agregaría un anuncio que hoy no existe).
    const empties: Array<[string, string]> = [
      ["Sin productos para esta búsqueda.", "text-text-tertiary"],
      ["Sin coincidencias.", "text-text-secondary"],
      ["Sin movimientos registrados.", "text-text-tertiary"],
    ];
    for (const [text, color] of empties) {
      const lines = linesWith(CLIENT_CODE, text);
      expect(lines, text).toHaveLength(1);
      expect(lines[0], text).not.toContain("Alert");
      expect(lines[0], text).toContain(color);
    }
  });
});
