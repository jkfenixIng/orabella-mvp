import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  adminCreateUserSchema,
  changePasswordSchema,
  isRoleCode,
  loginSchema,
  requestResetSchema,
  resetPasswordSchema,
  type RoleCode,
} from "./schemas";

const scrypt = promisify(scryptCb);

import {
  ACCOUNT_LOCKED_ERROR,
  GENERIC_LOGIN_ERROR,
  LOCKOUT_DURATION_MS,
  MAX_LOGIN_ATTEMPTS,
  PASSWORD_RESET_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_TTL_MS,
} from "./constants";
import { AUDIT_ACTIONS, writeAudit } from "@/src/shared/lib/audit";
import {
  MemoryRateLimiter,
  isRateLimited,
  recordRateFailure,
  resetRateLimit,
  type RateLimitBudget,
} from "@/src/shared/lib/rate-limit";

export {
  ACCOUNT_LOCKED_ERROR,
  GENERIC_LOGIN_ERROR,
  LOCKOUT_DURATION_MS,
  MAX_LOGIN_ATTEMPTS,
  PASSWORD_RESET_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  SESSION_COOKIE_NAME,
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_TTL_MS,
} from "./constants";

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

// ------------------------------------------------------------------ hash ---
const SCRYPT_KEYLEN = 64;

/** Hash scrypt con sal aleatoria. Formato: scrypt$v1$<saltHex>$<hashHex>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$v1$${salt}$${derived.toString("hex")}`;
}

/** Comparación en tiempo constante; false ante hash malformado. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const salt = parts[2];
  const expectedHex = parts[3];
  try {
    const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
    const expected = Buffer.from(expectedHex, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- tokens ---
/** Hash SHA-256 para guardar tokens (sesión/recuperación). Nunca en claro. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Token opaco de sesión (el raw viaja solo en cookie httpOnly). */
export function createSessionToken(now: Date = new Date()): IssuedToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
}

/** Token de recuperación de un solo uso, expiración corta (AUTH-06). */
export function createPasswordResetToken(now: Date = new Date()): IssuedToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  };
}

export function isResetTokenUsable(args: {
  used: boolean;
  expiresAt: Date;
  now?: Date;
}): boolean {
  const now = args.now ?? new Date();
  return !args.used && args.expiresAt.getTime() > now.getTime();
}

/**
 * CL-18: mensaje del error de negocio que ve el usuario cuando el CAS de la
 * clave pierde la carrera. Describe lo que pasó SIN revelar nada: dice que la
 * clave cambió por debajo y que hay que reintentar; nunca qué hash quedó ni
 * quién lo escribió.
 */
export const PASSWORD_CHANGED_ELSEWHERE_ERROR =
  "La clave cambió mientras se procesaba el cambio. Intente de nuevo.";

/**
 * ¿El fallo de un `rpc` es una DECISIÓN del contrato (un `RAISE EXCEPTION` de
 * las funciones de 054/057, siempre SQLSTATE P0001) y no una falla del sistema?
 * El mensaje es el vocabulario compartido entre el archivo y este módulo.
 */
function esRechazoDeRpc(
  error: { code?: string; message?: string } | null,
  codigo: string,
): boolean {
  return Boolean(error && error.code === "P0001" && error.message === codigo);
}

export interface SessionValidity {
  valid: boolean;
  reason: "ok" | "revoked" | "expired" | "inactive";
}

/** AUTH-03: expiración, revocación y timeout por inactividad. */
export function checkSessionValidity(args: {
  revoked: boolean;
  expiresAt: Date;
  lastActivityAt: Date;
  now?: Date;
}): SessionValidity {
  const now = args.now ?? new Date();
  if (args.revoked) return { valid: false, reason: "revoked" };
  if (args.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: "expired" };
  if (now.getTime() - args.lastActivityAt.getTime() > SESSION_INACTIVITY_TIMEOUT_MS) {
    return { valid: false, reason: "inactive" };
  }
  return { valid: true, reason: "ok" };
}

