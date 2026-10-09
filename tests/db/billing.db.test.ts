import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import {
  closeShiftCall,
  createInvoiceCall,
  insertEmployee,
  insertProduct,
  insertUser,
  openShift,
  registerId,
} from "./fixtures";

let db: Db;
let user: string;
let employee: string;
let shift: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
  employee = await insertEmployee(db);
  shift = await openShift(db, await registerId(db), user);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const lastNumber = async (): Promise<number> =>
  (await one<{ n: number }>(db, `SELECT (value ->> 'last_number')::int AS n FROM public.system_settings WHERE key = 'invoice_sequence'`)).n;

const annul = (invoice: string, expectedStatus: string, items: unknown[] = []) =>
  rpc<Record<string, unknown>>(
    db,
    "invoice_annul_atomic",
    [invoice, user, new Date().toISOString(), "Error de digitación", expectedStatus, JSON.stringify(items)],
    ["uuid", "uuid", "timestamptz", "text", "text", "jsonb"],
  );

describe("invoice_create_atomic", () => {
  it("reserves consecutive numbers without gaps, even when an emission fails", async () => {
    const first = await createInvoiceCall(db, { user, shift, employee });
    const product = await insertProduct(db, 1);
    // Fails inside the transaction (stock 1 < 5): the reservation rolls back with it.
    const failed = await pgError(createInvoiceCall(db, { user, shift, employee, product: { id: product, qty: 5 } }));
    expect(failed.message).toBe("INSUFFICIENT_STOCK");
    const second = await createInvoiceCall(db, { user, shift, employee });

    expect([first.consecutive_number, second.consecutive_number]).toEqual([1, 2]);
    expect(await lastNumber()).toBe(2);
    expect(await count(db, `SELECT 1 FROM public.invoices`)).toBe(2);
  });

  it("rejects an emission without an open shift (closed or unknown)", async () => {
    await closeShiftCall(db, { shift, user });
    expect((await pgError(createInvoiceCall(db, { user, shift, employee }))).message).toBe("SHIFT_NOT_OPEN");
    expect((await pgError(createInvoiceCall(db, { user, shift: randomUUID(), employee }))).message).toBe("SHIFT_NOT_OPEN");
    expect(await lastNumber()).toBe(0);
  });

  it("deducts stock through deduct_stock_atomic with the consecutive substituted in the reason", async () => {
    const product = await insertProduct(db, 10);
    const invoice = await createInvoiceCall(db, { user, shift, employee, product: { id: product, qty: 3 }, paid: true });
    expect(invoice).toMatchObject({ status: "Pagada", total: 30000, consecutive_number: 1 });

    const stock = await one<{ stock_qty: number }>(db, `SELECT stock_qty FROM public.products WHERE id = $1`, [product]);
    expect(stock.stock_qty).toBe(7);
    const movement = await one<{ type: string; qty: number; reason: string; idempotency_key: string | null }>(
      db,
      `SELECT type, qty, reason, idempotency_key FROM public.inventory_movements WHERE product_id = $1`,
      [product],
    );
    expect(movement).toEqual({ type: "OUT", qty: 3, reason: "Venta factura #1 - Cliente", idempotency_key: null });
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1 AND cash_shift_id = $2`, [invoice.id, shift])).toBe(1);
  });

  it("is idempotent by key: a replay hits the unique index (23505) and burns no number", async () => {
    const key = randomUUID();
    await createInvoiceCall(db, { user, shift, employee, idempotencyKey: key });
    const replay = await pgError(createInvoiceCall(db, { user, shift, employee, idempotencyKey: key }));
    expect(replay.code).toBe("23505");
    expect(replay.message).toContain("uq_invoices_sede_idempotency_key");
    expect(await lastNumber()).toBe(1);
    expect(await count(db, `SELECT 1 FROM public.invoices WHERE idempotency_key = $1`, [key])).toBe(1);
  });

  it("rejects a malformed idempotency key before any write", async () => {
    await createInvoiceCall(db, { user, shift, employee });
    const bad = await pgError(createInvoiceCall(db, { user, shift, employee, idempotencyKey: "not-a-uuid" }));
    expect(bad.message).toBe("INVOICE_INVALID");
    expect(await lastNumber()).toBe(1);
    expect(await count(db, `SELECT 1 FROM public.invoices`)).toBe(1);
  });
});

describe("invoice_annul_atomic", () => {
  it("annuls with compare-and-swap on the status and returns the stock with IN movements", async () => {
    const product = await insertProduct(db, 5);
    const invoice = await createInvoiceCall(db, { user, shift, employee, product: { id: product, qty: 2 } });
    const items = [{ product_id: product, qty: 2, reason: "Anulación factura #1" }];

    // Stale precondition: the service read 'Pagada' but the row is 'Emitida'.
    expect((await pgError(annul(invoice.id as string, "Pagada", items))).message).toBe("ANNUL_CONFLICT");

    const annulled = await annul(invoice.id as string, "Emitida", items);
    expect(annulled).toMatchObject({ status: "Anulada", cancel_reason: "Error de digitación", closed_by: user });
    const stock = await one<{ stock_qty: number }>(db, `SELECT stock_qty FROM public.products WHERE id = $1`, [product]);
    expect(stock.stock_qty).toBe(5);

    // A second annulment with the old precondition loses the CAS.
    expect((await pgError(annul(invoice.id as string, "Emitida", items))).message).toBe("ANNUL_CONFLICT");
    expect(await count(db, `SELECT 1 FROM public.inventory_movements WHERE type = 'IN'`)).toBe(1);
  });

  it("rolls the annulment back when a reversal targets an unknown product", async () => {
    const invoice = await createInvoiceCall(db, { user, shift, employee });
    const error = await pgError(annul(invoice.id as string, "Emitida", [{ product_id: randomUUID(), qty: 1, reason: "x" }]));
    expect(error.message).toBe("PRODUCT_NOT_FOUND");
    const row = await one<{ status: string }>(db, `SELECT status FROM public.invoices WHERE id = $1`, [invoice.id]);
    expect(row.status).toBe("Emitida");
  });
});

describe("trg_invoice_payments_cap (check_invoice_payments_cap)", () => {
  const pay = (invoice: string, amount: number, fee = 0) =>
    db.query(
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, fee_amount, cash_shift_id) VALUES ($1, 'efectivo', $2, $3, $4)`,
      [invoice, amount, fee, shift],
    );

  it("accepts partial payments up to the net total and rejects an overpayment", async () => {
    const invoice = (await createInvoiceCall(db, { user, shift, employee })).id as string;
    await pay(invoice, 6000);
    await pay(invoice, 4000);
    const error = await pgError(pay(invoice, 1));
    expect(error.code).toBe("P0001");
    expect(error.message).toContain("El cobro supera el neto facturado");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1`, [invoice])).toBe(2);
  });

  it("measures the cap net of the card fee", async () => {
    const invoice = (await createInvoiceCall(db, { user, shift, employee })).id as string;
    // gross 10500 with fee 500 is a net 10000: exactly the cap.
    await pay(invoice, 10500, 500);
    expect((await pgError(pay(invoice, 100))).code).toBe("P0001");
  });
});
