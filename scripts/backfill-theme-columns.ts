/**
 * Backfill `theme_names` / `sub_themes` / `sub_sub_themes` from `approved_tags`
 * for every design where the derived columns are out of sync with the
 * curated tags. Fixes the bug where approve / update_tags / accept_vision /
 * reject_vision changed approved_tags without recomputing the theme columns,
 * which made filtered counts under-report (a Flowers-tagged design wouldn't
 * appear under the Flowers theme filter).
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-theme-columns.ts          # dry-run, prints stats
 *   npx tsx scripts/backfill-theme-columns.ts --apply  # actually writes
 *
 * Scope: all designs with non-null approved_tags. Skips rows whose theme
 * columns already match what mapTagsToThemes produces (no-op writes).
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

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
  approved_tags: string[] | null;
  theme_names: string[] | null;
  sub_themes: string[] | null;
  sub_sub_themes: string[] | null;
}

function eqArr(a: string[] | null, b: string[] | null): boolean {
  const aa = (a ?? []).slice().sort();
  const bb = (b ?? []).slice().sort();
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  console.log("[backfill] loading designs with approved_tags …");
  // Paginate: Supabase REST caps a single select at 1000 rows.
  const rows: DesignRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,approved_tags,theme_names,sub_themes,sub_sub_themes")
      .not("approved_tags", "is", null)
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const batch = (data ?? []) as DesignRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  console.log(`[backfill] ${rows.length} designs to evaluate.`);

  let needsUpdate = 0;
  const updates: Array<{
    design_family: string;
    theme_names: string[];
    sub_themes: string[];
    sub_sub_themes: string[];
  }> = [];

  for (const r of rows) {
    const tags = r.approved_tags ?? [];
    const themes = await mapTagsToThemes(tags);
    const drift =
      !eqArr(r.theme_names, themes.theme_names) ||
      !eqArr(r.sub_themes, themes.sub_themes) ||
      !eqArr(r.sub_sub_themes, themes.sub_sub_themes);
    if (!drift) continue;
    needsUpdate++;
    updates.push({
      design_family: r.design_family,
      theme_names: themes.theme_names,
      sub_themes: themes.sub_themes,
      sub_sub_themes: themes.sub_sub_themes,
    });
  }

  console.log(
    `[backfill] ${needsUpdate} designs have drifted theme columns and need rewriting.`,
  );

  if (!args.apply) {
    console.log("[backfill] DRY-RUN. Re-run with --apply to commit changes.");
    if (updates.length > 0) {
      console.log("  first 10 drift samples:");
      for (const u of updates.slice(0, 10)) {
        console.log(
          `    ${u.design_family}  → theme_names=[${u.theme_names.slice(0, 4).join(", ")}${u.theme_names.length > 4 ? ", …" : ""}]`,
        );
      }
    }
    return;
  }

  // Apply in parallel-ish batches to bound concurrency.
  const PARALLEL = 25;
  let done = 0;
  for (let i = 0; i < updates.length; i += PARALLEL) {
    const slice = updates.slice(i, i + PARALLEL);
    await Promise.all(
      slice.map(async (u) => {
        const { error } = await sb
          .from("designs")
          .update({
            theme_names: u.theme_names,
            sub_themes: u.sub_themes,
            sub_sub_themes: u.sub_sub_themes,
          })
          .eq("design_family", u.design_family);
        if (error) {
          console.warn(`  ! ${u.design_family}: ${error.message}`);
          return;
        }
        done++;
      }),
    );
    if ((i + PARALLEL) % 250 < PARALLEL) {
      console.log(`  … ${done}/${updates.length} written`);
    }
  }
  console.log(`[backfill] done: ${done}/${updates.length} designs updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
