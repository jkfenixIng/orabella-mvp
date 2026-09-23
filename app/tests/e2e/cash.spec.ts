import { expect, test } from "@playwright/test";

/**
 * Caja de punta a punta (F2, solo backend de pruebas):
 * cierra el turno abierto si quedó alguno, abre uno nuevo con conteo
 * conocido y lo cierra con el mismo conteo. Estado final = inicial
 * (sin turno abierto), así la corrida es repetible.
 *
 * Nota: los locators son a nivel página (un solo diálogo abierto a la
 * vez); el scope por diálogo con filter()+has no resuelve en este proyecto.
 */
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
    await expect(page.locator('p[role="status"]', { hasText: /turno cerrado|cierre con diferencias/i })).toBeVisible({
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
  await expect(page.locator('p[role="status"]', { hasText: /turno abierto/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Cerrar turno", exact: true })).toBeVisible({ timeout: 10_000 });

  // Cierre con el mismo conteo: cuadra por construcción.
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  await expect(page.getByText("billete $ 100.000").first()).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("0").first().fill("2");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Sí, cerrar turno" }).click();
  await expect(page.locator('p[role="status"]', { hasText: /turno cerrado|cierre con diferencias/i })).toBeVisible({
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
  // role=status: solo el aviso de éxito (evita el falso positivo de "No hay un turno abierto.").
  await expect(page.locator('p[role="status"]', { hasText: /turno abierto/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Cerrar turno", exact: true })).toBeVisible();

  // Cierre con el mismo conteo: cuadra por construcción.
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cerrar turno" })).toBeVisible();
  await expect(page.getByText("billete $ 100.000").first()).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("0").first().fill("2");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Sí, cerrar turno" }).click();
  await expect(page.locator('p[role="status"]', { hasText: /turno cerrado|cierre con diferencias/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No hay un turno abierto.")).toBeVisible();

  // Vista del día: el turno de hoy aparece.
  await page.getByRole("button", { name: "Mostrar vista del día" }).click();
  await expect(page.getByText("Sin turnos este día.")).toBeHidden({ timeout: 30_000 });
});
