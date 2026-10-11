import { z } from "zod";

/**
 * COP money policy: every amount is handled in WHOLE pesos.
 *
 * - Input is parsed strictly: plain decimal digits only (`"1500"`, `"1500.5"`,
 *   or a finite number). Exponential (`1e3`), hexadecimal (`0x10`), signs,
 *   `NaN` and `Infinity` are rejected.
 * - A decimal input is ROUNDED (half-up, `Math.round`) to the nearest peso, not
 *   rejected.
 * - Percentages are NOT money and never go through this module.
 *
 * This is the single home of COP input parsing; feature schemas must use
 * `copSchema` / `positiveCopSchema` for money fields (guarded by
 * tests/cop-money-architecture.test.ts).
 */
const COP_LITERAL = /^\d+(?:\.\d+)?$/;

/** Strict COP parser. Returns null for anything that is not a plain non-negative decimal. */
export function parseCop(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!COP_LITERAL.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rounds a COP amount to the nearest whole peso (half-up for positives). */
export function roundCop(value: number): number {
  return Math.round(value);
}

/**
 * Whole-peso hydration of a stored amount for an editable money input: a legacy
 * `numeric(12,2)` such as `"12345.50"` must become `"12346"`, never the digits
 * `"1234550"` that a digits-only mask would leave.
 */
export function copInputDigits(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const parsed = parseCop(value);
  return parsed === null ? "" : String(roundCop(parsed));
}

/** True when two COP amounts are the same whole peso (legacy cents compare rounded). */
export function copEquals(a: number, b: number): boolean {
  return roundCop(a) === roundCop(b);
}

/**
 * True when `amount` exceeds `limit` by at least one whole peso. Caps and
 * overpay guards compare rounded pesos; a legacy value with cents is rounded
 * before the comparison (the database triggers stay the authority for races).
 */
export function copExceeds(amount: number, limit: number): boolean {
  return roundCop(amount) > roundCop(limit);
}

/** Stable message of migration 005 (SQLSTATE P0001) for a non-whole-peso write. */
export const COP_WHOLE_PESO_REQUIRED = "COP_WHOLE_PESO_REQUIRED";
export const COP_WHOLE_PESO_MESSAGE = "Los montos en pesos deben ser enteros, sin centavos.";

/**
 * True when a database error (supabase-js, Drizzle/PGlite wrapper or raw
 * driver error) is the 005 whole-peso rejection. Services translate it to a
 * 400 validation error instead of a 500.
 */
export function isCopWholePesoError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const candidate = current as { message?: unknown; error?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && candidate.message.includes(COP_WHOLE_PESO_REQUIRED)) return true;
    current = candidate.error ?? candidate.cause;
  }
  return false;
}

interface CopMessages {
  /** Message for an invalid or negative input. */
  invalid: string;
  /** Message for a missing/empty input; defaults to `invalid`. */
  required?: string;
}

function copValue(messages: CopMessages) {
  // A typed (non-`unknown`) base keeps `.optional()` / `.nullish()` / `.default()`
  // short-circuiting absent values instead of feeding them to the transform.
  return z.union([z.number(), z.string()], { error: messages.required ?? messages.invalid }).transform((value, context) => {
    if (typeof value === "string" && value.trim() === "") {
      context.addIssue({ code: "custom", message: messages.required ?? messages.invalid });
      return z.NEVER;
    }
    const parsed = parseCop(value);
    if (parsed === null) {
      context.addIssue({ code: "custom", message: messages.invalid });
      return z.NEVER;
    }
    return roundCop(parsed);
  });
}

/** Non-negative COP input: strictly parsed, then rounded to the nearest peso. */
export function copSchema(invalid: string, required?: string) {
  return copValue({ invalid, required });
}

/**
 * Positive COP input. The value is rounded FIRST, so a sub-peso input such as
 * `0.4` rounds to 0 and is rejected with the positive-amount message.
 */
export function positiveCopSchema(positive: string, required?: string) {
  return copValue({ invalid: positive, required }).refine((value) => value > 0, positive);
}
