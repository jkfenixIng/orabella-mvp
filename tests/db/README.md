# tests/db — characterization of the real schema (PGlite)

These tests run the **real SQL** of `supabase/migrations/001_orabella_schema.sql`
(PL/pgSQL functions, triggers, CHECKs, partial unique indexes, the EXCLUDE
constraint) instead of mocking `supabase-js`. They record what the schema does
**today**. They do not say what it should do: if a test fails after a schema
change, the behavior changed.

```
npm run test:db                                   # this suite only (~70 s)
npm run verify:backup -- <backup-dir>             # restore check, see below
```

`npm test` does **not** run this suite (`vitest.config.ts` excludes
`tests/db/**`). Reasons:

- It takes ~70 s alone, about twice the whole existing unit suite.
- When both ran in one process the total went from 35 s to 50–89 s. In one of
  three runs, two existing repo-walking tests (`ui-feedback`, `design-tokens`)
  failed after 14 s and 36 s, both past Vitest's 5 s default. They pass in
  under 0.3 s alone. The probable cause is CPU contention with the PGlite WASM
  instances.

## Engine: PGlite, not production Postgres

| | |
|---|---|
| Package | `@electric-sql/pglite` **0.5.8** (pinned, devDependency only, never imported from `src/` or `app/`) |
| Engine | **PostgreSQL 18.3** compiled to WASM (32-bit), in-process, single connection |
| Production | **PostgreSQL 17.11** (`prod-version.txt`) |

Every function in the schema compiles and runs on 18.3. No incompatibility was
found. These version differences show up only in catalog introspection, not in
behavior:

- PG 18 stores column `NOT NULL` as `pg_constraint` rows (`contype = 'n'`), and
  PG 17 does not. `scripts/verify-backup-restore.ts` filters them out.
- The `btree_gist` contrib in PGlite is 1.8. Production runs 1.7. Also,
  without an `extensions` schema, `001` installs `pgcrypto` in `public`
  (production has it in `extensions`). Both change only the number of extension
  functions in `public` (277 vs 216), not the schema's own objects.

## How the instance is built (`harness.ts`)

The instance follows the **clean PostgreSQL** install path. There is no `auth`
schema and no `extensions` schema.

1. **`supabase/bootstrap/platform-roles.sql`**: creates `anon`, `authenticated`
   and `service_role` (NOLOGIN) if they are missing. Nothing else.
2. **Every `supabase/migrations/NNN_*.sql` in order, verbatim** (`001`, then
   `002`, then `003`). No preprocessing: `GRANT`/`REVOKE`, `CREATE POLICY` and
   the `CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA public` of `btree_gist`
   and `pgcrypto` run as written. `001` creates `current_sede_id()` with a call
   to `auth.jwt()` (allowed because its preamble sets
   `check_function_bodies = false`), `002` replaces it with a body that reads
   `request.jwt.claims` directly, and `003` adds free payment-method codes,
   explicit arqueo modes and frozen per-method opening bases.
3. **`seeds/catalog.sql`**: roles, cash register, denominations, payment
   methods, taxes, settings.

`portable-platform.db.test.ts` covers that install path, the idempotency of
`002`, the ACL after `002`, and the equivalence of `current_sede_id()` against
Supabase's own `auth.jwt()` definition.

The result is dumped once per test file (`dumpDataDir`). Every test gets a fresh
instance loaded from that dump (`freshDb()`, about 1 s) instead of re-applying
the schema. `closeDb()` in `afterEach` tolerates a `beforeEach` that failed
before creating the instance. Tests call RPCs as `SELECT public.<fn>(...)`
through `rpc()`, with payloads shaped like the ones in
`src/features/*/service.ts` (`fixtures.ts` and the per-file builders).

## Monetary RPC contract (direct connection)

Money operations keep the database RPC as their **unit of work**: call it as one
`SELECT public.fn(...)` statement with bound parameters and explicit casts
(`numeric`, `boolean`, `uuid[]`, `jsonb`, etc.). Do not rebuild its transaction
client-side. In one monetary operation, do not mix Drizzle queries and an RPC
from a different engine; select the engine once and keep the RPC boundary.

## What is characterized

