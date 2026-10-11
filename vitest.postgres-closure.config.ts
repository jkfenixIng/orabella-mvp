import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": rootDir } },
  test: {
    environment: "node",
    include: ["tests/postgres-closure.runtime.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
