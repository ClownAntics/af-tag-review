/**
 * Conflict-aware theme recompute.
 *
 * Re-derives theme_names / sub_themes / sub_sub_themes from approved_tags, but
 * first strips decorations whose level-2 occasion conflicts with the design's
 * primary (via filterConflictingDecoration). This stops a stray decoration
 * like Fireworks/Stars — filed under "Seasonal: 4th of July" — from dragging
 * the "4th of July" sub-theme onto a New Year / Christmas flag.
 *
 * IMPORTANT: only the derived theme columns change. approved_tags is left
 * untouched (the decoration tag stays on the design), so nothing needs a
 * Shopify re-push. Only designs whose columns actually change are written.
 *
 * Usage:
 *   npx tsx scripts/recompute-themes-conflict.ts          # dry-run + before/after
 *   npx tsx scripts/recompute-themes-conflict.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes, filterConflictingDecoration } from "../lib/vision";

interface Row {
  design_family: string;
  approved_tags: string[] | null;
  theme_names: string[] | null;
  sub_themes: string[] | null;
  sub_sub_themes: string[] | null;
  vision_raw: { primary?: string | null } | null;
}

const eqArr = (a: string[] | null, b: string[]) => {
  const x = (a ?? []).slice().sort();
  return x.length === b.length && x.every((v, i) => v === b[i]);
};
const has4th = (subs: string[] | null) => (subs ?? []).some((s) => /4th of july/i.test(s));

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,approved_tags,theme_names,sub_themes,sub_sub_themes,vision_raw")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }
  console.log(`Scanning ${rows.length} non-excluded designs…`);

  const changes: { family: string; patch: Record<string, string[]> }[] = [];
  let before4th = 0;
  let after4th = 0;
  let lost4th = 0;
  for (const r of rows) {
    const primary = r.vision_raw?.primary ?? null;
    const { kept } = await filterConflictingDecoration(primary, r.approved_tags ?? []);
    const t = await mapTagsToThemes(kept);
    const tn = t.theme_names.slice().sort();
    const st = t.sub_themes.slice().sort();
    const sst = t.sub_sub_themes.slice().sort();

    const wasFourth = has4th(r.sub_themes);
    const nowFourth = has4th(st);
    if (wasFourth) before4th++;
    if (nowFourth) after4th++;
    if (wasFourth && !nowFourth) lost4th++;

    if (!eqArr(r.theme_names, tn) || !eqArr(r.sub_themes, st) || !eqArr(r.sub_sub_themes, sst)) {
      changes.push({ family: r.design_family, patch: { theme_names: tn, sub_themes: st, sub_sub_themes: sst } });
    }
  }
  console.log(`Designs needing recompute: ${changes.length}`);
  console.log(`"4th of July" sub-theme:  before=${before4th}  after=${after4th}  (removed from ${lost4th})`);

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