| Area | Function / object | Behaviors pinned |
|---|---|---|
| Cash | `cash_open_shift_atomic` | opening count and one `cash_shift_method_balances` row per active arqueable method written atomically; second open shift is `SHIFT_ALREADY_OPEN`; `uq_cash_shifts_open_per_register` is the final barrier (23505); `SHIFT_INVALID`, `SHIFT_REGISTER_NOT_FOUND`, `SHIFT_BALANCE_MISMATCH` |
| | `cash_close_shift_atomic` | amounts written verbatim plus the closing count; four-key token required; `SHIFT_ALREADY_CLOSED`; the `expected_cash >= 0` CHECK raises 23514; `ARQUEO_STALE` with no write for **each source**: `payments`, `invoice_payments` (both the row of the shift and the historical row without shift whose invoice belongs to it), `commission_payouts`, and `voucher_requests` (only approved vouchers with a method count) |
| | `cash_recount_shift_atomic` | closed shifts only (`SHIFT_NOT_CLOSED`); once per shift (`ALREADY_RECOUNTED`); the signed close is not touched; a cash line is required |
| | `cash_invoice_payment_atomic` | writes the mirror row (`invoice_payments`, marked) and the drawer row (`payments`, unmarked); closes with `closed_by`/`closed_at`; a replay with the same mark is 23505 on `uq_invoice_payments_invoice_idempotency_key` and rolls back both rows; mark required (`PAYMENT_INVALID`); `SHIFT_CLOSED`, `SHIFT_NOT_FOUND`; overpayment P0001 (the card fee rides on top of the net cap); `ANNUL_INVALID`; `p_set_shift` decides the invoice's shift link |
| | `invoice_split_payment_atomic` | all portions or none; mark only on the first one (two marks is `PAYMENT_INVALID`); writes no `payments` row; replay is 23505 and rolls back every portion; overpayment rolls back everything; portions of another shift are `PAYMENT_INVALID`; `SHIFT_CLOSED` |
| | `trg_commission_payouts_cap` + 003 balance guard | partial payouts up to `earned_immediate`; the excess is P0001; a row without `earned_immediate` is rejected; idempotency per (invoice, employee, key). The 003 guard also rejects a commission or approved voucher that would leave an arqueable method below 50% of its frozen opening base (`CASH_METHOD_MINIMUM_BREACH`); a legacy open shift without a frozen row is `CASH_METHOD_BALANCE_REQUIRED`. Pending/rejected vouchers never count; approved → rejected is `VOUCHER_CASH_OUT_IMMUTABLE`; moving a collection between methods is rejected with `CASH_METHOD_BALANCE_UPDATE_BREACH` when either method would fall below its floor (both rows/balances unchanged); any real method/amount/shift change of a collection on a legacy shift without frozen balances is `CASH_METHOD_BALANCE_REQUIRED` (rows unchanged), while an unchanged rewrite stays allowed. A method made arqueable after opening needs no hidden base: any real move or outflow using it is `CASH_METHOD_BALANCE_REQUIRED`; a method frozen at opening remains guarded even if its catalog mode later becomes `none`. |
| Billing | `invoice_create_atomic` + `next_invoice_number` | no number gaps, even when an emission fails; `SHIFT_NOT_OPEN`; stock deducted with `{consecutivo}` substituted; an idempotency-key replay raises **23505** and burns no number; `INVOICE_INVALID` burns no number either |
| | `invoice_annul_atomic` | CAS on status (`ANNUL_CONFLICT`); stock returned with IN movements; `PRODUCT_NOT_FOUND` rolls back the annulment |
| | `invoice_edit_items_atomic` | items removed, updated and inserted; stock moved by the given net delta; `edit_version` +1; **totals untouched**; a stale version or status is `EDIT_CONFLICT` with no write; an `INSUFFICIENT_STOCK` rolls back the items; payments are re-methoded, never re-amounted (`PAYMENT_MISMATCH` for an unknown payment) |
| | `invoice_edit_emitted_atomic` | tax snapshot replaced (old rows deleted by id, new ones inserted); the five totals rewritten verbatim; stock adjusted; `TAX_MISMATCH` keeps the old snapshot and totals; totals object required (`EDIT_INVALID`); `EDIT_CONFLICT` |
| | `trg_invoice_payments_cap` | partial payments allowed; overpayment is P0001; the cap is net of the card fee |
| Inventory | `trg_inventory_apply_stock`, `trg_inventory_no_negative` | IN adds, OUT subtracts, ADJUST sets; `INSUFFICIENT_STOCK`; `PRODUCT_NOT_FOUND`; `products_stock_qty_check` is the only barrier against a negative stock; per-product idempotency index |
| | `deduct_stock_atomic` | all or nothing; `DEDUCTION_INVALID` (empty plan, repeated product); `PRODUCT_NOT_FOUND` |
| Payroll | `payroll_apply_atomic` | recalculating **replaces** the item values (upsert) and does **not** duplicate the debts or change their amounts; resending the **same voucher** is **`PAYROLL_VOUCHER_CONFLICT`** with full rollback (item, debts and voucher unchanged; not a silent no-op); carry ids replay as a no-op; `PAYROLL_ITEM_MISMATCH`, `PAYROLL_INVALID` |
| | `payroll_delete_period_atomic` | draft only (`PAYROLL_PERIOD_CONFLICT`); vouchers reverted to their states; `PERIOD_OVERLAP_AMBIGUOUS` against a closed period of another cadence, including **NULL vs 'mensual'** in both directions; `PAYROLL_VOUCHER_CONFLICT` |
| | `payroll_correct_period_atomic` | closed periods only (`PERIOD_NOT_CLOSED`); one correction per period (23505 on `uq_payroll_period_corrections_period`); frozen rows written verbatim; `payroll_items` not touched; `PAYROLL_CORRECTION_MISMATCH` rolls back the header; a repeated employee is `PAYROLL_INVALID` |
| | `ex_payroll_periods_no_overlap` | 23P01 for the same frequency, NULL frequency included; adjacent ranges and different frequencies are allowed |
| | `trg_payroll_payments_cap` | payment above `net_pay` is P0001 |
| Users | `replace_user_roles` | sorted, deduplicated result; never zero roles (`ROLE_NOT_FOUND` keeps the old set); `USER_NOT_FOUND` |
| | `confirm_password_reset` | single use; used, expired or unknown token is `RESET_TOKEN_INVALID` and writes nothing; all sessions revoked |
| | `change_user_password` | CAS (`PASSWORD_CHANGED_ELSEWHERE`, no write); the precondition is required (`PASSWORD_INVALID`); the other sessions are revoked **in place** (`revoked = true`, not deleted) and the current one stays live |
| | `create_user_with_role` | user and roles in one transaction; `must_change_password = true`; an empty email is stored as NULL; `ROLE_NOT_FOUND`, `USER_INVALID` and `USER_EXISTS` write nothing |
| | `ensure_user_has_role` | adds the role only when the user has **none**; never adds to an existing set; `ROLE_NOT_FOUND`, `USER_NOT_FOUND` |
| | `upsert_employee_atomic` | account, role and record created together; `payout_mode`/`is_active` defaults unless sent; an existing user keeps its roles; an invalid cadence (`EMPLOYEE_INVALID`), `USER_EXISTS` and `USER_NOT_FOUND` write nothing |
| Direct engine | `drizzleServicesRepo` (`services.repo.db.test.ts`) | `drizzle-orm/pglite` over `freshDb()`; one table of equivalence cases runs against the supabase-js adapter and the Drizzle adapter with the same expected result (see the note below); `numeric(12,2)` comes back as a JS number; `toDbError` keeps P0001, 23505 (with detail), 23514 and 23P01 |
| | admin user management (`admin-users.service.db.test.ts`) | `listSedeUsers`, `upsertEmployee` (create via `upsert_employee_atomic`, edit), `setUserRoles` through the service on both engines; postgres never builds a Supabase client. Intentional change on both engines: the sede is a quoted PostgREST literal / bound parameter (adversarial `,` `)` `"` stay data) and the order is total (`full_name`, `id`). Superadmin is refused in both directions and zero roles before the RPC |
| | `bootstrap/app-role.sql` (`app-role.db.test.ts`) | `orabella_app` is LOGIN BYPASSRLS without password, member of `service_role` only; reads the 36 tables with `SET ROLE`; exactly SELECT/INSERT/UPDATE/DELETE (no TRUNCATE); writes through RLS; runs `replace_user_roles`; idempotent. **Supabase guard:** if `supabase_admin`, `supabase_auth_admin` or `supabase_storage_admin` exists, it aborts (P0001) without creating or changing anything; an `auth` schema alone does not trigger it |

