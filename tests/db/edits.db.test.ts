import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { createInvoiceCall, insertEmployee, insertProduct, insertUser, openShift, registerId } from "./fixtures";

let db: Db;
let user: string;
let employee: string;
let shift: string;
let product: string;
let invoice: string;
let itemId: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
  employee = await insertEmployee(db);
  shift = await openShift(db, await registerId(db), user);
  product = await insertProduct(db, 10);
  // 'Emitida' invoice: 2 units of the product at 10.000 (stock 10 -> 8).
  invoice = (await createInvoiceCall(db, { user, shift, employee, product: { id: product, qty: 2 } })).id as string;
  itemId = (await one<{ id: string }>(db, `SELECT id FROM public.invoice_items WHERE invoice_id = $1`, [invoice])).id;
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

/** `editItemColumns` (billing/service.ts) for a product line. */
const productLine = (qty: number, unitPrice = 10000) => ({
  item_type: "producto",
  product_id: product,
  service_id: null,
  custom_name: null,
  employee_id: employee,
  qty,
  unit_price: unitPrice,
  discount: 0,
  no_commission: false,
  commission_value: null,
  commission_mode: "comision",
  commission_percent_override: null,
  subtotal: qty * unitPrice,
});
const customLine = (subtotal: number) => ({
  item_type: "custom",
  product_id: null,
  service_id: null,
  custom_name: "Ajuste",
  employee_id: employee,
  qty: 1,
  unit_price: subtotal,
  discount: 0,
  no_commission: true,
  commission_value: null,
  commission_mode: "ninguna",
  commission_percent_override: null,
  subtotal,
});

const stock = async (): Promise<number> =>
  (await one<{ stock_qty: number }>(db, `SELECT stock_qty FROM public.products WHERE id = $1`, [product])).stock_qty;
const invoiceRow = () =>
  one<{ edit_version: number; subtotal: string; tax: string; total: string; status: string }>(
    db,
    `SELECT edit_version, subtotal::text, tax::text, total::text, status FROM public.invoices WHERE id = $1`,
    [invoice],
  );
const edit = (fn: string, version: number, payload: Record<string, unknown>, status = "Emitida") =>
  rpc<{ invoice: Record<string, unknown>; items: number; movements: number }>(
    db,
    fn,
    [invoice, user, version, status, JSON.stringify(payload)],
    ["uuid", "uuid", "integer", "text", "jsonb"],
  );

describe("invoice_edit_items_atomic (admin edit, total immutable)", () => {
  it("replaces the items, moves the stock by the net delta and bumps edit_version without touching the totals", async () => {
    // 2 units -> 1 unit + a custom line: same subtotal, stock comes back by 1.
    const written = await edit("invoice_edit_items_atomic", 0, {
      items_update: [{ id: itemId, ...productLine(1) }],
      items_insert: [customLine(10000)],
      movements: [{ product_id: product, type: "IN", qty: 1, reason: "Ajuste edición factura #1 — corrección" }],
    });
    expect(written).toMatchObject({ items: 2, movements: 1 });
    expect(await invoiceRow()).toEqual({ edit_version: 1, subtotal: "20000.00", tax: "0.00", total: "20000.00", status: "Emitida" });
    expect(await stock()).toBe(9);
    expect(await count(db, `SELECT 1 FROM public.invoice_items WHERE invoice_id = $1`, [invoice])).toBe(2);
  });

  it("characterization: line subtotals are written verbatim even when they no longer add up to the invoice total", async () => {
    // The 'total does not change' rule lives in the service; the function has no money column to write.
    await edit("invoice_edit_items_atomic", 0, { items_update: [{ id: itemId, ...productLine(5) }],
      movements: [{ product_id: product, type: "OUT", qty: 3, reason: "x" }] });
    expect((await invoiceRow()).total).toBe("20000.00");
    const line = await one<{ subtotal: string }>(db, `SELECT subtotal::text FROM public.invoice_items WHERE id = $1`, [itemId]);
    expect(line.subtotal).toBe("50000.00");
    expect(await stock()).toBe(5);
  });

  it("rejects a stale edit_version or status with EDIT_CONFLICT and writes nothing", async () => {
    await edit("invoice_edit_items_atomic", 0, { items_update: [{ id: itemId, ...productLine(2) }] });
    const stale = await pgError(
      edit("invoice_edit_items_atomic", 0, {
        items_update: [{ id: itemId, ...productLine(1) }],
        movements: [{ product_id: product, type: "IN", qty: 1, reason: "x" }],
      }),
    );
    expect(stale.message).toBe("EDIT_CONFLICT");
    expect((await pgError(edit("invoice_edit_items_atomic", 1, {}, "Pagada"))).message).toBe("EDIT_CONFLICT");
    expect((await invoiceRow()).edit_version).toBe(1);
    expect(await stock()).toBe(8);
  });

  it("rolls everything back when the stock adjustment cannot be applied", async () => {
    const error = await pgError(
      edit("invoice_edit_items_atomic", 0, {
        items_update: [{ id: itemId, ...productLine(20) }],
        movements: [{ product_id: product, type: "OUT", qty: 18, reason: "x" }],
      }),
    );
    expect(error.message).toBe("INSUFFICIENT_STOCK");
    expect((await invoiceRow()).edit_version).toBe(0);
    const line = await one<{ qty: number }>(db, `SELECT qty FROM public.invoice_items WHERE id = $1`, [itemId]);
    expect(line.qty).toBe(2);
  });

  it("only re-methods payments (never the amount) and counts them", async () => {
    const paid = (await createInvoiceCall(db, { user, shift, employee, paid: true })).id as string;
    const payment = await one<{ id: string }>(db, `SELECT id FROM public.invoice_payments WHERE invoice_id = $1`, [paid]);
    invoice = paid;
    await edit("invoice_edit_items_atomic", 0, { payments: [{ id: payment.id, method_code: "nequi", method_id: null }] }, "Pagada");
    const row = await one<{ method_code: string; amount: string }>(
      db, `SELECT method_code, amount::text FROM public.invoice_payments WHERE id = $1`, [payment.id]);
    expect(row).toEqual({ method_code: "nequi", amount: "10000.00" });
    const unknown = await pgError(
      edit("invoice_edit_items_atomic", 1, { payments: [{ id: randomUUID(), method_code: "nequi" }] }, "Pagada"),
    );
    expect(unknown.message).toBe("PAYMENT_MISMATCH");
  });
});

