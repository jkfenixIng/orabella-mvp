import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import {
  closeShiftCall,
  createInvoiceCall,
  insertEmployee,
  insertUser,
  methodId,
  openShift,
  registerId,
} from "./fixtures";

let db: Db;
let user: string;
let employee: string;
let shift: string;
let invoice: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
  employee = await insertEmployee(db);
  shift = await openShift(db, await registerId(db), user);
  // 'Emitida' invoice of 10.000 without payments and with its emission shift.
  invoice = (await createInvoiceCall(db, { user, shift, employee })).id as string;
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const invoiceRow = (id = invoice) =>
  one<{ status: string; closed_by: string | null; closed_at: string | null; cash_shift_id: string | null }>(
    db,
    `SELECT status, closed_by, closed_at::text, cash_shift_id FROM public.invoices WHERE id = $1`,
    [id],
  );

/** `collectInvoicePayment` (cash/service.ts): one collection, mark in p_collection. */
const cashPayment = async (args: {
  amount: number;
  markPaid: boolean;
  key?: string;
  setShift?: boolean;
  shiftId?: string;
  method?: string;
  fee?: number;
}) =>
  rpc<{ payment: Record<string, unknown>; invoice: { id: string; status: string } }>(
    db,
    "cash_invoice_payment_atomic",
    [
      args.shiftId ?? shift,
      invoice,
      user,
      new Date().toISOString(),
      args.setShift ?? false,
      args.markPaid,
      JSON.stringify({
        method_id: await methodId(db, args.method ?? "efectivo"),
        method_code: args.method ?? "efectivo",
        amount: args.amount + (args.fee ?? 0),
        fee_percent: args.fee ? 5 : 0,
        fee_amount: args.fee ?? 0,
        idempotency_key: args.key ?? randomUUID(),
      }),
    ],
    ["uuid", "uuid", "uuid", "timestamptz", "boolean", "boolean", "jsonb"],
  );

/** `paySplitInvoice` (billing/service.ts): the mark lives only in the first portion. */
const splitPayment = (args: { portions: number[]; markPaid: boolean; key?: string; shiftId?: string; portionShift?: string }) =>
  rpc<{ invoice: Record<string, unknown>; portions: number }>(
    db,
    "invoice_split_payment_atomic",
    [
      invoice,
      args.shiftId ?? shift,
      user,
      new Date().toISOString(),
      args.markPaid,
      JSON.stringify(
        args.portions.map((amount, index) => ({
          method_id: null,
          method_code: index === 0 ? "efectivo" : "nequi",
          amount,
          fee_percent: 0,
          fee_amount: 0,
          cash_shift_id: args.portionShift ?? args.shiftId ?? shift,
          idempotency_key: index === 0 ? (args.key ?? randomUUID()) : null,
        })),
      ),
    ],
    ["uuid", "uuid", "uuid", "timestamptz", "boolean", "jsonb"],
  );

