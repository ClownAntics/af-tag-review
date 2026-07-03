/**
 * Bulk-move ALL `flagged` designs to `novision` (Blake's D4: new/changed
 * designs sit as novision — no action implied — instead of flagged).
 * Status-only change: no vision runs, no tag or theme changes.
 *
 * Usage:
 *   npx tsx scripts/flagged-to-novision.ts          # dry-run (counts + sample)
 *   npx tsx scripts/flagged-to-novision.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const { count, error: cErr } = await sb
    .from("designs")
    .select("*", { count: "exact", head: true })
    .eq("status", "flagged");
  if (cErr) throw cErr;
  console.log(`flagged designs: ${count}`);

  const { data: sample } = await sb
    .from("designs")
    .select("design_family,design_name")
    .eq("status", "flagged")
    .limit(10);
  for (const r of sample ?? []) console.log(`  ${r.design_family}  "${r.design_name ?? ""}"`);
  if ((count ?? 0) > 10) console.log(`  … and ${(count ?? 0) - 10} more`);

  if (!apply) { console.log("\nDRY-RUN. Re-run with --apply to commit."); return; }

  const { error, count: updated } = await sb
    .from("designs")
    .update({ status: "novision" }, { count: "exact" })
    .eq("status", "flagged");
  if (error) throw error;
  console.log(`\nDone. Moved ${updated} designs flagged → novision.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
