import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FEATURES = join(ROOT, "src", "features");
const ALLOWED = new Set([
  "src/features/admin/repos/catalogs.ts",
  "src/features/admin/repos/services.ts",
  "src/features/admin/repos/users.ts",
  "src/features/alerts/repos/alerts.ts",
  "src/features/auth/repos/auth.ts",
  "src/features/billing/repos/billing.ts",
  "src/features/cash/repos/cash.ts",
  "src/features/commissions/repos/commissions.ts",
  "src/features/inventory/repos/inventory.ts",
  "src/features/payroll/repos/payroll.ts",
]);
const SUPABASE_IMPORT = /\b(?:import|export)\s*(?:type\s+)?(?:[^"']*?\s+from\s+)?["']@supabase\/[^"']+["']|\b(?:import|require)\s*\(\s*["']@supabase\/[^"']+["']\s*\)/;
const SUPABASE_SYMBOL = /\b(?:SupabaseClient|createAdminClient|createClient)\b/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function violations(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, code]) => !ALLOWED.has(path) && (SUPABASE_IMPORT.test(stripComments(code)) || SUPABASE_SYMBOL.test(stripComments(code))))
    .map(([path]) => path);
}

function projectSources(): Record<string, string> {
  return Object.fromEntries(
    sourceFiles(FEATURES).map((path) => [path.slice(ROOT.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")]),
  );
}

describe("Supabase boundary", () => {
  it("allows Supabase imports and constructors only in the explicit repository adapter list", () => {
    expect(violations(projectSources())).toEqual([]);
  });

  it.each([
    ["a package import", 'import { createClient } from "@supabase/supabase-js";'],
    ["a dynamic package import", 'const client = import("@supabase/ssr");'],
    ["a CommonJS package import", 'const client = require("@supabase/supabase-js");'],
    ["a SupabaseClient type", 'import type { SupabaseClient } from "other"; type Client = SupabaseClient;'],
    ["a createClient bypass", 'const client = createClient("url", "key");'],
    ["a createAdminClient bypass", 'const client = createAdminClient();'],
  ])("flags %s outside a repository adapter", (_label, code) => {
    expect(violations({ "src/features/cash/service.ts": code })).toEqual(["src/features/cash/service.ts"]);
  });

  it("does not treat comments as executable Supabase usage", () => {
    expect(violations({ "src/features/cash/service.ts": '// createClient from "@supabase/supabase-js"' })).toEqual([]);
  });
});
