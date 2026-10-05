import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataTable, type DataTableMinWidth } from "@/src/components/ui/lib/data-table";

/* --------------------------------------------------------------------------
   Contrato de `DataTable` (U-DataTable).

   El defecto que esta guarda cierra: hoy cada llamador escribe a mano el mismo
   envoltorio (`<div className="overflow-x-auto">`), la misma
   `<table className="min-w-full text-left text-sm">` y, cuando la tabla no
   entra, su PROPIO piso de ancho inventado (`min-w-[420px]`, `[880px]`,
   `[1040px]`...). Medido en el árbol: 16 envoltorios a mano y 18 pisos
   distintos. Sin un primitivo, la tabla 20 no se parece a la tabla 1.

   LA INVARIANTE QUE ESTA GUARDA PROTEGE ES UNA SOLA: el `min-w-[Npx]` tiene UN
   hogar en producción —`MIN_WIDTH` dentro de `data-table.tsx`— y sus cinco
   pasos son EXACTAMENTE los valores que el árbol ya renderiza, así que migrar un
   llamador no mueve un píxel. Un piso nuevo escrito en un feature es deuda
   nueva, y esto lo rechaza.

   DEUDA PREEXISTENTE, CON CONTEO EXACTO: los pisos inventados que ya existían
   —`payroll-client.tsx`, `invoices-client.tsx`, `cash-client.tsx`,
   `inventory-client.tsx`, `services-client.tsx`, `vouchers-client.tsx`— quedan
   en ALLOWLIST con su conteo real por archivo, igual que en
   `no-raw-palette.test.ts`. Agregar un piso nuevo a un archivo permitido también
   falla: el conteo deja de coincidir. Estos son la deuda que otra unidad migra;
   esta unidad NO toca ningún consumidor.

   POR QUÉ TOKENS Y NO SUBSTRINGS: este repo se quemó dos veces con grep de
   substring (`text-text-primary` termina en `text-primary`; `border-border`
   matchea `border-border-color`). Acá el detector corta la fuente en tokens de
   clase y exige coincidencia COMPLETA: `xmin-w-[420px]` no cuenta, y
   `min-w-[420px]0` tampoco. `min-w-full` NO es una violación: es la utilidad que
   Tailwind ya trae, no un valor inventado; solo cuenta `min-w-[<dígitos>px]`.

   ALCANCE: todos los `.ts`/`.tsx` de producción bajo la raíz de la app,
   salteando `node_modules`, `.next`, `.git` y `tests`. Se camina desde la raíz
   de la app (no solo `src/`) porque la deuda vive también en `app/<módulo>/`, y
   `tests/` queda afuera porque este mismo archivo nombra los pisos al
   explicarlos.

   MÉTODO DE RENDER: `environment: "node"`, sin DOM. Lo que se afirma es de dos
   clases: lo que se puede EJECUTAR de verdad (el módulo se importa, se renderiza
   a HTML con `react-dom/server` y se leen las clases reales) y lo que solo se
   puede leer del fuente (la escala single-homed y la forma del detector).
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** El primitivo es el único hogar legítimo de un `min-w-[Npx]`. */
const PRIMITIVE_PATH = "src/components/ui/lib/data-table.tsx";
const PRIMITIVE_ABS = join(APP_ROOT, "src", "components", "ui", "lib", "data-table.tsx");

/** Mismo criterio de exclusión que `no-raw-palette.test.ts` y `design-tokens.test.ts`. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests"]);

/* --------------------------------------------------------------------------
   La escala, afirmada desde afuera. Repetirla acá es a propósito: es el
   CONTRATO del primitivo. Si `MIN_WIDTH` cambia un valor o el default, esto
   falla aunque el fuente compile.
   -------------------------------------------------------------------------- */
const EXPECTED_MIN_WIDTH: Record<DataTableMinWidth, string | null> = {
  none: null,
  sm: "min-w-[420px]",
  md: "min-w-[560px]",
  lg: "min-w-[880px]", // el default
  xl: "min-w-[960px]",
  "2xl": "min-w-[1040px]",
};

