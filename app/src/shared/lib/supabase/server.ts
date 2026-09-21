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
 * Server-side Supabase client bound to the request cookies (user session,
 * RLS enforced). Use in Server Components, Server Actions and Route Handlers.
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
