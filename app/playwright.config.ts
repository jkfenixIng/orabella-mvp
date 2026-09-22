import { defineConfig } from "@playwright/test";

/**
 * Smoke E2E mínimo (pre-pruebas). Solo enumera y corre 1 spec sin
 * exigir suite completa. Navegadores se instalan aparte con
 * `npx playwright install --with-deps` (fuera de este lote).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
