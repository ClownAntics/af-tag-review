/**
 * Normalize the OLD 4-level "Long Garden" product_type string to the NEW
 * banner format in designs.shopify_product_types.
 *   OLD: "Sleeved Flags: Small Flags: Sublimated (Printed): Long Garden"
 *   NEW: "Sleeved Flags: Long Garden Flags: Sublimated (Printed)"
 * (Only ~5 excluded stragglers remain; active banners already use NEW.)
 *
 * Usage: npx tsx scripts/fix-longgarden-type.ts [--apply]
 */
import { getAdminClient } from "./_supabase-admin";

const OLD = "Sleeved Flags: Small Flags: Sublimated (Printed): Long Garden";
const NEW = "Sleeved Flags: Long Garden Flags: Sublimated (Printed)";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  const rows: { design_family: string; status: string; shopify_product_types: string[] | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data } = await sb.from("designs").select("design_family,status,shopify_product_types").range(o, o + PAGE - 1);
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }
  const hits = rows.filter((r) => (r.shopify_product_types ?? []).some((t) => t.trim() === OLD));
  console.log(`Designs with OLD "Long Garden" type: ${hits.length}`);
  for (const h of hits) console.log(`  ${h.design_family} [${h.status}]`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply."); return; }
  let done = 0;
  for (const h of hits) {
    const next = [...new Set((h.shopify_product_types ?? []).map((t) => (t.trim() === OLD ? NEW : t)))].sort();
    const { error } = await sb.from("designs").update({ shopify_product_types: next }).eq("design_family", h.design_family);
    if (error) { console.warn(`  ${h.design_family}: ${error.message}`); continue; }
    done++;
  }
  console.log(`\nDone. Normalized ${done} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