// ------------------------------------------------------------- rate-limit ---
/**
 * T8: rate-limit externo (Upstash Redis REST) con fallback a memoria
 * (NFR-03; ver src/shared/lib/rate-limit.ts). La clase se conserva con la
 * interfaz de T2 para compatibilidad y tests; el flujo de login y
 * recuperación usa las funciones async del módulo compartido.
 */
export { MemoryRateLimiter as DocumentRateLimiter } from "@/src/shared/lib/rate-limit";

/** Instancia histórica por proceso (compatibilidad; el flujo usa el módulo compartido). */
export const loginRateLimiter = new MemoryRateLimiter();

/** 5 intentos / 15 min por documento (AUTH-05, NFR-03). */
const LOGIN_BUDGET: RateLimitBudget = {
  maxAttempts: MAX_LOGIN_ATTEMPTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
  namespace: "login",
};

/** 5 solicitudes / 15 min por documento (NFR-03). */
const RESET_BUDGET: RateLimitBudget = {
  maxAttempts: MAX_LOGIN_ATTEMPTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
  namespace: "password-reset",
};

// ---------------------------------------------------------------- bloqueo ---
export function isAccountLocked(
  lockedUntil: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (!lockedUntil) return false;
  const until = lockedUntil instanceof Date ? lockedUntil : new Date(lockedUntil);
  return until.getTime() > now.getTime();
}

export interface FailedLoginOutcome {
  failedAttempts: number;
  lockedUntil: Date | null;
  locked: boolean;
}

/** AUTH-05: al 5.º fallo consecutivo la cuenta se bloquea temporalmente. */
export function nextFailedLoginState(
  currentAttempts: number,
  now: Date = new Date(),
): FailedLoginOutcome {
  const failedAttempts = currentAttempts + 1;
  if (failedAttempts >= MAX_LOGIN_ATTEMPTS) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS),
      locked: true,
    };
  }
  return { failedAttempts, lockedUntil: null, locked: false };
}

// ----------------------------------------------------------- persistencia ---
export interface AuthUserRow {
  id: string;
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

/**
 * Cliente privilegiado bajo demanda (service_role, solo servidor).
 * Import dinámico para que los tests unitarios (sin red/env) nunca lo carguen.
 */
async function adminDb() {
  const { createAdminClient } = await import("@/src/shared/lib/supabase/server");
  return createAdminClient();
}

function validationMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Datos inválidos.";
}

async function findUserByDocument(documento: string): Promise<{
  user: AuthUserRow;
  roles: RoleCode[];
} | null> {
  const db = await adminDb();
  const { data: user, error } = await db
    .from("users")
    .select(
      "id, sede_id, email, phone, id_type, id_number, password_hash, full_name, is_active, must_change_password, failed_attempts, locked_until",
    )
    .eq("id_number", documento)
    .maybeSingle();
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
  if (!user) return null;
  const row = user as AuthUserRow;
  const { data: roleRows, error: roleError } = await db
    .from("user_roles")
    .select("roles(code)")
    .eq("user_id", row.id);
  if (roleError) throw new AuthError("INTERNAL", "Error interno.", 500);
  const roles = ((roleRows ?? []) as unknown as Array<{ roles: { code: string } | null }>)
    .map((r) => r.roles?.code)
    .filter(isRoleCode);
  return { user: row, roles };
}

export interface LoginResult {
  user: Pick<AuthUserRow, "id" | "full_name" | "must_change_password">;
  roles: RoleCode[];
  sessionToken: string;
  mustChangePassword: boolean;
}

/**
 * AUTH-01/05: login por documento. Rate-limit compartido T8 (Upstash o
 * memoria), bloqueo tras 5 fallos, flag de cambio forzado. Error genérico
 * (sin enumerar usuarios). Los fallos y bloqueos quedan en audit_logs.
 */
