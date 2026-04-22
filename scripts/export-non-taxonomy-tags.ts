/**
 * Export every distinct tag in designs.shopify_tags that is NOT in the
 * FL-Themes taxonomy, sorted by frequency. Output: non_taxonomy_tags.csv
 * with columns: count, tag, in_current_blacklist, sample_families.
 *
 * Usage: npx tsx scripts/export-non-taxonomy-tags.ts
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import taxonomy from "../lib/taxonomy.json";

// Current expanded blacklist (case-insensitive), for reference in the export.
const CURRENT_BLACKLIST_LC = new Set([
  "in-stock",
  "reversible",
  "soloormonogram",
  "includeinpromotions",
  "showinglobalfilter",
  "suedereflections", // user wants this kept — will drop from next run
  "sale product",
  "ready-to-ship",
]);

async function main() {
  const sb = getAdminClient();

  const taxLc = new Set<string>();
  for (const e of (taxonomy as { entries: { term: string; label: string }[] })
    .entries) {
    taxLc.add(e.term.toLowerCase());
    taxLc.add(e.label.toLowerCase());
  }
  console.log(`Taxonomy terms (incl. labels): ${taxLc.size}`);

  type Row = {
    design_family: string;
    shopify_tags: string[] | null;
  };
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,shopify_tags")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
  }
  console.log(`Designs loaded: ${rows.length}`);

  const tallied = new Map<
    string,
    { count: number; families: string[] }
  >();
  for (const r of rows) {
    for (const raw of r.shopify_tags ?? []) {
      const t = raw.trim();
      if (!t) continue;
      if (taxLc.has(t.toLowerCase())) continue;
      const hit = tallied.get(t) ?? { count: 0, families: [] };
      hit.count++;
      if (hit.families.length < 3) hit.families.push(r.design_family);
      tallied.set(t, hit);
    }
  }

  const sorted = [...tallied.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`Distinct non-taxonomy tags: ${sorted.length}`);

  const lines = ["count,tag,in_current_blacklist,sample_families"];
  for (const [tag, info] of sorted) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const inBl = CURRENT_BLACKLIST_LC.has(tag.toLowerCase()) ? "Y" : "";
    lines.push(
      [
        String(info.count),
        esc(tag),
        inBl,
        esc(info.families.join(" | ")),
      ].join(","),
    );
  }
  writeFileSync("non_taxonomy_tags.csv", lines.join("\n"), "utf8");
  console.log(`Wrote non_taxonomy_tags.csv (${sorted.length} rows).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
