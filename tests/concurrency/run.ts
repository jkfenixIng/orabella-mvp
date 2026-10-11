import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { startCluster, stopCluster, type Cluster } from "./cluster.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const zeroCounts: { [key: string]: Json } = { payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 };
type PgError = Error & { code?: string; detail?: string; constraint?: string };
type Result = { name: string; repetitions?: number; status: "PASS" | "FAIL"; detail: string };
let serial = 0;
const backendPids = new WeakMap<Sql, number>();
let cluster: Cluster | undefined;
let shuttingDown = false;
const next = () => ++serial;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function eventually<T>(work: () => Promise<T | undefined>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await work();
    if (value !== undefined) return value;
    await sleep(40);
  }
  throw new Error(message);
}

async function errorOf(work: Promise<unknown>): Promise<PgError> {
  try { await work; } catch (error) { return error as PgError; }
  throw new Error("expected PostgreSQL operation to fail");
}

async function expectWaiting(observer: Sql, pid: number): Promise<void> {
  await eventually(async () => {
    const rows = await observer<{ state: string; wait_event_type: string | null; blocked: boolean }[]>`
      SELECT a.state, a.wait_event_type, EXISTS (
        SELECT 1 FROM pg_locks waiting
        JOIN pg_locks held ON waiting.locktype = held.locktype
          AND waiting.database IS NOT DISTINCT FROM held.database
          AND waiting.relation IS NOT DISTINCT FROM held.relation
          AND waiting.page IS NOT DISTINCT FROM held.page
          AND waiting.tuple IS NOT DISTINCT FROM held.tuple
          AND waiting.transactionid IS NOT DISTINCT FROM held.transactionid
          AND waiting.pid <> held.pid
        WHERE waiting.pid = a.pid AND NOT waiting.granted AND held.granted
      ) AS blocked
      FROM pg_stat_activity a WHERE a.pid = ${pid}`;
    return rows[0]?.state === "active" && rows[0].wait_event_type === "Lock" && rows[0].blocked ? rows[0] : undefined;
  }, `backend ${pid} was not observed waiting in pg_stat_activity and pg_locks`);
}

