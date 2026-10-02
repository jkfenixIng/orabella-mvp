import { expect, test } from "@playwright/test";

/**
 * Sin sesión, una ruta inexistente cae en la puerta del middleware y
 * redirige al login (igual que los flujos conocidos). El not-found global
 * solo se alcanza con sesión válida: queda a las pruebas F1-F4 manuales.
 */
test("ruta inexistente sin sesión redirige al login @full", async ({ page }) => {
  await page.goto("/ruta-que-no-existe-xyz");
  await expect(page).toHaveURL(/\/login\?next=.*/);
  await expect(page.getByLabel(/documento/i)).toBeVisible();
});

