// Shared CLI wiring for apply / reconcile / verify. Only argument parsing and
// adapter construction live here; the rules live in portable-migration-runner.mjs.
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { createPsqlDatabase, migrationUrl, resolvePsql } from "./portable-migration-db.mjs";
import { discoverMigrations, readJson } from "./portable-migrations.mjs";

export function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function usage(text) {
  console.error(text);
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

export function commandContext(usageText) {
  if (process.argv.includes("--help")) usage(usageText);
  const planPath = argument("--plan");
  if (!planPath) usage(usageText);
  const migrationsDir = resolve(argument("--migrations") ?? "supabase/migrations");
  const db = createPsqlDatabase({ psql: resolvePsql(argument("--psql")), url: migrationUrl() });
  return {
    plan: readJson(resolve(planPath)),
    discovered: discoverMigrations(migrationsDir),
    db,
    readSource: (filename) => readFileSync(join(migrationsDir, filename)),
  };
}

export async function runCommand(action) {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
