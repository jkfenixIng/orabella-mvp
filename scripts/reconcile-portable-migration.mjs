// Crash recovery for the first pending migration only: records it in the ledger
// (reconciled = true, with the operator's reason) when its marker proves it
// committed and no later pending marker is true. Never records a false marker.
import console from "node:console";
import { argument, commandContext, runCommand } from "./portable-migration-cli.mjs";
import { reconcilePlan } from "./portable-migration-runner.mjs";

const usageText =
  'usage: MIGRATION_DATABASE_URL=<migration-runner-url> node scripts/reconcile-portable-migration.mjs --plan <plan.json> --reason "<incident reference>" [--migrations <dir>] [--psql <absolute psql path>]';

await runCommand(async () => {
  const context = commandContext(usageText);
  const filename = await reconcilePlan({ ...context, reason: argument("--reason") });
  console.log(`reconciled ${filename}`);
});
