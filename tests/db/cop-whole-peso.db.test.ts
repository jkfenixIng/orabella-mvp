import { afterEach, describe, expect, it } from "vitest";
import { applyFile, buildSchemaDb, closeDb, one, pgError, rpc, type Db } from "./harness";
import { createInvoiceCall, insertEmployee, insertUser, openShift, registerId } from "./fixtures";

let db: Db | undefined;
const before005 = ["001_orabella_schema.sql", "002_portable_platform.sql", "003_payment_method_arqueo.sql", "004_inventory_literal_search.sql"]
  .map((name) => `supabase/migrations/${name}`);

async function legacyThen005(): Promise<Db> {
  db = await buildSchemaDb({ catalog: true, migrations: before005 });
  await db.query("INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('Legacy', 10.50, 1, 1)");
  await applyFile(db, "supabase/migrations/005_cop_whole_peso.sql");
  await applyFile(db, "supabase/migrations/005_cop_whole_peso.sql");
  return db;
}

afterEach(async () => closeDb(db));

describe("005 COP whole-peso migration", () => {
  it("is idempotent; rejects new cents and preserves legacy cents on non-money updates", async () => {
    const current = await legacyThen005();
    expect(await pgError(current.query("INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('New', 10.50, 1, 1)"))).toMatchObject({ code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" });
    await current.query("UPDATE public.services SET is_active = false WHERE name = 'Legacy'");
    expect(await one<{ price: string; is_active: boolean }>(current, "SELECT price::text, is_active FROM public.services WHERE name = 'Legacy'")).toEqual({ price: "10.50", is_active: false });
  });

  it("covers direct-money tables while leaving derived fee fields outside the guard", async () => {
    const current = await legacyThen005();
    for (const sql of [
      "INSERT INTO public.cash_denominations (kind, value) VALUES ('moneda', 10.5)",
      "UPDATE public.cash_registers SET base_configurada = 10.5",
      "INSERT INTO public.products (sku, name, cost_price) VALUES ('D', 'Decimal product', 10.5)",
      "INSERT INTO public.voucher_settings (max_per_day) VALUES (10.5)",
      "INSERT INTO public.system_settings (key, value) VALUES ('voucher_max_per_day', '{\"amount\":10.5}')",
    ]) expect(await pgError(current.query(sql))).toMatchObject({ code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" });
    expect((await current.query<{ n: number }>("SELECT count(*)::int n FROM information_schema.triggers WHERE trigger_name = 'trg_cop_whole_peso'")).rows[0].n).toBeGreaterThan(15);
  });

  it("audits every legacy numeric(12,2) column and reports services.price", async () => {
    const current = await legacyThen005();
    expect(await one<{ row_count: number }>(current, "SELECT row_count::int FROM public.cop_legacy_cents_audit WHERE table_name = 'services' AND column_name = 'price'")).toEqual({ row_count: 1 });
  });

  it("charges a legacy-cent invoice with a whole-peso payment and closes it", async () => {
    const current = await legacyThen005();
    const user = await insertUser(current);
    const employee = await insertEmployee(current);
    const shift = await openShift(current, await registerId(current), user);
    const invoice = (await createInvoiceCall(current, { user, shift, employee })).id as string;
    await current.query("UPDATE public.invoices SET surcharge = 0.50, total = total + 0.50 WHERE id = $1", [invoice]);
    const result = await rpc<{ invoice: { status: string } }>(
      current,
      "invoice_split_payment_atomic",
      [invoice, shift, user, new Date().toISOString(), true, JSON.stringify([{ method_id: null, method_code: "efectivo", amount: 10000, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: "e0000000-0000-4000-8000-000000000001" }])],
      ["uuid", "uuid", "uuid", "timestamptz", "boolean", "jsonb"],
    );
    expect(result.invoice.status).toBe("Pagada");
    expect((await one<{ amount: string }>(current, "SELECT amount::text FROM public.invoice_payments WHERE invoice_id = $1", [invoice])).amount).toBe("10000.00");
  });
});
