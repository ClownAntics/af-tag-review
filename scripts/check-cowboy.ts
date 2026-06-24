/**
 * Inspect the "Cowboy Accessories" design (AFSU0200 / SKUs AFGFSU0200,
 * AFHFSU0200): our DB row + the live Shopify status of each product.
 * Read-only.
 */
import { getAdminClient } from "./_supabase-admin";

const API_VERSION = "2025-01";
async function shopifyProduct(id: number) {
  const store = process.env.SHOPIFY_STORE;
  const tok = process.env.SHOPIFY_ADMIN_TOKEN;
  const url = `https://${store}.myshopify.com/admin/api/${API_VERSION}/products/${id}.json?fields=id,title,status,handle,product_type`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok!, "Content-Type": "application/json" } });
  if (!res.ok) return { id, error: `${res.status} ${res.statusText}` };
  const j = (await res.json()) as { product: { id: number; title: string; status: string; product_type: string } };
  return j.product;
}

async function main() {
  const sb = getAdminClient();
  const { data } = await sb
    .from("designs")
    .select("design_family,design_name,status,approved_tags,shopify_tags,shopify_product_ids,shopify_product_types,variant_skus,last_pushed_at,last_reviewed_at")
    .or("design_family.eq.AFSU0200,design_name.ilike.%Cowboy Accessories%,variant_skus.cs.{AFGFSU0200}");
  if (!data?.length) { console.log("No matching design found."); return; }

  for (const d of data) {
    console.log(`\n=== ${d.design_family} — "${d.design_name}" ===`);
    console.log(`  our status: ${d.status}`);
    console.log(`  approved_tags(${(d.approved_tags ?? []).length}): ${(d.approved_tags ?? []).join(", ")}`);
    console.log(`  shopify_tags(${(d.shopify_tags ?? []).length}): ${(d.shopify_tags ?? []).slice(0, 12).join(", ")}`);
    console.log(`  product_types: ${(d.shopify_product_types ?? []).join(" | ")}`);
    console.log(`  variant_skus: ${(d.variant_skus ?? []).join(", ")}`);
    console.log(`  shopify_product_ids: ${(d.shopify_product_ids ?? []).join(", ")}`);
    console.log(`  last_pushed_at=${d.last_pushed_at} last_reviewed_at=${d.last_reviewed_at}`);
    console.log("  Shopify live status:");
    for (const id of d.shopify_product_ids ?? []) {
      const p = await shopifyProduct(id);
      console.log(`    ${JSON.stringify(p)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
