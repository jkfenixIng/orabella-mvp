import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface DiscoveredMigration {
  filename: string;
  version: number;
  sha256: string;
}

export interface AppliedMigration {
  filename: string;
  sha256: string;
}

export interface MigrationState {
  applied: AppliedMigration[];
  deferred?: string[];
}

export interface MigrationPlan {
  format: 1;
  manifestSha256: string;
  discovered: DiscoveredMigration[];
  applied: AppliedMigration[];
  apply: DiscoveredMigration[];
  deferred: DiscoveredMigration[];
  expectedApplied: AppliedMigration[];
}

const MIGRATION_FILE = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new Error(`portable migration plan: ${message}`);
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertFilename(filename: string): number {
  const match = MIGRATION_FILE.exec(filename);
  if (!match) fail(`invalid migration filename ${filename}`);
  return Number(match[1]);
}

function assertUniqueVersions(migrations: readonly DiscoveredMigration[]): void {
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) fail(`duplicate migration version ${String(migration.version).padStart(3, "0")}`);
    versions.add(migration.version);
  }
}

function assertConsecutive(migrations: readonly DiscoveredMigration[]): void {
  if (migrations.length === 0) fail("no migrations at or after 002 were discovered");
  if (migrations[0].version !== 2) fail(`first portable migration must be 002, found ${String(migrations[0].version).padStart(3, "0")}`);
  for (let index = 1; index < migrations.length; index += 1) {
    const expected = migrations[index - 1].version + 1;
    if (migrations[index].version !== expected) fail(`missing migration version ${String(expected).padStart(3, "0")}`);
  }
}

function assertDiscovered(migrations: readonly DiscoveredMigration[]): DiscoveredMigration[] {
  const sorted = [...migrations].map((migration) => ({ ...migration, version: assertFilename(migration.filename) }));
  sorted.sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
  assertUniqueVersions(sorted);
  assertConsecutive(sorted);
  for (const migration of sorted) {
    if (!SHA256.test(migration.sha256)) fail(`invalid SHA256 for ${migration.filename}`);
  }
  return sorted;
}

function assertAppliedPrefix(discovered: readonly DiscoveredMigration[], applied: readonly AppliedMigration[]): void {
  const names = new Set<string>();
  for (const item of applied) {
    if (!names.add(item.filename)) fail(`duplicate applied migration ${item.filename}`);
  }
  if (applied.length > discovered.length) fail("applied migrations exceed discovered migrations");
  for (let index = 0; index < applied.length; index += 1) {
    const expected = discovered[index];
    const actual = applied[index];
    if (actual.filename !== expected.filename) fail("applied migrations must be a contiguous prefix of discovered migrations");
    if (actual.sha256 !== expected.sha256) fail(`hash mismatch for ${actual.filename}`);
  }
}

function resolveDeferred(discovered: readonly DiscoveredMigration[], appliedCount: number, names: readonly string[]): DiscoveredMigration[] {
  const deferred = names.map((name) => {
    const migration = discovered.find((candidate) => candidate.filename === name);
    if (!migration) fail(`deferred migration is not discovered: ${name}`);
    return migration;
  });
  const unique = new Set(deferred.map((migration) => migration.filename));
  if (unique.size !== deferred.length) fail("duplicate deferred migration");
  const expected = discovered.slice(discovered.length - deferred.length);
  if (deferred.length > 0 && expected.some((migration, index) => migration.filename !== deferred[index].filename)) {
    fail("deferred migrations must be a contiguous suffix; a later migration cannot bypass a deferred dependency");
  }
  if (deferred.some((migration) => discovered.indexOf(migration) < appliedCount)) fail("an applied migration cannot be deferred");
  return deferred;
}

export function buildMigrationPlan(discoveredInput: readonly DiscoveredMigration[], applied: readonly AppliedMigration[] = [], deferred: readonly string[] = []): MigrationPlan {
  const discovered = assertDiscovered(discoveredInput);
  assertAppliedPrefix(discovered, applied);
  const deferredMigrations = resolveDeferred(discovered, applied.length, deferred);
  const apply = discovered.slice(applied.length, discovered.length - deferredMigrations.length);
  const manifestSha256 = hash(JSON.stringify(discovered.map(({ filename, sha256 }) => ({ filename, sha256 }))));
  const expectedApplied = discovered.slice(0, discovered.length - deferredMigrations.length).map(({ filename, sha256 }) => ({ filename, sha256 }));
  return { format: 1, manifestSha256, discovered, applied: [...applied], apply, deferred: deferredMigrations, expectedApplied };
}

export function discoverMigrations(directory: string): DiscoveredMigration[] {
  const files = readdirSync(directory).filter((filename) => /^\d/.test(filename));
  return assertDiscovered(
    files
      .map((filename) => ({ filename, version: assertFilename(filename), sha256: hash(readFileSync(join(directory, filename)))}))
      .filter((migration) => migration.version >= 2),
  );
}

function readState(path: string): MigrationState {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MigrationState).applied)) fail(`invalid applied-state file ${path}`);
  const state = parsed as MigrationState;
  if (state.deferred !== undefined && !Array.isArray(state.deferred)) fail(`invalid deferred list in ${path}`);
  return state;
}

function usage(): never {
  console.error("usage: node scripts/plan-portable-migrations.ts --state <applied-state.json> --output <plan.json> [--migrations <dir>]");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  if (process.argv.includes("--help")) usage();
  const statePath = argument("--state");
  const output = argument("--output");
  const migrations = argument("--migrations") ?? "supabase/migrations";
  if (!statePath || !output) usage();
  const state = readState(resolve(statePath));
  const plan = buildMigrationPlan(discoverMigrations(resolve(migrations)), state.applied, state.deferred ?? []);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`manifest ${plan.manifestSha256}`);
  console.log(`apply ${plan.apply.map((migration) => migration.filename).join(" ") || "(none)"}`);
  console.log(`deferred ${plan.deferred.map((migration) => migration.filename).join(" ") || "(none)"}`);
}

if (basename(process.argv[1] ?? "") === "plan-portable-migrations.ts") main();
