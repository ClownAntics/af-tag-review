/**
 * Cookie-aware Supabase client for Server Components and Route Handlers.
 * Reads/writes the auth session via Next's cookie store so getUser() reflects
 * the signed-in user. Uses the anon key — identity only; privileged writes
 * still go through the service-role client in lib/supabase-admin.ts.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll called from a Server Component — cookies are read-only
            // there. The middleware refreshes the session cookie, so this is
            // safe to ignore.
          }
        },
      },
    },
  );
}
