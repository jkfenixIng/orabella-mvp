/**
 * Architecture guard for the direct database layer (src/shared/db).
 *
 * The connection (src/shared/db/client.ts) is server only and holds
 * DATABASE_URL. Same house style as the other source tests: read the real
 * files, no network.
 *
 *   1. Nothing under app/ imports src/shared/db: pages and routes go through a
 *      feature service.
 *   2. No "use client" module (app/ or src/) reaches it, through static VALUE
 *      imports or through import(): the bundler puts a dynamically imported
 *      module in a client chunk too. `import type` is erased and does not count.
 *   3. The connection is loaded only with import(), and the default engine's
 *      static graph does not contain drizzle-orm or postgres-js.
 *
 * The detector runs over a source reader, so the negative controls feed it
 * in-memory modules that MUST be flagged.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DB_DIR = "src/shared/db/";
const CLIENT = "src/shared/db/client.ts";

/** Repo files by repo-relative path; `virtual` overlays the disk. */
interface Sources {
  read(path: string): string;
  exists(path: string): boolean;
}

function sources(virtual: Record<string, string> = {}): Sources {
  return {
    read: (path) => virtual[path] ?? readFileSync(join(ROOT, path), "utf8"),
    exists: (path) => path in virtual || existsSync(join(ROOT, path)),
  };
}

const DISK = sources();

function toRepoPath(absolute: string): string {
  return relative(ROOT, absolute).split("\\").join("/");
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.tsx?$/.test(entry.name)) found.push(toRepoPath(absolute));
    }
  };
  if (existsSync(join(ROOT, root))) walk(join(ROOT, root));
  return found.sort();
}

/**
 * The directive prologue: string statements at the top of the module, after
 * any whitespace, line comments and block comments.
 */
