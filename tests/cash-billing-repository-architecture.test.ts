import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("cash and billing database ports", () => {
  it("keeps service persistence behind ports", () => {
    for (const service of ["src/features/cash/service.ts", "src/features/billing/service.ts"]) {
      const source = read(service);
      expect(source).not.toMatch(/createAdminClient/);
      expect(source).not.toMatch(/\.from\(/);
      expect(source).not.toMatch(/\.rpc\(/);
    }
  });

  it("keeps both engine adapters behind dynamic selectors", () => {
    const ports = ["src/features/cash/repos/cash.ts", "src/features/billing/repos/billing.ts"];
    for (const port of ports) {
      const adapter = port.replace(".ts", ".drizzle.ts");
      expect(existsSync(join(root, port))).toBe(true);
      expect(existsSync(join(root, adapter))).toBe(true);
      expect(read(port)).toMatch(/getDbConfig\(\)\.engine === "postgres"/);
      expect(read(port)).toMatch(/import\("@\/src\/shared\/db\/client"\)/);
      expect(read(port)).toMatch(/import\("\.\/.*\.drizzle"\)/);
    }
  });
});
