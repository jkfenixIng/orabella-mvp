import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LOCKED_ERROR,
  DocumentRateLimiter,
  GENERIC_LOGIN_ERROR,
  MAX_LOGIN_ATTEMPTS,
  SESSION_INACTIVITY_TIMEOUT_MS,
  adminCreateUser,
  changeUserPassword,
  checkSessionValidity,
  confirmPasswordReset,
  createPasswordResetToken,
  createSessionToken,
  getSessionUser,
  hashPassword,
  hashToken,
  isAccountLocked,
  isResetTokenUsable,
  nextFailedLoginState,
  verifyPassword,
} from "@/src/features/auth/service";
import {
  adminCreateUserSchema,
  changePasswordSchema,
  isRoleCode,
  loginSchema,
  requestResetSchema,
  resetPasswordSchema,
  sedeAssignableRoleSchema,
} from "@/src/features/auth/schemas";
import { requirePlatformAdmin } from "@/src/features/platform/service";
import { AUDIT_ACTIONS } from "@/src/shared/lib/audit";
import {
  main,
  provisionarSuperadmin,
  cargarEntornoDeProyecto,
  type CargadorDeEntorno,
} from "@/scripts/create-superadmin";

describe("auth schemas (Zod, sin red)", () => {
  it("login acepta documento+clave y recorta espacios", () => {
    const parsed = loginSchema.safeParse({ documento: "  123456  ", password: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.documento).toBe("123456");
  });

  it("login rechaza documento vacío", () => {
    expect(loginSchema.safeParse({ documento: "  ", password: "x" }).success).toBe(false);
  });

  it("changePassword exige política mínima (8+, letra y número)", () => {
    expect(
      changePasswordSchema.safeParse({ actual: "123456", nueva: "corta1" }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({ actual: "123456", nueva: "sin numeros" }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({ actual: "123456", nueva: "Clave123" }).success,
    ).toBe(true);
  });

  it("requestReset solo pide documento", () => {
    expect(requestResetSchema.safeParse({ documento: "123456" }).success).toBe(true);
    expect(requestResetSchema.safeParse({}).success).toBe(false);
  });

  it("resetPassword exige token y política de clave", () => {
    expect(resetPasswordSchema.safeParse({ token: "t", nueva: "Clave123" }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: "", nueva: "Clave123" }).success).toBe(false);
  });

  it("adminCreateUser exige correo real, documento, nombre y rol", () => {
    const base = {
      email: "caja@orabella.co",
      documento: "123456",
      id_type: "CC",
      full_name: "Caja Uno",
      roles: ["caja"],
    } as const;
    expect(adminCreateUserSchema.safeParse(base).success).toBe(true);
    expect(
      adminCreateUserSchema.safeParse({ ...base, email: "no-es-correo" }).success,
    ).toBe(false);
    expect(adminCreateUserSchema.safeParse({ ...base, roles: [] }).success).toBe(false);
    expect(adminCreateUserSchema.safeParse({ ...base, id_type: "XX" }).success).toBe(false);
  });

  it("G1: el vocabulario distingue el rol de plataforma del asignable desde sede", () => {
    // El catálogo completo conoce `superadmin`...
    expect(isRoleCode("superadmin")).toBe(true);
    expect(isRoleCode("admin")).toBe(true);
    expect(isRoleCode("dueño")).toBe(false);
    // ...pero el alta desde una sede NO lo acepta.
    expect(sedeAssignableRoleSchema.safeParse("superadmin").success).toBe(false);
    expect(sedeAssignableRoleSchema.safeParse("admin").success).toBe(true);
    const base = {
      email: "caja@orabella.co",
      documento: "123456",
      id_type: "CC",
      full_name: "Caja Uno",
      roles: ["superadmin"],
    } as const;
    expect(adminCreateUserSchema.safeParse(base).success).toBe(false);
  });
});

describe("rate-limit en memoria (5 intentos / 15 min por documento)", () => {
  it("permite 4 fallos y bloquea al 5.º", () => {
    const limiter = new DocumentRateLimiter();
    const now = Date.now();
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS - 1; i += 1) {
      expect(limiter.isBlocked("123", now)).toBe(false);
      limiter.recordFailure("123", now);
    }
    expect(limiter.isBlocked("123", now)).toBe(false);
    const outcome = limiter.recordFailure("123", now);
    expect(outcome.blocked).toBe(true);
    expect(limiter.isBlocked("123", now)).toBe(true);
  });

  it("la ventana expira: fallos viejos no cuentan", () => {
    const limiter = new DocumentRateLimiter(5, 15 * 60 * 1000);
    const start = 1_000_000;
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("123", start + i);
    expect(limiter.isBlocked("123", start + 10)).toBe(true);
    // 16 minutos después la ventana se vació.
    expect(limiter.isBlocked("123", start + 16 * 60 * 1000)).toBe(false);
  });

  it("el bloqueo es por documento (no contamina otros)", () => {
    const limiter = new DocumentRateLimiter();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("111", now);
    expect(limiter.isBlocked("111", now)).toBe(true);
    expect(limiter.isBlocked("222", now)).toBe(false);
  });

  it("reset() libera el documento tras login exitoso", () => {
    const limiter = new DocumentRateLimiter();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("123", now);
    limiter.reset("123");
    expect(limiter.isBlocked("123", now)).toBe(false);
  });
});

describe("bloqueo por intentos (locked_until)", () => {
  it("al 5.º fallo fija locked_until ~15 min", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const outcome = nextFailedLoginState(4, now);
    expect(outcome.failedAttempts).toBe(5);
    expect(outcome.locked).toBe(true);
    expect(outcome.lockedUntil?.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
    expect(isAccountLocked(outcome.lockedUntil, now)).toBe(true);
  });

  it("fallos previos no bloquean ni fijan locked_until", () => {
    const outcome = nextFailedLoginState(2, new Date());
    expect(outcome).toEqual({ failedAttempts: 3, lockedUntil: null, locked: false });
  });

  it("el bloqueo expira con el tiempo", () => {
    const lockedUntil = new Date("2026-09-18T10:15:00Z");
    expect(isAccountLocked(lockedUntil, new Date("2026-09-18T10:10:00Z"))).toBe(true);
    expect(isAccountLocked(lockedUntil, new Date("2026-09-18T10:16:00Z"))).toBe(false);
    expect(isAccountLocked(null, new Date())).toBe(false);
  });

  it("mensajes no enumeran usuarios", () => {
    expect(GENERIC_LOGIN_ERROR).not.toMatch(/existe|registrado/i);
    expect(ACCOUNT_LOCKED_ERROR).not.toMatch(/documento/i);
  });
});

describe("sesiones y recuperación (lógica pura)", () => {
  it("el token de sesión expira a 12 h y su hash es estable", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const issued = createSessionToken(now);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(12 * 60 * 60 * 1000);
    expect(hashToken(issued.token)).toBe(issued.tokenHash);
    expect(issued.token).toHaveLength(64);
  });

  it("checkSessionValidity distingue ok/expirada/revocada/inactiva", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const base = {
      revoked: false,
      expiresAt: new Date("2026-09-18T20:00:00Z"),
      lastActivityAt: new Date("2026-09-18T09:50:00Z"),
      now,
    };
    expect(checkSessionValidity(base)).toEqual({ valid: true, reason: "ok" });
    expect(checkSessionValidity({ ...base, revoked: true }).reason).toBe("revoked");
    expect(
      checkSessionValidity({ ...base, expiresAt: new Date("2026-09-18T09:00:00Z") }).reason,
    ).toBe("expired");
    expect(
      checkSessionValidity({
        ...base,
        lastActivityAt: new Date(now.getTime() - SESSION_INACTIVITY_TIMEOUT_MS - 1000),
      }).reason,
    ).toBe("inactive");
  });

  it("el token de reset expira a 30 min y es de un solo uso", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const issued = createPasswordResetToken(now);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(30 * 60 * 1000);
    expect(isResetTokenUsable({ used: false, expiresAt: issued.expiresAt, now })).toBe(true);
    expect(isResetTokenUsable({ used: true, expiresAt: issued.expiresAt, now })).toBe(false);
    expect(
      isResetTokenUsable({
        used: false,
        expiresAt: issued.expiresAt,
        now: new Date("2026-09-18T10:31:00Z"),
      }),
    ).toBe(false);
  });
});

