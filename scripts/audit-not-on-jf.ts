/**
 * Stream the live JF Shopify catalog, compute the set of design_families
 * currently present there, and find designs in Supabase whose family is NOT
 * in that set. Distinct from shopify_product_ids because that column is
 * populated by the last pull and can go stale when products are deleted or
 * archived on Shopify.
 *
 * Usage:
 *   npx tsx scripts/audit-not-on-jf.ts            # dry-run, writes CSV
 *   npx tsx scripts/audit-not-on-jf.ts --apply    # deletes the not-on-JF rows
 *
 * Deletion cascades to events + design_monthly_sales via FK (see migration 002).
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { listProducts, productToFamily } from "../lib/shopify";

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getAdminClient();

  // 1. Live Shopify side — build the set of design_families JF actually has.
  console.log("[audit] streaming JF Shopify catalog…");
  const liveFamilies = new Set<string>();
  let productsSeen = 0;
  for await (const p of listProducts()) {
    productsSeen++;
    const resolved = productToFamily(p);
    if (resolved) liveFamilies.add(resolved.design_family);
    if (productsSeen % 500 === 0) {
      console.log(
        `  … ${productsSeen} products, ${liveFamilies.size} families so far`,
      );
    }
  }
  console.log(
    `[audit] done: ${productsSeen} products → ${liveFamilies.size} unique design_families on JF.`,
  );
  console.log();

  // 2. DB side — page through ALL designs (Supabase caps selects at 1000).
  console.log("[audit] loading all designs from Supabase…");
  type Row = {
    design_family: string;
    design_name: string | null;
    manufacturer: string | null;
    status: string | null;
    units_total: number;
    last_sale_date: string | null;
    shopify_product_ids: number[] | null;
    shopify_tags: string[] | null;
    approved_tags: string[] | null;
  };
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,design_name,manufacturer,status,units_total,last_sale_date,shopify_product_ids,shopify_tags,approved_tags",
      )
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
  }
  console.log(`[audit] loaded ${rows.length} designs.`);
  console.log();

  // 3. Diff: designs whose family isn't on live JF.
  const notOnJf = rows.filter((r) => !liveFamilies.has(r.design_family));

  console.log(`Total designs in DB:          ${rows.length}`);
  console.log(`On live JF:                   ${rows.length - notOnJf.length}`);
  console.log(`NOT on live JF:               ${notOnJf.length}`);
  console.log();

  const withSales = notOnJf.filter((r) => r.units_total > 0);
  const zeroSales = notOnJf.filter((r) => r.units_total === 0);
  const totalUnits = withSales.reduce((s, r) => s + r.units_total, 0);
  console.log(`  with historical sales:      ${withSales.length} (${totalUnits.toLocaleString()} total units)`);
  console.log(`  zero sales:                 ${zeroSales.length}`);
  console.log();

  const byStatus = new Map<string, number>();
  for (const r of notOnJf) {
    const k = r.status ?? "(null)";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  console.log("  by status:");
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(14)} ${v}`);
  }
  console.log();

  const byMfr = new Map<string, number>();
  for (const r of notOnJf) {
    const k = r.manufacturer ?? "(null)";
    byMfr.set(k, (byMfr.get(k) ?? 0) + 1);
  }
  console.log("  by manufacturer:");
  for (const [k, v] of [...byMfr.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(14)} ${v}`);
  }
  console.log();

  const hasShopifyTags = notOnJf.filter(
    (r) => (r.shopify_tags ?? []).length > 0,
  );
  const hasApproved = notOnJf.filter((r) => (r.approved_tags ?? []).length > 0);
  const hasStaleIds = notOnJf.filter(
    (r) => (r.shopify_product_ids ?? []).length > 0,
  );
  console.log(`  have non-empty shopify_tags anyway:       ${hasShopifyTags.length}`);
  console.log(`  have non-empty approved_tags:             ${hasApproved.length}`);
  console.log(`  have stale shopify_product_ids populated: ${hasStaleIds.length}`);
  console.log();

  console.log("Top 20 NOT-on-JF by units:");
  const top = [...notOnJf]
    .sort((a, b) => b.units_total - a.units_total)
    .slice(0, 20);
  for (const r of top) {
    console.log(
      `  ${r.design_family.padEnd(14)} ${String(r.units_total).padStart(6)}u  ${r.status?.padEnd(12) ?? ""}  ${r.manufacturer?.padEnd(8) ?? ""}  ${r.design_name ?? ""}`,
    );
  }
  console.log();

  // 4. Write full list as CSV so we can review before deletion.
  const csv = [
    "design_family,manufacturer,status,units_total,last_sale_date,design_name",
  ];
  for (const r of [...notOnJf].sort((a, b) => b.units_total - a.units_total)) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    csv.push(
      [
        r.design_family,
        r.manufacturer ?? "",
        r.status ?? "",
        String(r.units_total),
        r.last_sale_date ?? "",
        esc(r.design_name ?? ""),
      ].join(","),
    );
  }
  writeFileSync("not_on_jf.csv", csv.join("\n"), "utf8");
  console.log(`[audit] wrote not_on_jf.csv (${notOnJf.length} rows).`);

  if (!apply) {
    console.log();
    console.log("DRY-RUN. Re-run with --apply to delete these rows.");
    return;
  }

  console.log();
  console.log(`[apply] deleting ${notOnJf.length} designs (cascades to events + design_monthly_sales)…`);
  const families = notOnJf.map((r) => r.design_family);
  const chunk = 100;
  let deleted = 0;
  for (let i = 0; i < families.length; i += chunk) {
    const slice = families.slice(i, i + chunk);
    const { error, count } = await sb
      .from("designs")
      .delete({ count: "exact" })
      .in("design_family", slice);
    if (error) throw new Error(`delete batch at ${i}: ${error.message}`);
    deleted += count ?? 0;
    console.log(`  deleted ${deleted}/${families.length}`);
  }
  console.log(`[apply] done. ${deleted} rows deleted.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
