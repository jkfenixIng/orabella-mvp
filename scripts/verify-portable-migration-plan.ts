import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMigrationPlan, discoverMigrations, type MigrationPlan, type MigrationState } from "./plan-portable-migrations.ts";

function fail(message: string): never {
  throw new Error(`portable migration verification: ${message}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usage(): never {
  console.error("usage: node scripts/verify-portable-migration-plan.ts --state <applied-state.json> --plan <plan.json> [--migrations <dir>]");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function main(): void {
  if (process.argv.includes("--help")) usage();
  const statePath = argument("--state");
  const planPath = argument("--plan");
  const migrations = argument("--migrations") ?? "supabase/migrations";
  if (!statePath || !planPath) usage();

  const state = readJson<MigrationState>(resolve(statePath));
  const supplied = readJson<MigrationPlan>(resolve(planPath));
  const expected = buildMigrationPlan(
    discoverMigrations(resolve(migrations)),
    supplied.applied,
    supplied.deferred.map((migration) => migration.filename),
  );
  if (!same(supplied, expected)) fail("plan does not match the current migration hashes, initial ledger, or deferred scope");
  if (!same(state.applied, supplied.expectedApplied)) fail("destination applied-state does not match the plan's expected applied ledger");
  if (!same(state.deferred ?? [], supplied.deferred.map((migration) => migration.filename))) {
    fail("destination deferred scope does not match the plan");
  }
  console.log(`verified manifest ${supplied.manifestSha256}`);
}

main();