async function backendPid(sql: Sql): Promise<number> {
  const cached = backendPids.get(sql);
  if (cached) return cached;
  const pid = (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
  backendPids.set(sql, pid);
  return pid;
}
async function begin(sql: Sql): Promise<void> { await sql.unsafe("BEGIN"); }
async function commit(sql: Sql): Promise<void> { await sql.unsafe("COMMIT"); }
async function rollback(sql: Sql): Promise<void> { await sql.unsafe("ROLLBACK").catch(() => undefined); }

async function user(sql: Sql): Promise<string> {
  const n = next();
  return (await sql<{ id: string }[]>`INSERT INTO public.users (id_type, id_number, password_hash, full_name, email) VALUES ('CC', ${`C-${n}`}, 'hash', ${`User ${n}`}, ${`c${n}@test.local`}) RETURNING id`)[0].id;
}
async function employee(sql: Sql): Promise<string> {
  const n = next();
  return (await sql<{ id: string }[]>`INSERT INTO public.employees (document, pay_type, full_name, salary_fixed) VALUES (${`E-${n}`}, 'fijo', ${`Employee ${n}`}, 1000000) RETURNING id`)[0].id;
}
async function register(sql: Sql): Promise<string> {
  const n = next();
  return (await sql<{ id: string }[]>`INSERT INTO public.cash_registers (name, base_configurada) VALUES (${`Concurrency ${n}`}, 200000) RETURNING id`)[0].id;
}
async function method(sql: Sql, code = "efectivo"): Promise<string> { return (await sql<{ id: string }[]>`SELECT id FROM public.payment_methods WHERE code = ${code}`)[0].id; }
function counts(cash = 200000): Json[] {
  return [{ method_code: "efectivo", denomination: 10000, quantity: cash / 10000, amount: cash }, ...["transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"].map((method_code) => ({ method_code, denomination: null, quantity: 1, amount: 0 }))];
}
async function open(sql: Sql, registerId: string, userId: string, base = 200000): Promise<string> {
  return (await sql<{ result: { id: string } }[]>`SELECT public.cash_open_shift_atomic(${registerId}::uuid, ${userId}::uuid, ${base}::numeric, ${sql.json(counts(base))}::jsonb) AS result`)[0].result.id;
}
async function close(sql: Sql, shift: string, userId: string, collectionCounts = zeroCounts): Promise<unknown> {
  const payload = { expected_cash: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, observation: null };
  return sql`SELECT public.cash_close_shift_atomic(${shift}::uuid, ${userId}::uuid, now(), ${sql.json(payload)}::jsonb, ${sql.json(counts())}::jsonb, ${sql.json(collectionCounts)}::jsonb)`;
}
async function invoice(sql: Sql, userId: string, shift: string, employeeId: string, key = randomUUID()): Promise<string> {
  const header = { client_name: "Client", client_document: null, subtotal: 10000, discount: 0, tax: 0, surcharge: 0, total: 10000, status: "Emitida", closed_by: null, closed_at: null };
  const items = [{ item_type: "custom", product_id: null, service_id: null, custom_name: "Service", employee_id: employeeId, qty: 1, unit_price: 10000, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 10000 }];
  return (await sql<{ result: { id: string } }[]>`SELECT public.invoice_create_atomic(${userId}::uuid, ${shift}::uuid, ${key}, ${sql.json(header)}::jsonb, ${sql.json(items)}::jsonb, '[]'::jsonb, '[]'::jsonb, 'Invoice #{consecutivo}', '[]'::jsonb) AS result`)[0].result.id;
}
async function payment(sql: Sql, shift: string, invoiceId: string, userId: string, key = randomUUID()): Promise<unknown> {
  const collection = { method_id: await method(sql), method_code: "efectivo", amount: 1000, fee_percent: 0, fee_amount: 0, idempotency_key: key };
  return sql`SELECT public.cash_invoice_payment_atomic(${shift}::uuid, ${invoiceId}::uuid, ${userId}::uuid, now(), false, false, ${sql.json(collection)}::jsonb)`;
}
async function splitPayment(sql: Sql, shift: string, invoiceId: string, userId: string, key = randomUUID()): Promise<unknown> {
  const portions = [{ method_code: "efectivo", amount: 1000, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: key }];
  return sql`SELECT public.invoice_split_payment_atomic(${invoiceId}::uuid, ${shift}::uuid, ${userId}::uuid, now(), false, ${sql.json(portions)}::jsonb)`;
}
async function payrollPeriod(sql: Sql): Promise<string> {
  const n = next();
  return (await sql<{ id: string }[]>`INSERT INTO public.payroll_periods (start_date, end_date, status) VALUES ('2026-01-01'::date + ${n * 3}::int, '2026-01-01'::date + ${n * 3 + 1}::int, 'borrador') RETURNING id`)[0].id;
}
function payrollItem(period: string, employeeId: string): { [key: string]: Json } { return { period_id: period, employee_id: employeeId, base_fixed: 500000, commissions: 0, bonuses: 0, adjustment_reason: null, deductions_vales: 50000, other_discounts: 0, net_pay: 450000, detail_json: [], voucher_total: 50000, voucher_excess: 0, debt_remainder: 0 }; }
async function applyPayroll(sql: Sql, period: string, items: Json[], vouchers: string[] = []): Promise<unknown> { return sql`SELECT public.payroll_apply_atomic(${period}::uuid, ${sql.json(items)}::jsonb, ${sql.array(vouchers)}::uuid[], '{}'::uuid[])`; }

async function scenarioOpen(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), r = await register(observer);
  await begin(a); const shift = await open(a, r, u);
  const waiting = open(b, r, u).then(() => undefined, (error) => error as PgError);
  await expectWaiting(observer, await backendPid(b)); await commit(a);
  const error = await waiting;
  assert(error, "waiting contender unexpectedly succeeded");
  assert(error?.code === "23505" || error?.message.includes("SHIFT_ALREADY_OPEN"), `second open got ${error?.code}/${error?.message}`);
  const rows = await observer<{ n: string }[]>`SELECT count(*)::text AS n FROM public.cash_shifts WHERE cash_register_id = ${r} AND status = 'abierto'`;
  assert(rows[0].n === "1", "expected exactly one open shift");
  return `winner=${shift}; loser=${error.code ?? error.message}`;
}

