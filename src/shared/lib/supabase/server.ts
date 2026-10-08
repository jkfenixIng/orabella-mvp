import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient as createJsClient } from "@supabase/supabase-js";

function readPublicEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase public env vars: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example).",
    );
  }
  return { url, anonKey };
}

/**
 * Cliente con RLS (anon key + cookies de la request). Hoy NO lo importa nadie:
 * todo el tráfico de la app va por `createAdminClient()` (service_role), que
 * bypasea RLS por diseño. Es decir que las políticas por sede del esquema NO se
 * evalúan nunca y este cliente NO es una segunda línea de defensa: la única
 * barrera es el código de aplicación (`requireSedeRole` en
 * `src/shared/lib/sede.ts`, que autoriza por ROL, más los filtros de cada
 * consulta). La comparación por sede se retiró con la columna `sede_id`: la
 * instalación es de una sola sede, así que ya no acotaba nada. Un guard
 * olvidado es una brecha total, sin red abajo.
 *
 * Se conserva —y no se borra— porque es el camino correcto si algún día se migra
 * la app a RLS. Ver la postura completa en `app/README.md` (D8).
 */
export async function createClient() {
  const { url, anonKey } = readPublicEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component (read-only cookies):
          // session refresh is handled by middleware/proxy in T2.
        }
      },
    },
  });
}

/**
 * Privileged server-only client (service_role, bypasses RLS).
 * NEVER import in client components. Used only for admin server tasks
 * (user provisioning, closed-period guards) with explicit auditing.
 */
export function createAdminClient() {
  const { url } = readPublicEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY: server-only secret, never expose with NEXT_PUBLIC_ prefix.",
    );
  }
  return createJsClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
