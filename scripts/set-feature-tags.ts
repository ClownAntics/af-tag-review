/**
 * Add the 13 feature/material Search-Term tags to each design's
 * approved_tags, driven by the boolean feature columns + the Type leaf
 * (material). Recomputes theme columns in lockstep. Optionally moves
 * tagged designs to readytosend.
 *
 * Feature tags (from boolean cols):
 *   is_double_sided→Double-Sided, is_printed_in_usa→Printed-In-USA,
 *   is_envirofriendly→Eco-Friendly, is_suede_reflections→Suede-Reflections,
 *   is_reversible→Reversible, is_premiersoft→PremierSoft,
 *   is_glittertrends→GlitterTrends
 * Material tags (from Type leaf): Sublimated (Printed)→Printed,
 *   Appliqued→Applique, Burlap→Burlap, Lustre→Lustre,
 *   Linen Flags→Linen, Moire→Moire  (Long Garden excluded — banner size)
 *
 * Usage:
 *   npx tsx scripts/set-feature-tags.ts            # dry-run + status breakdown
 *   npx tsx scripts/set-feature-tags.ts --apply            # tag, keep status
 *   npx tsx scripts/set-feature-tags.ts --apply --readytosend         # tag + readytosend ALL
 *   npx tsx scripts/set-feature-tags.ts --apply --readytosend-reviewed # tag + readytosend only updated/readytosend
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

interface Row {
  design_family: string;
  status: string;
  approved_tags: string[] | null;
  shopify_product_types: string[] | null;
  is_double_sided: boolean | null;
  is_printed_in_usa: boolean | null;
  is_envirofriendly: boolean | null;
  is_suede_reflections: boolean | null;
  is_reversible: boolean | null;
  is_premiersoft: boolean | null;
  is_glittertrends: boolean | null;
}

const FEATURE_COL_TAG: [keyof Row, string][] = [
  ["is_double_sided", "Double-Sided"],
  ["is_printed_in_usa", "Printed-In-USA"],
  ["is_envirofriendly", "Eco-Friendly"],
  ["is_suede_reflections", "Suede-Reflections"],
  ["is_reversible", "Reversible"],
  ["is_premiersoft", "PremierSoft"],
  ["is_glittertrends", "GlitterTrends"],
];
const MATERIAL_LEAF_TAG: Record<string, string> = {
  "Sublimated (Printed)": "Printed",
  Appliqued: "Applique",
  Burlap: "Burlap",
  Lustre: "Lustre",
  "Linen Flags": "Linen",
  Moire: "Moire",
};

function tagsFor(r: Row): string[] {
  const out = new Set<string>();
  for (const [col, tag] of FEATURE_COL_TAG) if (r[col] === true) out.add(tag);
  for (const t of r.shopify_product_types ?? []) {
    const leaf = t.split(":").pop()?.trim() ?? "";
    const tag = MATERIAL_LEAF_TAG[leaf];
    if (tag) out.add(tag);
  }
  return [...out];
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const readyAll = args.includes("--readytosend");
  const readyReviewed = args.includes("--readytosend-reviewed");

  const sb = getAdminClient();
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags,shopify_product_types,is_double_sided,is_printed_in_usa,is_envirofriendly,is_suede_reflections,is_reversible,is_premiersoft,is_glittertrends")
      .neq("status", "excluded")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  // Build per-design new tag set; track changes.
  const changes: { r: Row; before: string[]; after: string[]; added: string[] }[] = [];
  const tagCounts = new Map<string, number>();
  for (const r of rows) {
    const feat = tagsFor(r);
    if (feat.length === 0) continue;
    const before = r.approved_tags ?? [];
    const beforeSet = new Set(before);
    const added = feat.filter((t) => !beforeSet.has(t));
    if (added.length === 0) continue;
    const after = [...new Set([...before, ...feat])].sort();
    for (const t of added) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    changes.push({ r, before, after, added });
  }

  console.log(`Designs that gain ≥1 feature/material tag: ${changes.length}\n`);
  console.log("Per-tag (designs newly getting it):");
  for (const [t, n] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${t.padEnd(18)} ${n}`);

  const byStatus = new Map<string, number>();
  for (const c of changes) byStatus.set(c.r.status, (byStatus.get(c.r.status) ?? 0) + 1);
  console.log("\nAffected designs by current status:");
  for (const [s, n] of [...byStatus.entries()].sort()) console.log(`  ${s.padEnd(14)} ${n}`);

  const reviewed = new Set(["updated", "readytosend"]);
  const unreviewedCount = changes.filter((c) => !reviewed.has(c.r.status)).length;
  console.log(`\n⚠ ${unreviewedCount} affected designs are NOT yet content-reviewed (novision/flagged/pending).`);
  console.log(`  --readytosend          → moves ALL ${changes.length} to readytosend (incl. unreviewed)`);
  console.log(`  --readytosend-reviewed → moves only the ${changes.length - unreviewedCount} already-reviewed ones`);
  console.log(`  (neither flag)         → just adds tags, leaves status untouched`);

  if (!apply) {
    console.log("\nDRY-RUN. Add --apply (+ optional --readytosend / --readytosend-reviewed) to commit.");
    return;
  }

  console.log("\nApplying…");
  let done = 0;
  for (const c of changes) {
    const themes = await mapTagsToThemes(c.after);
    const patch: Record<string, unknown> = {
      approved_tags: c.after,
      theme_names: themes.theme_names,
      sub_themes: themes.sub_themes,
      sub_sub_themes: themes.sub_sub_themes,
    };
    const moveReady =
      readyAll || (readyReviewed && reviewed.has(c.r.status));
    if (moveReady) {
      patch.status = "readytosend";
      patch.last_reviewed_at = new Date().toISOString();
    }
    const { error: updErr } = await sb
      .from("designs")
      .update(patch)
      .eq("design_family", c.r.design_family);
    if (updErr) {
      console.warn(`  ${c.r.design_family}: ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: c.r.design_family,
      event_type: "tag_updated",
      actor: "blake",
      payload: { reason: "feature_material_tags", added: c.added, moved_readytosend: !!moveReady },
    });
    done++;
    if (done % 250 === 0) console.log(`  updated ${done}/${changes.length}`);
  }
  console.log(`\nDone. ${done}/${changes.length} designs tagged.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
