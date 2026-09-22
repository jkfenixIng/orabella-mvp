import { expect, test as setup } from "@playwright/test";

/**
 * Setup autenticado (solo con E2E_BACKEND=test en .env.e2e.local).
 * Login por UI con el admin de seed; si pide cambio forzado (AUTH-01),
 * lo completa con E2E_ADMIN_NEW_PASSWORD. Guarda la sesión para authed.spec.ts.
 */
const AUTH_FILE = "./tests/e2e/.auth/user.json";
const DOCUMENTO = process.env.E2E_ADMIN_DOCUMENTO ?? "10000001";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? DOCUMENTO;
const NEW_PASSWORD = process.env.E2E_ADMIN_NEW_PASSWORD ?? "E2e-Pruebas-2026";

setup.skip(
  process.env.E2E_BACKEND !== "test",
  "requiere E2E_BACKEND=test en app/.env.e2e.local (backend de pruebas)",
);

setup("login admin de pruebas", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/documento/i).fill(DOCUMENTO);
  await page.getByLabel(/^clave/i).fill(PASSWORD);
  await page.getByRole("button", { name: /ingresar/i }).click();

  // Cambio forzado la primera vez (AUTH-01): clave 8+ con letra y número.
  const forceHeading = page.getByRole("heading", { name: /cambio de clave/i });
  if (await forceHeading.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.getByLabel(/nueva clave/i).first().fill(NEW_PASSWORD);
    await page.getByLabel(/confirmar/i).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /cambiar clave/i }).click();
  }

  // Home con módulos: sesión válida.
  await expect(page.getByRole("heading", { name: /^orabella$/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: /módulos/i })).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
