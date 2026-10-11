import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_HOOK_TIMEOUT, closeDb, count, freshDb, one, pgError, rpc, warmTemplate, type Db } from "./harness";
import { insertUser } from "./fixtures";
import { isResetTokenUsable } from "@/src/features/auth/service";

let db: Db;
let user: string;

beforeAll(warmTemplate, DB_HOOK_TIMEOUT);
beforeEach(async () => {
  db = await freshDb();
  user = await insertUser(db, { passwordHash: "hash-v1" });
}, DB_HOOK_TIMEOUT);
afterEach(async () => {
  await closeDb(db);
});

const roles = async (id: string): Promise<string[]> =>
  (
    await db.query<{ code: string }>(
      `SELECT r.code FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
      [id],
    )
  ).rows.map((row) => row.code);
const addSession = (token: string) =>
  db.query(`INSERT INTO public.sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user, token]);
const liveSessions = () => count(db, `SELECT 1 FROM public.sessions WHERE user_id = $1 AND NOT revoked`, [user]);
const passwordHash = async (): Promise<string> =>
  (await one<{ password_hash: string }>(db, `SELECT password_hash FROM public.users WHERE id = $1`, [user])).password_hash;

describe("replace_user_roles", () => {
  const replace = (codes: string[], target = user) =>
    rpc<string[]>(db, "replace_user_roles", [target, codes], ["uuid", "text[]"]);

  it("replaces the set atomically and returns the applied codes sorted and deduplicated", async () => {
    expect(await replace(["empleado"])).toEqual(["empleado"]);
    expect(await replace(["caja", "admin", "caja"])).toEqual(["admin", "caja"]);
    expect(await roles(user)).toEqual(["admin", "caja"]);
  });

  it("never leaves zero roles: empty or unknown codes abort and keep the old set", async () => {
    await replace(["empleado"]);
    expect((await pgError(replace([]))).message).toBe("ROLE_NOT_FOUND");
    // 'gerente' is not even a valid code for the roles CHECK: still ROLE_NOT_FOUND, no partial apply.
    expect((await pgError(replace(["admin", "gerente"]))).message).toBe("ROLE_NOT_FOUND");
    expect(await roles(user)).toEqual(["empleado"]);
  });

  it("rejects an unknown user", async () => {
    expect((await pgError(replace(["admin"], "00000000-0000-4000-8000-000000000000"))).message).toBe("USER_NOT_FOUND");
  });
});

describe("confirm_password_reset", () => {
  const addReset = (token: string, expiresIn: string, used = false) =>
    db.query(
      `INSERT INTO public.password_resets (user_id, token_hash, expires_at, used) VALUES ($1, $2, now() + $3::interval, $4)`,
      [user, token, expiresIn, used],
    );
  const confirm = (token: string, now = new Date()) =>
    rpc<boolean>(db, "confirm_password_reset", [token, "hash-v2", now.toISOString()], ["text", "text", "timestamptz"]);

  it.each([
    ["missing", null, false, false],
    ["used", "1 hour", true, false],
    ["expires exactly now", "1 second", false, false],
    ["active", "1 hour", false, true],
  ] as const)("has the same usable decision as SQL: %s", async (_label, expiresIn, used, usable) => {
    const token = `equivalence-${_label}`;
    const now = new Date();
    if (expiresIn !== null) await addReset(token, expiresIn, used);
    const row = expiresIn === null
      ? null
      : await one<{ used: boolean; expires_at: string }>(db, `SELECT used, expires_at FROM public.password_resets WHERE token_hash = $1`, [token]);
    const evaluationNow = _label === "expires exactly now" && row ? new Date(row.expires_at) : now;
    const app = row !== null && isResetTokenUsable({ used: row.used, expiresAt: new Date(row.expires_at), now: evaluationNow });
    expect(app).toBe(usable);
    const result = usable ? await confirm(token, evaluationNow) : (await pgError(confirm(token, evaluationNow))).message;
    expect(result).toBe(usable ? true : "RESET_TOKEN_INVALID");
  });

  it("consumes the token, writes the password and revokes every session", async () => {
    await addReset("tok-ok", "1 hour");
    await addSession("s1");
    await addSession("s2");
    expect(await confirm("tok-ok")).toBe(true);
    expect(await passwordHash()).toBe("hash-v2");
    expect(await liveSessions()).toBe(0);
    // Single use.
    expect((await pgError(confirm("tok-ok"))).message).toBe("RESET_TOKEN_INVALID");
  });

  it("rejects used, expired and unknown tokens without changing the password", async () => {
    await addReset("tok-used", "1 hour", true);
    await addReset("tok-late", "1 minute");
    expect((await pgError(confirm("tok-used"))).message).toBe("RESET_TOKEN_INVALID");
    expect((await pgError(confirm("tok-late", new Date(Date.now() + 3_600_000)))).message).toBe("RESET_TOKEN_INVALID");
    expect((await pgError(confirm("tok-none"))).message).toBe("RESET_TOKEN_INVALID");
    expect(await passwordHash()).toBe("hash-v1");
    const late = await one<{ used: boolean }>(db, `SELECT used FROM public.password_resets WHERE token_hash = 'tok-late'`);
    expect(late.used).toBe(false);
  });
});

