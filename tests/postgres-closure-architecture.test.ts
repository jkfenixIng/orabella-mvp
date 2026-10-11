import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FEATURES = join(ROOT, "src", "features");
const ALLOWED = /[\\/]repos[\\/][\w.-]+\.ts$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("Supabase boundary", () => {
  it("allows the privileged client only in repository adapters", () => {
    const violations = sourceFiles(FEATURES)
      .filter((path) => /supabase\/server|createAdminClient/.test(readFileSync(path, "utf8")))
      .filter((path) => !ALLOWED.test(path))
      .map((path) => path.slice(ROOT.length + 1).replaceAll("\\", "/"));

    expect(violations).toEqual([]);
  });
});
