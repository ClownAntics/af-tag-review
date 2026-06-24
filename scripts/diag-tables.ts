/**
 * List all PostgREST-exposed tables in the Supabase project (read-only).
 */
import { config } from "dotenv";
config({ path: ".env.local", override: true });

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const spec = (await res.json()) as { definitions?: Record<string, unknown>; paths?: Record<string, unknown> };
  const tables = spec.definitions
    ? Object.keys(spec.definitions)
    : Object.keys(spec.paths ?? {}).filter((p) => p !== "/").map((p) => p.replace(/^\//, ""));
  console.log("Tables:");
  for (const t of tables.sort()) console.log(`  ${t}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
