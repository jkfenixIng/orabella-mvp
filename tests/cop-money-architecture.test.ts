import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * COP policy guard: a money field may not go back to a decimal
 * `z.coerce.number()`. Every numeric coercion in the schema surfaces must be
 * either an integer (`.int(...)`: quantities, minutes, ISO days, paging) or a
 * PERCENTAGE field (percentages are not money and keep decimals). Money uses
 * `copSchema` / `positiveCopSchema` from src/shared/money/cop.ts.
 */
const SCHEMA_SURFACES = [
  "src/features/billing/schemas.ts",
  "src/features/cash/schemas.ts",
  "src/features/cash/service.ts",
  "src/features/admin/schemas.ts",
  "src/features/inventory/schemas.ts",
  "src/features/payroll/schemas.ts",
  "src/features/commissions/schemas.ts",
];

const PERCENT_FIELDS = new Set(["percent", "fee_percent", "commission_percent", "commission_percent_override"]);

/** Field names whose numeric coercion is neither integer nor a percentage. */
function decimalCoercions(source: string): string[] {
  const offenders: string[] = [];
  const pattern = /(\w+)\s*:\s*z\s*\.coerce\s*\.number\(([^)]*)\)((?:\s*\.\w+\([^)]*\))*)/g;
  for (const match of source.matchAll(pattern)) {
    const [, field, , chain] = match;
    if (/\.int\(/.test(chain)) continue;
    if (PERCENT_FIELDS.has(field)) continue;
    offenders.push(field);
  }
  // Array element coercions (`z.array(z.coerce.number()...)`) have no field name.
  for (const match of source.matchAll(/z\.array\(\s*z\s*\.coerce\s*\.number\(\)((?:\s*\.\w+\([^)]*\))*)/g)) {
    if (!/\.int\(/.test(match[1])) offenders.push("<array element>");
  }
  return offenders;
}

describe("COP money schema architecture", () => {
  it("no money field uses a decimal z.coerce.number()", () => {
    const offenders = SCHEMA_SURFACES.flatMap((file) =>
      decimalCoercions(readFileSync(join(process.cwd(), file), "utf8")).map((field) => `${file}:${field}`),
    );
    expect(offenders).toEqual([]);
  });

  it("negative fixture: the guard catches a regressed money field", () => {
    const fixture = `export const s = z.object({
      amount: z.coerce.number().positive("El monto debe ser mayor a 0."),
      price: z.coerce
        .number()
        .nonnegative("x"),
      qty: z.coerce.number().int("Cantidad entera.").positive("x"),
      percent: z.coerce.number().min(0).max(100),
    });`;
    expect(decimalCoercions(fixture)).toEqual(["amount", "price"]);
  });

  it("every schema surface imports the shared COP helper", () => {
    for (const file of SCHEMA_SURFACES.filter((path) => path.endsWith("schemas.ts"))) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file).toMatch(/@\/src\/shared\/money\/cop/);
    }
  });
});