const WIDTH_STEPS = Object.keys(EXPECTED_MIN_WIDTH) as DataTableMinWidth[];

/** Los cinco valores que ya estaban en uso: los únicos que el primitivo puede declarar. */
const DATA_TABLE_MIN_WIDTHS = ["420", "560", "880", "960", "1040"] as const;
const SANCTIONED_TOKENS = new Set(DATA_TABLE_MIN_WIDTHS.map((value) => `min-w-[${value}px]`));

/* --------------------------------------------------------------------------
   Detector: tokens de clase completos, nunca substrings.
   -------------------------------------------------------------------------- */

/** Un token de clase incluye variantes, utilidad y el arbitrario `[NNNpx]` entero. */
const CLASS_TOKEN = /[A-Za-z0-9_:./[\]%-]+/g;

/** Solo el piso INVENTADO: `min-w-[420px]`. `min-w-full` no matchea. */
const INVENTED_MIN_WIDTH = /^min-w-\[\d+px\]$/;

/** Código sin comentarios: un piso nombrado al EXPLICAR algo no está aplicado. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Los `min-w-[Npx]` de un fragmento. La variante (`md:`) se descarta: el piso es
 * el piso, se aplique cuando se aplique.
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
 * La deuda preexistente, con su conteo EXACTO por archivo (medido sobre el
 * árbol real, no copiado del enunciado). Son los pisos que ya existían antes de
 * este primitivo y que otra unidad migra; esta unidad no toca ningún consumidor.
 * Si un archivo permitido suma un piso, el conteo deja de coincidir y la guarda
 * falla: un `min-w-[Npx]` nuevo es deuda nueva.
 *
 * Y si una unidad MIGRA un consumidor al primitivo, el número BAJA en la misma
 * medida: ese es el modo de pagar la deuda. Las dos tablas de liquidación de
 * `payroll-client.tsx` ya lo hicieron (6 → 4); el archivo todavía tiene cuatro
 * pisos a mano, pero ninguno es el de esas dos tablas.
 */
const ALLOWLIST = new Map<string, number>([
  ["app/cash/cash-client.tsx", 1],
  ["app/inventory/inventory-client.tsx", 2],
  ["app/invoices/invoices-client.tsx", 7],
  ["app/payroll/payroll-client.tsx", 4],
  ["app/services/services-client.tsx", 1],
  // La lista de vales ya no es una `<table min-w-[760px]>` dentro de un carril:
  // es la tarjeta de R-e2 (abajo de `sm`) sobre una grilla de seis columnas
  // (arriba). El piso no se transladó a otro lado —la fila no declara ningún
  // `min-w-[Npx]`—, así que su deuda baja a CERO y la entrada se queda como
  // testigo de que se pagó, no como permiso.
  ["app/vales/vouchers-client.tsx", 0],
]);

const SOURCES = readProductionSources();

/**
 * El MISMO predicado que usa la guarda, expuesto aparte para el control
 * negativo. Devuelve las violaciones de un archivo:
 *   - el primitivo: solo los cinco valores permitidos, cada uno una sola vez;
 *   - un archivo permitido: exactamente el conteo declarado;
 *   - cualquier otro: cero.
 */
function minWidthViolations(path: string, source: string): string[] {
  const found = inventedMinWidths(source);
  if (path === PRIMITIVE_PATH) {
    const unexpected = found.filter((token) => !SANCTIONED_TOKENS.has(token));
    const duplicated = [...SANCTIONED_TOKENS].filter(
      (token) => found.filter((hit) => hit === token).length > 1,
    );
    return [...unexpected, ...duplicated.map((token) => `${token}: duplicado en el primitivo`)];
  }
  const allowed = ALLOWLIST.get(path);
  if (allowed === undefined) {
    return found;
  }
  return found.length === allowed
    ? []
    : [`${path}: se esperaban ${allowed} pisos inventados, hay ${found.length}`];
}

