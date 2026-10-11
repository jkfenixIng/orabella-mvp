import { describe, expect, it } from "vitest";
import { MIGRATION_MARKERS } from "../../scripts/portable-migration-markers.mjs";
import { SCHEMA_PATH, buildSchemaDb } from "./harness";

async function marker(db: Awaited<ReturnType<typeof buildSchemaDb>>, filename: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(MIGRATION_MARKERS[filename as keyof typeof MIGRATION_MARKERS].sql);
  return result.rows[0].present;
}

describe("portable migration marker contracts", () => {
  it("are true after 001-005", async () => {
    const db = await buildSchemaDb({ catalog: false });
    try {
      for (const filename of Object.keys(MIGRATION_MARKERS)) expect(await marker(db, filename)).toBe(true);
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
