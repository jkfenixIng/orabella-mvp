import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, MIGRATIONS_DIR, closeDb, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { createInvoiceCall, insertEmployee, insertUser, methodId, registerId } from "./fixtures";

let db: Db;
let user: string;
let employee: string;
let register: string;

const ALL_METHODS = [
  { code: "efectivo", amount: 200000, denomination: 10000 },
  { code: "transferencia_normal", amount: 0 },
  { code: "nequi", amount: 0 },
  { code: "daviplata", amount: 0 },
  { code: "bre-b", amount: 0 },
  { code: "tarjeta", amount: 0 },
];

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
  employee = await insertEmployee(db);
  register = await registerId(db);
}, DB_HOOK_TIMEOUT);
afterEach(async () => closeDb(db));

async function openWithBalances(entries: Array<{ code: string; amount: number; denomination?: number }>) {
  return rpc<{ id: string }>(
    db,
    "cash_open_shift_atomic",
    [register, user, 200000, JSON.stringify(entries.map((entry) => ({
      method_code: entry.code,
      denomination: entry.denomination ?? null,
      quantity: entry.denomination ? entry.amount / entry.denomination : 1,
      amount: entry.amount,
    })))],
    ["uuid", "uuid", "numeric", "jsonb"],
  );
}

async function insertCommission(shift: string, code: string, amount: number) {
  const invoice = (await createInvoiceCall(db, { user, shift, employee })).id as string;
  await db.query(`UPDATE public.invoices SET status = 'Pagada', closed_by = $2, closed_at = now() WHERE id = $1`, [invoice, user]);
  return db.query(
    `INSERT INTO public.commission_payouts
      (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, earned_immediate, amount, paid_by)
     VALUES ($1, $2, $3, $4, 1000000, 1000000, $5, $6)`,
    [employee, invoice, shift, code, amount, user],
  );
}

async function insertVoucher(shift: string, code: string, amount: number, status = "aprobada") {
  return db.query(
    `INSERT INTO public.voucher_requests
      (employee_id, amount, status, approved_by, method_code, cash_shift_id)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'aprobada' THEN $4::uuid ELSE NULL END, $5, $6)`,
    [employee, amount, status, user, code, shift],
  );
}

