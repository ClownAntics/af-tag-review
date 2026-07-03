/**
 * READ-ONLY. Finds designs whose LIVE shopify_tags contain `memorial-day`
 * while our curated approved_tags do NOT — i.e. stale storefront tags that
 * keep polluting the Memorial Day collections regardless of our curation.
 * (Mirror is fresh from today's shopify-pull.)
 *
 * Usage: npx tsx scripts/scan-stale-memorial.ts
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const sb = getAdminClient();
  const rows: any[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,approved_tags,shopify_tags")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  const stale = rows.filter((r) => {
    const live = (r.shopify_tags ?? []).map((t: string) => t.toLowerCase());
    const cur = r.approved_tags ?? [];
    return live.includes("memorial-day") && !cur.includes("Memorial-Day");
  });

  console.log(`Live 'memorial-day' WITHOUT curated Memorial-Day: ${stale.length}\n`);
  for (const r of stale) {
    const cur4th = (r.approved_tags ?? []).includes("4th-Of-July") ? " [curated: 4th-Of-July]" : "";
    console.log(`  ${r.design_family} [${r.status}] "${r.design_name ?? ""}"${cur4th}`);
  }

  // Also the reverse: curated Memorial-Day designs (the legit collection)
  const legit = rows.filter((r) => (r.approved_tags ?? []).includes("Memorial-Day"));
  console.log(`\nCurated Memorial-Day designs (the legit set): ${legit.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
