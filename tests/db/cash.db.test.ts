import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { closeShiftCall, countLines, insertUser, openShift, registerId } from "./fixtures";

let db: Db;
let register: string;
let user: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  register = await registerId(db);
  user = await insertUser(db);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

describe("cash_open_shift_atomic", () => {
  it("opens the shift with its opening count and rejects a second open shift on the same register", async () => {
    const shift = await openShift(db, register, user);
    const row = await one<{ status: string; expected_cash: string }>(
      db,
      `SELECT status, expected_cash::text FROM public.cash_shifts WHERE id = $1`,
      [shift],
    );
    expect(row).toEqual({ status: "abierto", expected_cash: "0.00" });
    expect(await count(db, `SELECT 1 FROM public.cash_shift_counts WHERE shift_id = $1 AND phase = 'apertura'`, [shift])).toBe(6);

    const error = await pgError(openShift(db, register, user));
    expect(error.message).toBe("SHIFT_ALREADY_OPEN");
    expect(await count(db, `SELECT 1 FROM public.cash_shifts`)).toBe(1);
  });

  it("the partial unique index is the final barrier against a second open shift", async () => {
    await openShift(db, register, user);
    const error = await pgError(
      db.query(`INSERT INTO public.cash_shifts (cash_register_id, opened_by, opening_base) VALUES ($1, $2, 0)`, [register, user]),
    );
    expect(error.code).toBe("23505");
    expect(error.constraint ?? error.message).toContain("uq_cash_shifts_open_per_register");
  });

  describe("009 drawer bounds", () => {
    /** Drawer by 1-peso denomination so any whole amount is a valid line. */
    const drawerLines = (cash: number) => [
      { method_code: "efectivo", denomination: 1, quantity: cash, amount: cash },
      ...countLines().slice(1),
    ];
    const open = (cash: number) =>
      rpc<Record<string, unknown>>(db, "cash_open_shift_atomic", [register, user, cash, JSON.stringify(drawerLines(cash))], ["uuid", "uuid", "numeric", "jsonb"]);
    const closeOpen = async (baseLeft: number): Promise<string> => {
      const shift = await one<{ id: string }>(db, `SELECT id FROM public.cash_shifts WHERE status = 'abierto'`);
      await db.query(`UPDATE public.cash_shifts SET status = 'cerrado', closed_at = now(), counted_cash = $2, base_left = $2, cash_withdrawn = 0, base_difference = 0 WHERE id = $1`, [shift.id, baseLeft]);
      return shift.id;
    };

    it("first opening accepts 0 and B, rejects B + 1 without writing", async () => {
      expect((await pgError(open(200001))).message).toBe("OPENING_ABOVE_BASE");
      expect(await count(db, `SELECT 1 FROM public.cash_shifts`)).toBe(0);
      expect(await open(0)).toMatchObject({ status: "abierto" });
      await closeOpen(0);
      expect(await open(200000)).toMatchObject({ status: "abierto" });
    });

    it("later opening is bounded below by base_left, and a recount wins", async () => {
      await open(200000);
      const closed = await closeOpen(150000);
      expect((await pgError(open(149999))).message).toBe("OPENING_BELOW_PREVIOUS_CLOSE");
      expect(await open(150000)).toMatchObject({ status: "abierto" });
      await db.query(`DELETE FROM public.cash_shifts WHERE status = 'abierto'`);

      await db.query(
        `INSERT INTO public.cash_shift_recounts (shift_id, previous_counted_cash, previous_base_left, previous_cash_withdrawn, previous_base_difference, counted_cash, base_left, cash_withdrawn, base_difference, reason, recounted_by)
         VALUES ($1, 150000, 150000, 0, 0, 100000, 100000, 0, 0, 'Reconteo', $2)`,
        [closed, user],
      );
      expect((await pgError(open(99999))).message).toBe("OPENING_BELOW_PREVIOUS_CLOSE");
      expect(await open(100000)).toMatchObject({ status: "abierto" });
    });

    it("rejects a previous base above the configured base", async () => {
      await open(200000);
      await closeOpen(200000);
      await db.query(`UPDATE public.cash_registers SET base_configurada = 100000 WHERE id = $1`, [register]);
      expect((await pgError(open(100000))).message).toBe("OPENING_BASE_CONFLICT");
    });
  });

  it("accepts the reproduced 200000 drawer payload with declared digital zeroes", async () => {
    const payload = [
      { method_code: "efectivo", denomination: 100000, quantity: 2, amount: 200000 },
      { method_code: "transferencia_normal", denomination: null, quantity: 1, amount: 0 },
      { method_code: "nequi", denomination: null, quantity: 1, amount: 0 },
      { method_code: "daviplata", denomination: null, quantity: 1, amount: 0 },
      { method_code: "bre-b", denomination: null, quantity: 1, amount: 0 },
      { method_code: "tarjeta", denomination: null, quantity: 1, amount: 0 },
    ];
    expect(await rpc(db, "cash_open_shift_atomic", [register, user, 200000, JSON.stringify(payload)], ["uuid", "uuid", "numeric", "jsonb"])).toMatchObject({ status: "abierto", opening_base: 200000 });
  });

  it("rejects malformed input and an unknown register without writing", async () => {
    const call = (registerArg: string, counts: unknown) =>
      rpc(db, "cash_open_shift_atomic", [registerArg, user, 100, JSON.stringify(counts)], ["uuid", "uuid", "numeric", "jsonb"]);
    expect((await pgError(call(register, []))).message).toBe("SHIFT_INVALID");
    // digital line (no denomination) must declare quantity 1
    expect((await pgError(call(register, [{ method_code: "nequi", quantity: 2, amount: 10 }]))).message).toBe("SHIFT_INVALID");
    expect((await pgError(call("00000000-0000-0000-0000-000000000000", countLines()))).message).toBe("SHIFT_REGISTER_NOT_FOUND");
    expect(await count(db, `SELECT 1 FROM public.cash_shifts`)).toBe(0);
  });
});

