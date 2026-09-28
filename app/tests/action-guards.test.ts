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

   Manejo de `async` en el split: el separador es /^export (?:async )?function /m,
   así que el token `async` lo consume el propio split y cada trozo arranca
   directamente en el NOMBRE de la función. Por eso el regex de nombre
   (/^([A-Za-z0-9_]+)\s*\(/) no necesita contemplar `async`: no queda en el
   trozo. Es también la razón de que la posición de la función en el archivo no
   importe.

   Si un archivo no se puede leer o la enumeración queda vacía, el test FALLA
   (no se saltea): una glob rota debe romper ruidosamente, no pasar en el aire.
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

/**
 * Allowlist de acciones legítimamente públicas. Solo pueden estar aquí las que
 * NO pueden exigir sesión previa; cualquier otra exportación es un agujero.
 */
const PUBLIC_ACTIONS: Record<string, { file: string; why: string }> = {
  loginAction: {
    file: "src/features/auth/actions.ts",
    why: "pública por diseño: es la que CREA la sesión (no hay sesión todavía).",
  },
  logoutAction: {
    file: "src/features/auth/actions.ts",
    why: "pública por diseño: destruye la sesión y es inofensiva sin ella.",
  },
  requestResetAction: {
    file: "src/features/auth/actions.ts",
    why: "pública por diseño: recuperación de clave para quien no puede entrar.",
  },
  confirmResetAction: {
    file: "src/features/auth/actions.ts",
    why: "pública por diseño: segundo paso de la recuperación, sin sesión.",
  },
};

/** Regex que reconoce una guarda de autorización dentro del cuerpo. */
const GUARD_RE = /\brequire[A-Z]\w*\s*\(|\bgetSessionUser\s*\(/;

interface ScannedAction {
  /** Ruta relativa al root de la app, con separadores POSIX. */
  file: string;
  name: string;
  body: string;
}

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

/** Divide un módulo en trozos por función exportada (el prelude se descarta). */
function scanModule(absolutePath: string): ScannedAction[] {
  const source = readFileSync(absolutePath, "utf8");
  const file = toRepoPath(absolutePath);
  const chunks = source.split(/^export (?:async )?function /m).slice(1);

  return chunks.map((body) => {
    const name = body.match(/^([A-Za-z0-9_]+)\s*\(/)?.[1] ?? "";
    return { file, name, body };
  });
}

const ACTION_FILES = readActionFiles();
const SCANNED: ScannedAction[] = ACTION_FILES.flatMap(scanModule);

describe("guardas de autorización en server actions", () => {
  it("enumera los módulos de actions y no arranca vacío", () => {
    expect(ACTION_FILES.length).toBeGreaterThan(0);
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
    const offenses = SCANNED.filter(
      (action) => PUBLIC_ACTIONS[action.name] === undefined && !GUARD_RE.test(action.body),
    ).map((action) => `${action.file}: ${action.name}`);

    expect(
      offenses,
      `Acciones exportadas sin guarda de autorización (archivo: función): ${offenses.join(", ")}`,
    ).toEqual([]);
  });

  it("la allowlist no tiene entradas muertas", () => {
    const scannedNames = new Set(SCANNED.map((action) => action.name));
    const dead = Object.keys(PUBLIC_ACTIONS).filter((name) => !scannedNames.has(name));

    expect(
      dead,
      `Entradas muertas en PUBLIC_ACTIONS (ya no se escanean): ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("las acciones públicas permitidas viven en el módulo auth", () => {
    for (const [name, entry] of Object.entries(PUBLIC_ACTIONS)) {
      const found = SCANNED.find((action) => action.name === name);
      expect(found, `${name}: allowlistada pero no enumerada`).toBeDefined();
      expect(found?.file, `${name} (${entry.why}) debe vivir en ${entry.file}`).toBe(entry.file);
    }
  });
});