async function scenarioCloseVsPayment(observer: Sql, a: Sql, b: Sql, split: boolean): Promise<string> {
  const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u), i = await invoice(observer, u, s, e);
  await begin(a); await a`SELECT id FROM public.cash_shifts WHERE id = ${s} FOR UPDATE`;
  const waiting = (split ? splitPayment(b, s, i, u) : payment(b, s, i, u)).then(() => undefined, (error) => error as PgError);
  await expectWaiting(observer, await backendPid(b)); await close(a, s, u); await commit(a);
  const error = await waiting;
  assert(error, "waiting contender unexpectedly succeeded");
  assert(error?.message.includes("SHIFT_CLOSED"), `payment must see closed shift, got ${error?.code}/${error?.message}`);
  const rows = await observer<{ n: string }[]>`SELECT count(*)::text AS n FROM public.invoice_payments WHERE invoice_id = ${i}`;
  assert(rows[0].n === "0", "payment left an invoice payment after close");
  return `waiting payment rejected ${error.message}`;
}

async function scenarioDoubleClose(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), s = await open(observer, await register(observer), u);
  await begin(a); await a`SELECT id FROM public.cash_shifts WHERE id = ${s} FOR UPDATE`;
  const waiting = close(b, s, u).then(() => undefined, (error) => error as PgError);
  await expectWaiting(observer, await backendPid(b)); await close(a, s, u); await commit(a);
  const error = await waiting;
  assert(error, "waiting contender unexpectedly succeeded");
  assert(error?.message.includes("SHIFT_ALREADY_CLOSED"), `loser got ${error?.message}`);
  const rows = await observer<{ n: string }[]>`SELECT count(*)::text AS n FROM public.cash_shift_counts WHERE shift_id = ${s} AND phase = 'cierre'`;
  assert(rows[0].n === "6", "second close wrote duplicate count lines");
  return error.message;
}

async function scenarioStale(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u), i = await invoice(observer, u, s, e);
  await payment(a, s, i, u);
  const error = await errorOf(close(b, s, u));
  assert(error.message.includes("ARQUEO_STALE"), `close after new collection got ${error.message}`);
  const state = await observer<{ status: string }[]>`SELECT status FROM public.cash_shifts WHERE id = ${s}`;
  assert(state[0].status === "abierto", "stale close partially wrote the signed arqueo");
  return error.message;
}

async function scenarioMinimum(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u), i = await invoice(observer, u, s, e);
  const insert = (db: Sql) => db.unsafe("INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate, paid_by, idempotency_key) VALUES ($1, $2, $3, 'efectivo', 10000, 60000, 300000, $4, $5)", [e, i, s, u, randomUUID()]);
  await begin(a); await a`SELECT id FROM public.cash_shift_method_balances WHERE cash_shift_id = ${s} AND method_code = 'efectivo' FOR UPDATE`;
  const waiting = insert(b).then(() => undefined, (error) => error as PgError);
  await expectWaiting(observer, await backendPid(b)); await insert(a); await commit(a);
  const error = await waiting;
  assert(error, "waiting contender unexpectedly succeeded");
  assert(error?.message.includes("CASH_METHOD_MINIMUM_BREACH"), `minimum loser got ${error?.message}`);
  const balance = await observer<{ value: string }[]>`SELECT public.cash_shift_method_expected_balance(${s}, 'efectivo')::text AS value`;
  assert(Number(balance[0].value) >= 100000, `balance fell below floor: ${balance[0].value}`);
  return `${error.message}; balance=${balance[0].value}`;
}

