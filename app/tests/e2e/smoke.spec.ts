import { expect, test } from "@playwright/test";

/** Smoke: la página de login renderiza el formulario. */
test("login muestra formulario", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel(/documento/i)).toBeVisible();
});
