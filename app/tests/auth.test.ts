import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LOCKED_ERROR,
  DocumentRateLimiter,
  GENERIC_LOGIN_ERROR,
  MAX_LOGIN_ATTEMPTS,
  SESSION_INACTIVITY_TIMEOUT_MS,
  checkSessionValidity,
  createPasswordResetToken,
  createSessionToken,
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
  loginSchema,
  requestResetSchema,
  resetPasswordSchema,
} from "@/src/features/auth/schemas";

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
