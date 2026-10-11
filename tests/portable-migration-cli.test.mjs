import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plan = join(root, "scripts", "plan-portable-migrations.mjs");
const verify = join(root, "scripts", "verify-portable-migration-plan.mjs");
const apply = join(root, "scripts", "apply-portable-migration-plan.mjs");
const directory = mkdtempSync(join(tmpdir(), "orabella-portable-cli-"));
const migrations = join(directory, "migrations");
const state = join(directory, "state.json");
const output = join(directory, "plan.json");
const markers = join(directory, "markers.json");

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

function runWithEnv(env, script, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
}

function writeMigration(version) {
  writeFileSync(join(migrations, `${String(version).padStart(3, "0")}_fixture.sql`), `SELECT ${version};\n`);
}

await import("node:fs/promises").then(({ mkdir }) => mkdir(migrations));
for (const version of [2, 3, 4, 5, 6, 7]) writeMigration(version);
writeFileSync(state, JSON.stringify({ applied: [], deferred: ["006_fixture.sql", "007_fixture.sql"] }));

let result = run(plan, "--state", state, "--output", output, "--migrations", migrations);
assert.equal(result.status, 0, result.stderr);
let generated = JSON.parse(readFileSync(output, "utf8"));
assert.deepEqual(generated.apply.map((migration) => migration.filename), ["002_fixture.sql", "003_fixture.sql", "004_fixture.sql", "005_fixture.sql"]);
assert.deepEqual(generated.deferred.map((migration) => migration.filename), ["006_fixture.sql", "007_fixture.sql"]);

writeFileSync(state, JSON.stringify({ applied: [generated.expectedApplied[0], generated.expectedApplied[2]], deferred: ["006_fixture.sql", "007_fixture.sql"] }));
result = run(plan, "--state", state, "--output", output, "--migrations", migrations);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /contiguous prefix/);

writeFileSync(state, JSON.stringify({ applied: [], deferred: ["006_fixture.sql"] }));
result = run(plan, "--state", state, "--output", output, "--migrations", migrations);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /contiguous suffix/);

writeFileSync(state, JSON.stringify({ applied: [], deferred: [] }));
result = run(plan, "--state", state, "--output", output, "--migrations", migrations);
assert.equal(result.status, 0, result.stderr);
generated = JSON.parse(readFileSync(output, "utf8"));
writeFileSync(state, JSON.stringify({ applied: [], deferred: [] }));
writeFileSync(markers, JSON.stringify(Object.fromEntries(generated.expectedApplied.map((migration) => [migration.filename, true]))));

result = runWithEnv({ MIGRATION_DATABASE_URL: "", DATABASE_URL: "" }, apply, "--plan", output, "--migrations", migrations);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /MIGRATION_DATABASE_URL is required/);

result = runWithEnv({ MIGRATION_DATABASE_URL: "postgres://app", DATABASE_URL: "postgres://app" }, apply, "--plan", output, "--migrations", migrations);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /must not equal the application DATABASE_URL/);

const captured = join(directory, "captured.sql");
const fakePsqlScript = join(directory, "fake-psql.mjs");
writeFileSync(
  fakePsqlScript,
  `import { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.includes("-c")) { process.stdout.write(${JSON.stringify(JSON.stringify({ applied: generated.expectedApplied }))}); process.exit(0); }\nappendFileSync(${JSON.stringify(captured)}, readFileSync(args[args.indexOf("-f") + 1], "utf8") + "\\n-- next\\n");\n`,
);
const fakePsql = join(directory, process.platform === "win32" ? "fake-psql.cmd" : "fake-psql");
writeFileSync(
  fakePsql,
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fakePsqlScript}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakePsqlScript}" "$@"\n`,
);
if (process.platform !== "win32") chmodSync(fakePsql, 0o755);
result = runWithEnv({ MIGRATION_DATABASE_URL: "postgres://migration", DATABASE_URL: "postgres://app" }, apply, "--plan", output, "--migrations", migrations, "--psql", fakePsql);
assert.equal(result.status, 0, result.stderr);
const appliedSql = readFileSync(captured, "utf8");
assert.equal((appliedSql.match(/SET ROLE migration_operator;/g) ?? []).length, 6);
assert.ok(appliedSql.indexOf("SELECT 2;") < appliedSql.indexOf("'002_fixture.sql'"));
assert.ok(appliedSql.indexOf("'002_fixture.sql'") < appliedSql.indexOf("SELECT 3;"));
result = runWithEnv(
  { MIGRATION_DATABASE_URL: "postgres://migration", DATABASE_URL: "postgres://app" },
  verify,
  "--scope",
  state,
  "--plan",
  output,
  "--markers",
  markers,
  "--migrations",
  migrations,
  "--psql",
  fakePsql,
);
assert.equal(result.status, 0, result.stderr);

writeFileSync(join(migrations, "003_fixture.sql"), "SELECT 333;\n");
result = runWithEnv(
  { MIGRATION_DATABASE_URL: "postgres://migration", DATABASE_URL: "postgres://app" },
  verify,
  "--scope",
  state,
  "--plan",
  output,
  "--markers",
  markers,
  "--migrations",
  migrations,
  "--psql",
  fakePsql,
);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /hashes/);

result = runWithEnv({ MIGRATION_DATABASE_URL: "postgres://migration", DATABASE_URL: "postgres://app" }, apply, "--plan", output, "--migrations", migrations, "--psql", "missing-psql");
assert.notEqual(result.status, 0);
assert.match(result.stderr, /plan hash mismatch/);

console.log("portable migration CLI tests passed");
