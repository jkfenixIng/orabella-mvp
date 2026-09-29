import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------------
   Invariante estructural: toda server action exportada valida autorización.

   Por qué existe: un archivo con la directiva `"use server"` convierte CADA
   export async en un endpoint HTTP POST alcanzable desde el navegador. En
   particular `adminCreateUserAction` usa el cliente `service_role`, que salta
   RLS: si la action no valida la sesión, no hay segunda capa de defensa.

   Test offline y determinista: lee los archivos reales del repo (mismo patrón
   de casa que tests/design-tokens.test.ts y tests/hardening.test.ts). Sin red,
   sin mocks, sin Supabase.

   Qué cubre ahora (W3, endurecimiento):

   1. GUARDA — toda acción exportada valida autorización, salvo las cuatro
      públicas de auth. La allowlist está indexada por ARCHIVO + NOMBRE: una
      action nueva y sin guarda que reutilice uno de esos nombres en otro
      módulo ya no queda "sombreada" por un primer match por nombre.
   2. ORDEN — la PRIMERA llamada a un módulo `service` de cada acción debe ser
      una guarda. Antes solo se exigía presencia de token, así que una action
      que mutara antes de guardar pasaba igual: esa es la próxima forma del
      mismo bug que este archivo existe para prevenir.
   3. LIMPIEZA — las coincidencias se buscan sobre el fuente con comentarios y
      literales (`'...'`, `"..."`, `` `...` ``) en blanco, para que una guarda
      citada en un comentario o en un mensaje de error no cuente como guarda.
   4. FORMA DE EXPORT — todo export de un actions.ts debe ser una declaración
      de función (`export async function` / `export function`). El scanner no
      ve `export const x = async () => {}`, `export default` ni
      `export { x } from "..."`; si aparecen, este test lo dice con el nombre
      del archivo y la línea.
   5. ENUMERACIÓN — cada actions.ts aporta al menos una acción y el número de
      módulos analizados coincide con los actions.ts en disco. Una glob rota
      rompe ruidosamente en vez de pasar en el aire.

   Los self-tests del final ejercitan los helpers contra fuentes sintéticas
   (strings dentro de este archivo, sin tocar `src/`): son la prueba de que las
   reglas nuevas no son decorativas.

   --------------------------------------------------------------------------
   LIMITACIONES DEL STRIPPER (honestas: NO es un parser de JavaScript):

   - No reconoce literales regex. Un valor como `const re = /a//b/` (un `/`
     escapado no ayuda si el stripper no sabe de regex) se leería como el
     inicio de un comentario de línea y borraría el resto de la línea.
   - Las interpolaciones `${...}` de un template literal se borran junto con
     el literal: una guarda escrita dentro de `${}` queda invisible.
   - No entiende JSX: el texto JSX fuera de strings no se limpia.
   - Los strings sin cerrar se tratan como "hasta el final del archivo".
   - El parseo de imports exige que la sentencia `import` arranque una línea;
     varios imports en una misma línea solo se ven si el primero arranca línea.
   -------------------------------------------------------------------------- */

const APP_ROOT = process.cwd();
const FEATURES_DIR = join(APP_ROOT, "src", "features");

/**
 * Mínimo de acciones exportadas que el repo debe tener. El total real es 67
 * (8 módulos, verificado el 2026-10-01). El piso se deja holgadamente por
 * debajo para no volverse un mantenimiento molesto, pero sigue siendo
 * suficientemente alto para que una enumeración vacía o a medias falle.
 */
const MIN_SCANNED_ACTIONS = 50;