/* --------------------------------------------------------------------------
   Render real (sin DOM): `react-dom/server` sobre el elemento del primitivo.
   -------------------------------------------------------------------------- */

const SAMPLE_ROWS = createElement(
  "tbody",
  null,
  createElement("tr", null, createElement("td", null, "una celda")),
);

function renderTable(minWidth?: DataTableMinWidth, wrapperClassName?: string, className?: string): string {
  return renderToStaticMarkup(DataTable({ minWidth, wrapperClassName, className, children: SAMPLE_ROWS }));
}

/** Tokens de clase del primer tag `tag` del HTML renderizado. */
function classTokens(html: string, tag: "div" | "table"): string[] {
  const match = new RegExp(`<${tag}\\b[^>]*\\bclass="([^"]*)"`).exec(html);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe("DataTable: el módulo existe y exporta su contrato", () => {
  it("exporta el componente y el tipo de la escala", () => {
    expect(typeof DataTable).toBe("function");
    // El tipo no existe en runtime: se afirma su declaración en el fuente real.
    const source = readFileSync(PRIMITIVE_ABS, "utf8");
    expect(source).toMatch(/export\s+type\s+DataTableMinWidth\s*=\s*keyof\s+typeof\s+MIN_WIDTH/);
  });

  it("la escala son exactamente los pasos declarados (evidencia de tipo)", () => {
    // Si `DataTableMinWidth` perdiera un paso, este arreglo no compilaría.
    expect(WIDTH_STEPS).toEqual(["none", "sm", "md", "lg", "xl", "2xl"]);
  });
});

describe("DataTable renderiza el carril con scroll y aplica la escala", () => {
  it("el envoltorio es `overflow-x-auto` y contiene a la `<table>`", () => {
    const html = renderTable("sm");
    expect(classTokens(html, "div")).toContain("overflow-x-auto");
    expect(html).toMatch(/<div class="[^"]*overflow-x-auto[^"]*">\s*<table/);
  });

  it("el piso va a la `<table>`, no al envoltorio", () => {
    const html = renderTable("sm");
    expect(classTokens(html, "table")).toContain("min-w-[420px]");
    expect(classTokens(html, "div")).not.toContain("min-w-[420px]");
  });

  it("sin `minWidth` el default es `lg` (880px)", () => {
    const html = renderTable();
    expect(classTokens(html, "table")).toContain(EXPECTED_MIN_WIDTH.lg as string);
  });

  it("cada paso de la escala rinde su token, y `none` no fija ningún piso", () => {
    for (const step of WIDTH_STEPS) {
      const tableClasses = classTokens(renderTable(step), "table");
      const expected = EXPECTED_MIN_WIDTH[step];
      const pisos = tableClasses.filter((token) => INVENTED_MIN_WIDTH.test(token));
      if (expected === null) {
        expect(pisos, `paso "${step}" no debe fijar piso`).toEqual([]);
      } else {
        expect(pisos, `paso "${step}"`).toEqual([expected]);
      }
    }
  });

  it("el espaciado del llamador va al envoltorio y `className` a la tabla", () => {
    const html = renderTable("md", "mt-3", "align-middle");
    expect(classTokens(html, "div")).toContain("mt-3");
    expect(classTokens(html, "table")).toContain("align-middle");
    expect(classTokens(html, "div")).not.toContain("align-middle");
    expect(classTokens(html, "table")).not.toContain("mt-3");
  });
});

describe("detector de pisos inventados: importa el token, no el substring", () => {
  it("detecta un piso inventado y no una cadena de control", () => {
    expect(inventedMinWidths('className="min-w-[777px]"')).toEqual(["min-w-[777px]"]);
  });

  it("`min-w-full` NO es una violación: es la utilidad de Tailwind, no un valor inventado", () => {
    expect(inventedMinWidths('className="min-w-full overflow-x-auto"')).toEqual([]);
  });

  it("no cuenta un identificador que solo CONTIENE un piso", () => {
    expect(inventedMinWidths("const xmin-w-[420px] = 1; min-w-[420px]0")).toEqual([]);
  });

  it("no cuenta un piso nombrado en un comentario", () => {
    expect(inventedMinWidths('// min-w-[420px]\n/* min-w-[999px] */')).toEqual([]);
  });

  it("el control negativo: un valor fuera del vocabulario es una violación", () => {
    // Por el MISMO predicado que usa la guarda, en un archivo cualquiera...
    const libre = minWidthViolations("app/app/algo/algo-client.tsx", 'className="min-w-[777px]"');
    expect(libre).not.toEqual([]);
    expect(libre[0]).toContain("min-w-[777px]");
    // ...y también dentro del propio primitivo: agregar un piso nuevo falla.
    const enPrimitivo = minWidthViolations(PRIMITIVE_PATH, 'className="min-w-[777px]"');
    expect(enPrimitivo).toContain("min-w-[777px]");
    expect(enPrimitivo).not.toContain("min-w-[420px]");
    // Y un piso NUEVO en un archivo permitido también falla (el conteo cambia).
    const deuda = SOURCES.get("app/payroll/payroll-client.tsx") ?? "";
    expect(minWidthViolations("app/payroll/payroll-client.tsx", `${deuda} min-w-[777px]`)).not.toEqual([]);
  });
});

describe("la escala vive una sola vez: en el primitivo", () => {
  it("el walk leyó el árbol real (piso anti-vacío)", () => {
    const tsx = [...SOURCES.keys()].filter((path) => path.endsWith(".tsx"));
    expect(SOURCES.size, "archivos .ts/.tsx de producción leídos").toBeGreaterThan(100);
    expect(tsx.length, "archivos .tsx de producción leídos").toBeGreaterThanOrEqual(20);
    expect(SOURCES.has(PRIMITIVE_PATH), "el primitivo está en el walk").toBe(true);
  });

  it("el primitivo declara los cinco valores, cada uno una sola vez", () => {
    const source = SOURCES.get(PRIMITIVE_PATH) ?? "";
    const found = inventedMinWidths(source);
    for (const value of DATA_TABLE_MIN_WIDTHS) {
      const token = `min-w-[${value}px]`;
      expect(found.filter((hit) => hit === token), token).toHaveLength(1);
    }
    // Y ningún invento fuera de los cinco: el primitivo no es un cajón de sastre.
    expect([...new Set(found)].sort()).toEqual([...SANCTIONED_TOKENS].sort());
  });

  it("ningún archivo fuera del primitivo y de la deuda permitida inventa un piso", () => {
    const offenders: string[] = [];
    for (const [path, source] of SOURCES) {
      const violations = minWidthViolations(path, source);
      if (violations.length > 0) {
        offenders.push(violations.join(" "));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("los cinco valores no aparecen en ningún archivo fuera del primitivo y su deuda permitida", () => {
    const offenders: string[] = [];
    for (const [path, source] of SOURCES) {
      if (path === PRIMITIVE_PATH || ALLOWLIST.has(path)) {
        continue;
      }
      const hits = inventedMinWidths(source).filter((token) => SANCTIONED_TOKENS.has(token));
      if (hits.length > 0) {
        offenders.push(`${path}: ${hits.join(" ")}`);
      }
    }
    expect(offenders, "archivos fuera del primitivo que escriben un valor del inventario").toEqual([]);
  });

  it("la allowlist declara el conteo EXACTO de la deuda preexistente", () => {
    const failures: string[] = [];
    for (const [path, expected] of ALLOWLIST) {
      const source = SOURCES.get(path);
      if (source === undefined) {
        failures.push(`${path}: permitido pero no existe (entrada muerta)`);
        continue;
      }
      const found = inventedMinWidths(source).length;
      if (found !== expected) {
        failures.push(`${path}: se esperaban ${expected} pisos inventados, hay ${found}`);
      }
    }
    expect(failures).toEqual([]);
    // Los seis archivos de la lista, y 15 pisos en total: si un séptimo
    // apareciera sin entrar acá, el test de arriba ya lo habría marcado.
    // La cifra BAJA cuando una unidad paga su deuda, porque el piso no se
    // translada: las dos tablas de liquidación de `payroll-client.tsx`
    // dejaron de escribir su `min-w-[1040px]` a mano (6 → 4) y la lista de
    // vales ya no es una tabla con carril (1 → 0). Queda pagada, no escondida.
    expect([...ALLOWLIST.values()].reduce((total, hits) => total + hits, 0)).toBe(15);
  });
});

/* --------------------------------------------------------------------------
   LAS DOS TABLAS DE LIQUIDACIÓN YA PASAN POR EL PRIMITIVO.

   La queja del dueño: «hay que ajustar el diseño de la liquidación para que
   aproveche el espacio en pantalla porque queda muy espichado». Medido, el
   cuello de botella NO era el piso de la tabla sino el diálogo: `max-w-6xl`
   con `p-6` y un `pr-1` dejaban 1098px útiles en CUALQUIER monitor, y las 12
   columnas piden unos 1450. La tabla se ajustaba a ese tope y por eso leía
   apretada.

   LO QUE ESTA GUARDA AFIRMA, del archivo real y por fuente (mismo método que
   las guardas de consumidor de este archivo: sin DOM no hay props):
     1. las dos tablas se montan por `DataTable`, con el paso `2xl` de la escala
        compartida y sin carril escrito a mano;
     2. conservan las 12 columnas, en el mismo orden (esto es un ajuste de
        diseño, no una poda de contenido);
     3. el dinero va a la derecha con cifras tabulares y ningún encabezado se
        apila.

   LA CELDA DE VALES ES LA EXCEPCIÓN DECLARADA: `tests/payroll.test.ts`
   congela su apertura literal porque esa columna es la regla del dueño. El
   valor se alinea en el `<span>` interno, y esta guarda afirma la excepción
   para que nadie la lea como un descuido ni la "arregle" rompiendo la otra.
   -------------------------------------------------------------------------- */

const PAYROLL_CLIENT_PATH = "app/payroll/payroll-client.tsx";

/** Las dos tablas de liquidación, por el componente que las monta. */
const SETTLEMENT_TABLES = ["PeriodDetailTable", "DraftPayrollTable"] as const;

/** Las 12 columnas, en orden. Ninguna se quita: la tabla deja de apretar, no de informar. */
const SETTLEMENT_COLUMNS = [
  "Empleado",
  "Fijo (días)",
  "Comisión fija",
  "Comisión por porcentaje",
  "Bonos",
  "Vales (descuento)",
  "Otros (descuento)",
  "Motivo del ajuste",
  "Neto",
  "Pagado",
  "Saldo",
  "Detalle",
] as const;

/** 9 de las 12 son dinero: todas menos Empleado, Motivo del ajuste y Detalle. */
const MONEY_COLUMNS = 9;

/** El paso del primitivo que estas dos tablas usan: el mismo piso, con nombre. */
const PRIMITIVE_USE = '<DataTable minWidth="2xl" wrapperClassName="mt-4">';

/** El bloque de un componente: de su firma hasta la siguiente `function`. */
function componentBlock(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const next = source.indexOf("\nfunction ", start);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

/** Los `<th scope="col">` del bloque, con la clase que reciben y su rótulo. */
function tableHeaders(block: string): { className: string; label: string }[] {
  const pattern = /<th className=\{([^}]+)\} scope="col">\s*([^<]*?)\s*<\/th>/g;
  return [...block.matchAll(pattern)].map((match) => ({
    className: match[1],
    label: match[2],
  }));
}

/** Cuántos `<td>` de dinero hay: los planos y el de `font-semibold` (Neto). */
function moneyCellCount(block: string): number {
  const plain = block.match(/<td className=\{moneyCellClass\}>/g) ?? [];
  const bold = block.match(/<td className=\{cn\(moneyCellClass, "font-semibold"\)\}>/g) ?? [];
  return plain.length + bold.length;
}

/** Encabezados que no son de las dos clases de nowrap: los que se apilan. */
function wrappingHeaders(block: string): string[] {
  return tableHeaders(block)
    .filter((header) => header.className !== "headCellClass" && header.className !== "moneyHeadClass")
    .map((header) => header.label);
}

describe("las tablas de liquidación de nómina pasan por `DataTable`", () => {
  const source = SOURCES.get(PAYROLL_CLIENT_PATH) ?? "";

  it("piso anti-vacío: el cliente se leyó y las dos tablas existen", () => {
    expect(source.length).toBeGreaterThan(20_000);
    for (const name of SETTLEMENT_TABLES) {
      expect(componentBlock(source, name).length, name).toBeGreaterThan(1_000);
    }
  });

  it("cada tabla se monta por el primitivo, con el paso `2xl` de la escala", () => {
    for (const name of SETTLEMENT_TABLES) {
      const block = componentBlock(source, name);
      expect(block.split(PRIMITIVE_USE).length - 1, `${name}: abre con DataTable`).toBe(1);
      // Y cierra con el primitivo, no con un `</table>` suelto.
      expect(block.split("</DataTable>").length - 1, `${name}: cierra con DataTable`).toBe(1);
    }
    // Las dos, y solo dos: este carril no se multiplica.
    expect(source.split("<DataTable ").length - 1).toBe(SETTLEMENT_TABLES.length);
  });

  it("ninguna de las dos escribe su propio carril ni su propio piso de ancho", () => {
    for (const name of SETTLEMENT_TABLES) {
      const block = componentBlock(source, name);
      expect(stripComments(block), `${name}: carril a mano`).not.toContain("overflow-x-auto");
      expect(inventedMinWidths(block), `${name}: piso a mano`).toEqual([]);
    }
  });

  it("la deuda del archivo bajó: los cuatro pisos que quedan son de otras tablas", () => {
    // El 6 → 4 de la allowlist no es borrar un token suelto: los dos que
    // faltan son los que el primitivo renderiza hoy por su cuenta, y las dos
    // tablas que los tenían ya no los escriben.
    expect(inventedMinWidths(source)).toHaveLength(ALLOWLIST.get(PAYROLL_CLIENT_PATH) ?? -1);
    for (const name of SETTLEMENT_TABLES) {
      expect(componentBlock(source, name), `${name}: piso propio`).not.toContain("min-w-[1040px]");
    }
  });

  it("las 12 columnas siguen ahí, en el mismo orden, en las dos tablas", () => {
    for (const name of SETTLEMENT_TABLES) {
      const headers = tableHeaders(componentBlock(source, name));
      expect(headers.length, `${name}: número de columnas`).toBe(SETTLEMENT_COLUMNS.length);
      expect(headers.map((header) => header.label), `${name}: rótulos`).toEqual([
        ...SETTLEMENT_COLUMNS,
      ]);
    }
  });

  it("el dinero va a la derecha con cifras tabulares, y su encabezado con él", () => {
    // La clase es local del módulo (el estándar compartido no crece por una
    // tabla), pero lo que se afirma es lo que dice: la columna numérica se lee
    // en vertical.
    expect(source).toMatch(/const\s+moneyCellClass\s*=\s*cn\([^)]*"text-right tabular-nums/);
    expect(source).toMatch(/const\s+moneyHeadClass\s*=\s*cn\([^)]*"whitespace-nowrap text-right/);
    for (const name of SETTLEMENT_TABLES) {
      const block = componentBlock(source, name);
      const money = tableHeaders(block).filter((header) => header.className === "moneyHeadClass");
      expect(money.length, `${name}: encabezados de dinero`).toBe(MONEY_COLUMNS);
      // Y las celdas: 8 en la cerrada (bonos y otros son valores fijos) y 6 en
      // el borrador (los dos campos de ajuste son inputs `text-right` de por sí).
      expect(moneyCellCount(block), `${name}: celdas de dinero`).toBe(
        name === "PeriodDetailTable" ? 8 : 6,
      );
    }
  });

  it("la celda de vales conserva la apertura congelada y alinea el valor adentro", () => {
    const celdas: [string, string][] = [
      ["PeriodDetailTable", '<td className={tableCellClass} title={voucherCellTitle(item)}>'],
      [
        "DraftPayrollTable",
        '<td className={tableCellClass} title={item ? voucherCellTitle(item) : undefined}>',
      ],
    ];
    for (const [name, opening] of celdas) {
      const block = componentBlock(source, name);
      expect(block, `${name}: apertura congelada`).toContain(opening);
      const start = block.indexOf(opening);
      const cell = block.slice(start, block.indexOf("</td>", start));
      expect(cell, `${name}: el valor de vales se alinea`).toContain(
        '<span className="block text-right tabular-nums">',
      );
      // Sigue siendo SOLO el total real: alinear no=coló de vuelta el desglose
      // que el dueño rechazó.
      expect(cell.split("-${formatMoney(item.voucher_total)}").length - 1, `${name}: total`).toBe(1);
      expect(cell, `${name}: sin aplicado`).not.toContain("item.deductions_vales");
      expect(cell, `${name}: sin deuda`).not.toContain("item.pending_debt");
    }
  });

  it("ningún encabezado se apila: los 12 de cada tabla llevan `whitespace-nowrap`", () => {
    // El síntoma visible del «espichado» era un rótulo de tres palabras partido
    // en cuatro renglones dentro de una columna de 67px.
    expect(source).toMatch(/const\s+headCellClass\s*=\s*cn\([^)]*"whitespace-nowrap"/);
    for (const name of SETTLEMENT_TABLES) {
      expect(wrappingHeaders(componentBlock(source, name)), `${name}: rótulos apilados`).toEqual([]);
    }
  });

  it("el detector no es un sello de goma (control negativo)", () => {
    // El marcado VIEJO de la queja: dos columnas de muestra, carril y piso a
    // mano, dinero a la izquierda y rótulos que se apilan. El MISMO predicado
    // tiene que acusarlo, o las guardas de arriba no afirmarían nada.
    const viejo = [
      "function PeriodDetailTable() {",
      "  return (",
      '    <div className="mt-4 overflow-x-auto">',
      '      <table className={cn("w-full text-left text-sm", "min-w-[1040px]")}>',
      '        <thead><tr className={tableHeaderClass}>',
      '          <th className={tableCellClass} scope="col">Empleado</th>',
      '          <th className={tableCellClass} scope="col">Neto</th>',
      "        </tr></thead>",
      "        <tbody>",
      '          <tr><td className={tableCellClass}>{formatMoney(item.net_pay)}</td></tr>',
      "        </tbody>",
      "      </table>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(viejo.split(PRIMITIVE_USE).length - 1).toBe(0);
    expect(stripComments(viejo)).toContain("overflow-x-auto");
    expect(inventedMinWidths(viejo)).toEqual(["min-w-[1040px]"]);
    // El detector de columnas no se infla: dos rótulos son dos, no doce.
    expect(tableHeaders(viejo)).toHaveLength(2);
    expect(tableHeaders(viejo).length).not.toBe(SETTLEMENT_COLUMNS.length);
    // Y el de dinero y el de rótulos apilados también acusan lo viejo.
    expect(moneyCellCount(viejo)).toBe(0);
    expect(wrappingHeaders(viejo)).toEqual(["Empleado", "Neto"]);
  });
});

