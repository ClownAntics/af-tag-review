/**
 * Strip cross-occasion tags from existing `vision_tags` based on the stored
 * vision primary. Same rule as `filterConflictingDecoration` in lib/vision.ts:
 * if a tag has the same level-1 name as the primary but a different level-2
 * sub, it's a competing occasion (e.g. `Halloween` on a Mardi-Gras flag, or
 * `Christmas-Religious` on a Kwanzaa flag — both common visual mis-cues) and
 * gets dropped.
 *
 * Cheap: no Anthropic calls. We rewrite `vision_tags` in-place from the
 * existing `vision_raw.primary` and the current `vision_tags` array. The
 * dropped tags are logged to a `payload.dropped_conflicting` field on a new
 * `vision_tags_filtered` event so the change is auditable.
 *
 * Usage:
 *   npx tsx scripts/backfill-conflicting-decoration.ts          # dry-run
 *   npx tsx scripts/backfill-conflicting-decoration.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { getTaxonomy } from "../lib/taxonomy-source";

interface Args {
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { apply: false };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

interface DesignRow {
  design_family: string;
  status: string;
  vision_tags: string[] | null;
  vision_raw: { primary?: string | null } | null;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();
  const { entries } = await getTaxonomy();
  const byTerm = new Map(entries.map((e) => [e.term, e] as const));

  console.log("[backfill] loading designs with vision_tags…");
  const rows: DesignRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,vision_tags,vision_raw")
      .not("vision_tags", "is", null)
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const batch = (data ?? []) as DesignRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  console.log(`[backfill] ${rows.length} designs loaded.`);

  const changes: Array<{ family: string; before: string[]; after: string[]; dropped: string[] }> = [];

  for (const r of rows) {
    const primary = r.vision_raw?.primary ?? null;
    if (!primary) continue;
    const primaryEntry = byTerm.get(primary);
    // Skip if primary isn't in taxonomy or is a level-1 umbrella.
    if (!primaryEntry || primaryEntry.level === 1) continue;
    const tags = r.vision_tags ?? [];
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const t of tags) {
      const e = byTerm.get(t);
      if (!e) {
        kept.push(t);
        continue;
      }
      // Level-1 umbrella tag (e.g. "Seasonal") — keep.
      if (e.level === 1) {
        kept.push(t);
        continue;
      }
      // Different level-1 theme entirely — keep.
      if (e.name !== primaryEntry.name) {
        kept.push(t);
        continue;
      }
      // Same name, same sub — descendant or sibling of primary's sub. Keep.
      if (e.sub === primaryEntry.sub) {
        kept.push(t);
        continue;
      }
      // Same name, different sub — competing occasion. Drop.
      dropped.push(t);
    }
    if (dropped.length === 0) continue;
    changes.push({ family: r.design_family, before: tags, after: kept, dropped });
  }

  console.log(`[backfill] ${changes.length} designs have conflicting decoration tags.`);
  if (changes.length === 0) return;

  // Show a sample.
  for (const c of changes.slice(0, 15)) {
    console.log(`  ${c.family}: drop [${c.dropped.join(", ")}]`);
  }
  if (changes.length > 15) console.log(`  …and ${changes.length - 15} more.`);

  if (!args.apply) {
    console.log("\n[backfill] DRY-RUN. Re-run with --apply to commit.");
    return;
  }

  console.log("\n[backfill] applying…");
  let done = 0;
  for (const c of changes) {
    const { error: updErr } = await sb
      .from("designs")
      .update({ vision_tags: c.after })
      .eq("design_family", c.family);
    if (updErr) {
      console.warn(`  ${c.family}: update failed — ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: c.family,
      event_type: "vision_tags_filtered",
      actor: "system",
      payload: {
        dropped_conflicting: c.dropped,
        before_count: c.before.length,
        after_count: c.after.length,
      },
    });
    done++;
    if (done % 25 === 0) console.log(`  filtered ${done}/${changes.length}`);
  }
  console.log(`[backfill] done. ${done}/${changes.length} designs updated.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
