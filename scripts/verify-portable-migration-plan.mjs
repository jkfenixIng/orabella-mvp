import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildMigrationPlan, discoverMigrations, fail, readJson, same } from "./portable-migrations.mjs";

const ledgerQuery = `SELECT jsonb_build_object(
  'applied', coalesce(jsonb_agg(jsonb_build_object('filename', filename, 'sha256', sha256) ORDER BY filename), '[]'::jsonb)
)::text FROM public.portable_migration_audit;`;

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function usage() {
  console.error("usage: MIGRATION_DATABASE_URL=<migration-runner-url> node scripts/verify-portable-migration-plan.mjs --scope <scope-manifest.json> --plan <plan.json> --markers <schema-markers.json> [--migrations <dir>] [--psql <path>]");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

function migrationUrl() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is required");
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) fail("MIGRATION_DATABASE_URL must not equal the application DATABASE_URL");
  return url;
}

function ledger(url, psql) {
  const result = spawnSync(psql, [url, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", ledgerQuery], {
    encoding: "utf8",
    shell: process.platform === "win32" && psql.endsWith(".cmd"),
  });
  if (result.status !== 0) throw new Error(`portable migration verification: ledger query failed\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

if (process.argv.includes("--help")) usage();
const scopePath = value("--scope");
const planPath = value("--plan");
const markersPath = value("--markers");
if (!scopePath || !planPath || !markersPath) usage();

const scope = readJson(resolve(scopePath));
const plan = readJson(resolve(planPath));
if (!Array.isArray(scope.applied) || !Array.isArray(scope.deferred) || !Array.isArray(plan.applied) || !Array.isArray(plan.deferred)) {
  fail("invalid scope or plan JSON");
}
const expected = buildMigrationPlan(
  discoverMigrations(resolve(value("--migrations") ?? "supabase/migrations")),
  plan.applied,
  plan.deferred.map((migration) => migration.filename),
);
if (!same(plan, expected)) fail("plan does not match current migration hashes, initial ledger, or deferred scope");
if (!same(scope.deferred, plan.deferred.map((migration) => migration.filename))) fail("scope deferred suffix does not match plan");
const finalLedger = ledger(migrationUrl(), value("--psql") ?? "psql");
if (!same(finalLedger.applied, plan.expectedApplied)) fail("migration audit ledger does not match the plan's expected applied migrations");
const markers = readJson(resolve(markersPath));
for (const migration of plan.expectedApplied) {
  if (markers[migration.filename] !== true) fail(`schema marker missing or false for ${migration.filename}`);
}
console.log(`verified manifest ${plan.manifestSha256}`);
