import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPayrollPeriods, POST as postPayrollPeriod } from "@/app/api/v1/payroll-periods/route";
import {
  DELETE as deletePayrollPeriod,
  GET as getPayrollPeriod,
} from "@/app/api/v1/payroll-periods/[id]/route";
import { POST as calculatePayrollPeriod } from "@/app/api/v1/payroll-periods/[id]/calculate/route";
import { POST as closePayrollPeriod } from "@/app/api/v1/payroll-periods/[id]/close/route";
import { POST as postPayrollPayments } from "@/app/api/v1/payroll-items/[id]/payments/route";
import { POST as postVoucher } from "@/app/api/v1/vouchers/route";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import type { SessionUser } from "@/src/features/auth/service";
import * as adminService from "@/src/features/admin/service";
import * as platformService from "@/src/features/platform/service";
import { requirePlatformAdmin } from "@/src/features/platform/service";
import {
  getPeriodDetailAction,
  getVoucherSettingsAction,
  listPayrollExtrasAction,
  listPeriodsAction,
  payPayrollExtraAction,
  payPayrollItemAction,
  requestVoucherAction,
} from "@/src/features/payroll/actions";
import * as payrollService from "@/src/features/payroll/service";

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
   Roles exigidos por superficie: la nómina es del admin (y del empleado en lo
   suyo); los vales siguen siendo de la caja.

   Por qué existe: el bloque de arriba exige que HAYA una guarda, no que sea la
   guarda CORRECTA. Cambiar `requirePayrollAdmin` por `requirePayrollPayer`
   (que admite caja) dejaba todo en verde y abría la nómina a la caja — que es
   exactamente el defecto que este bloque cierra. Acá se lee el ROL que admite
   cada guarda (el segundo argumento de `requireSedeRole(session.roles, X)` en
   `src/features/payroll/service.ts`, resolviendo las constantes
   `X: RoleCode[] = [...]`) y se exige una tabla de roles por superficie, con
   las rutas de `app/api/v1` incluidas.

   Reglas derivadas (valen para cualquier superficie futura, no solo para las
   filas de la tabla):
   - Superficie de NÓMINA (`kind: "payroll"`): admite admin y NUNCA caja.
   - Superficie de VALES con atención en mostrador (`cajaDebeEntrar: true`):
     sigue admitiendo caja. Es el control anti-sobreguardia: "todo solo admin"
     rompería los vales, que son un flujo de caja por diseño (la caja abre el
     vale con turno abierto).
   -------------------------------------------------------------------------- */

const PAYROLL_SERVICE_FILE = "src/features/payroll/service.ts";
const PAYROLL_ACTIONS_FILE = "src/features/payroll/actions.ts";
const PLATFORM_SERVICE_FILE = "src/features/platform/service.ts";
const PLATFORM_ACTIONS_FILE = "src/features/platform/actions.ts";

/**
 * Guardas que NO viven en `payroll/service.ts`, con los roles que admiten.
 * `requireSession` (admin/service) es "cualquier rol autenticado de su sede".
 */
const EXTERNAL_GUARD_ROLES: Record<string, string[]> = {
  requireSession: ["admin", "caja", "empleado"],
  requireAdminSession: ["admin"],
};

interface SurfaceSpec {
  /** Ruta relativa al root de la app, con separadores POSIX. */
  file: string;
  /** Nombre exportado: la acción o el handler HTTP (GET/POST/DELETE). */
  name: string;
  /** Qué datos toca: nómina (plata del personal), vales o la superficie de plataforma. */
  kind: "payroll" | "voucher" | "platform";
  /** Roles que debe admitir, en el orden en que se declaran. */
  roles: string[];
  /** Superficie de vales por la que la caja DEBE seguir entrando. */
  cajaDebeEntrar?: boolean;
  /** Por qué esa lista de roles (la decisión, no la observación). */
  why: string;
}

/**
 * Tabla de autorización del módulo de nómina/vales. Cada fila es una entrada
 * alcanzable: una server action (`"use server"` convierte todo export en un
 * endpoint POST) o un handler de `app/api/v1`. El test exige que el fuente real
 * coincida con esta tabla.
 */
