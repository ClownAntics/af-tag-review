/**
 * Exclude "phantom" designs — rows in our DB (from the TeamDesk/sales import)
 * that have NO Shopify product (empty shopify_product_ids). They can't be
 * tag-pushed and aren't real Shopify listings, so they clutter the pipeline.
 * Reversible via the ↩ Include button if a real Shopify listing appears later.
 *
 * Usage: npx tsx scripts/exclude-phantoms.ts [--apply]
 */
import { getAdminClient } from "./_supabase-admin";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  const rows: { design_family: string; design_name: string | null; status: string; units_total: number | null; shopify_product_ids: number[] | null; variant_skus: string[] | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("designs").select("design_family,design_name,status,units_total,shopify_product_ids,variant_skus").neq("status", "excluded").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }
  const phantoms = rows.filter((r) => !(r.shopify_product_ids ?? []).length);
  console.log(`Phantom designs (no Shopify product): ${phantoms.length}\n`);
  for (const p of phantoms) console.log(`  ${p.design_family.padEnd(12)} [${p.status}] units=${p.units_total ?? 0}  ${p.design_name ?? ""}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to exclude."); return; }
  const fams = phantoms.map((p) => p.design_family);
  for (let i = 0; i < fams.length; i += 200) {
    const slice = fams.slice(i, i + 200);
    const { error } = await sb.from("designs").update({ status: "excluded" }).in("design_family", slice);
    if (error) throw error;
  }
  await sb.from("events").insert(phantoms.map((p) => ({ design_family: p.design_family, event_type: "excluded", actor: "blake", payload: { reason: "no_shopify_product", from_status: p.status } })));
  console.log(`\nExcluded ${fams.length} phantom designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