describe("password_hash scrypt (sin red)", () => {
  it("hash redondo: verifica la clave y rechaza otra", async () => {
    const hash = await hashPassword("123456");
    await expect(verifyPassword("123456", hash)).resolves.toBe(true);
    await expect(verifyPassword("otra-clave", hash)).resolves.toBe(false);
  });

  it("sales distintas generan hashes distintos", async () => {
    const a = await hashPassword("Clave123");
    const b = await hashPassword("Clave123");
    expect(a).not.toBe(b);
  });

  it("hash malformado no verifica", async () => {
    await expect(verifyPassword("x", "no-es-un-hash")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CL-15: atomicidad de identidad y acceso (AUTH-02, AUTH-04, AUTH-06).
//
// Las operaciones de este módulo escribían SEGUIDO y sin transacción contra
// PostgREST, que no ofrece multi-statement por request (la misma nota que ya
// está escrita en 005, 039, 040, 041 y 046). El doble modela exactamente eso:
//
//   * cada `.from(tabla).insert()/update()/delete()` es un request propio, que
//     confirma por su cuenta: un fallo inyectado deja CONFIRMADAS las
//     escrituras anteriores (y el estado parcial es el defecto que se prueba);
//   * `rpc(nombre, args)` es UNA sentencia, y una sentencia corre ENTERA dentro
//     de una sola transacción del servidor: el doble calcula el estado nuevo y
//     lo confirma al final, así que un fallo inyectado adentro no toca ninguna
//     fila. Esa garantía es de PostgreSQL (BEGIN … COMMIT/ROLLBACK), no de este
//     doble: el doble sólo la imita.
//
// Lo que las pruebas fijan del CÓDIGO es la forma de la llamada (UNA sentencia
// por operación, cero escrituras sueltas) y la invariante observable: tras
// cualquier fallo, o no se escribió nada, o el residuo es AUDIBLE (auditado) y
// reparable por una persona.
// ---------------------------------------------------------------------------

const SEDE = "11111111-1111-4111-8111-111111111111";
const USUARIO = "55555555-5555-4555-8555-555555555555";
const CLAVE_VIEJA = "Vieja123";

const postgrest = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** Escrituras sueltas por `.from()`, en orden: "users.update", … */
  writes: [] as string[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /**
   * Fallo inyectable en una escritura puntual. Es el MISMO punto de fallo para
   * la implementación vieja (el request suelto) y para la nueva (la sentencia
   * de adentro del rpc): una sola prueba describe el mismo fallo en las dos.
   */
  failWrite: null as null | { label: string; error: { code: string; message: string } },
  /** Fallo inyectable dentro de un rpc: aborta la transacción ENTERA. */
  failRpc: null as null | { fn: string; error: { code: string; message: string } },
  /**
   * Intercalado de otro escritor: corre justo ANTES de la primera escritura,
   * es decir entre la lectura del servicio y su escritura —el punto exacto de
   * la ventana—. Se dispara tanto antes del request suelto de la implementación
   * vieja como antes del rpc de la nueva.
   */
  antesDeEscribir: null as null | (() => void),
  /** El rpc contesta éxito sin haber aplicado nada (control negativo). */
  rpcNoAplica: false,
  /** El espejo en Supabase Auth (sistema EXTERNO) falla. */
  authCreateUserError: null as null | { code?: string; status?: number; message: string },
  authCreados: [] as Array<Record<string, unknown>>,
  /** La compensación contesta éxito SIN haber borrado (control negativo). */
  compensacionMiente: false,
  /** Filas escritas en `audit_logs` (el rastro de lo que hay que reparar). */
  auditInserts: [] as Array<Record<string, unknown>>,
}));

function filasDe(tabla: string): Array<Record<string, unknown>> {
  return postgrest.rows[tabla] ?? [];
}

function p0001(mensaje: string): { code: string; message: string } {
  return { code: "P0001", message: mensaje };
}

/**
 * Cascada real de 002_auth.sql: `user_roles`, `sessions` y `password_resets`
 * referencian `users(id)` ON DELETE CASCADE, y `employees.user_id` es
 * ON DELETE SET NULL. El doble la modela porque la compensación del alta
 * depende de ella.
 */
function borrarUsuario(userId: string): void {
  postgrest.rows.user_roles = filasDe("user_roles").filter((fila) => fila.user_id !== userId);
  postgrest.rows.sessions = filasDe("sessions").filter((fila) => fila.user_id !== userId);
  postgrest.rows.password_resets = filasDe("password_resets").filter(
    (fila) => fila.user_id !== userId,
  );
  postgrest.rows.employees = filasDe("employees").map((fila) =>
    fila.user_id === userId ? { ...fila, user_id: null } : fila,
  );
  postgrest.rows.users = filasDe("users").filter((fila) => fila.id !== userId);
}

/** Modelo de `confirm_password_reset` (054): UNA sentencia, UNA transacción. */
function confirmResetAtomico(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const fila = filasDe("password_resets").find(
    (reset) => reset.token_hash === String(args.p_token_hash),
  );
  if (!fila) return { data: null, error: p0001("RESET_TOKEN_INVALID") };
  // La usabilidad se valida ADENTRO, bajo el lock: es lo que hace que el CAS
  // del token no pueda perderse.
  if (fila.used === true) return { data: null, error: p0001("RESET_TOKEN_INVALID") };
  if (
    new Date(String(fila.expires_at)).getTime() <= new Date(String(args.p_now)).getTime()
  ) {
    return { data: null, error: p0001("RESET_TOKEN_INVALID") };
  }
  if (!filasDe("users").some((usuario) => usuario.id === fila.user_id)) {
    return { data: null, error: p0001("USER_NOT_FOUND") };
  }
  if (postgrest.rpcNoAplica) return { data: true, error: null };
  // Fallo inyectado: la transacción se revierte ENTERA (ninguna fila se toca).
  const etiquetas = ["password_resets.update", "users.update", "sessions.update"];
  if (postgrest.failWrite && etiquetas.includes(postgrest.failWrite.label)) {
    return { data: null, error: postgrest.failWrite.error };
  }

  postgrest.rows.password_resets = filasDe("password_resets").map((reset) =>
    reset.id === fila.id ? { ...reset, used: true } : reset,
  );
  postgrest.rows.users = filasDe("users").map((usuario) =>
    usuario.id === fila.user_id
      ? {
          ...usuario,
          password_hash: args.p_password_hash,
          must_change_password: false,
          failed_attempts: 0,
          locked_until: null,
        }
      : usuario,
  );
  postgrest.rows.sessions = filasDe("sessions").map((sesion) =>
    sesion.user_id === fila.user_id ? { ...sesion, revoked: true } : sesion,
  );
  return { data: true, error: null };
}

/** Modelo de `change_user_password` (054 + CL-18/057): la clave y la revocación,
 * atómicas, y el CAS sobre el hash leído como precondición. */
function cambiarClaveAtomico(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const userId = String(args.p_user_id);
  if (!args.p_password_hash) return { data: null, error: p0001("PASSWORD_INVALID") };
  // CL-18: la precondición del CAS es obligatoria; sin ella la llamada no es la
  // de 057 y se rechaza (el modelo NUNCA aplica un cambio sin CAS).
  const esperado = args.p_expected_password_hash;
  if (!esperado) return { data: null, error: p0001("PASSWORD_INVALID") };
  if (!filasDe("users").some((usuario) => usuario.id === userId)) {
    return { data: null, error: p0001("USER_NOT_FOUND") };
  }
  const vigente = String(
    filasDe("users").find((usuario) => usuario.id === userId)?.password_hash ?? "",
  );
  if (vigente !== String(esperado)) {
    return { data: null, error: p0001("PASSWORD_CHANGED_ELSEWHERE") };
  }
  if (postgrest.rpcNoAplica) return { data: 0, error: null };
  if (
    postgrest.failWrite &&
    ["users.update", "sessions.update"].includes(postgrest.failWrite.label)
  ) {
    return { data: null, error: postgrest.failWrite.error };
  }

  const actual = args.p_current_token_hash ? String(args.p_current_token_hash) : null;
  const otras = filasDe("sessions").filter(
    (sesion) =>
      sesion.user_id === userId &&
      sesion.revoked === false &&
      (actual === null || sesion.token_hash !== actual),
  );
  postgrest.rows.users = filasDe("users").map((usuario) =>
    usuario.id === userId
      ? {
          ...usuario,
          password_hash: args.p_password_hash,
          must_change_password: false,
          failed_attempts: 0,
          locked_until: null,
        }
      : usuario,
  );
  postgrest.rows.sessions = filasDe("sessions").map((sesion) =>
    otras.some((otra) => otra.id === sesion.id) ? { ...sesion, revoked: true } : sesion,
  );
  return { data: otras.length, error: null };
}

/** Modelo de `create_user_with_role` (054): el par usuario+rol, atómico. */
function crearUsuarioConRolAtomico(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const usuario = (args.p_user ?? {}) as Record<string, unknown>;
  const codes = [...new Set((args.p_role_codes ?? []) as string[])];
  if (codes.length === 0) return { data: null, error: p0001("ROLE_NOT_FOUND") };
  const roles = filasDe("roles").filter((rol) => codes.includes(String(rol.code)));
  if (roles.length !== codes.length) return { data: null, error: p0001("ROLE_NOT_FOUND") };
  // Unicidad REAL de 002_auth.sql (`users.id_number` y `users.email`): el pase
  // de la carrera se reporta con el mismo contrato que hoy (error interno).
  if (filasDe("users").some((fila) => fila.id_number === usuario.id_number)) {
    return { data: null, error: p0001("USER_EXISTS") };
  }
  if (
    usuario.email &&
    filasDe("users").some((fila) => fila.email === usuario.email)
  ) {
    return { data: null, error: p0001("USER_EXISTS") };
  }
  if (postgrest.rpcNoAplica) return { data: null, error: null };
  if (
    postgrest.failWrite &&
    ["users.insert", "user_roles.insert"].includes(postgrest.failWrite.label)
  ) {
    return { data: null, error: postgrest.failWrite.error };
  }

  const userId = `usuario-generado-${filasDe("users").length + 1}`;
  // AUTH-01: la clave inicial es el documento y el cambio es obligatorio.
  postgrest.rows.users = [
    ...filasDe("users"),
    // `users.is_active` es NOT NULL DEFAULT true en 002_auth.sql: el doble
    // modela el default (si no, la columna queda ausente y miente).
    { is_active: true, ...usuario, id: userId, must_change_password: true },
  ];
  postgrest.rows.user_roles = [
    ...filasDe("user_roles"),
    ...roles.map((rol) => ({ user_id: userId, role_id: rol.id })),
  ];
  return { data: userId, error: null };
}

/** Modelo de `discard_created_user` (054): la compensación, verificada. */
function descartarUsuarioAtomico(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const userId = String(args.p_user_id);
  if (!userId || userId === "null") return { data: null, error: p0001("USER_NOT_FOUND") };
  if (postgrest.compensacionMiente) return { data: 1, error: null };
  if (!filasDe("users").some((fila) => fila.id === userId)) return { data: 0, error: null };
  if (postgrest.failWrite?.label === "users.delete") {
    return { data: null, error: postgrest.failWrite.error };
  }
  borrarUsuario(userId);
  return { data: 1, error: null };
}

/**
 * Modelo de `replace_user_roles` (039): el reemplazo ENTERO (borrar y escribir)
 * en una sentencia, y el conjunto APLICADO como retorno —el llamador contrasta
 * lo que pidió contra lo que la base dice que escribió—.
 */
function aplicarReemplazoDeRoles(args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  const userId = String(args.p_user_id);
  const codes = [...new Set((args.p_role_codes ?? []) as string[])];
  if (!filasDe("users").some((usuario) => usuario.id === userId)) {
    return { data: null, error: p0001("USER_NOT_FOUND") };
  }
  if (codes.length === 0) return { data: null, error: p0001("ROLE_NOT_FOUND") };
  const roles = filasDe("roles").filter((rol) => codes.includes(String(rol.code)));
  if (roles.length !== codes.length) return { data: null, error: p0001("ROLE_NOT_FOUND") };
  if (
    postgrest.failWrite &&
    ["user_roles.delete", "user_roles.insert"].includes(postgrest.failWrite.label)
  ) {
    return { data: null, error: postgrest.failWrite.error };
  }
  postgrest.rows.user_roles = [
    ...filasDe("user_roles").filter((fila) => fila.user_id !== userId),
    ...roles.map((rol) => ({ user_id: userId, role_id: rol.id })),
  ];
  return { data: roles.map((rol) => String(rol.code)).sort(), error: null };
}

function aplicarRpc(fn: string, args: Record<string, unknown>): {
  data: unknown;
  error: unknown;
} {
  postgrest.rpcCalls.push({ fn, args });
  if (postgrest.failRpc?.fn === fn) return { data: null, error: postgrest.failRpc.error };
  postgrest.antesDeEscribir?.();
  if (fn === "confirm_password_reset") return confirmResetAtomico(args);
  if (fn === "change_user_password") return cambiarClaveAtomico(args);
  if (fn === "create_user_with_role") return crearUsuarioConRolAtomico(args);
  if (fn === "replace_user_roles") return aplicarReemplazoDeRoles(args);
  if (fn === "discard_created_user") return descartarUsuarioAtomico(args);
  return {
    data: null,
    error: { code: "PGRST202", message: `no existe la función ${fn}` },
  };
}

type Filtro = { column: string; values: unknown[]; negate?: boolean };

function cumpleFiltros(fila: Record<string, unknown>, filtros: Filtro[]): boolean {
  return filtros.every((filtro) =>
    filtro.negate
      ? !filtro.values.includes(fila[filtro.column])
      : filtro.values.includes(fila[filtro.column]),
  );
}

function createStubClient() {
  const from = (table: string) => {
    const filtros: Filtro[] = [];
    let modo: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> = {};
    let ejecutado: { data: unknown; error: unknown } | null = null;

    const run = (): { data: unknown; error: unknown } => {
      if (ejecutado) return ejecutado;
      if (modo === "select") {
        ejecutado = {
          data: filasDe(table).filter((fila) => cumpleFiltros(fila, filtros)),
          error: null,
        };
        return ejecutado;
      }

      postgrest.writes.push(`${table}.${modo}`);
      postgrest.antesDeEscribir?.();
      if (postgrest.failWrite?.label === `${table}.${modo}`) {
        ejecutado = { data: null, error: postgrest.failWrite.error };
        return ejecutado;
      }

      if (modo === "insert") {
        const valores = (Array.isArray(payload) ? payload : [payload]) as Array<
          Record<string, unknown>
        >;
        if (table === "audit_logs") postgrest.auditInserts.push(valores[0]);
        if (table === "user_roles") {
          // FK real de 002_auth.sql: user_roles.user_id -> users.id.
          if (
            valores.some(
              (fila) => !filasDe("users").some((usuario) => usuario.id === fila.user_id),
            )
          ) {
            ejecutado = { data: null, error: { code: "23503", message: "viola la FK de users" } };
            return ejecutado;
          }
        }
        if (table === "users") {
          // Unicidad real de 002_auth.sql: `id_number` y `email`. El doble la
          // modela para poder probar la carrera del alta.
          const repetido = valores.some(
            (nueva) =>
              filasDe("users").some(
                (fila) =>
                  fila.id_number === nueva.id_number ||
                  (nueva.email !== null &&
                    nueva.email !== undefined &&
                    fila.email === nueva.email),
              ),
          );
          if (repetido) {
            ejecutado = {
              data: null,
              error: {
                code: "23505",
                message: 'duplicate key value violates unique constraint "users_id_number_key"',
              },
            };
            return ejecutado;
          }
          // `users.id` lo genera la base (gen_random_uuid): el doble lo inventa
          // para que el `select("id").single()` devuelva una identidad real.
          for (const [indice, nueva] of valores.entries()) {
            if (!nueva.id) {
              nueva.id = `usuario-generado-${filasDe("users").length + indice + 1}`;
            }
          }
        }
        if (table === "sedes") {
          // `sedes.id` también lo genera la base (003_admin.sql). El doble lo
          // inventa para que un alta de sede —la que ya no hace el script de
          // aprovisionamiento, pero sí el doble de otras rutas— devuelva una
          // identidad real.
          for (const [indice, nueva] of valores.entries()) {
            if (!nueva.id) nueva.id = `sede-generada-${filasDe("sedes").length + indice + 1}`;
          }
        }
        postgrest.rows[table] = [...filasDe(table), ...valores];
        ejecutado = { data: valores, error: null };
        return ejecutado;
      }

      if (modo === "update") {
        postgrest.rows[table] = filasDe(table).map((fila) =>
          cumpleFiltros(fila, filtros) ? { ...fila, ...payload } : fila,
        );
        ejecutado = { data: null, error: null };
        return ejecutado;
      }

      const aBorrar = filasDe(table).filter((fila) => cumpleFiltros(fila, filtros));
      if (table === "users") for (const fila of aBorrar) borrarUsuario(String(fila.id));
      else postgrest.rows[table] = filasDe(table).filter((fila) => !cumpleFiltros(fila, filtros));
      ejecutado = { data: null, error: null };
      return ejecutado;
    };

    const query: Record<string, unknown> = {
      select: () => query,
      insert: (values?: unknown) => {
        modo = "insert";
        // Puede ser un objeto (audit_logs, users) o un arreglo (user_roles).
        payload = values as Record<string, unknown>;
        return query;
      },
      update: (values?: unknown) => {
        modo = "update";
        payload = (values ?? {}) as Record<string, unknown>;
        return query;
      },
      delete: () => {
        modo = "delete";
        return query;
      },
      eq: (column: string, value: unknown) => {
        filtros.push({ column, values: [value] });
        return query;
      },
      neq: (column: string, value: unknown) => {
        filtros.push({ column, values: [value], negate: true });
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filtros.push({ column, values });
        return query;
      },
      is: (column: string, value: unknown) => {
        filtros.push({ column, values: [value ?? null] });
        return query;
      },
      or: () => query,
      order: () => query,
      limit: () => query,
      range: () => query,
      single: () => {
        const resultado = run();
        const primera = (resultado.data as Array<Record<string, unknown>> | null)?.[0] ?? null;
        return Promise.resolve({ data: primera, error: resultado.error });
      },
      maybeSingle: () => {
        const resultado = run();
        return Promise.resolve({
          data: (resultado.data as Array<Record<string, unknown>> | null)?.[0] ?? null,
          error: resultado.error,
        });
      },
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return query;
  };

  const rpc = (fn: string, args: Record<string, unknown>) =>
    Promise.resolve(aplicarRpc(fn, args));

  const auth = {
    admin: {
      createUser: (values: Record<string, unknown>) => {
        postgrest.authCreados.push(values);
        if (postgrest.authCreateUserError) {
          return Promise.resolve({ data: null, error: postgrest.authCreateUserError });
        }
        return Promise.resolve({ data: { user: { id: "auth-1" } }, error: null });
      },
    },
  };

  return { from, rpc, auth };
}

vi.mock("@/src/shared/lib/supabase/server", () => ({
  createAdminClient: () => createStubClient(),
}));

// ---------------------------------------------------- recuperación (AUTH-06) ---

describe("auth: confirmación de recuperación atómica (CL-15 / AUTH-06)", () => {
  const TOKEN = "token-de-recuperacion-en-claro";
  const RESET_ID = "77777777-7777-4777-8777-777777777777";
  const AHORA = new Date("2026-09-18T10:00:00Z");

  async function sembrar(args: { usada?: boolean; expira?: Date } = {}): Promise<void> {
    postgrest.rows = {};
    postgrest.rows.users = [
      {
        id: USUARIO,
        sede_id: SEDE,
        password_hash: await hashPassword(CLAVE_VIEJA),
        must_change_password: true,
        failed_attempts: 3,
        locked_until: new Date(AHORA.getTime() + 60_000).toISOString(),
        is_active: true,
      },
    ];
    postgrest.rows.password_resets = [
      {
        id: RESET_ID,
        user_id: USUARIO,
        token_hash: hashToken(TOKEN),
        expires_at: (args.expira ?? new Date(AHORA.getTime() + 10 * 60_000)).toISOString(),
        used: args.usada ?? false,
      },
    ];
    postgrest.rows.sessions = [
      { id: "s-1", user_id: USUARIO, token_hash: "hash-de-la-sesion-1", revoked: false },
      { id: "s-2", user_id: USUARIO, token_hash: "hash-de-la-sesion-2", revoked: false },
    ];
  }

  function quemado(): boolean {
    return filasDe("password_resets")[0]?.used === true;
  }

  function hashDeLaClave(): string {
    return String(filasDe("users")[0]?.password_hash ?? "");
  }

  function sesionesVivas(): string[] {
    return filasDe("sessions")
      .filter((sesion) => sesion.revoked === false)
      .map((sesion) => String(sesion.token_hash))
      .sort();
  }

  beforeEach(() => {
    postgrest.writes.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.failWrite = null;
    postgrest.failRpc = null;
    postgrest.antesDeEscribir = null;
    postgrest.rpcNoAplica = false;
    postgrest.authCreateUserError = null;
    postgrest.authCreados.length = 0;
    postgrest.compensacionMiente = false;
    postgrest.auditInserts.length = 0;
  });

  it("un fallo entre la marca y la clave NO quema el token: el enlace sigue sirviendo", async () => {
    await sembrar();
    postgrest.failWrite = {
      label: "users.update",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };

    await expect(
      confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA),
    ).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    // EL HALLAZGO, en sus tres caras a la vez: el token quemado, la clave
    // vieja viva y las sesiones intactas. Con el token quemado y la clave sin
    // cambiar, la persona NO puede recuperar la cuenta nunca más: el enlace ya
    // responde RESET_TOKEN_INVALID y no hay otro camino de recuperación en el
    // MVP. Es un callejón sin salida, no una degradación.
    expect
      .soft(
        quemado(),
        "el token quedó quemado: la clave vieja sigue viva y el enlace ya responde RESET_TOKEN_INVALID",
      )
      .toBe(false);
    expect.soft(await verifyPassword(CLAVE_VIEJA, hashDeLaClave())).toBe(true);
    expect.soft(sesionesVivas()).toEqual(["hash-de-la-sesion-1", "hash-de-la-sesion-2"]);

    // Y el MISMO enlace vuelve a servir: no hay callejón sin salida.
    postgrest.failWrite = null;
    await expect(
      confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA),
    ).resolves.toEqual({ changed: true });
    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(true);
    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(false);
    expect(sesionesVivas()).toEqual([]);
    expect(filasDe("users")[0]?.must_change_password).toBe(false);
    expect(filasDe("users")[0]?.locked_until).toBeNull();
  });

  it("la operación viaja en UNA sentencia: cero escrituras sueltas", async () => {
    await sembrar();

    await confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA);

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual([
      "confirm_password_reset",
    ]);
    expect(postgrest.writes).toEqual([]);
  });

  it("el token sigue siendo de UN solo uso: el segundo intento no cambia la clave", async () => {
    await sembrar();
    await confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA);

    await expect(
      confirmPasswordReset({ token: TOKEN, nueva: "Otra1234" }, AHORA),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID", status: 400 });

    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(true);
    await expect(verifyPassword("Otra1234", hashDeLaClave())).resolves.toBe(false);
  });

  it("otro escritor usa el token entre la lectura y la escritura: se rechaza sin escribir", async () => {
    await sembrar();
    postgrest.antesDeEscribir = () => {
      postgrest.rows.password_resets = filasDe("password_resets").map((fila) => ({
        ...fila,
        used: true,
      }));
    };

    await expect(
      confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID", status: 400 });

    // El token lo consumió el otro; la clave NO se tocó ni se revocó nada.
    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(true);
    expect(sesionesVivas()).toEqual(["hash-de-la-sesion-1", "hash-de-la-sesion-2"]);
  });

  it("token desconocido o vencido: RESET_TOKEN_INVALID sin escribir nada", async () => {
    await sembrar({ expira: new Date(AHORA.getTime() - 60_000) });

    await expect(
      confirmPasswordReset({ token: TOKEN, nueva: "Nueva123" }, AHORA),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID", status: 400 });
    await expect(
      confirmPasswordReset({ token: "otro-token", nueva: "Nueva123" }, AHORA),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID", status: 400 });

    expect(quemado()).toBe(false);
    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(true);
    expect(postgrest.writes).toEqual([]);
  });
});

// ------------------------------------------------------ cambio de clave (AUTH-02) ---

describe("auth: cambio de clave atómico (CL-15 / AUTH-02)", () => {
  const TOKEN_ACTUAL = "hash-de-la-sesion-actual";
  const TOKEN_AJENO = "hash-de-la-sesion-ajena";

  async function sembrar(): Promise<void> {
    postgrest.rows = {};
    postgrest.rows.users = [
      { id: USUARIO, sede_id: SEDE, password_hash: await hashPassword(CLAVE_VIEJA) },
    ];
    postgrest.rows.sessions = [
      { id: "s-actual", user_id: USUARIO, token_hash: TOKEN_ACTUAL, revoked: false },
      { id: "s-ajena", user_id: USUARIO, token_hash: TOKEN_AJENO, revoked: false },
      { id: "s-vieja", user_id: USUARIO, token_hash: "hash-ya-revocado", revoked: true },
    ];
  }

  function hashDeLaClave(): string {
    return String(filasDe("users")[0]?.password_hash ?? "");
  }

  function sesionesVivas(): string[] {
    return filasDe("sessions")
      .filter((sesion) => sesion.revoked === false)
      .map((sesion) => String(sesion.token_hash))
      .sort();
  }

  function cambiar(nueva: string): Promise<{ changed: boolean }> {
    return changeUserPassword({
      userId: USUARIO,
      currentTokenHash: TOKEN_ACTUAL,
      raw: { actual: CLAVE_VIEJA, nueva },
    });
  }

  beforeEach(() => {
    postgrest.writes.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.failWrite = null;
    postgrest.failRpc = null;
    postgrest.antesDeEscribir = null;
    postgrest.rpcNoAplica = false;
    postgrest.auditInserts.length = 0;
  });

  it("un fallo al revocar las OTRAS sesiones no deja la clave ya cambiada", async () => {
    await sembrar();
    postgrest.failWrite = {
      label: "sessions.update",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };

    await expect(cambiar("Nueva123")).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    // El hallazgo: la clave cambiada con la sesión ajena VIVA es lo contrario
    // del propósito del cambio. Sin escritura, la clave vieja sigue sirviendo.
    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(true);
    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(false);
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL, TOKEN_AJENO].sort());
  });

  it("el cambio exitoso se comporta igual que antes: clave nueva, la actual viva", async () => {
    await sembrar();

    await expect(cambiar("Nueva123")).resolves.toEqual({ changed: true });

    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(true);
    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(false);
    // La sesión actual sigue viva; la ajena se revoca (AUTH-02 intacto).
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL]);
    // Y queda el rastro auditado de siempre (TRA-01).
    expect(postgrest.auditInserts.map((fila) => fila.action)).toEqual([
      "auth.password_changed",
    ]);
    // Y el rastro sigue nombrando QUIÉN y sobre QUÉ, sin la sede que ya no se
    // envía: `user_id` y `entity_id` son los que hacen la traza ubicable.
    expect(postgrest.auditInserts[0]).toMatchObject({
      user_id: USUARIO,
      action: "auth.password_changed",
      entity: "users",
      entity_id: USUARIO,
      metadata: {},
    });
    expect(postgrest.auditInserts[0]).not.toHaveProperty("sede_id");
  });

  it("la operación viaja en UNA sentencia: cero escrituras sueltas", async () => {
    await sembrar();

    await cambiar("Nueva123");

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual([
      "change_user_password",
    ]);
    expect(postgrest.writes.filter((escritura) => escritura !== "audit_logs.insert")).toEqual(
      [],
    );
  });

  it("clave actual incorrecta: se rechaza sin escribir nada (política intacta)", async () => {
    await sembrar();

    await expect(
      changeUserPassword({
        userId: USUARIO,
        currentTokenHash: TOKEN_ACTUAL,
        raw: { actual: "NoEsLaClave1", nueva: "Nueva123" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });

    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(true);
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL, TOKEN_AJENO].sort());
    expect(postgrest.writes).toEqual([]);
  });

  it("un fallo del rpc no cambia la clave ni revoca nada (control negativo)", async () => {
    await sembrar();
    postgrest.failRpc = {
      fn: "change_user_password",
      error: { code: "42501", message: "permission denied for function change_user_password" },
    };

    await expect(cambiar("Nueva123")).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    await expect(verifyPassword(CLAVE_VIEJA, hashDeLaClave())).resolves.toBe(true);
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL, TOKEN_AJENO].sort());
  });

  it("una escritura ajena entre la lectura y el cambio NO se pisa en silencio (CL-18)", async () => {
    await sembrar();
    // La ventana declarada: el usuario ya verificó su clave contra el hash
    // leído, y ANTES de su escritura otro escritor legítimo (un admin) cambia
    // la fila. Sin CAS, la intervención del admin desaparece sin rastro.
    postgrest.antesDeEscribir = () => {
      postgrest.rows.users = filasDe("users").map((fila) => ({
        ...fila,
        password_hash: "hash-puesto-por-el-admin",
        must_change_password: true,
      }));
    };

    await expect(cambiar("Nueva123")).rejects.toMatchObject({
      code: "PASSWORD_CHANGED_ELSEWHERE",
      status: 409,
    });

    // El error es de negocio y accionable (nunca un 500 genérico), y la
    // escritura ajena sigue EN PIE: es lo que el usuario tiene que volver a
    // mirar antes de reintentar.
    expect(hashDeLaClave()).toBe("hash-puesto-por-el-admin");
    expect(filasDe("users")[0]?.must_change_password).toBe(true);
    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(false);
    // Nada se revocó: una carrera perdida no expulsa sesiones.
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL, TOKEN_AJENO].sort());
  });

  it("el CAS es de ESA fila: que otro usuario cambie no rechaza el cambio propio (control negativo)", async () => {
    await sembrar();
    postgrest.rows.users = [
      ...filasDe("users"),
      { id: "otro-usuario", sede_id: SEDE, password_hash: "hash-de-otro" },
    ];
    postgrest.antesDeEscribir = () => {
      postgrest.rows.users = filasDe("users").map((fila) =>
        fila.id === "otro-usuario" ? { ...fila, password_hash: "hash-de-otro-nuevo" } : fila,
      );
    };

    await expect(cambiar("Nueva123")).resolves.toEqual({ changed: true });

    await expect(verifyPassword("Nueva123", hashDeLaClave())).resolves.toBe(true);
    expect(sesionesVivas()).toEqual([TOKEN_ACTUAL]);
  });

  it("el cambio exitoso sigue igual y deja como base el hash que leyó", async () => {
    await sembrar();
    const base = hashDeLaClave();

    await expect(cambiar("Nueva123")).resolves.toEqual({ changed: true });

    // La precondición del CAS viaja como el hash que el servicio LEYÓ para
    // verificar la clave actual: la comparación en tiempo constante sigue
    // siendo sobre el mismo valor que la base tiene que encontrar.
    const llamada = postgrest.rpcCalls.find((entry) => entry.fn === "change_user_password");
    expect(llamada?.args.p_expected_password_hash).toBe(base);
  });
});