export async function loginWithDocument(raw: unknown, now: Date = new Date()): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) throw new AuthError("VALIDATION", validationMessage(parsed.error), 400);
  const { documento, password } = parsed.data;

  if (await isRateLimited(documento, LOGIN_BUDGET)) {
    throw new AuthError("RATE_LIMITED", ACCOUNT_LOCKED_ERROR, 429);
  }

  const found = await findUserByDocument(documento);
  if (!found || !found.user.is_active) {
    await recordRateFailure(documento, LOGIN_BUDGET);
    await writeAudit({
      sede_id: found?.user.sede_id ?? null,
      user_id: found?.user.id ?? null,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: "users",
      entity_id: found?.user.id ?? documento,
      metadata: { reason: "unknown_or_inactive" },
    });
    throw new AuthError("INVALID_CREDENTIALS", GENERIC_LOGIN_ERROR, 401);
  }
  const { user, roles } = found;

  if (isAccountLocked(user.locked_until, now)) {
    throw new AuthError("ACCOUNT_LOCKED", ACCOUNT_LOCKED_ERROR, 423);
  }

  const matches = await verifyPassword(password, user.password_hash);
  const db = await adminDb();
  if (!matches) {
    const outcome = nextFailedLoginState(user.failed_attempts, now);
    await recordRateFailure(documento, LOGIN_BUDGET);
    const { error } = await db
      .from("users")
      .update({
        failed_attempts: outcome.failedAttempts,
        locked_until: outcome.lockedUntil?.toISOString() ?? null,
      })
      .eq("id", user.id);
    if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
    await writeAudit({
      sede_id: user.sede_id,
      user_id: user.id,
      action: outcome.locked ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
      entity: "users",
      entity_id: user.id,
      metadata: { attempts: outcome.failedAttempts, locked: outcome.locked },
    });
    throw new AuthError(
      "INVALID_CREDENTIALS",
      outcome.locked ? ACCOUNT_LOCKED_ERROR : GENERIC_LOGIN_ERROR,
      outcome.locked ? 423 : 401,
    );
  }

  const issued = createSessionToken(now);
  const { error: sessionError } = await db.from("sessions").insert({
    user_id: user.id,
    token_hash: issued.tokenHash,
    expires_at: issued.expiresAt.toISOString(),
  });
  if (sessionError) throw new AuthError("INTERNAL", "Error interno.", 500);

  const { error: resetError } = await db
    .from("users")
    .update({ failed_attempts: 0, locked_until: null })
    .eq("id", user.id);
  if (resetError) throw new AuthError("INTERNAL", "Error interno.", 500);

  await resetRateLimit(documento, LOGIN_BUDGET);
  return {
    user: { id: user.id, full_name: user.full_name, must_change_password: user.must_change_password },
    roles,
    sessionToken: issued.token,
    mustChangePassword: user.must_change_password,
  };
}

/** AUTH-03: revoca la sesión (logout). Idempotente. */
export async function logoutWithToken(token: string | null | undefined): Promise<{ revoked: boolean }> {
  if (!token) return { revoked: false };
  const db = await adminDb();
  const { error } = await db
    .from("sessions")
    .update({ revoked: true })
    .eq("token_hash", hashToken(token))
    .eq("revoked", false);
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
  return { revoked: true };
}

export interface SessionUser {
  user: AuthUserRow;
  roles: RoleCode[];
  session: SessionRow;
}

/**
 * Valida el token de sesión (expiración/revocación/inactividad) y
 * refresca last_activity_at. Null si exige re-autenticación (AUTH-03).
 */
