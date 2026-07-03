/**
 * Run the taxonomy refresh WITHOUT a dev server by invoking the production
 * route handler directly (same code path as the app's Refresh button):
 * app/api/taxonomy/refresh/route.ts POST — phase=plan | phase=apply.
 *
 * Usage:
 *   npx tsx scripts/run-taxonomy-refresh.ts          # plan (diff only, no writes)
 *   npx tsx scripts/run-taxonomy-refresh.ts --apply  # apply (upsert + design sweep)
 */
import "./_supabase-admin"; // loads .env.local before the route module reads env

async function main() {
  const phase = process.argv.slice(2).includes("--apply") ? "apply" : "plan";
  const { POST } = await import("../app/api/taxonomy/refresh/route");
  const res = await POST(new Request(`http://localhost/api/taxonomy/refresh?phase=${phase}`, { method: "POST" }));
  const body = await res.json();
  console.log(`HTTP ${res.status} (phase=${phase})`);
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
