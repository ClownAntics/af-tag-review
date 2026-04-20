import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Next.js loads .env.local automatically; tsx doesn't, so do it here. This
// runs once at module load, before any script that imports getAdminClient.
// `override: true` ensures values in .env.local win over anything already in
// the process env (e.g., a stale empty var from a previous shell test).
config({ path: ".env.local", override: true });

/**
 * Admin Supabase client used by import scripts.
 *
 * Reads SUPABASE_SERVICE_ROLE_KEY (NOT NEXT_PUBLIC_*). The service-role key
 * bypasses RLS and must NEVER be exposed to the browser. Add it to .env.local:
 *
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 */
export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function chunkedUpsert<T>(
  table: string,
  rows: T[],
  client: ReturnType<typeof getAdminClient>,
  conflictTarget: string,
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await client
      .from(table)
      .upsert(chunk as object[], { onConflict: conflictTarget });
    if (error) {
      throw new Error(
        `Upsert into ${table} failed at offset ${i}: ${error.message}`,
      );
    }
    process.stdout.write(
      `  ${table}: upserted ${Math.min(i + chunkSize, rows.length)}/${rows.length}\r`,
    );
  }
  process.stdout.write("\n");
}
