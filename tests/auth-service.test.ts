/**
 * Characterization of the auth service on the supabase-js path for the flows
 * `tests/auth.test.ts` does not pin request by request: login, logout,
 * session read, reset request and the admin reset. Written against the
 * service before the repository extraction (6d0d38d) and kept unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminResetUserPassword,
  getSessionUser,
  hashToken,
  hashPassword,
  loginWithDocument,
  logoutWithToken,
  requestPasswordReset,
  verifyPassword,
} from "@/src/features/auth/service";

const USER_SELECT =
  "id, sede_id, email, phone, id_type, id_number, password_hash, full_name, is_active, must_change_password, failed_attempts, locked_until";
const SESSION_SELECT = "id, user_id, token_hash, expires_at, revoked, last_activity_at";

type Response = { data?: unknown; error: unknown };
const postgrest = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; chain: Array<[string, unknown[]]> }>,
  answers: [] as Array<{ data?: unknown; error: unknown }>,
}));

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const call = { table, chain: [] as Array<[string, unknown[]]> };
      // audit_logs is written by writeAudit with its own client: not recorded.
      if (table !== "audit_logs") postgrest.calls.push(call);
      const answer = () => (table === "audit_logs" ? { data: null, error: null } : postgrest.answers.shift() ?? { data: null, error: null });
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "update", "insert"]) {
        query[method] = (...args: unknown[]) => {
          call.chain.push([method, args]);
          return query;
        };
      }
      query.maybeSingle = () => {
        call.chain.push(["maybeSingle", []]);
        return Promise.resolve(answer());
      };
      query.then = (ok?: (v: unknown) => unknown, ko?: (r: unknown) => unknown) => Promise.resolve(answer()).then(ok, ko);
      return query;
    },
  }),
}));

function answer(...responses: Response[]) {
  postgrest.answers = responses;
}

const NOW = new Date("2026-10-10T12:00:00.000Z");
let documento = 0;
const nextDocument = () => `90000${(documento += 1)}`;

async function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1", sede_id: "s1", email: "a@b.co", phone: null, id_type: "CC", id_number: "1",
    password_hash: await hashPassword("Clave123"), full_name: "Ana", is_active: true,
    must_change_password: false, failed_attempts: 0, locked_until: null, ...overrides,
  };
}

beforeEach(() => {
  postgrest.calls = [];
  postgrest.answers = [];
});

describe("loginWithDocument (supabase-js)", () => {
  it("reads the user by document and its roles(code) embed, opens a session and clears the counters", async () => {
    const doc = nextDocument();
    answer({ data: await user(), error: null }, { data: [{ roles: { code: "admin" } }, { roles: null }, { roles: { code: "otro" } }], error: null });
    const result = await loginWithDocument({ documento: doc, password: "Clave123" }, NOW);
    expect(result).toMatchObject({ user: { id: "u1", full_name: "Ana", must_change_password: false }, roles: ["admin"], mustChangePassword: false });
    expect(result.sessionToken).toHaveLength(64);
    const [read, roles, session, reset] = postgrest.calls;
    expect(read.chain).toEqual([["select", [USER_SELECT]], ["eq", ["id_number", doc]], ["maybeSingle", []]]);
    expect(roles.chain).toEqual([["select", ["roles(code)"]], ["eq", ["user_id", "u1"]]]);
    expect(session).toEqual({
      table: "sessions",
      chain: [["insert", [{ user_id: "u1", token_hash: hashToken(result.sessionToken), expires_at: "2026-10-11T00:00:00.000Z" }]]],
    });
    expect(reset.chain).toEqual([["update", [{ failed_attempts: 0, locked_until: null }]], ["eq", ["id", "u1"]]]);
  });

  it("a wrong password counts the failure (5th locks) and never opens a session", async () => {
    answer({ data: await user({ failed_attempts: 4 }), error: null }, { data: [], error: null });
    await expect(loginWithDocument({ documento: nextDocument(), password: "Otra1234" }, NOW)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 423 });
    expect(postgrest.calls.at(-1)?.chain).toEqual([
      ["update", [{ failed_attempts: 5, locked_until: "2026-10-10T12:15:00.000Z" }]],
      ["eq", ["id", "u1"]],
    ]);
    expect(postgrest.calls.some((call) => call.table === "sessions")).toBe(false);
  });

  it("unknown, inactive or locked accounts and database failures", async () => {
    answer({ data: null, error: null });
    await expect(loginWithDocument({ documento: nextDocument(), password: "x" }, NOW)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
    answer({ data: await user({ locked_until: "2026-10-10T12:05:00+00:00" }), error: null }, { data: [], error: null });
    await expect(loginWithDocument({ documento: nextDocument(), password: "Clave123" }, NOW)).rejects.toMatchObject({ code: "ACCOUNT_LOCKED", status: 423 });
    answer({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(loginWithDocument({ documento: nextDocument(), password: "x" }, NOW)).rejects.toMatchObject({ code: "INTERNAL", status: 500, message: "Error interno." });
    answer({ data: await user(), error: null }, { data: [], error: null }, { error: { code: "23505", message: "duplicate key value violates unique constraint \"sessions_token_hash_key\"" } });
    await expect(loginWithDocument({ documento: nextDocument(), password: "Clave123" }, NOW)).rejects.toMatchObject({ code: "INTERNAL", message: "Error interno." });
  });
});

describe("sessions (supabase-js)", () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: "s1", user_id: "u1", token_hash: hashToken("tok"), expires_at: "2026-10-10T20:00:00+00:00",
    revoked: false, last_activity_at: "2026-10-10T11:50:00+00:00", ...overrides,
  });

  it("logout revokes only the live session of that token; no token is a no-op", async () => {
    expect(await logoutWithToken(null)).toEqual({ revoked: false });
    expect(postgrest.calls).toEqual([]);
    answer({ error: null });
    expect(await logoutWithToken("tok")).toEqual({ revoked: true });
    expect(postgrest.calls[0]).toEqual({
      table: "sessions",
      chain: [["update", [{ revoked: true }]], ["eq", ["token_hash", hashToken("tok")]], ["eq", ["revoked", false]]],
    });
    answer({ error: { message: "down" } });
    await expect(logoutWithToken("tok")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("a valid session refreshes its activity and carries the roles; read failures of those two are ignored", async () => {
    const row = await user();
    answer({ data: session(), error: null }, { data: row, error: null }, { error: null }, { data: [{ roles: { code: "caja" } }], error: null });
    expect(await getSessionUser("tok", NOW)).toEqual({ user: row, roles: ["caja"], session: session() });
    expect(postgrest.calls.map((call) => call.chain)).toEqual([
      [["select", [SESSION_SELECT]], ["eq", ["token_hash", hashToken("tok")]], ["maybeSingle", []]],
      [["select", [USER_SELECT]], ["eq", ["id", "u1"]], ["maybeSingle", []]],
      [["update", [{ last_activity_at: NOW.toISOString() }]], ["eq", ["id", "s1"]]],
      [["select", ["roles(code)"]], ["eq", ["user_id", "u1"]]],
    ]);
    answer({ data: session(), error: null }, { data: row, error: null }, { error: { message: "x" } }, { data: null, error: { message: "y" } });
    expect((await getSessionUser("tok", NOW))?.roles).toEqual([]);
  });

  it.each([
    ["revoked", { revoked: true }],
    ["expired", { expires_at: "2026-10-10T11:59:59+00:00" }],
    ["inactive", { last_activity_at: "2026-10-10T10:00:00+00:00" }],
  ])("a %s session is null without reading the user", async (_label, overrides) => {
    answer({ data: session(overrides), error: null });
    expect(await getSessionUser("tok", NOW)).toBeNull();
    expect(postgrest.calls).toHaveLength(1);
  });
});

describe("password reset request and admin reset (supabase-js)", () => {
  it("stores only the token hash with a 30 minute expiry; unknown documents answer the same", async () => {
    answer({ data: await user(), error: null }, { data: [], error: null }, { error: null });
    const result = await requestPasswordReset({ documento: nextDocument() }, NOW);
    expect(result.requested).toBe(true);
    expect(postgrest.calls.at(-1)).toEqual({
      table: "password_resets",
      chain: [["insert", [{ user_id: "u1", token_hash: hashToken(result.devToken as string), expires_at: "2026-10-10T12:30:00.000Z" }]]],
    });
    answer({ data: null, error: null });
    expect(await requestPasswordReset({ documento: nextDocument() }, NOW)).toEqual({ requested: true });
  });

  it("admin reset puts the document back as the password, forces the change and unlocks", async () => {
    answer({ data: { id: "u1", id_number: "777" }, error: null }, { error: null });
    expect(await adminResetUserPassword("u1", "admin-1")).toEqual({ user_id: "u1" });
    const [, update] = postgrest.calls;
    const [, [patch]] = update.chain[0] as [string, [Record<string, unknown>]];
    expect(patch).toMatchObject({ must_change_password: true, failed_attempts: 0, locked_until: null });
    expect(await verifyPassword("777", patch.password_hash as string)).toBe(true);
    expect(update.chain[1]).toEqual(["eq", ["id", "u1"]]);
    answer({ data: null, error: null });
    await expect(adminResetUserPassword("u2", "admin-1")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
