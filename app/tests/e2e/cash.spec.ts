import { expect, test, type Page } from "@playwright/test";

/**
 * Caja de punta a punta (F2, solo backend de pruebas):
 * cierra el turno abierto si quedó alguno, abre uno nuevo con conteo
 * conocido y lo cierra con el mismo conteo. Estado final = inicial
 * (sin turno abierto), así la corrida es repetible.
 *
 * Nota: los locators son a nivel página (un solo diálogo abierto a la
 * vez); el scope por diálogo con filter()+has no resuelve en este proyecto.
 *
 * Avisos de turno: son EVENTOS (acaban de pasar), así que salen por el toast
 * de sonner y ya NO por el `<p role="status">` que tenía el cliente. Sonner
 * 2.0.8 monta el texto en un `div[data-title]`, dentro del
 * `li[data-sonner-toast]`, dentro de la
 * `<section aria-label="Notifications alt+T" aria-live="polite">` que el
 * Toaster de app/layout.tsx monta una sola vez. Por eso se ancla en el
 * rol/nombre accesible de esa sección (`region`, que es lo que `<section>` con
 * nombre accesible mapea) y no en una clase: el TEXTO se busca adentro. El
 * `.first()` toma el toast MÁS NUEVO: sonner antepone cada toast a la lista,
 * así que el primero del DOM es el último en llegar.
 */
function avisos(page: Page) {
  return page.getByRole("region", { name: /notifications/i });
}

test.skip(process.env.E2E_BACKEND !== "test", "requiere backend de pruebas");

test.use({ storageState: "./tests/e2e/.auth/user.json" });

test("caja abre y cierra un turno @changed", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/cash");
  await expect(page.getByRole("heading", { name: /^caja$/i })).toBeVisible({ timeout: 15_000 });

  // Si ya hay turno abierto, cerrarlo primero
  const hasOpenShift = await page.getByText("No hay un turno abierto.").isVisible().catch(() => false);
  if (!hasOpenShift) {
    await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Cerrar turno" })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder("0").first().fill("2");
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByRole("button", { name: "Sí, cerrar turno" }).click();
    await expect(avisos(page).getByText(/turno cerrado|cierre con diferencias/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("No hay un turno abierto.")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000); // Dar tiempo a la BD
  }

  // Apertura con conteo conocido: 2 billetes de $100.000 (base $200.000).
  await page.getByRole("button", { name: "Abrir turno", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Abrir turno" })).toBeVisible({ timeout: 15_000 });
  await page.getByText("billete $ 100.000").first().fill("2");
  await page.getByRole("button", { name: "Validar y abrir" }).click();
  await expect(avisos(page).getByText(/turno abierto/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Cerrar turno", exact: true })).toBeVisible({ timeout: 10_000 });

  // Cierre con el mismo conteo: cuadra por construcción.
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  await expect(page.getByText("billete $ 100.000").first()).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("0").first().fill("2");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Sí, cerrar turno" }).click();
  await expect(avisos(page).getByText(/turno cerrado|cierre con diferencias/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No hay un turno abierto.")).toBeVisible({ timeout: 10_000 });

  // Vista del día: el turno de hoy aparece.
  await page.getByRole("button", { name: "Mostrar vista del día" }).click();
  await expect(page.getByText("Sin turnos este día.")).toBeHidden({ timeout: 30_000 });

  // Apertura con conteo conocido: 2 billetes de $100.000 (base $200.000).
  // Se espera a la denominación por nombre porque la lista carga async.
  await page.getByRole("button", { name: "Abrir turno", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Abrir turno" })).toBeVisible();
  await expect(page.getByText("billete $ 100.000").first()).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("0").first().fill("2");
  await page.getByRole("button", { name: "Validar y abrir" }).click();
  // El aviso se busca DENTRO de la bandeja de toasts: el `<p>` de la página
  // ("No hay un turno abierto.") también contiene "turno abierto" y esta
  // guarda lo deja afuera sin depender de un `role` que ya no existe.
  await expect(avisos(page).getByText(/turno abierto/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Cerrar turno", exact: true })).toBeVisible();

  // Cierre con el mismo conteo: cuadra por construcción.
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cerrar turno" })).toBeVisible();
  await expect(page.getByText("billete $ 100.000").first()).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("0").first().fill("2");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Sí, cerrar turno" }).click();
  await expect(avisos(page).getByText(/turno cerrado|cierre con diferencias/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No hay un turno abierto.")).toBeVisible();

  // Vista del día: el turno de hoy aparece.
  await page.getByRole("button", { name: "Mostrar vista del día" }).click();
  await expect(page.getByText("Sin turnos este día.")).toBeHidden({ timeout: 30_000 });
});
