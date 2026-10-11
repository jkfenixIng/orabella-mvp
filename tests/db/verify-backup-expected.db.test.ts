/**
 * `scripts/verify-backup-restore.ts` restores a production backup with 001+002,
 * then applies every later migration, and tolerates ONLY the catalog objects it
 * declares in `EXPECTED_LATER.onlyInRepo`. That declared set must be exactly
 * what later migrations add over 001+002: a missing entry makes a real restore fail,
 * an extra entry would hide drift. The script runs on import, so its set is
 * read from its source text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, MIGRATION_PATHS, PORTABLE_PATH, REPO_ROOT, SCHEMA_PATH, buildSchemaDb, type Db } from "./harness";

const SCRIPT = readFileSync(join(REPO_ROOT, "scripts", "verify-backup-restore.ts"), "utf8");

function declared(): Set<string> {
  const block = /onlyInRepo: new Set\(\[([\s\S]*?)\]\)/.exec(SCRIPT)?.[1] ?? "";
  return new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

const INVENTORY = `
  SELECT 'function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'trigger|' || c.relname || '.' || t.tgname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'constraint|' || c.relname || '.' || k.conname || '|' || k.contype::text
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND k.contype <> 'n'
  UNION ALL
  SELECT 'index|' || tablename || '.' || indexname FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy|' || tablename || '.' || policyname FROM pg_policies WHERE schemaname = 'public'`;

async function inventory(db: Db): Promise<Set<string>> {
  return new Set((await db.query<{ line: string }>(INVENTORY)).rows.map((row) => row.line));
}

describe("verify-backup-restore: declared repo-only objects", () => {
  it("equals exactly what the migrations after 001+002 add", async () => {
    expect(MIGRATION_PATHS.map((path) => path.split(/[\\/]/).pop())).toContain("004_inventory_literal_search.sql");
    const legacy = await buildSchemaDb({ catalog: false, migrations: [SCHEMA_PATH, PORTABLE_PATH] });
    const current = await buildSchemaDb({ catalog: false });
    try {
      const before = await inventory(legacy);
      const added = [...(await inventory(current))].filter((line) => !before.has(line)).sort();
      expect(added).toContain("function|search_products_literal(p_query text, p_limit integer, p_offset integer)");
      expect([...declared()].sort()).toEqual(added);
    } finally {
      await legacy.close();
      await current.close();
    }
  }, DB_HOOK_TIMEOUT);
});