describe("change_user_password", () => {
  const change = (expected: string | null, current: string | null = "s-current") =>
    rpc<number>(db, "change_user_password", [user, "hash-v2", current, expected], ["uuid", "text", "text", "text"]);

  it("compare-and-swaps on the expected hash and revokes the other sessions", async () => {
    await addSession("s-current");
    await addSession("s-other");
    expect(await change("hash-v1")).toBe(1);
    expect(await passwordHash()).toBe("hash-v2");
    const sessions = await db.query<{ token_hash: string; revoked: boolean }>(
      `SELECT token_hash, revoked FROM public.sessions WHERE user_id = $1 ORDER BY token_hash`,
      [user],
    );
    // Revoked in place (UPDATE ... SET revoked = true), not deleted.
    expect(sessions.rows).toEqual([
      { token_hash: "s-current", revoked: false },
      { token_hash: "s-other", revoked: true },
    ]);
  });

  it("rejects a stale expected hash with PASSWORD_CHANGED_ELSEWHERE and writes nothing", async () => {
    await addSession("s-other");
    expect((await pgError(change("hash-stale"))).message).toBe("PASSWORD_CHANGED_ELSEWHERE");
    expect(await passwordHash()).toBe("hash-v1");
    expect(await liveSessions()).toBe(1);
  });

  it("requires the precondition (missing expected hash is PASSWORD_INVALID, never 'do not compare')", async () => {
    expect((await pgError(change(null))).message).toBe("PASSWORD_INVALID");
    expect((await pgError(change("  "))).message).toBe("PASSWORD_INVALID");
  });
});

