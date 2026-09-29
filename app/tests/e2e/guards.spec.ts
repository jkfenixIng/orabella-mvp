import { expect, test } from "@playwright/test";

/**
 * Puerta de autenticación (middleware): sin cookie de sesión, cada flujo
 * protegido redirige a /login?next=<ruta>. No toca la BD (solo presencia
 * de cookie), así que es determinista en cualquier entorno.
 */
const FLOWS = ["/", "/admin", "/invoices", "/cash", "/inventory", "/payroll", "/vales", "/alerts"];

for (const flow of FLOWS) {
  test(`sin sesión ${flow} redirige al login @full`, async ({ page }) => {
    await page.goto(flow);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=.*${flow.replace(/\//g, ".*")}`));
    await expect(page.getByLabel(/documento/i)).toBeVisible();
  });
}

