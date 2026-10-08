import { createBrowserClient } from "@supabase/ssr";

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

/** Browser-side Supabase client (anon key only, RLS enforced). */
export function createClient() {
  const { url, anonKey } = readPublicEnv();
  return createBrowserClient(url, anonKey);
}
