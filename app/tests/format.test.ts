import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import type { ActionResult } from "@/src/shared/lib/api-response";
import { formatDateTime, toNumber } from "@/src/shared/lib/format";
import { formatMoney, formatMoneyInput, stripMoneyInput } from "@/src/shared/lib/money";

/* --------------------------------------------------------------------------
   WU3 — formato compartido y guarda anti-re-duplicación.

   Contexto medido en el árbol (verificado el 2026-10-01, antes de este WU):
     - `formatMoney`: 8 definiciones (1 en admin-shared + 7 copias locales).
       NO eran equivalentes: cinco usaban el guion largo "—" como marcador de
       vacío y tres usaban el guion simple "-" (caja, nómina, vales). Este WU
       normaliza en "—"; el cambio es visible y el commit lo declara.
     - `toNumber`: 6 (1 exportada + 5 copias locales byte-idénticas).
     - `formatDateTime`: 2 copias locales (alertas con "—", caja con "-").
     - `ActionResult<T>`: 8 definiciones byte-idénticas.
   Se consolidaron en `src/shared/lib/money.ts` (formatMoney),
   `src/shared/lib/format.ts` (toNumber, formatDateTime) y
   `src/shared/lib/api-response.ts` (ActionResult).

   Este archivo tiene dos mitades:
     1. COMPORTAMIENTO — lo que hace el formateador unificado, asertado sobre
        la conducta que tenían las copias (no sobre una expectativa inventada).
     2. GUARDA — chequeo offline que cada helper se declare UNA sola vez en
        las fuentes de producción. Sin la guarda, el próximo archivo pega su
        copia local y la disparidad reaparece (fue exactamente lo que pasó).

   --------------------------------------------------------------------------
   LIMITACIONES DEL DETECTOR (honestas: NO es un parser de JavaScript):

   - Se borran COMENTARIOS (`//` y `/* ... *\/`) y SENTENCIAS `import ...`
     (que pueden traer `type Foo` en su lista de especificadores y no
     declaran nada) antes de contar, porque los archivos existentes nombran
     estos helpers al explicarlos. NO se borran literales de string: un
     literal que dijera `function formatMoney(` se contaría como definición.
     Es un falso POSITIVO ruidoso, nunca un falso NEGATIVO silencioso; ese es
     el lado correcto del error.
   - Un `/*` sin cerrar borraría el resto del archivo; en fuentes que compilan
     no ocurre, y de todos modos el piso de archivos y la aserción del archivo
     canónico fallarían ruidosamente.
   - Se cuentan definiciones: `function NAME(`, `const/let/var NAME =`,
     `type/interface/enum NAME`. Un `export { NAME } from "..."` o un
     `export * from "..."` reexporta, NO define, y por eso no cuenta: es
     justamente la forma que usan `admin-shared.ts`/`admin-styles.ts`.
   - No se recorre `tests/`: este mismo archivo nombra los helpers al
     explicarlos, igual que en `no-raw-palette.test.ts`.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();

/** Directorios que no son código de producción (mismo criterio que las otras guardas). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "tests",
  "test-results",
  "playwright-report",
]);

/**
 * Piso anti-vacío: las fuentes de producción son 129 archivos `.ts`/`.tsx`
 * (medido el 2026-10-01 con el mismo walk de acá: sin `tests/`, `node_modules`,
 * `.next`, `.git`, `coverage`, `test-results` ni `playwright-report`). El piso va
 * holgadamente por debajo para no ser mantenimiento molesto, pero alto como
 * para que un walk roto (p. ej. `cwd` distinto) falle en vez de pasar solo.
 */
const MIN_PRODUCTION_FILES = 80;

/** U+00A0: separador que `Intl` inserta entre el símbolo y el monto en es-CO. */
const NBSP = "\u00a0";
const COP = "$";

/** Monto esperado tal como lo escribe `Intl.NumberFormat("es-CO", COP)`. */
const money = (amount: string): string => `${COP}${NBSP}${amount}`;

/** "—": marcador único de vacío/no numérico del formateador unificado. */
const EMPTY = "—";

interface ProductionSource {
  /** Ruta relativa al root de la app, con separadores POSIX. */
  path: string;
  code: string;
}

