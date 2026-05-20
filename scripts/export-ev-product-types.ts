/**
 * One-off: export every design family whose Shopify `product_type` field
 * contains a raw EV-prefixed product id (e.g. "EV432556") instead of a real
 * category like "Sleeved Flags: …". These are misconfigured Shopify entries
 * — someone dumped the wrong column during a bulk import. The CSV is what
 * you hand to whoever maintains the Shopify catalog so they can fix it.
 *
 * Usage: npx tsx scripts/export-ev-product-types.ts
 *
 * Output: ev-product-type-fixes.csv in the project root.
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";

const EV_PATTERN = /^EV\d+$/;
const SHOPIFY_ADMIN_PRODUCT_URL =
  "https://admin.shopify.com/store/justforfunflags/products/";

interface Row {
  design_family: string;
  design_name: string | null;
  manufacturer: string | null;
  shopify_product_ids: number[] | null;
  shopify_product_types: string[] | null;
}

(async () => {
  const sb = getAdminClient();
  const matches: Array<{
    design_family: string;
    design_name: string;
    manufacturer: string;
    bad_values: string;
    good_values: string;
    product_ids: string;
    admin_urls: string;
  }> = [];

  const PAGE = 1000;
  let scanned = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,design_name,manufacturer,shopify_product_ids,shopify_product_types",
      )
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    scanned += rows.length;
    for (const r of rows) {
      const types = r.shopify_product_types ?? [];
      const bad = types.filter((t) => EV_PATTERN.test(t));
      if (bad.length === 0) continue;
      const good = types.filter((t) => !EV_PATTERN.test(t));
      const ids = r.shopify_product_ids ?? [];
      matches.push({
        design_family: r.design_family,
        design_name: r.design_name ?? "",
        manufacturer: r.manufacturer ?? "",
        bad_values: bad.join(" | "),
        good_values: good.join(" | "),
        product_ids: ids.join(" | "),
        admin_urls: ids.map((id) => `${SHOPIFY_ADMIN_PRODUCT_URL}${id}`).join(" | "),
      });
    }
    if (rows.length < PAGE) break;
  }

  const header = [
    "design_family",
    "design_name",
    "manufacturer",
    "bad_product_type",
    "other_product_types",
    "shopify_product_ids",
    "shopify_admin_urls",
  ];

  const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const lines = [header.join(",")];
  for (const m of matches) {
    lines.push(
      [
        esc(m.design_family),
        esc(m.design_name),
        esc(m.manufacturer),
        esc(m.bad_values),
        esc(m.good_values),
        esc(m.product_ids),
        esc(m.admin_urls),
      ].join(","),
    );
  }

  const out = "ev-product-type-fixes.csv";
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`Scanned ${scanned} designs.`);
  console.log(`Found ${matches.length} with EV-prefixed product_type values.`);
  console.log(`Wrote ${out}.`);
})();
