import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arqueoMethods, buildArqueoCountLines } from "@/app/cash/arqueo-lines";

const methods = [
  { code: "caja-billetes", name: "Caja", is_active: true, arqueo_mode: "denominations" as const },
  { code: "efectivo", name: "Efectivo", is_active: true, arqueo_mode: "declared_total" as const },
  { code: "tarjeta", name: "Tarjeta", is_active: true, arqueo_mode: "none" as const },
  { code: "nequi", name: "Nequi", is_active: false, arqueo_mode: "declared_total" as const },
];
const denominations = [
  { id: "d1", value: 50000 },
  { id: "d2", value: 10000 },
];

describe("cash UI: count lines follow each method's arqueo mode (003)", () => {
  it("lists only active arqueable methods, split by mode", () => {
    const split = arqueoMethods(methods);
    expect(split.drawer?.code).toBe("caja-billetes");
    expect(split.declared.map((method) => method.code)).toEqual(["efectivo"]);
  });

  it("builds the drawer by denomination under its configured code and one declared total per method", () => {
    const lines = buildArqueoCountLines({
      methods,
      denominations,
      quantities: { d1: "2", d2: "3" },
      totals: { efectivo: "1500" },
    });
    expect(lines).toEqual([
      { method_code: "caja-billetes", denomination: 50000, quantity: 2, amount: 100000 },
      { method_code: "caja-billetes", denomination: 10000, quantity: 3, amount: 30000 },
      { method_code: "efectivo", denomination: null, quantity: 1, amount: 1500 },
    ]);
  });

  it("never produces a negative or fractional count", () => {
    const lines = buildArqueoCountLines({
      methods,
      denominations,
      quantities: { d1: "-4", d2: "2.7" },
      totals: { efectivo: "-90" },
    });
    expect(lines.every((line) => line.amount >= 0 && Number.isInteger(line.quantity))).toBe(true);
  });

  it("the cash client builds its counts with the helper, not with a hard-coded cash code", () => {
    const source = readFileSync(join(process.cwd(), "app", "cash", "cash-client.tsx"), "utf8");
    expect(source).toContain("buildArqueoCountLines");
    expect(source).not.toMatch(/method_code: "efectivo"/);
    expect(source).not.toMatch(/code !== "efectivo"/);
  });
});