/** Camina el árbol y devuelve las fuentes `.ts`/`.tsx` de producción. */
function readProductionSources(): ProductionSource[] {
  const out: ProductionSource[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const absolute = join(dir, entry.name);
      out.push({
        path: relative(APP_ROOT, absolute).split(sep).join("/"),
        code: readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(APP_ROOT);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reemplaza comentarios por espacios conservando los saltos de línea, para que
 * un helper nombrado dentro de un comentario no cuente como definición.
 */
function blankOutComments(source: string): string {
  const chars = source.split("");
  const length = source.length;

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (source[index] !== "\n") chars[index] = " ";
    }
  };

  let index = 0;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      let end = index + 2;
      while (end < length && source[end] !== "\n") end += 1;
      blank(index, end);
      index = end;
      continue;
    }
    if (char === "/" && next === "*") {
      let end = index + 2;
      while (end < length && !(source[end] === "*" && source[end + 1] === "/")) end += 1;
      end = Math.min(end + 2, length);
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === char) break;
        end += 1;
      }
      index = end + 1;
      continue;
    }
    index += 1;
  }

  return chars.join("");
}

/**
 * Reemplaza por espacios las sentencias `import ... from "..."` completas
 * (también las multilínea), conservando los saltos de línea. Una importación NO
 * define nada, pero su lista de especificadores puede contener `type Foo`
 * (p. ej. `import { formatMoney, type ActionResult } from "../admin-shared"`),
 * que sin este paso se leería como una declaración de tipo.
 */
function stripImportStatements(code: string): string {
  const pattern = /^[ \t]*import\b[\s\S]*?from\s*["'][^"'\n]*["']\s*;|^[ \t]*import\s*["'][^"'\n]*["']\s*;/gm;
  return code.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
}

type HelperKind = "function" | "type";

/** Definición completa del identificador (no mencionado dentro de otro nombre). */
function declarationPattern(name: string, kind: HelperKind): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = `(?:^|[^\\w.$])`;
  if (kind === "type") {
    return new RegExp(`${boundary}(?:type|interface|enum)\\s+${escaped}\\b`, "g");
  }
  return new RegExp(
    `${boundary}function\\s+${escaped}\\s*\\(|${boundary}(?:const|let|var)\\s+${escaped}\\s*[:=]`,
    "g",
  );
}

/** Cuenta definiciones de `name` en una fuente ya sin comentarios ni imports. */
function countDeclarations(code: string, name: string, kind: HelperKind): number {
  const stripped = stripImportStatements(blankOutComments(code));
  return stripped.match(declarationPattern(name, kind))?.length ?? 0;
}

interface HelperSpec {
  name: string;
  kind: HelperKind;
  /** Archivo canónico donde el helper debe declararse (ruta relativa POSIX). */
  file: string;
}

/** Único hogar de cada helper consolidado en WU3. */
const CANONICAL_HELPERS: readonly HelperSpec[] = [
  { name: "formatMoney", kind: "function", file: "src/shared/lib/money.ts" },
  { name: "formatMoneyInput", kind: "function", file: "src/shared/lib/money.ts" },
  { name: "stripMoneyInput", kind: "function", file: "src/shared/lib/money.ts" },
  { name: "toNumber", kind: "function", file: "src/shared/lib/format.ts" },
  { name: "formatDateTime", kind: "function", file: "src/shared/lib/format.ts" },
  { name: "ActionResult", kind: "type", file: "src/shared/lib/api-response.ts" },
];

/** Archivos que la guarda tiene que haber leído (si falta uno, el walk está roto). */
const REQUIRED_FILES: readonly string[] = [
  "src/shared/lib/money.ts",
  "src/shared/lib/format.ts",
  "src/shared/lib/api-response.ts",
  "app/admin/admin-shared.ts",
  "app/alerts/alerts-client.tsx",
  "app/cash/cash-client.tsx",
  "app/inventory/inventory-client.tsx",
  "app/invoices/invoices-client.tsx",
  "app/payroll/payroll-client.tsx",
  "app/services/services-client.tsx",
  "app/vales/vouchers-client.tsx",
];

const SOURCES = readProductionSources();

