import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, one, pgError, rpc, warmTemplate, type Db, withCopTriggersDisabled } from "./harness";
import { countLines, createInvoiceCall, insertEmployee, insertPeriod, insertUser, openShift, payrollItem, registerId } from "./fixtures";

let db: Db;
let user: string;
let employee: string;
let register: string;
let shift: string;
let invoice: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
  employee = await insertEmployee(db);
  register = await registerId(db);
  shift = await openShift(db, register, user);
  invoice = (await createInvoiceCall(db, { user, shift, employee })).id as string;
}, DB_HOOK_TIMEOUT);
afterEach(async () => closeDb(db));

const expectCop = async (operation: Promise<unknown>) => {
  expect(await pgError(operation)).toMatchObject({ code: "P0001", message: "COP_WHOLE_PESO_REQUIRED" });
};

describe("005 rejects new decimal amounts at RPC boundaries", () => {
  it("invoice_create_atomic rejects a decimal line price", async () => {
    await expectCop(
      rpc(db, "invoice_create_atomic", [user, shift, "e0000000-0000-4000-8000-000000000010", JSON.stringify({ client_name: "x", client_document: null, subtotal: 10.5, discount: 0, tax: 0, surcharge: 0, total: 10.5, status: "Emitida", closed_by: null, closed_at: null }), JSON.stringify([{ item_type: "custom", product_id: null, service_id: null, custom_name: "x", employee_id: employee, qty: 1, unit_price: 10.5, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 10.5 }]), "[]", "[]", "x", "[]"], ["uuid", "uuid", "text", "jsonb", "jsonb", "jsonb", "jsonb", "text", "jsonb"]),
    );
  });

  it("invoice edit rejects a decimal unit_price; subtotal is derived and deliberately excluded", async () => {
    const item = await one<{ id: string }>(db, "SELECT id FROM public.invoice_items WHERE invoice_id = $1", [invoice]);
    await expectCop(
      rpc(db, "invoice_edit_emitted_atomic", [invoice, user, 0, "Emitida", JSON.stringify({ items_update: [{ id: item.id, item_type: "custom", product_id: null, service_id: null, custom_name: "Servicio libre", employee_id: employee, qty: 1, unit_price: 10.5, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 10.5 }], taxes: [], totals: { subtotal: 10.5, discount: 0, tax: 0, surcharge: 0, total: 10.5 }, movements: [] })], ["uuid", "uuid", "integer", "text", "jsonb"]),
    );
  });

  it("split payment rejects a decimal new amount; fee_amount is derived and excluded", async () => {
    await expectCop(
      rpc(db, "invoice_split_payment_atomic", [invoice, shift, user, new Date().toISOString(), false, JSON.stringify([{ method_id: null, method_code: "efectivo", amount: 10.5, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: "e0000000-0000-4000-8000-000000000011" }])], ["uuid", "uuid", "uuid", "timestamptz", "boolean", "jsonb"]),
    );
  });

  it("cash open and recount reject decimal direct count amounts", async () => {
    // A well-formed opening (integer quantities) whose only defect is cents:
    // the declared-total line of nequi and the opening base carry 0.50.
    const decimalOpening = countLines().map((line) => (line.method_code === "nequi" ? { ...line, amount: 0.5 } : line));
    await rpc(db, "cash_close_shift_atomic", [shift, user, new Date().toISOString(), JSON.stringify({ expected_cash: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, observation: null }), JSON.stringify(countLines()), JSON.stringify({ payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 })], ["uuid", "uuid", "timestamptz", "jsonb", "jsonb", "jsonb"]);
    await expectCop(rpc(db, "cash_open_shift_atomic", [register, user, 200000.5, JSON.stringify(decimalOpening)], ["uuid", "uuid", "numeric", "jsonb"]));
  });

  it("cash recount rejects a decimal recounted amount", async () => {
    await rpc(db, "cash_close_shift_atomic", [shift, user, new Date().toISOString(), JSON.stringify({ expected_cash: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, observation: null }), JSON.stringify(countLines()), JSON.stringify({ payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 })], ["uuid", "uuid", "timestamptz", "jsonb", "jsonb", "jsonb"]);
    await expectCop(rpc(db, "cash_recount_shift_atomic", [shift, user, JSON.stringify({ previous_counted_cash: 200000, previous_base_left: 200000, previous_cash_withdrawn: 0, previous_base_difference: 0, counted_cash: 200000.5, base_left: 200000, cash_withdrawn: 0, base_difference: 0, reason: "x" }), JSON.stringify(countLines())], ["uuid", "uuid", "jsonb", "jsonb"]));
  });

  it("payroll apply and payroll payment reject decimal direct money", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15" });
    const decimal = { ...payrollItem(period, employee), bonuses: 10.5, net_pay: 450010.5 };
    await expectCop(rpc(db, "payroll_apply_atomic", [period, JSON.stringify([decimal]), [], []], ["uuid", "jsonb", "uuid[]", "uuid[]"]));
    await rpc(db, "payroll_apply_atomic", [period, JSON.stringify([payrollItem(period, employee)]), [], []], ["uuid", "jsonb", "uuid[]", "uuid[]"]);
    const item = await one<{ id: string }>(db, "SELECT id FROM public.payroll_items WHERE period_id = $1", [period]);
    await expectCop(db.query("INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount) VALUES ($1, 'efectivo', 10.5)", [item.id]));
  });
});

