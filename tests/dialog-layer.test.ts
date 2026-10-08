import { describe, expect, it } from "vitest";
import {
  computeDialogZIndex,
  computePopoverZIndex,
} from "@/src/components/ui/lib/dialog";

// Contrato de capas de diálogo (U1). Estas bandas sostienen dos invariantes:
//   1. El overlay de un diálogo apilado queda por encima del contenido anterior.
//   2. Los popovers (Select/Combobox) quedan por encima del contenido de su
//      propio diálogo y por debajo del overlay del diálogo siguiente.
describe("computeDialogZIndex", () => {
  it("el primer diálogo abierto usa overlay 45 y contenido 50", () => {
    expect(computeDialogZIndex(1)).toEqual({ overlay: 45, content: 50 });
  });

  it("cada nivel apilado sube 10 unidades", () => {
    expect(computeDialogZIndex(2)).toEqual({ overlay: 55, content: 60 });
    expect(computeDialogZIndex(3)).toEqual({ overlay: 65, content: 70 });
  });

  it("el overlay de un nivel supera el contenido del nivel anterior", () => {
    for (let level = 1; level < 5; level += 1) {
      const below = computeDialogZIndex(level);
      const above = computeDialogZIndex(level + 1);
      expect(above.overlay).toBeGreaterThan(below.content);
    }
  });

  it("normaliza niveles inválidos al nivel 1", () => {
    expect(computeDialogZIndex(0)).toEqual({ overlay: 45, content: 50 });
    expect(computeDialogZIndex(-3)).toEqual({ overlay: 45, content: 50 });
  });
});

describe("computePopoverZIndex", () => {
  it("con un diálogo abierto, el popover (53) supera su contenido (50) y su overlay (45)", () => {
    const dialog = computeDialogZIndex(1);
    const popover = computePopoverZIndex(1);
    expect(popover).toBe(53);
    expect(popover).toBeGreaterThan(dialog.content);
    expect(popover).toBeGreaterThan(dialog.overlay);
  });

  it("el popover nunca alcanza el overlay del diálogo siguiente", () => {
    for (let level = 1; level < 5; level += 1) {
      const popover = computePopoverZIndex(level);
      const nextOverlay = computeDialogZIndex(level + 1).overlay;
      expect(popover).toBeLessThan(nextOverlay);
    }
  });

  it("sin diálogos abiertos usa la banda del nivel 1", () => {
    expect(computePopoverZIndex(0)).toBe(computePopoverZIndex(1));
  });
});
