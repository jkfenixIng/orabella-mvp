import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { startCluster, stopCluster, type Cluster } from "./cluster.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type PgError = Error & { code?: string; detail?: string; constraint?: string };
type Result = { name: string; repetitions?: number; status: "PASS" | "FAIL"; detail: string };
type Sessions = { observer: Sql; a: Sql; b: Sql; c: Sql; pids: number[] };
const zeroCounts: { [key: string]: Json } = { payments: 0, invoice_payments: 0, commission_payouts: 0, voucher_requests: 0 };
let serial = 0;
const backendPids = new WeakMap<Sql, number>();
let cluster: Cluster | undefined;
let shuttingDown = false;
const next = () => ++serial;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function eventually<T>(work: () => Promise<T | undefined>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) { const value = await work(); if (value !== undefined) return value; await sleep(40); }
  throw new Error(message);
}
async function errorOf(work: Promise<unknown>): Promise<PgError> { try { await work; } catch (error) { return error as PgError; } throw new Error("expected PostgreSQL operation to fail"); }
/** Starts a contender now and keeps an early rejection observable instead of unhandled. */
function track<T>(work: Promise<T>): Promise<T> { work.catch(() => undefined); return work; }
async function expectWaiting(observer: Sql, pid: number): Promise<void> {
  await eventually(async () => {
    const rows = await observer<{ state: string; wait_event_type: string | null; blocked: boolean }[]>`
      SELECT a.state, a.wait_event_type, EXISTS (
        SELECT 1 FROM pg_locks waiting JOIN pg_locks held ON waiting.locktype = held.locktype
          AND waiting.database IS NOT DISTINCT FROM held.database AND waiting.relation IS NOT DISTINCT FROM held.relation
          AND waiting.page IS NOT DISTINCT FROM held.page AND waiting.tuple IS NOT DISTINCT FROM held.tuple
          AND waiting.transactionid IS NOT DISTINCT FROM held.transactionid AND waiting.pid <> held.pid
        WHERE waiting.pid = a.pid AND NOT waiting.granted AND held.granted) AS blocked
      FROM pg_stat_activity a WHERE a.pid = ${pid}`;
    return rows[0]?.state === "active" && rows[0].wait_event_type === "Lock" && rows[0].blocked ? rows[0] : undefined;
  }, `backend ${pid} was not observed waiting in pg_stat_activity and pg_locks`);
}
async function backendPid(sql: Sql): Promise<number> { const cached = backendPids.get(sql); if (cached) return cached; const pid = (await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; backendPids.set(sql, pid); return pid; }
async function begin(sql: Sql): Promise<void> { await sql.unsafe("BEGIN"); }
async function commit(sql: Sql): Promise<void> { await sql.unsafe("COMMIT"); }
async function rollback(sql: Sql): Promise<void> { await sql.unsafe("ROLLBACK").catch(() => undefined); }
async function user(sql: Sql): Promise<string> { const n = next(); return (await sql<{ id: string }[]>`INSERT INTO public.users (id_type, id_number, password_hash, full_name, email) VALUES ('CC', ${`C-${n}`}, 'hash', ${`User ${n}`}, ${`c${n}@test.local`}) RETURNING id`)[0].id; }
async function employee(sql: Sql): Promise<string> { const n = next(); return (await sql<{ id: string }[]>`INSERT INTO public.employees (document, pay_type, full_name, salary_fixed) VALUES (${`E-${n}`}, 'fijo', ${`Employee ${n}`}, 1000000) RETURNING id`)[0].id; }
async function register(sql: Sql): Promise<string> { const n = next(); return (await sql<{ id: string }[]>`INSERT INTO public.cash_registers (name, base_configurada) VALUES (${`Concurrency ${n}`}, 200000) RETURNING id`)[0].id; }
async function method(sql: Sql, code = "efectivo"): Promise<string> { return (await sql<{ id: string }[]>`SELECT id FROM public.payment_methods WHERE code = ${code}`)[0].id; }
function counts(cash = 200000): Json[] { return [{ method_code: "efectivo", denomination: 10000, quantity: cash / 10000, amount: cash }, ...["transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"].map((method_code) => ({ method_code, denomination: null, quantity: 1, amount: 0 }))]; }
async function open(sql: Sql, registerId: string, userId: string): Promise<string> { return (await sql<{ result: { id: string } }[]>`SELECT public.cash_open_shift_atomic(${registerId}::uuid, ${userId}::uuid, 200000, ${sql.json(counts())}::jsonb) AS result`)[0].result.id; }
async function close(sql: Sql, shift: string, userId: string): Promise<unknown> { const payload = { expected_cash: 0, counted_cash: 200000, base_left: 200000, cash_withdrawn: 0, base_difference: 0, observation: null }; return sql`SELECT public.cash_close_shift_atomic(${shift}::uuid, ${userId}::uuid, now(), ${sql.json(payload)}::jsonb, ${sql.json(counts())}::jsonb, ${sql.json(zeroCounts)}::jsonb)`; }
async function invoice(sql: Sql, userId: string, shift: string, employeeId: string, key = randomUUID()): Promise<string> {
  const header = { client_name: "Client", client_document: null, subtotal: 10000, discount: 0, tax: 0, surcharge: 0, total: 10000, status: "Emitida", closed_by: null, closed_at: null };
  const items = [{ item_type: "custom", product_id: null, service_id: null, custom_name: "Service", employee_id: employeeId, qty: 1, unit_price: 10000, discount: 0, no_commission: false, commission_value: null, commission_mode: "comision", commission_percent_override: null, subtotal: 10000 }];
  return (await sql<{ result: { id: string } }[]>`SELECT public.invoice_create_atomic(${userId}::uuid, ${shift}::uuid, ${key}, ${sql.json(header)}::jsonb, ${sql.json(items)}::jsonb, '[]'::jsonb, '[]'::jsonb, 'Invoice #{consecutivo}', '[]'::jsonb) AS result`)[0].result.id;
}
async function payment(sql: Sql, shift: string, invoiceId: string, userId: string): Promise<unknown> { const collection = { method_id: await method(sql), method_code: "efectivo", amount: 1000, fee_percent: 0, fee_amount: 0, idempotency_key: randomUUID() }; return sql`SELECT public.cash_invoice_payment_atomic(${shift}::uuid, ${invoiceId}::uuid, ${userId}::uuid, now(), false, false, ${sql.json(collection)}::jsonb)`; }
async function payrollPeriod(sql: Sql): Promise<string> { const n = next(); return (await sql<{ id: string }[]>`INSERT INTO public.payroll_periods (start_date, end_date, status) VALUES ('2026-01-01'::date + ${n * 3}::int, '2026-01-01'::date + ${n * 3 + 1}::int, 'borrador') RETURNING id`)[0].id; }
function payrollItem(period: string, employeeId: string): { [key: string]: Json } { return { period_id: period, employee_id: employeeId, base_fixed: 500000, commissions: 0, bonuses: 0, adjustment_reason: null, deductions_vales: 50000, other_discounts: 0, net_pay: 450000, detail_json: [], voucher_total: 50000, voucher_excess: 20000, debt_remainder: 5000 }; }
async function applyPayroll(sql: Sql, period: string, items: Json[], vouchers: string[] = []): Promise<unknown> { return sql`SELECT public.payroll_apply_atomic(${period}::uuid, ${sql.json(items)}::jsonb, ${sql.array(vouchers)}::uuid[], '{}'::uuid[])`; }

async function scenarioOpen(o: Sql, a: Sql, b: Sql): Promise<string> { const u = await user(o), r = await register(o); await begin(a); const shift = await open(a, r, u); const loser = track(open(b, r, u)); await expectWaiting(o, await backendPid(b)); await commit(a); const error = await errorOf(loser); assert(error.code === "23505" || error.message.includes("SHIFT_ALREADY_OPEN"), `open loser got ${error.code}/${error.message}`); return `winner=${shift}; loser=${error.code ?? error.message}`; }
async function splitPayment(sql: Sql, shift: string, invoiceId: string, userId: string): Promise<unknown> { const portions = [{ method_code: "efectivo", amount: 1000, fee_percent: 0, fee_amount: 0, cash_shift_id: shift, idempotency_key: randomUUID() }]; return sql`SELECT public.invoice_split_payment_atomic(${invoiceId}::uuid, ${shift}::uuid, ${userId}::uuid, now(), false, ${sql.json(portions)}::jsonb)`; }
async function scenarioCloseVsPayment(o: Sql, a: Sql, b: Sql, split: boolean): Promise<string> { const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), i = await invoice(o, u, s, e); await begin(a); await a`SELECT id FROM public.cash_shifts WHERE id = ${s} FOR UPDATE`; const loser = track(split ? splitPayment(b, s, i, u) : payment(b, s, i, u)); await expectWaiting(o, await backendPid(b)); await close(a, s, u); await commit(a); const error = await errorOf(loser); assert(error.message.includes("SHIFT_CLOSED"), `payment loser got ${error.code}/${error.message}`); return error.message; }
async function scenarioDoubleClose(o: Sql, a: Sql, b: Sql): Promise<string> { const u = await user(o), s = await open(o, await register(o), u); await begin(a); await a`SELECT id FROM public.cash_shifts WHERE id = ${s} FOR UPDATE`; const loser = track(close(b, s, u)); await expectWaiting(o, await backendPid(b)); await close(a, s, u); await commit(a); const error = await errorOf(loser); assert(error.message.includes("SHIFT_ALREADY_CLOSED"), `close loser got ${error.message}`); return error.message; }
async function scenarioStale(o: Sql, a: Sql, b: Sql, c: Sql): Promise<string> {
  const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), i = await invoice(o, u, s, e);
  await begin(a); await a`SELECT id FROM public.invoices WHERE id = ${i} FOR UPDATE`;
  const collecting = track(payment(b, s, i, u)); await expectWaiting(o, await backendPid(b));
  const closing = track(close(c, s, u)); await expectWaiting(o, await backendPid(c));
  await commit(a); await collecting; const error = await errorOf(closing);
  assert(error.message.includes("ARQUEO_STALE"), `close after interleaved collection got ${error.code}/${error.message}`);
  const state = await o<{ status: string }[]>`SELECT status FROM public.cash_shifts WHERE id = ${s}`; assert(state[0].status === "abierto", "stale close partially wrote the signed arqueo"); return error.message;
}
async function scenarioMinimum(o: Sql, a: Sql, b: Sql): Promise<string> { const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), i = await invoice(o, u, s, e); const insert = async (db: Sql) => db.unsafe("INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate, paid_by, idempotency_key) VALUES ($1,$2,$3,'efectivo',10000,60000,300000,$4,$5)", [e, i, s, u, randomUUID()]); await begin(a); await a`SELECT id FROM public.cash_shift_method_balances WHERE cash_shift_id = ${s} AND method_code = 'efectivo' FOR UPDATE`; const loser = track(insert(b)); await expectWaiting(o, await backendPid(b)); await insert(a); await commit(a); const error = await errorOf(loser); assert(error.message.includes("CASH_METHOD_MINIMUM_BREACH"), `minimum loser got ${error.code}/${error.message}`); return error.message; }
async function scenarioEditVsCommission(o: Sql, a: Sql, b: Sql): Promise<string> {
  for (let run = 1; run <= 20; run++) {
    const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), i = await invoice(o, u, s, e); await payment(o, s, i, u);
    const paymentId = (await o<{ id: string }[]>`SELECT id FROM public.invoice_payments WHERE invoice_id = ${i}`)[0].id;
    const edit = (db: Sql) => db`SELECT public.invoice_edit_items_atomic(${i}::uuid, ${u}::uuid, 0, 'Emitida', ${db.json({ payments: [{ id: paymentId, method_code: "nequi", method_id: null }] })}::jsonb)`;
    const payout = (db: Sql) => db`INSERT INTO public.commission_payouts (employee_id, invoice_id, cash_shift_id, method_code, base_subtotal, amount, earned_immediate, paid_by, idempotency_key) VALUES (${e}, ${i}, ${s}, 'efectivo', 10000, 100, 1000, ${u}, ${randomUUID()})`;
    // Alternate which operation holds its locks first; both sides must finish, never 40P01 or another error.
    const [holder, waiter, first, second] = run % 2 ? [a, b, payout, edit] : [b, a, edit, payout];
    await begin(holder); await first(holder);
    const waiting = track(second(waiter)); await expectWaiting(o, await backendPid(waiter)); await commit(holder);
    await waiting.catch((error: PgError) => { throw new Error(`edit/payout repetition ${run} must not fail; got ${error.code}/${error.message}`); });
    const state = await o<{ method_code: string; payouts: string; edit_version: number }[]>`SELECT ip.method_code, (SELECT count(*)::text FROM public.commission_payouts WHERE invoice_id = ${i}) AS payouts, i.edit_version FROM public.invoice_payments ip JOIN public.invoices i ON i.id = ip.invoice_id WHERE ip.id = ${paymentId}`;
    assert(state[0]?.method_code === "nequi" && state[0].payouts === "1" && state[0].edit_version === 1, `inconsistent edit/payout state on repetition ${run}: ${JSON.stringify(state)}`);
  }
  return "20 lock-observed alternating repetitions; both succeed; 40P01=0";
}
async function consecutive(o: Sql, id: string): Promise<number> { return (await o<{ n: number }[]>`SELECT consecutive_number AS n FROM public.invoices WHERE id = ${id}`)[0].n; }
async function lastNumber(o: Sql): Promise<number> { return (await o<{ n: number }[]>`SELECT coalesce((value ->> 'last_number')::int, 0) AS n FROM public.system_settings WHERE key = 'invoice_sequence'`)[0]?.n ?? 0; }
async function scenarioInvoiceConcurrency(o: Sql, a: Sql, b: Sql): Promise<string> {
  const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), base = await lastNumber(o);
  // Aborted holder: its reserved number is rolled back and the waiting creator receives it.
  await begin(a); await invoice(a, u, s, e); const afterAbort = track(invoice(b, u, s, e)); await expectWaiting(o, await backendPid(b)); await rollback(a);
  const reused = await consecutive(o, await afterAbort);
  // Committed holder: the waiting creator receives the next adjacent number.
  await begin(a); const committed = await invoice(a, u, s, e); const afterCommit = track(invoice(b, u, s, e)); await expectWaiting(o, await backendPid(b)); await commit(a);
  const numbers = [reused, await consecutive(o, committed), await consecutive(o, await afterCommit)];
  assert(JSON.stringify(numbers) === JSON.stringify([base + 1, base + 2, base + 3]), `consecutives after abort/commit were ${numbers.join(",")}, expected ${base + 1},${base + 2},${base + 3}`);
  return `abort reused=${numbers[0]}; commit sequence=${numbers.slice(1).join(",")}`;
}
async function scenarioIdempotency(o: Sql, a: Sql, b: Sql): Promise<string> { const u = await user(o), e = await employee(o), s = await open(o, await register(o), u), key = randomUUID(); await begin(a); const winnerId = await invoice(a, u, s, e, key); const loser = track(invoice(b, u, s, e, key)); await expectWaiting(o, await backendPid(b)); await commit(a); const error = await errorOf(loser); assert(error.code === "23505", `same-key loser got ${error.code}/${error.message}`); const rows = await o<{ id: string }[]>`SELECT id FROM public.invoices WHERE idempotency_key = ${key}`; assert(rows.length === 1 && rows[0].id === winnerId, "idempotency winner relookup was not exact"); return `winner=${winnerId}; loser=23505`; }
async function scenarioPayrollCap(o: Sql, a: Sql, b: Sql): Promise<string> { const u = await user(o), e = await employee(o), p = await payrollPeriod(o); await applyPayroll(o, p, [payrollItem(p, e)]); const item = (await o<{ id: string }[]>`SELECT id FROM public.payroll_items WHERE period_id = ${p}`)[0].id; const insert = async (db: Sql) => db.unsafe("INSERT INTO public.payroll_payments (payroll_item_id, method_code, amount, paid_by, idempotency_key) VALUES ($1,'efectivo',300000,$2,$3)", [item, u, randomUUID()]); await begin(a); await a`SELECT id FROM public.payroll_items WHERE id = ${item} FOR UPDATE`; const loser = track(insert(b)); await expectWaiting(o, await backendPid(b)); await insert(a); await commit(a); const error = await errorOf(loser); const where = (error as PgError & { where?: string }).where ?? ""; assert(error.code === "P0001" && error.message.startsWith("El pago supera el neto del ítem") && where.includes("check_payroll_payments_cap"), `payroll cap loser got ${error.code}/${error.message}/${where}`); const paid = await o<{ total: string }[]>`SELECT sum(amount)::text AS total FROM public.payroll_payments WHERE payroll_item_id = ${item}`; assert(paid[0].total === "300000.00", `payroll item paid ${paid[0].total}`); return `loser=P0001/check_payroll_payments_cap; paid=${paid[0].total}`; }
async function scenarioPayrollApply(o: Sql, a: Sql, b: Sql): Promise<string> { const e = await employee(o), p = await payrollPeriod(o), voucher = (await o<{ id: string }[]>`INSERT INTO public.voucher_requests (employee_id, amount, status) VALUES (${e},50000,'aprobada') RETURNING id`)[0].id, item = payrollItem(p, e); await begin(a); await a`SELECT id FROM public.voucher_requests WHERE id = ${voucher} FOR UPDATE`; const loser = track(applyPayroll(b, p, [item], [voucher])); await expectWaiting(o, await backendPid(b)); await applyPayroll(a, p, [item], [voucher]); await commit(a); const error = await errorOf(loser); assert(error.code === "P0001" && error.message.includes("PAYROLL_VOUCHER_CONFLICT"), `payroll apply loser got ${error.code}/${error.message}`); const carries = await o<{ kind: string; amount: string }[]>`SELECT origin_kind AS kind, amount::text AS amount FROM public.payroll_discount_carries WHERE origin_period_id = ${p} ORDER BY origin_kind`; const status = await o<{ status: string }[]>`SELECT status FROM public.voucher_requests WHERE id = ${voucher}`; assert(JSON.stringify(carries) === JSON.stringify([{ kind: "carry_remainder", amount: "5000.00" }, { kind: "voucher_excess", amount: "20000.00" }]) && status[0].status === "descontada", "apply must create the documented carry kinds and consume its voucher once"); return `loser=P0001/PAYROLL_VOUCHER_CONFLICT; carries=${carries.map((row) => row.kind).join(",")}`; }

