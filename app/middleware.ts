import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";

/**
 * T2 — puerta gruesa de autenticación (proxy/middleware).
 * Protege todo menos /login, /api/v1/health y /api/v1/auth/*.
 * Solo verifica presencia de la cookie; la validez (expiración,
 * revocación, inactividad) la verifica getSessionUser() en cada
 * Route Handler / Server Action con la BD (AUTH-03).
 *
 * DECISIÓN — /admin solo admin: la cookie de sesión es un token
 * opaco y no porta el rol, y el middleware corre en el Edge sin
 * acceso a la BD; por eso NO se valida el rol aquí. La autorización
 * por rol se hace en la página del servidor (app/admin/page.tsx),
 * que lee la sesión con getSessionUser() y redirige al inicio a
 * quien no tenga rol admin.
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
  // DECISIÓN — dónde vive la exclusión de los activos: la Matcher y SÓLO la
  // Matcher. Next la evalúa antes de ejecutar la función, así que es la única
  // superficie donde una exclusión puede evitar la redirección; dentro de la
  // función ya se respondió.
  //
  // La alternativa nueva es `.*\.[^/]*$`: desde el inicio del pathname (la barra
  // inicial ya se consumió) se busca UN punto seguido SÓLO de caracteres sin
  // barra hasta el final. Eso es exactamente "el ÚLTIMO segmento tiene punto",
  // que es lo que hace que algo sea un archivo — y por eso vale a cualquier
  // profundidad: `public/images/logo.png` sigue siendo un archivo con la
  // carpeta que sea.
  //
  // La versión anterior (`[^/]*\.[^/]*`) estaba anclada al PRIMER segmento y
  // fallaba en las DOS direcciones: no excluía `/images/logo.png` (el día que
  // hubiera un subdirectorio en `public/`, el logo volvía a caerse en la puerta
  // sin cookie) y sí excluía `/v1.2/payroll`, abriendo de paso una ruta de
  // aplicación. Con `[^/]*$` al final, un punto dentro de un DIRECTORIO no
  // califica: después del punto viene la barra.
  //
  // Criterio de forma, no de rutas conocidas: una futura ruta de aplicación cuyo
  // ÚLTIMO segmento leyera con punto quedaría sin esta puerta. Se acepta porque
  // la invariante del proyecto es que las rutas de aplicación no llevan punto
  // (las de aplicación son segmentos planos: `/payroll`, `/api/v1/payroll-periods`,
  // `/plataforma`…; y `/login`, `/api/v1/health` y `/api/v1/auth/*`, las únicas
  // públicas, tampoco). `tests/middleware-matcher.test.ts` deja esto escrito y
  // verificado, no supuesto.
  //
  // Se deja intacta `PUBLIC_PATHS`: esa lista es de rutas DE APLICACIÓN, no de
  // archivos, y agregar aquí una extensión habría sido abrirla sin control.
  //
  // Sin esta exclusión el logo del login (`/orabella-logo.png`) y el favicon
  // (`/icon.png`) caían en la puerta sin cookie —justo en `/login`, que es
  // donde se muestran— y el navegador recibía el HTML del login en vez del PNG.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]*$).*)"],
};
