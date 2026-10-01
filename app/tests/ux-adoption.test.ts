import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guarda de adopción del estándar (WU6d).

   Los primitivos existen (`Tabs`, `FormDialog`/`ConfirmDialog`, `DataTable`,
   `EmptyState`) y cada uno tiene su contrato pineado en su propio test. Lo que
   faltaba era el cierre del círculo: apuntar esos contratos AL ÁRBOL entero,
   para que el próximo archivo no reintroduzca el defecto que el primitivo vino
   a eliminar. Esta guarda es ese cierre, y cada sección de
   `app/docs/ux-ui-standard.md` §10 queda así con su test.

   Método: no hay DOM ni render en este setup (`environment: "node"` es el
   default de `vitest.config.ts`). Todo se lee del fuente real con `node:fs`,
   caminando desde la raíz de la app como `tests/no-raw-palette.test.ts`.

   Conteo por TOKEN DE CLASE COMPLETO y predicados POR BLOQUE, nunca por
   substring ni por archivo: este repositorio se quemó dos veces con greps de
   substring (`text-text-primary` TERMINA en `text-primary`; `border-border`
   MATCHEA `border-border-color`), y un conteo por archivo igualaría un archivo
   con 2 modales y 2 títulos con uno con 2 modales y 1 título. Los controles
   negativos de esas dos trampas están al final, explícitos.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** Directorios que no son código de producción (mismo criterio que `no-raw-palette.test.ts`). */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests"]);

/** Código sin comentarios: una clase o una etiqueta nombrada al EXPLICAR algo no está aplicada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/* --------------------------------------------------------------------------
   1. Todo `DialogContent` del árbol lleva su `DialogTitle` (estándar §4).

   El predicado es el MISMO que `tests/ux-dialog.test.ts` declara para la
   primitiva (por bloque, con su control negativo): acá se apunta al árbol
   entero, que es la continuación que ese archivo ya anunciaba. Se copia en vez
   de importarse porque los tests no se importan entre sí.
   -------------------------------------------------------------------------- */

/** `DialogContent`s cuyo bloque no contiene un `DialogTitle`. */
function dialogsWithoutTitle(source: string): string[] {
  const clean = stripComments(source);
  const violations: string[] = [];
  for (const segment of clean.split("<DialogContent").slice(1)) {
    const end = segment.indexOf("</DialogContent>");
    const block = end >= 0 ? segment.slice(0, end) : segment;
    if (!/<DialogTitle\b/.test(block)) {
      violations.push("<DialogContent>");
    }
  }
  return violations;
}

/** Cuántas aperturas `<DialogContent` EXACTAS hay (con delimitador: `<DialogContentX` no cuenta). */
function countDialogContent(source: string): number {
  return stripComments(source).match(/<DialogContent(?=[\s/>])/g)?.length ?? 0;
}

/** Contenido de todos los `.ts`/`.tsx` de producción, indexado por ruta relativa. */
function readProductionSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      const path = join(dir, entry.name);
      files.set(path.slice(APP_ROOT.length + 1).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(APP_ROOT);
  return files;
}

/**
 * Ofensores conocidos, con su conteo EXACTO. Si un archivo permitido suma o
 * pierde un diálogo sin título, el conteo deja de coincidir y la guarda falla:
 * agregar un SÉPTIMO diálogo sin título —o uno en cualquier otro archivo—
 * falla. Misma honestidad que `no-raw-palette.test.ts`: lo permitido es lo que
 * otra tanda ya posee, no una aspiración.
 */
const TITLE_ALLOWLIST = new Map<string, { titleless: number; reason: string }>([
  [
    "app/invoices/invoices-client.tsx",
    {
      titleless: 6,
      reason:
        "F1 en `odd/tasks/ajustes-post-lote.md`: los 6 `DialogContent` sin " +
        "`DialogTitle` heredados. Su uniformidad (`DialogHeader`/`Footer`, " +
        "tokens) es una tanda propia diferida, no deuda olvidada.",
    },
  ],
]);

const SOURCES = readProductionSources();

/** Total de bloques `DialogContent` en el árbol (para el piso anti-vacío). */
function totalDialogBlocks(): number {
  let total = 0;
  for (const source of SOURCES.values()) {
    total += countDialogContent(source);
  }
  return total;
}

