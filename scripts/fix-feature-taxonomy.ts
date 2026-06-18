/**
 * Directly canonicalize the 5 Feature taxonomy_entries rows in Supabase.
 * The TeamDesk refresh apply doesn't update search terms on existing rows
 * (only handles adds), so edits to rows 977-981 never propagated. This
 * patches them to the agreed kebab-Title-Case canonical so they match the
 * tags already on designs.
 *
 * Usage: npx tsx scripts/fix-feature-taxonomy.ts --apply
 */
import { getAdminClient } from "./_supabase-admin";

const FIXES: { td_row_id: number; search_term: string; sub_theme: string; label: string }[] = [
  { td_row_id: 977, search_term: "GlitterTrends", sub_theme: "GlitterTrends", label: "Features: GlitterTrends" },
  { td_row_id: 978, search_term: "PremierSoft", sub_theme: "PremierSoft", label: "Features: PremierSoft" },
  { td_row_id: 979, search_term: "Printed-In-USA", sub_theme: "Printed In USA", label: "Features: Printed In USA" },
  { td_row_id: 980, search_term: "Reversible", sub_theme: "Reversible", label: "Features: Reversible" },
  { td_row_id: 981, search_term: "Suede-Reflections", sub_theme: "Suede Reflections", label: "Features: Suede Reflections" },
];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  for (const f of FIXES) {
    console.log(`#${f.td_row_id} → "${f.search_term}" | ${f.label}`);
    if (!apply) continue;
    const { error } = await sb
      .from("taxonomy_entries")
      .update({ search_term: f.search_term, sub_theme: f.sub_theme, label: f.label })
      .eq("td_row_id", f.td_row_id);
    if (error) throw new Error(`#${f.td_row_id}: ${error.message}`);
  }
  console.log(apply ? "\n✅ Applied." : "\nDRY-RUN. Add --apply.");
}
main().catch((e) => { console.error(e); process.exit(1); });
