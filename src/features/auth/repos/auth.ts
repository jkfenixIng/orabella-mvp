/**
 * Port of the auth persistence (users, user_roles + roles, sessions,
 * password_resets, roles, the four identity RPCs and the Supabase Auth
 * mirror), its supabase-js adapter and the selector — same pattern as
 * `src/features/admin/repos/services.ts`.
 *
 * `supabaseAuthRepo` holds the requests the service sent before the
 * extraction (6d0d38d), unchanged. `./auth.drizzle.ts` is loaded with import()
 * only when DB_ENGINE=postgres. Both adapters throw `DbQueryError`; an RPC
 * rejection keeps SQLSTATE P0001 and its exact message, so `esRechazoDeRpc`
 * works on both engines.
 *
 * SECRETS: password hashes and token hashes are parameters of these calls.
 * `toDbError` never copies Drizzle's "Failed query ... params:" text, and the
 * service never forwards a database message to the client.
 *
 * MIRROR (decision of phase 3b-2): Supabase Auth exists only behind the
 * `supabase` engine. With DB_ENGINE=postgres there is no Supabase Auth; the
 * mirror is a copy nobody reads (production auth.users has 0 rows), so the
 * postgres adapter omits it and returns "no error": no compensation runs.
 * The `supabase` engine keeps the mirror and its compensation exactly as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbConfig } from "@/src/shared/config/env";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";

export interface AuthUserRow {
  id: string;
  /**
   * The account still names its installation and the session guards require
   * it (NO_SEDE otherwise). A returned field, never a read filter.
   */
  sede_id: string | null;
  email: string | null;
  phone: string | null;
  id_type: string;
  id_number: string;
  password_hash: string;
  full_name: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_attempts: number;
  locked_until: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked: boolean;
  last_activity_at: string;
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used: boolean;
}

/** One `user_roles` row with its `roles(code)` embed: an object, or null. */
export interface UserRoleEmbed {
  roles: { code: string } | null;
}

export interface LoginStatePatch {
  failed_attempts: number;
  locked_until: string | null;
}

export interface NewUser {
  sede_id: string | null;
  email: string;
  phone: string | null;
  id_type: string;
  id_number: string;
  password_hash: string;
  full_name: string;
}

export interface AuthMirrorUser {
  email: string;
  password: string;
  email_confirm: true;
  user_metadata: { id_number: string; full_name: string };
}

export interface AuthRepo {
  findUserByDocument(documento: string): Promise<AuthUserRow | null>;
  findUserById(id: string): Promise<AuthUserRow | null>;
  /** `user_roles` of a user with the `roles(code)` embed (PostgREST shape). */
  roleEmbeds(userId: string): Promise<UserRoleEmbed[]>;
  updateLoginState(userId: string, patch: LoginStatePatch): Promise<void>;
  insertSession(row: { user_id: string; token_hash: string; expires_at: string }): Promise<void>;
  /** Revokes the live session with that token hash (idempotent). */
  revokeSession(tokenHash: string): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRow | null>;
  touchSession(sessionId: string, at: string): Promise<void>;
  findPasswordHash(userId: string): Promise<{ id: string; password_hash: string } | null>;
  insertPasswordReset(row: { user_id: string; token_hash: string; expires_at: string }): Promise<void>;
  findPasswordReset(tokenHash: string): Promise<PasswordResetRow | null>;
  findUserIdBy(column: "id" | "id_number" | "email", value: string): Promise<{ id: string } | null>;
  findRoles(codes: string[]): Promise<Array<{ id: string; code: string }>>;
  findUserDocument(userId: string): Promise<{ id: string; id_number: string } | null>;
  resetPasswordToDocument(userId: string, passwordHash: string): Promise<void>;
  linkEmployees(userId: string, documento: string): Promise<void>;
  changeUserPassword(args: { userId: string; passwordHash: string; currentTokenHash: string | null; expectedPasswordHash: string }): Promise<unknown>;
  confirmPasswordReset(args: { tokenHash: string; passwordHash: string; now: string }): Promise<unknown>;
  createUserWithRole(user: NewUser, roleCodes: string[]): Promise<unknown>;
  discardCreatedUser(userId: string): Promise<unknown>;
  /**
   * Mirror in Supabase Auth: the provider error (code/status), or null on
   * success. The postgres adapter has no Supabase Auth and always returns null.
   */
  mirrorAuthUser(user: AuthMirrorUser): Promise<{ code?: string; status?: number } | null>;
}

