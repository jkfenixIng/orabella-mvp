import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Los módulos .tsx del proyecto usan JSX; el tsconfig lo deja en "preserve"
  // (Next lo compila). Vitest necesita transformarlo para poder importarlos.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
