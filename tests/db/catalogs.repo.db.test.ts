import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleCatalogsRepo } from "@/src/features/admin/repos/catalogs.drizzle";
import { supabaseCatalogsRepo, type CatalogsRepo } from "@/src/features/admin/repos/catalogs";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { postgrestDouble } from "./postgrest-double";

const ID = "00000000-0000-4000-8000-000000000001";
const METHOD_ID = "00000000-0000-4000-8000-000000000002";
let pg: Db; let db: Database;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => { pg = await freshDb(); db = drizzle({ client: pg, schema }) as unknown as Database; }, DB_HOOK_TIMEOUT);
afterEach(() => closeDb(pg));

async function outcome(run: () => Promise<unknown>) {
  try { return { value: await run() }; } catch (error) { if (!(error instanceof DbQueryError)) throw error; return { error: error.error.code }; }
}

interface Case { name: string; run(repo: CatalogsRepo): Promise<unknown>; }

/** Generated ids differ per instance: blank them before comparing. */
const blankId = (value: unknown) =>
  value && typeof value === "object" && "id" in value && value.id !== ID && value.id !== METHOD_ID
    ? { ...value, id: "<generated>" }
    : value;

const CASES: Case[] = [
  { name: "taxes sorted by code, numeric as number", run: (repo) => repo.listTaxes(50) },
  { name: "payment methods sorted by code, honoring the limit", run: (repo) => repo.listPaymentMethods(3) },
  { name: "employees sorted by name", run: (repo) => repo.listEmployees(50) },
  { name: "employee pages use full_name then id and the exact range", run: async (repo) => [await repo.employeesPage(0, 1), await repo.employeesPage(2, 3)] },
  { name: "tax insert keeps the database default is_active", run: async (repo) => blankId(await repo.upsertTax({ code: "otro", name: "Otro", percent: 10.5 })) },
  { name: "tax update by id without is_active keeps it", run: (repo) => repo.upsertTax({ id: ID, code: "IVA", name: "IVA 2", percent: 5 }) },
  { name: "tax CHECK violation is 23514", run: (repo) => repo.upsertTax({ code: "IVA", name: "Mal", percent: 101 }) },
  { name: "payment insert lets 003 derive arqueable from the mode", run: async (repo) => blankId(await repo.insertPaymentMethod({ code: "billetera", name: "Billetera", arqueo_mode: "declared_total", fee_percent: 1.25 })) },
  { name: "payment duplicate code is 23505", run: (repo) => repo.insertPaymentMethod({ code: "zeta", name: "Otra", arqueo_mode: "none" }) },
  { name: "payment bad code format is 23514", run: (repo) => repo.insertPaymentMethod({ code: "Bad Code", name: "X", arqueo_mode: "none" }) },
  { name: "second denominations method is 23505 (unique index of 003)", run: (repo) => repo.updatePaymentMethod(METHOD_ID, { name: "Zeta", arqueo_mode: "denominations" }) },
  { name: "payment update writes only the given fields", run: (repo) => repo.updatePaymentMethod(METHOD_ID, { name: "Zeta 2", fee_percent: 2.5 }) },
  { name: "payment update of a missing id is PGRST116 (single)", run: (repo) => repo.updatePaymentMethod("00000000-0000-4000-8000-000000000099", { name: "X" }) },
  { name: "payment maybeSingle finds the code", run: (repo) => repo.findPaymentMethod(METHOD_ID) },
  { name: "employee by id (numeric as number, civil date as text)", run: (repo) => repo.findEmployee("00000000-0000-4000-8000-0000000000e2") },
  { name: "employee by id: maybeSingle null", run: (repo) => repo.findEmployee("00000000-0000-4000-8000-000000000099") },
  { name: "payment maybeSingle null", run: (repo) => repo.findPaymentMethod("00000000-0000-4000-8000-000000000099") },
];

async function seed(instance: Db) {
  await instance.query(`INSERT INTO public.tax_configs (id, code, name, percent, is_active) VALUES ($1, 'IVA', 'IVA', 19.25, true)`, [ID]);
  await instance.query(`INSERT INTO public.payment_methods (id, code, name, arqueo_mode) VALUES ($1, 'zeta', 'Zeta', 'none')`, [METHOD_ID]);
  await instance.query(`INSERT INTO public.employees (id, full_name, document, pay_type, salary_fixed, commission_percent, birth_date)
    VALUES ('00000000-0000-4000-8000-0000000000e2', 'Beto', '2', 'mixto', 1234.5, 7.25, '1990-02-03'),
           ('00000000-0000-4000-8000-0000000000e1', 'Ana', '1', 'fijo', NULL, NULL, NULL),
           ('00000000-0000-4000-8000-0000000000e4', 'Beto', '4', 'fijo', NULL, NULL, NULL),
           ('00000000-0000-4000-8000-0000000000e3', 'Beto', '3', 'fijo', NULL, NULL, NULL)`);
}

describe("admin catalogs repository: equivalence supabase-js ↔ drizzle", () => {
  // Each adapter gets its own fresh instance with the same seed, so a write
  // case starts from the same state on both sides.
  it.each(CASES)("$name", async ({ run }) => {
    const other = await freshDb();
    try {
      await seed(pg);
      await seed(other);
      const viaPostgrest = await outcome(() => run(supabaseCatalogsRepo(postgrestDouble(other))));
      const viaDrizzle = await outcome(() => run(drizzleCatalogsRepo(db)));
      expect(viaDrizzle).toEqual(viaPostgrest);
    } finally {
      await closeDb(other);
    }
  });
});

describe("admin catalogs drizzle repository", () => {
  it("uses numeric number mode for every catalog money/percentage field", async () => {
    await seed(pg);
    const repo = drizzleCatalogsRepo(db);
    expect(typeof (await repo.listTaxes(1))[0]?.percent).toBe("number");
    expect(typeof (await repo.listPaymentMethods(1))[0]?.fee_percent).toBe("number");
    const [, employee] = await repo.listEmployees(2);
    expect([typeof employee.salary_fixed, typeof employee.commission_percent]).toEqual(["number", "number"]);
  });

  it("lets the 003 trigger reject an immutable code with its SQLSTATE and message", async () => {
    await seed(pg);
    const { rows } = await pg.query<{ id: string }>(`SELECT id FROM public.payment_methods WHERE code = 'zeta'`);
    const error = await pg.query(`UPDATE public.payment_methods SET code = 'other' WHERE id = $1`, [rows[0].id]).then(
      () => { throw new Error("expected error"); }, (reason) => reason,
    );
    expect((error as { code?: string; message?: string }).code).toBe("P0001");
    expect((error as { message?: string }).message).toContain("PAYMENT_METHOD_CODE_IMMUTABLE");
  });
});
