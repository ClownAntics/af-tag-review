/**
 * Surgical clean of non-taxonomy noise in designs.approved_tags (vendor tags
 * like "america-forever", Shopify housekeeping like "By Theme" /
 * "IncludeInPromotions" / "garden-mini"). For each affected design:
 *   - keep exact canonical Search Terms,
 *   - resolve label / name / leaf / case-variant forms to their Search Term,
 *   - DROP anything that still doesn't resolve (true junk),
 *   - recompute theme columns. Status unchanged (no flag, no re-push needed —
 *     Shopify already lowercases; dropped junk was never a real facet).
 *
 * Usage: npx tsx scripts/clean-tag-noise.ts [--apply]
 */
import { getAdminClient } from "./_supabase-admin";
import { getTaxonomy } from "../lib/taxonomy-source";
import { mapTagsToThemes } from "../lib/vision";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  const { entries } = await getTaxonomy();

  const canonical = new Set<string>();
  const byLower = new Map<string, string>();
  for (const e of entries) {
    if (!e.term) continue;
    canonical.add(e.term);
    byLower.set(e.term.toLowerCase(), e.term);
    byLower.set(e.term.toLowerCase().replace(/-/g, " "), e.term);
    byLower.set(e.term.toLowerCase().replace(/\s+/g, "-"), e.term);
    if (e.label) {
      byLower.set(e.label.toLowerCase(), e.term);
      const leaf = e.label.split(":").pop()?.trim();
      if (leaf) { byLower.set(leaf.toLowerCase(), e.term); byLower.set(leaf.toLowerCase().replace(/\s+/g, "-"), e.term); }
    }
  }

  const rows: { design_family: string; status: string; approved_tags: string[] | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("designs").select("design_family,status,approved_tags").neq("status", "excluded").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }

  const changes: { family: string; before: string[]; after: string[]; dropped: string[] }[] = [];
  for (const r of rows) {
    const before = r.approved_tags ?? [];
    if (!before.length) continue;
    const dropped: string[] = [];
    const resolved: string[] = [];
    for (const t of before) {
      if (canonical.has(t)) { resolved.push(t); continue; }
      const c = byLower.get(t.toLowerCase());
      if (c) resolved.push(c); else dropped.push(t);
    }
    const after = [...new Set(resolved)].sort();
    const changedNow = dropped.length > 0 || after.length !== before.length || after.some((v, i) => v !== [...new Set(before)].sort()[i]);
    if (changedNow && (dropped.length > 0 || JSON.stringify(after) !== JSON.stringify([...before].sort()))) {
      changes.push({ family: r.design_family, before, after, dropped });
    }
  }

  console.log(`Designs to clean: ${changes.length}\n`);
  for (const c of changes) console.log(`  ${c.family}\n     dropped: ${c.dropped.join(", ") || "(none)"}\n     after:   ${c.after.join(", ")}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply."); return; }
  let done = 0;
  for (const c of changes) {
    const themes = await mapTagsToThemes(c.after);
    const { error } = await sb.from("designs").update({ approved_tags: c.after, theme_names: themes.theme_names, sub_themes: themes.sub_themes, sub_sub_themes: themes.sub_sub_themes }).eq("design_family", c.family);
    if (error) { console.warn(`  ${c.family}: ${error.message}`); continue; }
    await sb.from("events").insert({ design_family: c.family, event_type: "tag_updated", actor: "blake", payload: { reason: "strip_noise", dropped: c.dropped } });
    done++;
  }
  console.log(`\nDone. Cleaned ${done} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
