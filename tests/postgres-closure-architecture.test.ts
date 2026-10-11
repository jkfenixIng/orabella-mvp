import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ALLOWED = new Map([
  ["src/features/admin/repos/catalogs.ts", "admin catalog repository adapter"],
  ["src/features/admin/repos/services.ts", "admin service repository adapter"],
  ["src/features/admin/repos/users.ts", "admin user repository adapter"],
  ["src/features/alerts/repos/alerts.ts", "alerts repository adapter"],
  ["src/features/auth/repos/auth.ts", "auth repository adapter"],
  ["src/features/billing/repos/billing.ts", "billing repository adapter"],
  ["src/features/cash/repos/cash.ts", "cash repository adapter"],
  ["src/features/commissions/repos/commissions.ts", "commissions repository adapter"],
  ["src/features/inventory/repos/inventory.ts", "inventory repository adapter"],
  ["src/features/payroll/repos/payroll.ts", "payroll repository adapter"],
  ["src/shared/lib/repos/audit.ts", "shared audit repository adapter"],
  ["src/shared/lib/supabase/client.ts", "shared browser client factory"],
  ["src/shared/lib/supabase/server.ts", "shared server client factory"],
]);
const EXCLUDED = new Map([
  ["next-env.d.ts", "generated Next environment declaration"],
  ["playwright.config.ts", "Playwright test configuration"],
  ["vitest.config.ts", "Vitest test configuration"],
  ["vitest.db.config.ts", "Vitest database test configuration"],
  ["vitest.postgres-closure.config.ts", "Vitest PostgreSQL closure configuration"],
  ["eslint.config.mjs", "lint-only configuration"],
  ["scripts/", "offline maintenance scripts"],
  ["tests/", "test sources"],
]);
const IGNORED_DIRECTORIES = new Map([
  [".git", "Git metadata"],
  [".next", "generated Next output"],
  ["node_modules", "third-party dependencies"],
  ["coverage", "test coverage output"],
  ["build", "build output"],
  ["dist", "distribution output"],
  ["out", "static export output"],
  ["test-results", "Playwright test output"],
  ["playwright-report", "Playwright report output"],
]);
const SUPABASE = "@supabase/";
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Root-level files that ship or configure the production build; anything else at the root must be classified. */
const ROOT_PRODUCTION = new Set(["middleware.ts", "next.config.ts", "postcss.config.mjs"]);
const SOURCE_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function repoPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function exclusionFor(path: string): string | null {
  if (TEST_FILE.test(path)) return "*.test.*";
  return [...EXCLUDED.keys()].find((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)) ?? null;
}

function isExcluded(path: string): boolean {
  return exclusionFor(path) !== null;
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function compiledByTsconfig(root: string): string[] {
  const config = join(root, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) return [];
  if (parsed.errors.length > 0) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
  return parsed.fileNames.map((path) => repoPath(root, path));
}

/** Every source-extension file under `root`, skipping only VCS, dependency and build output directories. */
function allSourceFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return IGNORED_DIRECTORIES.has(entry.name) ? [] : allSourceFiles(root, path);
    const relativePath = repoPath(root, path);
    return isSourceFile(relativePath) ? [relativePath] : [];
  });
}

