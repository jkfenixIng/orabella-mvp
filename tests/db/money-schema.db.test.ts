import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";

const MONEY_TABLES = [
  schema.cashDenominations, schema.cashRegisters, schema.cashShifts, schema.cashShiftCounts, schema.cashShiftRecounts, schema.cashShiftMethodBalances, schema.payments,
  schema.invoices, schema.invoiceItems, schema.invoiceTaxes, schema.invoicePayments, schema.commissionRules, schema.commissionPayouts,
  schema.payrollPeriods, schema.payrollItems, schema.payrollPayments, schema.payrollExtras, schema.voucherRequests, schema.payrollDiscountCarries,
  schema.payrollPeriodCorrections, schema.payrollPeriodCorrectionItems, schema.systemSettings,
] as PgTable[];

let db: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => (db = await freshDb()), DB_HOOK_TIMEOUT);
afterEach(async () => closeDb(db));

describe("shared money schemas", () => {
  it("declare only real columns with their 001-004 PostgreSQL types", async () => {
    const declared = MONEY_TABLES.flatMap((table) => {
      const config = getTableConfig(table);
      return config.columns.map((column) => `${config.name}.${column.name}:${column.getSQLType().replace(/\(.*\)/, "").replace("timestamp with time zone", "timestamptz")}`);
    });
    const { rows } = await db.query<{ column: string }>(
      `SELECT table_name || '.' || column_name || ':' || CASE udt_name WHEN 'timestamptz' THEN 'timestamptz' WHEN 'int4' THEN 'integer' WHEN 'bool' THEN 'boolean' ELSE udt_name END AS column
         FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Set(rows.map((row) => row.column));
    expect(declared.filter((column) => !actual.has(column))).toEqual([]);
  });
});
