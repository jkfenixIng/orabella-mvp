import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";

/**
 * T2 — puerta gruesa de autenticación (proxy/middleware).
 * Protege todo menos /login, /api/v1/health y /api/v1/auth/*.
 * Solo verifica presencia de la cookie; la validez (expiración,
 * revocación, inactividad) la verifica getSessionUser() en cada
 * Route Handler / Server Action con la BD (AUTH-03).
 */
const PUBLIC_PATHS: RegExp[] = [/^\/login\/?$/, /^\/api\/v1\/health\/?$/, /^\/api\/v1\/auth(\/|$)/];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) {
    return NextResponse.next();
  }
  const session = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { success: false, code: "UNAUTHENTICATED", message: "Se requiere autenticación." },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