export async function getSessionUser(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await adminDb();
  const { data: session, error } = await db
    .from("sessions")
    .select("id, user_id, token_hash, expires_at, revoked, last_activity_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
  if (!session) return null;
  const sessionRow = session as SessionRow;
  const validity = checkSessionValidity({
    revoked: sessionRow.revoked,
    expiresAt: new Date(sessionRow.expires_at),
    lastActivityAt: new Date(sessionRow.last_activity_at),
    now,
  });
  if (!validity.valid) return null;

  const { data: user, error: userError } = await db
    .from("users")
    .select(
      "id, sede_id, email, phone, id_type, id_number, password_hash, full_name, is_active, must_change_password, failed_attempts, locked_until",
    )
    .eq("id", sessionRow.user_id)
    .maybeSingle();
  if (userError) throw new AuthError("INTERNAL", "Error interno.", 500);
  if (!user || !(user as AuthUserRow).is_active) return null;

  await db
    .from("sessions")
    .update({ last_activity_at: now.toISOString() })
    .eq("id", sessionRow.id);

  const { data: roleRows } = await db
    .from("user_roles")
    .select("roles(code)")
    .eq("user_id", sessionRow.user_id);
  const roles = ((roleRows ?? []) as unknown as Array<{ roles: { code: string } | null }>)
    .map((r) => r.roles?.code)
    .filter(isRoleCode);
  return { user: user as AuthUserRow, roles, session: sessionRow };
}

/**
 * AUTH-02: cambio de clave propia. Revoca las demás sesiones, mantiene la actual.
 * Queda en audit_logs (TRA-01).
 */
export async function changeUserPassword(args: {
  userId: string;
  currentTokenHash: string | null;
  raw: unknown;
}): Promise<{ changed: boolean }> {
  const parsed = changePasswordSchema.safeParse(args.raw);
  if (!parsed.success) throw new AuthError("VALIDATION", validationMessage(parsed.error), 400);
  const db = await adminDb();
  const { data: user, error } = await db
    .from("users")
    .select("id, password_hash, sede_id")
    .eq("id", args.userId)
    .maybeSingle();
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
  if (!user) throw new AuthError("UNAUTHENTICATED", "Se requiere autenticación.", 401);

  const matches = await verifyPassword(parsed.data.actual, (user as { password_hash: string }).password_hash);
  if (!matches) throw new AuthError("INVALID_CREDENTIALS", "La clave actual no es correcta.", 401);

  // CL-18: la clave nueva, la expulsión de las DEMÁS sesiones y el CAS sobre
  // el hash leído viajan en UNA sentencia del servidor (057,
  // `change_user_password`). El hash que se leyó arriba para verificar la clave
  // actual viaja como PRECONDICIÓN: la función lo compara contra la fila
  // bloqueada y, si otro escritor legítimo (un admin restableciendo, una
  // recuperación confirmada) escribió en el medio, aborta sin escribir nada.
  // Perder la carrera deja de ser un pisado silencioso y pasa a ser un error de
  // negocio que el usuario puede accionar.
  //
  // La post-condición —"ninguna otra sesión viva"— se comprueba ADENTRO de la
  // función, sobre la fila bloqueada: si no se cumple, la transacción entera se
  // revierte y la clave no cambia.
  const { error: changeError } = await db.rpc("change_user_password", {
    p_user_id: args.userId,
    p_password_hash: await hashPassword(parsed.data.nueva),
    p_current_token_hash: args.currentTokenHash,
    p_expected_password_hash: (user as { password_hash: string }).password_hash,
  });
  if (changeError) {
    // El CAS perdió: la clave cambió por debajo entre la lectura y la
    // escritura. Es un rechazo DE CONTRATO (P0001), no un 500: el usuario
    // reintenta con la clave que ahora tiene.
    if (esRechazoDeRpc(changeError, "PASSWORD_CHANGED_ELSEWHERE")) {
      throw new AuthError("PASSWORD_CHANGED_ELSEWHERE", PASSWORD_CHANGED_ELSEWHERE_ERROR, 409);
    }
    throw new AuthError("INTERNAL", "Error interno.", 500);
  }

  const changed = user as { id: string; sede_id: string | null };
  await writeAudit({
    sede_id: changed.sede_id,
    user_id: args.userId,
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entity: "users",
    entity_id: args.userId,
    metadata: {},
  });
  return { changed: true };
}

/**
 * AUTH-06: solicitud de recuperación. Respuesta genérica siempre
 * (no revela si el documento existe). Rate-limit T8: 5 solicitudes / 15 min
 * por documento (NFR-03). Sin mailer en T2: en no-producción
 * devuelve el token para pruebas manuales; en producción solo { requested }.
 */
export async function requestPasswordReset(
  raw: unknown,
  now: Date = new Date(),
): Promise<{ requested: boolean; devToken?: string }> {
  const parsed = requestResetSchema.safeParse(raw);
  if (!parsed.success) throw new AuthError("VALIDATION", validationMessage(parsed.error), 400);
  if (await isRateLimited(parsed.data.documento, RESET_BUDGET)) {
    throw new AuthError("RATE_LIMITED", "Demasiadas solicitudes. Intente más tarde.", 429);
  }
  await recordRateFailure(parsed.data.documento, RESET_BUDGET);
  const found = await findUserByDocument(parsed.data.documento);
  if (!found || !found.user.is_active) return { requested: true };

  const issued = createPasswordResetToken(now);
  const db = await adminDb();
  const { error } = await db.from("password_resets").insert({
    user_id: found.user.id,
    token_hash: issued.tokenHash,
    expires_at: issued.expiresAt.toISOString(),
  });
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);

  if (process.env.NODE_ENV === "production") return { requested: true };
  return { requested: true, devToken: issued.token };
}

