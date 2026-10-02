import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Criterio estado-vs-evento en el módulo de servicios (WU-B).

   El defecto que esta unidad arregla: hoy todo mensaje del módulo es un
   `<p role="status">` (o `role="alert"`) inline y PERSISTENTE, así que
   "Servicio creado." se queda en pantalla para siempre y compite con los
   mensajes que sí importan. Son dos cosas distintas y merecen dos canales:

   - ESTADO  -> lo que ES el caso hasta que algo cambie ("El usuario no tiene
                sede asignada.", "no se pudo guardar"): inline, persistente, al
                lado de la cosa -> `Alert` (que deriva el rol ARIA de la
                variante).
   - EVENTO  -> lo que acaba de pasar ("Servicio creado."): efímero -> `toast`.

   Un hecho, un canal: nada se anuncia por los dos.

   Este test es offline y sin DOM (`vitest.config.ts` corre `environment: "node"`):
   lee los archivos reales —igual que ui-feedback.test.ts y design-tokens.test.ts—
   y afirma el criterio sobre el texto del código. No hay render.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const CLIENT_PATH = join(APP_ROOT, "app", "services", "services-client.tsx");
const PAGE_PATH = join(APP_ROOT, "app", "services", "page.tsx");

const CLIENT_TSX = readFileSync(CLIENT_PATH, "utf8");
const PAGE_TSX = readFileSync(PAGE_PATH, "utf8");

/**
 * Código sin comentarios: un `role="status"` mencionado al EXPLICAR el criterio
 * no es un rol aplicado en el JSX. Mismo criterio que ui-feedback.test.ts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CLIENT_CODE = stripComments(CLIENT_TSX);
const PAGE_CODE = stripComments(PAGE_TSX);

/**
 * Roles ad-hoc: cualquier `role=` escrito a mano en el módulo. Los roles de
 * estas vistas los pone la primitiva (`Alert` los deriva de la variante), no
 * la vista.
 */
const AD_HOC_ROLE = /\brole\s*=/g;

function adHocRoles(source: string): string[] {
  return [...source.matchAll(AD_HOC_ROLE)].map((match) => match[0]);
}

/** Las líneas del código que mencionan un texto. */
function linesWith(source: string, text: string): string[] {
  return source.split("\n").filter((line) => line.includes(text));
}

/** Los textos de evento de este módulo, tal como se ven en pantalla. */
const EVENTS = ["Servicio creado.", "Servicio actualizado."] as const;

/** El texto del fallo al guardar: estado, no evento. */
const SAVE_ERROR = "[${result.code}] ${result.message}";

const ALERT_IMPORT = /import\s*\{\s*Alert\s*\}\s*from\s*["']@\/src\/components\/ui\/lib\/alert["']/;
const SONNER_TOAST_IMPORT = /import\s*\{\s*toast\s*\}\s*from\s*["']sonner["']/;

describe("servicios: no queda ningún rol ad-hoc en el módulo", () => {
  it("los dos archivos se leyeron de verdad (si el walk se rompe, esto falla)", () => {
    // Pisos: un archivo vacío o mal leído no debe dejar pasar las guardas solas.
    expect(CLIENT_CODE.length, "services-client.tsx").toBeGreaterThan(5_000);
    expect(PAGE_CODE.length, "page.tsx").toBeGreaterThan(500);
    // Anclas de contenido: confirman que leímos los archivos correctos.
    expect(CLIENT_CODE, "componente cliente").toContain("export function ServicesClient");
    expect(PAGE_CODE, "página servidor").toContain("export default async function ServicesPage");
  });

  it("el cliente no escribe roles a mano", () => {
    expect(adHocRoles(CLIENT_CODE), "role= en services-client.tsx").toEqual([]);
  });

  it("la página tampoco escribe roles a mano", () => {
    expect(adHocRoles(PAGE_CODE), "role= en page.tsx").toEqual([]);
  });

  it("el detector no es un sello de goma: sí marca los roles escritos a mano", () => {
    // Control negativo del detector. Cubre las dos formas que el repositorio
    // tenía escritas: el rol fijo y el rol condicional.
    const fijo = `<p role="status">ok</p><div role="alert">err</div>`;
    const condicional = `<p role={message.kind === "error" ? "alert" : "status"}>x</p>`;
    expect(adHocRoles(fijo)).toHaveLength(2);
    expect(adHocRoles(condicional)).toHaveLength(1);

    // Y el stripper no borra código real: solo comentarios.
    expect(stripComments(fijo)).toBe(fijo);
    expect(adHocRoles(stripComments(`/* role="status" */`))).toEqual([]);
  });
});

describe("servicios: lo efímero va por el toast (evento)", () => {
  it("el cliente importa el toast de sonner y NO monta un segundo Toaster", () => {
    expect(CLIENT_CODE).toMatch(SONNER_TOAST_IMPORT);
    // El Toaster ya está montado una sola vez en app/layout.tsx (ui-feedback.test.ts).
    expect(CLIENT_CODE).not.toMatch(/<Toaster\b/);
  });

  it('"Servicio creado." y "Servicio actualizado." salen por toast.success', () => {
    for (const text of EVENTS) {
      const lines = linesWith(CLIENT_CODE, text);
      // Exactamente una línea por texto: aparece en el canal efímero…
      expect(lines, text).toHaveLength(1);
      // …y esa línea es la llamada al toast, no un `<p>` persistente.
      expect(lines[0], text).toMatch(/toast\.success\(/);
    }
  });

  it("el aviso de éxito dejó de ser estado: ya no hay `notice` ni setNotice", () => {
    expect(CLIENT_CODE).not.toMatch(/setNotice/);
    expect(CLIENT_CODE).not.toMatch(/\bnotice\b/);
  });

  it("un hecho, un canal: el fallo al guardar NO se anuncia además por toast", () => {
    expect(CLIENT_CODE).not.toMatch(/toast\.(error|warning)\(/);
  });
});

describe("servicios: lo persistente va por Alert (estado)", () => {
  it("el fallo al guardar es estado: Alert destructivo junto al formulario", () => {
    expect(CLIENT_CODE).toMatch(ALERT_IMPORT);
    // El Alert envuelve EXACTAMENTE el texto de error del formulario.
    expect(CLIENT_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}\{error\}[\s\S]{0,40}<\/Alert>/,
    );
    // Y el texto visible se conserva, formato [código] incluido.
    expect(CLIENT_CODE).toContain(SAVE_ERROR);
  });

  it("la página es Server Component: su aviso es estado y no puede ser toast", () => {
    expect(PAGE_CODE).toMatch(ALERT_IMPORT);
    expect(PAGE_CODE).toMatch(
      /<Alert\s+variant="destructive"[\s\S]{0,160}El usuario no tiene sede asignada\.[\s\S]{0,40}<\/Alert>/,
    );
    // El límite del servidor es la razón del criterio: sin cliente no hay toast.
    expect(PAGE_CODE).not.toMatch(/["']use client["']/);
    expect(PAGE_CODE).not.toContain("sonner");
    expect(PAGE_CODE).not.toMatch(/\btoast\b/);
  });

  it("el Alert derivado de la variante es el que anuncia (no hay role explícito)", () => {
    // `destructive` -> role="alert" asertivo: mismo anuncio que antes, sin
    // escribirlo a mano. Se afirma sobre la primitiva, no sobre un render.
    expect(CLIENT_CODE).toMatch(/variant="destructive"/);
    expect(PAGE_CODE).toMatch(/variant="destructive"/);
  });
});

describe("servicios: el texto visible no cambió (cambia el canal, no la copia)", () => {
  it("los cuatro textos del módulo siguen ahí, palabra por palabra", () => {
    const expected = [
      ...EVENTS,
      SAVE_ERROR,
      "Aún no hay servicios en esta sede.",
      "Servicios de la sede",
      "Qué servicios se brindan, con su precio y duración estimada.",
    ];
    for (const text of expected) {
      expect(CLIENT_CODE, `cliente: ${text}`).toContain(text);
    }
    expect(PAGE_CODE, "página: sede").toContain("El usuario no tiene sede asignada.");
    expect(PAGE_CODE, "página: catálogo").toContain(
      "Catálogo de servicios de la sede: qué se brinda, con precio y duración estimada.",
    );
  });

  it("no se reescribió la copia (control negativo del 'contiene')", () => {
    expect(CLIENT_CODE).not.toContain("Servicio guardado.");
    expect(CLIENT_CODE).not.toContain("Servicios actualizados.");
    expect(PAGE_CODE).not.toContain("Sin sede asignada.");
  });

  it("el placeholder de lista vacía sigue siendo texto de tabla, no un aviso", () => {
    // Nunca anunció nada (no tenía rol) y vive donde iría la tabla: no compite
    // con ningún mensaje, así que no se convierte en Alert.
    const lines = linesWith(CLIENT_CODE, "Aún no hay servicios en esta sede.");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("Alert");
  });
});

/* --------------------------------------------------------------------------
   Servicios: las duraciones sólo aceptan dígitos (guarda de fuente)

   La duración mínima y máxima son MINUTOS enteros. `inputMode="numeric"` es
   una pista del teclado, no una validación: una letra tecleada llegaba al
   estado. Los dos campos pasan por `stripQuantityInput` antes de escribir el
   estado; esta guarda falla si alguien quita el cable.
   -------------------------------------------------------------------------- */
describe("servicios: las duraciones sólo aceptan dígitos (guarda de fuente)", () => {
  /** Bloque `onChange={...}` cuyo cuerpo contiene `anchor` ("" si no existe). */
  function onChangeBlock(text: string, anchor: string): string {
    const at = text.indexOf(anchor);
    if (at === -1) return "";
    const start = text.lastIndexOf("onChange={", at);
    if (start === -1) return "";
    let depth = 0;
    for (let i = start + "onChange=".length; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return text.slice(start);
  }

  it("piso anti-vacío: el cliente se leyó de verdad", () => {
    expect(CLIENT_TSX.length).toBeGreaterThan(5_000);
    expect(CLIENT_TSX).toContain("stripQuantityInput");
  });

  it("la duración mínima filtra antes de escribir el estado", () => {
    const block = onChangeBlock(CLIENT_TSX, "duracion_min: stripQuantityInput");
    expect(block, "campo duración mínima").not.toBe("");
    expect(block).toContain("stripQuantityInput(event.target.value)");
    expect(block).not.toContain("duracion_min: event.target.value");
  });

  it("la duración máxima filtra antes de escribir el estado", () => {
    const block = onChangeBlock(CLIENT_TSX, "duracion_max: stripQuantityInput");
    expect(block, "campo duración máxima").not.toBe("");
    expect(block).toContain("stripQuantityInput(event.target.value)");
    expect(block).not.toContain("duracion_max: event.target.value");
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    const fake = `<Input onChange={(event) => setForm({ ...form, duracion_min: event.target.value })} />`;
    const block = onChangeBlock(fake, "duracion_min:");
    expect(block).not.toBe("");
    // Sin el cable al helper, la misma guarda falla.
    expect(block).not.toContain("stripQuantityInput(event.target.value)");
    // Sin el ancla no hay bloque: la guarda falla en vez de pasar sola.
    expect(onChangeBlock(fake, "no-existe:")).toBe("");
  });
});