const SURFACES: readonly SurfaceSpec[] = [
  // ---- plataforma: solo la cuenta con el rol `superadmin` (G3a) ----
  {
    file: PLATFORM_ACTIONS_FILE,
    name: "listPlatformSedesAction",
    kind: "platform",
    roles: ["superadmin"],
    why: "lista TODAS las sedes de la instalación: es la superficie de plataforma y ningún rol de sede entra.",
  },
  // ---- acciones de nómina: solo admin (pagar un ítem incluido) ----
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "openPayrollPeriodAction",
    kind: "payroll",
    roles: ["admin"],
    why: "abre el periodo: generar la nómina es del admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "calculatePayrollAction",
    kind: "payroll",
    roles: ["admin"],
    why: "calcula la nómina: generar la nómina es del admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "payPayrollItemAction",
    kind: "payroll",
    roles: ["admin"],
    why: "paga un ítem de nómina: es parte de liquidarla, y la caja no tiene acceso al módulo.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "payPayrollExtraAction",
    kind: "payroll",
    roles: ["admin"],
    why: "registra un pago extraordinario (despido/renuncia/emergencia) con motivo: es plata de nómina y la caja no entra al módulo.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "listPayrollExtrasAction",
    kind: "payroll",
    roles: ["admin"],
    why: "lee el registro de pagos extraordinarios: es lectura de nómina completa y la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "listPayrollMonthRowsAction",
    kind: "payroll",
    roles: ["admin"],
    why: "lee los pagos de un mes de un empleado: es lectura de nómina y la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "closePayrollPeriodAction",
    kind: "payroll",
    roles: ["admin"],
    why: "cierra el periodo (lo vuelve inmutable): revisar la nómina es del admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "deletePayrollPeriodAction",
    kind: "payroll",
    roles: ["admin"],
    why: "borra el borrador y devuelve los vales descontados: es del admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "correctPayrollPeriodAction",
    kind: "payroll",
    roles: ["admin"],
    why: "corrige un período cerrado (registro con las dos versiones y motivo): es plata ya firmada y la caja no entra al módulo.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "getPayrollPeriodCorrectionAction",
    kind: "payroll",
    roles: ["admin"],
    why: "lee la corrección de un período: muestra la nómina completa de la sede (dos versiones y lo pagado) y la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "listPeriodsAction",
    kind: "payroll",
    roles: ["admin", "empleado"],
    why: "el empleado necesita sus periodos para ver SU recibo (la página /payroll es admin+empleado); la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "getPeriodDetailAction",
    kind: "payroll",
    roles: ["admin", "empleado"],
    why: "mismo caso, con alcance por fila: el admin ve todo, el empleado solo sus ítems; la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "getPayrollSettlementSourcesAction",
    kind: "payroll",
    roles: ["admin", "empleado"],
    why: "lee las facturas y vales de la liquidación de UN empleado (alcance por fila: el empleado solo la suya); es lectura de nómina y la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "getPayrollStartDateAction",
    kind: "payroll",
    roles: ["admin"],
    why: "F10: lee desde cuándo existe la nómina de la sede. Es configuración de nómina (y el piso de los ciclos que se ofrecen), no del recibo del empleado: la caja no entra.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "setPayrollStartDateAction",
    kind: "payroll",
    roles: ["admin"],
    why: "F10: fija la fecha de inicio de la nómina de la sede (configuración de nómina, solo admin).",
  },
  // ---- rutas de nómina: solo admin ----
  {
    file: "app/api/v1/payroll-periods/route.ts",
    name: "GET",
    kind: "payroll",
    roles: ["admin"],
    why: "lista los periodos de la sede: es lectura de nómina completa.",
  },
  {
    file: "app/api/v1/payroll-periods/route.ts",
    name: "POST",
    kind: "payroll",
    roles: ["admin"],
    why: "abre un periodo.",
  },
  {
    file: "app/api/v1/payroll-periods/[id]/route.ts",
    name: "GET",
    kind: "payroll",
    roles: ["admin"],
    why: "detalle del periodo SIN alcance por fila: si lo leyera otro rol, vería la nómina de toda la planta.",
  },
  {
    file: "app/api/v1/payroll-periods/[id]/route.ts",
    name: "DELETE",
    kind: "payroll",
    roles: ["admin"],
    why: "borra un borrador.",
  },
  {
    file: "app/api/v1/payroll-periods/[id]/calculate/route.ts",
    name: "POST",
    kind: "payroll",
    roles: ["admin"],
    why: "calcula la nómina.",
  },
  {
    file: "app/api/v1/payroll-periods/[id]/close/route.ts",
    name: "POST",
    kind: "payroll",
    roles: ["admin"],
    why: "cierra la nómina.",
  },
  {
    file: "app/api/v1/payroll-items/[id]/payments/route.ts",
    name: "POST",
    kind: "payroll",
    roles: ["admin"],
    why: "paga un ítem de nómina.",
  },
  // ---- vales: el módulo sigue siendo de la caja + el admin ----
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "requestVoucherAction",
    kind: "voucher",
    roles: ["admin", "caja"],
    cajaDebeEntrar: true,
    why: "la caja abre el vale al empleado con su turno abierto: es un flujo de caja por diseño.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "getVoucherSettingsAction",
    kind: "voucher",
    roles: ["admin", "caja", "empleado"],
    cajaDebeEntrar: true,
    why: "topes vigentes del vale: es lectura del flujo de vales (cualquier rol autenticado de su sede).",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "listVouchersAction",
    kind: "voucher",
    roles: ["admin", "caja", "empleado"],
    cajaDebeEntrar: true,
    why: "el admin y la caja ven todos los vales de la sede; el empleado solo los suyos (alcance por fila).",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "setVoucherLimitsAction",
    kind: "voucher",
    roles: ["admin"],
    why: "configura topes: solo admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "approveVoucherAction",
    kind: "voucher",
    roles: ["admin"],
    why: "autoriza un vale fuera de rango: solo admin.",
  },
  {
    file: PAYROLL_ACTIONS_FILE,
    name: "rejectVoucherAction",
    kind: "voucher",
    roles: ["admin"],
    why: "rechaza un vale pendiente: solo admin.",
  },
  {
    file: "app/api/v1/vouchers/route.ts",
    name: "GET",
    kind: "voucher",
    roles: ["admin", "caja", "empleado"],
    cajaDebeEntrar: true,
    why: "lista de vales de la sede.",
  },
  {
    file: "app/api/v1/vouchers/route.ts",
    name: "POST",
    kind: "voucher",
    roles: ["admin", "caja"],
    cajaDebeEntrar: true,
    why: "la caja abre el vale (con turno abierto).",
  },
  {
    file: "app/api/v1/vouchers/[id]/approve/route.ts",
    name: "POST",
    kind: "voucher",
    roles: ["admin"],
    why: "autoriza un vale pendiente.",
  },
  {
    file: "app/api/v1/vouchers/[id]/reject/route.ts",
    name: "POST",
    kind: "voucher",
    roles: ["admin"],
    why: "rechaza un vale pendiente.",
  },
  {
    file: "app/api/v1/voucher-settings/route.ts",
    name: "GET",
    kind: "voucher",
    roles: ["admin", "caja", "empleado"],
    cajaDebeEntrar: true,
    why: "topes vigentes del vale.",
  },
  {
    file: "app/api/v1/voucher-settings/route.ts",
    name: "POST",
    kind: "voucher",
    roles: ["admin"],
    why: "configura topes: solo admin.",
  },
];

