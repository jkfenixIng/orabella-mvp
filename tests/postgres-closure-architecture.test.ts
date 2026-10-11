import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE_ROOTS = ["src", "app"] as const;
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
const SUPABASE = "@supabase/";
// `.d.ts` participates in type resolution, so it is scanned too; `allowJs` adds the JS family.
const SOURCE_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : isSourceFile(path) ? [path] : [];
  });
}

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
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(SUPABASE)) {
        violations.push(`${path}: Supabase module import`);
      }
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) && argument.literal.text.startsWith(SUPABASE)) {
        violations.push(`${path}: Supabase import type`);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression) {
        const violation = dynamicLoadViolation(path, expression);
        if (violation) violations.push(violation);
      }
    }
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const argument = node.arguments[0];
        if (argument) {
          const violation = dynamicLoadViolation(path, argument);
          if (violation) violations.push(violation);
        }
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

function projectSources(): Record<string, string> {
  return Object.fromEntries(
    SOURCE_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
      .map((path) => [path.slice(ROOT.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")]),
  );
}

describe("Supabase boundary", () => {
  it("scans all production source roots and allows only named infrastructure boundaries", () => {
    expect(SOURCE_ROOTS).toEqual(["src", "app"]);
    expect([...ALLOWED.values()]).toEqual(expect.arrayContaining(["shared audit repository adapter", "shared server client factory"]));
    expect(violations(projectSources())).toEqual([]);
  });

  it.each([
    ["a package import", "src/shared/lib/random.ts", 'import { createClient } from "@supabase/supabase-js";'],
    ["an import type", "src/features/cash/service.ts", 'type Client = import("@supabase/supabase-js").SupabaseClient;'],
    ["a literal dynamic package import", "src/features/cash/service.ts", 'const client = import("@supabase/ssr");'],
    ["a concatenated dynamic package import", "src/features/cash/service.ts", "const client = import('@supabase/' + 'supabase-js');"],
    ["a template dynamic package import", "src/features/cash/service.ts", "const client = import(`@supabase/supabase-js`);"],
    ["a variable dynamic import", "src/features/cash/service.ts", 'const moduleName = "@supabase/supabase-js"; const client = import(moduleName);'],
    ["a literal CommonJS package import", "src/features/cash/service.ts", 'const client = require("@supabase/supabase-js");'],
    ["a variable CommonJS import", "src/features/cash/service.ts", 'const moduleName = "@supabase/supabase-js"; const client = require(moduleName);'],
    ["an import-equals require", "src/features/cash/service.ts", 'import supabase = require("@supabase/supabase-js");'],
    ["a JavaScript package import", "src/shared/lib/random.js", 'import { createClient } from "@supabase/supabase-js";'],
    ["an ES module package import", "app/unsafe/loader.mjs", 'export { createClient } from "@supabase/supabase-js";'],
  ])("flags %s outside an allowed boundary", (_label, path, code) => {
    expect(violations({ [path]: code })).toHaveLength(1);
  });

  it("rejects a nonliteral import-equals module reference", () => {
    const code = 'const moduleName = "@supabase/supabase-js"; import supabase = require(moduleName);';
    expect(violations({ "src/features/cash/service.ts": code })).toHaveLength(1);
  });

  it("scans every source extension the TypeScript configuration can compile", () => {
    const { config } = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
    const allowJs = config?.compilerOptions?.allowJs === true;
    expect(SOURCE_EXTENSIONS).toEqual(expect.arrayContaining([".ts", ".tsx", ".mts", ".cts", ".d.ts"]));
    if (allowJs) expect(SOURCE_EXTENSIONS).toEqual(expect.arrayContaining([".js", ".jsx", ".mjs", ".cjs"]));
    expect(SOURCE_EXTENSIONS.every((extension) => isSourceFile(`x${extension}`))).toBe(true);
  });

  it("allows existing repository and shared client boundaries", () => {
    expect(violations({
      "src/features/cash/repos/cash.ts": 'import type { SupabaseClient } from "@supabase/supabase-js";',
      "src/shared/lib/supabase/server.ts": 'const client = import(moduleName);',
    })).toEqual([]);
  });
});
