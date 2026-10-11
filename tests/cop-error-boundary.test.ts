import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COP_WHOLE_PESO_MESSAGE, copValidationError } from "@/src/shared/money/cop";

/**
 * COP error-boundary fitness test.
 *
 * Migration 005 raises SQLSTATE P0001 with the stable message
 * `COP_WHOLE_PESO_REQUIRED`. Every feature that writes a guarded column owns ONE
 * translator (`<feature>CopValidation`, built on `copValidationError`) and every
 * write that can surface the 005 error must pass through it BEFORE any business
 * P0001 mapping (caps, cash minimums) and before an INTERNAL 500 fallback.
 *
 * The manifest below inventories, per 005 table/column, the service write sites.
 * A site is the `await db.<writer>(` call; the guard reads the error-handling
 * window that follows it and requires the feature translator to appear before
 * the first INTERNAL/business branch. A new writer of a guarded column added to a
 * service without the translator makes `unmappedWriteSites` non-empty.
 */

interface Feature {
  file: string;
  /** Names that count as passing through the translator in this feature. */
  translators: RegExp;
  /** Repository/RPC writers that touch 005-guarded columns (table.column in the note). */
  writers: Array<{ writer: string; covers: string; scope?: string }>;
}

const FEATURES: Record<string, Feature> = {
  cash: {
    file: "src/features/cash/service.ts",
    translators: /throwCashCop\(|toCashError\(|cashCopValidation\(/,
    writers: [
      { writer: "upsertDenomination", covers: "cash_denominations.value" },
      { writer: "openShiftAtomic", covers: "cash_shifts.opening_base, cash_shift_counts.amount (cash_open_shift_atomic)" },
      { writer: "invoicePaymentAtomic", covers: "invoice_payments.amount, payments.amount" },
      { writer: "insertPaymentWithoutInvoice", covers: "payments.amount" },
      { writer: "closeShiftAtomic", covers: "cash_shifts.counted_cash/base_left/cash_withdrawn/base_difference, cash_shift_counts" },
      { writer: "updateRegisterBase", covers: "cash_registers.base_configurada" },
      { writer: "recountShiftAtomic", covers: "cash_shift_recounts.*, cash_shift_counts" },
    ],
  },
  payroll: {
    file: "src/features/payroll/service.ts",
    translators: /throwPayrollCop\(|toPayrollError\(|payrollCopValidation\(/,
    writers: [
      { writer: "applyAtomic", covers: "payroll_items.bonuses/other_discounts, payroll_discount_carries.amount (payroll_apply_atomic)" },
      { writer: "insertPayments", covers: "payroll_payments.amount" },
      { writer: "insertExtra", covers: "payroll_extras.amount" },
      { writer: "correctAtomic", covers: "payroll_period_correction_items.corrected_bonuses/other_discounts" },
      { writer: "upsertSettings", covers: "system_settings voucher_max_per_day/week, voucher_per_day_limits", scope: "const filas = [" },
      { writer: "insertVoucher", covers: "voucher_requests.amount" },
    ],
  },
  commissions: {
    file: "src/features/commissions/service.ts",
    translators: /throwCommissionCop\(|commissionCopValidation\(/,
    writers: [
      { writer: "upsertRule", covers: "commission_rules.amount" },
      { writer: "insertPayout", covers: "commission_payouts.amount" },
    ],
  },
  admin: {
    file: "src/features/admin/service.ts",
    translators: /throwAdminCop\(|adminCopValidation\(/,
    writers: [
      { writer: "upsertEmployeeAtomic", covers: "employees.salary_fixed (upsert_employee_atomic)" },
      { writer: "upsertEmployee", covers: "employees.salary_fixed" },
      { writer: "upsert", covers: "services.price" },
    ],
  },
  inventory: {
    file: "src/features/inventory/service.ts",
    translators: /throwInventoryCop\(|inventoryCopValidation\(/,
    writers: [
      { writer: "upsertProduct", covers: "products.cost_price/sale_price/commission_value" },
    ],
  },
  billing: {
    file: "src/features/billing/service.ts",
    translators: /throwBillingCop\(|billingCopValidation\(|toRpcCreateError\(|toRpcEditError\(|toRpcAnnulError\(|toBillingError\(/,
    writers: [
      { writer: "createInvoiceAtomic", covers: "invoices.discount, invoice_items.unit_price/discount/commission_value, invoice_payments.amount" },
      { writer: "editItemsAtomic", covers: "invoice_items.*" },
      { writer: "editEmittedAtomic", covers: "invoice_items.*" },
      { writer: "splitPaymentAtomic", covers: "invoice_payments.amount, payments.amount" },
    ],
  },
};

/** The first branch that would answer something other than COP validation. */
const BUSINESS_OR_INTERNAL = /"INTERNAL"|"OVERPAID"|"ALREADY_|"SHIFT_|"CASH_OUT|"PERIOD_|"RULE_CONFLICT"|"EMPLOYEE_CODE|"SKU_TAKEN"|cashMethodRuleError\(|code === "P0001"|=== "23505"/;

/**
 * Write sites of `writer` whose error window reaches a business/INTERNAL branch
 * before the translator. Each site returns `writer@line`. The window is the
 * code after the call up to its error handling (bounded at 6000 chars or the
 * next `await db.`/`await repo.` write).
 */
/** Index just past the `)` that closes the call opened at `open` (string-aware). */
function callEnd(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return i + 1;
  }
  return source.length;
}

function unmappedWriteSites(source: string, writer: string, translators: RegExp, scope?: string): string[] {
  const offenders: string[] = [];
  const offset = scope ? Math.max(0, source.indexOf(scope)) : 0;
  const call = new RegExp(String.raw`await (?:db|repo)\.${writer.replace(/[()]/g, "\\$&")}(?:<[^>]*>)?\(`, "g");
  for (const match of source.slice(offset).matchAll(call)) {
    const start = offset + (match.index ?? 0);
    // The error handling starts AFTER the call statement: the payload is not
    // error handling, and a translator in another function does not count.
    const after = callEnd(source, start + match[0].length - 1);
    const rest = source.slice(after, after + 6000);
    const nextWrite = rest.search(/await (?:db|repo)\.\w+(?:<[^>]*>)?\(/);
    const window = nextWrite === -1 ? rest : rest.slice(0, nextWrite);
    const translated = window.search(translators);
    const business = window.search(BUSINESS_OR_INTERNAL);
    if (business !== -1 && (translated === -1 || translated > business)) {
      offenders.push(`${writer}@${source.slice(0, start).split("\n").length}`);
    }
    if (scope) break;
  }
  return offenders;
}

function writeSites(source: string, writer: string): number {
  const call = new RegExp(String.raw`await (?:db|repo)\.${writer.replace(/[()]/g, "\\$&")}(?:<[^>]*>)?\(`, "g");
  return [...source.matchAll(call)].length;
}

describe("COP 005 error boundary: every guarded write passes the feature translator", () => {
  for (const [name, feature] of Object.entries(FEATURES)) {
    const source = readFileSync(join(process.cwd(), feature.file), "utf8");

    it(`${name}: the inventoried writers exist (the manifest is not stale)`, () => {
      for (const { writer } of feature.writers) {
        expect(writeSites(source, writer), `${name}.${writer}`).toBeGreaterThan(0);
      }
    });

    it(`${name}: no guarded write reaches INTERNAL/business P0001 before the COP translator`, () => {
      const offenders = feature.writers.flatMap(({ writer, scope }) => unmappedWriteSites(source, writer, feature.translators, scope));
      expect(offenders).toEqual([]);
    });
  }

  it("negative fixture: a write that skips the translator is reported", () => {
    const regressed = `
      const { data, error } = await db.insertVoucher({ amount });
      if (error || !data) {
        if ((error as { code?: string }).code === "23505") return winner;
        throw new PayrollError("INTERNAL", "Error interno.", 500);
      }`;
    expect(unmappedWriteSites(regressed, "insertVoucher", FEATURES.payroll.translators)).toEqual(["insertVoucher@2"]);

    const fixed = regressed.replace("if (error || !data) {", "if (error || !data) {\n        throwPayrollCop(error);");
    expect(unmappedWriteSites(fixed, "insertVoucher", FEATURES.payroll.translators)).toEqual([]);
  });

  it("explicitly inventories the eight review routes", () => {
    const payroll = readFileSync(join(process.cwd(), FEATURES.payroll.file), "utf8");
    const cash = readFileSync(join(process.cwd(), FEATURES.cash.file), "utf8");
    for (const marker of [
      "export async function calculatePayroll",
      "export async function correctPayrollPeriod",
      "export async function setVoucherLimits",
      "export async function payPayrollExtra",
      "export async function requestVoucher",
    ]) {
      const start = payroll.indexOf(marker);
      expect(start, marker).toBeGreaterThanOrEqual(0);
      expect(payroll.slice(start, start + 18_000), marker).toContain("throwPayrollCop(");
    }
    for (const marker of ["export async function openShift", "export async function closeShift", "export async function recountClosedShift"]) {
      const start = cash.indexOf(marker);
      expect(start, marker).toBeGreaterThanOrEqual(0);
      expect(cash.slice(start, start + 18_000), marker).toContain("throwCashCop(");
    }
  });

  it("negative fixture: a translator placed AFTER a business P0001 branch is still reported", () => {
    const late = `
      const { data, error } = await db.insertExtra({ amount });
      if (error) {
        if ((error as { code?: string }).code === "P0001") throw new PayrollError("OVERPAID", "x", 422);
        throwPayrollCop(error);
      }`;
    expect(unmappedWriteSites(late, "insertExtra", FEATURES.payroll.translators)).toEqual(["insertExtra@2"]);
  });
});

/**
 * Behavioral contract of the shared translator every feature builds on: the
 * 005 error becomes the feature's validation error; anything else returns null
 * so the feature's existing mapping (business code or INTERNAL) still answers.
 */
describe("copValidationError: the shared feature-boundary contract", () => {
  const make = () => ({ code: "VALIDATION", status: 400, message: COP_WHOLE_PESO_MESSAGE });
  const SHAPES: Array<[string, unknown]> = [
    ["supabase-js/PostgREST error", { code: "P0001", message: "COP_WHOLE_PESO_REQUIRED", details: "services.price" }],
    ["DbQueryError (normalized in .error)", { name: "DbQueryError", message: "COP_WHOLE_PESO_REQUIRED", error: { code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" } }],
    ["Drizzle wrapper with driver cause", { message: "Failed query: insert ...", cause: { code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" } }],
  ];

  it.each(SHAPES)("%s → 400 VALIDATION", (_shape, error) => {
    expect(copValidationError(error, make)).toEqual({ code: "VALIDATION", status: 400, message: COP_WHOLE_PESO_MESSAGE });
  });

  it.each<[string, unknown]>([
    ["business P0001 (cash minimum)", { code: "P0001", message: "CASH_METHOD_MINIMUM_BREACH" }],
    ["payroll cap P0001", { code: "P0001", message: "El pago supera el neto del ítem" }],
    ["unique violation", { code: "23505", message: "duplicate key" }],
    ["check violation", { code: "23514", message: "check" }],
    ["no error", null],
  ])("%s → null (the feature's own mapping keeps answering)", (_shape, error) => {
    expect(copValidationError(error, make)).toBeNull();
  });
});
