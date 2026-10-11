/**
 * Row fixtures for the characterization tests. Payload builders mirror the shape
 * each service sends to its RPC (src/features/*\/service.ts); amounts are plain
 * numbers because the services send numbers, and the RPCs read them as text.
 */
import { randomUUID } from "node:crypto";
import { one, rpc, type Db } from "./harness";

let sequence = 0;
const next = (): number => ++sequence;

export async function insertUser(db: Db, overrides: { passwordHash?: string } = {}): Promise<string> {
  const n = next();
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO public.users (id_type, id_number, password_hash, full_name, email)
     VALUES ('CC', $1, $2, $3, $4) RETURNING id`,
    [`ID-${n}`, overrides.passwordHash ?? "scrypt$test$hash", `Usuario ${n}`, `u${n}@test.local`],
  );
  return row.id;
}

export async function insertEmployee(db: Db): Promise<string> {
  const n = next();
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO public.employees (document, pay_type, full_name, salary_fixed)
     VALUES ($1, 'fijo', $2, 1000000) RETURNING id`,
    [`DOC-${n}`, `Empleado ${n}`],
  );
  return row.id;
}

export async function insertProduct(db: Db, stock = 0): Promise<string> {
  const n = next();
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO public.products (sku, name, stock_qty, sale_price) VALUES ($1, $2, $3, 10000) RETURNING id`,
    [`SKU-${n}`, `Producto ${n}`, stock],
  );
  return row.id;
}

/** The single cash register the catalog seeds ('Caja única'). */
export async function registerId(db: Db): Promise<string> {
  return (await one<{ id: string }>(db, `SELECT id FROM public.cash_registers ORDER BY name LIMIT 1`)).id;
}

export async function methodId(db: Db, code: string): Promise<string> {
  return (await one<{ id: string }>(db, `SELECT id FROM public.payment_methods WHERE code = $1`, [code])).id;
}

/** The catalog's declared-total methods (all arqueable after 003's backfill). */
export const DECLARED_TOTAL_METHODS = ["transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"];

/**
 * `countLines` (cash/service.ts): the cash line by denomination + one declared
 * total per arqueable method. Since 003 an opening must count every active
 * arqueable method (its frozen base).
 */
export function countLines(cash = 200000): Array<Record<string, unknown>> {
  return [
    { method_code: "efectivo", denomination: 10000, quantity: cash / 10000, amount: cash },
    ...DECLARED_TOTAL_METHODS.map((method_code) => ({ method_code, denomination: null, quantity: 1, amount: 0 })),
  ];
}

export async function openShift(db: Db, register: string, user: string, base = 200000): Promise<string> {
  const shift = await rpc<{ id: string }>(
    db,
    "cash_open_shift_atomic",
    [register, user, base, JSON.stringify(countLines(base))],
    ["uuid", "uuid", "numeric", "jsonb"],
  );
  return shift.id;
}

export interface CloseArgs {
  shift: string;
  user: string;
  collectionCounts?: Record<string, number>;
  counted?: number;
}

/** The `p_close` envelope of `closeShift` (cash/service.ts), already resolved. */
export function closeShiftCall(db: Db, args: CloseArgs): Promise<Record<string, unknown>> {
  const counted = args.counted ?? 200000;
  return rpc(
    db,
    "cash_close_shift_atomic",
    [
      args.shift,
      args.user,
      new Date().toISOString(),
      JSON.stringify({
        expected_cash: 0,
        counted_cash: counted,
        base_left: 200000,
        cash_withdrawn: counted - 200000,
        base_difference: 0,
        observation: null,
      }),
      JSON.stringify(countLines(counted)),
      JSON.stringify(
        args.collectionCounts ?? { payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 },
      ),
    ],
    ["uuid", "uuid", "timestamptz", "jsonb", "jsonb", "jsonb"],
  );
}

export interface InvoiceArgs {
  user: string;
  shift: string;
  employee: string;
  idempotencyKey?: string;
  /** Product line: sells `qty` units at 10.000 and deducts them from stock. */
  product?: { id: string; qty: number };
  /** Paid portions in efectivo; omitted = 'Emitida' without payments. */
  paid?: boolean;
}

/** `invoice_create_atomic` with the payload shape of `createInvoice` (billing/service.ts). */
export function createInvoiceCall(db: Db, args: InvoiceArgs): Promise<Record<string, unknown>> {
  const qty = args.product?.qty ?? 1;
  const subtotal = 10000 * qty;
  const status = args.paid ? "Pagada" : "Emitida";
  const item = args.product
    ? { item_type: "producto", product_id: args.product.id, service_id: null, custom_name: null }
    : { item_type: "custom", product_id: null, service_id: null, custom_name: "Servicio libre" };
  return rpc(
    db,
    "invoice_create_atomic",
    [
      args.user,
      args.shift,
      args.idempotencyKey ?? randomUUID(),
      JSON.stringify({
        client_name: "Cliente",
        client_document: null,
        subtotal,
        discount: 0,
        tax: 0,
        surcharge: 0,
        total: subtotal,
        status,
        closed_by: args.paid ? args.user : null,
        closed_at: args.paid ? new Date().toISOString() : null,
      }),
      JSON.stringify([
        {
          ...item,
          employee_id: args.employee,
          qty,
          unit_price: 10000,
          discount: 0,
          no_commission: false,
          commission_value: null,
          commission_mode: "comision",
          commission_percent_override: null,
          subtotal,
        },
      ]),
      JSON.stringify([]),
      JSON.stringify(
        args.paid
          ? [{ method_id: null, method_code: "efectivo", amount: subtotal, fee_percent: 0, fee_amount: 0 }]
          : [],
      ),
      "Venta factura #{consecutivo} - Cliente",
      JSON.stringify(args.product ? [{ product_id: args.product.id, qty }] : []),
    ],
    ["uuid", "uuid", "text", "jsonb", "jsonb", "jsonb", "jsonb", "text", "jsonb"],
  );
}

export async function insertPeriod(
  db: Db,
  args: { start: string; end: string; status?: "borrador" | "cerrado"; frequency?: string | null },
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO public.payroll_periods (start_date, end_date, status, closed_at, frequency)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'cerrado' THEN now() END, $4) RETURNING id`,
    [args.start, args.end, args.status ?? "borrador", args.frequency ?? null],
  );
  return row.id;
}

export async function insertVoucher(
  db: Db,
  employee: string,
  status: "pendiente" | "aprobada" | "descontada" = "aprobada",
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO public.voucher_requests (employee_id, amount, status) VALUES ($1, 50000, $2) RETURNING id`,
    [employee, status],
  );
  return row.id;
}

/** One `payroll_items` payload line as `computePayrollLines` builds it (payroll/service.ts). */
export function payrollItem(
  period: string,
  employee: string,
  extra: { voucherExcess?: number; debtRemainder?: number } = {},
): Record<string, unknown> {
  return {
    period_id: period,
    employee_id: employee,
    base_fixed: 500000,
    commissions: 0,
    bonuses: 0,
    adjustment_reason: null,
    deductions_vales: 50000,
    other_discounts: 0,
    net_pay: 450000,
    detail_json: [],
    voucher_total: 50000,
    voucher_excess: extra.voucherExcess ?? 0,
    debt_remainder: extra.debtRemainder ?? 0,
  };
}