describe("create_user_with_role", () => {
  /** `createUser` (auth/service.ts): the password travels already hashed. */
  const create = (overrides: Record<string, unknown>, codes: string[]) =>
    rpc<string>(
      db,
      "create_user_with_role",
      [
        JSON.stringify({
          sede_id: null,
          email: "nueva@test.local",
          phone: null,
          id_type: "CC",
          id_number: "900",
          password_hash: "hash-doc",
          full_name: "Nueva Persona",
          ...overrides,
        }),
        codes,
      ],
      ["jsonb", "text[]"],
    );

  it("creates the user with must_change_password and its roles in one transaction", async () => {
    const id = await create({}, ["caja", "empleado"]);
    expect(await roles(id)).toEqual(["caja", "empleado"]);
    const row = await one<{ must_change_password: boolean; email: string | null }>(
      db,
      `SELECT must_change_password, email FROM public.users WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ must_change_password: true, email: "nueva@test.local" });
    // An empty email is stored as NULL, so two document-only users can coexist.
    await create({ id_number: "901", email: "  " }, ["empleado"]);
    await create({ id_number: "902", email: "" }, ["empleado"]);
    expect(await count(db, `SELECT 1 FROM public.users WHERE email IS NULL`)).toBe(2);
  });

  it("writes nothing on an unknown role, no role, a duplicate or a malformed payload", async () => {
    const before = await count(db, `SELECT 1 FROM public.users`);
    expect((await pgError(create({}, ["empleado", "gerente"]))).message).toBe("ROLE_NOT_FOUND");
    expect((await pgError(create({}, []))).message).toBe("ROLE_NOT_FOUND");
    expect((await pgError(create({ full_name: "" }, ["empleado"]))).message).toBe("USER_INVALID");
    await create({}, ["empleado"]);
    expect((await pgError(create({ email: "otra@test.local" }, ["empleado"]))).message).toBe("USER_EXISTS");
    expect(await count(db, `SELECT 1 FROM public.users`)).toBe(before + 1);
  });
});

describe("ensure_user_has_role", () => {
  const ensure = (code: string, target = user) =>
    rpc<string[]>(db, "ensure_user_has_role", [target, code], ["uuid", "text"]);

  it("adds the role only when the user has none, and never replaces an existing set", async () => {
    expect(await ensure("empleado")).toEqual(["empleado"]);
    // Already has a role: a different code is NOT added.
    expect(await ensure("admin")).toEqual(["empleado"]);
    expect(await roles(user)).toEqual(["empleado"]);
  });

  it("rejects an unknown code or user", async () => {
    expect((await pgError(ensure("gerente"))).message).toBe("ROLE_NOT_FOUND");
    expect((await pgError(ensure("empleado", "00000000-0000-4000-8000-000000000000"))).message).toBe("USER_NOT_FOUND");
    expect(await roles(user)).toEqual([]);
  });
});

describe("upsert_employee_atomic", () => {
  /** `upsertEmployee` (admin/service.ts) on creation: legajo + optional new account. */
  const legajo = (overrides: Record<string, unknown> = {}) => ({
    full_name: "Ana Pérez",
    employee_code: null,
    document: "777",
    phone: null,
    position: null,
    email: null,
    birth_date: null,
    pay_type: "fijo",
    pay_frequency: null,
    salary_fixed: 1200000,
    commission_percent: null,
    ...overrides,
  });
  const upsert = (employee: Record<string, unknown>, userId: string | null, createUser: Record<string, unknown> | null) =>
    rpc<Record<string, unknown>>(
      db,
      "upsert_employee_atomic",
      [JSON.stringify(employee), userId, createUser === null ? null : JSON.stringify(createUser), "empleado"],
      ["jsonb", "uuid", "jsonb", "text"],
    );
  const account = { sede_id: null, email: null, phone: null, id_type: "CC", id_number: "777", password_hash: "h", full_name: "Ana Pérez" };

  it("creates account, role and legajo together, applying the column defaults", async () => {
    const row = await upsert(legajo(), null, account);
    expect(row).toMatchObject({ full_name: "Ana Pérez", payout_mode: "nomina", is_active: true, pay_frequency: null });
    expect(await roles(row.user_id as string)).toEqual(["empleado"]);
  });

  it("links an existing user and keeps its roles; explicit payout_mode/is_active override the defaults", async () => {
    await rpc(db, "replace_user_roles", [user, ["caja"]], ["uuid", "text[]"]);
    const row = await upsert(legajo({ payout_mode: "inmediato", is_active: false, pay_frequency: "quincenal" }), user, null);
    expect(row).toMatchObject({ user_id: user, payout_mode: "inmediato", is_active: false, pay_frequency: "quincenal" });
    expect(await roles(user)).toEqual(["caja"]);
  });

  it("writes nothing on an invalid cadence, a duplicated account or an unknown user", async () => {
    const employees = () => count(db, `SELECT 1 FROM public.employees`);
    expect((await pgError(upsert(legajo({ pay_frequency: "diaria" }), null, account))).message).toBe("EMPLOYEE_INVALID");
    await upsert(legajo(), null, account);
    expect((await pgError(upsert(legajo({ document: "778" }), null, account))).message).toBe("USER_EXISTS");
    expect((await pgError(upsert(legajo({ document: "779" }), "00000000-0000-4000-8000-000000000000", null))).message).toBe("USER_NOT_FOUND");
    expect(await employees()).toBe(1);
  });
});
