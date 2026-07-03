/**
 * READ-ONLY diagnostic. Scans the live catalog for designs whose approved_tags
 * carry BOTH `Memorial-Day` and `4th-Of-July` (a taxonomy-declared conflict),
 * which pollutes the storefront's Memorial Day / 4th of July collections since
 * approved_tags is what gets pushed to Shopify.
 *
 * Buckets each dual-tagged design by what the conflict resolver WOULD do given
 * its vision primary:
 *   - fourth-wins   : primary is a 4th-of-July term → Memorial-Day should drop
 *   - memorial-wins : primary is Memorial-Day       → 4th-Of-July should drop
 *   - unresolved    : primary is non-Seasonal (or null) → resolver keeps BOTH
 *
 * No writes. Usage: npx tsx scripts/scan-memorial-4th-conflict.ts
 */
import { getAdminClient } from "./_supabase-admin";
import { filterConflictingDecoration } from "../lib/vision";

interface Row {
  design_family: string;
  design_name: string | null;
  status: string;
  approved_tags: string[] | null;
  vision_raw: { primary?: string | null } | null;
}

const M = "Memorial-Day";
const F = "4th-Of-July";

async function main() {
  const sb = getAdminClient();
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,approved_tags,vision_raw")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  const both = rows.filter(
    (r) => (r.approved_tags ?? []).includes(M) && (r.approved_tags ?? []).includes(F),
  );

  const byStatus: Record<string, number> = {};
  for (const r of both) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const fourthWins: Row[] = [];
  const memorialWins: Row[] = [];
  const unresolved: Row[] = [];
  for (const r of both) {
    const primary = r.vision_raw?.primary ?? null;
    const { dropped } = await filterConflictingDecoration(primary, r.approved_tags ?? []);
    if (dropped.includes(M)) fourthWins.push(r);
    else if (dropped.includes(F)) memorialWins.push(r);
    else unresolved.push(r);
  }

  console.log(`Total non-excluded scanned: ${rows.length}`);
  console.log(`Designs with BOTH ${M} + ${F}: ${both.length}`);
  console.log(`  by status: ${JSON.stringify(byStatus)}`);
  console.log("");
  console.log(`Resolver buckets (given vision primary):`);
  console.log(`  fourth-wins  (drop Memorial-Day): ${fourthWins.length}`);
  console.log(`  memorial-wins(drop 4th-Of-July):  ${memorialWins.length}`);
  console.log(`  UNRESOLVED   (keeps both):        ${unresolved.length}`);
  console.log("");

  const sample = (label: string, arr: Row[], n = 15) => {
    console.log(`--- ${label} (showing ${Math.min(n, arr.length)}/${arr.length}) ---`);
    for (const r of arr.slice(0, n)) {
      console.log(
        `  ${r.design_family}  primary=${r.vision_raw?.primary ?? "∅"}  "${r.design_name ?? ""}"`,
      );
    }
    console.log("");
  };
  sample("UNRESOLVED (both tags survive → in both collections)", unresolved, 30);
  sample("fourth-wins (Memorial-Day is the wrong one)", fourthWins);
  sample("memorial-wins (4th-Of-July is the wrong one)", memorialWins);

  // Name-based smell test: designs tagged Memorial-Day whose NAME screams 4th.
  const nameSaysFourth = both.filter((r) =>
    /4th|fourth|independence|birthday|firework/i.test(r.design_name ?? ""),
  );
  sample("name-says-4th but tagged Memorial-Day too", nameSaysFourth, 30);
}
main().catch((e) => { console.error(e); process.exit(1); });
