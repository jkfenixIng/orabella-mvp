import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildMigrationPlan, discoverMigrations, fail, hash, readJson, same } from "./portable-migrations.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function usage() {
  console.error("usage: MIGRATION_DATABASE_URL=<migration-operator-url> node scripts/apply-portable-migration-plan.mjs --plan <plan.json> [--migrations <dir>] [--psql <path>]");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

function requireMigrationUrl() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail("MIGRATION_DATABASE_URL is required");
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) fail("MIGRATION_DATABASE_URL must not equal the application DATABASE_URL");
  return url;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPsql(psql, url, scriptPath) {
  const result = spawnSync(psql, [url, "-X", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], {
    encoding: "utf8",
    shell: process.platform === "win32" && psql.endsWith(".cmd"),
  });
  if (result.status === 0) return;
  throw new Error(`portable migration apply: psql failed\n${result.stdout}\n${result.stderr}`);
}

if (process.argv.includes("--help")) usage();
const planPath = value("--plan");
if (!planPath) usage();
const plan = readJson(resolve(planPath));
const migrationsDir = resolve(value("--migrations") ?? "supabase/migrations");
const psql = value("--psql") ?? "psql";
const url = requireMigrationUrl();
const currentMigrations = discoverMigrations(migrationsDir);
if (!Array.isArray(plan.applied) || !Array.isArray(plan.deferred)) fail("invalid plan JSON");
const expectedPlan = buildMigrationPlan(currentMigrations, plan.applied, plan.deferred.map((migration) => migration.filename));
if (!same(plan, expectedPlan)) fail("plan hash mismatch: plan does not match current deterministic migration plan");
const discovered = new Map(currentMigrations.map((migration) => [migration.filename, migration]));
const temporary = mkdtempSync(join(tmpdir(), "orabella-portable-apply-"));

try {
  for (const migration of plan.apply ?? []) {
    const current = discovered.get(migration.filename);
    if (!current || current.sha256 !== migration.sha256) fail(`plan hash mismatch for ${migration.filename}`);
    const source = readFileSync(join(migrationsDir, migration.filename));
    if (hash(source) !== migration.sha256) fail(`file changed before apply: ${migration.filename}`);

    // Migration files own BEGIN/COMMIT. The appended INSERT runs only when the
    // file succeeds in the same psql session; it cannot be one transaction with
    // a file that commits itself. A crash after that commit but before INSERT is
    // deliberately surfaced as an incomplete ledger, never repaired automatically.
    const scriptPath = join(temporary, `${basename(migration.filename)}.apply.sql`);
    writeFileSync(
      scriptPath,
      `${source.toString()}\nSET ROLE migration_operator;\nINSERT INTO public.portable_migration_audit (filename, sha256) VALUES (${sqlLiteral(migration.filename)}, ${sqlLiteral(migration.sha256)});\n`,
    );
    runPsql(psql, url, scriptPath);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
