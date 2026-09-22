import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Backend de pruebas: app/.env.e2e.local (claves del proyecto Supabase de
 * PRUEBAS, git-ignored) se carga solo para la corrida E2E, sin pisar el
 * entorno real ni tocar .env.local. Sin ese archivo corren únicamente los
 * specs sin sesión (guards/api/smoke/login/notfound).
 */
function loadE2EEnv(): void {
  const file = join(process.cwd(), ".env.e2e.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    const value = trimmed
      .slice(trimmed.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadE2EEnv();

const e2eEnv: Record<string, string> = {};
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (process.env[key]) e2eEnv[key] = process.env[key] as string;
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "e2e", testMatch: /.*\.spec\.ts/, dependencies: ["setup"] },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
    env: e2eEnv,
  },
});
