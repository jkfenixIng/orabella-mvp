// Node 20 runnable: node tests/portable-migration-cli.test.mjs
// Planner CLI end-to-end over fixture migrations; no database is contacted.
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMigrationPlan, discoverMigrations } from "../scripts/portable-migrations.mjs";
import { resolvePsql } from "../scripts/portable-migration-db.mjs";
import { MIGRATION_MARKERS } from "../scripts/portable-migration-markers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planner = join(root, "scripts", "plan-portable-migrations.mjs");
const apply = join(root, "scripts", "apply-portable-migration-plan.mjs");
const directory = mkdtempSync(join(tmpdir(), "orabella-portable-cli-"));
const fixtures = join(directory, "migrations");
const fixtureContracts = Object.fromEntries([2, 3, 4, 5, 6, 7].map((version) => [`00${version}_fixture.sql`, { sql: "SELECT true AS present" }]));

const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });

try {
  mkdirSync(fixtures);
  for (const version of [2, 3, 4, 5, 6, 7]) writeFileSync(join(fixtures, `00${version}_fixture.sql`), `SELECT ${version};\n`);
  const discovered = discoverMigrations(fixtures, fixtureContracts);

  // 002-007 with a governed 006+007 suffix deferred.
  const deferredPlan = buildMigrationPlan(discovered, [], ["006_fixture.sql", "007_fixture.sql"], fixtureContracts);
  assert.deepEqual(deferredPlan.apply.map((migration) => migration.filename), ["002_fixture.sql", "003_fixture.sql", "004_fixture.sql", "005_fixture.sql"]);
  assert.deepEqual(deferredPlan.deferred.map((migration) => migration.filename), ["006_fixture.sql", "007_fixture.sql"]);
  assert.throws(() => buildMigrationPlan(discovered, [], ["006_fixture.sql"], fixtureContracts), /contiguous suffix/);

  // Skipped 003 and hash mismatch in the applied state.
  const [m2, , m4] = deferredPlan.expectedApplied;
  assert.throws(() => buildMigrationPlan(discovered, [m2, m4], [], fixtureContracts), /contiguous prefix/);
  assert.throws(() => buildMigrationPlan(discovered, [{ ...m2, sha256: "f".repeat(64) }], [], fixtureContracts), /hash mismatch/);

  // Duplicate and out-of-order versions on disk.
  writeFileSync(join(fixtures, "003_duplicate.sql"), "SELECT 33;\n");
  assert.throws(() => discoverMigrations(fixtures, { ...fixtureContracts, "003_duplicate.sql": { sql: "SELECT true AS present" } }), /duplicate migration version 003/);
  rmSync(join(fixtures, "003_duplicate.sql"));

  // CLI: the real marker registry has no contract for fixture files, so planning fails closed.
  const state = join(directory, "state.json");
  writeFileSync(state, JSON.stringify({ applied: [], deferred: [] }));
  let result = run(planner, ["--state", state, "--output", join(directory, "plan.json"), "--migrations", fixtures]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing marker contract for 002_fixture\.sql/);

  // CLI: the real repository migrations all have marker contracts.
  const output = join(directory, "repo-plan.json");
  result = run(planner, ["--state", state, "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  const repoPlan = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(repoPlan.format, 2);
  assert.match(repoPlan.markerContractsSha256, /^[a-f0-9]{64}$/);
  const cashOpeningMarker = MIGRATION_MARKERS["009_cash_opening_bounds.sql"].sql;
  for (const required of ["rolname IN ('anon', 'authenticated')", "cash_open_shift_atomic_legacy", "has_function_privilege", "grantee = 0"]) {
    assert.ok(cashOpeningMarker.includes(required), `009 marker must check ${required}`);
  }
  assert.deepEqual(repoPlan.discovered.map((migration) => migration.filename), [
    "002_portable_platform.sql", "003_payment_method_arqueo.sql", "004_inventory_literal_search.sql",
    "005_cop_whole_peso.sql", "006_installation_owner.sql", "007_money_cap_policy.sql",
    "008_inactive_payment_method_arqueo.sql", "009_cash_opening_bounds.sql",
  ]);
  const deferred = ["006_installation_owner.sql", "007_money_cap_policy.sql", "008_inactive_payment_method_arqueo.sql", "009_cash_opening_bounds.sql"];
  const repoDeferred = buildMigrationPlan(repoPlan.discovered, [], deferred);
  assert.deepEqual(repoDeferred.apply.map((migration) => migration.filename), [
    "002_portable_platform.sql", "003_payment_method_arqueo.sql", "004_inventory_literal_search.sql", "005_cop_whole_peso.sql",
  ]);
  assert.deepEqual(repoDeferred.deferred.map((migration) => migration.filename), deferred);

  // Apply refuses missing MIGRATION_DATABASE_URL, the app DATABASE_URL, and an unsafe psql path before contacting a DB.
  result = run(apply, ["--plan", output], { MIGRATION_DATABASE_URL: "", DATABASE_URL: "" });
  assert.match(result.stderr, /MIGRATION_DATABASE_URL is required/);
  result = run(apply, ["--plan", output, "--psql", process.execPath], { MIGRATION_DATABASE_URL: "postgres://app", DATABASE_URL: "postgres://app" });
  assert.match(result.stderr, /must not equal the application DATABASE_URL/);
  result = run(apply, ["--plan", output, "--psql", "psql"], { MIGRATION_DATABASE_URL: "postgres://migration", DATABASE_URL: "postgres://app" });
  assert.match(result.stderr, /absolute path/);

  // psql path validation is shell-free.
  const exe = process.platform === "win32" ? "C:\\pg\\bin\\psql.exe" : "/usr/bin/psql";
  assert.throws(() => resolvePsql("relative/psql"), /absolute path/);
  assert.throws(() => resolvePsql(`${exe}&calc`), /shell metacharacters/);
  assert.throws(() => resolvePsql("C:\\pg\\psql.cmd", { platform: "win32" }), /\.exe on Windows/);
  assert.throws(() => resolvePsql(join(directory, process.platform === "win32" ? "missing.exe" : "missing")), /existing file/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("portable migration CLI tests passed");
