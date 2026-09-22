import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";

/** Flujos con sesión (solo con E2E_BACKEND=test; ver auth.setup.ts). */
const AUTH_FILE = "./tests/e2e/.auth/user.json";

test.skip(
  process.env.E2E_BACKEND !== "test" || !existsSync(AUTH_FILE),
  "requiere backend de pruebas + sesión de setup",
);

test.use({ storageState: existsSync(AUTH_FILE) ? AUTH_FILE : undefined });

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