describe("invoice_edit_emitted_atomic (free edit, totals rewritten)", () => {
  const taxRows = () =>
    db.query<{ tax_code: string; percent: string; amount: string }>(
      `SELECT tax_code, percent::text, amount::text FROM public.invoice_taxes WHERE invoice_id = $1 ORDER BY tax_code`,
      [invoice],
    );

  it("replaces the tax snapshot, rewrites the five totals and adjusts the stock", async () => {
    const oldTax = await one<{ id: string }>(
      db,
      `INSERT INTO public.invoice_taxes (invoice_id, tax_code, tax_name, percent, amount) VALUES ($1, 'ICA', 'ICA viejo', 1, 200) RETURNING id`,
      [invoice],
    );
    await edit("invoice_edit_emitted_atomic", 0, {
      items_update: [{ id: itemId, ...productLine(3) }],
      movements: [{ product_id: product, type: "OUT", qty: 1, reason: "Edición libre emitida factura #1" }],
      taxes_remove: [oldTax.id],
      taxes: [{ tax_code: "IVA", tax_name: "IVA", percent: 19, amount: 5700 }],
      totals: { subtotal: 30000, discount: 0, tax: 5700, surcharge: 0, total: 35700 },
    });
    expect(await invoiceRow()).toEqual({ edit_version: 1, subtotal: "30000.00", tax: "5700.00", total: "35700.00", status: "Emitida" });
    expect((await taxRows()).rows).toEqual([{ tax_code: "IVA", percent: "19.00", amount: "5700.00" }]);
    expect(await stock()).toBe(7);
  });

  it("keeps the old snapshot when the removal list does not match (TAX_MISMATCH rolls back)", async () => {
    await db.query(
      `INSERT INTO public.invoice_taxes (invoice_id, tax_code, tax_name, percent, amount) VALUES ($1, 'ICA', 'ICA', 1, 200)`,
      [invoice],
    );
    const error = await pgError(
      edit("invoice_edit_emitted_atomic", 0, {
        taxes_remove: [randomUUID()],
        taxes: [{ tax_code: "IVA", tax_name: "IVA", percent: 19, amount: 3800 }],
        totals: { subtotal: 20000, discount: 0, tax: 3800, surcharge: 0, total: 23800 },
      }),
    );
    expect(error.message).toBe("TAX_MISMATCH");
    expect((await taxRows()).rows).toEqual([{ tax_code: "ICA", percent: "1.00", amount: "200.00" }]);
    expect(await invoiceRow()).toMatchObject({ edit_version: 0, total: "20000.00" });
  });

  it("does not check the totals arithmetic: the invoices CHECK is the barrier (23514)", async () => {
    const error = await pgError(
      edit("invoice_edit_emitted_atomic", 0, { totals: { subtotal: 20000, discount: 0, tax: 0, surcharge: 0, total: 99999 } }),
    );
    expect(error.code).toBe("23514");
    expect(error.constraint).toBe("invoices_total_surcharge_check");
  });

  it("requires the totals object and the current edit_version", async () => {
    expect((await pgError(edit("invoice_edit_emitted_atomic", 0, {}))).message).toBe("EDIT_INVALID");
    const totals = { subtotal: 20000, discount: 0, tax: 0, surcharge: 0, total: 20000 };
    await edit("invoice_edit_emitted_atomic", 0, { totals });
    expect((await pgError(edit("invoice_edit_emitted_atomic", 0, { totals }))).message).toBe("EDIT_CONFLICT");
    expect((await invoiceRow()).edit_version).toBe(1);
  });
});
