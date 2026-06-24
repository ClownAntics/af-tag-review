/**
 * Apply Material facet tags to every non-excluded design, derived from the
 * shopify_product_types leaf. This is what makes the Material filter list all
 * six types instead of only "Printed" — each design gets its Material:* sub-theme.
 *
 *   "Sublimated (Printed)" → Printed   (NOT "Long Garden" — that's banner size)
 *   "Appliqued"            → Applique
 *   "Burlap"               → Burlap
 *   "Lustre"               → Lustre
 *   "Linen Flags"          → Linen
 *   "Moire"                → Moire
 *
 * Adds the tag to approved_tags (dedupe) and recomputes theme columns in
 * lockstep. Status is left untouched — these are mostly the adopted non-AF
 * catalog ('updated', uncurated); the flag-undertagged neverCurated guard
 * (0 content tags) keeps them out of the re-flag sweep.
 *
 * Usage:
 *   npx tsx scripts/set-material-tags.ts          # dry-run
 *   npx tsx scripts/set-material-tags.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

const MATERIAL_LEAF_TAG: Record<string, string> = {
  "Sublimated (Printed)": "Printed",
  Appliqued: "Applique",
  Burlap: "Burlap",
  Lustre: "Lustre",
  "Linen Flags": "Linen",
  Moire: "Moire",
};

interface Row {
  design_family: string;
  status: string;
  approved_tags: string[] | null;
  shopify_product_types: string[] | null;
}

function materialsFor(r: Row): string[] {
  const out = new Set<string>();
  for (const t of r.shopify_product_types ?? []) {
    const leaf = t.split(":").pop()?.trim() ?? "";
    const tag = MATERIAL_LEAF_TAG[leaf];
    if (tag) out.add(tag);
  }
  return [...out];
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags,shopify_product_types")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as Row[]));
    if (b.length < PAGE) break;
  }

  const changes: { family: string; after: string[]; added: string[] }[] = [];
  const perTag = new Map<string, number>();
  for (const r of rows) {
    const mats = materialsFor(r);
    if (!mats.length) continue;
    const before = r.approved_tags ?? [];
    const beforeSet = new Set(before);
    const added = mats.filter((t) => !beforeSet.has(t));
    if (!added.length) continue;
    for (const t of added) perTag.set(t, (perTag.get(t) ?? 0) + 1);
    changes.push({ family: r.design_family, after: [...new Set([...before, ...mats])].sort(), added });
  }

  console.log(`Designs gaining a Material tag: ${changes.length}\n`);
  for (const [t, n] of [...perTag.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(10)} ${n}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  let done = 0;
  for (const c of changes) {
    const themes = await mapTagsToThemes(c.after);
    const { error } = await sb
      .from("designs")
      .update({
        approved_tags: c.after,
        theme_names: themes.theme_names,
        sub_themes: themes.sub_themes,
        sub_sub_themes: themes.sub_sub_themes,
      })
      .eq("design_family", c.family);
    if (error) { console.warn(`  ${c.family}: ${error.message}`); continue; }
    done++;
    if (done % 250 === 0) console.log(`  updated ${done}/${changes.length}`);
  }
  console.log(`\nDone. ${done}/${changes.length} designs tagged with Material.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
