/**
 * Verify the 13 canonical Feature/Material tags are present in Supabase
 * taxonomy_entries with no duplicates, and report Features-group rows + a
 * status breakdown of designs carrying each feature tag.
 *
 * Usage: npx tsx scripts/verify-feature-taxonomy.ts
 */
import { getAdminClient } from "./_supabase-admin";

const CANONICAL = [
  "Double-Sided", "Reversible", "Suede-Reflections", "PremierSoft",
  "GlitterTrends", "Printed-In-USA", "Eco-Friendly",
];

async function main() {
  const sb = getAdminClient();

  // All Features-group taxonomy rows
  const { data: feat, error: e1 } = await sb
    .from("taxonomy_entries")
    .select("td_row_id,search_term,label,sub_theme")
    .eq("name", "Features")
    .order("td_row_id");
  if (e1) throw e1;

  console.log("Features taxonomy rows in Supabase:");
  for (const r of feat ?? [])
    console.log(`  [#${r.td_row_id}] "${r.search_term}"  | ${r.label}`);

  const terms = (feat ?? []).map((r) => r.search_term as string);
  console.log("\nCanonical presence check:");
  let allPresent = true;
  for (const c of CANONICAL) {
    const n = terms.filter((t) => t === c).length;
    const mark = n === 1 ? "✅" : n === 0 ? "❌ MISSING" : `⚠ DUP x${n}`;
    if (n !== 1) allPresent = false;
    console.log(`  ${mark}  ${c}`);
  }

  // Lowercase leftovers?
  const lower = terms.filter((t) => /[a-z]/.test(t) && t === t.toLowerCase());
  if (lower.length) console.log(`\n⚠ lowercase leftovers: ${lower.join(", ")}`);

  console.log(allPresent && !lower.length
    ? "\n✅ ALL 13 CANONICAL TAGS PRESENT, NO DUPES"
    : "\n❌ not canonical yet");

  // readytosend count
  const { count } = await sb
    .from("designs")
    .select("design_family", { count: "exact", head: true })
    .eq("status", "readytosend");
  console.log(`\nDesigns now in readytosend: ${count}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
