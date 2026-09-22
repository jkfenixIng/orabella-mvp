import { expect, test } from "@playwright/test";

/** Flujos con sesión (solo con E2E_BACKEND=test; ver auth.setup.ts). */
const AUTH_FILE = "./tests/e2e/.auth/user.json";

// Solo la bandera decide: el archivo lo escribe setup (dependencia) antes
// de que este proyecto corra; evaluarlo acá sería en carga, demasiado pronto.
test.skip(process.env.E2E_BACKEND !== "test", "requiere backend de pruebas");

test.use({ storageState: AUTH_FILE });

test("home muestra módulos con sesión", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/^.*\/$/);
  await expect(page.getByRole("region", { name: /módulos/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /facturación/i })).toBeVisible();
});

test("admin carga con sesión admin", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByRole("heading", { name: /administración/i })).toBeVisible();
});
