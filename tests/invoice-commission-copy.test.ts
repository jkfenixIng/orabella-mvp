import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "app/invoices/invoices-client.tsx"), "utf8");
const dialog = source.slice(
  source.indexOf("Pago inmediato de comisión(es): aparece"),
  source.indexOf("{/* Confirmación clásica"),
);
const RULE = "El porcentaje se paga en nómina.";

describe("factura: la comisión no expone mecánica interna al cliente", () => {
  it("el diálogo de pago no explica el tope de efectivo ni la acumulación a nómina", () => {
    expect(dialog.length).toBeGreaterThan(0);
    expect(dialog).not.toContain("50%");
    expect(dialog).not.toContain("base de apertura");
    expect(dialog).not.toContain("se acumula");
  });

  it("la hoja de factura en vista cliente no imprime reglas internas de comisión", () => {
    const occurrences = source.split(RULE).length - 1;
    const guarded =
      source.match(
        /\{!clientView && \(\s*<p className="text-xs text-paper-ink-muted">\s*Se paga el porcentaje del empleado sobre el subtotal\.\s*El porcentaje se paga en nómina\./g,
      ) ?? [];
    expect(occurrences).toBe(3);
    expect(guarded).toHaveLength(occurrences);
  });
});
