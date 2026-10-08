import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "next-env.d.ts",
      // Artefactos generados
      "node_modules/**",
      ".next/**",
      "out/**",
      "dist/**",
      "build/**",
      ".angular/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      ".vercel/**",
      ".vitest/**",
      "__pycache__/**",
      // Fuera del proyecto: checkouts hermanos y estado local (ver .gitignore).
      // Sin esto `eslint .` desde la raiz lintea `front/`, que es otra app.
      "front/**",
      "API/**",
      "odd/**",
      "entregables/**",
      ".agents/**",
      ".claude/**",
      ".codegraph/**",
      ".perxia/**",
      ".atl/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