async function scenarioInvoiceConcurrency(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u);
  const [first, second] = await Promise.all([invoice(a, u, s, e), invoice(b, u, s, e)]);
  const rows = await observer<{ consecutive_number: number }[]>`SELECT consecutive_number FROM public.invoices WHERE id IN (${first}, ${second}) ORDER BY consecutive_number`;
  assert(rows.length === 2 && rows[0].consecutive_number !== rows[1].consecutive_number, "consecutive invoices duplicated a number");
  return `consecutives=${rows.map((row) => row.consecutive_number).join(",")}`;
}

async function scenarioIdempotency(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u), key = randomUUID();
  const outcomes = await Promise.allSettled([invoice(a, u, s, e, key), invoice(b, u, s, e, key)]);
  assert(outcomes.filter((outcome) => outcome.status === "rejected").length === 1, "same invoice key did not reject one contender");
  const rows = await observer<{ id: string }[]>`SELECT id FROM public.invoices WHERE idempotency_key = ${key}`;
  assert(rows.length === 1, "idempotency relookup did not find exactly one invoice");
  return `one winner=${rows[0].id}`;
}

async function scenarioPayrollCap(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(observer), e = await employee(observer), p = await payrollPeriod(observer);
  await applyPayroll(observer, p, [payrollItem(p, e)]);
  const item = (await observer<{ id: string }[]>`SELECT id FROM public.payroll_items WHERE period_id = ${p}`)[0].id;
  const insert = (db: Sql) => db.unsafe("INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount, paid_by, idempotency_key) VALUES ($1, 'efectivo', 300000, $2, $3)", [item, u, randomUUID()]);
  await begin(a); await a`SELECT id FROM public.payroll_items WHERE id = ${item} FOR UPDATE`;
  const waiting = insert(b).then(() => undefined, (error) => error as PgError);
  await expectWaiting(observer, await backendPid(b)); await insert(a); await commit(a);
  const error = await waiting;
  assert(error, "waiting contender unexpectedly succeeded");
  assert(error?.code === "P0001", `payroll cap loser got ${error?.code}/${error?.message}`);
  const rows = await observer<{ total: string }[]>`SELECT coalesce(sum(amount), 0)::text AS total FROM public.payroll_payments WHERE payroll_item_id = ${item}`;
  assert(rows[0].total === "300000.00", `payroll net was double-paid: ${rows[0].total}`);
  return `${error.code}; paid=${rows[0].total}`;
}

async function scenarioPayrollApply(observer: Sql, a: Sql, b: Sql): Promise<string> {
  const e = await employee(observer), p = await payrollPeriod(observer);
  const voucher = (await observer<{ id: string }[]>`INSERT INTO public.voucher_requests (employee_id, amount, status) VALUES (${e}, 50000, 'aprobada') RETURNING id`)[0].id;
  const item = { ...payrollItem(p, e), voucher_excess: 20000, debt_remainder: 5000 };
  const outcomes = await Promise.allSettled([applyPayroll(a, p, [item], [voucher]), applyPayroll(b, p, [item], [voucher])]);
  assert(outcomes.filter((outcome) => outcome.status === "fulfilled").length === 1, "exactly one payroll apply must consume the voucher");
  const carries = await observer<{ n: string }[]>`SELECT count(*)::text AS n FROM public.payroll_discount_carries WHERE origin_period_id = ${p}`;
  const status = await observer<{ status: string }[]>`SELECT status FROM public.voucher_requests WHERE id = ${voucher}`;
  assert(carries[0].n === "2" && status[0].status === "descontada", "concurrent payroll apply duplicated carries or voucher consumption");
  return `one applied; carries=${carries[0].n}; voucher=${status[0].status}`;
}