/** Lista de roles de un literal `["admin", "caja"]` (ya sin comentarios). */
function parseRoleList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => part !== "");
}

/** Constantes `const X: RoleCode[] = [...]` del módulo de guardas. */
function readRoleConstants(source: string): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  const declaration = /^[\t ]*const[\t ]+([A-Za-z0-9_$]+)[\t ]*:[\t ]*RoleCode\[\][\t ]*=[\t ]*\[([^\]]*)\]/gm;

  let match = declaration.exec(source);
  while (match !== null) {
    constants.set(match[1], parseRoleList(match[2]));
    match = declaration.exec(source);
  }

  return constants;
}

/**
 * Guarda -> roles admitidos. Se lee del cuerpo real de cada `export ... function
 * requireX(...)`: el segundo argumento del gate de rol —`requireSedeRole(...)` o
 * el helper del módulo `requirePayrollRoles(...)`—, resolviendo ese argumento
 * contra las constantes del módulo (o un literal inline).
 *
 * Se limpian los comentarios pero NO los literales: los roles son strings.
 */
function readGuardRoles(source: string, file: string): Map<string, string[]> {
  const constants = readRoleConstants(stripComments(source));
  const guards = new Map<string, string[]>();
  const gate = /(?:requireSedeRole|requirePayrollRoles)\(\s*[A-Za-z0-9_$.]*roles\s*,\s*([^)]*?)\s*\)/;

  for (const guard of scanModuleSource(source, file)) {
    const call = gate.exec(stripComments(guard.rawBody));
    if (call === null) continue;

    const argument = call[1].trim();
    const roles = argument.startsWith("[")
      ? parseRoleList(argument.replace(/^\[/, "").replace(/\]$/, ""))
      : constants.get(argument);
    if (roles !== undefined) guards.set(guard.name, roles);
  }

  return guards;
}

/** Superficie exportada -> primera guarda que invoca su cuerpo. */
function readSurfaceGuards(source: string, file: string): Map<string, string> {
  const guards = new Map<string, string>();

  for (const surface of scanModuleSource(source, file)) {
    const call = /\b(require[A-Z]\w*)\s*\(/.exec(surface.body);
    if (call !== null) guards.set(surface.name, call[1]);
  }

  return guards;
}

/**
 * Ofensa derivada de la REGLA (no de la tabla) sobre los roles resueltos: es la
 * que sobrevive a que alguien reordene la tabla de expectativas.
 */
function ruleOffense(spec: SurfaceSpec, roles: string[]): string | null {
  if (spec.kind === "payroll") {
    if (roles.includes("caja")) {
      return (
        `la nómina no admite caja: admite [${roles.join(", ")}]. ` +
        "La caja abre vales, no nómina."
      );
    }
    if (!roles.includes("admin")) {
      return `una superficie de nómina debe admitir admin: admite [${roles.join(", ")}].`;
    }
    return null;
  }

  if (spec.cajaDebeEntrar === true && !roles.includes("caja")) {
    return (
      `es un flujo de caja: debe seguir admitiendo caja, admite [${roles.join(", ")}]. ` +
      "Cerrar los vales a la caja rompe el mostrador."
    );
  }

  return null;
}

/**
 * Ofensas de ROL de las superficies esperadas de UN archivo. Pura respecto del
 * filesystem: los self-tests le pasan fuentes sintéticas.
 */
function surfaceRoleOffenses(args: {
  file: string;
  source: string;
  expected: readonly SurfaceSpec[];
  guardRoles: Map<string, string[]>;
  externalGuards?: Record<string, string[]>;
}): string[] {
  const guards = readSurfaceGuards(args.source, args.file);
  const external = args.externalGuards ?? EXTERNAL_GUARD_ROLES;
  const offenses: string[] = [];

  for (const spec of args.expected) {
    if (spec.file !== args.file) continue;

    const guard = guards.get(spec.name);
    if (guard === undefined) {
      offenses.push(
        `${args.file}: ${spec.name} no se encontró entre las exportaciones: ` +
          "la tabla de roles quedaría sin cubrirlo (¿se renombró o se borró?).",
      );
      continue;
    }

    const roles = args.guardRoles.get(guard) ?? external[guard];
    if (roles === undefined) {
      offenses.push(
        `${args.file}: ${spec.name} usa '${guard}' y no se pudieron leer los roles que admite: ` +
          "declárelos como `const X: RoleCode[] = [...]` y pásalos a `requireSedeRole(session.roles, X)`.",
      );
      continue;
    }

    const rule = ruleOffense(spec, roles);
    if (rule !== null) {
      offenses.push(`${args.file}: ${spec.name} → ${rule} (${spec.why})`);
    } else if (roles.join(",") !== spec.roles.join(",")) {
      offenses.push(
        `${args.file}: ${spec.name} exige roles [${roles.join(", ")}]; la tabla espera ` +
          `[${spec.roles.join(", ")}] (${spec.why}).`,
      );
    }
  }

  return offenses;
}

/** Todos los `route.ts` bajo un directorio, con separadores POSIX. */
function readRouteFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...readRouteFiles(absolute));
    else if (entry.isFile() && entry.name === "route.ts") found.push(toRepoPath(absolute));
  }

  return found.sort();
}

