import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
const SUPABASE_IMPORT = /\b(?:import|export)\s*(?:type\s+)?(?:[^"']*?\s+from\s+)?["']@supabase\/[^"']+["']|\b(?:import|require)\s*\(\s*["']@supabase\/[^"']+["']\s*\)/;
const SUPABASE_SYMBOL = /\b(?:SupabaseClient|createAdminClient|createClient)\b/;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
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
    ["a dynamic package import", "src/features/cash/service.ts", 'const client = import("@supabase/ssr");'],
    ["a CommonJS package import", "src/features/cash/service.ts", 'const client = require("@supabase/supabase-js");'],
    ["a SupabaseClient type", "src/features/cash/service.ts", 'import type { SupabaseClient } from "other"; type Client = SupabaseClient;'],
    ["a createClient bypass", "app/unsafe/page.tsx", 'const client = createClient("url", "key");'],
    ["a createAdminClient bypass", "src/features/cash/service.ts", "const client = createAdminClient();"],
  ])("flags %s outside an allowed boundary", (_label, path, code) => {
    expect(violations({ [path]: code })).toEqual([path]);
  });

  it("does not treat comments as executable Supabase usage", () => {
    expect(violations({ "src/features/cash/service.ts": '// createClient from "@supabase/supabase-js"' })).toEqual([]);
  });
});
