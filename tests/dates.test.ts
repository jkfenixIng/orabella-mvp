import { describe, expect, it } from "vitest";
import {
  BOGOTA_TZ_OFFSET,
  bogotaDay,
  dayBounds,
  isInstantInBogotaRange,
  rangeBounds,
} from "@/src/shared/lib/dates";

// Regresión de la ventana de facturas de nómina: los límites deben llevar el
// offset de Bogotá o la ventana corre 5 h (se pierden las facturas de la noche
// del último día y se cuelan las de la noche anterior).

describe("dates: límites de rango en hora de Bogotá", () => {
  it("rangeBounds arma el rango inclusivo con offset -05:00", () => {
    expect(rangeBounds("2026-09-23", "2026-09-24")).toEqual({
      from: "2026-09-23T00:00:00-05:00",
      to: "2026-09-24T23:59:59.999-05:00",
    });
  });

  it("dayBounds cubre el día completo con offset -05:00", () => {
    expect(BOGOTA_TZ_OFFSET).toBe("-05:00");
    expect(dayBounds("2026-09-24")).toEqual({
      from: "2026-09-24T00:00:00-05:00",
      to: "2026-09-24T23:59:59.999-05:00",
    });
  });
});

describe("dates: factura de la noche del end_date cae en el rango (bug de comisión)", () => {
  it("una factura de 23:50 Bogotá del 24 sep (04:50Z del 25) entra en 23→24", () => {
    // 2026-09-24 23:50 Bogotá = 2026-09-25T04:50:00Z (UTC-5).
    expect(isInstantInBogotaRange("2026-09-25T04:50:00Z", "2026-09-23", "2026-09-24")).toBe(true);
  });

  it("el límite superior incluye 23:59:59.999 Bogotá y excluye la medianoche siguiente", () => {
    // 2026-09-24 23:59:59.999 Bogotá = 2026-09-25T04:59:59.999Z.
    expect(isInstantInBogotaRange("2026-09-25T04:59:59.999Z", "2026-09-23", "2026-09-24")).toBe(true);
    // 2026-09-25 00:00 Bogotá = 2026-09-25T05:00:00Z → fuera.
    expect(isInstantInBogotaRange("2026-09-25T05:00:00Z", "2026-09-23", "2026-09-24")).toBe(false);
  });
});

describe("dates: efecto espejo — la noche anterior al start_date NO se cuela", () => {
  it("una factura de 20:00 Bogotá del 22 sep (01:00Z del 23) queda fuera de 23→24", () => {
    // 2026-09-22 20:00 Bogotá = 2026-09-23T01:00:00Z (UTC-5).
    expect(isInstantInBogotaRange("2026-09-23T01:00:00Z", "2026-09-23", "2026-09-24")).toBe(false);
  });
});

describe("dates: bogotaDay resuelve el día de Bogotá, no el de UTC", () => {
  it("04:50Z del 25 sep corresponde al 24 sep en Bogotá", () => {
    expect(bogotaDay(0, new Date("2026-09-25T04:50:00Z"))).toBe("2026-09-24");
  });

  it("05:00Z del 25 sep ya es el 25 sep en Bogotá (medianoche COT)", () => {
    expect(bogotaDay(0, new Date("2026-09-25T05:00:00Z"))).toBe("2026-09-25");
  });
});
