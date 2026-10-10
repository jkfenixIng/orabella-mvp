/**
 * Service catalog repository (ADM-05) on both engines.
 *
 * - The Drizzle adapter runs against the real schema in PGlite
 *   (`drizzle-orm/pglite` over freshDb()).
 * - One table of equivalence cases runs against BOTH adapters: the supabase-js
 *   adapter over a PostgREST double and the Drizzle adapter over PGlite. Each
 *   case must give the same domain result.
 * - `toDbError` is checked against errors raised by the real PostgreSQL.
 */
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  supabaseServicesRepo,
  type ServiceRow,
  type ServicesRepo,
  type ServiceWrite,
} from "@/src/features/admin/repos/services";
import { drizzleServicesRepo } from "@/src/features/admin/repos/services.drizzle";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import * as schema from "@/src/shared/db/schema";
import { DB_HOOK_TIMEOUT, closeDb, freshDb, warmTemplate, type Db } from "./harness";

const ID_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const ID_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const ID_C = "0c0c0c0c-0000-4000-8000-00000000000c";

let pg: Db;
let db: Database;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  pg = await freshDb();
  db = drizzle({ client: pg, schema }) as unknown as Database;
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(pg);
});

// ------------------------------------------------------- PostgREST double ---

/**
 * What PostgREST answers for the two requests the adapter sends: rows ordered
 * by name (ASCII names, so collation cannot differ), the limit, an upsert that
 * only writes the keys of the payload, and numeric(12,2) as a JSON number.
 * A CHECK violation is answered the way PostgREST forwards it: the SQLSTATE.
 */
