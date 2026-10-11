// Executes a deterministic portable migration plan. Before any migration it
// checks the runner identity, re-reads the LIVE ledger and refuses a stale plan,
// and refuses any pending migration whose schema marker is already true.
// Each migration file owns BEGIN/COMMIT; its ledger INSERT runs in the same psql
// session only after the file succeeded (ON_ERROR_STOP). A crash between the
// file's COMMIT and the INSERT leaves the ledger behind: run `reconcile`.
import console from "node:console";
import { commandContext, runCommand } from "./portable-migration-cli.mjs";
import { applyPlan } from "./portable-migration-runner.mjs";

const usageText =
  "usage: MIGRATION_DATABASE_URL=<migration-runner-url> node scripts/apply-portable-migration-plan.mjs --plan <plan.json> [--migrations <dir>] [--psql <absolute psql path>]";

await runCommand(async () => {
  const applied = await applyPlan(commandContext(usageText));
  console.log(`applied ${applied.join(" ") || "(none)"}`);
});
