import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8");
const PRIMITIVE = read("src", "components", "ui", "lib", "list-toolbar.tsx");

describe("list toolbar convention", () => {
  it("labels search and status controls and exposes the shared actions", () => {
    expect(PRIMITIVE).toMatch(/<label[^>]*htmlFor=\{searchId\}[\s\S]*?<Input[\s\S]*?id=\{searchId\}/);
    expect(PRIMITIVE).toContain("<Search aria-hidden=\"true\"");
    expect(PRIMITIVE).toMatch(/<label[^>]*>\s*\{statusLabel\}\s*<select/);
    for (const text of ["Filtrar", "Limpiar", "Más filtros"]) expect(PRIMITIVE).toContain(text);
    expect(PRIMITIVE).toContain("aria-expanded={moreOpen}");
    expect(PRIMITIVE).toContain("activeFilterCount > 0");
  });

  it("renders the shared pagination footer", () => {
    expect(PRIMITIVE).toContain('aria-label="Paginación"');
    expect(PRIMITIVE).toContain("Mostrando {start}–{end} de {total}");
    expect(PRIMITIVE).toContain("Página {safePage + 1} de {pageCount}");
    expect(PRIMITIVE).toContain("Anterior");
    expect(PRIMITIVE).toContain("Siguiente");
  });

  it("services uses the server page action with a 20 row page and 300 ms debounce", () => {
    const client = read("app", "services", "services-client.tsx");
    expect(client).toContain("const PAGE_SIZE = 20;");
    expect(client).toContain("const SEARCH_DEBOUNCE_MS = 300;");
    expect(client).toContain("listServicesPageAction({");
    expect(client).toContain("<ListToolbar");
    expect(client).toContain("<ListPager");
    expect(client).toMatch(/variant=\{row\.is_active \? "success" : "destructive"\}/);
  });

  it("services page action is limited to admin and caja", () => {
    const actions = read("src", "features", "admin", "actions.ts");
    expect(actions).toMatch(/listServicesPageAction[\s\S]*role === "admin" \|\| role === "caja"/);
  });

  it("loading skeletons respect reduced motion", () => {
    for (const area of ["services", "inventory"]) {
      const loading = read("app", area, "loading.tsx");
      expect(loading).toContain("motion-safe:animate-pulse");
      expect(loading).not.toContain("min-h-screen");
      expect(loading).toContain('role="status"');
    }
  });
});
