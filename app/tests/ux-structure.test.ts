import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Guarda de estructura de página (WU2).

   El defecto medido en el árbol: cada `app/<dir>/page.tsx` repetía a mano el mismo
   `<main className="mx-auto flex min-h-screen max-w-{3xl|4xl|5xl} flex-col
   gap-{4|6} px-6 py-12">` y su propio `<h1>` (en `text-2xl` para la rama "sin
   sede" y en `text-3xl` para la rama real del MISMO archivo). No existía
   primitivo. `PageContainer`/`PageHeader` (`src/components/ui/lib/page.tsx`)
   lo cierran; esta guarda impide que vuelva.

   Qué afirma:

     1. Ningún `page.tsx` compone a mano el shell (`<main>` con `mx-auto` +
        `flex` + un `max-w-*`) ni escribe un `<h1>` literal.
     2. Ningún `page.tsx` pide `min-h-screen`: la altura la resuelve el shell y
        el primitivo usa `min-h-dvh lg:min-h-0`.
     3. Cada página importa y usa `PageContainer` y `PageHeader`.
     4. El `<h1>` del primitivo es exactamente `text-3xl font-bold`.
     5. Piso anti-vacío: si el walk encuentra menos de nueve páginas, o no está
        alguna de las nueve migradas, la guarda FALLA en vez de pasar sola.
     6. Control negativo del detector: la firma vieja se reporta como violación
        por el MISMO predicado que usa la guarda.

   POR QUÉ TOKENS Y NO SUBSTRINGS: este repo se quemó dos veces con grep de
   substring (`text-text-primary` termina en `text-primary`; `border-border`
   matchea `border-border-color`). Acá todo se compara como token de clase
   completo: `mx-auto` no matchea `my-mx-auto`, y `max-w-4xl` no matchea
   `max-w-4xl-ish`. El `<h1` exige un delimitador después del identificador,
   así que `<h10>` no cuenta.

   ALCANCE: los diez `page.tsx` bajo `app/` —los nueve `app/<dir>/page.tsx` de los
   módulos MÁS el inicio `app/page.tsx`, tal como los enumera la tabla de la
   unidad—. No entran `error.tsx`, `not-found.tsx` ni los `loading.tsx`: tienen
   su propio shell a propósito (el estado de error/404 centra el contenido y
   los esqueletos replican el ancho de su página), y esta unidad no los toca.

   LIMITES HONESTOS: el detector es léxico, no un parser de JS. `mainTags` corta
   en el primer `>` (los `className` de estas páginas no contienen `>`), el
   stripper de comentarios es naïf (un `//` dentro de un literal lo cortaría; en
   estas superficies no hay URLs) y solo se miran literales de string, no la
   interpolación `${...}`.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const PAGES_ROOT = join(APP_ROOT, "app");
const PRIMITIVE_PATH = join(APP_ROOT, "src", "components", "ui", "lib", "page.tsx");

/** Piso anti-vacío: por debajo de nueve páginas leídas, la guarda no probó nada. */
const MIN_PAGES = 9;

/**
 * Las NUEVE pantallas de módulo (`app/<dir>/page.tsx`) que migró la unidad. El
 * inicio `app/page.tsx` es la décima y también se migró: entra igual en el
 * walk de todas las páginas, pero no se lista acá porque la unidad habla de
 * "nueve page shells" (`app/<dir>/page.tsx`).
 */
const MIGRATED_PAGES = [
  "app/admin/page.tsx",
  "app/alerts/page.tsx",
  "app/cash/page.tsx",
  "app/inventory/page.tsx",
  "app/invoices/page.tsx",
  "app/login/page.tsx",
  "app/payroll/page.tsx",
  "app/services/page.tsx",
  "app/vales/page.tsx",
];

/** Directorios que no son código de la app. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/** Código sin comentarios: una firma nombrada al EXPLICARLA no es una firma usada. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Token de clase: variantes (`lg:`), utilidad, y como mucho `/alpha`. */
const CLASS_TOKEN = /[A-Za-z0-9_:./-]+/g;

function tokenize(literal: string): string[] {
  return [...literal.matchAll(CLASS_TOKEN)].map((match) => match[0]);
}

/** Utilidad de un token: la variante se corta antes (`lg:min-h-0` → `min-h-0`). */
function utilityOf(token: string): string {
  return token.split(":").pop() ?? token;
}

/** Contenido de cada `page.tsx` bajo una raíz, indexado por ruta relativa al cwd. */
function readPages(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(current, entry.name));
        continue;
      }
      if (entry.name !== "page.tsx") continue;
      const path = join(current, entry.name);
      const relative = path.slice(APP_ROOT.length + 1).split(sep).join("/");
      files.set(relative, readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return files;
}

