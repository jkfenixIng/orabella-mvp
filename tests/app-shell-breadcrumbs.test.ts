import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findNavLocation } from "@/src/shared/components/main-nav";

const shell = readFileSync(join(process.cwd(), "src/shared/components/app-shell.tsx"), "utf8");

describe("AppShell breadcrumbs", () => {
  it("derives Spanish group and route labels from MainNav metadata", () => {
    expect(findNavLocation("/")).toBeNull();
    expect(findNavLocation("/login")).toBeNull();
    expect(findNavLocation("/cash/history")).toMatchObject({
      group: { label: "Operación" },
      link: { label: "Caja" },
    });
    expect(findNavLocation("/admin")).toMatchObject({
      group: { label: "Control" },
      link: { label: "Administración" },
    });
  });

  it("uses semantic navigation and avoids login and Home root", () => {
    expect(shell).toContain('aria-label="Ruta de navegación"');
    expect(shell).toContain('aria-current="page"');
    expect(shell).toContain("if (isLogin)");
    expect(shell).toContain("if (!location) return null;");
    expect(shell).toContain("findNavLocation(pathname)");
  });
});
