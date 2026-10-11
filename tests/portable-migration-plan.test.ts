import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMigrationPlan, discoverMigrations, type AppliedMigration, type DiscoveredMigration } from "../scripts/plan-portable-migrations";

const migration = (version: number, hash = `${version}`.padStart(64, "0")): DiscoveredMigration => ({
  filename: `${String(version).padStart(3, "0")}_migration.sql`,
  version,
  sha256: hash,
});

const applied = (item: DiscoveredMigration): AppliedMigration => ({
  filename: item.filename,
  sha256: item.sha256,
});

describe("portable migration plan", () => {
  it("rejects a destination state that skips 003", () => {
    const discovered = [migration(2), migration(3), migration(4)];

    expect(() => buildMigrationPlan(discovered, [applied(discovered[0]), applied(discovered[2])])).toThrow(
      "applied migrations must be a contiguous prefix",
    );
  });

  it("rejects duplicate versions and gaps in the discovered order", () => {
    expect(() => buildMigrationPlan([migration(2), migration(2)])).toThrow("duplicate migration version 002");
    expect(() => buildMigrationPlan([migration(2), migration(4)])).toThrow("missing migration version 003");
  });

  it("rejects duplicate migration files on disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "orabella-migrations-"));
    writeFileSync(join(directory, "002_first.sql"), "SELECT 1;");
    writeFileSync(join(directory, "002_second.sql"), "SELECT 2;");

    expect(() => discoverMigrations(directory)).toThrow("duplicate migration version 002");
  });

  it("rejects an applied migration whose hash changed", () => {
    const discovered = [migration(2)];

    expect(() => buildMigrationPlan(discovered, [{ filename: discovered[0].filename, sha256: "f".repeat(64) }])).toThrow(
      "hash mismatch",
    );
  });

  it("rejects a deferred migration when a later migration remains in scope", () => {
    const discovered = [migration(2), migration(3), migration(4)];

    expect(() => buildMigrationPlan(discovered, [], [discovered[1].filename])).toThrow("contiguous suffix");
  });

  it("plans the remaining contiguous suffix", () => {
    const discovered = [migration(2), migration(3), migration(4)];

    const plan = buildMigrationPlan(discovered, [applied(discovered[0])]);

    expect(plan.apply.map((item) => item.filename)).toEqual([discovered[1].filename, discovered[2].filename]);
    expect(plan.deferred).toEqual([]);
    expect(plan.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
