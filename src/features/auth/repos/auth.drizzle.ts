/**
 * Direct PostgreSQL adapter of the auth port (`./auth.ts`). SERVER ONLY,
 * loaded with import() only when DB_ENGINE=postgres; the database is injected
 * so the tests run it against PGlite.
 *
 * Equivalences with the supabase-js adapter:
 * - `roles(code)`: `user_roles LEFT JOIN roles`, one `{ roles: { code } | null }`
 *   per `user_roles` row (a many-to-one embed is an object, never an array).
 * - RPCs: `SELECT public.fn(arg::cast, ...)` returning the same scalar.
 * - Timestamps through `toPostgrestTimestamp`; errors through `toDbError`,
 *   which never carries Drizzle's query parameters (hashes, token hashes).
 * - No Supabase Auth behind this engine: `mirrorAuthUser` is a no-op success
 *   (decision documented in `./auth.ts`).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/src/shared/db/client";
import { DbQueryError, toDbError } from "@/src/shared/db/errors";
import { callRpc } from "@/src/shared/db/rpc";
import { authEmployees, authUsers, passwordResets, roles, sessions, userRoles } from "@/src/shared/db/schema";
import { toPostgrestTimestamp } from "@/src/shared/db/timestamps";
import type { AuthRepo, AuthUserRow, PasswordResetRow, SessionRow } from "./auth";

const USER_COLUMNS = {
  id: authUsers.id,
  sede_id: authUsers.sedeId,
  email: authUsers.email,
  phone: authUsers.phone,
  id_type: authUsers.idType,
  id_number: authUsers.idNumber,
  password_hash: authUsers.passwordHash,
  full_name: authUsers.fullName,
  is_active: authUsers.isActive,
  must_change_password: authUsers.mustChangePassword,
  failed_attempts: authUsers.failedAttempts,
  locked_until: authUsers.lockedUntil,
};

const SESSION_COLUMNS = {
  id: sessions.id,
  user_id: sessions.userId,
  token_hash: sessions.tokenHash,
  expires_at: sessions.expiresAt,
  revoked: sessions.revoked,
  last_activity_at: sessions.lastActivityAt,
};

const RESET_COLUMNS = {
  id: passwordResets.id,
  user_id: passwordResets.userId,
  token_hash: passwordResets.tokenHash,
  expires_at: passwordResets.expiresAt,
  used: passwordResets.used,
};

const toUser = (row: AuthUserRow): AuthUserRow => ({ ...row, locked_until: toPostgrestTimestamp(row.locked_until) });
const toSession = (row: SessionRow): SessionRow => ({
  ...row,
  expires_at: toPostgrestTimestamp(row.expires_at),
  last_activity_at: toPostgrestTimestamp(row.last_activity_at),
});
const toReset = (row: PasswordResetRow): PasswordResetRow => ({ ...row, expires_at: toPostgrestTimestamp(row.expires_at) });

async function run<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new DbQueryError(toDbError(error));
  }
}

export function drizzleAuthRepo(db: Database): AuthRepo {
  const userWhere = async (condition: ReturnType<typeof eq>) => {
    const [row] = await db.select(USER_COLUMNS).from(authUsers).where(condition).limit(1);
    return row ? toUser(row) : null;
  };
  return {
    // id_number and id are UNIQUE: maybeSingle can never see two rows.
    findUserByDocument: (documento) => run(() => userWhere(eq(authUsers.idNumber, documento))),
    findUserById: (id) => run(() => userWhere(eq(authUsers.id, id))),
    roleEmbeds: (userId) =>
      run(async () => {
        const rows = await db
          .select({ code: roles.code })
          .from(userRoles)
          .leftJoin(roles, eq(roles.id, userRoles.roleId))
          .where(eq(userRoles.userId, userId));
        return rows.map((row) => ({ roles: row.code === null ? null : { code: row.code } }));
      }),
    updateLoginState: (userId, patch) =>
      run(async () => {
        await db
          .update(authUsers)
          .set({ failedAttempts: patch.failed_attempts, lockedUntil: patch.locked_until })
          .where(eq(authUsers.id, userId));
      }),
    insertSession: (row) =>
      run(async () => {
        await db.insert(sessions).values({ userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at });
      }),
    revokeSession: (tokenHash) =>
      run(async () => {
        await db
          .update(sessions)
          .set({ revoked: true })
          .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.revoked, false)));
      }),
    findSession: (tokenHash) =>
      run(async () => {
        const [row] = await db.select(SESSION_COLUMNS).from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
        return row ? toSession(row) : null;
      }),
    touchSession: (sessionId, at) =>
      run(async () => {
        await db.update(sessions).set({ lastActivityAt: at }).where(eq(sessions.id, sessionId));
      }),
    findPasswordHash: (userId) =>
      run(async () => {
        const [row] = await db
          .select({ id: authUsers.id, password_hash: authUsers.passwordHash })
          .from(authUsers)
          .where(eq(authUsers.id, userId))
          .limit(1);
        return row ?? null;
      }),
    insertPasswordReset: (row) =>
      run(async () => {
        await db.insert(passwordResets).values({ userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at });
      }),
    findPasswordReset: (tokenHash) =>
      run(async () => {
        const [row] = await db.select(RESET_COLUMNS).from(passwordResets).where(eq(passwordResets.tokenHash, tokenHash)).limit(1);
        return row ? toReset(row) : null;
      }),
    findUserIdBy: (column, value) =>
      run(async () => {
        const target = column === "email" ? authUsers.email : column === "id" ? authUsers.id : authUsers.idNumber;
        const [row] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(target, value)).limit(1);
        return row ?? null;
      }),
    findRoles: (codes) => run(() => db.select({ id: roles.id, code: roles.code }).from(roles).where(inArray(roles.code, codes))),
    findUserDocument: (userId) =>
      run(async () => {
        const [row] = await db
          .select({ id: authUsers.id, id_number: authUsers.idNumber })
          .from(authUsers)
          .where(eq(authUsers.id, userId))
          .limit(1);
        return row ?? null;
      }),
    resetPasswordToDocument: (userId, passwordHash) =>
      run(async () => {
        await db
          .update(authUsers)
          .set({ passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null })
          .where(eq(authUsers.id, userId));
      }),
    linkEmployees: (userId, documento) =>
      run(async () => {
        await db
          .update(authEmployees)
          .set({ userId })
          .where(and(eq(authEmployees.document, documento), isNull(authEmployees.userId)));
      }),
    changeUserPassword: (args) =>
      run(() =>
        callRpc(db, "change_user_password", [
          { value: args.userId, cast: "uuid" },
          { value: args.passwordHash, cast: "text" },
          { value: args.currentTokenHash, cast: "text" },
          { value: args.expectedPasswordHash, cast: "text" },
        ]),
      ),
    confirmPasswordReset: (args) =>
      run(() =>
        callRpc(db, "confirm_password_reset", [
          { value: args.tokenHash, cast: "text" },
          { value: args.passwordHash, cast: "text" },
          { value: args.now, cast: "timestamptz" },
        ]),
      ),
    createUserWithRole: (user, roleCodes) =>
      run(() =>
        callRpc(db, "create_user_with_role", [
          { value: user, cast: "jsonb" },
          { value: roleCodes, cast: "text[]" },
        ]),
      ),
    discardCreatedUser: (userId) => run(() => callRpc(db, "discard_created_user", [{ value: userId, cast: "uuid" }])),
    mirrorAuthUser: async () => null,
  };
}
