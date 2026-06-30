/**
 * Browser Supabase client for client components (the login page's Google
 * sign-in button). Cookie-based session via @supabase/ssr so the server sees
 * the same session.
 */
import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
