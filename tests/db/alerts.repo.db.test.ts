import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleAlertsRepo } from "@/src/features/alerts/repos/alerts.drizzle";
import { supabaseAlertsRepo, type AlertsRepo } from "@/src/features/alerts/repos/alerts";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";
import { postgrestDouble } from "./postgrest-double";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
let pg: Db;
let db: Database;
beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => { pg = await freshDb(); db = drizzle({ client: pg, schema }) as unknown as Database; }, DB_HOOK_TIMEOUT);
afterEach(() => closeDb(pg));

async function seed(count = 23) {
  await pg.query(`INSERT INTO public.users (id, sede_id, id_type, id_number, password_hash, full_name) VALUES
    ($1, (SELECT id FROM public.sedes LIMIT 1), 'CC', '1', 'x', 'Ana'),
    ($2, (SELECT id FROM public.sedes LIMIT 1), 'CC', '2', 'x', 'Beto')`, [U1, U2]);
  for (let n = 0; n < count; n += 1) {
    await pg.query(`INSERT INTO public.audit_logs (id, user_id, action, entity, entity_id, metadata, created_at, is_read)
      VALUES (gen_random_uuid(), $1, 'cash.shift_open_mismatch', 'cash_shifts', $2, '{}'::jsonb,
        '2026-10-09 14:32:18.123456-05'::timestamptz + ($3 || ' seconds')::interval, false)`, [U1, `shift-${n}`, n]);
  }
}

async function outcome(run: () => Promise<unknown>) {
  try { return { value: await run() }; }
  catch (error) {
    if (!(error instanceof DbQueryError)) throw error;
    return { error: error.error.code };
  }
}

interface Case {
  name: string;
  run(repo: AlertsRepo): Promise<unknown>;
}

const CASES: Case[] = [
  { name: "exact count", run: (repo) => repo.count({ actions: ["cash.shift_open_mismatch"], unreadOnly: true }) },
  { name: "first page", run: (repo) => repo.list({ actions: ["cash.shift_open_mismatch"], unreadOnly: true, offset: 0, limit: 10 }) },
  { name: "second page", run: (repo) => repo.list({ actions: ["cash.shift_open_mismatch"], unreadOnly: true, offset: 10, limit: 10 }) },
  { name: "inclusive bounds with offsets", run: (repo) => repo.list({ actions: ["cash.shift_open_mismatch"], from: "2026-10-09T14:32:20-05:00", to: "2026-10-09T19:32:22.123456+00:00", offset: 0, limit: 10 }) },
  { name: "invalid timestamp keeps SQLSTATE 22007", run: (repo) => repo.count({ actions: ["cash.shift_open_mismatch"], from: "not-a-date" }) },
  { name: "shift reviews", run: (repo) => repo.shiftReviews(["shift-1", "shift-2"], ["cash.shift_open_mismatch"]) },
  { name: "user names", run: (repo) => repo.userNames([U1, U2]) },
  { name: "maybeSingle null", run: (repo) => repo.markRead("00000000-0000-4000-8000-000000000099", { is_read: true, read_at: "2026-10-09T14:00:00.000-05:00", review_note: "x", reviewed_by: U1 }) },
];

describe("alerts repository: equivalence supabase-js ↔ drizzle", () => {
  // Same instance, same seed: the supabase-js adapter goes through a double
  // whose JSON is produced by PostgreSQL itself (to_json, like PostgREST).
  it.each(CASES)("$name", async ({ run }) => {
    await seed();
    const viaPostgrest = await outcome(() => run(supabaseAlertsRepo(postgrestDouble(pg))));
    const viaDrizzle = await outcome(() => run(drizzleAlertsRepo(db)));
    expect(viaDrizzle).toEqual(viaPostgrest);
  });
});

describe("alerts repository: stable order on created_at ties (created_at DESC, id DESC)", () => {
  /**
   * 12 rows share one instant and 3 are newer, so the tie straddles the page
   * boundary (page size 10). Both adapters must return the same rows in the
   * same order, with nothing repeated or missing across the two pages.
   */
  async function seedTies() {
    await seed(15);
    await pg.exec(`
      UPDATE public.audit_logs SET created_at = '2026-10-09 12:00:00.5+00'
       WHERE entity_id NOT IN ('shift-12', 'shift-13', 'shift-14');
      UPDATE public.audit_logs SET created_at = '2026-10-09 13:00:00+00'
       WHERE entity_id IN ('shift-12', 'shift-13', 'shift-14');`);
  }

  async function twoPages(repo: AlertsRepo) {
    const filters = { actions: ["cash.shift_open_mismatch"], unreadOnly: true };
    const first = await repo.list({ ...filters, offset: 0, limit: 10 });
    const second = await repo.list({ ...filters, offset: 10, limit: 10 });
    return { first, second };
  }

  it("supabase-js and drizzle return the same two pages, in the same order", async () => {
    await seedTies();
    const viaPostgrest = await twoPages(supabaseAlertsRepo(postgrestDouble(pg)));
    const viaDrizzle = await twoPages(drizzleAlertsRepo(db));
    expect(viaDrizzle).toEqual(viaPostgrest);

    const ids = [...viaDrizzle.first, ...viaDrizzle.second].map((row) => row.id);
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM public.audit_logs ORDER BY created_at DESC, id DESC`,
    );
    expect(viaDrizzle.first).toHaveLength(10);
    expect(viaDrizzle.second).toHaveLength(5);
    // No repeats, no gaps, and exactly the contract order.
    expect(new Set(ids).size).toBe(15);
    expect(ids).toEqual(rows.map((row) => row.id));
    // The three newer rows lead; the tied rows follow by id descending.
    const tied = ids.slice(3);
    expect(tied).toEqual([...tied].sort().reverse());
  });
});

describe("alerts drizzle repository", () => {
  it.each([
    ["UTC", "2026-10-09T19:32:40.123456+00:00"],
    ["America/Bogota", "2026-10-09T14:32:40.123456-05:00"],
  ])("timestamps in a %s session are the string to_json gives (what PostgREST sends)", async (zone, expected) => {
    await seed();
    await pg.exec(`SET TIME ZONE '${zone}'`);
    const [newest] = await drizzleAlertsRepo(db).list({ actions: ["cash.shift_open_mismatch"], offset: 0, limit: 1 });
    const { rows } = await pg.query<{ json: string }>(
      `SELECT to_json(created_at)#>>'{}' AS json FROM public.audit_logs WHERE id = $1`,
      [newest.id],
    );
    expect(newest.created_at).toBe(expected);
    expect(newest.created_at).toBe(rows[0].json);
    expect(newest.read_at).toBeNull();
  });


  it("resolves the matching voucher row and lets no-match remain idempotent", async () => {
    await seed(0);
    await pg.query(`INSERT INTO public.audit_logs (action, entity, entity_id, metadata, is_read) VALUES ('voucher.requested', 'voucher_requests', 'v1', '{}'::jsonb, false)`);
    const repo = drizzleAlertsRepo(db);
    const patch = { is_read: true as const, read_at: "2026-10-09T14:00:00.000-05:00", review_note: "ok", reviewed_by: U2 };
    const match = { action: "voucher.requested", entity: "voucher_requests", entity_id: "v1", is_read: false as const };
    await repo.resolveVoucher(match, patch); await repo.resolveVoucher(match, patch);
    expect(await repo.list({ actions: ["voucher.requested"], offset: 0, limit: 10 })).toMatchObject([{ is_read: true, review_note: "ok", reviewed_by: U2 }]);
  });
});