/** Union of what tsconfig compiles and what Next may compile (any source extension), minus reasoned exclusions. */
function productionSources(root = ROOT): Record<string, string> {
  const files = new Set([...compiledByTsconfig(root), ...allSourceFiles(root)]);
  return Object.fromEntries(
    [...files]
      .filter((path) => !isExcluded(path))
      .map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
}

/** The repository scan is filesystem-bound; compute it once per run. */
let repoScan: { candidates: string[]; sources: Record<string, string> } | undefined;
function scanRepo(): { candidates: string[]; sources: Record<string, string> } {
  repoScan ??= {
    candidates: [...new Set([...compiledByTsconfig(ROOT), ...allSourceFiles(ROOT)])],
    sources: productionSources(ROOT),
  };
  return repoScan;
}
const SCAN_TIMEOUT = 60_000;

function moduleSpecifier(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return moduleSpecifier(expression.expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = moduleSpecifier(expression.left);
    const right = moduleSpecifier(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function dynamicLoadViolation(path: string, expression: ts.Expression): string | null {
  const specifier = moduleSpecifier(expression);
  if (specifier === null) return `${path}: nonliteral dynamic module load is prohibited outside allowed boundaries`;
  if (specifier.startsWith(SUPABASE)) return `${path}: Supabase dynamic module load`;
  return null;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sourceViolations(path: string, code: string): string[] {
  if (ALLOWED.has(path)) return [];
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, scriptKind(path));
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(SUPABASE)) violations.push(`${path}: Supabase module import`);
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) && argument.literal.text.startsWith(SUPABASE)) violations.push(`${path}: Supabase import type`);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
      const violation = dynamicLoadViolation(path, node.moduleReference.expression);
      if (violation) violations.push(violation);
    }
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const argument = node.arguments[0];
      if ((isImport || isRequire) && argument) {
        const violation = dynamicLoadViolation(path, argument);
        if (violation) violations.push(violation);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function violations(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([path, code]) => sourceViolations(path, code));
}

describe("Supabase boundary", () => {
  it("scans the union of tsconfig files and all production source extensions", () => {
    const { sources } = scanRepo();
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(["middleware.ts", "next.config.ts", "src/shared/lib/supabase/server.ts", "app/page.tsx"]));
    expect([...ALLOWED.values()]).toEqual(expect.arrayContaining(["shared audit repository adapter", "shared server client factory"]));
    expect(violations(sources)).toEqual([]);
  }, SCAN_TIMEOUT);

  it("catches JavaScript and module files Next can compile even when tsconfig omits them", () => {
    const root = mkdtempSync(join(tmpdir(), "orabella-supabase-guard-"));
    try {
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"allowJs":true},"include":["**/*.ts"]}');
      writeFileSync(join(root, "marker.ts"), "export {};");
      for (const [path, code] of [
        ["app/page.js", 'import { createClient } from "@supabase/supabase-js";'],
        ["src/x.mjs", 'import { createClient } from "@supabase/supabase-js";'],
        ["middleware.js", 'import { createClient } from "@supabase/supabase-js";'],
      ] as const) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, code);
      }
      // tsconfig compiles none of them (include is **/*.ts): only the walk finds them.
      expect(compiledByTsconfig(root)).toEqual(["marker.ts"]);
      expect(violations(productionSources(root)).map((entry) => entry.split(":")[0]).sort()).toEqual(["app/page.js", "middleware.js", "src/x.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, SCAN_TIMEOUT);

  it("keeps non-production exclusions explicit and detects drift", () => {
    const { candidates, sources: scanned } = scanRepo();
    // A stale exclusion (nothing it covers exists any more) fails.
    expect([...EXCLUDED.keys()].filter((entry) => !candidates.some((path) => exclusionFor(path) === entry))).toEqual([]);
    // A new root-level source file must be declared production or excluded with a reason.
    expect(candidates.filter((path) => !path.includes("/") && !isExcluded(path) && !ROOT_PRODUCTION.has(path))).toEqual([]);
    // Every declared production root file is actually scanned.
    expect([...ROOT_PRODUCTION].filter((path) => !(path in scanned))).toEqual([]);
    // Only build/VCS/dependency output directories are skipped by the walk.
    expect([...IGNORED_DIRECTORIES.keys()].sort()).toEqual(["build", "coverage", "dist", ".git", "node_modules", ".next", "out", "playwright-report", "test-results"].sort());
  }, SCAN_TIMEOUT);

  it.each([
    ["a package import", "src/shared/lib/random.ts", 'import { createClient } from "@supabase/supabase-js";'],
    ["a root middleware import", "middleware.ts", 'import { createClient } from "@supabase/supabase-js";'],
    ["an import type", "src/features/cash/service.ts", 'type Client = import("@supabase/supabase-js").SupabaseClient;'],
    ["a literal dynamic package import", "src/features/cash/service.ts", 'const client = import("@supabase/ssr");'],
    ["a concatenated dynamic package import", "src/features/cash/service.ts", "const client = import('@supabase/' + 'supabase-js');"],
    ["a template dynamic package import", "src/features/cash/service.ts", "const client = import(`@supabase/supabase-js`);"],
    ["a variable dynamic import", "src/features/cash/service.ts", 'const moduleName = "@supabase/supabase-js"; const client = import(moduleName);'],
    ["a literal CommonJS package import", "src/features/cash/service.ts", 'const client = require("@supabase/supabase-js");'],
    ["a variable CommonJS import", "src/features/cash/service.ts", 'const moduleName = "@supabase/supabase-js"; const client = require(moduleName);'],
    ["an import-equals require", "src/features/cash/service.ts", 'import supabase = require("@supabase/supabase-js");'],
    ["a nonliteral import-equals require", "src/features/cash/service.ts", 'const moduleName = "@supabase/supabase-js"; import supabase = require(moduleName);'],
    ["a JavaScript package import", "src/shared/lib/random.js", 'import { createClient } from "@supabase/supabase-js";'],
    ["an ES module package import", "app/unsafe/loader.mjs", 'export { createClient } from "@supabase/supabase-js";'],
  ])("flags %s outside an allowed boundary", (_label, path, code) => {
    expect(violations({ [path]: code })).toHaveLength(1);
  });

  it("allows existing repository and shared client boundaries", () => {
    expect(violations({
      "src/features/cash/repos/cash.ts": 'import type { SupabaseClient } from "@supabase/supabase-js";',
      "src/shared/lib/supabase/server.ts": "const client = import(moduleName);",
    })).toEqual([]);
  });
});
