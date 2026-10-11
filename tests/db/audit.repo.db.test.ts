import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleAuditRepo } from "@/src/shared/lib/repos/audit.drizzle";
import { supabaseAuditRepo } from "@/src/shared/lib/repos/audit";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { postgrestDouble } from "./postgrest-double";

let left: Db;
let right: Db;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => [left, right] = await Promise.all([freshDb(), freshDb()]), DB_HOOK_TIMEOUT);
afterEach(async () => { await closeDb(left); await closeDb(right); });

const entry = { user_id: null, action: "auth.login_failed", entity: "users", entity_id: "900", metadata: { reason: "unknown_or_inactive" } };

async function rows(db: Db) {
  return (await db.query(`SELECT user_id, action, entity, entity_id, metadata FROM public.audit_logs ORDER BY id`)).rows;
}

describe("audit repository: Supabase ↔ PostgreSQL direct", () => {
  it("writes the exact shared payload and database defaults in either engine", async () => {
    await supabaseAuditRepo(postgrestDouble(left)).insert(entry);
    await drizzleAuditRepo(drizzle({ client: right, schema }) as unknown as Database).insert(entry);
    expect(await rows(right)).toEqual(await rows(left));
    expect(await rows(right)).toEqual([{ ...entry, metadata: entry.metadata }]);
  });

  it("direct errors preserve SQLSTATE but never include a bound metadata secret", async () => {
    const secret = "token_hash_that_must_not_escape";
    const repo = drizzleAuditRepo(drizzle({ client: right, schema }) as unknown as Database);
    const error = await repo.insert({ ...entry, user_id: "not-a-uuid", metadata: { secret } }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(DbQueryError);
    expect((error as DbQueryError).error).toMatchObject({ code: "22P02", details: null });
    expect((error as DbQueryError).message).not.toContain(secret);
    expect((error as DbQueryError).error.message).not.toContain(secret);
  });
});
