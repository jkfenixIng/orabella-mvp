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

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
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

function sourceViolations(path: string, code: string): string[] {
  if (ALLOWED.has(path)) return [];
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
  ])("flags %s outside an allowed boundary", (_label, path, code) => {
    expect(violations({ [path]: code })).toHaveLength(1);
  });

  it("allows existing repository and shared client boundaries", () => {
    expect(violations({
      "src/features/cash/repos/cash.ts": 'import type { SupabaseClient } from "@supabase/supabase-js";',
      "src/shared/lib/supabase/server.ts": 'const client = import(moduleName);',
    })).toEqual([]);
  });
});
