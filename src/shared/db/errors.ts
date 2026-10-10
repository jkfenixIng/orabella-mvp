/**
 * Normalizes an error thrown on the direct PostgreSQL path to the shape the
 * services already read from supabase-js: `{ code, message, details }`, where
 * `code` is the SQLSTATE (P0001 RAISE EXCEPTION, 23505 unique, 23P01 exclusion,
 * 23514 check, ...). PostgREST passes the SQLSTATE through unchanged, so the
 * same `error.code === "23505"` checks keep working on both engines.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError` with the original in
 * `cause`; postgres-js and PGlite both expose `code`, `message` and `detail`.
 *
 * Pure module (no driver import): repositories of both engines use it.
 */
export interface DbError {
  code: string | null;
  message: string;
  details: string | null;
}

/** Failure of a repository call, carrying the normalized database error. */
export class DbQueryError extends Error {
  readonly error: DbError;

  constructor(error: DbError) {
    super(error.message);
    this.name = "DbQueryError";
    this.error = error;
  }
}

type PgLike = { code?: unknown; message?: unknown; detail?: unknown; details?: unknown; cause?: unknown };

const SQLSTATE = /^[0-9A-Z]{5}$/;

function asPgLike(value: unknown): PgLike | null {
  return typeof value === "object" && value !== null ? (value as PgLike) : null;
}

/** The innermost error that carries a SQLSTATE, following `cause` links. */
function findPgError(error: unknown): PgLike | null {
  let current = asPgLike(error);
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current.code === "string" && SQLSTATE.test(current.code)) return current;
    current = asPgLike(current.cause);
  }
  return null;
}

export function toDbError(error: unknown): DbError {
  const pg = findPgError(error);
  const source = pg ?? asPgLike(error);
  const detail = source?.detail ?? source?.details;
  // A supabase-js error may carry a PostgREST code (PGRST116, ...): keep it.
  const code = pg ? (pg.code as string) : typeof source?.code === "string" ? source.code : null;
  return {
    code,
    message: typeof source?.message === "string" ? source.message : String(error),
    details: typeof detail === "string" ? detail : null,
  };
}
