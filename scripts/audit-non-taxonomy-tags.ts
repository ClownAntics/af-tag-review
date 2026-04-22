/**
 * Audit-only: find tags in approved_tags / shopify_tags that are not in the
 * FL Themes taxonomy (lib/taxonomy.json). Reports frequencies so we can decide
 * what to clean up.
 *
 * Usage: npx tsx scripts/audit-non-taxonomy-tags.ts
 */
import { getAdminClient } from "./_supabase-admin";
import taxonomy from "../lib/taxonomy.json";

async function main() {
  const sb = getAdminClient();

  // Build case-insensitive set of valid taxonomy terms.
  const validTerms = new Set<string>();
  for (const e of (taxonomy as { entries: { term: string }[] }).entries) {
    validTerms.add(e.term.toLowerCase());
  }
  console.log(`Taxonomy terms: ${validTerms.size}`);
  console.log();

  // Page through designs.
  type Row = {
    design_family: string;
    status: string | null;
    approved_tags: string[] | null;
    shopify_tags: string[] | null;
  };
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags,shopify_tags")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
  }
  console.log(`Designs loaded: ${rows.length}`);
  console.log();

  function tally(
    getTags: (r: Row) => string[],
    onlyNonTaxonomy = true,
  ): Map<string, { count: number; families: string[] }> {
    const out = new Map<string, { count: number; families: string[] }>();
    for (const r of rows) {
      for (const t of getTags(r)) {
        const norm = t.trim();
        if (!norm) continue;
        if (onlyNonTaxonomy && validTerms.has(norm.toLowerCase())) continue;
        const hit = out.get(norm) ?? { count: 0, families: [] };
        hit.count++;
        if (hit.families.length < 5) hit.families.push(r.design_family);
        out.set(norm, hit);
      }
    }
    return out;
  }

  const approvedNonTax = tally((r) => r.approved_tags ?? []);
  const shopifyNonTax = tally((r) => r.shopify_tags ?? []);

  console.log("─── Non-taxonomy tags in approved_tags ───");
  const approvedSorted = [...approvedNonTax.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  );
  if (approvedSorted.length === 0) {
    console.log("  (none — clean)");
  } else {
    for (const [t, info] of approvedSorted) {
      console.log(
        `  ${String(info.count).padStart(5)}×  ${t.padEnd(30)}  e.g. ${info.families.slice(0, 3).join(", ")}`,
      );
    }
  }
  console.log();

  console.log("─── Non-taxonomy tags in shopify_tags (top 50) ───");
  const shopifySorted = [...shopifyNonTax.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  );
  for (const [t, info] of shopifySorted.slice(0, 50)) {
    console.log(
      `  ${String(info.count).padStart(5)}×  ${t.padEnd(30)}  e.g. ${info.families.slice(0, 3).join(", ")}`,
    );
  }
  if (shopifySorted.length > 50) {
    console.log(`  … ${shopifySorted.length - 50} more`);
  }
  console.log();

  // Focused look at in-stock / reversible variants (case-insensitive).
  const targets = /^(in[- ]?stock|reversi?ble|reversable)$/i;
  console.log("─── in-stock / reversible specifically ───");
  const byStatus = new Map<string, { approved: number; shopify: number }>();
  let inApprovedTotal = 0;
  let inShopifyTotal = 0;
  for (const r of rows) {
    const inA = (r.approved_tags ?? []).some((t) => targets.test(t));
    const inS = (r.shopify_tags ?? []).some((t) => targets.test(t));
    if (!inA && !inS) continue;
    if (inA) inApprovedTotal++;
    if (inS) inShopifyTotal++;
    const k = r.status ?? "(null)";
    const cur = byStatus.get(k) ?? { approved: 0, shopify: 0 };
    if (inA) cur.approved++;
    if (inS) cur.shopify++;
    byStatus.set(k, cur);
  }
  console.log(
    `  Designs with in-stock/reversible in approved_tags: ${inApprovedTotal}`,
  );
  console.log(
    `  Designs with in-stock/reversible in shopify_tags:  ${inShopifyTotal}`,
  );
  console.log(`  By status:`);
  for (const [k, v] of [...byStatus.entries()].sort()) {
    console.log(
      `    ${k.padEnd(14)} approved_tags=${v.approved}  shopify_tags=${v.shopify}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
