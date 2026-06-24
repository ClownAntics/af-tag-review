/**
 * Locate which field carries (a) accessory / flag-pole products and
 * (b) the lifecycle statuses "Out of Stock - CA Discontinued",
 * "Out of Stock - Discontinued", "Donate", "Inactive" — so we know exactly
 * what to exclude. Read-only.
 */
import { getAdminClient } from "./_supabase-admin";

const LIFECYCLE = ["out of stock - ca discontinued", "out of stock - discontinued", "donate", "inactive"];

async function main() {
  const sb = getAdminClient();
  const rows: {
    design_family: string;
    design_name: string | null;
    status: string;
    classification: string | null;
    product_types: string[] | null;
    shopify_product_types: string[] | null;
    shopify_tags: string[] | null;
    manufacturer: string | null;
  }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,classification,product_types,shopify_product_types,shopify_tags,manufacturer")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }
  console.log(`Scanned ${rows.length} non-excluded designs.\n`);

  // --- distinct classification ---
  const cls = new Map<string, number>();
  for (const r of rows) cls.set(r.classification ?? "(null)", (cls.get(r.classification ?? "(null)") ?? 0) + 1);
  console.log("classification values:");
  for (const [c, n] of [...cls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(c).padEnd(34)} ${n}`);

  // --- where do the lifecycle strings appear? ---
  const fieldHit = (vals: (string | null)[] | null) =>
    (vals ?? []).some((v) => v && LIFECYCLE.includes(v.toLowerCase().trim()));
  console.log("\nLifecycle strings found in:");
  console.log(`  classification:        ${rows.filter((r) => r.classification && LIFECYCLE.includes(r.classification.toLowerCase().trim())).length}`);
  console.log(`  shopify_tags:          ${rows.filter((r) => fieldHit(r.shopify_tags)).length}`);
  console.log(`  product_types:         ${rows.filter((r) => fieldHit(r.product_types)).length}`);
  console.log(`  shopify_product_types: ${rows.filter((r) => fieldHit(r.shopify_product_types)).length}`);

  // broader: any tag containing these words
  const wordRe = /out of stock|discontinu|donate|inactive/i;
  const tagMatches = new Map<string, number>();
  for (const r of rows) for (const t of r.shopify_tags ?? []) if (wordRe.test(t)) tagMatches.set(t, (tagMatches.get(t) ?? 0) + 1);
  console.log("\nshopify_tags matching /out of stock|discontinu|donate|inactive/i:");
  if (!tagMatches.size) console.log("  (none)");
  for (const [t, n] of [...tagMatches.entries()].sort((a, b) => b[1] - a[1])) console.log(`  "${t}"  ${n}`);

  // --- accessory / flag pole ---
  const accRe = /accessor|flag\s*pole|flagpole/i;
  console.log("\nAccessory / flag-pole signal counts:");
  const inTypes = rows.filter((r) => [...(r.shopify_product_types ?? []), ...(r.product_types ?? [])].some((t) => accRe.test(t)));
  const inName = rows.filter((r) => r.design_name && accRe.test(r.design_name));
  console.log(`  matched in product_types:  ${inTypes.length}`);
  console.log(`  matched in design_name:    ${inName.length}`);
  // distinct product_type strings that match
  const accTypes = new Map<string, number>();
  for (const r of rows) for (const t of [...(r.shopify_product_types ?? []), ...(r.product_types ?? [])]) if (accRe.test(t)) accTypes.set(t, (accTypes.get(t) ?? 0) + 1);
  console.log("  distinct matching product_type strings:");
  for (const [t, n] of [...accTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    "${t}"  ${n}`);
  console.log("  sample names matched only by title:");
  for (const r of inName.filter((r) => ![...(r.shopify_product_types ?? []), ...(r.product_types ?? [])].some((t) => accRe.test(t))).slice(0, 12))
    console.log(`    ${r.design_family}: ${r.design_name}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