/** AUTH-06: confirma con token de un solo uso y expiración corta. */
export async function confirmPasswordReset(
  raw: unknown,
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  const parsed = resetPasswordSchema.safeParse(raw);
  if (!parsed.success) throw new AuthError("VALIDATION", validationMessage(parsed.error), 400);
  const db = await adminDb();
  const tokenHash = hashToken(parsed.data.token);

  // Lectura de CORTESÍA: da el 400 sin tocar nada cuando el token ya no sirve.
  // La comprobación que MANDA es la de adentro de `confirm_password_reset`
  // (054), sobre la fila bloqueada: entre esta lectura y esa sentencia, otro
  // puede haber usado el token.
  const { data: reset, error } = await db
    .from("password_resets")
    .select("id, user_id, token_hash, expires_at, used")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new AuthError("INTERNAL", "Error interno.", 500);
  const row = reset as PasswordResetRow | null;
  if (
    !row ||
    !isResetTokenUsable({ used: row.used, expiresAt: new Date(row.expires_at), now })
  ) {
    throw new AuthError("RESET_TOKEN_INVALID", "Token inválido o vencido.", 400);
  }

  // CL-15: la marca de un solo uso (el CAS), la clave y la revocación de las
  // sesiones viajan en UNA sentencia del servidor (054). Antes eran tres
  // requests de PostgREST —tres transacciones— y un fallo entre la marca y la
  // clave dejaba el token QUEMADO con la clave SIN CAMBIAR: el enlace ya no
  // servía ("usado"), la clave vieja seguía siendo la válida y, sin otro camino
  // de recuperación en el MVP, la cuenta quedaba inaccesible PARA SIEMPRE. Es
  // el único hallazgo del barrido que era un callejón sin salida, y por eso la
  // marca y la clave son ahora indivisibles.
  const { error: resetError } = await db.rpc("confirm_password_reset", {
    p_token_hash: tokenHash,
    p_password_hash: await hashPassword(parsed.data.nueva),
    p_now: now.toISOString(),
  });
  if (resetError) {
    // Un token que se consumió (o venció) entre la lectura de arriba y la
    // sentencia: la función lo rechaza con el MISMO error que el usuario ya
    // conoce, y no escribió nada.
    if (esRechazoDeRpc(resetError, "RESET_TOKEN_INVALID")) {
      throw new AuthError("RESET_TOKEN_INVALID", "Token inválido o vencido.", 400);
    }
    throw new AuthError("INTERNAL", "Error interno.", 500);
  }
  return { changed: true };
}

type AdminDb = Awaited<ReturnType<typeof adminDb>>;

