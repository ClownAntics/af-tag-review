/**
 * Safe-merge prep for pushing the Material facet live, then mark readytosend.
 *
 * Target: non-excluded, uncurated adopted-catalog designs (0 content tags,
 * never reviewed, never pushed) that carry a Material facet. For each:
 *   approved_tags = case-insensitive union of (existing shopify_tags + current
 *                   approved_tags)  — keeps EVERY live tag, just adds the facet
 *   recompute theme columns
 *   status = readytosend
 *
 * Because the push REPLACES a product's tags with approved_tags, the merge is
 * what makes the eventual push additive (material facet added, nothing wiped).
 *
 * Usage:
 *   npx tsx scripts/merge-material-readytosend.ts          # dry-run
 *   npx tsx scripts/merge-material-readytosend.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";
import { contentTagCount, UNDERTAGGED_FACETS } from "../lib/flag-undertagged";

const MATERIAL = new Set(["Printed", "Applique", "Burlap", "Lustre", "Linen", "Moire"]);

interface Row {
  design_family: string;
  status: string;
  approved_tags: string[] | null;
  shopify_tags: string[] | null;
  last_reviewed_at: string | null;
  last_pushed_at: string | null;
}

/** Union keeping all tags; on case collision keep the first-seen (approved) casing. */
function mergeTags(approved: string[], shopify: string[]): string[] {
  const byLower = new Map<string, string>();
  for (const t of [...approved, ...shopify]) {
    const k = t.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, t);
  }
  return [...byLower.values()].sort();
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags,shopify_tags,last_reviewed_at,last_pushed_at")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as Row[]));
    if (b.length < PAGE) break;
  }

  const uncurated = (r: Row) =>
    contentTagCount(r.approved_tags) === 0 && !r.last_reviewed_at && !r.last_pushed_at;
  const hasMaterial = (r: Row) => (r.approved_tags ?? []).some((t) => MATERIAL.has(t));

  const targets = rows.filter((r) => uncurated(r) && hasMaterial(r));
  // sanity: how many would still be ≤1 content tag AFTER the merge (these would
  // remain bare even after pulling in shopify_tags — worth knowing).
  let stillThin = 0;
  for (const r of targets) {
    const merged = mergeTags(r.approved_tags ?? [], r.shopify_tags ?? []);
    if (merged.filter((t) => !UNDERTAGGED_FACETS.has(t)).length <= 1) stillThin++;
  }
  console.log(`Target (uncurated + has Material facet): ${targets.length}`);
  console.log(`  of which still ≤1 content tag even after merge: ${stillThin}`);
  const noShopify = targets.filter((r) => (r.shopify_tags ?? []).length === 0).length;
  console.log(`  with no shopify_tags to merge (facet only): ${noShopify}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  let done = 0;
  for (const r of targets) {
    const merged = mergeTags(r.approved_tags ?? [], r.shopify_tags ?? []);
    const themes = await mapTagsToThemes(merged);
    const { error } = await sb
      .from("designs")
      .update({
        approved_tags: merged,
        theme_names: themes.theme_names,
        sub_themes: themes.sub_themes,
        sub_sub_themes: themes.sub_sub_themes,
        status: "readytosend",
      })
      .eq("design_family", r.design_family);
    if (error) { console.warn(`  ${r.design_family}: ${error.message}`); continue; }
    done++;
    if (done % 250 === 0) console.log(`  ${done}/${targets.length}`);
  }
  console.log(`\nDone. ${done}/${targets.length} merged + moved to readytosend.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