describe("cash_close_shift_atomic", () => {
  it("closes an open shift writing the amounts verbatim and the closing count", async () => {
    const shift = await openShift(db, register, user);
    const closed = await closeShiftCall(db, { shift, user, counted: 250000 });
    expect(closed).toMatchObject({ status: "cerrado", counted_cash: 250000, base_left: 200000, cash_withdrawn: 50000, closed_by: user });
    expect(await count(db, `SELECT 1 FROM public.cash_shift_counts WHERE shift_id = $1 AND phase = 'cierre'`, [shift])).toBe(6);
  });

  it("rejects with ARQUEO_STALE when a collection source changed after the read, writing nothing", async () => {
    const shift = await openShift(db, register, user);
    // A payment confirmed between the service read (0 payments) and the lock.
    await db.query(
      `INSERT INTO public.payments (cash_shift_id, method_code, amount, user_id) VALUES ($1, 'efectivo', 1000, $2)`,
      [shift, user],
    );
    const error = await pgError(closeShiftCall(db, { shift, user }));
    expect(error.message).toBe("ARQUEO_STALE");
    const row = await one<{ status: string }>(db, `SELECT status FROM public.cash_shifts WHERE id = $1`, [shift]);
    expect(row.status).toBe("abierto");
    expect(await count(db, `SELECT 1 FROM public.cash_shift_counts WHERE shift_id = $1 AND phase = 'cierre'`, [shift])).toBe(0);

    // With the fresh token the same close goes through.
    const closed = await closeShiftCall(db, {
      shift,
      user,
      collectionCounts: { payments: 1, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 },
    });
    expect(closed.status).toBe("cerrado");
  });

  it("requires the four-key token (missing key is SHIFT_INVALID) and rejects a second close", async () => {
    const shift = await openShift(db, register, user);
    const partial = await pgError(closeShiftCall(db, { shift, user, collectionCounts: { payments: 0, invoice_payments: 0 } }));
    expect(partial.message).toBe("SHIFT_INVALID");
    await closeShiftCall(db, { shift, user });
    expect((await pgError(closeShiftCall(db, { shift, user }))).message).toBe("SHIFT_ALREADY_CLOSED");
  });

  it("lets the expected_cash >= 0 CHECK speak (the service maps it to CASH_OUT_EXCEEDS_COLLECTED)", async () => {
    const shift = await openShift(db, register, user);
    const error = await pgError(
      rpc(
        db,
        "cash_close_shift_atomic",
        [
          shift,
          user,
          new Date().toISOString(),
          JSON.stringify({ expected_cash: -1, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0 }),
          JSON.stringify(countLines()),
          JSON.stringify({ payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 }),
        ],
        ["uuid", "uuid", "timestamptz", "jsonb", "jsonb", "jsonb"],
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.constraint).toBe("cash_shifts_expected_cash_check");
  });
});

describe("cash_recount_shift_atomic", () => {
  const recount = (shift: string, counts = countLines(210000)) =>
    rpc<Record<string, unknown>>(
      db,
      "cash_recount_shift_atomic",
      [
        shift,
        user,
        JSON.stringify({
          previous_counted_cash: 200000,
          previous_base_left: 200000,
          previous_cash_withdrawn: 0,
          previous_base_difference: 0,
          counted_cash: 210000,
          base_left: 200000,
          cash_withdrawn: 10000,
          base_difference: 0,
          reason: "Billete mal contado",
        }),
        JSON.stringify(counts),
      ],
      ["uuid", "uuid", "jsonb", "jsonb"],
    );

  it("only recounts a closed shift, once, and leaves the signed close untouched", async () => {
    const shift = await openShift(db, register, user);
    expect((await pgError(recount(shift))).message).toBe("SHIFT_NOT_CLOSED");

    await closeShiftCall(db, { shift, user });
    const written = await recount(shift);
    expect(written).toMatchObject({ shift_id: shift, counted_cash: 210000, previous_counted_cash: 200000, reason: "Billete mal contado" });
    expect(await count(db, `SELECT 1 FROM public.cash_shift_counts WHERE shift_id = $1 AND phase = 'reconteo'`, [shift])).toBe(6);
    const closed = await one<{ counted_cash: string }>(db, `SELECT counted_cash::text FROM public.cash_shifts WHERE id = $1`, [shift]);
    expect(closed.counted_cash).toBe("200000.00");

    expect((await pgError(recount(shift))).message).toBe("ALREADY_RECOUNTED");
  });

  it("requires a cash line in the recount", async () => {
    const shift = await openShift(db, register, user);
    await closeShiftCall(db, { shift, user });
    const error = await pgError(recount(shift, [{ method_code: "nequi", denomination: null, quantity: 1, amount: 0 }]));
    expect(error.message).toBe("SHIFT_INVALID");
  });
});