function postgrestDouble(seed: ServiceRow[]): SupabaseClient {
  const rows = seed.map((row) => ({ ...row }));
  let generated = 0;
  const from = () => {
    let limit = Infinity;
    let payload: (ServiceWrite & { id?: string }) | null = null;
    const run = () => {
      if (!payload) {
        const data = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
        return { data, error: null };
      }
      if (payload.price < 0 || payload.duracion_min > payload.duracion_max) {
        return { data: null, error: { code: "23514", message: "new row violates check constraint", details: null } };
      }
      const existing = rows.find((row) => row.id === payload!.id);
      if (existing) {
        Object.assign(existing, payload);
        return { data: [{ ...existing }], error: null };
      }
      generated += 1;
      const created: ServiceRow = {
        is_active: true,
        ...payload,
        id: payload.id ?? `generated-${generated}`,
      };
      rows.push(created);
      return { data: [{ ...created }], error: null };
    };
    const query = {
      select: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      upsert: (value: ServiceWrite) => {
        payload = { ...value };
        return query;
      },
      single: () => {
        const result = run();
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
      },
      then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return query;
  };
  return { from } as unknown as SupabaseClient;
}

async function seedPglite(rows: ServiceRow[]): Promise<void> {
  for (const row of rows) {
    await pg.query(
      `INSERT INTO public.services (id, name, description, price, duracion_min, duracion_max, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.name, row.description, row.price, row.duracion_min, row.duracion_max, row.is_active],
    );
  }
}

// ------------------------------------------------------ equivalence cases ---

const SEED: ServiceRow[] = [
  { id: ID_B, name: "Manicure", description: null, price: 18000, duracion_min: 30, duracion_max: 40, is_active: true },
  { id: ID_A, name: "Corte", description: "Clasico", price: 25000.5, duracion_min: 20, duracion_max: 30, is_active: false },
  { id: ID_C, name: "Tinte", description: null, price: 0, duracion_min: 0, duracion_max: 0, is_active: true },
];

/** Generated ids are not comparable across engines: blank them before comparing. */
const withoutGeneratedId = (row: ServiceRow | null) =>
  row && (SEED.some((seed) => seed.id === row.id) ? row : { ...row, id: "<generated>" });

type Outcome = { value: unknown } | { error: { name: string; code: string | null } };

interface EquivalenceCase {
  name: string;
  run: (repo: ServicesRepo) => Promise<unknown>;
  expected: Outcome;
}

const CASES: EquivalenceCase[] = [
  {
    name: "list: ordered by name, money as number",
    run: (repo) => repo.list(50),
    expected: { value: [SEED[1], SEED[0], SEED[2]] },
  },
  {
    name: "list: honors the limit",
    run: (repo) => repo.list(2),
    expected: { value: [SEED[1], SEED[0]] },
  },
  {
    name: "upsert without id inserts and defaults is_active to true",
    run: async (repo) =>
      withoutGeneratedId(
        await repo.upsert({ name: "Pedicure", description: null, price: 32000.75, duracion_min: 40, duracion_max: 60 }),
      ),
    expected: {
      value: { id: "<generated>", name: "Pedicure", description: null, price: 32000.75, duracion_min: 40, duracion_max: 60, is_active: true },
    },
  },
  {
    name: "upsert with id updates and keeps is_active when it is not sent",
    run: (repo) =>
      repo.upsert({ id: ID_A, name: "Corte premium", description: null, price: 30000, duracion_min: 25, duracion_max: 35 }),
    expected: {
      value: { id: ID_A, name: "Corte premium", description: null, price: 30000, duracion_min: 25, duracion_max: 35, is_active: false },
    },
  },
  {
    name: "upsert with id writes is_active when it is sent",
    run: (repo) =>
      repo.upsert({ id: ID_B, name: "Manicure", description: "Gel", price: 18000, duracion_min: 30, duracion_max: 40, is_active: false }),
    expected: {
      value: { id: ID_B, name: "Manicure", description: "Gel", price: 18000, duracion_min: 30, duracion_max: 40, is_active: false },
    },
  },
  {
    name: "upsert then list sees the write",
    run: async (repo) => {
      await repo.upsert({ id: ID_C, name: "Alisado", description: null, price: 90000, duracion_min: 90, duracion_max: 120 });
      return (await repo.list(50)).map((row) => row.name);
    },
    expected: { value: ["Alisado", "Corte", "Manicure"] },
  },
  {
    name: "a CHECK violation surfaces as DbQueryError with SQLSTATE 23514",
    run: (repo) => repo.upsert({ name: "Mal", description: null, price: -1, duracion_min: 0, duracion_max: 0 }),
    expected: { error: { name: "DbQueryError", code: "23514" } },
  },
];

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: await run() };
  } catch (error) {
    if (!(error instanceof DbQueryError)) throw error;
    return { error: { name: error.name, code: error.error.code } };
  }
}

describe("services repository: equivalence supabase-js ↔ drizzle", () => {
  it.each(CASES)("supabase-js: $name", async ({ run, expected }) => {
    expect(await outcome(() => run(supabaseServicesRepo(postgrestDouble(SEED))))).toEqual(expected);
  });

  it.each(CASES)("drizzle/PGlite: $name", async ({ run, expected }) => {
    await seedPglite(SEED);
    expect(await outcome(() => run(drizzleServicesRepo(db)))).toEqual(expected);
  });
});

// -------------------------------------------------------- drizzle details ---

describe("drizzle services repository on the real schema", () => {
  it("returns numeric(12,2) as a JS number rounded by PostgreSQL, never a string", async () => {
    const row = await drizzleServicesRepo(db).upsert({
      name: "Redondeo",
      description: null,
      price: 10.005,
      duracion_min: 1,
      duracion_max: 1,
    });
    expect(row?.price).toBe(10.01);
    expect(typeof row?.price).toBe("number");
    const [listed] = await drizzleServicesRepo(db).list(1);
    expect(typeof listed.price).toBe("number");
  });

  it("generates the uuid and lets the 001 trigger maintain updated_at", async () => {
    const created = await drizzleServicesRepo(db).upsert({ name: "X", description: null, price: 1, duracion_min: 1, duracion_max: 1 });
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    await pg.query(`UPDATE public.services SET updated_at = now() - interval '1 day' WHERE id = $1`, [created!.id]);
    await drizzleServicesRepo(db).upsert({ id: created!.id, name: "Y", description: null, price: 1, duracion_min: 1, duracion_max: 1 });
    const { rows } = await pg.query<{ fresh: boolean }>(
      `SELECT updated_at > now() - interval '1 hour' AS fresh FROM public.services WHERE id = $1`,
      [created!.id],
    );
    expect(rows[0].fresh).toBe(true);
  });

  it("rejects the duration CHECK (23514) and writes nothing", async () => {
    const failure = await drizzleServicesRepo(db)
      .upsert({ name: "Mal", description: null, price: 1, duracion_min: 9, duracion_max: 1 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DbQueryError);
    expect((failure as DbQueryError).error.code).toBe("23514");
    expect(await drizzleServicesRepo(db).list(50)).toEqual([]);
  });
});

// ------------------------------------------------------------- toDbError ---

describe("toDbError on errors raised by PostgreSQL through Drizzle", () => {
  const raised = (statement: ReturnType<typeof sql>) =>
    db.execute(statement).then(
      () => {
        throw new Error("expected a database error");
      },
      (error: unknown) => toDbError(error),
    );

  it("P0001 from RAISE EXCEPTION (an RPC)", async () => {
    const error = await raised(
      sql`SELECT public.replace_user_roles(${ID_A}::uuid, ARRAY['admin']::text[])`,
    );
    expect(error.code).toBe("P0001");
    expect(error.message).toContain("USER_NOT_FOUND");
  });

  it("23505 unique violation, with the detail", async () => {
    await seedPglite([SEED[0]]);
    const error = await raised(
      sql`INSERT INTO public.services (id, name, price, duracion_min, duracion_max) VALUES (${ID_B}::uuid, 'Dup', 1, 1, 1)`,
    );
    expect(error.code).toBe("23505");
    expect(error.details).toContain(ID_B);
  });

  it("23514 check violation", async () => {
    const error = await raised(
      sql`INSERT INTO public.services (name, price, duracion_min, duracion_max) VALUES ('Mal', -1, 1, 1)`,
    );
    expect(error.code).toBe("23514");
  });

  it("23P01 exclusion violation", async () => {
    await pg.exec(`CREATE TEMP TABLE slots (r int4range, EXCLUDE USING gist (r WITH &&));
                   INSERT INTO slots VALUES ('[1,5)');`);
    const error = await raised(sql`INSERT INTO slots VALUES ('[3,8)')`);
    expect(error.code).toBe("23P01");
  });

  it("keeps a non-database error readable without inventing a code", () => {
    expect(toDbError(new Error("boom"))).toEqual({ code: null, message: "boom", details: null });
    // supabase-js shape: PostgREST's own code and `details` pass through.
    expect(toDbError({ code: "PGRST116", message: "x", details: "0 rows" })).toEqual({
      code: "PGRST116",
      message: "x",
      details: "0 rows",
    });
  });
});