/** Valor del atributo `className` de una etiqueta JSX (comilla doble o simple). */
function classNameValue(tag: string): string {
  const match = tag.match(/className=(?:"([^"]*)"|'([^']*)')/);
  return match?.[1] ?? match?.[2] ?? "";
}

/** Etiquetas de apertura `<main …>` (cortan en el primer `>`). */
function mainTags(source: string): string[] {
  return [...stripComments(source).matchAll(/<main\b[^>]*>/g)].map((match) => match[0]);
}

/**
 * Firmas del shell copiadas a mano: cada `<main>` que lleva `mx-auto`, `flex` y
 * un `max-w-*` como tokens de clase completos.
 */
function handRolledShells(source: string): string[] {
  const findings: string[] = [];
  for (const tag of mainTags(source)) {
    const classes = tokenize(classNameValue(tag)).map(utilityOf);
    const hasAuto = classes.includes("mx-auto");
    const hasFlex = classes.includes("flex");
    const hasWidth = classes.some((utility) => utility.startsWith("max-w-"));
    if (hasAuto && hasFlex && hasWidth) findings.push(tag);
  }
  return findings;
}

/** ¿Hay un `<h1>` literal? El `(?=[\s/>])` impide contar `<h10>` o `<h1ish>`. */
function literalH1(source: string): boolean {
  return /<h1(?=[\s/>])/.test(stripComments(source));
}

/** El predicado que usa la guarda: shell a mano o `<h1>` literal. */
function shellViolations(source: string): string[] {
  const findings = [...handRolledShells(source)];
  if (literalH1(source)) findings.push("<h1>");
  return findings;
}

/**
 * Literales de string del archivo, sin las comillas. Un escáner de estado
 * simple: dentro de un literal se ignora cualquier otra comilla hasta la de
 * cierre del mismo tipo (mismo detector que `badge-adoption.test.ts`).
 */
function stringLiterals(source: string): string[] {
  const code = stripComments(source);
  const literals: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (quote === null) {
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        start = i + 1;
      }
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) {
      literals.push(code.slice(start, i));
      quote = null;
    }
  }
  return literals;
}

/** Tokens `min-h-screen` (con su variable) presentes en el archivo. */
function minHScreenTokens(source: string): string[] {
  const found: string[] = [];
  for (const literal of stringLiterals(source)) {
    for (const token of tokenize(literal)) {
      if (utilityOf(token) === "min-h-screen") found.push(token);
    }
  }
  return found;
}

/** Especificadores importados del primitivo de página (token completo). */
function pageImportSpecifiers(source: string): string[] {
  const match = stripComments(source).match(
    /import\s*\{([^}]*)\}\s*from\s*["']@\/src\/components\/ui\/lib\/page["']/,
  );
  if (!match) return [];
  return match[1]
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
}

/** ¿La página abre la etiqueta del componente? (`<PageContainer` no es `<PageContainerX`). */
function usesComponent(source: string, name: string): boolean {
  return new RegExp(`<${name}(?=[\\s/>])`).test(stripComments(source));
}

/** Clases del `<h1>` del primitivo (token completo). */
function h1Classes(source: string): string[] {
  const match = stripComments(source).match(/<h1\b[^>]*className="([^"]*)"/);
  return match ? tokenize(match[1]).map(utilityOf) : [];
}

const PAGES = readPages(PAGES_ROOT);

/* ==========================================================================
   El detector mismo (control negativo)
   ========================================================================== */