/**
 * CL-15: compensación del alta de usuario cuando el espejo en Supabase Auth
 * falla.
 *
 * El espejo es un sistema EXTERNO y no puede entrar en la transacción de
 * `create_user_with_role`, así que la única salida es deshacer lo escrito —y
 * hacerlo VERIFICADO y AUDIBLE—:
 *
 *   1. `discard_created_user` (054) borra el usuario dentro de su propia
 *      transacción, con red de conteo y red de seguridad: `users` y sus
 *      `user_roles` (ON DELETE CASCADE, 002) se van juntos.
 *   2. El llamador vuelve a LEER la tabla. La función ya verificó adentro, pero
 *      el rastro que se escribe unas líneas más abajo tiene que describir lo
 *      que el llamador pudo OBSERVAR, no lo que la función prometió: una
 *      compensación que contesta éxito sin haber borrado también tiene que ser
 *      audible.
 *   3. Si el borrado no se pudo hacer o no se pudo verificar, el residuo queda
 *      AUDITADO en `audit_logs` (más el error en consola). Un residuo silencioso
 *      es exactamente el defecto que esta unidad cierra: el alta falla, el
 *      usuario queda y nadie se entera.
 *
 * La fila de auditoría nombra el usuario que quedó, su correo y el motivo
 * estructurado: JAMÁS una clave, un hash ni un token.
 */
async function discardCreatedUser(
  db: AdminDb,
  args: { userId: string; sedeId: string | null; email: string; motivo: string },
): Promise<void> {
  let removido = false;
  try {
    const { error } = await db.rpc("discard_created_user", { p_user_id: args.userId });
    if (!error) {
      const { data: resto, error: readError } = await db
        .from("users")
        .select("id")
        .eq("id", args.userId)
        .maybeSingle();
      removido = !readError && !resto;
    }
  } catch {
    removido = false;
  }

  if (removido) return;

  await writeAudit({
    sede_id: args.sedeId,
    user_id: null,
    action: AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED,
    entity: "users",
    entity_id: args.userId,
    metadata: { email: args.email, motivo: args.motivo },
  });
  console.error(
    "[auth] el alta falló y su compensación también: quedó el usuario",
    args.userId,
    "para reparar a mano.",
  );
}

/**
 * AUTH-04/07: alta solo por admin. Clave inicial = documento con cambio
 * forzado (AUTH-01). Crea la fila en users + roles y la espeja en
 * Supabase Auth Admin con el email real (futura JWT/RLS; ver README).
 *
 * CL-15: el par `users` + `user_roles` viaja en UNA sentencia del servidor
 * (054, `create_user_with_role`). Antes eran dos requests de PostgREST y un
 * fallo entre ellos dejaba al usuario insertado sin sus roles; peor, la
 * compensación del espejo fallido borraba sin mirar el resultado de su propio
 * borrado. El espejo sigue afuera de la transacción —es otro sistema— y su
 * fallo ahora se compensa de forma VERIFICADA y AUDIBLE.
 */