/** ¿La ruta pertenece al módulo de nómina o al de vales? */
function isPayrollOrVoucherRoute(file: string): boolean {
  return file
    .split("/")
    .some((segment) => segment.startsWith("payroll") || segment.startsWith("voucher"));
}

const ROUTE_FILES = readRouteFiles(join(APP_ROOT, "app", "api", "v1"));
const SURFACE_FILE_LIST: readonly string[] = [
  PAYROLL_ACTIONS_FILE,
  PLATFORM_ACTIONS_FILE,
  ...ROUTE_FILES.filter(isPayrollOrVoucherRoute),
];

const PAYROLL_SERVICE_SOURCE = readFileSync(join(APP_ROOT, PAYROLL_SERVICE_FILE), "utf8");
const PLATFORM_SERVICE_SOURCE = readFileSync(join(APP_ROOT, PLATFORM_SERVICE_FILE), "utf8");
/**
 * Guardas de los módulos con tabla de autorización, en un solo mapa: las de
 * nómina (`payroll/service.ts`) y la de plataforma (`platform/service.ts`).
 */
const GUARD_ROLES = new Map([
  ...readGuardRoles(PAYROLL_SERVICE_SOURCE, PAYROLL_SERVICE_FILE),
  ...readGuardRoles(PLATFORM_SERVICE_SOURCE, PLATFORM_SERVICE_FILE),
]);

/**
 * Matriz de guardas probadas por comportamiento (ver el bloque de abajo): qué
 * rol admite cada una y qué rol rechaza. Es también el registro de las guardas
 * que las superficies pueden usar.
 */
const GUARD_MATRIX: ReadonlyArray<{
  guard: string;
  module: "payroll" | "admin" | "platform";
  admite: string[];
  rechaza: string[];
}> = [
  {
    // G3a: la superficie de plataforma solo la abre el rol `superadmin`.
    guard: "requirePlatformAdmin",
    module: "platform",
    admite: ["superadmin"],
    rechaza: ["admin", "caja", "empleado"],
  },
  {
    guard: "requirePayrollAdmin",
    module: "payroll",
    admite: ["admin"],
    rechaza: ["caja", "empleado"],
  },
  {
    guard: "requirePayrollViewer",
    module: "payroll",
    admite: ["admin", "empleado"],
    rechaza: ["caja"],
  },
  {
    guard: "requirePayrollPayer",
    module: "payroll",
    admite: ["admin", "caja"],
    rechaza: ["empleado"],
  },
  {
    // Vales: cualquier rol autenticado de su sede (lista y topes del vale).
    guard: "requireSession",
    module: "admin",
    admite: ["admin", "caja", "empleado"],
    rechaza: [],
  },
];

/** Source de un archivo de superficie, leído del repo real. */
function surfaceSource(file: string): string {
  return readFileSync(join(APP_ROOT, file), "utf8");
}

