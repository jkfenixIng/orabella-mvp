import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const client = readFileSync(join(process.cwd(), "app", "cash", "cash-client.tsx"), "utf8");
const actions = readFileSync(join(process.cwd(), "src", "features", "cash", "actions.ts"), "utf8");

describe("cash available-by-method toggle", () => {
  it("hides loaded balances on the next press and exposes expanded state", () => {
    expect(client).toContain("aria-expanded={methodBalances !== null}");
    expect(client).toContain('aria-controls="cash-method-balances"');
    expect(client).toMatch(/if \(methodBalances !== null\) \{\s*setMethodBalances\(null\);\s*return;/);
    expect(client).toContain('{methodBalances ? "Ocultar disponible por método" : "Ver disponible por método"}');
  });

  it("keeps the panel admin-only in UI and server action", () => {
    expect(client).toContain("{props.isAdmin && methodBalances && (");
    expect(actions).toMatch(/getShiftMethodBalancesAction[\s\S]*requireAdminSession/);
  });
});
