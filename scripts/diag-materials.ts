/**
 * Diagnose why the Material theme only shows "Printed" as a sub-theme.
 * Checks: (1) taxonomy_entries for the Material group, (2) how many designs
 * carry each material tag in approved_tags, (3) what Material:* sub_themes are
 * actually populated, (4) raw shopify_product_types leaves that should map.
 */
import { getAdminClient } from "./_supabase-admin";

const MATERIAL_LEAF_TAG: Record<string, string> = {
  "Sublimated (Printed)": "Printed",
  Appliqued: "Applique",
  Burlap: "Burlap",
  Lustre: "Lustre",
  "Linen Flags": "Linen",
  Moire: "Moire",
};
const MATERIAL_TAGS = ["Printed", "Applique", "Burlap", "Lustre", "Linen", "Moire"];

async function main() {
  const sb = getAdminClient();

  // 1. Taxonomy: anything that looks like Material
  const { data: tax } = await sb
    .from("taxonomy_entries")
    .select("td_row_id,search_term,name,sub_theme,sub_sub_theme,label,level")
    .or("name.eq.Material,label.ilike.Material%")
    .order("td_row_id");
  console.log("=== taxonomy_entries (Material) ===");
  for (const r of tax ?? [])
    console.log(`  [#${r.td_row_id}] term="${r.search_term}" name="${r.name}" sub="${r.sub_theme}" label="${r.label}" lvl=${r.level}`);
  if (!tax?.length) console.log("  (none found)");

  // Also: is there a taxonomy entry for each material tag at all?
  console.log("\n=== taxonomy entry present per material tag (by search_term) ===");
  for (const t of MATERIAL_TAGS) {
    const { data } = await sb.from("taxonomy_entries").select("td_row_id,name,label").eq("search_term", t);
    console.log(`  ${t.padEnd(10)} ${data?.length ? data.map((d) => `#${d.td_row_id}(${d.name}|${d.label})`).join(", ") : "❌ MISSING"}`);
  }

  // 2 + 3 + 4: scan designs
  const rows: { approved_tags: string[] | null; sub_themes: string[] | null; shopify_product_types: string[] | null; status: string }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("approved_tags,sub_themes,shopify_product_types,status")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }

  console.log(`\n=== designs scanned: ${rows.length} ===`);
  console.log("\nmaterial tag in approved_tags:");
  for (const t of MATERIAL_TAGS) {
    const n = rows.filter((r) => (r.approved_tags ?? []).includes(t)).length;
    console.log(`  ${t.padEnd(10)} ${n}`);
  }

  console.log("\nMaterial:* values present in sub_themes column:");
  const subCounts = new Map<string, number>();
  for (const r of rows)
    for (const s of r.sub_themes ?? [])
      if (/material/i.test(s)) subCounts.set(s, (subCounts.get(s) ?? 0) + 1);
  if (!subCounts.size) console.log("  (none)");
  for (const [s, n] of [...subCounts.entries()].sort()) console.log(`  "${s}"  ${n}`);

  console.log("\nshopify_product_types leaves that SHOULD map to a material tag:");
  const leafCounts = new Map<string, number>();
  for (const r of rows)
    for (const pt of r.shopify_product_types ?? []) {
      const leaf = pt.split(":").pop()?.trim() ?? "";
      if (MATERIAL_LEAF_TAG[leaf]) leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
    }
  for (const [l, n] of [...leafCounts.entries()].sort()) console.log(`  "${l}" → ${MATERIAL_LEAF_TAG[l]}  ${n}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
