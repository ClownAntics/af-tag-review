import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Single shared Supabase client.
 *
 * MVP uses the anon key both client- and server-side. RLS on the `designs` /
 * `sku_variants` tables grants public SELECT (see supabase/schema.sql). Import
 * scripts use the service-role key from a separate env var (see
 * scripts/_supabase-admin.ts).
 */

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cached;
}
