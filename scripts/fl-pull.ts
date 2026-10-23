/**
 * Sync the FL (Flagsrus) catalog into Supabase: link designs to their FL
 * products (fl_product_ids / fl_product_types / fl_tags) and insert FL-only
 * products as new No-vision designs. Logic: lib/fl-sync.ts (shared with
 * Settings → "Sync FL catalog").
 *
 * Usage:
 *   npx tsx scripts/fl-pull.ts          # dry run — counts + sample new designs
 *   npx tsx scripts/fl-pull.ts --apply  # write to Supabase
 *
 * Needs SHOPIFY_FL_STORE + SHOPIFY_FL_ADMIN_TOKEN in .env.local.
 */
import { getAdminClient } from "./_supabase-admin";
import { runFlSync } from "../lib/fl-sync";

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) if (a !== "--apply") throw new Error(`unknown arg: ${a}`);
  const apply = argv.includes("--apply");
  console.log(`[fl-pull] streaming FL catalog · ${apply ? "APPLY" : "dry run"}…`);
  const r = await runFlSync(getAdminClient(), { apply });
  console.log(
    `[fl-pull] ${r.productsSeen} FL products, ${r.productsMatched} with SKUs → ${r.families} families`,
  );
  console.log(
    `[fl-pull] ${apply ? "" : "would: "}link/refresh ${r.linked} designs · insert ${r.inserted} FL-only · unlink ${r.unlinked}`,
  );
  if (r.unlinkSkippedSafety) console.warn(`[fl-pull] unlink skipped: ${r.unlinkSkippedSafety}`);
  if (r.newSamples.length > 0) {
    console.log("[fl-pull] sample FL-only designs:");
    for (const s of r.newSamples) console.log(`    ${s}`);
  }
  console.log(`[fl-pull] ${Math.round(r.durationMs / 1000)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
