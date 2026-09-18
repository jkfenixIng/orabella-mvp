"use server";

import { cookies } from "next/headers";
import {
  AuthError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  adminCreateUser,
  changeUserPassword,
  confirmPasswordReset,
  getSessionUser,
  hashToken,
  loginWithDocument,
  logoutWithToken,
  requestPasswordReset,
} from "./service";

const isProduction = process.env.NODE_ENV === "production";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: isProduction,
  };
}

function toFailure(error: unknown): { success: false; code: string; message: string } {
  if (error instanceof AuthError) {
    return { success: false, code: error.code, message: error.message };
  }
  return { success: false, code: "INTERNAL", message: "Error interno." };
}

/** Misma lógica que POST /api/v1/auth/login (API-first: servicio compartido). */
export async function loginAction(input: { documento: string; password: string }) {
  try {
    const result = await loginWithDocument(input);
    const store = await cookies();
    store.set(SESSION_COOKIE_NAME, result.sessionToken, cookieOptions());
    return {
      success: true as const,
      mustChangePassword: result.mustChangePassword,
      fullName: result.user.full_name,
      roles: result.roles,
    };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/auth/logout. */
export async function logoutAction() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  try {
    await logoutWithToken(token);
    store.delete(SESSION_COOKIE_NAME);
    return { success: true as const };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/auth/password:change. */
export async function changePasswordAction(input: { actual: string; nueva: string }) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  try {
    const session = await getSessionUser(token);
    if (!session) throw new AuthError("UNAUTHENTICATED", "Se requiere autenticación.", 401);
    await changeUserPassword({
      userId: session.user.id,
      currentTokenHash: token ? hashToken(token) : null,
      raw: input,
    });
    return { success: true as const };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/auth/password-reset:request. */
export async function requestResetAction(input: { documento: string }) {
  try {
    const result = await requestPasswordReset(input);
    return { success: true as const, devToken: result.devToken };
  } catch (error) {
    return toFailure(error);
  }
}

/** Misma lógica que POST /api/v1/auth/password-reset:confirm. */
export async function confirmResetAction(input: { token: string; nueva: string }) {
  try {
    await confirmPasswordReset(input);
    return { success: true as const };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Alta solo por admin (AUTH-04). La ruta REST equivalente exige sesión
 * con rol admin; esta action asume que el llamante ya verificó el rol
 * (la verificación por rol/sede la cierra T3 con requireSedeRole).
 */
export async function adminCreateUserAction(input: {
  email: string;
  documento: string;
  id_type: "CC" | "CE" | "PPT" | "PEP" | "otro";
  full_name: string;
  phone?: string;
  roles: Array<"admin" | "empleado" | "caja">;
  sede_id?: string | null;
}) {
  try {
    const created = await adminCreateUser(input);
    return { success: true as const, id: created.id };
  } catch (error) {
    return toFailure(error);
  }
}