// ------------------------------------------------ alta de usuario (AUTH-04/07) ---

describe("auth: alta de usuario atómica (CL-15 / AUTH-04)", () => {
  const ALTA = {
    email: "nueva@orabella.co",
    documento: "998877",
    id_type: "CC" as const,
    full_name: "Nueva Persona",
    roles: ["caja"] as const,
    sede_id: SEDE,
  };

  function sembrar(): void {
    postgrest.rows = {};
    postgrest.rows.users = [];
    postgrest.rows.roles = [
      { id: "rol-admin", code: "admin" },
      { id: "rol-empleado", code: "empleado" },
      { id: "rol-caja", code: "caja" },
    ];
    postgrest.rows.user_roles = [];
    postgrest.rows.employees = [];
  }

  function usuarios(): Array<Record<string, unknown>> {
    return filasDe("users");
  }

  /** El rastro que hace AUDIBLE una compensación fallida. */
  function rastroDeCompensacion(): Array<Record<string, unknown>> {
    return postgrest.auditInserts.filter(
      (fila) => fila.action === "auth.user_create_rollback_failed",
    );
  }

  function escriturasSueltas(): string[] {
    return postgrest.writes.filter(
      (escritura) =>
        !escritura.startsWith("audit_logs.") && !escritura.startsWith("employees."),
    );
  }

  beforeEach(() => {
    postgrest.writes.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.failWrite = null;
    postgrest.failRpc = null;
    postgrest.antesDeEscribir = null;
    postgrest.rpcNoAplica = false;
    postgrest.authCreateUserError = null;
    postgrest.authCreados.length = 0;
    postgrest.compensacionMiente = false;
    postgrest.auditInserts.length = 0;
  });

  it("un espejo fallido con compensación fallida deja un residuo AUDITABLE", async () => {
    sembrar();
    postgrest.authCreateUserError = {
      code: "email_exists",
      message: "email address already registered",
    };
    postgrest.failRpc = {
      fn: "discard_created_user",
      error: { code: "42501", message: "permission denied for function discard_created_user" },
    };
    postgrest.failWrite = {
      label: "users.delete",
      error: { code: "42501", message: "permission denied for table users" },
    };

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    // El residuo EXISTE (nadie pudo borrarlo): el usuario quedó con su rol. Por
    // eso mismo tiene que quedar el rastro que un humano repara —el residuo
    // silencioso es el defecto.
    expect(usuarios()).toHaveLength(1);
    expect(filasDe("user_roles")).toHaveLength(1);
    const rastro = rastroDeCompensacion();
    expect(rastro, "la compensación fallida tiene que ser audible").toHaveLength(1);
    // El rastro NOMBRA el usuario que quedó y POR QUÉ: es lo que convierte el
    // residuo en trabajo de reparación.
    expect(rastro[0]).toMatchObject({
      user_id: null,
      entity: "users",
      entity_id: usuarios()[0].id,
      metadata: { email: ALTA.email, motivo: "email_exists" },
    });
    // El rastro ya no lleva la sede de la instalación: el usuario huérfano se
    // ubica por `entity`/`entity_id`, no por un tenant que ya no se envía.
    expect(rastro[0]).not.toHaveProperty("sede_id");
    // Y jamás un secreto: la clave inicial ES el documento del alta.
    expect(JSON.stringify(rastro[0])).not.toContain(ALTA.documento);
    // El rastro usa la acción del VOCABULARIO COMPARTIDO: es lo que hace que la
    // bandeja (y su filtro) puedan verlo, en vez de una cadena local paralela.
    expect(rastro[0].action).toBe(AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED);
  });

  it("la compensación que MIENTE (dice que borró y no borró) también es audible", async () => {
    sembrar();
    postgrest.authCreateUserError = { message: "email address already registered" };
    postgrest.compensacionMiente = true;

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    // El rpc contestó sin error, pero la fila sigue ahí: la verificación del
    // llamador es la que convierte el silencio en rastro.
    expect(usuarios()).toHaveLength(1);
    expect(rastroDeCompensacion()).toHaveLength(1);
    expect(rastroDeCompensacion()[0].action).toBe(AUDIT_ACTIONS.USER_CREATE_ROLLBACK_FAILED);
  });

  it("un espejo fallido con compensación exitosa no deja NADA (ni un rastro falso)", async () => {
    sembrar();
    postgrest.authCreateUserError = { message: "email address already registered" };

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    expect(usuarios()).toEqual([]);
    // La cascada real de 002_auth.sql se lleva los roles con el usuario.
    expect(filasDe("user_roles")).toEqual([]);
    expect(rastroDeCompensacion()).toEqual([]);
  });

  it("un fallo de la escritura de roles no deja el usuario huérfano", async () => {
    sembrar();
    postgrest.failWrite = {
      label: "user_roles.insert",
      error: { code: "42501", message: "permission denied for table user_roles" },
    };

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    expect(usuarios()).toEqual([]);
    expect(filasDe("user_roles")).toEqual([]);
  });

  it("el alta exitosa se comporta igual que antes: usuario + rol, y devuelve su id", async () => {
    sembrar();

    const creado = await adminCreateUser(ALTA);

    expect(creado.id).toBe(usuarios()[0]?.id);
    expect(usuarios()).toHaveLength(1);
    expect(usuarios()[0]).toMatchObject({
      email: ALTA.email,
      id_number: ALTA.documento,
      full_name: ALTA.full_name,
      must_change_password: true,
    });
    expect(filasDe("user_roles")).toHaveLength(1);
    // El espejo en Supabase Auth sigue recibiéndose con los MISMOS datos.
    expect(postgrest.authCreados).toEqual([
      {
        email: ALTA.email,
        password: ALTA.documento,
        email_confirm: true,
        user_metadata: { id_number: ALTA.documento, full_name: ALTA.full_name },
      },
    ]);
  });

  it("el par usuario+rol viaja en UNA sentencia: cero escrituras sueltas", async () => {
    sembrar();

    await adminCreateUser(ALTA);

    expect(postgrest.rpcCalls.map((llamada) => llamada.fn)).toEqual(["create_user_with_role"]);
    expect(escriturasSueltas()).toEqual([]);
  });

  it("documento repetido por carrera: la unicidad de users se conserva", async () => {
    sembrar();
    postgrest.antesDeEscribir = () => {
      postgrest.rows.users = [
        { id: "otro", id_number: ALTA.documento, email: "otro@orabella.co" },
      ];
    };

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({ code: "INTERNAL", status: 500 });

    expect(usuarios()).toHaveLength(1); // el de la carrera, no el nuestro
    expect(filasDe("user_roles")).toEqual([]);
  });

  it("rol desconocido: VALIDATION sin escribir nada (contrato intacto)", async () => {
    sembrar();
    postgrest.rows.roles = filasDe("roles").filter((rol) => rol.code !== "caja");

    await expect(adminCreateUser(ALTA)).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
    });

    expect(usuarios()).toEqual([]);
    expect(postgrest.writes).toEqual([]);
  });
});

