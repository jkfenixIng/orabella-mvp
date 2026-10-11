import { describe, expect, it } from "vitest";
import { MIGRATION_MARKERS } from "../../scripts/portable-migration-markers.mjs";
import { MIGRATION_PATHS, SCHEMA_PATH, buildSchemaDb } from "./harness";

async function marker(db: Awaited<ReturnType<typeof buildSchemaDb>>, filename: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(MIGRATION_MARKERS[filename as keyof typeof MIGRATION_MARKERS].sql);
  return result.rows[0].present;
}

describe("portable migration marker contracts", () => {
  it("are true after 001-007", async () => {
    const db = await buildSchemaDb({ catalog: false });
    try {
      for (const filename of Object.keys(MIGRATION_MARKERS)) expect(await marker(db, filename)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("distinguish 006 and 007 from a 001-005 baseline", async () => {
    const through005 = MIGRATION_PATHS.filter((path) => /[\\/]00[1-5]_[^\\/]+\.sql$/.test(path));
    expect(through005).toHaveLength(5);
    const db = await buildSchemaDb({ catalog: false, migrations: through005 });
    try {
      for (const filename of Object.keys(MIGRATION_MARKERS)) {
        expect(await marker(db, filename)).toBe(!/^00[67]_/.test(filename));
      }
    } finally {
      await db.close();
    }
  });

  it("are false on the 001-only baseline", async () => {
    const db = await buildSchemaDb({ catalog: false, migrations: [SCHEMA_PATH] });
    try {
      for (const filename of Object.keys(MIGRATION_MARKERS)) expect(await marker(db, filename)).toBe(false);
    } finally {
      await db.close();
    }
  });
});
