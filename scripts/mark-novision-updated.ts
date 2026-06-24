/**
 * Mark every `novision` design as `updated`.
 *
 * Context: a Shopify catalog pull dumped the entire non-AF back-catalog
 * (~6,734 families) into novision today. These are long-established products
 * already live on Shopify with their own tags — not things we need to review.
 * Per Blake, treat them as live/done by flipping novision → updated.
 *
 * Leaves approved_tags untouched (empty) — we haven't curated them; they're
 * live as-is. The flag-undertagged rule's `neverCurated` guard skips them so
 * they don't get swept back into flagged.
 *
 * Usage:
 *   npx tsx scripts/mark-novision-updated.ts          # dry-run
 *   npx tsx scripts/mark-novision-updated.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  // Count + manufacturer breakdown of what we're about to flip.
  const rows: { design_family: string; manufacturer: string | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,manufacturer")
      .eq("status", "novision")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }
  const byMfr = new Map<string, number>();
  for (const r of rows) byMfr.set(r.manufacturer ?? "?", (byMfr.get(r.manufacturer ?? "?") ?? 0) + 1);
  console.log(`novision → updated: ${rows.length} designs`);
  for (const [m, n] of [...byMfr.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${(m ?? "?").padEnd(14)} ${n}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200).map((r) => r.design_family);
    const { error } = await sb
      .from("designs")
      .update({ status: "updated" })
      .in("design_family", slice);
    if (error) throw new Error(`batch at ${i}: ${error.message}`);
    done += slice.length;
    console.log(`  updated ${done}/${rows.length}`);
  }
  console.log(`\nDone. ${done} designs novision → updated.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