async function scenarioDeadlock(observer: Sql, a: Sql, b: Sql): Promise<string> {
  for (let run = 1; run <= 20; run++) {
    const u = await user(observer), e = await employee(observer), s = await open(observer, await register(observer), u), i = await invoice(observer, u, s, e);
    await payment(observer, s, i, u);
    const paymentId = (await observer<{ id: string }[]>`SELECT id FROM public.invoice_payments WHERE invoice_id = ${i}`)[0].id;
    const payout = a.unsafe("INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate, paid_by, idempotency_key) VALUES ($1,$2,$3,'efectivo',10000,100,1000,$4,$5)", [e, i, s, u, randomUUID()]);
    const edit = b.unsafe("SELECT public.invoice_edit_items_atomic($1::uuid, $2::uuid, 0, 'Emitida', $3::jsonb)", [i, u, JSON.stringify({ payments: [{ id: paymentId, method_code: "nequi", method_id: null }] })]);
    const outcomes = await Promise.allSettled([payout, edit]);
    const deadlock = outcomes.find((outcome) => outcome.status === "rejected" && (outcome.reason as PgError).code === "40P01");
    assert(!deadlock, `40P01 deadlock detected on repetition ${run}`);
  }
  return "20 repetitions; 40P01=0";
}

interface Sessions { observer: Sql; a: Sql; b: Sql; pids: number[] }

/** A failed or timed-out scenario must not leave a lock that blocks the next one. */
async function recover({ observer, a, b, pids }: Sessions): Promise<void> {
  await observer`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ANY(${pids}::int[]) AND state <> 'idle'`.catch(() => undefined);
  await Promise.all([rollback(a), rollback(b)]);
}

async function runScenario(sessions: Sessions, name: string, fn: () => Promise<string>, repetitions?: number): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("scenario timed out after 60s")), 60_000); });
  try { return { name, repetitions, status: "PASS", detail: await Promise.race([fn(), timeout]) }; }
  catch (error) { await recover(sessions); return { name, repetitions, status: "FAIL", detail: (error as Error).message }; }
  finally { clearTimeout(timer); }
}

async function teardown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (cluster) {
    const current = cluster;
    cluster = undefined;
    await stopCluster(current).catch((error) => console.error(`TEARDOWN failure: ${(error as Error).message}`));
    console.log(`TEARDOWN dataDirRemoved=${current.dataDir}`);
  }
}

function handleSignal(signal: NodeJS.Signals): void {
  void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

async function main(): Promise<void> {
  let observer: Sql | undefined;
  let a: Sql | undefined;
  let b: Sql | undefined;
  try {
    cluster = await startCluster();
    observer = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
    a = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
    b = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
    const o = observer, x = a, y = b;
    await Promise.all([backendPid(x), backendPid(y)]);
    const sessions = { observer: o, a: x, b: y, pids: [await backendPid(x), await backendPid(y)] };
    const scenarios: Array<[string, () => Promise<string>, number?]> = [
      ["a. concurrent shift opens", () => scenarioOpen(o, x, y)],
      ["b. close vs cash invoice payment", () => scenarioCloseVsPayment(o, x, y, false)],
      ["c. close vs split invoice payment", () => scenarioCloseVsPayment(o, x, y, true)],
      ["d. concurrent closes", () => scenarioDoubleClose(o, x, y)],
      ["e. stale arqueo after collection", () => scenarioStale(o, x, y)],
      ["f. concurrent arqueo-method outflows", () => scenarioMinimum(o, x, y)],
      ["g. invoice method edit vs commission", () => scenarioDeadlock(o, x, y), 20],
      ["h. concurrent invoice consecutives", () => scenarioInvoiceConcurrency(o, x, y)],
      ["i. same idempotency key", () => scenarioIdempotency(o, x, y)],
      ["j. concurrent payroll payments cap", () => scenarioPayrollCap(o, x, y)],
      ["k. concurrent payroll apply", () => scenarioPayrollApply(o, x, y)],
    ];
    const results: Result[] = [];
    for (const [name, fn, repetitions] of scenarios) {
      const result = await runScenario(sessions, name, fn, repetitions);
      console.log(`${result.status} ${name}${repetitions ? ` (${repetitions}x)` : ""}: ${result.detail}`);
      results.push(result);
    }
    if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
  } finally {
    if (a) await rollback(a);
    if (b) await rollback(b);
    await Promise.all([observer?.end({ timeout: 1 }), a?.end({ timeout: 1 }), b?.end({ timeout: 1 })].filter(Boolean));
    await teardown();
  }
}

main().catch((error) => { console.error(`test:concurrency setup/runtime failure: ${(error as Error).stack ?? (error as Error).message}`); process.exitCode = 1; });
