/**
 * Mop-up for revert-wedding-dresses.ts: clears "Wedding-Dresses" from designs
 * the main revert didn't touch — vision_tags (bogus suggestions) and any
 * shopify_tags occurrences without a matching approved_tags hit. Live
 * (status='updated') shopify_tags hits are requeued so shopify-push corrects
 * the store.
 *
 *   npx tsx scripts/revert-wedding-dresses-residual.ts --apply
 *   then (if any requeued): npx tsx scripts/shopify-push.ts --apply
 */
import { getAdminClient } from "./_supabase-admin";

const BAD = "Wedding-Dresses";
const GOOD = "Seasonal";

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getAdminClient();

  const { data, error } = await sb
    .from("designs")
    .select("design_family,status,vision_tags,shopify_tags,approved_tags,shopify_product_ids")
    .or(`vision_tags.cs.{"${BAD}"},shopify_tags.cs.{"${BAD}"}`);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    design_family: string; status: string;
    vision_tags: string[] | null; shopify_tags: string[] | null;
    approved_tags: string[] | null; shopify_product_ids: number[] | null;
  }>;

  let requeue = 0;
  console.log(`Residual designs with "${BAD}": ${rows.length}`);
  for (const d of rows) {
    const upd: Record<string, unknown> = {};
    if ((d.vision_tags ?? []).includes(BAD)) upd.vision_tags = d.vision_tags!.filter((t) => t !== BAD);
    if ((d.shopify_tags ?? []).includes(BAD)) {
      upd.shopify_tags = [...new Set(d.shopify_tags!.map((t) => (t === BAD ? GOOD : t)))].sort();
      // Make sure approved_tags reflects the fix too, then requeue if live.
      if ((d.approved_tags ?? []).includes(BAD)) {
        upd.approved_tags = [...new Set(d.approved_tags!.map((t) => (t === BAD ? GOOD : t)))].sort();
      }
      if (d.status === "updated" && (d.shopify_product_ids?.length ?? 0) > 0) {
        upd.status = "readytosend";
        requeue++;
      }
    }
    console.log(`  ${d.design_family.padEnd(10)} [${d.status}] ${Object.keys(upd).join(", ")}`);
    if (apply) {
      const { error: e } = await sb.from("designs").update(upd).eq("design_family", d.design_family);
      if (e) throw new Error(`${d.design_family}: ${e.message}`);
    }
  }
  console.log(apply ? `\nApplied. ${requeue} requeued for re-push.` : "\nDry run — re-run with --apply.");
}

main().catch((e) => { console.error(e); process.exit(1); });