/**
 * 005 smoke on real PostgreSQL 18: triggers present, a new decimal INSERT is
 * COP_WHOLE_PESO_REQUIRED, a legacy cent row (written with the trigger off, as
 * before 005) still accepts a non-money UPDATE, and the audit view is
 * service_role-only. Everything runs in one transaction that is rolled back.
 */
async function scenarioCopWholePeso(o: Sql, a: Sql): Promise<string> {
  const triggers = (await o<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('trg_cop_whole_peso', 'trg_cop_whole_peso_settings') AND NOT tgisinternal`)[0].n;
  assert(triggers >= 20, `expected the 005 triggers, found ${triggers}`);
  await begin(a);
  try {
    const rejected = await errorOf(a.unsafe("INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('COP decimal', 10.50, 1, 1)"));
    assert(rejected.code === "P0001" && rejected.message === "COP_WHOLE_PESO_REQUIRED", `decimal insert got ${rejected.code}/${rejected.message}`);
    await a.unsafe("ROLLBACK"); await begin(a);
    await a.unsafe("ALTER TABLE public.services DISABLE TRIGGER trg_cop_whole_peso");
    const legacy = (await a<{ id: string }[]>`INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('COP legacy', 10.50, 1, 1) RETURNING id`)[0].id;
    await a.unsafe("ALTER TABLE public.services ENABLE TRIGGER trg_cop_whole_peso");
    const updated = (await a<{ price: string }[]>`UPDATE public.services SET is_active = false WHERE id = ${legacy} RETURNING price::text AS price`)[0].price;
    assert(updated === "10.50", `legacy update rewrote price to ${updated}`);
    const acl = (await a<{ anon: boolean; authenticated: boolean; service: boolean; write: boolean }[]>`SELECT has_table_privilege('anon', 'public.cop_legacy_cents_audit', 'SELECT') AS anon, has_table_privilege('authenticated', 'public.cop_legacy_cents_audit', 'SELECT') AS authenticated, has_table_privilege('service_role', 'public.cop_legacy_cents_audit', 'SELECT') AS service, has_table_privilege('service_role', 'public.cop_legacy_cents_audit', 'INSERT') AS write`)[0];
    assert(!acl.anon && !acl.authenticated && acl.service && !acl.write, `audit view ACL ${JSON.stringify(acl)}`);
    return `triggers=${triggers}; decimal=P0001/COP_WHOLE_PESO_REQUIRED; legacyUpdate=10.50; auditAcl=service_role SELECT only`;
  } finally { await rollback(a); }
}
async function recover({ observer, a, b, c, pids }: Sessions): Promise<void> { await observer`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ANY(${pids}::int[]) AND state <> 'idle'`; await Promise.all([rollback(a), rollback(b), rollback(c)]); }
async function runScenario(sessions: Sessions, name: string, fn: () => Promise<string>, repetitions?: number): Promise<Result> {
  const operation = fn(); let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("scenario timed out after 60s")), 60_000); });
  try { return { name, repetitions, status: "PASS", detail: await Promise.race([operation, timeout]) }; }
  catch (error) { await recover(sessions); await operation.catch(() => undefined); return { name, repetitions, status: "FAIL", detail: (error as Error).message }; }
  finally { clearTimeout(timer); }
}
async function teardown(): Promise<void> { if (shuttingDown) return; shuttingDown = true; if (!cluster) return; const current = cluster; cluster = undefined; await stopCluster(current); console.log(`TEARDOWN dataDirRemoved=${current.dataDir}`); }
function handleSignal(signal: NodeJS.Signals): void { void teardown().then(() => process.exit(signal === "SIGINT" ? 130 : 143), () => { process.exitCode = 1; process.exit(signal === "SIGINT" ? 130 : 143); }); }
process.once("SIGINT", () => handleSignal("SIGINT")); process.once("SIGTERM", () => handleSignal("SIGTERM"));
process.once("unhandledRejection", (error) => { console.error(error); handleSignal("SIGTERM"); });
process.once("uncaughtException", (error) => { console.error(error); handleSignal("SIGTERM"); });
async function main(): Promise<void> {
  let observer: Sql | undefined, a: Sql | undefined, b: Sql | undefined, c: Sql | undefined;
  try {
    cluster = await startCluster(); observer = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined }); a = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined }); b = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined }); c = postgres(cluster.url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
    const o = observer, x = a, y = b, z = c, sessions = { observer: o, a: x, b: y, c: z, pids: await Promise.all([backendPid(x), backendPid(y), backendPid(z)]) };
    const scenarios: Array<[string, () => Promise<string>, number?]> = [["a. concurrent shift opens", () => scenarioOpen(o, x, y)], ["b. close vs cash invoice payment", () => scenarioCloseVsPayment(o, x, y, false)], ["c. close vs split invoice payment", () => scenarioCloseVsPayment(o, x, y, true)], ["d. concurrent closes", () => scenarioDoubleClose(o, x, y)], ["e. stale arqueo after collection", () => scenarioStale(o, x, y, z)], ["f. concurrent arqueo-method outflows", () => scenarioMinimum(o, x, y)], ["g. invoice method edit vs commission", () => scenarioEditVsCommission(o, x, y), 20], ["h. concurrent invoice consecutives", () => scenarioInvoiceConcurrency(o, x, y)], ["i. same idempotency key", () => scenarioIdempotency(o, x, y)], ["j. concurrent payroll payments cap", () => scenarioPayrollCap(o, x, y)], ["k. concurrent payroll apply", () => scenarioPayrollApply(o, x, y)], ["l. 005 COP whole-peso smoke", () => scenarioCopWholePeso(o, x)]];
    const results: Result[] = []; for (const [name, fn, repetitions] of scenarios) { const result = await runScenario(sessions, name, fn, repetitions); console.log(`${result.status} ${name}${repetitions ? ` (${repetitions}x)` : ""}: ${result.detail}`); results.push(result); } if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
  } finally { await Promise.all([a && rollback(a), b && rollback(b), c && rollback(c)].filter(Boolean)); await Promise.all([observer?.end({ timeout: 1 }), a?.end({ timeout: 1 }), b?.end({ timeout: 1 }), c?.end({ timeout: 1 })].filter(Boolean)); await teardown(); }
}
main().catch((error) => { console.error(`test:concurrency setup/runtime failure: ${(error as Error).stack ?? (error as Error).message}`); process.exitCode = 1; });
