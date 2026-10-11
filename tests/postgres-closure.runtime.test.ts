import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startCluster, stopCluster, type Cluster } from "./concurrency/cluster";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

let cluster: Cluster;
let sql: Sql;
let userId: string;
let employeeId: string;
let productId: string;

async function scalar<T>(query: Promise<readonly T[]>): Promise<T> {
  const [row] = await query;
  if (!row) throw new Error("expected a row");
  return row;
}

beforeAll(async () => {
  cluster = await startCluster();
  sql = postgres(cluster.url, { max: 1 });
  process.env.DB_ENGINE = "postgres";
  process.env.DATABASE_URL = cluster.url;
  const { hashPassword } = await import("@/src/features/auth/service");
  const user = await scalar(sql<{ id: string }[]>`
    INSERT INTO public.users (sede_id, email, id_type, id_number, password_hash, full_name)
    VALUES ((SELECT id FROM public.sedes LIMIT 1), 'closure@test.local', 'CC', 'closure-user', ${await hashPassword("Clave123")}, 'Closure User')
    RETURNING id
  `);
  userId = user.id;
  await sql`INSERT INTO public.user_roles (user_id, role_id) SELECT ${userId}::uuid, id FROM public.roles WHERE code = 'admin'`;
  const employee = await scalar(sql<{ id: string }[]>`
    INSERT INTO public.employees (document, full_name, pay_type, salary_fixed)
    VALUES ('closure-employee', 'Closure Employee', 'fijo', 1000000)
    RETURNING id
  `);
  employeeId = employee.id;
  const product = await scalar(sql<{ id: string }[]>`
    INSERT INTO public.products (sku, name, stock_qty, sale_price)
    VALUES ('CLOSURE-1', 'Closure Product', 10, 10000)
    RETURNING id
  `);
  productId = product.id;
}, 120_000);

afterAll(async () => {
  const holder = globalThis as typeof globalThis & { __orabellaDb?: { sql: { end(options?: unknown): Promise<void> } } };
  await holder.__orabellaDb?.sql.end({ timeout: 5 });
  delete holder.__orabellaDb;
  await sql.end({ timeout: 5 });
  await stopCluster(cluster);
  delete process.env.DB_ENGINE;
  delete process.env.DATABASE_URL;
}, 120_000);

describe("DB_ENGINE=postgres closure on an ephemeral PostgreSQL cluster", () => {
  it("runs auth login/session/reset/admin reset without Supabase configuration", async () => {
    const auth = await import("@/src/features/auth/service");
    const login = await auth.loginWithDocument({ documento: "closure-user", password: "Clave123" });
    expect((await auth.getSessionUser(login.sessionToken))?.user.id).toBe(userId);
    const reset = await auth.requestPasswordReset({ documento: "closure-user" });
    await expect(auth.confirmPasswordReset({ token: reset.devToken, nueva: "Nueva123" })).resolves.toEqual({ changed: true });
    await expect(auth.loginWithDocument({ documento: "closure-user", password: "Nueva123" })).resolves.toMatchObject({ user: { id: userId } });
    await expect(auth.adminResetUserPassword(userId, userId)).resolves.toEqual({ user_id: userId });
  }, 30_000);

  it("runs admin catalogs, inventory, cash, billing, commissions, and payroll through PostgreSQL adapters", async () => {
    const [admin, inventory, cash, billing, commissions, payroll] = await Promise.all([
      import("@/src/features/admin/service"),
      import("@/src/features/inventory/service"),
      import("@/src/features/cash/service"),
      import("@/src/features/billing/service"),
      import("@/src/features/commissions/service"),
      import("@/src/features/payroll/service"),
    ]);
    expect((await admin.listPaymentMethods()).length).toBeGreaterThan(0);
    await expect(admin.upsertTaxConfig({ code: "otro", name: "Closure", percent: 0 })).resolves.toMatchObject({ code: "otro" });
    await expect(inventory.registerMovement({ product_id: productId, type: "IN", qty: 1, reason: "closure" }, { userId })).resolves.toMatchObject({ stock_qty: 11 });

    const register = await scalar(sql<{ id: string }[]>`SELECT id FROM public.cash_registers ORDER BY name LIMIT 1`);
    const counts = [
      { method_code: "efectivo", denomination: 10000, quantity: 20, amount: 200000 },
      ...["transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"].map((method_code) => ({ method_code, denomination: null, quantity: 1, amount: 0 })),
    ];
    const actor = { userId, sedeId: "single", roles: ["admin" as const] };
    const opened = await cash.openShift({ cash_register_id: register.id, counts }, actor);
    const invoice = await billing.createInvoice({
      client_name: "Closure",
      discount: 0,
      idempotency_key: "7d9ecb25-a9f9-4e1b-ae23-1b0e4ee7f32d",
      items: [{ item_type: "producto", product_id: productId, employee_id: employeeId, qty: 1, unit_price: 10000, discount: 0, no_commission: false }],
      payments: [],
    }, actor);
    await expect(commissions.upsertCommissionRule({ item_type: "producto", item_id: productId, employee_id: employeeId, amount: 1000 })).resolves.toMatchObject({ amount: 1000 });
    await expect(payroll.requestVoucher({ employee_id: employeeId, amount: 1000, method_code: "efectivo", idempotency_key: "73e47cf1-27e9-43ee-8656-0ac3b3a1dcbf" }, actor)).resolves.toMatchObject({ voucher: { cash_shift_id: opened.shift.id } });
    expect(invoice.invoice.cash_shift_id).toBe(opened.shift.id);
  }, 30_000);
});
