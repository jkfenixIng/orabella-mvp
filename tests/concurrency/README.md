# Real PostgreSQL concurrency suite

```bash
npm run test:concurrency
```

The suite starts a private PostgreSQL cluster, applies bootstrap/migrations/seeds, and uses one observer plus three independent `postgres-js` contenders. It is separate from `npm test` and `npm run test:db`. The runner requires Node 22.18+ or 23.6+ because it executes TypeScript directly; this guard applies only to the test command and does not change the production `engines` contract.

## What is verified

Every listed scenario is interleaved deliberately. One contender holds the relevant PostgreSQL lock, another is observed waiting through both `pg_stat_activity` and `pg_locks`, and only then is the holder released.

- shift open, close/payment, double-close, method-floor, payroll-payment cap;
- stale arqueo: a collection commits after the close snapshot but before its lock, and close rejects exactly with `ARQUEO_STALE`;
- invoice edits versus commission inserts: twenty lock-observed repetitions, permitted loser states are explicit, and `40P01` must stay zero;
- invoice creation: an observed sequence lock yields adjacent consecutive numbers;
- invoice idempotency: the blocked loser is exactly `23505` and the stored winner is re-looked up;
- payroll apply: the waiting loser is exactly `P0001/PAYROLL_VOUCHER_CONFLICT`; the winner leaves the two documented carry kinds and consumes the voucher once.

## Isolation and cleanup

- The runner creates only `%LOCALAPPDATA%\Temp\opencode\orabella-pgtmp-<id>` and chooses a random loopback port that is never `5432`.
- It never connects to, starts, stops, or changes the Windows PostgreSQL service.
- Each directory has `orabella-concurrency-cluster.json`, recording its runner PID, port and creation time. Teardown refuses a missing or non-owned marker.
- Teardown fails closed: it stops the owned postmaster, proves the recorded process and loopback port are gone, removes the directory, and fails the runner if any step fails. A timeout cancels active backends, rolls back contenders, and waits for the timed-out operation to settle before the next scenario.

Set `ORABELLA_PG_BIN` when PostgreSQL binaries are installed outside `C:\Program Files\PostgreSQL\18\bin`.