describe("estructura de página: el detector no es un sello de goma", () => {
  it("reporta la firma vieja que el repositorio tenía escrita, por el mismo predicado de la guarda", () => {
    // La firma exacta de la tabla, tal como estaba en los nueve page.tsx.
    const oldShell =
      '<main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">';
    expect(shellViolations(oldShell).length).toBeGreaterThan(0);
    // Y el `<h1>` a mano, que la unidad elimina.
    expect(shellViolations('<h1 className="text-2xl font-bold">Caja</h1>').length).toBeGreaterThan(0);
    // Las dos firmas sueltas NO alcanzan si no coocurren en el mismo `<main>`.
    expect(shellViolations('<main className="mx-auto flex flex-col">')).toEqual([]);
    expect(shellViolations('<main className="mx-auto max-w-4xl">')).toEqual([]);
  });

  it("cuenta tokens completos, no substrings", () => {
    // `my-mx-auto` no es `mx-auto`; `max-w-4xl-ish` no empieza como token `max-w-`.
    expect(shellViolations('<main className="my-mx-auto flex max-w-4xl">')).toEqual([]);
    expect(shellViolations('<main className="mx-auto flex max-w-none">')).toHaveLength(1);
    // El `<h1` exige delimitador.
    expect(literalH1('<h10 className="x">y</h10>')).toBe(false);
    expect(literalH1("<h1ish />")).toBe(false);
    expect(literalH1("<h1>y</h1>")).toBe(true);
    // `min-h-screen` como token, con variante; `min-h-dvh` no cuenta.
    expect(minHScreenTokens('className="lg:min-h-screen"')).toEqual(["lg:min-h-screen"]);
    expect(minHScreenTokens('className="min-h-dvh lg:min-h-0"')).toEqual([]);
    expect(minHScreenTokens('<div className="my-min-h-screen">')).toEqual([]);
  });

  it("no cuenta una firma nombrada en un comentario", () => {
    expect(
      shellViolations("// <main className=\"mx-auto flex max-w-4xl\">\n/* <h1>x</h1> */"),
    ).toEqual([]);
  });
});

/* ==========================================================================
   El walk y las nueve páginas migradas
   ========================================================================== */
describe("estructura de página: el walk leyó las páginas reales", () => {
  it("el walk leyó al menos nueve páginas y están las nueve migradas (piso anti-vacío)", () => {
    expect(PAGES.size, "page.tsx encontrados").toBeGreaterThanOrEqual(MIN_PAGES);
    for (const path of MIGRATED_PAGES) {
      expect(PAGES.has(path), `${path} está en el walk`).toBe(true);
    }
    // Anclas de contenido: confirman que se leyó la página correcta.
    expect(PAGES.get("app/admin/page.tsx")).toContain("export default async function AdminPage");
    expect(PAGES.get("app/login/page.tsx")).toContain("export default async function LoginPage");
    expect(PAGES.get("app/page.tsx")).toContain("export default async function HomePage");
  });

  it("ningún page.tsx compone a mano el shell ni escribe un `<h1>` literal", () => {
    const offenders: string[] = [];
    for (const [path, source] of PAGES) {
      const findings = shellViolations(source);
      if (findings.length > 0) offenders.push(`${path}: ${findings.join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("ningún page.tsx pide `min-h-screen` (la altura la resuelve el shell)", () => {
    const offenders: string[] = [];
    for (const [path, source] of PAGES) {
      const found = minHScreenTokens(source);
      if (found.length > 0) offenders.push(`${path}: ${found.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("cada page.tsx importa y usa PageContainer y PageHeader", () => {
    const failures: string[] = [];
    for (const [path, source] of PAGES) {
      const specifiers = pageImportSpecifiers(source);
      for (const name of ["PageContainer", "PageHeader"]) {
        if (!specifiers.includes(name)) failures.push(`${path}: no importa ${name}`);
        if (!usesComponent(source, name)) failures.push(`${path}: no usa <${name}>`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("el `<h1>` del primitivo es exactamente text-3xl font-bold, una sola vez", () => {
    const primitive = readFileSync(PRIMITIVE_PATH, "utf8");
    expect(h1Classes(primitive)).toEqual(["text-3xl", "font-bold"]);
    // Una sola vez por página: el primitivo es el único que lo declara.
    expect([...stripComments(primitive).matchAll(/<h1(?=[\s/>])/g)]).toHaveLength(1);
  });
});