describe("roles exigidos por cada superficie de nómina, de vales y de plataforma", () => {
  it("la tabla cubre todas las acciones de nómina y de plataforma, y todas las rutas de nómina y vales", () => {
    // La cobertura va por PAREJA (archivo, acción): un mismo nombre en otro
    // módulo no queda sombreado por una fila de nómina (mismo criterio que la
    // allowlist de acciones públicas).
    const actionFiles = [PAYROLL_ACTIONS_FILE, PLATFORM_ACTIONS_FILE];
    const declared = new Set(
      actionFiles.flatMap((file) =>
        scanModuleSource(surfaceSource(file), file).map((surface) => `${file}: ${surface.name}`),
      ),
    );
    const covered = new Set(
      SURFACES.filter((spec) => actionFiles.includes(spec.file)).map(
        (spec) => `${spec.file}: ${spec.name}`,
      ),
    );

    const unlisted = [...declared].filter((name) => !covered.has(name));
    expect(
      unlisted,
      `Acciones sin fila en la tabla de roles (una superficie sin rol declarado es una ` +
        `superficie sin invariante): ${unlisted.join(", ")}`,
    ).toEqual([]);

    const dead = [...covered].filter((name) => !declared.has(name));
    expect(dead, `Filas de la tabla que ya no existen en el fuente: ${dead.join(", ")}`).toEqual([]);

    const routes = ROUTE_FILES.filter(isPayrollOrVoucherRoute);
    const declaredRoutes = new Set(SURFACES.map((spec) => spec.file));
    const unrouted = routes.filter((file) => !declaredRoutes.has(file));
    expect(
      unrouted,
      `Rutas de nómina/vales sin fila en la tabla de roles: ${unrouted.join(", ")}`,
    ).toEqual([]);
  });

  it("los roles de cada guarda se leen del fuente real (constante o literal inline)", () => {
    expect(GUARD_ROLES.get("requirePayrollAdmin")).toEqual(["admin"]);

    const unresolved = SURFACE_FILE_LIST.flatMap((file) =>
      surfaceRoleOffenses({
        file,
        source: surfaceSource(file),
        expected: SURFACES,
        guardRoles: GUARD_ROLES,
      }),
    );

    expect(
      unresolved,
      "Superficies cuyo ROL no coincide con la tabla de autorización:\n" +
        unresolved.join("\n"),
    ).toEqual([]);
  });

  it("la tabla no tiene filas duplicadas ni fuera del módulo", () => {
    const ids = SURFACES.map((spec) => `${spec.file}: ${spec.name}`);
    expect(ids.length, "la tabla de roles quedó vacía").toBeGreaterThan(0);
    expect(new Set(ids).size, `Filas duplicadas en la tabla de roles: ${ids.join(", ")}`).toBe(
      ids.length,
    );
  });

  it("toda guarda usada por una superficie está declarada en la matriz de roles probada", () => {
    const used = new Set<string>();
    for (const file of SURFACE_FILE_LIST) {
      for (const guard of readSurfaceGuards(surfaceSource(file), file).values()) used.add(guard);
    }

    const missing = [...used].filter((guard) => !GUARD_MATRIX.some((row) => row.guard === guard));
    expect(
      missing,
      `Guardas usadas sin fila en GUARD_MATRIX (roles sin probar): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

/* ---- Self-tests del invariante de ROLES (fuentes sintéticas) -------------- */

/** Acciones sintéticas con la ESTRUCTURA del estado previo al arreglo. */
const FIXTURE_ROLE_PRE_FIX = `
import {
  payPayrollItem,
  requirePayrollPayer,
} from "./service";

export async function payPayrollItemAction(id: string, input: unknown) {
  const session = await requirePayrollPayer(await sessionToken());
  return payPayrollItem(session.sedeId, id, input, session);
}
`;

/** El mismo cuerpo, con la guarda correcta (nómina). */
const FIXTURE_ROLE_FIXED = FIXTURE_ROLE_PRE_FIX.replace(
  /requirePayrollPayer/g,
  "requirePayrollAdmin",
);

/**
 * Guardas sintéticas: una constante, un literal inline y roles solo en texto.
 * Se cubren las DOS formas de gate: `requireSedeRole(...)` directo y el helper
 * del módulo (`requirePayrollRoles`), que es como lo hacen las guardas reales.
 */
const FIXTURE_GUARD_SOURCE = `
const ADMIN_ROLES: RoleCode[] = ["admin"];
const PAYER_ROLES: RoleCode[] = ["admin", "caja"];

/** Los roles del vale (admin y caja) se documentan acá; no se leen de acá. */
export async function requirePayrollAdmin(token: string | null) {
  const session = await payrollSession(token);
  requirePayrollRoles(session.roles, ADMIN_ROLES);
  return session;
}

export async function requirePayrollPayer(token: string | null) {
  const session = await payrollSession(token);
  requirePayrollRoles(session.roles, PAYER_ROLES);
  return session;
}

export async function requireOnlyEmpleado(
  // roles permitidos: ["empleado"] en un comentario, que no cuenta
  token: string | null,
) {
  const session = await getSessionUser(token);
  requireSedeRole(session.roles, ["empleado"]);
  return session;
}
`;

const FIXTURE_SURFACE_SPEC: SurfaceSpec = {
  file: "synthetic/actions.ts",
  name: "payPayrollItemAction",
  kind: "payroll",
  roles: ["admin"],
  why: "pagar nómina es del admin.",
};

describe("self-tests del invariante de ROLES (fuentes sintéticas)", () => {
  it("control negativo: la guarda de vales en una superficie de nómina se reporta por ROL", () => {
    const offenses = surfaceRoleOffenses({
      file: "synthetic/actions.ts",
      source: FIXTURE_ROLE_PRE_FIX,
      expected: [FIXTURE_SURFACE_SPEC],
      guardRoles: new Map([["requirePayrollPayer", ["admin", "caja"]]]),
    });

    expect(offenses).toHaveLength(1);
    expect(offenses[0]).toContain("payPayrollItemAction");
    expect(offenses[0]).toContain("la nómina no admite caja");
    expect(offenses[0]).toContain("[admin, caja]");
    // El mismo cuerpo con la guarda correcta pasa limpio: la ofensa es de ROL,
    // no de presencia (la guarda siempre estuvo ahí).
    expect(
      surfaceRoleOffenses({
        file: "synthetic/actions.ts",
        source: FIXTURE_ROLE_FIXED,
        expected: [FIXTURE_SURFACE_SPEC],
        guardRoles: new Map([["requirePayrollAdmin", ["admin"]]]),
      }),
    ).toEqual([]);
  });

  it("control negativo: admitir admin pero perder al empleado también se reporta", () => {
    const offenses = surfaceRoleOffenses({
      file: "synthetic/actions.ts",
      source: FIXTURE_ROLE_FIXED,
      expected: [{ ...FIXTURE_SURFACE_SPEC, roles: ["admin", "empleado"] }],
      guardRoles: new Map([["requirePayrollAdmin", ["admin"]]]),
    });

    expect(offenses).toHaveLength(1);
    expect(offenses[0]).toContain("exige roles [admin]; la tabla espera [admin, empleado]");
  });

  it("control negativo: una guarda desconocida no deja la superficie en el aire", () => {
    const offenses = surfaceRoleOffenses({
      file: "synthetic/actions.ts",
      source: FIXTURE_ROLE_PRE_FIX,
      expected: [FIXTURE_SURFACE_SPEC],
      guardRoles: new Map(),
    });

    expect(offenses).toHaveLength(1);
    expect(offenses[0]).toContain("requirePayrollPayer");
    expect(offenses[0]).toContain("no se pudieron leer los roles");
  });

  it("los roles se leen de la constante, del literal inline y no del comentario", () => {
    const guards = readGuardRoles(FIXTURE_GUARD_SOURCE, "synthetic/service.ts");

    expect(guards.get("requirePayrollAdmin")).toEqual(["admin"]);
    expect(guards.get("requirePayrollPayer")).toEqual(["admin", "caja"]);
    expect(guards.get("requireOnlyEmpleado")).toEqual(["empleado"]);
    // 3 guardas, 3 entradas: el comentario ("roles permitidos") no aporta ninguna.
    expect([...guards.keys()]).toHaveLength(3);
  });

  it("control de cobertura: una superficie fuera de la tabla se reporta", () => {
    const offenses = surfaceRoleOffenses({
      file: "synthetic/actions.ts",
      source: FIXTURE_ROLE_PRE_FIX,
      expected: [{ ...FIXTURE_SURFACE_SPEC, name: "otraAccionDeNomina" }],
      guardRoles: new Map([["requirePayrollPayer", ["admin", "caja"]]]),
    });

    expect(offenses).toHaveLength(1);
    expect(offenses[0]).toContain("no se encontró entre las exportaciones");
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

/* --------------------------------------------------------------------------
   Comportamiento: la caja no entra a la nómina y sí entra a los vales.

   El bloque de arriba es estático (lee el fuente). Este ejecuta la guarda real
   con una sesión simulada: es la prueba de que el ROL que el fuente declara es
   el que la guarda aplica. La sesión se mockea (`getSessionUser`) y el cliente
   de datos se reemplaza por un doble mínimo; nada toca Supabase.
   -------------------------------------------------------------------------- */

const SEDE_PRUEBA = "11111111-1111-4111-8111-111111111111";
const PERIOD_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
/** PA-2a: la planta de la prueba necesita un id con forma de uuid. */
const EMPLEADO_ID = "44444444-4444-4444-8444-444444444444";

const sessionStub = vi.hoisted(() => ({ current: null as null | SessionUser }));

const dbStub = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, unknown>>> }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "token-de-prueba" }) }),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => {},
}));

vi.mock("@/src/features/auth/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/auth/service")>();
  return { ...actual, getSessionUser: async () => sessionStub.current };
});

/**
 * Doble mínimo de PostgREST: las consultas encadenan y resuelven las filas
 * sembradas por tabla. Alcanza para las lecturas que estas pruebas ejercitan.
 * La mayoría de las escrituras no se ejercitan (la guarda rechaza antes de
 * llegar ahí); `insert` existe sólo para el control positivo del pago
 * extraordinario (PA-2a), que sí necesita que la escritura devuelva una fila.
 */
vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => {
    const from = (table: string) => {
      const rows = dbStub.rows[table] ?? [];
      const result = { data: rows, error: null };
      /**
       * CL-5: las consultas de este doble ignoran sus filtros y devuelven la
       * primera fila sembrada. Alcanza para las guardas, pero la lectura por
       * MARCA (el lookup del servicio, `eq("idempotency_key", …)`) tiene que
       * responder que NO hay nada: si devolviera la fila sembrada, la prueba de
       * abajo dejaría de ejercitar la ESCRITURA del pago extraordinario y se
       * volvería, sin decirlo, una prueba del camino de repetición.
       */
      let filteredByMark = false;
      const query: Record<string, unknown> = {
        select: () => query,
        insert: (payload?: unknown) => {
          const values = (Array.isArray(payload) ? payload : [payload]) as Array<
            Record<string, unknown>
          >;
          const persisted = values.map((row, index) => ({
            id: `fila-insertada-${index + 1}`,
            created_at: "2026-01-31T23:59:59.000Z",
            ...row,
          }));
          dbStub.rows[table] = [...rows, ...persisted];
          return query;
        },
        eq: (column: string) => {
          if (column === "idempotency_key") filteredByMark = true;
          return query;
        },
        neq: () => query,
        in: () => query,
        is: () => query,
        match: () => query,
        order: () => query,
        range: () => query,
        limit: () => query,
        maybeSingle: () =>
          Promise.resolve({ data: filteredByMark ? null : (rows[0] ?? null), error: null }),
        single: () =>
          Promise.resolve({ data: filteredByMark ? null : (rows[0] ?? null), error: null }),
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return query;
    };

    return { from };
  },
}));

/** Sesión simulada: el rol es lo único que las guardas miran. */
function asSession(roles: string[]): void {
  sessionStub.current = {
    user: { id: "u-prueba", sede_id: SEDE_PRUEBA },
    roles,
  } as unknown as SessionUser;
}

/** Request mínima: las rutas solo leen la cookie de sesión y el cuerpo. */
function fakeRequest(): NextRequest {
  return {
    cookies: {
      get: (name: string) =>
        name === SESSION_COOKIE_NAME ? { value: "token-de-prueba" } : undefined,
    },
    nextUrl: { searchParams: new URLSearchParams() },
    json: async () => ({}),
  } as unknown as NextRequest;
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const PERIODO_PRUEBA = {
  id: PERIOD_ID,
  sede_id: SEDE_PRUEBA,
  start_date: "2026-01-01",
  end_date: "2026-01-31",
  status: "borrador",
  created_by: "u-prueba",
  closed_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const ITEM_PRUEBA = {
  id: ITEM_ID,
  period_id: PERIOD_ID,
  employee_id: "emp-1",
  base_fixed: 0,
  commissions: 100000,
  bonuses: 0,
  deductions_vales: 0,
  other_discounts: 0,
  net_pay: 100000,
  detail_json: [],
  created_at: "2026-01-15T10:00:00.000Z",
};

const METODO_PRUEBA = {
  id: "pm-1",
  sede_id: SEDE_PRUEBA,
  code: "efectivo",
  name: "Efectivo",
  is_active: true,
  kind: "efectivo",
};

/** Cada ruta de nómina, con su llamada: es la superficie HTTP completa. */
const PAYROLL_ROUTE_CALLS: ReadonlyArray<{ label: string; call: () => Promise<Response> }> = [
  { label: "GET /api/v1/payroll-periods", call: () => getPayrollPeriods(fakeRequest()) },
  { label: "POST /api/v1/payroll-periods", call: () => postPayrollPeriod(fakeRequest()) },
  {
    label: "GET /api/v1/payroll-periods/:id",
    call: () => getPayrollPeriod(fakeRequest(), routeParams(PERIOD_ID)),
  },
  {
    label: "DELETE /api/v1/payroll-periods/:id",
    call: () => deletePayrollPeriod(fakeRequest(), routeParams(PERIOD_ID)),
  },
  {
    label: "POST /api/v1/payroll-periods/:id/calculate",
    call: () => calculatePayrollPeriod(fakeRequest(), routeParams(PERIOD_ID)),
  },
  {
    label: "POST /api/v1/payroll-periods/:id/close",
    call: () => closePayrollPeriod(fakeRequest(), routeParams(PERIOD_ID)),
  },
  {
    label: "POST /api/v1/payroll-items/:id/payments",
    call: () => postPayrollPayments(fakeRequest(), routeParams(ITEM_ID)),
  },
];

/** Deja el doble con la nómina de una sede (sin tocar Supabase). */
function seedNomina(): void {
  dbStub.rows.payroll_periods = [PERIODO_PRUEBA];
  dbStub.rows.payroll_items = [ITEM_PRUEBA];
  dbStub.rows.payment_methods = [METODO_PRUEBA];
}

describe("nómina solo admin (y el propio empleado): la caja no entra; los vales sí", () => {
  beforeEach(() => {
    dbStub.rows = {};
    sessionStub.current = null;
  });

  it("la caja NO lee la lista de periodos (listPeriodsAction)", async () => {
    seedNomina();
    asSession(["caja"]);

    const result = await listPeriodsAction();

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("la caja NO lee el detalle del periodo (getPeriodDetailAction)", async () => {
    seedNomina();
    asSession(["caja"]);

    const result = await getPeriodDetailAction(PERIOD_ID);

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("la caja NO paga un ítem de nómina (payPayrollItemAction)", async () => {
    seedNomina();
    asSession(["caja"]);

    const result = await payPayrollItemAction(ITEM_ID, {
      portions: [{ method_code: "efectivo", amount: 1000 }],
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("la caja NO registra un pago extraordinario (payPayrollExtraAction)", async () => {
    seedNomina();
    asSession(["caja"]);

    const result = await payPayrollExtraAction({
      employee_id: EMPLEADO_ID,
      amount: 500000,
      method_code: "efectivo",
      reason: "Renuncia",
      kind: "renuncia",
    });

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("la caja NO lista los pagos extraordinarios (listPayrollExtrasAction)", async () => {
    seedNomina();
    asSession(["caja"]);

    const result = await listPayrollExtrasAction();

    expect(result).toMatchObject({ success: false, code: "FORBIDDEN" });
  });

  it("control positivo: el admin registra y lista un pago extraordinario", async () => {
    seedNomina();
    const extra = {
      id: "extra-1",
      sede_id: SEDE_PRUEBA,
      employee_id: EMPLEADO_ID,
      amount: 500000,
      method_id: METODO_PRUEBA.id,
      method_code: "efectivo",
      reference: null,
      reason: "Renuncia",
      kind: "renuncia",
      days_from: null,
      days_to: null,
      paid_by: "u-prueba",
      paid_at: "2026-01-20T10:00:00.000Z",
      created_at: "2026-01-20T10:00:00.000Z",
    };
    dbStub.rows.payroll_extras = [extra];
    dbStub.rows.employees = [
      { id: EMPLEADO_ID, sede_id: SEDE_PRUEBA, user_id: null, full_name: "Empleada" },
    ];
    asSession(["admin"]);

    const registered = await payPayrollExtraAction({
      // CL-5: la marca del intento es obligatoria (044). Acá el valor es
      // cualquiera con forma de uuid: la prueba verifica la GUARDA y la
      // escritura, no la idempotencia, que tiene sus propias pruebas.
      idempotency_key: "8c1e5a37-2d64-4f09-b7a3-6e0c9b4d1f25",
      employee_id: EMPLEADO_ID,
      amount: 500000,
      method_code: "efectivo",
      reason: "Renuncia",
      kind: "renuncia",
    });
    expect(registered, JSON.stringify(registered)).toMatchObject({ success: true });

    const listed = await listPayrollExtrasAction();
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data.map((row) => row.id)).toContain("extra-1");
  });

  it("toda ruta de nómina rechaza a la caja con 403 FORBIDDEN", async () => {
    for (const route of PAYROLL_ROUTE_CALLS) {
      seedNomina();
      asSession(["caja"]);

      const response = await route.call();

      expect(response.status, `${route.label}: la caja no puede entrar a nómina`).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code: "FORBIDDEN",
      });
    }
  });

  it("control positivo: el admin sí lee los periodos (action y ruta)", async () => {
    seedNomina();
    asSession(["admin"]);

    const action = await listPeriodsAction();
    expect(action.success).toBe(true);
    if (!action.success) return;
    expect(action.data.map((row) => row.id)).toEqual([PERIOD_ID]);

    const response = await getPayrollPeriods(fakeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [{ id: PERIOD_ID }],
    });
  });

  it("control de sobreajuste: el empleado sigue viendo SU nómina", async () => {
    seedNomina();
    dbStub.rows.employees = [
      { id: "emp-1", sede_id: SEDE_PRUEBA, user_id: "u-prueba", full_name: "Empleada" },
    ];
    asSession(["empleado"]);

    const periods = await listPeriodsAction();
    expect(periods.success).toBe(true);

    const detail = await getPeriodDetailAction(PERIOD_ID);
    expect(detail.success).toBe(true);
    if (!detail.success) return;
    // Solo lo suyo: el alcance por fila sigue aplicándose para el empleado.
    expect(detail.data.items.map((row) => row.id)).toEqual([ITEM_ID]);
  });

  it("control anti-sobreguardia: la caja SÍ entra a vales", async () => {
    dbStub.rows.voucher_requests = [];
    asSession(["caja"]);

    const vouchers = await requestVoucherAction({});
    expect(
      vouchers.success === false && vouchers.code === "FORBIDDEN",
      "la caja abre vales con turno abierto: no puede quedar fuera de vales",
    ).toBe(false);

    const settings = await getVoucherSettingsAction();
    expect(settings.success).toBe(true);

    const response = await postVoucher(fakeRequest());
    expect(
      response.status,
      "POST /api/v1/vouchers: la caja no puede quedar rechazada por autorización",
    ).not.toBe(403);
  });

  describe("matriz de guardas", () => {
    const modules: Record<string, Record<string, unknown>> = {
      payroll: payrollService as unknown as Record<string, unknown>,
      admin: adminService as unknown as Record<string, unknown>,
      platform: platformService as unknown as Record<string, unknown>,
    };

    function guardOf(row: (typeof GUARD_MATRIX)[number]): (token: string) => Promise<unknown> {
      const fn = modules[row.module][row.guard];
      expect(typeof fn, `${row.guard} no existe en el módulo ${row.module}`).toBe("function");
      return fn as (token: string) => Promise<unknown>;
    }

    function outcomeOf(guard: (token: string) => Promise<unknown>): Promise<unknown> {
      return guard("token-de-prueba").then(
        () => null,
        (error: unknown) => error,
      );
    }

    it("sin sesión, toda guarda responde UNAUTHENTICATED (401)", async () => {
      for (const row of GUARD_MATRIX) {
        sessionStub.current = null;
        const outcome = await outcomeOf(guardOf(row));
        expect(outcome, `${row.guard} sin sesión`).toMatchObject({
          code: "UNAUTHENTICATED",
          status: 401,
        });
      }
    });

    it("cada guarda admite los roles que declara y rechaza los demás con FORBIDDEN (403)", async () => {
      for (const row of GUARD_MATRIX) {
        for (const role of row.admite) {
          asSession([role]);
          const outcome = await outcomeOf(guardOf(row));
          expect(outcome, `${row.guard} debería admitir ${role}`).toBeNull();
        }

        for (const role of row.rechaza) {
          asSession([role]);
          const outcome = await outcomeOf(guardOf(row));
          expect(outcome, `${row.guard} debería rechazar ${role}`).toMatchObject({
            code: "FORBIDDEN",
            status: 403,
          });
        }
      }
    });

    it("los roles declarados en el fuente son los que la guarda aplica", () => {
      for (const row of GUARD_MATRIX) {
        const declared =
          GUARD_ROLES.get(row.guard) ?? EXTERNAL_GUARD_ROLES[row.guard];
        expect(declared, `${row.guard}: roles no legibles en el fuente`).toEqual(row.admite);
      }
    });
  });
});

/* --------------------------------------------------------------------------
   G1: la guarda de PLATAFORMA.

   `requirePlatformAdmin` es la única puerta a `/plataforma`. Su rol se lee del
   fuente con la misma maquinaria que las guardas de nómina (`const X:
   RoleCode[] = [...]` + `requireSedeRole(session.roles, X)`), y se ejecuta con
   la sesión simulada para fijar el comportamiento.

   El camino REAL de la sesión (que `getSessionUser` no descarte `superadmin`)
   se prueba en tests/auth.test.ts, sin mockear `getSessionUser`: acá la sesión
   es el doble que aísla a la guarda del resto del mundo.
   -------------------------------------------------------------------------- */

describe("plataforma: requirePlatformAdmin (G1)", () => {
  it("los roles declarados en el fuente son los que la guarda aplica", () => {
    const guards = readGuardRoles(surfaceSource(PLATFORM_SERVICE_FILE), PLATFORM_SERVICE_FILE);
    expect(guards.get("requirePlatformAdmin")).toEqual(["superadmin"]);
  });

  it("sin sesión: UNAUTHENTICATED (401)", async () => {
    sessionStub.current = null;
    await expect(requirePlatformAdmin("token-de-prueba")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("admite `superadmin` y rechaza los demás roles con FORBIDDEN (403)", async () => {
    asSession(["superadmin"]);
    await expect(requirePlatformAdmin("token-de-prueba")).resolves.toMatchObject({
      userId: "u-prueba",
      sedeId: SEDE_PRUEBA,
      roles: ["superadmin"],
    });

    for (const rol of ["admin", "caja", "empleado"]) {
      asSession([rol]);
      await expect(requirePlatformAdmin("token-de-prueba")).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
    }
  });
});
