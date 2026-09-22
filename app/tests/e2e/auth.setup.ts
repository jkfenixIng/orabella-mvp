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

  // El primer golpe compila la ruta bajo demanda: espera larga y ramificada.
  const forceHeading = page.getByRole("heading", { name: /cambio de clave/i });
  const modules = page.getByRole("region", { name: /módulos/i });
  // El anunciador de rutas de Next (__next-route-announcer__) también usa
  // role=alert vacío: los errores reales viven en <p role=alert> del form.
  const alert = page.locator("form p[role=alert]");
  await expect(forceHeading.or(modules).or(alert)).toBeVisible({ timeout: 60_000 });

  // Cambio forzado la primera vez (AUTH-01): clave 8+ con letra y número.
  if (await forceHeading.isVisible()) {
    await page.getByLabel(/nueva clave/i).first().fill(NEW_PASSWORD);
    await page.getByLabel(/confirmar/i).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /cambiar clave/i }).click();
    await expect(modules.or(alert)).toBeVisible({ timeout: 60_000 });
  }

  // Error de login: falla fuerte con el mensaje real (no sigue sin sesión).
  if (await alert.isVisible()) {
    throw new Error(`login E2E rechazado: ${await alert.innerText()}`);
  }

  // Home con módulos: sesión válida (la URL manda, el h1 "Orabella" también existe en /login).
  await expect(page).toHaveURL(/^.*\/$/);
  await expect(modules).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
