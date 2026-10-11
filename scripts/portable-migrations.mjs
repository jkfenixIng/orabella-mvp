import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationFile = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;
const sha256 = /^[a-f0-9]{64}$/;

export function fail(message) {
  throw new Error(`portable migrations: ${message}`);
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function version(filename) {
  const match = migrationFile.exec(filename);
  if (!match) fail(`invalid migration filename ${filename}`);
  return Number(match[1]);
}

function validateDiscovered(input) {
  const migrations = input.map((migration) => ({ ...migration, version: version(migration.filename) }));
  migrations.sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
  if (migrations.length === 0) fail("no migrations at or after 002 were discovered");
  if (migrations[0].version !== 2) fail(`first portable migration must be 002, found ${String(migrations[0].version).padStart(3, "0")}`);
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!sha256.test(migration.sha256)) fail(`invalid SHA256 for ${migration.filename}`);
    if (index > 0) {
      const previous = migrations[index - 1];
      if (migration.version === previous.version) fail(`duplicate migration version ${String(migration.version).padStart(3, "0")}`);
      if (migration.version !== previous.version + 1) fail(`missing migration version ${String(previous.version + 1).padStart(3, "0")}`);
    }
  }
  return migrations;
}

function validateApplied(discovered, applied) {
  if (applied.length > discovered.length) fail("applied migrations exceed discovered migrations");
  for (let index = 0; index < applied.length; index += 1) {
    const expected = discovered[index];
    const actual = applied[index];
    if (actual.filename !== expected.filename) fail("applied migrations must be a contiguous prefix of discovered migrations");
    if (actual.sha256 !== expected.sha256) fail(`hash mismatch for ${actual.filename}`);
  }
}

function deferredSuffix(discovered, appliedLength, deferredNames) {
  const deferred = deferredNames.map((name) => {
    const migration = discovered.find((candidate) => candidate.filename === name);
    if (!migration) fail(`deferred migration is not discovered: ${name}`);
    return migration;
  });
  if (new Set(deferred.map((migration) => migration.filename)).size !== deferred.length) fail("duplicate deferred migration");
  const suffix = discovered.slice(discovered.length - deferred.length);
  if (suffix.some((migration, index) => migration.filename !== deferred[index].filename)) {
    fail("deferred migrations must be a contiguous suffix; a later migration cannot bypass a deferred dependency");
  }
  if (deferred.some((migration) => discovered.indexOf(migration) < appliedLength)) fail("an applied migration cannot be deferred");
  return deferred;
}

export function discoverMigrations(directory) {
  return validateDiscovered(
    readdirSync(directory)
      .filter((filename) => /^\d/.test(filename))
      .map((filename) => ({ filename, version: version(filename), sha256: hash(readFileSync(join(directory, filename)))}))
      .filter((migration) => migration.version >= 2),
  );
}

export function buildMigrationPlan(discoveredInput, applied = [], deferredNames = []) {
  const discovered = validateDiscovered(discoveredInput);
  validateApplied(discovered, applied);
  const deferred = deferredSuffix(discovered, applied.length, deferredNames);
  const apply = discovered.slice(applied.length, discovered.length - deferred.length);
  const expectedApplied = discovered.slice(0, discovered.length - deferred.length).map(({ filename, sha256: digest }) => ({ filename, sha256: digest }));
  const manifestSha256 = hash(JSON.stringify(discovered.map(({ filename, sha256: digest }) => ({ filename, sha256: digest }))));
  return { format: 1, manifestSha256, discovered, applied, apply, deferred, expectedApplied };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