describe("cash_invoice_payment_atomic", () => {
  it("writes the mirror row, the drawer ledger row and closes the invoice when told to", async () => {
    const written = await cashPayment({ amount: 10000, markPaid: true });
    expect(written.invoice.status).toBe("Pagada");
    expect(written.payment).toMatchObject({ cash_shift_id: shift, invoice_id: invoice, amount: 10000, user_id: user });

    const row = await invoiceRow();
    expect(row.status).toBe("Pagada");
    expect(row.closed_by).toBe(user);
    expect(row.closed_at).not.toBeNull();
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1 AND idempotency_key IS NOT NULL`, [invoice])).toBe(1);
    // The drawer row carries no mark (043): identity lives on the mirror row.
    expect(await count(db, `SELECT 1 FROM public.payments WHERE invoice_id = $1 AND idempotency_key IS NULL`, [invoice])).toBe(1);
  });

  it("characterization: the status follows p_mark_paid, not the collected amount", async () => {
    // The function never compares collected vs billed: a full payment with
    // markPaid=false leaves 'Emitida', and a partial one with markPaid=true closes it.
    await cashPayment({ amount: 10000, markPaid: false });
    expect((await invoiceRow()).status).toBe("Emitida");

    const other = (await createInvoiceCall(db, { user, shift, employee })).id as string;
    invoice = other;
    await cashPayment({ amount: 1000, markPaid: true });
    expect((await invoiceRow(other)).status).toBe("Pagada");
  });

  it("is idempotent by uq_invoice_payments_invoice_idempotency_key: a replay rolls back both rows", async () => {
    const key = randomUUID();
    await cashPayment({ amount: 4000, markPaid: false, key });
    const replay = await pgError(cashPayment({ amount: 4000, markPaid: false, key }));
    expect(replay.code).toBe("23505");
    expect(replay.message).toContain("uq_invoice_payments_invoice_idempotency_key");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1`, [invoice])).toBe(1);
    expect(await count(db, `SELECT 1 FROM public.payments WHERE invoice_id = $1`, [invoice])).toBe(1);
  });

  it("requires the mark (PAYMENT_INVALID) and an open shift (SHIFT_CLOSED / SHIFT_NOT_FOUND)", async () => {
    const noMark = await pgError(
      rpc(
        db,
        "cash_invoice_payment_atomic",
        [shift, invoice, user, new Date().toISOString(), false, false,
          JSON.stringify({ method_code: "efectivo", amount: 1000, fee_percent: 0, fee_amount: 0 })],
        ["uuid", "uuid", "uuid", "timestamptz", "boolean", "boolean", "jsonb"],
      ),
    );
    expect(noMark.message).toBe("PAYMENT_INVALID");
    expect((await pgError(cashPayment({ amount: 1000, markPaid: false, shiftId: randomUUID() }))).message).toBe("SHIFT_NOT_FOUND");

    await closeShiftCall(db, { shift, user });
    expect((await pgError(cashPayment({ amount: 1000, markPaid: true }))).message).toBe("SHIFT_CLOSED");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1`, [invoice])).toBe(0);
    expect((await invoiceRow()).status).toBe("Emitida");
  });

  it("rejects an overpayment through the 031 cap (P0001) and rejects an annulled invoice", async () => {
    await cashPayment({ amount: 6000, markPaid: false });
    const over = await pgError(cashPayment({ amount: 4001, markPaid: true }));
    expect(over.code).toBe("P0001");
    expect(over.message).toContain("El cobro supera el neto facturado");
    expect((await invoiceRow()).status).toBe("Emitida");
    expect(await count(db, `SELECT 1 FROM public.payments WHERE invoice_id = $1`, [invoice])).toBe(1);

    // The card fee rides on top of the net cap: net 4000 + fee 200 fits exactly.
    await cashPayment({ amount: 4000, fee: 200, markPaid: true, method: "tarjeta" });
    expect((await invoiceRow()).status).toBe("Pagada");

    const annulled = (await createInvoiceCall(db, { user, shift, employee })).id as string;
    await rpc(db, "invoice_annul_atomic", [annulled, user, new Date().toISOString(), "x", "Emitida", "[]"],
      ["uuid", "uuid", "timestamptz", "text", "text", "jsonb"]);
    invoice = annulled;
    expect((await pgError(cashPayment({ amount: 1000, markPaid: false }))).message).toBe("ANNUL_INVALID");
  });

  it("links the invoice to the collecting shift only when p_set_shift is true", async () => {
    await db.query(`UPDATE public.invoices SET cash_shift_id = NULL WHERE id = $1`, [invoice]);
    await cashPayment({ amount: 1000, markPaid: false, setShift: false });
    expect((await invoiceRow()).cash_shift_id).toBeNull();
    await cashPayment({ amount: 1000, markPaid: false, setShift: true });
    expect((await invoiceRow()).cash_shift_id).toBe(shift);
  });
});

describe("invoice_split_payment_atomic", () => {
  it("writes every portion with the mark only on the first, and closes the invoice", async () => {
    const written = await splitPayment({ portions: [6000, 4000], markPaid: true });
    expect(written.portions).toBe(2);
    expect(written.invoice).toMatchObject({ status: "Pagada", closed_by: user });
    const rows = await db.query<{ method_code: string; marked: boolean }>(
      `SELECT method_code, idempotency_key IS NOT NULL AS marked FROM public.invoice_payments WHERE invoice_id = $1 ORDER BY method_code`,
      [invoice],
    );
    expect(rows.rows).toEqual([
      { method_code: "efectivo", marked: true },
      { method_code: "nequi", marked: false },
    ]);
    // The split path writes no drawer-ledger row in `payments`.
    expect(await count(db, `SELECT 1 FROM public.payments WHERE invoice_id = $1`, [invoice])).toBe(0);
  });

  it("is idempotent by the first portion's mark: a replay rolls back all portions", async () => {
    const key = randomUUID();
    await splitPayment({ portions: [3000, 2000], markPaid: false, key });
    const replay = await pgError(splitPayment({ portions: [3000, 2000], markPaid: false, key }));
    expect(replay.code).toBe("23505");
    expect(replay.message).toContain("uq_invoice_payments_invoice_idempotency_key");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1`, [invoice])).toBe(2);
  });

  it("rejects an overpayment as a whole: no portion survives", async () => {
    const over = await pgError(splitPayment({ portions: [6000, 4001], markPaid: true }));
    expect(over.code).toBe("P0001");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments WHERE invoice_id = $1`, [invoice])).toBe(0);
    expect((await invoiceRow()).status).toBe("Emitida");
  });

  it("rejects a closed shift, portions of another shift, and two marks", async () => {
    const otherShift = randomUUID();
    expect((await pgError(splitPayment({ portions: [1000], markPaid: false, portionShift: otherShift }))).message).toBe("PAYMENT_INVALID");
    const twoMarks = await pgError(
      rpc(
        db,
        "invoice_split_payment_atomic",
        [invoice, shift, user, new Date().toISOString(), false,
          JSON.stringify([1000, 1000].map((amount) => ({
            method_code: "efectivo", amount, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: randomUUID(),
          })))],
        ["uuid", "uuid", "uuid", "timestamptz", "boolean", "jsonb"],
      ),
    );
    expect(twoMarks.message).toBe("PAYMENT_INVALID");

    await closeShiftCall(db, { shift, user });
    expect((await pgError(splitPayment({ portions: [1000], markPaid: true }))).message).toBe("SHIFT_CLOSED");
    expect(await count(db, `SELECT 1 FROM public.invoice_payments`)).toBe(0);
  });
});

describe("cash_close_shift_atomic: ARQUEO_STALE per source", () => {
  const zero = { payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 };
  const stale = async () => {
    const error = await pgError(closeShiftCall(db, { shift, user, collectionCounts: zero }));
    expect(error.message).toBe("ARQUEO_STALE");
    expect((await one<{ status: string }>(db, `SELECT status FROM public.cash_shifts WHERE id = $1`, [shift])).status).toBe("abierto");
  };

  it("invoice_payments: a portion attributed to the shift", async () => {
    await splitPayment({ portions: [1000], markPaid: false });
    await stale();
    const closed = await closeShiftCall(db, { shift, user, collectionCounts: { ...zero, invoice_payments: 1 } });
    expect(closed.status).toBe("cerrado");
  });

  it("invoice_payments: a historical row without shift whose invoice belongs to the shift", async () => {
    await db.query(
      `INSERT INTO public.invoice_payments (invoice_id, method_code, amount, cash_shift_id) VALUES ($1, 'efectivo', 1000, NULL)`,
      [invoice],
    );
    await stale();
  });

  it("commission_payouts: an immediate payout of the shift", async () => {
    await db.query(
      `INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate)
       VALUES ($1, $2, $3, 'efectivo', 10000, 500, 1000)`,
      [employee, invoice, shift],
    );
    await stale();
  });

  it("voucher_requests: only approved vouchers with a method count", async () => {
    // A pending voucher without method does not change the signed number: the close goes through.
    await db.query(
      `INSERT INTO public.voucher_requests (employee_id, amount, status, cash_shift_id) VALUES ($1, 1000, 'pendiente', $2)`,
      [employee, shift],
    );
    await db.query(
      `INSERT INTO public.voucher_requests (employee_id, amount, status, approved_by, method_code, cash_shift_id)
       VALUES ($1, 1000, 'aprobada', $2, 'efectivo', $3)`,
      [employee, user, shift],
    );
    await stale();
    const closed = await closeShiftCall(db, { shift, user, collectionCounts: { ...zero, voucher_requests: 1 } });
    expect(closed.status).toBe("cerrado");
  });
});

describe("trg_commission_payouts_cap (check_commission_payouts_cap)", () => {
  const payout = (amount: number, earned: number | null, key: string | null = null) =>
    db.query(
      `INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate, paid_by, idempotency_key)
       VALUES ($1, $2, $3, 'efectivo', 10000, $4, $5, $6, $7)`,
      [employee, invoice, shift, amount, earned, user, key],
    );

  it("accepts partial payouts up to the earned amount and rejects the excess", async () => {
    await payout(600, 1000);
    await payout(400, 1000);
    const over = await pgError(payout(1, 1000));
    expect(over.code).toBe("P0001");
    expect(over.message).toContain("El pago supera la comisión ganada del par");
  });

  it("rejects a row without earned_immediate (a write that skipped the service)", async () => {
    const error = await pgError(payout(100, null));
    expect(error.code).toBe("P0001");
    expect(error.message).toContain("earned_immediate");
  });

  it("is idempotent per (invoice, employee, key) through the partial unique index", async () => {
    const key = randomUUID();
    await payout(100, 1000, key);
    expect((await pgError(payout(100, 1000, key))).code).toBe("23505");
  });
});
