/**
 * READ-ONLY verification of the banner/doormat split (T1).
 *
 * Checks, across all non-excluded AF families:
 *   1. No flag family (AF<body>) carries a GB/DR variant SKU.
 *   2. No banner/doormat family (AFGB/AFDR<body>) carries a flag SKU.
 *   3. Spot-checks named families (default: AFMS0006, AFGBSP0023, AFGBSP0016).
 *   4. Duplicate check: no AFGB/AFDR family whose SKUs also live elsewhere.
 *
 * Usage: npx tsx scripts/verify-banner-doormat-split.ts [families…]
 */
import { getAdminClient } from "./_supabase-admin";

interface Row {
  design_family: string;
  design_name: string | null;
  status: string;
  variant_skus: string[] | null;
}

const isGbDr = (sku: string) => /^AF(GB|DR)/i.test(sku);
const famIsGbDr = (f: string) => /^AF(GB|DR)/i.test(f);

async function main() {
  const spot = process.argv.slice(2);
  if (!spot.length) spot.push("AFMS0006", "AFGBSP0023", "AFGBSP0016");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,variant_skus")
      .neq("status", "excluded")
      .like("design_family", "AF%")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }
  console.log(`AF non-excluded families: ${rows.length}\n`);

  // 1 + 2: misfiled SKUs
  let bad1 = 0, bad2 = 0;
  for (const r of rows) {
    const skus = r.variant_skus ?? [];
    if (!famIsGbDr(r.design_family)) {
      const stray = skus.filter(isGbDr);
      if (stray.length) { bad1++; console.log(`  ✗ flag family ${r.design_family} still has: ${stray.join(", ")}`); }
    } else {
      const stray = skus.filter((s) => !isGbDr(s));
      if (stray.length) { bad2++; console.log(`  ✗ ${r.design_family} has non-GB/DR SKUs: ${stray.join(", ")}`); }
    }
  }
  console.log(`Check 1 — GB/DR SKUs inside flag families:      ${bad1 === 0 ? "✓ none" : `✗ ${bad1} families`}`);
  console.log(`Check 2 — flag SKUs inside GB/DR families:      ${bad2 === 0 ? "✓ none" : `✗ ${bad2} families`}`);

  // 4: same SKU in two families
  const seen = new Map<string, string>();
  let dupes = 0;
  for (const r of rows) {
    for (const s of r.variant_skus ?? []) {
      const prev = seen.get(s);
      if (prev && prev !== r.design_family) { dupes++; console.log(`  ✗ SKU ${s} in both ${prev} and ${r.design_family}`); }
      seen.set(s, r.design_family);
    }
  }
  console.log(`Check 3 — SKUs claimed by two families:         ${dupes === 0 ? "✓ none" : `✗ ${dupes}`}`);

  // Spot checks
  console.log("\nSpot checks:");
  for (const f of spot) {
    const r = rows.find((x) => x.design_family === f);
    if (!r) { console.log(`  ${f}: not found (may be excluded or absent)`); continue; }
    console.log(`  ${f} [${r.status}] "${r.design_name ?? ""}" skus=[${(r.variant_skus ?? []).join(", ")}]`);
  }

  // Counts
  const gb = rows.filter((r) => /^AFGB/i.test(r.design_family)).length;
  const dr = rows.filter((r) => /^AFDR/i.test(r.design_family)).length;
  const flagged = rows.filter((r) => r.status === "flagged").length;
  console.log(`\nAFGB families: ${gb} · AFDR families: ${dr} · flagged (AF, non-excl): ${flagged}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
