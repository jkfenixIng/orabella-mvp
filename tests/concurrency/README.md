# Real PostgreSQL concurrency suite

```bash
npm run test:concurrency
```

The suite starts a private PostgreSQL cluster with `initdb --auth=trust -E UTF8 --locale=C`, applies the bootstrap/migrations/seeds, and uses three `postgres-js` connections: observer plus two contenders. It is intentionally separate from `npm test` and `npm run test:db`.

The eleven scenarios exercise real row-lock waits, concurrent callers, idempotency and payroll/cash invariants. The observer proves controlled waits through both `pg_stat_activity` and `pg_locks`; the edit-vs-commission deadlock probe repeats twenty times and reports any `40P01` as a failure.

## Isolation and cleanup

- The runner creates only `%LOCALAPPDATA%\Temp\opencode\orabella-pgtmp-<id>` and chooses a random loopback port that is never `5432`.
- It never connects to, starts, stops, or changes the Windows PostgreSQL service.
- Each directory has `orabella-concurrency-cluster.json`, recording its runner PID, port and creation time. Teardown refuses to stop a directory without this runner's matching PID marker.
- Global `try/finally`, `SIGINT`, and `SIGTERM` handlers stop the owned postmaster with `pg_ctl -m fast -w` and remove the directory. Each scenario has a 60-second timeout; the runner cancels/rolls back active contenders before continuing so a defect is reported rather than hidden by a hung suite.

## Recovery after an interrupted process

First confirm the marker belongs to the interrupted `test:concurrency` runner. Then stop only that directory; do **not** target the service data directory or port 5432:

```powershell
$dir = "${env:LOCALAPPDATA}\Temp\opencode\orabella-pgtmp-<id>"
Get-Content "$dir\orabella-concurrency-cluster.json"
& "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D $dir -m fast -w -t 60 stop
Remove-Item -LiteralPath $dir -Recurse -Force
```

Set `ORABELLA_PG_BIN` when PostgreSQL binaries are installed outside `C:\Program Files\PostgreSQL\18\bin`.
