/**
 * READ-ONLY diagnostic: what drives storefront facets (Size / Material /
 * Double Sided)? Fetches sample products from a garden-flags collection and
 * lists their metafields. GET requests only — never writes.
 *
 * Usage: npx tsx scripts/diag-facets-readonly.ts
 */
import "./_supabase-admin"; // side-effect: loads .env.local

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!STORE || !TOKEN) throw new Error("Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");
const BASE = `https://${STORE}.myshopify.com/admin/api/2025-01`;

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Shopify-Access-Token": TOKEN! },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  // 0. Shop info (domains)
  const shop = await get("/shop.json");
  console.log(
    `Shop: ${shop.shop.name} | myshopify: ${shop.shop.myshopify_domain} | primary domain: ${shop.shop.domain}`,
  );

  // 1. Find a garden-flags-ish collection (custom + smart)
  const [cc, sc] = await Promise.all([
    get("/custom_collections.json?limit=250&fields=id,handle,title"),
    get("/smart_collections.json?limit=250&fields=id,handle,title"),
  ]);
  const collections = [
    ...(cc.custom_collections ?? []),
    ...(sc.smart_collections ?? []),
  ];
  console.log(`Collections total: ${collections.length}`);
  const gardenish = collections.filter((c: any) =>
    /garden|patriotic|flag/i.test(c.handle + " " + c.title),
  );
  console.log("Flag-ish collections (first 20):");
  for (const c of gardenish.slice(0, 20)) console.log(`  ${c.id}  ${c.handle}  "${c.title}"`);

  // 2. Try candidate collections until one has products
  const candidates = [
    ...gardenish.filter((c: any) => /garden-flag/i.test(c.handle)),
    ...gardenish,
  ];
  let products: any[] = [];
  for (const c of candidates.slice(0, 10)) {
    const prods = await get(
      `/collections/${c.id}/products.json?limit=5&fields=id,title,handle,tags,product_type,options`,
    );
    console.log(`\nCollection ${c.handle}: ${prods.products?.length ?? 0} products returned`);
    if (prods.products?.length) {
      products = prods.products;
      break;
    }
  }
  for (const p of products) {
    console.log(`\n=== PRODUCT ${p.id} "${p.title}" (${p.handle}) ===`);
    console.log(`  type: ${p.product_type}`);
    console.log(`  options: ${JSON.stringify(p.options?.map((o: any) => ({ name: o.name, values: o.values })))}`);
    console.log(`  tags: ${p.tags}`);
    const mf = await get(`/products/${p.id}/metafields.json?limit=250`);
    if (!mf.metafields?.length) {
      console.log("  metafields: (none)");
      continue;
    }
    for (const m of mf.metafields) {
      const val = String(m.value);
      console.log(
        `  metafield ${m.namespace}.${m.key} [${m.type}] = ${val.length > 160 ? val.slice(0, 160) + "…" : val}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