function directives(code: string): string[] {
  const found: string[] = [];
  let rest = code.replace(/^\uFEFF/, "");
  for (;;) {
    const trivia = rest.match(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/);
    if (trivia) rest = rest.slice(trivia[0].length);
    const directive = rest.match(/^(["'])([^"'\n]*)\1\s*;?/);
    if (!directive) return found;
    found.push(directive[2]);
    rest = rest.slice(directive[0].length);
  }
}

const hasDirective = (src: Sources, path: string, name: string) => directives(src.read(path)).includes(name);

/** Static value imports and re-exports (type-only ones are skipped). */
function staticImports(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']/gm)) {
    if (!match[2]) specifiers.push(match[3]);
  }
  for (const match of code.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

/** `import("...")` with a literal specifier. */
function dynamicImports(code: string): string[] {
  return [...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
}

/** Resolves an import to a repo file, or null for packages. */
function resolveImport(src: Sources, from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = toRepoPath(resolve(ROOT, dirname(from), specifier));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && src.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Every repo file reachable from `start`. A "use server" module is a boundary:
 * a client gets action references, not its code, so the walk does not enter it.
 */
function graph(src: Sources, start: string, options: { dynamic: boolean }): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file !== start && hasDirective(src, file, "use server")) continue;
    const code = src.read(file);
    const specifiers = [...staticImports(code), ...(options.dynamic ? dynamicImports(code) : [])];
    for (const specifier of specifiers) {
      const target = resolveImport(src, file, specifier);
      if (target) queue.push(target);
    }
  }
  return seen;
}

/** "client -> db file" for every client module that can pull src/shared/db into a bundle. */
function clientDbViolations(src: Sources, files: string[]): string[] {
  return files
    .filter((file) => hasDirective(src, file, "use client"))
    .flatMap((file) =>
      [...graph(src, file, { dynamic: true })]
        .filter((reached) => reached.startsWith(DB_DIR))
        .map((reached) => `${file} -> ${reached}`),
    );
}

const APP_FILES = sourceFiles("app");
const ALL_FILES = [...APP_FILES, ...sourceFiles("src")];
const CLIENT_FILES = ALL_FILES.filter((file) => hasDirective(DISK, file, "use client"));
const mentionsDb = (path: string) => /["']@\/src\/shared\/db(?:\/[^"']*)?["']/.test(DISK.read(path));

describe("src/shared/db is server only", () => {
  it("finds the files it audits", () => {
    expect(APP_FILES.length).toBeGreaterThan(20);
    expect(CLIENT_FILES).toContain("app/services/services-client.tsx");
    expect(CLIENT_FILES).toContain("src/components/ui/lib/button.tsx");
    expect(existsSync(join(ROOT, CLIENT))).toBe(true);
  });

  it("no file under app/ imports src/shared/db", () => {
    expect(APP_FILES.filter(mentionsDb)).toEqual([]);
  });

  it("no 'use client' module in app/ or src/ reaches src/shared/db, statically or with import()", () => {
    expect(clientDbViolations(DISK, ALL_FILES)).toEqual([]);
  });

  it("the connection module is never imported statically, only with import()", () => {
    const statics = ALL_FILES.filter((file) =>
      staticImports(DISK.read(file)).some((specifier) => resolveImport(DISK, file, specifier) === CLIENT),
    );
    expect(statics).toEqual([]);
    expect(DISK.read("src/features/admin/repos/services.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/features/admin/repos/catalogs.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/features/alerts/repos/alerts.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/features/inventory/repos/inventory.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/features/auth/repos/auth.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/shared/lib/repos/audit.ts")).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
    expect(DISK.read("src/shared/lib/audit.ts")).not.toMatch(/supabase\/server/);
  });

  it("the default engine's static graphs load neither drizzle-orm nor postgres-js", () => {
    const reached = [
      ...graph(DISK, "src/features/admin/service.ts", { dynamic: false }),
      ...graph(DISK, "src/features/alerts/service.ts", { dynamic: false }),
      ...graph(DISK, "src/features/inventory/service.ts", { dynamic: false }),
      ...graph(DISK, "src/features/auth/service.ts", { dynamic: false }),
      ...graph(DISK, "src/shared/lib/repos/audit.ts", { dynamic: false }),
    ];
    const driverImporters = [...new Set(reached)].filter((file) =>
      staticImports(DISK.read(file)).some((specifier) => /^(drizzle-orm|postgres)(\/|$)/.test(specifier)),
    );
    expect(reached).toContain("src/features/admin/repos/services.ts");
    expect(reached).toContain("src/features/admin/repos/catalogs.ts");
    expect(reached).toContain("src/features/alerts/repos/alerts.ts");
    expect(reached).toContain("src/features/inventory/repos/inventory.ts");
    expect(reached).toContain("src/features/auth/repos/auth.ts");
    expect(driverImporters).toEqual([]);
  });

  it("every Drizzle adapter is reached only through import() from its port", () => {
    const adapters = ALL_FILES.filter((file) => file.endsWith(".drizzle.ts"));
    expect(adapters).toEqual(
      expect.arrayContaining([
        "src/features/inventory/repos/inventory.drizzle.ts",
        "src/features/auth/repos/auth.drizzle.ts",
        "src/shared/lib/repos/audit.drizzle.ts",
      ]),
    );
    const statics = ALL_FILES.filter((file) =>
      staticImports(DISK.read(file)).some((specifier) => adapters.includes(resolveImport(DISK, file, specifier) ?? "")),
    );
    expect(statics).toEqual([]);
  });
});

describe("the detector itself (negative controls)", () => {
  const BUTTON = "src/components/ui/lib/fake-db-button.tsx";
  const run = (virtual: Record<string, string>) =>
    clientDbViolations(sources(virtual), Object.keys(virtual));

  it.each([
    ["a static import", `"use client";\nimport { getDb } from "@/src/shared/db/client";\n`],
    ["a static import of another db module", `'use client'\nimport { toDbError } from "@/src/shared/db/errors";\n`],
    ["a dynamic import()", `"use client";\nexport async function f() {\n  const m = await import("@/src/shared/db/client");\n  return m;\n}\n`],
    ["a block comment before the directive", `/*\n * Licence header.\n */\n"use client";\nimport { getDb } from "@/src/shared/db/client";\n`],
    ["mixed comments before the directive", `// a\n/* b */ /* c */\n'use client';\nconst m = () => import('@/src/shared/db/client');\n`],
  ])("flags %s in a src/ client module", (_label, code) => {
    const target = `src/shared/db/${code.includes("errors") ? "errors" : "client"}.ts`;
    // The walk continues into the reached module (client.ts -> schema/...).
    expect(run({ [BUTTON]: code })).toContain(`${BUTTON} -> ${target}`);
  });

  it("flags a client module that reaches src/shared/db through a plain helper", () => {
    expect(
      run({
        "app/fake/view.tsx": `"use client";\nimport { helper } from "./helper";\n`,
        "app/fake/helper.ts": `export const helper = () => import("@/src/shared/db/client");\n`,
      }),
    ).toContain("app/fake/view.tsx -> src/shared/db/client.ts");
  });

  it("does not flag type-only imports, server modules or a 'use server' boundary", () => {
    expect(
      run({
        [BUTTON]: `"use client";\nimport type { Database } from "@/src/shared/db/client";\nimport { act } from "@/app/fake/actions";\n`,
        "app/fake/actions.ts": `"use server";\nimport { getDb } from "@/src/shared/db/client";\nexport const act = async () => getDb();\n`,
        "app/fake/server.ts": `import { getDb } from "@/src/shared/db/client";\n`,
      }),
    ).toEqual([]);
  });

  it("a directive after code does not count", () => {
    expect(directives(`import x from "y";\n"use client";\n`)).toEqual([]);
    expect(directives(`/* a */\n"use strict";\n'use client'\n`)).toEqual(["use strict", "use client"]);
  });

  it("the real server route does reach the connection through import()", () => {
    expect(graph(DISK, "app/api/v1/services/route.ts", { dynamic: true })).toContain(CLIENT);
    expect(graph(DISK, "app/api/v1/services/route.ts", { dynamic: false })).not.toContain(CLIENT);
  });
});
