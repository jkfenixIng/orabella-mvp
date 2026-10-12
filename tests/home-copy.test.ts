import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeWelcomeDescription, homeWelcomeTitle } from "@/app/home-copy";

describe("inicio: bienvenida", () => {
  it("saluda con el primer nombre y cae a un saludo genérico", () => {
    expect(homeWelcomeTitle("  Ana María Pérez ")).toBe("Bienvenido, Ana");
    expect(homeWelcomeTitle("")).toBe("Bienvenido");
    expect(homeWelcomeTitle(null)).toBe("Bienvenido");
  });

  it("describe solo los módulos visibles del rol", () => {
    expect(homeWelcomeDescription(["Facturación", "Vales", "Nómina"])).toBe(
      "Desde aquí gestiona facturación, vales y nómina. Elija un módulo para empezar.",
    );
    expect(homeWelcomeDescription(["Caja"])).toBe("Desde aquí gestiona caja. Elija un módulo para empezar.");
    expect(homeWelcomeDescription([])).toBe("Aún no tiene módulos asignados.");
  });

  it("la página usa la lista filtrada por rol", () => {
    const page = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
    expect(page).toContain("homeWelcomeTitle(session.user.full_name)");
    expect(page).toContain("homeWelcomeDescription(visibleModules.map((module) => module.name))");
  });
});
