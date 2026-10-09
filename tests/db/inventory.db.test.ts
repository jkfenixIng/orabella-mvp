import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { insertProduct, insertUser } from "./fixtures";

let db: Db;
let user: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const move = (product: string, type: string, qty: number, key: string | null = null) =>
  db.query(
    `INSERT INTO public.inventory_movements (product_id, type, qty, reason, user_id, idempotency_key) VALUES ($1, $2, $3, 'prueba', $4, $5)`,
    [product, type, qty, user, key],
  );
const stock = async (product: string): Promise<number> =>
  (await one<{ stock_qty: number }>(db, `SELECT stock_qty FROM public.products WHERE id = $1`, [product])).stock_qty;

describe("trg_inventory_apply_stock / trg_inventory_no_negative", () => {
  it("IN adds, OUT subtracts and ADJUST sets the absolute stock", async () => {
    const product = await insertProduct(db, 0);
    await move(product, "IN", 10);
    expect(await stock(product)).toBe(10);
    await move(product, "OUT", 3);
    expect(await stock(product)).toBe(7);
    await move(product, "ADJUST", 2);
    expect(await stock(product)).toBe(2);
  });

  it("rejects an OUT larger than the stock and writes no movement", async () => {
    const product = await insertProduct(db, 2);
    const error = await pgError(move(product, "OUT", 3));
    expect(error.message).toBe("INSUFFICIENT_STOCK");
    expect(await stock(product)).toBe(2);
    expect(await count(db, `SELECT 1 FROM public.inventory_movements WHERE product_id = $1`, [product])).toBe(0);
  });

  it("an OUT on an unknown product fails in the trigger before the foreign key", async () => {
    expect((await pgError(move(randomUUID(), "OUT", 1))).message).toBe("PRODUCT_NOT_FOUND");
  });

  it("characterization: ADJUST below zero is caught by the products CHECK, not the trigger", async () => {
    // ADJUST writes `stock_qty = NEW.qty`, and qty > 0 by its own CHECK, so the
    // only path to a negative stock is direct: the table CHECK is the barrier.
    const product = await insertProduct(db, 1);
    const error = await pgError(db.query(`UPDATE public.products SET stock_qty = -1 WHERE id = $1`, [product]));
    expect(error.constraint).toBe("products_stock_qty_check");
    expect((await pgError(move(product, "ADJUST", 0))).constraint).toBe("inventory_movements_qty_check");
  });

  it("the partial unique index makes a keyed movement idempotent per product", async () => {
    const product = await insertProduct(db, 0);
    const key = randomUUID();
    await move(product, "IN", 5, key);
    const replay = await pgError(move(product, "IN", 5, key));
    expect(replay.code).toBe("23505");
    expect(await stock(product)).toBe(5);
    // NULL keys are outside the index: unkeyed movements never collide.
    await move(product, "IN", 1);
    await move(product, "IN", 1);
    expect(await stock(product)).toBe(7);
  });
});

describe("deduct_stock_atomic", () => {
  const deduct = (items: unknown[]) =>
    rpc<number>(db, "deduct_stock_atomic", [user, "Venta", JSON.stringify(items)], ["uuid", "text", "jsonb"]);

  it("deducts every product or none", async () => {
    const a = await insertProduct(db, 5);
    const b = await insertProduct(db, 1);
    expect(await deduct([{ product_id: a, qty: 2 }, { product_id: b, qty: 1 }])).toBe(2);
    expect([await stock(a), await stock(b)]).toEqual([3, 0]);

    const error = await pgError(deduct([{ product_id: a, qty: 1 }, { product_id: b, qty: 1 }]));
    expect(error.message).toBe("INSUFFICIENT_STOCK");
    expect([await stock(a), await stock(b)]).toEqual([3, 0]);
  });

  it("rejects an empty plan, a repeated product and an unknown product", async () => {
    const a = await insertProduct(db, 5);
    expect((await pgError(deduct([]))).message).toBe("DEDUCTION_INVALID");
    expect((await pgError(deduct([{ product_id: a, qty: 1 }, { product_id: a, qty: 1 }]))).message).toBe("DEDUCTION_INVALID");
    expect((await pgError(deduct([{ product_id: randomUUID(), qty: 1 }]))).message).toBe("PRODUCT_NOT_FOUND");
    expect(await stock(a)).toBe(5);
  });
});