// ------------------------------------------------------------- migración 054 ---

describe("migración 054_identity_atomic.sql (CL-15)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "054_identity_atomic.sql"),
    "utf8",
  );

  it("crea las funciones que el servicio llama por rpc", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.confirm_password_reset");
    expect(sql).toContain("p_token_hash text, p_password_hash text, p_now timestamptz");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.change_user_password");
    expect(sql).toContain("p_user_id uuid, p_password_hash text, p_current_token_hash text");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_user_with_role");
    expect(sql).toContain("p_user jsonb, p_role_codes text[]");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.discard_created_user");
  });

  it("la recuperación valida y marca el token DENTRO de la transacción", () => {
    expect(sql).toContain("FROM public.password_resets");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("RAISE EXCEPTION 'RESET_TOKEN_INVALID'");
    expect(sql).toContain("GET DIAGNOSTICS v_filas = ROW_COUNT");
    // El CAS del token sigue siendo la escritura, con su red de conteo.
    expect(sql).toContain("UPDATE public.password_resets");
    expect(sql).toContain("AND used = false");
  });

  it("el cambio de clave actualiza y revoca en la MISMA sentencia, y verifica el resultado", () => {
    expect(sql).toContain("UPDATE public.users");
    expect(sql).toContain("UPDATE public.sessions");
    expect(sql).toContain("AND revoked = false");
    expect(sql).toContain("SESSIONS_NOT_REVOKED");
  });

  it("el alta crea usuario y rol juntos, y la compensación verifica el borrado", () => {
    expect(sql).toContain("INSERT INTO public.users");
    expect(sql).toContain("INSERT INTO public.user_roles");
    expect(sql).toContain("RAISE EXCEPTION 'ROLE_NOT_FOUND'");
    expect(sql).toContain("EXCEPTION WHEN unique_violation");
    expect(sql).toContain("DELETE FROM public.users");
    // La verificación del borrado: no alcanza con emitir el DELETE.
    expect(sql).toContain("FROM public.user_roles");
  });

  it("no borra ni reescribe filas de datos existentes", () => {
    // Se miran SENTENCIAS (ancladas al inicio de línea), no la prosa del
    // encabezado, que justamente explica qué no hace el archivo.
    expect(sql).not.toMatch(/^\s*DELETE FROM public\.(roles|user_roles|sessions)\b/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).not.toMatch(/^\s*DROP/im);
  });

  it("es idempotente, con search_path fijo y sin DEFINER", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
  });

  it("cierra el permiso: sólo service_role puede ejecutarlas", () => {
    for (const firma of [
      "public.confirm_password_reset(text, text, timestamptz)",
      "public.change_user_password(uuid, text, text)",
      "public.create_user_with_role(jsonb, text[])",
      "public.discard_created_user(uuid)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${firma} TO service_role`);
    }
  });

  it("declara que el agente no la ejecutó", () => {
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

// ----------------------------------------------------- migración 057 (CL-18) ---

describe("migración 057_identity_password_cas.sql (CL-18)", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase", "schema-history", "057_identity_password_cas.sql"),
    "utf8",
  );

  it("reemplaza la firma vieja por la de cuatro parámetros (el CAS es obligatorio)", () => {
    // Sin el DROP, `CREATE OR REPLACE` dejaría viva la versión sin CAS y
    // cualquiera podría llamarla para saltarse la precondición.
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.change_user_password(uuid, text, text)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.change_user_password");
    expect(sql).toContain(
      "p_user_id uuid,\n  p_password_hash text,\n  p_current_token_hash text,\n  p_expected_password_hash text",
    );
  });

  it("compara el hash bajo el candado y aborta con el código propio de la carrera", () => {
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("IS DISTINCT FROM p_expected_password_hash");
    expect(sql).toContain("RAISE EXCEPTION 'PASSWORD_CHANGED_ELSEWHERE'");
    // La clave no se escribe si el CAS no pasó: el UPDATE exige el mismo hash.
    expect(sql).toContain("AND password_hash = p_expected_password_hash");
    expect(sql).toContain("GET DIAGNOSTICS v_filas = ROW_COUNT");
  });

  it("conserva la post-condición de 054: ninguna otra sesión viva", () => {
    expect(sql).toContain("UPDATE public.sessions");
    expect(sql).toContain("AND revoked = false");
    expect(sql).toContain("SESSIONS_NOT_REVOKED");
  });

  it("es idempotente, con search_path fijo y sin DEFINER", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
  });

  it("cierra el permiso de la firma nueva: sólo service_role puede ejecutarla", () => {
    const firma = "public.change_user_password(uuid, text, text, text)";
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM anon`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${firma} FROM authenticated`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${firma} TO service_role`);
  });

  it("no borra ni reescribe filas de datos existentes", () => {
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect(sql).not.toMatch(/^\s*TRUNCATE/im);
    expect(sql).not.toMatch(/^\s*ALTER\s+TABLE/im);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|DATABASE)/im);
  });

  it("declara que el agente no la ejecutó", () => {
    expect(sql).toContain("NO ejecutado por el agente: requiere base de datos");
  });
});

/* --------------------------------------------------------------------------
   G1: la SESIÓN REAL transporta el rol de plataforma.

   Este bloque NO mockea `getSessionUser`: ejercita el camino real contra el
   doble de PostgREST de este archivo. Es la prueba que faltaba para no dar por
   cubierta la guarda con una sesión simulada: si el filtro de roles de la
   sesión descarta `superadmin`, `getSessionUser` lo pierde y la guarda nunca
   pasa, aunque el resto del mundo devuelva verde.
   -------------------------------------------------------------------------- */

describe("auth: la sesión real lleva el rol de plataforma hasta la guarda (G1)", () => {
  const SESION_ID = "88888888-8888-4888-8888-888888888888";
  const TOKEN = "token-de-sesion-de-plataforma";

  /**
   * `roles(code)` es el embed que resuelve PostgREST: el doble devuelve la fila
   * con el objeto embebido, que es exactamente lo que `getSessionUser` lee.
   */
  function sembrarSesion(roles: string[]): void {
    postgrest.rows = {};
    postgrest.rows.users = [
      { id: USUARIO, sede_id: SEDE, full_name: "Dueño", is_active: true },
    ];
    postgrest.rows.sessions = [
      {
        id: SESION_ID,
        user_id: USUARIO,
        token_hash: hashToken(TOKEN),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        revoked: false,
        last_activity_at: new Date().toISOString(),
      },
    ];
    postgrest.rows.user_roles = roles.map((code) => ({
      user_id: USUARIO,
      role_id: `rol-${code}`,
      roles: { code },
    }));
  }

  beforeEach(() => {
    postgrest.rows = {};
  });

  it("getSessionUser conserva `superadmin`: el filtro de la sesión ya no lo descarta", async () => {
    sembrarSesion(["superadmin"]);

    const session = await getSessionUser(TOKEN);

    expect(session?.roles).toEqual(["superadmin"]);
  });

  it("una sesión con `superadmin` LLEGA a la guarda; sin él, no pasa", async () => {
    sembrarSesion(["superadmin"]);
    const actor = await requirePlatformAdmin(TOKEN);
    expect(actor).toMatchObject({ userId: USUARIO, roles: ["superadmin"] });

    sembrarSesion(["admin"]);
    await expect(requirePlatformAdmin(TOKEN)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("sin sesión: UNAUTHENTICATED (401)", async () => {
    postgrest.rows = {};
    await expect(requirePlatformAdmin(null)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });
});

// -------------------------------------- cuenta de plataforma (G2) ---

/**
 * G2: la cuenta de plataforma se aprovisiona desde el ENTORNO, nunca desde el
 * repositorio. Dos cosas se fijan acá y no en otro lado:
 *
 *   1. PARIDAD DEL HASH. El script no puede tener su propio scrypt: si lo
 *      tuviera, el hash guardado compilaría y el login lo rechazaría sin que
 *      nada fallara antes. Por eso la prueba verifica el hash que el script
 *      escribió con `verifyPassword`, la MISMA función del login, y además
 *      comprueba que verifica la clave correcta y NO otra (control negativo).
 *   2. AUSENCIA DE CLAVE POR DEFECTO. Sin `SUPERADMIN_PASSWORD` el script se
 *      niega y no escribe NADA. El respaldo silencioso es el defecto clásico:
 *      termina siendo la clave de producción.
 *   3. LA SEDE DE LA INSTALACIÓN. La instalación es de UNA SOLA SEDE, así que la
 *      cuenta se ancla a LA SEDE DEL NEGOCIO y el script no crea ninguna fila de
 *      `sedes`. Se fija que no escriba en esa tabla, que no le importe una fila
 *      inactiva que no es la instalación, y que los dos estados imposibles (ninguna
 *      sede activa, dos o más) se rechacen ANTES de tocar la cuenta y sin elegir una
 *      al azar.
 *
 * Las claves de esta suite son FICTICIAS a propósito: así como la clave real no
 * vive en el repositorio, tampoco vive en una prueba.
 */
describe("G2: cuenta de plataforma `superadmin` desde variables de entorno", () => {
  const CLAVE_FICTICIA = "clave-ficticia-de-prueba";
  const OTRA_CLAVE_FICTICIA = "otra-clave-ficticia-de-prueba";
  /** Credencial FICTICIA: nada con pinta de real, tampoco en una prueba. */
  const CLAVE_DE_SERVICIO_FICTICIA = "credencial-ficticia-de-prueba";
  /** Cargador sin archivos: las pruebas de `main()` no tocan el disco. */
  const SIN_ARCHIVOS: CargadorDeEntorno = () => ({ loadedEnvFiles: [] });
  /** Lo que había en el entorno antes de que una prueba escribiera la ficticia. */
  const CLAVE_DE_SERVICIO_PREVIA = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const EXIT_CODE_INICIAL = process.exitCode;

  /**
   * Fila que NO es la instalación: la que esta capa creó antes de la decisión de
   * una sola sede. Inactiva, y con su nombre propio: el script tiene que resolver
   * la instalación por DATO (`is_active`), nunca por el nombre de la fila.
   */
  const SEDE_VIEJA_DE_PLATAFORMA = "00000000-0000-4000-8000-000000000001";
  const NOMBRE_SEDE_VIEJA = "Plataforma (sistema)";

  function sembrar(): void {
    postgrest.rows = {};
    // La instalación es de UNA sede, ya existente: el script NO la crea.
    postgrest.rows.sedes = [{ id: SEDE, name: "Sede principal", is_active: true }];
    postgrest.rows.roles = [{ id: "rol-superadmin", code: "superadmin" }];
    postgrest.rows.users = [];
    postgrest.rows.user_roles = [];
  }

  function cuenta(): Record<string, unknown> | undefined {
    return filasDe("users").find((fila) => fila.id_number === "superadmin");
  }

  /** Filas de `sedes` tal como quedaron: el script no debe escribir ninguna. */
  function filasDeSedes(): Array<Record<string, unknown>> {
    return filasDe("sedes");
  }

  function rolesDeLaCuenta(): Array<Record<string, unknown>> {
    const usuario = cuenta();
    return filasDe("user_roles").filter((fila) => fila.user_id === usuario?.id);
  }

  function hashGuardado(): string {
    return String(cuenta()?.password_hash ?? "");
  }

  /** Captura lo que imprime el CLI sin ensuciar la salida de la suite. */
  function capturarSalida(): {
    lineas: string[];
    errores: string[];
    avisos: string[];
    restaurar: () => void;
  } {
    const lineas: string[] = [];
    const errores: string[] = [];
    const avisos: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lineas.push(args.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errores.push(args.map(String).join(" "));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      avisos.push(args.map(String).join(" "));
    });
    return {
      lineas,
      errores,
      avisos,
      restaurar: () => {
        log.mockRestore();
        error.mockRestore();
        warn.mockRestore();
      },
    };
  }

  beforeEach(() => {
    postgrest.writes.length = 0;
    postgrest.rpcCalls.length = 0;
    postgrest.failWrite = null;
    postgrest.failRpc = null;
    postgrest.rpcNoAplica = false;
    postgrest.antesDeEscribir = null;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    // El cargador falso escribe una credencial ficticia en el entorno: se
    // restaura lo que había para no dejarla pegada al resto de la suite.
    if (CLAVE_DE_SERVICIO_PREVIA === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = CLAVE_DE_SERVICIO_PREVIA;
    // `main()` marca `process.exitCode`: la suite no puede terminar con el
    // código de un script que se negó a correr.
    process.exitCode = EXIT_CODE_INICIAL;
    vi.unstubAllEnvs();
  });

  it("carga los archivos de entorno del proyecto, y el entorno del proceso GANA sobre el archivo", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://desde-el-proceso.supabase.co");
    let dirRecibido = "";
    const cargador: CargadorDeEntorno = (dir) => {
      dirRecibido = dir;
      // El archivo PISA todo lo que traiga, incluso lo que ya estaba en el
      // entorno: así la precedencia la tiene que garantizar el script, no el
      // cargador.
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://desde-el-archivo.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = CLAVE_DE_SERVICIO_FICTICIA;
      return { loadedEnvFiles: [{ path: ".env.local" }, { path: ".env" }] };
    };

    const archivos = cargarEntornoDeProyecto("/proyecto", cargador);

    expect(dirRecibido).toBe("/proyecto");
    expect(archivos).toEqual([".env.local", ".env"]);
    // Lo que ya estaba en el entorno del proceso sigue mandando...
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://desde-el-proceso.supabase.co");
    // ...y lo que sólo venía del archivo queda cargado.
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe(CLAVE_DE_SERVICIO_FICTICIA);
  });

  it("dice de dónde salieron las credenciales: imprime los archivos cargados y ningún valor", async () => {
    sembrar();
    vi.stubEnv("SUPERADMIN_PASSWORD", CLAVE_FICTICIA);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto-de-prueba.supabase.co");
    const salida = capturarSalida();
    const cargador: CargadorDeEntorno = () => ({
      loadedEnvFiles: [{ path: ".env.local" }, { path: ".env" }],
    });

    await main(cargador);

    expect(process.exitCode).toBeFalsy();
    const todo = [...salida.lineas, ...salida.avisos, ...salida.errores].join("\n");
    expect(todo).toContain("archivos cargados: .env.local, .env");
    // Solo NOMBRES de archivo: ningún valor sale por la salida del script.
    expect(todo).not.toContain(CLAVE_FICTICIA);
    salida.restaurar();
  });

  it("sin archivos de entorno ni variables de Supabase, el aviso de credenciales faltantes sigue saliendo", async () => {
    sembrar();
    vi.stubEnv("SUPERADMIN_PASSWORD", CLAVE_FICTICIA);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    const salida = capturarSalida();

    await main(SIN_ARCHIVOS);

    expect(process.exitCode).toBe(1);
    // Dijo de dónde salieron (o no) las credenciales...
    expect(salida.lineas.join("\n")).toContain("no se encontraron archivos de entorno");
    // ...y el aviso de siempre sigue saliendo, antes de tocar la base.
    expect(salida.errores.join("\n")).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(postgrest.rpcCalls).toEqual([]);
    expect(postgrest.writes).toEqual([]);
    salida.restaurar();
  });

  it("se ancla a la sede activa de la INSTALACIÓN y el hash que escribe VERIFICA con `verifyPassword`", async () => {
    sembrar();

    const resultado = await provisionarSuperadmin({ clave: CLAVE_FICTICIA });

    // La instalación es la sede activa que YA existe: el script la usa tal cual.
    expect(resultado.sede).toMatchObject({ id: SEDE, name: "Sede principal" });
    // Y NO escribe en `sedes`: ni la crea, ni la activa, ni la desactiva.
    expect(postgrest.writes.filter((escritura) => escritura.startsWith("sedes."))).toEqual([]);
    expect(filasDeSedes()).toHaveLength(1);
    // La cuenta queda anclada a ESA sede.
    expect(cuenta()?.sede_id).toBe(SEDE);

    const hash = hashGuardado();
    expect(resultado.accion).toBe("creada");
    // El formato es el de la casa (`scrypt$v1$<sal>$<hash>`): el script no
    // inventa otro esquema de hash.
    expect(hash.startsWith("scrypt$v1$")).toBe(true);
    expect(hash).not.toContain(CLAVE_FICTICIA);
    // LA PRUEBA QUE IMPIDE LA DIVERGENCIA SILENCIOSA: el hash lo verifica la
    // función del LOGIN, no una copia del script.
    await expect(verifyPassword(CLAVE_FICTICIA, hash)).resolves.toBe(true);
    await expect(verifyPassword(OTRA_CLAVE_FICTICIA, hash)).resolves.toBe(false);
    // Y la credencial del entorno es la que sirve para entrar: sin cambio
    // forzado y sin bloqueo.
    expect(cuenta()).toMatchObject({
      id_number: "superadmin",
      id_type: "otro",
      must_change_password: false,
      failed_attempts: 0,
      locked_until: null,
    });
  });

  it("sin `SUPERADMIN_PASSWORD` se niega a correr y no escribe nada", async () => {
    sembrar();
    vi.stubEnv("SUPERADMIN_PASSWORD", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto-de-prueba.supabase.co");
    const salida = capturarSalida();

    await main(SIN_ARCHIVOS);

    expect(process.exitCode).toBe(1);
    // La clave se valida ANTES de tocar la base: ninguna lectura ni escritura.
    expect(postgrest.rpcCalls).toEqual([]);
    expect(postgrest.writes).toEqual([]);
    expect(cuenta()).toBeUndefined();
    expect(salida.errores.join("\n")).toContain("SUPERADMIN_PASSWORD");
    salida.restaurar();
  });

  it("con la clave vacía tampoco escribe: vacío no es una clave", async () => {
    sembrar();
    vi.stubEnv("SUPERADMIN_PASSWORD", "   ");
    const salida = capturarSalida();

    await main(SIN_ARCHIVOS);

    expect(process.exitCode).toBe(1);
    expect(postgrest.rpcCalls).toEqual([]);
    expect(cuenta()).toBeUndefined();
    salida.restaurar();
  });

  it("la segunda corrida no crea otra cuenta y no duplica el rol", async () => {
    sembrar();

    const primera = await provisionarSuperadmin({ clave: CLAVE_FICTICIA });
    const segunda = await provisionarSuperadmin({ clave: OTRA_CLAVE_FICTICIA });

    expect(primera.accion).toBe("creada");
    expect(segunda.accion).toBe("actualizada");
    // La misma sede de instalación en las dos corridas: no se elige otra.
    expect(segunda.sede.id).toBe(primera.sede.id);
    // Y `sedes` sigue como estaba: el aprovisionamiento no escribe en esa tabla.
    expect(filasDeSedes()).toHaveLength(1);
    expect(filasDeSedes()[0]).toMatchObject({ id: SEDE, is_active: true });
    // UNA cuenta con el documento `superadmin`, no dos (la unicidad de 002 y la
    // lectura previa del script son las dos redes).
    expect(filasDe("users")).toHaveLength(1);
    // UN rol: `replace_user_roles` reemplaza el conjunto, no agrega filas.
    expect(rolesDeLaCuenta()).toHaveLength(1);
    expect(segunda.roles).toEqual(["superadmin"]);
    // La clave que manda es la de la ÚLTIMA corrida: es la decisión documentada
    // (volver a correr el script repone la credencial del entorno).
    await expect(verifyPassword(OTRA_CLAVE_FICTICIA, hashGuardado())).resolves.toBe(true);
    await expect(verifyPassword(CLAVE_FICTICIA, hashGuardado())).resolves.toBe(false);
  });

  it("una fila que NO es la instalación no la desorienta: se ancla a la activa", async () => {
    sembrar();
    // La fila que dejó la versión anterior de esta capa, con su nombre de sistema.
    // No es la instalación —está inactiva— y no debe cambiar ni contarse.
    postgrest.rows.sedes.push({
      id: SEDE_VIEJA_DE_PLATAFORMA,
      name: NOMBRE_SEDE_VIEJA,
      is_active: false,
    });

    const resultado = await provisionarSuperadmin({ clave: CLAVE_FICTICIA });

    expect(resultado.sede.id).toBe(SEDE);
    expect(cuenta()?.sede_id).toBe(SEDE);
    // La fila vieja queda exactamente como estaba: ni se borra ni se activa.
    expect(filasDeSedes().find((fila) => fila.id === SEDE_VIEJA_DE_PLATAFORMA)).toMatchObject({
      name: NOMBRE_SEDE_VIEJA,
      is_active: false,
    });
  });

  it("sin ninguna sede activa falla ANTES de tocar la cuenta", async () => {
    sembrar();
    postgrest.rows.sedes = [
      { id: SEDE_VIEJA_DE_PLATAFORMA, name: NOMBRE_SEDE_VIEJA, is_active: false },
    ];

    await expect(provisionarSuperadmin({ clave: CLAVE_FICTICIA })).rejects.toMatchObject({
      codigo: "SEDE_AUSENTE",
    });

    expect(filasDe("users")).toEqual([]);
    expect(filasDe("user_roles")).toEqual([]);
    expect(postgrest.rpcCalls).toEqual([]);
  });

  it("con dos sedes activas se rechaza: no elige una al azar", async () => {
    sembrar();
    postgrest.rows.sedes = [
      { id: SEDE, name: "Sede principal", is_active: true },
      { id: SEDE_VIEJA_DE_PLATAFORMA, name: NOMBRE_SEDE_VIEJA, is_active: true },
    ];

    await expect(provisionarSuperadmin({ clave: CLAVE_FICTICIA })).rejects.toMatchObject({
      codigo: "SEDE_DUPLICADA",
    });

    expect(filasDe("users")).toEqual([]);
    expect(filasDe("sedes")).toHaveLength(2);
  });

  it("una cuenta anclada a otra sede se re-ancla a la de la instalación y lo dice", async () => {
    sembrar();
    const primera = await provisionarSuperadmin({ clave: CLAVE_FICTICIA });
    // Estado a corregir: la cuenta quedó apuntando a una sede que ya no es la
    // instalación (la fila vieja que dejó la versión anterior del script).
    postgrest.rows.users = filasDe("users").map((fila) => ({
      ...fila,
      sede_id: SEDE_VIEJA_DE_PLATAFORMA,
    }));

    const segunda = await provisionarSuperadmin({ clave: OTRA_CLAVE_FICTICIA });

    expect(segunda.sede.id).toBe(primera.sede.id);
    expect(cuenta()?.sede_id).toBe(SEDE);
    // Cambiar de sede cambia lo que la cuenta ve del negocio: no puede ser mudo.
    expect(segunda.avisos.join(" | ")).toContain("otra sede");
  });

  it("sin ninguna sede activa el CLI lo dice con palabras y no escribe nada", async () => {
    sembrar();
    postgrest.rows.sedes = [
      { id: SEDE_VIEJA_DE_PLATAFORMA, name: NOMBRE_SEDE_VIEJA, is_active: false },
    ];
    vi.stubEnv("SUPERADMIN_PASSWORD", CLAVE_FICTICIA);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto-de-prueba.supabase.co");
    const salida = capturarSalida();

    await main(SIN_ARCHIVOS);

    // El mensaje dice QUÉ hacer (activar la sede del negocio), no sólo el código.
    expect(process.exitCode).toBe(1);
    expect(salida.errores.join("\n")).toContain("sede activa");
    expect(cuenta()).toBeUndefined();
    expect(postgrest.rpcCalls).toEqual([]);
    salida.restaurar();
  });

  it("si el catálogo no tiene `superadmin` (069 sin aplicar) falla y no crea la cuenta", async () => {
    sembrar();
    postgrest.rows.roles = [];

    await expect(provisionarSuperadmin({ clave: CLAVE_FICTICIA })).rejects.toMatchObject({
      codigo: "CATALOGO_SIN_ROL",
    });

    expect(filasDe("users")).toEqual([]);
  });

  it("imprime el host de destino y la sede de la instalación, y nunca la clave", async () => {
    sembrar();
    vi.stubEnv("SUPERADMIN_PASSWORD", CLAVE_FICTICIA);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto-de-prueba.supabase.co");
    const salida = capturarSalida();

    await main(SIN_ARCHIVOS);

    expect(process.exitCode).toBeFalsy();
    const todo = [...salida.lineas, ...salida.errores, ...salida.avisos].join("\n");
    // El host de Supabase: es el chequeo humano de a qué base se le escribe.
    expect(todo).toContain("proyecto-de-prueba.supabase.co");
    // El nombre Y el id de la sede a la que quedó anclada la cuenta.
    expect(todo).toContain("Sede principal");
    expect(todo).toContain(SEDE);
    // La credencial NUNCA sale por la salida del script.
    expect(todo).not.toContain(CLAVE_FICTICIA);
    salida.restaurar();
  });
});