describe("005 permits operations on legacy-cent rows without rewriting history", () => {
  it("recounts a legacy-cent shift and preserves its signed close", async () => {
    await withCopTriggersDisabled(db, async () => {
      await db.query("UPDATE public.cash_shifts SET counted_cash = 200000.5, base_left = 200000.5, cash_withdrawn = 0, base_difference = 0, status = 'cerrado', closed_at = now() WHERE id = $1", [shift]);
    });
    await rpc(db, "cash_recount_shift_atomic", [shift, user, JSON.stringify({ previous_counted_cash: 200000.5, previous_base_left: 200000.5, previous_cash_withdrawn: 0, previous_base_difference: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, reason: "legacy" }), JSON.stringify(countLines())], ["uuid", "uuid", "jsonb", "jsonb"]);
    expect(await one<{ counted_cash: string }>(db, "SELECT counted_cash::text FROM public.cash_shifts WHERE id = $1", [shift])).toEqual({ counted_cash: "200000.50" });
  });

  it("corrects a legacy-cent payroll period without mutating payroll_items", async () => {
    const period = await insertPeriod(db, { start: "2026-09-01", end: "2026-09-15", status: "cerrado" });
    await withCopTriggersDisabled(db, async () => {
      await db.query("INSERT INTO public.payroll_items (period_id, employee_id, base_fixed, commissions, bonuses, deductions_vales, other_discounts, net_pay) VALUES ($1, $2, 100, 0, 0.5, 0, 0, 100.5)", [period, employee]);
    });
    const correctedBy = await insertUser(db);
    await rpc(db, "payroll_correct_period_atomic", [period, JSON.stringify({ period_id: period, reason: "legacy", corrected_by: correctedBy, previous_net_total: 100.5, previous_paid_total: 0, corrected_net_total: 101, previous_item_count: 1, corrected_item_count: 1 }), JSON.stringify([{ employee_id: employee, previous_base_fixed: 100, previous_commissions: 0, previous_bonuses: 0.5, previous_deductions_vales: 0, previous_other_discounts: 0, previous_net_pay: 100.5, previous_paid: 0, corrected_base_fixed: 100, corrected_commissions: 0, corrected_bonuses: 1, corrected_deductions_vales: 0, corrected_other_discounts: 0, corrected_net_pay: 101 }])], ["uuid", "jsonb", "jsonb"]);
    expect(await one<{ net_pay: string }>(db, "SELECT net_pay::text FROM public.payroll_items WHERE period_id = $1", [period])).toEqual({ net_pay: "100.50" });
  });

  it("characterizes emitted invoice edit with a legacy-cent surcharge: the total keeps the historical cent", async () => {
    await withCopTriggersDisabled(db, async () => {
      await db.query("UPDATE public.invoices SET surcharge = 0.5, total = total + 0.5 WHERE id = $1", [invoice]);
    });
    const item = await one<{ id: string }>(db, "SELECT id FROM public.invoice_items WHERE invoice_id = $1", [invoice]);
    await rpc(db, "invoice_edit_emitted_atomic", [invoice, user, 0, "Emitida", JSON.stringify({ items_update: [{ id: item.id, item_type: "custom", product_id: null, service_id: null, custom_name: "Servicio libre", employee_id: employee, qty: 1, unit_price: 10000, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 10000 }], taxes: [], totals: { subtotal: 10000, discount: 0, tax: 0, surcharge: 0.5, total: 10000.5 }, movements: [] })], ["uuid", "uuid", "integer", "text", "jsonb"]);
    expect(await one<{ surcharge: string; total: string }>(db, "SELECT surcharge::text, total::text FROM public.invoices WHERE id = $1", [invoice])).toEqual({ surcharge: "0.50", total: "10000.50" });
  });
});
