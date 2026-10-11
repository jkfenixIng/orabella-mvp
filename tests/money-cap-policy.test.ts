import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  commissionPayoutCapExceeded,
  invoicePaymentCapExceeded,
  payrollPaymentCapExceeded,
} from "@/src/shared/money/caps";
import { cashOutLimitViolation } from "@/src/features/cash/schemas";
import { closeDb, freshDb, warmTemplate, type Db } from "./db/harness";

let db: Db;

beforeAll(warmTemplate, 120_000);
beforeEach(async () => (db = await freshDb()), 120_000);
afterEach(async () => closeDb(db));

describe("whole-peso cap policy", () => {
  it.each([
    ["legacy 0.009 stays below a 0.01 cap", 0.009, 0, 0.01, false],
    ["legacy 0.01 equals a 0.01 cap", 0.01, 0, 0.01, false],
    ["a half peso rounds up before the cap", 0.5, 0, 0, true],
  ])("keeps invoice, payroll and commission predicates equivalent to SQL: %s", async (_label, paid, incoming, cap, expected) => {
    const sql = await db.query<{ exceeded: boolean }>(
      "SELECT round(($1::numeric + $2::numeric)) > round($3::numeric) AS exceeded",
      [paid, incoming, cap],
    );
    const args = { alreadyPaid: paid, incoming, cap };
    expect(invoicePaymentCapExceeded(args)).toBe(expected);
    expect(payrollPaymentCapExceeded(args)).toBe(expected);
    expect(commissionPayoutCapExceeded(args)).toBe(expected);
    expect(sql.rows[0]?.exceeded).toBe(expected);
  });

  it.each([
    ["legacy 0.009 opening rounds to zero", 0.009, 0, 0, false],
    ["legacy 0.01 opening rounds to zero", 0.01, 0, 0, false],
    ["a half-peso opening base rounds to one before its 50% floor", 0.5, 1, 1, true],
  ])("keeps the 50% cash floor equivalent to SQL: %s", async (_label, opening, expected, amount, breach) => {
    const sql = await db.query<{ breached: boolean }>(
      "SELECT round($2::numeric) - round($3::numeric) < round(round($1::numeric) * 0.5) AS breached",
      [opening, expected, amount],
    );
    const violation = cashOutLimitViolation({
      methodCode: "efectivo",
      openingBase: opening,
      expectedBalance: expected,
      amount,
    });
    expect(violation !== null).toBe(breach);
    expect(sql.rows[0]?.breached).toBe(breach);
  });
});