**What the "equivalence" proves, and what it does not.** Only the Drizzle side
runs against real PostgreSQL (PGlite). The supabase-js side runs against a
**hand-written double** of PostgREST inside `services.repo.db.test.ts`, not
against a real PostgREST: it checks that both adapters map the same answers to
the same domain result. The exact request the supabase-js adapter sends
(columns, `order("name")`, `limit`, the upsert payload and `onConflict: "id"`)
is pinned by the characterization in `tests/admin-services.test.ts`, which ran
before the extraction and still passes after it.

Behaviors worth knowing (characterized, not corrected):

- The database does not de-duplicate an invoice or a payment replay: the
  partial unique index raises 23505. The service handles idempotency with its
  lookup plus that 23505.
- Neither payment RPC compares collected vs billed. The status follows
  `p_mark_paid` as decided by the service: a full payment with `false` stays
  `Emitida`, and a partial one with `true` closes the invoice. The only
  database barrier is the overpayment cap (031).
- `invoice_edit_items_atomic` writes line subtotals verbatim even when they no
  longer add up to the invoice total. "The total does not change" is enforced
  by the service, because the function has no money column to write.
  `invoice_edit_emitted_atomic` does not check the totals arithmetic either:
  the `invoices_total_surcharge_check` CHECK is the barrier (23514).
- `PERIOD_OVERLAP_AMBIGUOUS` can only happen across **different** cadences
  (NULL counts as its own cadence), because the EXCLUDE already stops
  same-cadence overlaps.