describe("formatMoney unificado", () => {
  it("formatea enteros en es-CO con símbolo COP y sin decimales", () => {
    expect(formatMoney(1234567)).toBe(money("1.234.567"));
    expect(formatMoney(0)).toBe(money("0"));
    expect(formatMoney(-5000)).toBe(`-${COP}${NBSP}5.000`);
  });

  it("redondea a cero decimales como hacían las ocho copias originales", () => {
    expect(formatMoney(1234.56)).toBe(money("1.235"));
    expect(formatMoney(999.4)).toBe(money("999"));
  });

  it("acepta strings numéricos (conducta de siete de las ocho copias)", () => {
    expect(formatMoney("1234567")).toBe(money("1.234.567"));
    expect(formatMoney(" 1234.56 ")).toBe(money("1.235"));
  });

  it("usa el guion largo «—» como marcador de vacío y de no numérico", () => {
    expect(formatMoney(null)).toBe(EMPTY);
    expect(formatMoney(undefined)).toBe(EMPTY);
    expect(formatMoney(NaN)).toBe(EMPTY);
    expect(formatMoney(Infinity)).toBe(EMPTY);
    expect(formatMoney(-Infinity)).toBe(EMPTY);
    expect(formatMoney("abc")).toBe(EMPTY);
  });

  it("un string vacío rinde «$ 0», no el marcador de vacío (conducta heredada)", () => {
    /* Las ocho copias hacían `Number("")` (o dejaban que `Intl` lo hiciera) y
       eso da 0, que SÍ es finito. Se documenta tal cual: cambiarlo a "—" sería
       conducta nueva, fuera del alcance de WU3. */
    expect(formatMoney("")).toBe(money("0"));
    expect(formatMoney("   ")).toBe(money("0"));
  });

  it("normaliza en «—» el marcador que caja, nómina y vales escribían como «-»", () => {
    /* Cambio visible y deliberado de WU3: antes estas tres rutas renderizaban
       "-" en un monto vacío. Acá se fija el contrato nuevo, no el viejo. */
    expect(formatMoney(null)).not.toBe("-");
    expect(formatMoney(null)).toBe(EMPTY);
    expect(formatMoney(null).length).toBe(1);
  });

  it("mantiene intacta la máscara de entrada que ya vivía en money.ts", () => {
    expect(formatMoneyInput("1234567")).toBe("1.234.567");
    expect(formatMoneyInput("0001234")).toBe("1.234");
    expect(formatMoneyInput("")).toBe("");
    expect(stripMoneyInput("$ 1.234")).toBe("1234");
  });
});

describe("toNumber unificado", () => {
  it("devuelve null para vacíos y no numéricos", () => {
    expect(toNumber("")).toBeNull();
    expect(toNumber("   ")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber("Infinity")).toBeNull();
    expect(toNumber("NaN")).toBeNull();
  });

  it("parsea números, con signo, decimales y espacios de sobra", () => {
    expect(toNumber("12")).toBe(12);
    expect(toNumber(" 12.5 ")).toBe(12.5);
    expect(toNumber("-3.25")).toBe(-3.25);
    expect(toNumber("0")).toBe(0);
  });

  it("acepta la notación que acepta Number() (conducta heredada, documentada)", () => {
    /* Las cinco copias locales usaban Number() directo, así que "0x10" y "1e3"
       pasaban como 16 y 1000. Se documenta para que un futuro cambio de
       parser sea una decisión, no un accidente. */
    expect(toNumber("0x10")).toBe(16);
    expect(toNumber("1e3")).toBe(1000);
  });
});

describe("formatDateTime unificado", () => {
  it("usa «—» para vacío y falsy", () => {
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDateTime(undefined)).toBe(EMPTY);
    expect(formatDateTime("")).toBe(EMPTY);
  });

  it("formatea día/mes y hora/minuto en es-CO", () => {
    /* Se construye en hora LOCAL para que la aserción no dependa del huso del
       runner: las dos copias usaban `toLocaleString` sin `timeZone` y eso se
       conserva tal cual (unificación, no cambio de huso).
       Ojo con el relleno, que NO es uniforme en es-CO y es el que ya rendían
       las copias: la hora y el minuto van a dos dígitos, el día y el mes no. */
    expect(formatDateTime(new Date(2024, 2, 5, 9, 30).toISOString())).toBe("5/3, 09:30 a. m.");
    expect(formatDateTime(new Date(2024, 2, 5, 15, 7).toISOString())).toBe("5/3, 03:07 p. m.");
    expect(formatDateTime(new Date(2024, 11, 25, 8, 5).toISOString())).toBe("25/12, 08:05 a. m.");
  });

  it("normaliza en «—» el marcador que caja escribía como «-»", () => {
    /* Cambio visible y deliberado de WU3 en la fecha vacía de caja. */
    expect(formatDateTime(null)).not.toBe("-");
  });

  it("devuelve «Invalid Date» ante una fecha ilegible (conducta heredada)", () => {
    /* Las dos copias locales dependían de `toLocaleString` sobre un Date
       inválido. No se arregla acá: cambiarlo sería una conducta nueva, fuera
       del alcance de WU3. */
    expect(formatDateTime("no-es-fecha")).toBe("Invalid Date");
  });
});

