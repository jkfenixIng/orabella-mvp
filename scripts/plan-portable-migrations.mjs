import console from "node:console";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { buildMigrationPlan, discoverMigrations, fail, readJson } from "./portable-migrations.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function usage() {
  console.error("usage: node scripts/plan-portable-migrations.mjs --state <scope-manifest.json> --output <plan.json> [--migrations <dir>]");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

if (process.argv.includes("--help")) usage();
const statePath = value("--state");
const output = value("--output");
if (!statePath || !output) usage();

const state = readJson(resolve(statePath));
if (!Array.isArray(state.applied) || (state.deferred !== undefined && !Array.isArray(state.deferred))) {
  fail(`invalid scope manifest ${statePath}`);
}
const plan = buildMigrationPlan(discoverMigrations(resolve(value("--migrations") ?? "supabase/migrations")), state.applied, state.deferred ?? []);
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), `${JSON.stringify(plan, null, 2)}\n`);
console.log(`manifest ${plan.manifestSha256}`);
console.log(`apply ${plan.apply.map((migration) => migration.filename).join(" ") || "(none)"}`);
console.log(`deferred ${plan.deferred.map((migration) => migration.filename).join(" ") || "(none)"}`);
