/**
 * Recompute theme_names / sub_themes / sub_sub_themes for every non-excluded
 * design from approved_tags against the (now-clean) taxonomy. Scrubs phantom
 * values that earlier recomputes baked in from corrupted taxonomy rows
 * (e.g. "Wedding: Wedding Dresses: 3" from the bad Seasonal entry,
 * "MLB Baseball: 2").
 *
 * Only writes designs whose derived columns actually change.
 *
 * Usage:
 *   npx tsx scripts/recompute-theme-columns.ts          # dry-run
 *   npx tsx scripts/recompute-theme-columns.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

interface Row {
  design_family: string;
  approved_tags: string[] | null;
  theme_names: string[] | null;
  sub_themes: string[] | null;
  sub_sub_themes: string[] | null;
}

const eqArr = (a: string[] | null, b: string[]) => {
  const x = (a ?? []).slice().sort();
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,approved_tags,theme_names,sub_themes,sub_sub_themes")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }
  console.log(`Scanning ${rows.length} non-excluded designs…`);

  const changes: { family: string; patch: Record<string, string[]> }[] = [];
  let phantomWedding = 0;
  let phantomMlb = 0;
  for (const r of rows) {
    const t = await mapTagsToThemes(r.approved_tags ?? []);
    const tn = t.theme_names.slice().sort();
    const st = t.sub_themes.slice().sort();
    const sst = t.sub_sub_themes.slice().sort();
    if (!eqArr(r.theme_names, tn) || !eqArr(r.sub_themes, st) || !eqArr(r.sub_sub_themes, sst)) {
      if ((r.sub_sub_themes ?? []).some((s) => s.includes("Wedding Dresses: 3"))) phantomWedding++;
      if ((r.sub_sub_themes ?? []).some((s) => s.includes("MLB Baseball: 2"))) phantomMlb++;
      changes.push({ family: r.design_family, patch: { theme_names: tn, sub_themes: st, sub_sub_themes: sst } });
    }
  }
  console.log(`Designs needing recompute: ${changes.length}`);
  console.log(`  with phantom "Wedding Dresses: 3" being scrubbed: ${phantomWedding}`);
  console.log(`  with phantom "MLB Baseball: 2" being scrubbed:    ${phantomMlb}`);

  if (!apply) { console.log("\nDRY-RUN. Re-run with --apply to commit."); return; }

  console.log("\nApplying…");
  let done = 0;
  for (const c of changes) {
    const { error } = await sb.from("designs").update(c.patch).eq("design_family", c.family);
    if (error) { console.warn(`  ${c.family}: ${error.message}`); continue; }
    done++;
    if (done % 500 === 0) console.log(`  ${done}/${changes.length}`);
  }
  console.log(`\nDone. Recomputed ${done}/${changes.length} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
