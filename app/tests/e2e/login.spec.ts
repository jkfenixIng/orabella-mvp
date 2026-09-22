import { expect, test } from "@playwright/test";

/** Login: validación inmediata en el navegador (inputs required). */
test("login exige documento y clave antes de enviar", async ({ page }) => {
  await page.goto("/login");
  const documento = page.getByLabel(/documento/i);
  const clave = page.getByLabel(/clave/i);
  await expect(documento).toHaveAttribute("required", "");
  await expect(clave).toHaveAttribute("required", "");
  await page.getByRole("button", { name: /ingresar/i }).click();
  // El navegador frena el submit vacío: seguimos en /login sin errores de red.
  await expect(page).toHaveURL(/\/login/);
  await expect(documento).toBeVisible();
});
