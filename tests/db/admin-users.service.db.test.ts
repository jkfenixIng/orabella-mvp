/**
 * Admin user management through the SERVICE on both engines, over the real
 * schema: listSedeUsers, upsertEmployee (create and edit), currentRoleCodes
 * (via setUserRoles) and setUserRoles. The postgres engine must never build a
 * Supabase client; the supabase engine must (through the PostgREST double).
 */
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, setCopTriggers, warmTemplate, type Db } from "./harness";

const engine = vi.hoisted(() => ({ pg: null as unknown as Db, supabaseCalls: 0 }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/src/shared/lib/supabase/server", async () => {
  const { postgrestDouble } = await import("./postgrest-double");
  return {
    createAdminClient: () => {
      engine.supabaseCalls += 1;
      if (process.env.DB_ENGINE === "postgres") throw new Error("Supabase used on the postgres engine");
      return postgrestDouble(engine.pg);
    },
  };
});
vi.mock("@/src/shared/db/client", async () => {
  const schema = await import("@/src/shared/db/schema");
  return { getDb: () => drizzle({ client: engine.pg, schema }) };
});

let sede: string;
let otherSede: string;
let ana: string;
let root: string;

const addUser = async (document: string, name: string, sedeId: string | null) =>
  (await one<{ id: string }>(
    engine.pg,
    `INSERT INTO public.users (sede_id, id_type, id_number, password_hash, full_name) VALUES ($1, 'CC', $2, 'hash', $3) RETURNING id`,
    [sedeId, document, name],
  )).id;
