import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// `npm run test:db`: only the PGlite characterization suite (tests/db/README.md).
export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.db.test.ts"],
    testTimeout: 60_000,
  },
});
