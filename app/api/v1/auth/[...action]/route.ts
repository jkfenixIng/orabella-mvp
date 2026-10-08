import type { NextRequest } from "next/server";
import { fail, ok } from "@/src/shared/lib/api-response";
import {
  AuthError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  changeUserPassword,
  confirmPasswordReset,
  getSessionUser,
  hashToken,
  loginWithDocument,
  logoutWithToken,
  requestPasswordReset,
} from "@/src/features/auth/service";

const isProduction = process.env.NODE_ENV === "production";

function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) return fail(error.code, error.message, error.status);
  return fail("INTERNAL", "Error interno.", 500);
}

/**
 * Dispatch API-first de auth. Cubre las rutas con ":" (colon permitido en el
 * path HTTP) y sus equivalentes con "/" — sin carpetas con ":" en disco
 * (NTFS no las permite):
 * - POST /api/v1/auth/login
 * - POST /api/v1/auth/logout
 * - POST /api/v1/auth/password:change  (alias /password/change)
 * - POST /api/v1/auth/password-reset:request (alias /password-reset/request)
 * - POST /api/v1/auth/password-reset:confirm (alias /password-reset/confirm)
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string[] }> },
) {
  const { action } = await context.params;
  const key = action.join("/");

  try {
    if (key === "login") {
      const body: unknown = await request.json().catch(() => ({}));
      const result = await loginWithDocument(body);
      const response = ok({
        must_change_password: result.mustChangePassword,
        user: {
          id: result.user.id,
          full_name: result.user.full_name,
          roles: result.roles,
        },
      });
      response.cookies.set(SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: isProduction,
      });
      return response;
    }

    if (key === "logout") {
      const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
      await logoutWithToken(token);
      const response = ok({ revoked: true });
      response.cookies.delete(SESSION_COOKIE_NAME);
      return response;
    }

    if (key === "password:change" || key === "password/change") {
      const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
      const session = await getSessionUser(token);
      if (!session) return fail("UNAUTHENTICATED", "Se requiere autenticación.", 401);
      const body: unknown = await request.json().catch(() => ({}));
      await changeUserPassword({
        userId: session.user.id,
        currentTokenHash: token ? hashToken(token) : null,
        raw: body,
      });
      return ok({ changed: true });
    }

    if (key === "password-reset:request" || key === "password-reset/request") {
      const body: unknown = await request.json().catch(() => ({}));
      const result = await requestPasswordReset(body);
      // Respuesta genérica (AUTH-06); devToken solo existe en no-producción.
      return ok(
        result.devToken ? { requested: true, dev_token: result.devToken } : { requested: true },
      );
    }

    if (key === "password-reset:confirm" || key === "password-reset/confirm") {
      const body: unknown = await request.json().catch(() => ({}));
      await confirmPasswordReset(body);
      return ok({ changed: true });
    }

    return fail("NOT_FOUND", "No encontrado.", 404);
  } catch (error) {
    return authErrorResponse(error);
  }
}
