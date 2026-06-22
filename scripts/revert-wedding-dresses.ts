/**
 * One-off remediation for the 2026-06-16 taxonomy-refresh bug.
 *
 * A corrupt FL Themes row (Id 175 — Search Term "Seasonal" on a "Wedding
 * Dresses" entry) made the taxonomy refresh emit a rename Seasonal →
 * Wedding-Dresses, which rewrote ~428 designs' approved_tags / shopify_tags
 * and pushed the bad tag live to Shopify. None of these are wedding products;
 * they all simply had the broad "Seasonal" tag.
 *
 * This restores the tag: in approved_tags and shopify_tags, "Wedding-Dresses"
 * → "Seasonal" (dedup, sorted). Designs currently status='updated' are flipped
 * to 'readytosend' so scripts/shopify-push.ts re-pushes the corrected set to
 * Shopify (which also rewrites shopify_tags + status back to 'updated').
 * Designs in any other status (e.g. flagged, mid-review) get the DB fix but
 * are left in place — they'll push correctly when their review completes.
 *
 *   npx tsx scripts/revert-wedding-dresses.ts          # dry run
 *   npx tsx scripts/revert-wedding-dresses.ts --apply  # write
 *   then: npx tsx scripts/shopify-push.ts --apply      # re-push the 'updated' set
 */
import { getAdminClient } from "./_supabase-admin";

const BAD = "Wedding-Dresses";
const GOOD = "Seasonal";

function fix(tags: string[] | null): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) out.add(t === BAD ? GOOD : t);
  return [...out].sort();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getAdminClient();

  const { data, error } = await sb
    .from("designs")
    .select("design_family,status,approved_tags,shopify_tags,shopify_product_ids")
    .contains("approved_tags", [BAD])
    .order("design_family");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    design_family: string;
    status: string;
    approved_tags: string[] | null;
    shopify_tags: string[] | null;
    shopify_product_ids: number[] | null;
  }>;

  let willRequeue = 0;
  let dbOnly = 0;
  for (const d of rows) {
    if (d.status === "updated" && (d.shopify_product_ids?.length ?? 0) > 0) willRequeue++;
    else dbOnly++;
  }

  console.log(`Designs with "${BAD}" in approved_tags: ${rows.length}`);
  console.log(`  will fix DB + requeue for Shopify re-push (status updated): ${willRequeue}`);
  console.log(`  will fix DB only (other status / no product ids):          ${dbOnly}`);
  console.log("\n  examples:");
  for (const d of rows.slice(0, 5)) {
    console.log(`    ${d.design_family.padEnd(10)} [${d.status}] ${fix(d.approved_tags).join(", ")}`);
  }

  if (!apply) {
    console.log("\nDry run — no writes. Re-run with --apply.");
    return;
  }

  let done = 0;
  for (const d of rows) {
    const approved = fix(d.approved_tags);
    const shopify = fix(d.shopify_tags);
    const requeue = d.status === "updated" && (d.shopify_product_ids?.length ?? 0) > 0;
    const update: Record<string, unknown> = { approved_tags: approved, shopify_tags: shopify };
    if (requeue) update.status = "readytosend";

    const { error: upErr } = await sb.from("designs").update(update).eq("design_family", d.design_family);
    if (upErr) throw new Error(`${d.design_family}: ${upErr.message}`);
    await sb.from("events").insert({
      design_family: d.design_family,
      event_type: "tag_renamed",
      actor: "system",
      payload: { from: BAD, to: GOOD, source: "manual_revert", requeued: requeue },
    });
    done++;
    if (done % 50 === 0) process.stdout.write(`  ${done}/${rows.length}\r`);
  }
  console.log(`\nReverted ${done} designs. ${willRequeue} queued as readytosend.`);
  console.log("Next: npx tsx scripts/shopify-push.ts --apply");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