describe("003 payment method arqueo", () => {
  it("forces inactive methods to none through 008 and the coherence constraint", async () => {
    await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'nequi'`);
    await db.query(`UPDATE public.payment_methods SET is_active = false WHERE code = 'nequi'`);
    expect(await one<{ arqueable: boolean; arqueo_mode: string }>(db, `SELECT arqueable, arqueo_mode FROM public.payment_methods WHERE code = 'nequi'`))
      .toEqual({ arqueable: false, arqueo_mode: "none" });
    await db.query("SET session_replication_role = replica");
    const error = await pgError(db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'nequi'`));
    await db.query("SET session_replication_role = origin");
    expect(error.code).toBe("23514");
  });

  it("backfills current arqueable methods and accepts a free normalized code that cannot change", async () => {
    const modes = await db.query<{ code: string; arqueable: boolean; arqueo_mode: string }>(
      `SELECT code, arqueable, arqueo_mode FROM public.payment_methods ORDER BY code`,
    );
    expect(modes.rows.find((row) => row.code === "efectivo")).toMatchObject({ arqueable: true, arqueo_mode: "denominations" });
    expect(modes.rows.find((row) => row.code === "nequi")).toMatchObject({ arqueable: true, arqueo_mode: "declared_total" });

    const created = await one<{ id: string; code: string }>(db,
      `INSERT INTO public.payment_methods (code, name, arqueo_mode) VALUES ('billetera-qr_1', 'Billetera QR', 'none') RETURNING id, code`);
    expect(created.code).toBe("billetera-qr_1");
    expect((await pgError(db.query(`UPDATE public.payment_methods SET code = 'otro-codigo' WHERE id = $1`, [created.id]))).message)
      .toContain("PAYMENT_METHOD_CODE_IMMUTABLE");
    expect((await pgError(db.query(`INSERT INTO public.payment_methods (code, name, arqueo_mode) VALUES ('MALO', 'Malo', 'none')`))).code)
      .toBe("23514");
  });

  it("keeps arqueable coherent with arqueo_mode", async () => {
    const id = await methodId(db, "nequi");
    await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'none' WHERE id = $1`, [id]);
    expect(await one<{ arqueable: boolean }>(db, `SELECT arqueable FROM public.payment_methods WHERE id = $1`, [id])).toEqual({ arqueable: false });
    await db.query(`UPDATE public.payment_methods SET arqueable = true WHERE id = $1`, [id]);
    expect(await one<{ arqueable: boolean; arqueo_mode: string }>(db, `SELECT arqueable, arqueo_mode FROM public.payment_methods WHERE id = $1`, [id]))
      .toEqual({ arqueable: true, arqueo_mode: "declared_total" });
  });

  it("creates one frozen balance per active arqueable method and none for non-arqueable", async () => {
    const nequi = await methodId(db, "nequi");
    await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'none' WHERE id = $1`, [nequi]);
    const shift = await openWithBalances([{ code: "efectivo", amount: 200000, denomination: 10000 }, { code: "transferencia_normal", amount: 0 }, { code: "daviplata", amount: 0 }, { code: "bre-b", amount: 0 }, { code: "tarjeta", amount: 0 }]);
    const balances = await db.query<{ method_code: string; opening_base: number }>(
      `SELECT method_code, opening_base FROM public.cash_shift_method_balances WHERE cash_shift_id = $1 ORDER BY method_code`, [shift.id]);
    expect(balances.rows).toHaveLength(5);
    expect(Number(balances.rows.find((row) => row.method_code === "efectivo")?.opening_base)).toBe(200000);
    expect(balances.rows.some((row) => row.method_code === "nequi")).toBe(false);
  });

  it("uses balance, not cumulative withdrawals: collections replenish the available amount", async () => {
    const shift = await openWithBalances([{ code: "efectivo", amount: 200000, denomination: 10000 }, { code: "transferencia_normal", amount: 0 }, { code: "nequi", amount: 0 }, { code: "daviplata", amount: 0 }, { code: "bre-b", amount: 0 }, { code: "tarjeta", amount: 0 }]);
    await insertCommission(shift.id, "efectivo", 100000);
    await db.query(`INSERT INTO public.payments (cash_shift_id, method_id, method_code, amount, user_id) VALUES ($1, $2, 'efectivo', 60000, $3)`, [shift.id, await methodId(db, "efectivo"), user]);
    await insertVoucher(shift.id, "efectivo", 60000);
    const balance = await one<{ expected: number }>(db, `SELECT public.cash_shift_method_expected_balance($1, 'efectivo') AS expected`, [shift.id]);
    expect(Number(balance.expected)).toBe(100000);
  });

  it("allows exactly the floor and rejects below it across commission plus voucher sequentially", async () => {
    const shift = await openWithBalances([{ code: "efectivo", amount: 200000, denomination: 10000 }, { code: "transferencia_normal", amount: 0 }, { code: "nequi", amount: 0 }, { code: "daviplata", amount: 0 }, { code: "bre-b", amount: 0 }, { code: "tarjeta", amount: 0 }]);
    await insertCommission(shift.id, "efectivo", 60000);
    await insertVoucher(shift.id, "efectivo", 40000);
    const commissionFailure = await pgError(insertCommission(shift.id, "efectivo", 1));
    expect(commissionFailure.message).toContain("CASH_METHOD_MINIMUM_BREACH");
    const voucherFailure = await pgError(insertVoucher(shift.id, "efectivo", 1));
    expect(voucherFailure.message).toContain("CASH_METHOD_MINIMUM_BREACH");
  });

  it("does not apply the rule to payroll payments, payroll extras or the payroll voucher discount", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    // The floor is already reached: any new commission/voucher would breach.
    await insertCommission(shift.id, "efectivo", 100000);
    const period = await one<{ id: string }>(db,
      `INSERT INTO public.payroll_periods (start_date, end_date) VALUES ('2026-01-01', '2026-01-31') RETURNING id`);
    const item = await one<{ id: string }>(db,
      `INSERT INTO public.payroll_items (period_id, employee_id, base_fixed, net_pay) VALUES ($1, $2, 900000, 900000) RETURNING id`,
      [period.id, employee]);
    await db.query(`INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount, paid_by) VALUES ($1, 'efectivo', 900000, $2)`, [item.id, user]);
    await db.query(
      `INSERT INTO public.payroll_extras (employee_id, amount, method_code, reason, kind, paid_by) VALUES ($1, 500000, 'efectivo', 'Liquidación', 'otro', $2)`,
      [employee, user]);
    // An approved voucher already inside the balance can go to 'descontada'.
    await db.query(`UPDATE public.cash_shift_method_balances SET opening_base = 400000 WHERE cash_shift_id = $1 AND method_code = 'efectivo'`, [shift.id]);
    const voucher = await one<{ id: string }>(db,
      `INSERT INTO public.voucher_requests (employee_id, amount, status, approved_by, method_code, cash_shift_id) VALUES ($1, 10000, 'aprobada', $2, 'efectivo', $3) RETURNING id`,
      [employee, user, shift.id]);
    await db.query(`UPDATE public.cash_shift_method_balances SET opening_base = 1000000 WHERE cash_shift_id = $1 AND method_code = 'efectivo'`, [shift.id]);
    await db.query(`UPDATE public.voucher_requests SET status = 'descontada' WHERE id = $1`, [voucher.id]);
    expect(await one<{ status: string }>(db, `SELECT status FROM public.voucher_requests WHERE id = $1`, [voucher.id]))
      .toEqual({ status: "descontada" });
  });

  it("a pending or rejected voucher never affects the balance; approved -> rejected is explicitly forbidden", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    // A rejected row that still names an approver would make 001's close token
    // (approved_by + method) disagree with the balance: it cannot be written.
    expect((await pgError(db.query(
      `INSERT INTO public.voucher_requests (employee_id, amount, status, approved_by, method_code, cash_shift_id) VALUES ($1, 50000, 'rechazada', $2, 'efectivo', $3)`,
      [employee, user, shift.id]))).message).toBe("VOUCHER_CASH_OUT_IMMUTABLE");
    await db.query(`INSERT INTO public.voucher_requests (employee_id, amount, status, method_code, cash_shift_id) VALUES ($1, 50000, 'rechazada', 'efectivo', $2)`, [employee, shift.id]);
    await db.query(`INSERT INTO public.voucher_requests (employee_id, amount, status, method_code, cash_shift_id) VALUES ($1, 50000, 'pendiente', 'efectivo', $2)`, [employee, shift.id]);
    const balance = async () =>
      Number((await one<{ expected: number }>(db, `SELECT public.cash_shift_method_expected_balance($1, 'efectivo') AS expected`, [shift.id])).expected);
    expect(await balance()).toBe(200000);

    const approved = await one<{ id: string }>(db,
      `INSERT INTO public.voucher_requests (employee_id, amount, status, approved_by, method_code, cash_shift_id) VALUES ($1, 50000, 'aprobada', $2, 'efectivo', $3) RETURNING id`,
      [employee, user, shift.id]);
    await insertCommission(shift.id, "efectivo", 50000);
    expect(await balance()).toBe(100000);
    expect((await pgError(insertCommission(shift.id, "efectivo", 1))).message).toBe("CASH_METHOD_MINIMUM_BREACH");

    // The domain has no approved -> rejected transition: a direct UPDATE is
    // rejected, so the approved outflow keeps counting and nothing is freed.
    const rejected = await pgError(db.query(`UPDATE public.voucher_requests SET status = 'rechazada' WHERE id = $1`, [approved.id]));
    expect(rejected.message).toBe("VOUCHER_CASH_OUT_IMMUTABLE");
    expect(await one<{ status: string }>(db, `SELECT status FROM public.voucher_requests WHERE id = $1`, [approved.id]))
      .toEqual({ status: "aprobada" });
    expect(await balance()).toBe(100000);
    // The payroll path (aprobada -> descontada -> aprobada) stays legal and counted.
    await db.query(`UPDATE public.voucher_requests SET status = 'descontada' WHERE id = $1`, [approved.id]);
    expect(await balance()).toBe(100000);
    await db.query(`UPDATE public.voucher_requests SET status = 'aprobada' WHERE id = $1`, [approved.id]);
    expect(await balance()).toBe(100000);
  });

  it("approving a pending voucher counts it; a pending one that stays pending never counts", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    const pending = await one<{ id: string }>(db,
      `INSERT INTO public.voucher_requests (employee_id, amount, status, method_code, cash_shift_id) VALUES ($1, 40000, 'pendiente', 'efectivo', $2) RETURNING id`,
      [employee, shift.id]);
    const balance = async () =>
      Number((await one<{ expected: number }>(db, `SELECT public.cash_shift_method_expected_balance($1, 'efectivo') AS expected`, [shift.id])).expected);
    expect(await balance()).toBe(200000);
    await db.query(`UPDATE public.voucher_requests SET status = 'aprobada', approved_by = $2 WHERE id = $1`, [pending.id, user]);
    expect(await balance()).toBe(160000);
  });

  it("rejects a moved invoice collection when the source method would fall below its floor and rolls back", async () => {
    const entries = ALL_METHODS.map((entry) => entry.code === "nequi" ? { ...entry, amount: 200000 } : entry);
    const shift = await openWithBalances(entries);
    const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
    await db.query(`UPDATE public.invoices SET subtotal = 500000, total = 500000 WHERE id = $1`, [invoice]);
    const payment = await one<{ id: string }>(db,
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'nequi', 100000, $2) RETURNING id`,
      [invoice, shift.id]);
    await insertCommission(shift.id, "nequi", 150000);
    const before = await db.query<{ method_code: string; expected: number }>(
      `SELECT code AS method_code, public.cash_shift_method_expected_balance($1, code) AS expected FROM public.payment_methods WHERE code IN ('nequi', 'efectivo') ORDER BY code`, [shift.id]);

    const failure = await pgError(db.query(`UPDATE public.invoice_payments SET method_code = 'efectivo' WHERE id = $1`, [payment.id]));
    expect(failure.message).toBe("CASH_METHOD_BALANCE_UPDATE_BREACH");
    expect(await one<{ method_code: string }>(db, `SELECT method_code FROM public.invoice_payments WHERE id = $1`, [payment.id]))
      .toEqual({ method_code: "nequi" });
    const after = await db.query<{ method_code: string; expected: number }>(
      `SELECT code AS method_code, public.cash_shift_method_expected_balance($1, code) AS expected FROM public.payment_methods WHERE code IN ('nequi', 'efectivo') ORDER BY code`, [shift.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it("permits a method move that preserves both method floors", async () => {
    const entries = ALL_METHODS.map((entry) => entry.code === "nequi" ? { ...entry, amount: 200000 } : entry);
    const shift = await openWithBalances(entries);
    const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
    await db.query(`UPDATE public.invoices SET subtotal = 500000, total = 500000 WHERE id = $1`, [invoice]);
    const payment = await one<{ id: string }>(db,
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'nequi', 100000, $2) RETURNING id`,
      [invoice, shift.id]);
    await insertCommission(shift.id, "nequi", 100000);
    await db.query(`UPDATE public.invoice_payments SET method_code = 'efectivo' WHERE id = $1`, [payment.id]);
    expect(await one<{ method_code: string }>(db, `SELECT method_code FROM public.invoice_payments WHERE id = $1`, [payment.id]))
      .toEqual({ method_code: "efectivo" });
    expect(Number((await one<{ expected: number }>(db, `SELECT public.cash_shift_method_expected_balance($1, 'nequi') AS expected`, [shift.id])).expected)).toBe(100000);
  });

  it("a direct UPDATE of a drawer payment cannot drain a method below its floor", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    const drawer = await one<{ id: string }>(db,
      `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 100000, $2) RETURNING id`,
      [shift.id, user]);
    await insertCommission(shift.id, "efectivo", 200000);
    for (const change of [
      `UPDATE public.payments SET amount = 50000 WHERE id = $1`,
      `UPDATE public.payments SET method_code = 'nequi' WHERE id = $1`,
    ]) {
      expect((await pgError(db.query(change, [drawer.id]))).message).toBe("CASH_METHOD_BALANCE_UPDATE_BREACH");
    }
    expect(await one<{ method_code: string; amount: string }>(db, `SELECT method_code, amount::text FROM public.payments WHERE id = $1`, [drawer.id]))
      .toEqual({ method_code: "efectivo", amount: "100000.00" });
  });

  it("the real invoice edit RPC keeps working when it rewrites a payment with the same method", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
    const payment = await one<{ id: string }>(db,
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`,
      [invoice, shift.id]);
    await insertCommission(shift.id, "efectivo", 110000);
    // Same method: a neutral rewrite, allowed even with the method at its floor.
    await rpc(db, "invoice_edit_items_atomic", [invoice, user, 0, "Emitida", JSON.stringify({
      items_remove: [], items_update: [], items_insert: [],
      payments: [{ id: payment.id, method_code: "efectivo", method_id: null }],
      movements: [],
    })], ["uuid", "uuid", "integer", "text", "jsonb"]);
    expect(await one<{ method_code: string }>(db, `SELECT method_code FROM public.invoice_payments WHERE id = $1`, [payment.id]))
      .toEqual({ method_code: "efectivo" });
  });

  it("the invoice edit wrappers lock shifts and balances before their legacy invoice lock", async () => {
    for (const name of ["invoice_edit_items_atomic", "invoice_edit_emitted_atomic"]) {
      const wrapper = await one<{ definition: string; owner: string; service: boolean; anon: boolean }>(db, `
        SELECT pg_get_functiondef(p.oid) AS definition,
               pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
          FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.${name}(uuid,uuid,integer,text,jsonb)')
      `);
      const legacy = await one<{ definition: string; owner: string }>(db, `
        SELECT pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.${name}_legacy(uuid,uuid,integer,text,jsonb)')
      `);
      expect(wrapper.definition).toContain("lock_invoice_edit_payment_balances");
      expect(wrapper.definition.indexOf("lock_invoice_edit_payment_balances"))
        .toBeLessThan(wrapper.definition.indexOf(`${name}_legacy`));
      expect(legacy.definition).toContain("FOR UPDATE OF i");
      expect(wrapper.owner).toBe(legacy.owner);
      expect(wrapper.service).toBe(true);
      expect(wrapper.anon).toBe(false);
    }
    const helper = await one<{ definition: string }>(db, `
      SELECT pg_get_functiondef('public.lock_invoice_edit_payment_balances(uuid,jsonb)'::regprocedure) AS definition
    `);
    expect(helper.definition.indexOf("public.cash_shifts")).toBeLessThan(helper.definition.indexOf("public.cash_shift_method_balances"));
    expect(helper.definition).toContain("ORDER BY s.id FOR SHARE OF s");
    expect(helper.definition).toContain("ORDER BY b.cash_shift_id, b.method_code FOR UPDATE OF b");
  });

  it("counts invoice collections of the shift and checks a pending voucher again when it is approved", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
    await db.query(
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 10000, $2)`,
      [invoice, shift.id]);
    await insertCommission(shift.id, "efectivo", 110000);
    const pending = await one<{ id: string }>(db,
      `INSERT INTO public.voucher_requests (employee_id, amount, status, method_code, cash_shift_id) VALUES ($1, 1, 'pendiente', 'efectivo', $2) RETURNING id`,
      [employee, shift.id]);
    const failure = await pgError(db.query(
      `UPDATE public.voucher_requests SET status = 'aprobada', approved_by = $2 WHERE id = $1`, [pending.id, user]));
    expect(failure.message).toBe("CASH_METHOD_MINIMUM_BREACH");
    expect(await one<{ status: string }>(db, `SELECT status FROM public.voucher_requests WHERE id = $1`, [pending.id]))
      .toEqual({ status: "pendiente" });
  });

  it("freezes each method's own base: a later configuration change does not move it", async () => {
    const entries = ALL_METHODS.map((entry) => (entry.code === "nequi" ? { ...entry, amount: 40000 } : entry));
    const shift = await openWithBalances(entries);
    await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'none' WHERE code = 'nequi'`);
    // nequi is no longer arqueable, but this shift froze 40.000 for it.
    await insertVoucher(shift.id, "nequi", 20000);
    expect((await pgError(insertVoucher(shift.id, "nequi", 1))).message).toBe("CASH_METHOD_MINIMUM_BREACH");
  });

  it("rejects an opening that omits an active arqueable method", async () => {
    const failure = await pgError(openWithBalances(ALL_METHODS.filter((entry) => entry.code !== "daviplata")));
    expect(failure.message).toBe("SHIFT_BALANCE_MISMATCH");
    expect(await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM public.cash_shifts`)).toEqual({ n: 0 });
  });

  it("is idempotent: re-applying 003 keeps data, constraints and the wrapper", async () => {
    const shift = await openWithBalances(ALL_METHODS);
    await db.exec(readFileSync(join(MIGRATIONS_DIR, "003_payment_method_arqueo.sql"), "utf8"));
    expect(await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM public.cash_shift_method_balances WHERE cash_shift_id = $1`, [shift.id]))
      .toEqual({ n: 6 });
    await insertCommission(shift.id, "efectivo", 100000);
    expect((await pgError(insertCommission(shift.id, "efectivo", 1))).message).toBe("CASH_METHOD_MINIMUM_BREACH");
  });

  it("recount requires the configured denomination method, not the 'efectivo' code", async () => {
    await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'efectivo'`);
    await db.query(`INSERT INTO public.payment_methods (code, name, arqueo_mode) VALUES ('caja-billetes', 'Caja', 'denominations')`);
    const lines: Array<{ code: string; amount: number; denomination?: number }> = [
      { code: "caja-billetes", amount: 200000, denomination: 10000 },
      ...ALL_METHODS.map((entry) => ({ code: entry.code, amount: 0 })),
    ];
    const shift = await openWithBalances(lines);
    const counts = lines.map((entry) => ({
      method_code: entry.code,
      denomination: entry.denomination ?? null,
      quantity: entry.denomination ? entry.amount / entry.denomination : 1,
      amount: entry.amount,
    }));
    await rpc(db, "cash_close_shift_atomic", [shift.id, user, new Date().toISOString(),
      JSON.stringify({ expected_cash: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0 }),
      JSON.stringify(counts),
      JSON.stringify({ payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 })],
    ["uuid", "uuid", "timestamptz", "jsonb", "jsonb", "jsonb"]);
    const recount = (lines2: unknown[]) => rpc(db, "cash_recount_shift_atomic", [shift.id, user,
      JSON.stringify({ previous_counted_cash: 200000, previous_base_left: 200000, previous_cash_withdrawn: 0, previous_base_difference: 0,
        counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, reason: "Revisión" }),
      JSON.stringify(lines2)], ["uuid", "uuid", "jsonb", "jsonb"]);
    // Without the drawer line it is rejected...
    expect((await pgError(recount(counts.filter((line) => line.method_code !== "caja-billetes")))).message).toBe("SHIFT_INVALID");
    // ...and with it, it is accepted even though no 'efectivo' denomination line exists.
    expect(await recount(counts)).toMatchObject({ shift_id: shift.id, reason: "Revisión" });
  });

  it("rejects every legacy collection move but permits an unchanged rewrite", async () => {
    const legacy = await one<{ id: string }>(db,
      `INSERT INTO public.cash_shifts (cash_register_id, opened_by, opening_base, expected_cash, status) VALUES ($1, $2, 200000, 0, 'abierto') RETURNING id`, [register, user]);
    const otherRegister = await one<{ id: string }>(db,
      `INSERT INTO public.cash_registers (name, base_configurada) VALUES ('Caja secundaria', 200000) RETURNING id`);
    register = otherRegister.id;
    const newer = await openWithBalances(ALL_METHODS);
    const invoice = (await createInvoiceCall(db, { user, shift: legacy.id, employee })).id as string;
    await db.query(`UPDATE public.invoices SET subtotal = 500000, total = 500000 WHERE id = $1`, [invoice]);
    const invoicePayment = await one<{ id: string }>(db,
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`, [invoice, legacy.id]);
    const drawerPayment = await one<{ id: string }>(db,
      `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`, [legacy.id, user]);

    for (const sql of [
      `UPDATE public.invoice_payments SET method_code = 'nequi' WHERE id = $1`,
      `UPDATE public.invoice_payments SET amount = 9000 WHERE id = $1`,
      `UPDATE public.invoice_payments SET cash_shift_id = $2 WHERE id = $1`,
      `UPDATE public.payments SET method_code = 'nequi' WHERE id = $1`,
      `UPDATE public.payments SET amount = 9000 WHERE id = $1`,
      `UPDATE public.payments SET cash_shift_id = $2 WHERE id = $1`,
    ]) {
      const args = sql.includes("$2") ? [sql.includes("invoice_payments") ? invoicePayment.id : drawerPayment.id, newer.id] : [sql.includes("invoice_payments") ? invoicePayment.id : drawerPayment.id];
      expect((await pgError(db.query(sql, args))).message).toBe("CASH_METHOD_BALANCE_REQUIRED");
    }
    expect(await one<{ method_code: string; amount: string; cash_shift_id: string }>(db,
      `SELECT method_code, amount::text, cash_shift_id FROM public.invoice_payments WHERE id = $1`, [invoicePayment.id]))
      .toEqual({ method_code: "efectivo", amount: "10000.00", cash_shift_id: legacy.id });
    expect(await one<{ method_code: string; amount: string; cash_shift_id: string }>(db,
      `SELECT method_code, amount::text, cash_shift_id FROM public.payments WHERE id = $1`, [drawerPayment.id]))
      .toEqual({ method_code: "efectivo", amount: "10000.00", cash_shift_id: legacy.id });

    await db.query(`UPDATE public.invoice_payments SET method_code = 'efectivo' WHERE id = $1`, [invoicePayment.id]);
    await db.query(`UPDATE public.payments SET amount = 10000 WHERE id = $1`, [drawerPayment.id]);
  });

  describe("a method whose arqueo mode changed after the shift opened", () => {
    const methodOf = (table: string, id: string) =>
      one<{ method_code: string; amount: string }>(db, `SELECT method_code, amount::text FROM public.${table} WHERE id = $1`, [id]);

    beforeEach(async () => {
      await db.query(`INSERT INTO public.payment_methods (code, name, arqueo_mode) VALUES ('qr-pay', 'QR', 'none')`);
    });

    async function shiftWithCollections() {
      const shift = await openWithBalances(ALL_METHODS);
      const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
      await db.query(`UPDATE public.invoices SET subtotal = 500000, total = 500000 WHERE id = $1`, [invoice]);
      const invoicePayment = await one<{ id: string }>(db,
        `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`, [invoice, shift.id]);
      const drawerPayment = await one<{ id: string }>(db,
        `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`, [shift.id, user]);
      return { shift, invoicePayment, drawerPayment };
    }

    it("rejects a collection move to a method that became arqueable without a frozen base, and keeps the rows", async () => {
      const { invoicePayment, drawerPayment } = await shiftWithCollections();
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'qr-pay'`);
      for (const [table, id] of [["invoice_payments", invoicePayment.id], ["payments", drawerPayment.id]] as const) {
        const failure = await pgError(db.query(`UPDATE public.${table} SET method_code = 'qr-pay' WHERE id = $1`, [id]));
        expect(failure.message).toBe("CASH_METHOD_BALANCE_REQUIRED");
        expect(await methodOf(table, id)).toEqual({ method_code: "efectivo", amount: "10000.00" });
      }
      // The real edit RPC rolls back the whole edit with the same code.
      const invoice = (await one<{ invoice_id: string }>(db,
        `SELECT invoice_id FROM public.invoice_payments WHERE id = $1`, [invoicePayment.id])).invoice_id;
      const viaRpc = await pgError(rpc(db, "invoice_edit_items_atomic", [invoice, user, 0, "Emitida", JSON.stringify({
        items_remove: [], items_update: [], items_insert: [],
        payments: [{ id: invoicePayment.id, method_code: "qr-pay", method_id: null }],
        movements: [],
      })], ["uuid", "uuid", "integer", "text", "jsonb"]));
      expect(viaRpc.message).toBe("CASH_METHOD_BALANCE_REQUIRED");
      expect(await one<{ edit_version: number }>(db, `SELECT edit_version FROM public.invoices WHERE id = $1`, [invoice]))
        .toEqual({ edit_version: 0 });
      expect(await methodOf("invoice_payments", invoicePayment.id)).toEqual({ method_code: "efectivo", amount: "10000.00" });
    });

    it("rejects a collection move FROM a method that became arqueable without a frozen base", async () => {
      const shift = await openWithBalances(ALL_METHODS);
      const drawer = await one<{ id: string }>(db,
        `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'qr-pay', 10000, $2) RETURNING id`, [shift.id, user]);
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'qr-pay'`);
      expect((await pgError(db.query(`UPDATE public.payments SET method_code = 'efectivo' WHERE id = $1`, [drawer.id]))).message)
        .toBe("CASH_METHOD_BALANCE_REQUIRED");
      expect(await methodOf("payments", drawer.id)).toEqual({ method_code: "qr-pay", amount: "10000.00" });
    });

    it("rejects a commission or voucher by a method that became arqueable without a frozen base", async () => {
      const shift = await openWithBalances(ALL_METHODS);
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'qr-pay'`);
      expect((await pgError(insertCommission(shift.id, "qr-pay", 1))).message).toBe("CASH_METHOD_BALANCE_REQUIRED");
      expect((await pgError(insertVoucher(shift.id, "qr-pay", 1))).message).toBe("CASH_METHOD_BALANCE_REQUIRED");
      expect(await one<{ n: number }>(db,
        `SELECT (SELECT count(*) FROM public.commission_payouts WHERE method_code = 'qr-pay')::int
              + (SELECT count(*) FROM public.voucher_requests WHERE method_code = 'qr-pay')::int AS n`)).toEqual({ n: 0 });
    });

    it("a frozen base still governs after its method is marked none: outflows and collection moves cannot escape", async () => {
      const shift = await openWithBalances(ALL_METHODS.map((entry) => (entry.code === "nequi" ? { ...entry, amount: 40000 } : entry)));
      const invoice = (await createInvoiceCall(db, { user, shift: shift.id, employee })).id as string;
      await db.query(`UPDATE public.invoices SET subtotal = 500000, total = 500000 WHERE id = $1`, [invoice]);
      const payment = await one<{ id: string }>(db,
        `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'nequi', 10000, $2) RETURNING id`, [invoice, shift.id]);
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'none' WHERE code = 'nequi'`);
      // Frozen 40.000 + 10.000 collected; floor 20.000.
      await insertCommission(shift.id, "nequi", 25000);
      expect((await pgError(insertCommission(shift.id, "nequi", 5001))).message).toBe("CASH_METHOD_MINIMUM_BREACH");
      expect((await pgError(insertVoucher(shift.id, "nequi", 5001))).message).toBe("CASH_METHOD_MINIMUM_BREACH");
      expect((await pgError(db.query(`UPDATE public.invoice_payments SET method_code = 'efectivo' WHERE id = $1`, [payment.id]))).message)
        .toBe("CASH_METHOD_BALANCE_UPDATE_BREACH");
      expect(await methodOf("invoice_payments", payment.id)).toEqual({ method_code: "nequi", amount: "10000.00" });
    });

    it("a shift opened after activating the method freezes its base and allows the move", async () => {
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'qr-pay'`);
      const shift = await openWithBalances([...ALL_METHODS, { code: "qr-pay", amount: 0 }]);
      expect(await one<{ n: number }>(db,
        `SELECT count(*)::int AS n FROM public.cash_shift_method_balances WHERE cash_shift_id = $1 AND method_code = 'qr-pay'`, [shift.id]))
        .toEqual({ n: 1 });
      const drawer = await one<{ id: string }>(db,
        `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 10000, $2) RETURNING id`, [shift.id, user]);
      await db.query(`UPDATE public.payments SET method_code = 'qr-pay' WHERE id = $1`, [drawer.id]);
      expect(await methodOf("payments", drawer.id)).toEqual({ method_code: "qr-pay", amount: "10000.00" });
    });

    it("an unchanged rewrite stays allowed even when the method lacks a frozen base", async () => {
      const shift = await openWithBalances(ALL_METHODS);
      const drawer = await one<{ id: string }>(db,
        `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'qr-pay', 10000, $2) RETURNING id`, [shift.id, user]);
      await db.query(`UPDATE public.payment_methods SET arqueo_mode = 'declared_total' WHERE code = 'qr-pay'`);
      await db.query(`UPDATE public.payments SET method_code = 'qr-pay', amount = 10000 WHERE id = $1`, [drawer.id]);
      expect(await methodOf("payments", drawer.id)).toEqual({ method_code: "qr-pay", amount: "10000.00" });
    });
  });

  it("blocks a legacy open shift without balances instead of permitting an uncontrolled outflow", async () => {
    const legacy = await one<{ id: string }>(db, `INSERT INTO public.cash_shifts (cash_register_id, opened_by, opening_base, expected_cash, status) VALUES ($1, $2, 200000, 0, 'abierto') RETURNING id`, [register, user]);
    expect((await pgError(insertCommission(legacy.id, "efectivo", 1))).message).toContain("CASH_METHOD_BALANCE_REQUIRED");
  });
});
