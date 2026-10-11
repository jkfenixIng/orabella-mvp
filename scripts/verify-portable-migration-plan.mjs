// Verifies against the LIVE database: the ledger equals the plan's expected
// applied migrations and every expected migration's versioned marker is true.
import console from "node:console";
import { commandContext, runCommand } from "./portable-migration-cli.mjs";
import { verifyPlan } from "./portable-migration-runner.mjs";

const usageText =
  "usage: MIGRATION_DATABASE_URL=<migration-runner-url> node scripts/verify-portable-migration-plan.mjs --plan <plan.json> [--migrations <dir>] [--psql <absolute psql path>]";

await runCommand(async () => {
  const manifest = await verifyPlan(commandContext(usageText));
  console.log(`verified manifest ${manifest}`);
});
