import { expect, test } from "@playwright/test";

/**
 * Regresión: el listado de facturas debe renderizar contra la BD real.
 * Caza la clase de bugs que los unit tests no ven (columnas ausentes,
 * joins ambiguos de PostgREST): listInvoices fallaba con 42703/PGRST201
 * y solo se veía en el navegador.
 */
test.skip(process.env.E2E_BACKEND !== "test", "requiere backend de pruebas");

test.use({ storageState: "./tests/e2e/.auth/user.json" });

test("facturas lista sin error @changed", async ({ page }) => {
  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: /^facturación$/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: /algo salió mal/i })).toBeHidden();
  const empty = page.getByText("Sin facturas para estos filtros.");
  const firstRow = page.getByText(/#\d+/).first();
  await expect(empty.or(firstRow)).toBeVisible({ timeout: 20_000 });
});