describe("adopción de diálogos: el walk leyó el árbol real (piso anti-vacío)", () => {
  it("el walk leyó los archivos de producción y VE diálogos", () => {
    // Sin este piso, un walk roto (p. ej. cwd distinto) haría pasar la guarda sola.
    expect(SOURCES.size, "archivos .ts/.tsx de producción leídos").toBeGreaterThan(100);
    // Los 6 de facturación más los que el panel admin escribe a mano con su
    // título (vista de empleado, confirmación de vales): si el walk no viera
    // ninguno, la afirmación de abajo pasaría sin haber mirado nada.
    expect(totalDialogBlocks(), "bloques `DialogContent` vistos en el árbol").toBeGreaterThanOrEqual(6);
  });
});

describe("adopción de diálogos: todo `DialogContent` se anuncia con nombre", () => {
  it("ningún archivo fuera de la lista permitida deja un diálogo sin `DialogTitle`", () => {
    const offenders: string[] = [];
    for (const [path, source] of SOURCES) {
      if (TITLE_ALLOWLIST.has(path)) {
        continue;
      }
      const violations = dialogsWithoutTitle(source);
      if (violations.length > 0) {
        offenders.push(`${path}: ${violations.length} diálogo(s) sin título`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("los archivos permitidos tienen exactamente los diálogos sin título declarados", () => {
    const failures: string[] = [];
    for (const [path, { titleless: expected }] of TITLE_ALLOWLIST) {
      const source = SOURCES.get(path);
      if (source === undefined) {
        failures.push(`${path}: permitido pero no existe (entrada muerta)`);
        continue;
      }
      const found = dialogsWithoutTitle(source).length;
      if (found !== expected) {
        failures.push(`${path}: se esperaban ${expected} diálogos sin título, hay ${found}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   2. El panel admin no escribe a mano el vocabulario que ya es del primitivo
   (estándar §3 y §5): ni `role="tab"`/`role="tablist"` (el `Tabs` los declara:
   con `tabpanel`, `aria-controls`, `tabIndex` rotativo y flechas), ni
   `min-w-[Npx]` (la escala es single-homed en `DataTable`).
   -------------------------------------------------------------------------- */

const ADMIN_PREFIX = "app/admin/";

/** Fuentes de producción bajo `app/admin/`, por ruta relativa. */
function adminSources(): Map<string, string> {
  return new Map([...SOURCES].filter(([path]) => path.startsWith(ADMIN_PREFIX)));
}

/**
 * Vocabulario de pestaña escrito a mano: `role="tab"` o `role="tablist"`.
 * Solo esos dos valores: `role="tabpanel"` no lo escribe nadie a mano en el
 * panel (lo declara el primitivo), y los roles de feedback (`status`/`alert`)
 * son otro canal con su propia guarda.
 */
function handRolledTabRoles(source: string): string[] {
  return stripComments(source).match(/\brole\s*=\s*["']tab(list)?["']/g) ?? [];
}

/** Un token de clase incluye variantes, utilidad y el arbitrario `[NNNpx]` entero. */
const CLASS_TOKEN = /[A-Za-z0-9_:./[\]%-]+/g;

/** Solo el piso INVENTADO: `min-w-[420px]`. `min-w-full` no matchea. */
const INVENTED_MIN_WIDTH = /^min-w-\[\d+px\]$/;

/**
 * Los `min-w-[Npx]` de un fragmento. La variante (`md:`) se descarta y
 * `min-w-full` NO cuenta: es una utilidad de Tailwind, no un valor inventado
 * (mismo criterio que `tests/ux-data-table.test.ts`).
 */
function inventedMinWidths(source: string): string[] {
  const found: string[] = [];
  for (const line of stripComments(source).split(/\r?\n/)) {
    for (const match of line.matchAll(CLASS_TOKEN)) {
      const token = match[0];
      const utility = token.split(":").pop() ?? token;
      if (INVENTED_MIN_WIDTH.test(utility)) {
        found.push(utility);
      }
    }
  }
  return found;
}

describe("adopción en admin: el vocabulario de pestaña lo declara el primitivo", () => {
  it("ningún archivo bajo `app/admin/` escribe `role=\"tab\"` ni `role=\"tablist\"` a mano", () => {
    const offenders: string[] = [];
    for (const [path, source] of adminSources()) {
      const found = handRolledTabRoles(source);
      if (found.length > 0) {
        offenders.push(`${path}: ${found.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("adopción en admin: el piso de tabla vive solo en `DataTable`", () => {
  it("ningún archivo bajo `app/admin/` inventa un `min-w-[Npx]`", () => {
    const offenders: string[] = [];
    for (const [path, source] of adminSources()) {
      const found = inventedMinWidths(source);
      if (found.length > 0) {
        offenders.push(`${path}: ${found.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   3. Controles negativos: que la guarda ACUSE, y prueba de que el séptimo
   diálogo fallaría (mutación sintética sobre el fuente REAL, sin tocar el
   árbol: el archivo de producción no se modifica, se le agrega el bloque roto
   en memoria y se comprueba que el MISMO predicado lo acusa).
   -------------------------------------------------------------------------- */

describe("control negativo: la guarda de nombre accesible acusa de verdad", () => {
  it("reporta un `DialogContent` sin `DialogTitle`", () => {
    expect(dialogsWithoutTitle("<DialogContent><p>hola</p></DialogContent>")).toEqual([
      "<DialogContent>",
    ]);
  });

  it("cuenta POR BLOQUE: dos modales con un solo título siguen siendo una violación", () => {
    const sample =
      "<DialogContent><DialogTitle>a</DialogTitle></DialogContent>" +
      "<DialogContent><p>sin nombre</p></DialogContent>";
    expect(dialogsWithoutTitle(sample)).toEqual(["<DialogContent>"]);
  });

  it("un SÉPTIMO diálogo sin título en facturación rompería la allowlist exacta", () => {
    // El fuente real, más el bloque que alguien agregaría: el conteo deja de
    // ser 6 y la afirmación de arriba falla. Sin conteo exacto, este séptimo
    // pasaría de largo.
    const real = SOURCES.get("app/invoices/invoices-client.tsx") ?? "";
    expect(real, "el archivo permitido está en el walk").not.toBe("");
    const withSeventh = `${real}<DialogContent><p>nuevo modal</p></DialogContent>`;
    expect(dialogsWithoutTitle(withSeventh)).toHaveLength(7);
    expect(7).not.toBe(TITLE_ALLOWLIST.get("app/invoices/invoices-client.tsx")?.titleless);
  });

  it("un diálogo sin título en CUALQUIER otro archivo se acusa por bloque", () => {
    // El `admin-tabs.tsx` real, sano, más un bloque roto en memoria: el
    // predicado lo acusa aunque el archivo en disco siga intacto.
    const tabs = SOURCES.get("app/admin/admin-tabs.tsx") ?? "";
    expect(tabs, "admin-tabs está en el walk").not.toBe("");
    expect(dialogsWithoutTitle(tabs)).toEqual([]);
    expect(dialogsWithoutTitle(`${tabs}<DialogContent><p>roto</p></DialogContent>`)).toEqual([
      "<DialogContent>",
    ]);
  });
});

describe("control negativo: el vocabulario a mano en admin se acusa", () => {
  it("un `role=\"tab\"` agregado a un archivo sano del panel se reporta", () => {
    const tabs = SOURCES.get("app/admin/admin-tabs.tsx") ?? "";
    expect(handRolledTabRoles(tabs)).toEqual([]);
    expect(handRolledTabRoles(`${tabs}<div role="tab">x</div>`)).toEqual(['role="tab"']);
    expect(handRolledTabRoles(`${tabs}<div role="tablist">x</div>`)).toEqual(['role="tablist"']);
  });

  it("un `min-w-[Npx]` agregado a un archivo sano del panel se reporta, y `min-w-full` no", () => {
    const taxes = SOURCES.get("app/admin/admin-sections/taxes-section.tsx") ?? "";
    expect(inventedMinWidths(taxes)).toEqual([]);
    expect(inventedMinWidths(`${taxes} min-w-[777px]`)).toEqual(["min-w-[777px]"]);
    // `min-w-full` es la utilidad de Tailwind, no un valor inventado.
    expect(inventedMinWidths(`${taxes} min-w-full`)).toEqual([]);
  });

  it("ni el rol ni el piso se cuentan cuando solo se NOMBRAN en un comentario", () => {
    expect(handRolledTabRoles('// role="tab" estaba acá\n/* role="tablist" */')).toEqual([]);
    expect(inventedMinWidths("// min-w-[420px]\n/* min-w-[999px] */")).toEqual([]);
  });
});