// ---------------------------------------------------------------- supabase ---

const USER_SELECT =
  "id, sede_id, email, phone, id_type, id_number, password_hash, full_name, is_active, must_change_password, failed_attempts, locked_until";

function fail(error: unknown): never {
  throw new DbQueryError(toDbError(error));
}

async function single<T>(promise: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data, error } = await promise;
  if (error) fail(error);
  return (data ?? null) as T | null;
}

async function write(promise: PromiseLike<{ error: unknown }>): Promise<void> {
  const { error } = await promise;
  if (error) fail(error);
}

async function rpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) fail(error);
  return data;
}

export function supabaseAuthRepo(db: SupabaseClient): AuthRepo {
  return {
    findUserByDocument: (documento) => single(db.from("users").select(USER_SELECT).eq("id_number", documento).maybeSingle()),
    findUserById: (id) => single(db.from("users").select(USER_SELECT).eq("id", id).maybeSingle()),
    async roleEmbeds(userId) {
      const { data, error } = await db.from("user_roles").select("roles(code)").eq("user_id", userId);
      if (error) fail(error);
      return (data ?? []) as unknown as UserRoleEmbed[];
    },
    updateLoginState: (userId, patch) => write(db.from("users").update(patch).eq("id", userId)),
    insertSession: (row) => write(db.from("sessions").insert(row)),
    revokeSession: (tokenHash) => write(db.from("sessions").update({ revoked: true }).eq("token_hash", tokenHash).eq("revoked", false)),
    findSession: (tokenHash) =>
      single(db.from("sessions").select("id, user_id, token_hash, expires_at, revoked, last_activity_at").eq("token_hash", tokenHash).maybeSingle()),
    touchSession: (sessionId, at) => write(db.from("sessions").update({ last_activity_at: at }).eq("id", sessionId)),
    findPasswordHash: (userId) => single(db.from("users").select("id, password_hash").eq("id", userId).maybeSingle()),
    insertPasswordReset: (row) => write(db.from("password_resets").insert(row)),
    findPasswordReset: (tokenHash) =>
      single(db.from("password_resets").select("id, user_id, token_hash, expires_at, used").eq("token_hash", tokenHash).maybeSingle()),
    findUserIdBy: (column, value) => single(db.from("users").select("id").eq(column, value).maybeSingle()),
    async findRoles(codes) {
      const { data, error } = await db.from("roles").select("id, code").in("code", codes);
      if (error) fail(error);
      return (data ?? []) as Array<{ id: string; code: string }>;
    },
    findUserDocument: (userId) => single(db.from("users").select("id, id_number").eq("id", userId).maybeSingle()),
    resetPasswordToDocument: (userId, passwordHash) =>
      write(
        db
          .from("users")
          .update({ password_hash: passwordHash, must_change_password: true, failed_attempts: 0, locked_until: null })
          .eq("id", userId),
      ),
    linkEmployees: (userId, documento) =>
      write(db.from("employees").update({ user_id: userId }).eq("document", documento).is("user_id", null)),
    changeUserPassword: (args) =>
      rpc(db, "change_user_password", {
        p_user_id: args.userId,
        p_password_hash: args.passwordHash,
        p_current_token_hash: args.currentTokenHash,
        p_expected_password_hash: args.expectedPasswordHash,
      }),
    confirmPasswordReset: (args) =>
      rpc(db, "confirm_password_reset", { p_token_hash: args.tokenHash, p_password_hash: args.passwordHash, p_now: args.now }),
    createUserWithRole: (user, roleCodes) => rpc(db, "create_user_with_role", { p_user: user, p_role_codes: roleCodes }),
    discardCreatedUser: (userId) => rpc(db, "discard_created_user", { p_user_id: userId }),
    async mirrorAuthUser(user) {
      const { error } = await db.auth.admin.createUser(user);
      return error ? (error as { code?: string; status?: number }) : null;
    },
  };
}

// ---------------------------------------------------------------- selector ---

/** The adapter for the configured engine; engine modules load on demand (server only). */
export async function authRepo(): Promise<AuthRepo> {
  if (getDbConfig().engine === "postgres") {
    const [{ getDb }, { drizzleAuthRepo }] = await Promise.all([
      import("@/src/shared/db/client"),
      import("./auth.drizzle"),
    ]);
    return drizzleAuthRepo(getDb());
  }
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return supabaseAuthRepo(createAdminClient());
}