export async function adminCreateUser(raw: unknown): Promise<{ id: string }> {
  const parsed = adminCreateUserSchema.safeParse(raw);
  if (!parsed.success) throw new AuthError("VALIDATION", validationMessage(parsed.error), 400);
  const input = parsed.data;
  const db = await adminDb();

  const { data: existingDoc } = await db
    .from("users")
    .select("id")
    .eq("id_number", input.documento)
    .maybeSingle();
  if (existingDoc) throw new AuthError("USER_EXISTS", "El documento ya está registrado.", 409);
  const { data: existingEmail } = await db
    .from("users")
    .select("id")
    .eq("email", input.email)
    .maybeSingle();
  if (existingEmail) throw new AuthError("USER_EXISTS", "El correo ya está registrado.", 409);

  const { data: roleRows, error: roleError } = await db
    .from("roles")
    .select("id, code")
    .in("code", input.roles);
  if (roleError) throw new AuthError("INTERNAL", "Error interno.", 500);
  const roleIds = ((roleRows ?? []) as Array<{ id: string; code: string }>).map((r) => r.id);
  if (roleIds.length !== input.roles.length) {
    throw new AuthError("VALIDATION", "Rol desconocido.", 400);
  }

  const { data: createdId, error: createError } = await db.rpc("create_user_with_role", {
    p_user: {
      sede_id: input.sede_id ?? null,
      email: input.email,
      phone: input.phone ?? null,
      id_type: input.id_type,
      id_number: input.documento,
      password_hash: await hashPassword(input.documento),
      full_name: input.full_name,
    },
    p_role_codes: input.roles,
  });
  if (createError) {
    // Un rol que no está en el catálogo conserva su error de negocio (el
    // pre-chequeo de arriba ya devolvía éste); una carrera de unicidad y todo
    // lo demás es un error interno, igual que hoy.
    if (esRechazoDeRpc(createError, "ROLE_NOT_FOUND")) {
      throw new AuthError("VALIDATION", "Rol desconocido.", 400);
    }
    throw new AuthError("INTERNAL", "Error interno.", 500);
  }
  if (typeof createdId !== "string" || createdId.length === 0) {
    throw new AuthError("INTERNAL", "Error interno.", 500);
  }
  const userId = createdId;

  // El espejo en Supabase Auth es OTRO sistema: no es una fila de esta base y
  // no puede entrar en la transacción de la línea de arriba. Un fallo acá se
  // compensa deshaciendo lo escrito, y si la compensación también falla el
  // residuo queda AUDITADO (ver `discardCreatedUser`).
  const { error: authError } = await db.auth.admin.createUser({
    email: input.email,
    password: input.documento,
    email_confirm: true,
    user_metadata: { id_number: input.documento, full_name: input.full_name },
  });
  if (authError) {
    await discardCreatedUser(db, {
      userId,
      sedeId: input.sede_id ?? null,
      email: input.email,
      // El motivo se guarda ESTRUCTURADO (código/estado del proveedor) y no como
      // el texto libre que devuelva el otro sistema: un mensaje ajeno no puede
      // terminar escribiendo en la auditoría algo que el usuario mandó.
      motivo: String(
        (authError as { code?: string; status?: number }).code ??
          (authError as { status?: number }).status ??
          "auth_error",
      ),
    });
    throw new AuthError("INTERNAL", "Error interno.", 500);
  }

  // Vínculo automático (best-effort, no rompe el alta): empleados sin
  // usuario con el mismo documento en la sede quedan vinculados.
  if (input.sede_id) {
    const { error: linkError } = await db
      .from("employees")
      .update({ user_id: userId })
      .eq("sede_id", input.sede_id)
      .eq("document", input.documento)
      .is("user_id", null);
    if (linkError) console.error("[auth] no se pudo vincular empleado:", linkError.message);
  }

  return { id: userId };
}

/**
 * AUTH-04: el admin restablece la clave de un usuario de su sede a su
 * documento (convención de clave inicial), con cambio forzado al entrar.
 * Desbloquea y limpia intentos. Queda auditado.
 */
export async function adminResetUserPassword(
  sedeId: string,
  userId: string,
  actorUserId: string,
): Promise<{ user_id: string }> {
  const db = await adminDb();
  const { data: target, error: targetError } = await db
    .from("users")
    .select("id, sede_id, id_number")
    .eq("id", userId)
    .maybeSingle();
  if (targetError) throw new AuthError("INTERNAL", "Error interno.", 500);
  if (!target) throw new AuthError("NOT_FOUND", "Usuario no encontrado.", 404);
  const row = target as { id: string; sede_id: string | null; id_number: string };
  if (row.sede_id !== sedeId) {
    throw new AuthError("FORBIDDEN", "Ese usuario no es de esta sede.", 403);
  }
  const { error: updateError } = await db
    .from("users")
    .update({
      password_hash: await hashPassword(row.id_number),
      must_change_password: true,
      failed_attempts: 0,
      locked_until: null,
    })
    .eq("id", row.id);
  if (updateError) throw new AuthError("INTERNAL", "Error interno.", 500);
  await writeAudit({
    sede_id: sedeId,
    user_id: actorUserId,
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entity: "users",
    entity_id: row.id,
    metadata: { reset_by_admin: true },
  });
  return { user_id: row.id };
}