describe("ActionResult<T> exportado desde el sobre de respuesta", () => {
  it("es usable y conserva la forma éxito/error que tenían las ocho copias", () => {
    const success: ActionResult<number> = { success: true, data: 7 };
    const failure: ActionResult<number> = { success: false, code: "CASH-001", message: "Turno cerrado" };

    expect(success).toEqual({ success: true, data: 7 });
    expect(failure).toEqual({ success: false, code: "CASH-001", message: "Turno cerrado" });
    expect(success.success).toBe(true);
    if (!failure.success) expect(failure.code).toBe("CASH-001");
  });
});

describe("guarda: cada helper se declara exactamente una vez", () => {
  it("el walk leyó las fuentes de producción y no arrancó vacío (piso anti-vacío)", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(MIN_PRODUCTION_FILES);
    const paths = new Set(SOURCES.map((source) => source.path));
    for (const required of REQUIRED_FILES) {
      expect(paths.has(required), `no se leyó ${required}`).toBe(true);
    }
    expect(SOURCES.some((source) => source.path.startsWith("tests/"))).toBe(false);
  });

  for (const spec of CANONICAL_HELPERS) {
    it(`«${spec.name}» se define una sola vez, en ${spec.file}`, () => {
      const hits = SOURCES.map((source) => ({
        path: source.path,
        count: countDeclarations(source.code, spec.name, spec.kind),
      })).filter((entry) => entry.count > 0);

      const total = hits.reduce((acc, entry) => acc + entry.count, 0);
      expect(
        total,
        `definiciones de ${spec.name}: ${hits.map((h) => `${h.path}×${h.count}`).join(", ") || "ninguna"}`,
      ).toBe(1);
      expect(hits.map((hit) => hit.path)).toEqual([spec.file]);
    });
  }

  it("ningún cliente arrastra su propia copia de los helpers", () => {
    const names = CANONICAL_HELPERS.map((spec) => spec.name);
    const clientSources = SOURCES.filter(
      (source) =>
        /^app\/.+-client\.tsx$/.test(source.path) || source.path === "app/admin/admin-shared.ts",
    );
    /* Enumeración: los ocho archivos medidos (7 clientes + admin-shared) y las
       seis entradas de la lista canónica. Si alguien recorta la lista de
       helpers a la mitad, este test lo dice. */
    expect(clientSources.length).toBeGreaterThanOrEqual(8);

    for (const source of clientSources) {
      for (const spec of CANONICAL_HELPERS) {
        expect(
          countDeclarations(source.code, spec.name, spec.kind),
          `${source.path} redefine ${spec.name}`,
        ).toBe(0);
      }
    }
    expect(names).toHaveLength(CANONICAL_HELPERS.length);
  });

  it("los clientes importan el helper compartido en vez de declararlo", () => {
    const byPath = new Map(SOURCES.map((source) => [source.path, source.code]));
    const imports: Array<{ path: string; pattern: RegExp }> = [
      { path: "app/cash/cash-client.tsx", pattern: /import \{[^}]*\bformatMoney\b[^}]*\} from "@\/src\/shared\/lib\/money"/ },
      { path: "app/cash/cash-client.tsx", pattern: /import \{ formatDateTime \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/alerts/alerts-client.tsx", pattern: /import \{ formatDateTime \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/alerts/alerts-client.tsx", pattern: /import type \{ ActionResult \} from "@\/src\/shared\/lib\/api-response"/ },
      { path: "app/payroll/payroll-client.tsx", pattern: /import \{ toNumber \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/inventory/inventory-client.tsx", pattern: /import \{ toNumber \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/invoices/invoices-client.tsx", pattern: /import \{ toNumber \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/services/services-client.tsx", pattern: /import \{ toNumber \} from "@\/src\/shared\/lib\/format"/ },
      { path: "app/vales/vouchers-client.tsx", pattern: /import \{ toNumber \} from "@\/src\/shared\/lib\/format"/ },
    ];
    for (const entry of imports) {
      const code = byPath.get(entry.path);
      expect(code, `no se leyó ${entry.path}`).toBeDefined();
      expect(entry.pattern.test(code ?? ""), `${entry.path} no importa como se espera`).toBe(true);
    }
  });
});

describe("self-tests del detector (fuentes sintéticas, sin tocar src/)", () => {
  it("cuenta dos definiciones cuando el helper se re-duplica (control negativo)", () => {
    const first = "export function formatMoney(value: number | null): string {\n  return \"\";\n}\n";
    const second = "function formatMoney(value: number | null): string {\n  return \"\";\n}\n";
    expect(countDeclarations(first, "formatMoney", "function")).toBe(1);
    expect(countDeclarations(second, "formatMoney", "function")).toBe(1);
    expect(
      countDeclarations(`${first}${second}`, "formatMoney", "function"),
    ).toBe(2);
  });

  it("no cuenta una mención dentro de un comentario", () => {
    const source = [
      "// function formatMoney(value: number | null): string {}",
      "/* const toNumber = (value: string) => Number(value); */",
      "export const ok = 1;",
    ].join("\n");
    expect(countDeclarations(source, "formatMoney", "function")).toBe(0);
    expect(countDeclarations(source, "toNumber", "function")).toBe(0);
  });

  it("no cuenta una reexportación: reexportar no es definir", () => {
    const source = [
      'export { formatMoney } from "@/src/shared/lib/money";',
      'export type { ActionResult } from "@/src/shared/lib/api-response";',
      'export * from "@/src/shared/lib/format";',
    ].join("\n");
    expect(countDeclarations(source, "formatMoney", "function")).toBe(0);
    expect(countDeclarations(source, "ActionResult", "type")).toBe(0);
    expect(countDeclarations(source, "toNumber", "function")).toBe(0);
  });

  it("no cuenta una importación, ni siquiera con especificador `type` (control negativo)", () => {
    /* El caso real que la primera versión de esta guarda marcaba por error:
       `import { formatMoney, type ActionResult } from "../admin-shared"`.
       La importación no declara el tipo. */
    expect(
      countDeclarations(
        'import { formatMoney, type ActionResult } from "../admin-shared";',
        "ActionResult",
        "type",
      ),
    ).toBe(0);
    expect(
      countDeclarations(
        'import type { ActionResult } from "@/src/shared/lib/api-response";',
        "ActionResult",
        "type",
      ),
    ).toBe(0);
    expect(
      countDeclarations(
        'import { formatMoney } from "@/src/shared/lib/money";',
        "formatMoney",
        "function",
      ),
    ).toBe(0);
    expect(
      countDeclarations(
        'import {\n  formatMoney,\n  formatMoneyInput,\n} from "@/src/shared/lib/money";',
        "formatMoney",
        "function",
      ),
    ).toBe(0);
  });

  it("cuenta también la forma `const NAME = ...` y el tipo de otro nombre", () => {
    expect(countDeclarations("const toNumber = (v: string) => Number(v);", "toNumber", "function")).toBe(1);
    expect(countDeclarations("let formatDateTime: F = () => \"\";", "formatDateTime", "function")).toBe(1);
    expect(countDeclarations("type ActionResult<T> = { ok: true };", "ActionResult", "type")).toBe(1);
    expect(countDeclarations("interface ActionResult<T> { ok: true }", "ActionResult", "type")).toBe(1);
  });

  it("no confunde un identificador con otro que lo contiene", () => {
    /* `formatMoneyInput` NO es `formatMoney`, y `errFormatMoney` tampoco. */
    expect(countDeclarations("export function formatMoneyInput(d: string): string { return d; }", "formatMoney", "function")).toBe(0);
    expect(countDeclarations("function errFormatMoney(): void {}", "formatMoney", "function")).toBe(0);
    expect(countDeclarations("export function formatMoneyInput(d: string): string { return d; }", "formatMoneyInput", "function")).toBe(1);
  });
});