const roleCodes = async (userId: string) =>
  (await engine.pg.query<{ code: string }>(
    `SELECT r.code FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  )).rows.map((row) => row.code);

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  engine.pg = await freshDb();
  await setCopTriggers(engine.pg, false);
  engine.supabaseCalls = 0;
  sede = (await one<{ id: string }>(engine.pg, `SELECT id FROM public.sedes ORDER BY name LIMIT 1`)).id;
  otherSede = (await one<{ id: string }>(engine.pg, `INSERT INTO public.sedes (name) VALUES ('Otra') RETURNING id`)).id;
  ana = await addUser("100", "Ana", sede);
  root = await addUser("101", "Root", null);
  await addUser("102", "Zoe", otherSede);
  await engine.pg.query(`SELECT public.replace_user_roles($1::uuid, ARRAY['empleado']::text[])`, [ana]);
  await engine.pg.query(`SELECT public.provision_installation_owner($1::uuid)`, [root]);
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb(engine.pg);
});

describe("listSedeUsers sede filter (intentional change)", () => {
  it("finding: the previous unquoted value was PostgREST syntax; the quoted one is one eq item", async () => {
    const { parseOrTree } = await import("./postgrest-double");
    const { quotePostgrestLiteral } = await import("@/src/features/admin/repos/users");
    const needle = 'x",sede_id.not.is.null,id.eq."';
    // Before: `sede_id.eq.${sedeId},sede_id.is.null` — the comma ended the value.
    expect(() => parseOrTree(`sede_id.eq.x,sede_id.not.is.null,sede_id.is.null`)).toThrow(/unsupported or\(\) item/);
    expect(parseOrTree(`sede_id.eq.x,id.is.null,sede_id.is.null`)).toHaveLength(3);
    expect(parseOrTree(`sede_id.eq.${quotePostgrestLiteral(needle)},sede_id.is.null`)).toEqual([
      { column: "sede_id", op: "eq", value: needle },
      { column: "sede_id", op: "is", value: "null" },
    ]);
  });
});

describe.each(["supabase", "postgres"] as const)("admin user service on %s", (name) => {
  beforeEach(() => {
    vi.stubEnv("DB_ENGINE", name === "postgres" ? "postgres" : "");
    vi.stubEnv("DATABASE_URL", name === "postgres" ? "postgres://unused.invalid/db" : "");
  });
  afterEach(() => {
    if (name === "postgres") expect(engine.supabaseCalls).toBe(0);
    else expect(engine.supabaseCalls).toBeGreaterThan(0);
  });
  const service = () => import("@/src/features/admin/service");

  it("listSedeUsers: the sede plus the users without one, roles as codes, ordered by full_name, id", async () => {
    const homonym = await addUser("103", "Ana", null);
    const users = await (await service()).listSedeUsers(sede);
    const expected = [
      { id: ana, sede_id: sede, full_name: "Ana", id_number: "100", roles: ["empleado"] },
      { id: homonym, sede_id: null, full_name: "Ana", id_number: "103", roles: [] },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(users).toEqual([...expected, { id: root, sede_id: null, full_name: "Root", id_number: "101", roles: ["superadmin"] }]);
  });

  it.each([
    'x",sede_id.not.is.null,id.eq."',
    "x,sede_id.not.is.null",
    "x),or(sede_id.not.is.null",
    `${"00000000-0000-4000-8000-000000000099"}") OR true --`,
  ])("listSedeUsers treats the adversarial sede %j as data: never another sede's users", async (needle) => {
    const outcome = await (await service()).listSedeUsers(needle).then(
      (rows) => ({ ids: rows.map((row) => row.id) }),
      (error: { code?: string }) => ({ error: error.code }),
    );
    // A non-uuid literal is a typed-value error (22P02 → INTERNAL), never syntax that widens the filter.
    expect(outcome).toEqual({ error: "INTERNAL" });
    expect(await count(engine.pg, `SELECT 1 FROM public.users`)).toBe(3);
  });

  it("upsertEmployee creates account, role and legajo through the RPC, then edits the legajo", async () => {
    const { upsertEmployee } = await service();
    const created = await upsertEmployee({ full_name: "Bea", document: "200", employee_code: "E-1", pay_type: "mixto", salary_fixed: 1234.5, commission_percent: 7.25 }, sede);
    expect(created).toMatchObject({ full_name: "Bea", document: "200", employee_code: "E-1", salary_fixed: 1235, commission_percent: 7.25, payout_mode: "nomina", is_active: true, pay_frequency: null });
    const account = await one<{ id: string; sede_id: string; password_hash: string }>(engine.pg, `SELECT id, sede_id, password_hash FROM public.users WHERE id_number = '200'`);
    expect(created.user_id).toBe(account.id);
    expect(account.sede_id).toBe(sede);
    expect(account.password_hash).toMatch(/^scrypt\$v1\$/);
    expect(await roleCodes(account.id)).toEqual(["empleado"]);

    const edited = await upsertEmployee({ id: created.id, full_name: "Bea Dos", document: "200", employee_code: "E-1", pay_type: "fijo", salary_fixed: 1500, pay_frequency: "quincenal" }, sede);
    expect(edited).toEqual({ ...created, full_name: "Bea Dos", pay_type: "fijo", salary_fixed: 1500, commission_percent: null, pay_frequency: "quincenal" });
    expect(await roleCodes(account.id)).toEqual(["empleado"]);
  });

  it("an RPC failure on creation is INTERNAL and never carries the password hash", async () => {
    await engine.pg.query(`UPDATE public.users SET email = 'taken@test.local' WHERE id = $1`, [ana]);
    const error = await (await service())
      .upsertEmployee({ full_name: "Eva", document: "400", email: "taken@test.local", pay_type: "fijo", salary_fixed: 1000 }, sede)
      .then(() => null, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: "INTERNAL", status: 500, message: "Error interno." });
    expect(JSON.stringify(error)).not.toMatch(/scrypt|password/i);
    expect(await count(engine.pg, `SELECT 1 FROM public.users WHERE id_number = '400'`)).toBe(0);
  });

  it("upsertEmployee links an existing account and keeps its role; rejects duplicates before the RPC", async () => {
    const { upsertEmployee } = await service();
    const linked = await upsertEmployee({ full_name: "Ana", document: "100", employee_code: "E-2", pay_type: "fijo", salary_fixed: 1000 }, sede);
    expect(linked.user_id).toBe(ana);
    expect(await roleCodes(ana)).toEqual(["empleado"]);
    await expect(upsertEmployee({ full_name: "Ana", document: "100", pay_type: "fijo", salary_fixed: 1000 }, sede)).rejects.toMatchObject({ code: "USER_ALREADY_LINKED", status: 409 });
    await expect(upsertEmployee({ full_name: "Otro", document: "300", employee_code: " E-2 ", pay_type: "fijo", salary_fixed: 1000 }, sede)).rejects.toMatchObject({ code: "EMPLOYEE_CODE_TAKEN", status: 409 });
    expect(await count(engine.pg, `SELECT 1 FROM public.employees`)).toBe(1);
  });

  it("setUserRoles replaces an assignable role atomically", async () => {
    await expect((await service()).setUserRoles({ user_id: ana, roles: ["caja"] })).resolves.toEqual({ user_id: ana, roles: ["caja"] });
    expect(await roleCodes(ana)).toEqual(["caja"]);
  });

  it("setUserRoles refuses superadmin in both directions and zero roles, before the RPC", async () => {
    const { setUserRoles } = await service();
    const forbidden = { code: "FORBIDDEN", status: 403, message: "El rol superadmin no se puede asignar ni quitar desde la aplicación." };
    await expect(setUserRoles({ user_id: ana, roles: ["superadmin"] })).rejects.toMatchObject(forbidden);
    await expect(setUserRoles({ user_id: root, roles: ["admin"] })).rejects.toMatchObject(forbidden);
    await expect(setUserRoles({ user_id: ana, roles: [] })).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    expect([await roleCodes(ana), await roleCodes(root)]).toEqual([["empleado"], ["superadmin"]]);
  });

  it("setUserRoles maps the RPC rejections: unknown user is NOT_FOUND and writes nothing", async () => {
    await expect((await service()).setUserRoles({ user_id: "00000000-0000-4000-8000-000000000099", roles: ["admin"] })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