/** Regex que reconoce una guarda de autorización dentro del cuerpo. */
const GUARD_RE = /\brequire[A-Z]\w*\s*\(|\bgetSessionUser\s*\(/;

interface PublicAction {
  /** Ruta relativa al root de la app, con separadores POSIX. */
  file: string;
  name: string;
  /** Motivo por el que esta exportación NO exige sesión previa. */
  why: string;
}

/**
 * Allowlist de acciones legítimamente públicas. La clave es la PAREJA
 * (archivo, nombre): si mañana aparece otra `loginAction` sin guarda en, digamos,
 * `src/features/billing/actions.ts`, esta lista no la cubre y el test la marca.
 * Solo pueden estar aquí las que NO pueden exigir sesión previa.
 */
const PUBLIC_ACTIONS: readonly PublicAction[] = [
  {
    file: "src/features/auth/actions.ts",
    name: "loginAction",
    why: "pública por diseño: es la que CREA la sesión (no hay sesión todavía).",
  },
  {
    file: "src/features/auth/actions.ts",
    name: "logoutAction",
    why: "pública por diseño: destruye la sesión y es inofensiva sin ella.",
  },
  {
    file: "src/features/auth/actions.ts",
    name: "requestResetAction",
    why: "pública por diseño: recuperación de clave para quien no puede entrar.",
  },
  {
    file: "src/features/auth/actions.ts",
    name: "confirmResetAction",
    why: "pública por diseño: segundo paso de la recuperación, sin sesión.",
  },
];

/** ¿La pareja (archivo, nombre) está allowlistada como pública? */
function isPublicAction(action: { file: string; name: string }): boolean {
  return PUBLIC_ACTIONS.some(
    (entry) => entry.file === action.file && entry.name === action.name,
  );
}

/* ---- Stripper ------------------------------------------------------------ */

const NEWLINE = "\n";
/** Código de `\` (backslash). Se usa numérico para no pelear con escapes. */
const BACKSLASH_CODE = 92;

/**
 * Devuelve una copia del fuente del MISMO largo en la que el contenido que no
 * debe poder satisfacer un chequeo quedó reemplazado por espacios (los saltos
 * de línea se preservan para que los offsets sigan siendo legibles):
 * comentarios `//`, comentarios `/* ... *\/` y, si `literals` es true, los
 * literales `'...'`, `"..."` y `` `...` ``.
 */
function blankOut(source: string, options: { literals: boolean }): string {
  const chars = source.split("");
  const length = source.length;

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (source[index] !== NEWLINE) chars[index] = " ";
    }
  };

  let index = 0;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      let end = index + 2;
      while (end < length && source[end] !== NEWLINE) end += 1;
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

    if (options.literals && (char === '"' || char === "'" || char === "`")) {
      let end = index + 1;
      while (end < length) {
        if (source.charCodeAt(end) === BACKSLASH_CODE) {
          end += 2;
          continue;
        }
        if (source[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      end = Math.min(end, length);
      blank(index, end);
      index = end;
      continue;
    }

    index += 1;
  }

  return chars.join("");
}

/** Deja los strings intactos: lo necesita el parseo de imports (specifiers). */
function stripComments(source: string): string {
  return blankOut(source, { literals: false });
}

/** Fuente sin comentarios ni literales: es contra esto que se hacen los match. */
function stripCommentsAndLiterals(source: string): string {
  return blankOut(source, { literals: true });
}

/* ---- Imports de service -------------------------------------------------- */

interface ServiceImports {
  /** Nombres locales llamables directamente (named y default). */
  direct: string[];
  /** Alias de `import * as ns from ".../service"`. */
  namespaces: string[];
}

/** ¿El specifier apunta a un módulo `service` (local o por ruta)? */
function isServiceSpecifier(specifier: string): boolean {
  return specifier === "./service" || specifier.endsWith("/service");
}

/** Extrae los nombres locales de la cláusula de un `import`. */
function collectImportBindings(
  clause: string,
  direct: Set<string>,
  namespaces: Set<string>,
): void {
  const normalized = clause.replace(/\s+/g, " ").replace(/^type /, "").trim();
  const open = normalized.indexOf("{");
  const close = normalized.lastIndexOf("}");

  if (open !== -1 && close > open) {
    for (const part of normalized.slice(open + 1, close).split(",")) {
      const token = part.trim();
      if (token === "") continue;
      const local = token.split(" as ").pop()?.trim() ?? "";
      if (local !== "") direct.add(local);
    }
  }

  const prefix = open === -1 ? normalized : normalized.slice(0, open);
  const suffix = open === -1 || close === -1 ? "" : normalized.slice(close + 1);
  const outside = (prefix + suffix).trim();

  if (outside.includes("* as ")) {
    const alias = outside.split("* as ").pop()?.trim().split(/[ ,]/)[0] ?? "";
    if (alias !== "") namespaces.add(alias);
    return;
  }

  const defaultName = outside.replace(/,/g, " ").trim().split(" ")[0] ?? "";
  if (defaultName !== "") direct.add(defaultName);
}

/**
 * Identificadores cuyo specifier es `./service` o termina en `/service`. Los
 * imports se leen del fuente con comentarios en blanco pero strings intactos:
 * son justamente los specifiers.
 */
function parseServiceImports(source: string): ServiceImports {
  const code = stripComments(source);
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const statement = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;

  let match = statement.exec(code);
  while (match !== null) {
    if (isServiceSpecifier(match[2])) {
      collectImportBindings(match[1], direct, namespaces);
    }
    match = statement.exec(code);
  }

  return { direct: [...direct], namespaces: [...namespaces] };
}

/* ---- Escaneo de acciones ------------------------------------------------- */

interface ScannedAction {
  /** Ruta relativa al root de la app, con separadores POSIX. */
  file: string;
  name: string;
  /** Cuerpo con comentarios y literales en blanco (offsets preservados). */
  body: string;
  /** Cuerpo original, solo como evidencia en los self-tests. */
  rawBody: string;
  /** Offset del cuerpo dentro del fuente del módulo. */
  bodyStart: number;
}

/** Divide un módulo en trozos por función exportada (el prelude se descarta). */
function scanModuleSource(source: string, file: string): ScannedAction[] {
  const code = stripCommentsAndLiterals(source);
  const declaration = /^export (?:async )?function /gm;
  const marks: Array<{ start: number; bodyStart: number }> = [];

  let match = declaration.exec(source);
  while (match !== null) {
    marks.push({ start: match.index, bodyStart: match.index + match[0].length });
    match = declaration.exec(source);
  }

  return marks.map((mark, position) => {
    const end = position + 1 < marks.length ? marks[position + 1].start : source.length;
    const rawBody = source.slice(mark.bodyStart, end);
    const name = rawBody.match(/^([A-Za-z0-9_$]+)\s*\(/)?.[1] ?? "";

    return {
      file,
      name,
      body: code.slice(mark.bodyStart, end),
      rawBody,
      bodyStart: mark.bodyStart,
    };
  });
}

/** ¿La acción tiene alguna guarda de autorización (en código, no en texto)? */
function hasGuard(action: ScannedAction): boolean {
  return GUARD_RE.test(action.body);
}

/* ---- Orden: la primera llamada a service debe ser una guarda ------------- */

interface ServiceCall {
  /** Nombre llamado, tal como se reporta (`mutateThing` o `svc.mutateThing`). */
  name: string;
  /** Offset absoluto dentro del fuente del módulo. */
  offset: number;
}

interface OrderSource {
  /** Fuente con comentarios y literales en blanco. */
  body: string;
  /** Offset del cuerpo dentro del fuente del módulo. */
  bodyStart: number;
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/** Índice de `identifier` como token completo (no parte de un nombre mayor). */
function indexOfWholeIdentifier(source: string, identifier: string, from: number): number {
  let index = source.indexOf(identifier, from);
  while (index !== -1) {
    const before = index === 0 ? undefined : source[index - 1];
    const after = source[index + identifier.length];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return index;
    index = source.indexOf(identifier, index + 1);
  }
  return -1;
}

/** Primera invocación directa `identifier(` dentro de `source`. */
function firstDirectCall(source: string, identifier: string): number {
  let from = 0;
  for (;;) {
    const index = indexOfWholeIdentifier(source, identifier, from);
    if (index === -1) return -1;
    if (source[skipWhitespace(source, index + identifier.length)] === "(") return index;
    from = index + identifier.length;
  }
}

/** Primera invocación `alias.member(` dentro de `source`. */
function firstNamespaceCall(source: string, alias: string): { member: string; index: number } | null {
  let from = 0;
  for (;;) {
    const index = indexOfWholeIdentifier(source, alias, from);
    if (index === -1) return null;

    let cursor = skipWhitespace(source, index + alias.length);
    if (source[cursor] === ".") {
      cursor = skipWhitespace(source, cursor + 1);
      const memberStart = cursor;
      while (cursor < source.length && isIdentifierChar(source[cursor])) cursor += 1;
      const member = source.slice(memberStart, cursor);
      if (member !== "" && source[skipWhitespace(source, cursor)] === "(") {
        return { member, index };
      }
    }

    from = index + alias.length;
  }
}

/** Primera llamada, en orden de aparición, a cualquier identificador `service`. */
function firstServiceCall(
  action: OrderSource,
  imports: ServiceImports,
): ServiceCall | null {
  let best: ServiceCall | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;

  const consider = (candidate: ServiceCall | null): void => {
    if (candidate === null || candidate.offset >= bestOffset) return;
    best = candidate;
    bestOffset = candidate.offset;
  };

  for (const identifier of imports.direct) {
    const index = firstDirectCall(action.body, identifier);
    consider(index === -1 ? null : { name: identifier, offset: action.bodyStart + index });
  }

  for (const alias of imports.namespaces) {
    const found = firstNamespaceCall(action.body, alias);
    consider(
      found === null
        ? null
        : { name: `${alias}.${found.member}`, offset: action.bodyStart + found.index },
    );
  }

  return best;
}

/** Una guarda es, por definición, una primera llamada aceptable. */
function isGuardCall(call: ServiceCall): boolean {
  return GUARD_RE.test(`${call.name}(`);
}

/* ---- Chequeos agregados -------------------------------------------------- */

/** Formas de export que el scanner NO puede analizar. */
function exportFormOffenses(source: string, file: string): string[] {
  const code = stripCommentsAndLiterals(source);
  const offenses: string[] = [];
  const keyword = /^export\b/gm;

  let match = keyword.exec(code);
  while (match !== null) {
    const statement = code.slice(match.index);
    if (!/^export\s+(?:async\s+)?function\s+/.test(statement)) {
      const snippet = statement.split(NEWLINE)[0].trim();
      offenses.push(
        `${file}: la exportación \`${snippet}\` no es una declaración de función, ` +
          "así que el scanner no puede verla. Toda exportación de un actions.ts debe ser " +
          "`export async function` o `export function`.",
      );
    }
    match = keyword.exec(code);
  }

  return offenses;
}

interface ModuleAnalysis {
  file: string;
  imports: ServiceImports;
  actions: ScannedAction[];
  /** Acciones no públicas sin ninguna guarda (archivo: nombre). */
  unguarded: string[];
  /** Acciones cuya primera llamada a service no es una guarda. */
  order: string[];
  /** Exports con una forma que el scanner no puede analizar. */
  exportForms: string[];
}

/**
 * Analiza un fuente completo (real o sintético) y devuelve todos los hallazgos.
 * Es pura respecto del filesystem: la lectura de disco vive en `readActionFiles`,
 * así que los self-tests pueden pasarle strings arbitrarios.
 */
function analyzeModule(source: string, file: string): ModuleAnalysis {
  const actions = scanModuleSource(source, file);
  const imports = parseServiceImports(source);

  const unguarded = actions
    .filter((action) => !isPublicAction(action) && !hasGuard(action))
    .map((action) => `${action.file}: ${action.name}`);

  const order: string[] = [];
  for (const action of actions) {
    // Las públicas de la allowlist no pueden pasar por una guarda (todavía no
    // existe sesión), así que se excluyen del invariante de ORDEN por la misma
    // razón por la que se excluyen del de presencia. Un actions.ts real que
    // reutilice ese nombre en OTRO módulo no queda exento: la allowlist va por
    // pareja (archivo, nombre).
    if (isPublicAction(action)) continue;
    const call = firstServiceCall(action, imports);
    if (call === null || isGuardCall(call)) continue;
    order.push(
      `${action.file}: ${action.name} (first service call '${call.name}' at offset ` +
        `${call.offset} is not an authorization guard)`,
    );
  }

  return { file, imports, actions, unguarded, order, exportForms: exportFormOffenses(source, file) };
}

/* ---- Enumeración real ---------------------------------------------------- */

function toRepoPath(absolutePath: string): string {
  return relative(APP_ROOT, absolutePath).split(sep).join("/");
}

/** Enumera `src/features/<feature>/actions.ts` leyendo el directorio real. */
function readActionFiles(): string[] {
  return readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FEATURES_DIR, entry.name, "actions.ts"))
    .filter((candidate) => existsSync(candidate))
    .sort();
}

/** Recuento independiente, para contrastar contra la enumeración anterior. */
function countActionsFilesOnDisk(): number {
  return readdirSync(FEATURES_DIR, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(FEATURES_DIR, entry.name, "actions.ts")),
  ).length;
}

const ACTION_FILES = readActionFiles();
const MODULES: ModuleAnalysis[] = ACTION_FILES.map((absolutePath) =>
  analyzeModule(readFileSync(absolutePath, "utf8"), toRepoPath(absolutePath)),
);
const SCANNED: ScannedAction[] = MODULES.flatMap((module) => module.actions);

/* ---- Tests --------------------------------------------------------------- */

describe("guardas de autorización en server actions", () => {
  it("enumera todos los actions.ts de disco y no arranca vacío", () => {
    expect(ACTION_FILES.length, "no se encontró ningún src/features/*/actions.ts").toBeGreaterThan(
      0,
    );
    expect(
      MODULES.length,
      "módulos analizados != archivos src/features/*/actions.ts encontrados en disco",
    ).toBe(countActionsFilesOnDisk());

    const empty = MODULES.filter((module) => module.actions.length === 0).map(
      (module) => module.file,
    );
    expect(
      empty,
      `actions.ts sin ninguna acción escaneada (el scanner no los está viendo): ${empty.join(", ")}`,
    ).toEqual([]);

    expect(SCANNED.length, "enumeración de acciones sospechosamente chica").toBeGreaterThanOrEqual(
      MIN_SCANNED_ACTIONS,
    );
  });

  it("cada actions.ts abre con la directiva use server", () => {
    for (const absolutePath of ACTION_FILES) {
      const source = readFileSync(absolutePath, "utf8");
      expect(
        /^\s*["']use server["']/.test(source),
        `${toRepoPath(absolutePath)}: no abre con la directiva "use server"`,
      ).toBe(true);
    }
  });

  it("toda acción exportada valida autorización salvo las públicas de auth", () => {
    const offenses = MODULES.flatMap((module) => module.unguarded);

    expect(
      offenses,
      `Acciones exportadas sin guarda de autorización (archivo: función): ${offenses.join(", ")}`,
    ).toEqual([]);
  });

  it("la primera llamada a un módulo service de cada acción es una guarda", () => {
    const offenses = MODULES.flatMap((module) => module.order);

    expect(
      offenses,
      "Acciones que llaman a su módulo service antes de autorizar (la mutación " +
        `puede ejecutarse sin sesión): ${offenses.join(" | ")}`,
    ).toEqual([]);
  });

  it("todo export de un actions.ts es una declaración de función", () => {
    const offenses = MODULES.flatMap((module) => module.exportForms);

    expect(offenses, offenses.join(" | ")).toEqual([]);
  });

  it("la allowlist no tiene entradas muertas", () => {
    const dead = PUBLIC_ACTIONS.filter(
      (entry) => !SCANNED.some((action) => action.file === entry.file && action.name === entry.name),
    ).map((entry) => `${entry.file}: ${entry.name}`);

    expect(
      dead,
      `Entradas muertas en PUBLIC_ACTIONS (ya no se escanean): ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("cada acción allowlisted se declara exactamente una vez en todo el repo", () => {
    const offenses: string[] = [];

    for (const entry of PUBLIC_ACTIONS) {
      const hits = SCANNED.filter((action) => action.name === entry.name);
      if (hits.length !== 1) {
        offenses.push(
          `${entry.name}: ${hits.length} declaraciones (` +
            `${hits.map((hit) => hit.file).join(", ")}), la allowlist quedaría ambigua`,
        );
      }
    }

    expect(offenses, offenses.join(" | ")).toEqual([]);
  });

  it("cada entrada de la allowlist apunta al módulo donde la función se declara", () => {
    const offenses: string[] = [];

    for (const entry of PUBLIC_ACTIONS) {
      const found = SCANNED.find(
        (action) => action.file === entry.file && action.name === entry.name,
      );
      if (found === undefined) {
        const elsewhere = SCANNED.filter((action) => action.name === entry.name).map(
          (action) => action.file,
        );
        offenses.push(
          `${entry.file}: ${entry.name} (${entry.why}) no se declara ahí` +
            (elsewhere.length > 0 ? `; se declara en ${elsewhere.join(", ")}` : ""),
        );
      }
    }

    expect(offenses, offenses.join(" | ")).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   Self-tests: los helpers, contra fuentes sintéticas armadas como strings.
   No crean archivos ni tocan `src/`; son la evidencia de que la invariante de
   orden, la limpieza de comentarios/literales y el chequeo de forma de export
   no son decorativos.
   -------------------------------------------------------------------------- */

const FIXTURE_MUTATE_THEN_GUARD = `
import {
  requireSession,
  mutateThing,
} from "./service";

export async function doThing(input: { token: string }) {
  const session = await mutateThing(input);
  await requireSession(session.token);
  return { ok: true };
}
`;

const FIXTURE_GUARD_FIRST = `
import {
  requireSession,
  mutateThing as mutate,
} from "./service";

export async function doThing(input: { token: string }) {
  const session = await requireSession(input.token);
  await mutate(session.sedeId, input);
  return { ok: true };
}
`;

const FIXTURE_GUARD_ONLY_IN_TEXT = `
import { mutateThing } from "./service";

/**
 * Antes empezaba con requireSession(token); se movió al wrapper.
 */
export async function doThing(input: unknown) {
  // requireSession(token) ya no vive aquí
  const note = "revisado por requireSession(token)";
  await mutateThing(input);
  return { ok: true, note };
}
`;

const FIXTURE_ARROW_EXPORT = `
import { mutateThing } from "./service";

export const doThing = async (input: unknown) => {
  await mutateThing(input);
  return { ok: true };
};
`;

const FIXTURE_OTHER_EXPORT_FORMS = `
import { mutateThing } from "./service";

export default async function doThing(input: unknown) {
  await mutateThing(input);
}

export { mutateThing } from "./service";
`;

const BACKSLASH = String.fromCharCode(BACKSLASH_CODE);

const FIXTURE_LITERAL_TRAPS = [
  "export async function doThing(input: { token: string }) {",
  '  const url = "https://example.test//invoices"; await requireSession(input.token);',
  `  const quoted = "dice ${BACKSLASH}" y // tampoco es comentario";`,
  "  return { ok: true };",
  "}",
  "",
].join(NEWLINE);

describe("self-tests de los helpers (fuentes sintéticas)", () => {
  it("la allowlist se indexa por archivo Y nombre (un mismo nombre en otro módulo NO queda sombreado)", () => {
    const source = `
import { doLogin } from "./service";

export async function loginAction(input: unknown) {
  return doLogin(input);
}
`;

    // Mismo nombre público, otro módulo: debe reportarse como sin guarda.
    const elsewhere = analyzeModule(source, "synthetic/not-auth-actions.ts");
    expect(elsewhere.unguarded).toEqual(["synthetic/not-auth-actions.ts: loginAction"]);

    // La pareja real (auth + loginAction) sí está exenta.
    const auth = analyzeModule(source, "src/features/auth/actions.ts");
    expect(auth.unguarded).toEqual([]);

    expect(isPublicAction({ file: "src/features/auth/actions.ts", name: "loginAction" })).toBe(true);
    expect(isPublicAction({ file: "synthetic/not-auth-actions.ts", name: "loginAction" })).toBe(
      false,
    );
  });

  it("(i) mutar antes de guardar reporta ofensa de ORDEN", () => {
    const analysis = analyzeModule(FIXTURE_MUTATE_THEN_GUARD, "synthetic/mutate-first.ts");

    expect(analysis.order).toHaveLength(1);
    expect(analysis.order[0]).toContain("synthetic/mutate-first.ts: doThing");
    expect(analysis.order[0]).toContain("first service call 'mutateThing'");
    expect(analysis.order[0]).toContain("is not an authorization guard");
    // La guarda existe: el fallo es de orden, no de presencia.
    expect(analysis.unguarded).toEqual([]);
  });

  it("(ii) una guarda solo en comentario/string reporta ofensa de GUARDA", () => {
    const analysis = analyzeModule(FIXTURE_GUARD_ONLY_IN_TEXT, "synthetic/hidden-guard.ts");
    const action = analysis.actions[0];

    expect(analysis.unguarded).toHaveLength(1);
    expect(analysis.unguarded[0]).toBe("synthetic/hidden-guard.ts: doThing");
    // Evidencia de que el stripper es lo que atrapa el caso: el texto crudo sí
    // contiene el token, el texto limpio no.
    expect(action.rawBody).toContain("requireSession");
    expect(GUARD_RE.test(action.body)).toBe(false);
  });

  it("(iii) `export const x = async () => {}` reporta forma de export no analizable", () => {
    const analysis = analyzeModule(FIXTURE_ARROW_EXPORT, "synthetic/arrow.ts");

    expect(analysis.exportForms).toHaveLength(1);
    expect(analysis.exportForms[0]).toContain("synthetic/arrow.ts");
    expect(analysis.exportForms[0]).toContain("export const doThing");
    expect(analysis.exportForms[0]).toContain("no es una declaración de función");
  });

  it("(iii bis) `export default` y `export { x } from` también reportan", () => {
    const analysis = analyzeModule(FIXTURE_OTHER_EXPORT_FORMS, "synthetic/other-forms.ts");

    expect(analysis.exportForms).toHaveLength(2);
    expect(analysis.exportForms.join(" | ")).toContain("export default");
    expect(analysis.exportForms.join(" | ")).toContain("export { mutateThing } from");
  });

  it("(iv) guarda primero y después la llamada a service pasa limpio", () => {
    const analysis = analyzeModule(FIXTURE_GUARD_FIRST, "synthetic/guard-first.ts");

    expect(analysis.unguarded).toEqual([]);
    expect(analysis.order).toEqual([]);
    expect(analysis.exportForms).toEqual([]);
  });

  it("el stripper no se deja engañar por `//` ni comillas escapadas dentro de strings", () => {
    const analysis = analyzeModule(FIXTURE_LITERAL_TRAPS, "synthetic/literal-traps.ts");

    expect(analysis.actions).toHaveLength(1);
    expect(analysis.unguarded).toEqual([]);
    expect(GUARD_RE.test(analysis.actions[0].body)).toBe(true);
  });

  it("los imports se leen de `./service` y de cualquier ruta que termine en `/service`", () => {
    const analysis = analyzeModule(
      `
import { requireSession } from "@/src/features/payroll/service";
import { mutateThing as mutate } from "./service";
import { readFile } from "node:fs";

export async function doThing() {
  await mutate();
  await requireSession();
}
`,
      "synthetic/imports.ts",
    );

    expect(analysis.imports.direct).toEqual(
      expect.arrayContaining(["requireSession", "mutate"]),
    );
    expect(analysis.imports.direct).not.toContain("readFile");
    expect(analysis.order).toHaveLength(1);
    expect(analysis.order[0]).toContain("first service call 'mutate'");
  });
});
