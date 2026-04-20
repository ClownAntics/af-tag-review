/**
 * Service-role Supabase client for server-side routes that need to bypass RLS
 * (e.g. /api/review/vision/run — it writes vision_tags + status for many
 * designs in one request and logs events).
 *
 * Browser code must NEVER import this file. It reads SUPABASE_SERVICE_ROLE_KEY
 * from the process env; that variable is only available to server-side code
 * in Next.js and is explicitly not NEXT_PUBLIC_*.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getAdminSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
