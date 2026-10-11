/**
 * Payroll SERVICE on both engines with its real admin/cash/audit collaborators.
 * With DB_ENGINE=postgres the Supabase client throws and must never be called;
 * the default engine must keep working through Supabase (PostgREST double).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { insertEmployee, insertPeriod, insertUser, openShift, registerId } from "./fixtures";

const engine = vi.hoisted(() => ({ pg: null as unknown as Db, supabaseCalls: 0 }));

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/src/shared/lib/supabase/server", async () => {
  const { postgrestDouble } = await import("./postgrest-double");
  return {
    createAdminClient: () => {
      engine.supabaseCalls += 1;
      if (process.env.DB_ENGINE === "postgres") throw new Error("Supabase used on the postgres engine");
      return postgrestDouble(engine.pg);
    },
  };
});
vi.mock("@/src/shared/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/src/shared/db/schema");
  return { getDb: () => drizzle({ client: engine.pg, schema }) };
});

let user: string;
let employee: string;
let shift: string;

const ORIGINAL_ENV = { DB_ENGINE: process.env.DB_ENGINE, DATABASE_URL: process.env.DATABASE_URL };

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  // Each engine's stubs must be gone before the next test starts.
  expect({ DB_ENGINE: process.env.DB_ENGINE, DATABASE_URL: process.env.DATABASE_URL }).toEqual(ORIGINAL_ENV);
  engine.supabaseCalls = 0;
  engine.pg = await freshDb();
  user = await insertUser(engine.pg);
  employee = await insertEmployee(engine.pg);
  shift = await openShift(engine.pg, await registerId(engine.pg), user);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

describe.each(["supabase", "postgres"] as const)("payroll service on %s", (name) => {
  beforeEach(() => {
    vi.stubEnv("DB_ENGINE", name === "postgres" ? "postgres" : "");
    vi.stubEnv("DATABASE_URL", name === "postgres" ? "postgres://unused.invalid/db" : "");
  });
  afterEach(() => {
    if (name === "postgres") expect(engine.supabaseCalls).toBe(0);
    else expect(engine.supabaseCalls).toBeGreaterThan(0);
  });
  it("calculates the active roster through the dual admin catalog", async () => {
    const period = await insertPeriod(engine.pg, { start: "2026-09-01", end: "2026-09-15" });
    const { calculatePayroll } = await import("@/src/features/payroll/service");

    const detail = await calculatePayroll(period, { adjustments: [] }, { userId: user });

    expect(detail.items).toEqual(expect.arrayContaining([expect.objectContaining({ employee_id: employee })]));
  });

  it("requests then approves a voucher through real cash and admin services", async () => {
    const { approveVoucher, requestVoucher } = await import("@/src/features/payroll/service");
    const requested = await requestVoucher(
      {
        employee_id: employee,
        amount: 1000,
        method_code: "efectivo",
        request_date: "2026-09-15",
        idempotency_key: "9620e61c-b0b4-45ae-9cc8-6cd83998e0c6",
      },
      { userId: user, roles: ["admin"] },
    );
    expect(requested.voucher).toMatchObject({ cash_shift_id: shift, status: "aprobada" });

    const pending = await engine.pg.query<{ id: string }>(
      `INSERT INTO public.voucher_requests (employee_id, amount, status, method_code, cash_shift_id)
       VALUES ($1, 1000, 'pendiente', 'efectivo', $2) RETURNING id`,
      [employee, shift],
    );
    const approved = await approveVoucher(pending.rows[0].id, { observation: "Aprobado" }, { userId: user });
    expect(approved.status).toBe("aprobada");
    const stored = await engine.pg.query<{ status: string; approved_by: string }>(
      `SELECT status, approved_by FROM public.voucher_requests WHERE id = $1`,
      [pending.rows[0].id],
    );
    expect(stored.rows[0]).toEqual({ status: "aprobada", approved_by: user });
  });
});