## Out of scope (not covered yet)

- **Real concurrency.** PGlite has one connection, so `FOR UPDATE`/`FOR SHARE`,
  lock ordering, and "the second caller waits and then sees the new row" cannot
  be tested here. These tests cover the **sequential** guarantees that make
  those locks safe: CAS in `WHERE`, count nets, partial unique indexes,
  idempotency keys and the ordered commission+voucher balance sequence. The
  003 trigger locks `cash_shifts` then the per-method balance row; real
  two-connection PostgreSQL still needs to verify waiting behavior.
- **RLS.** Tests run as the PGlite superuser, which bypasses policies. Policies
  are created and inventoried, but not exercised.
- **`discard_created_user`** has no test yet. PGlite does not block it; it is
  the low-priority compensation of a user creation.
- **Count nets** (`*_MISMATCH` raised because an `INSERT` wrote
  fewer rows than requested) are only reachable through a `JOIN` that drops
  rows. They are covered where such a `JOIN` exists (unknown product, employee
  or payment). The remaining nets cannot be triggered with valid input by
  design.

## Known debt (outside this suite)

- **`supabase/test-bootstrap.sql` (the E2E base) drifted: it does not include
  `002`.** It is still `001` + `seeds/catalog.sql` + `seeds/acceptance.sql`, so
  its `current_sede_id()` still calls `auth.jwt()`. This works on a Supabase
  test project, which has `auth`, and fails to *call* on a plain PostgreSQL.
  Pending: regenerate it with `002` after `001` (squash README, steps 2.8 and
  7.5). It was left alone on purpose in this phase.
- **A clean PostgreSQL install is not usable by the app yet.** The bootstrap
  creates `service_role` without `BYPASSRLS` and without table privileges,
  because `001` relies on Supabase's default privileges on `public`. These
  tests run as the PGlite superuser, so they do not see it. Phase 3 defines the
  application role (squash README §9.6).

- `src/features/billing/service.ts:1352-1353`: the comment says the two unique
  indexes that can raise 23505 are `(sede_id, consecutive_number)` and
  `(sede_id, idempotency_key)`. Since 077 neither includes `sede_id`: they are
  `invoices_consecutive_number_key (consecutive_number)` and
  `uq_invoices_sede_idempotency_key (idempotency_key)`, the second keeping the
  old name. Comment only. It was left alone because this phase does not touch
  `src/`.

## Backup restore check (`scripts/verify-backup-restore.ts`)

This script reads a backup folder and does not modify it. It writes one file,
`verificacion-restauracion-pglite.txt`, in that same folder. It never connects
to a remote database. Steps:

1. Checks `SHA256SUMS.txt`. A listed file that is missing is reported as a
   FAILURE and the run continues.
2. Builds the schema (bootstrap + `001` + `002`, without the catalog seed).
   `prod-version.txt` is optional and informative: when it is missing, the
   report says so. The report states one **expected difference**: until `002`
   is applied in production, production's `current_sede_id()` still calls
   `auth.jwt()`. Step 6 compares signatures, so it cannot see it. The script
   fails if the repo's body still references `auth.`.
3. Loads `prod-public-data.sql` with `session_replication_role = replica` (the
   same as `pg_restore --disable-triggers`). The dump holds trigger results
   such as `products.stock_qty`, so the triggers must not fire again. `\restrict`
   and `\unrestrict` are skipped. `COPY ... FROM stdin` blocks go through
   PGlite's `/dev/blob`.
4. Checks every foreign key explicitly.
5. Compares exact row counts per table against `prod-conteos.txt`.
6. Compares the catalog inventory against `prod-catalogo.txt`: own functions
   (extension functions excluded with `pg_depend deptype = 'e'`), triggers,
   constraints, indexes and policies. The "difference is only extension
   functions" note is printed only when the own functions match exactly.

Required files: `SHA256SUMS.txt`, `prod-public-data.sql`, `prod-conteos.txt`,
`prod-catalogo.txt`. Exit code: 0 OK, 1 differences, 2 bad arguments.

`prod-public.dump` (`-Fc`) is only checksummed. Reading it needs `pg_restore`,
which is not available here.

### Node version

The script runs as TypeScript with Node's built-in type stripping, with no
loader. That feature is on by default from **Node 22.18.0 / 23.6.0**. On
earlier versions, `npm run verify:backup` fails while parsing the file. It was
verified on Node 24.19.

`package.json` still declares `"engines": { "node": ">=20" }`. It was **not**
raised on purpose, because Vercel uses `engines.node` to override the
project's Node version. Today `>=20` resolves to the latest 24.x on Vercel.
Raising it to `>=22.18.0` would most likely resolve to 24.x too, but that is a
production runtime decision and it is not taken here. `test:db` runs under
Vitest and has no such requirement.
