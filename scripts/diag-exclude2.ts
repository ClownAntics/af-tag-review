/**
 * Dry-run the two exclusion sets, read-only:
 *  A) accessories / flag poles  (from shopify_product_types + title)
 *  B) lifecycle statuses via td_product join (SKU → designs.variant_skus)
 *
 * For B, a design family can hold several SKUs. Report both rules:
 *   strict = ALL matched SKUs are excludable (no live variant left)
 *   loose  = ANY matched SKU is excludable
 * plus how well the SKU join even works.
 */
import { getAdminClient } from "./_supabase-admin";

const EXCLUDE_STATUS = new Set([
  "out of stock - ca discontinued",
  "out of stock - discontinued",
  "donate",
  "inactive",
]);
const accRe = /accessor|flag\s*pole|flagpole/i;

async function main() {
  const sb = getAdminClient();

  // 1. td_product SKU -> status
  const skuStatus = new Map<string, string>();
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("td_product").select("SKU,Status").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as { SKU: string | null; Status: string | null }[];
    for (const r of b) if (r.SKU) skuStatus.set(r.SKU.trim(), (r.Status ?? "").trim());
    if (b.length < PAGE) break;
  }
  console.log(`td_product SKUs: ${skuStatus.size}`);

  // 2. designs (non-excluded)
  const designs: { design_family: string; design_name: string | null; status: string; manufacturer: string | null; variant_skus: string[] | null; shopify_product_types: string[] | null }[] = [];
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,manufacturer,variant_skus,shopify_product_types")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    designs.push(...(b as typeof designs));
    if (b.length < PAGE) break;
  }
  console.log(`non-excluded designs: ${designs.length}\n`);

  // ---- A) accessories / poles ----
  const accessory = designs.filter((d) =>
    (d.shopify_product_types ?? []).some((t) => accRe.test(t)) ||
    (d.design_name ? accRe.test(d.design_name) : false),
  );
  const accByMfr = new Map<string, number>();
  for (const d of accessory) accByMfr.set(d.manufacturer ?? "?", (accByMfr.get(d.manufacturer ?? "?") ?? 0) + 1);
  console.log(`A) accessory / flag-pole designs: ${accessory.length}`);
  for (const [m, n] of [...accByMfr.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${(m ?? "?").padEnd(14)} ${n}`);

  // ---- B) lifecycle via SKU join ----
  const skusFor = (d: typeof designs[number]) => {
    const s = (d.variant_skus ?? []).map((x) => x.trim()).filter(Boolean);
    return s.length ? s : [d.design_family.trim()];
  };
  let noMatch = 0, strict = 0, loose = 0, mixed = 0;
  const strictRows: typeof designs = [];
  const strictByMfr = new Map<string, number>();
  for (const d of designs) {
    const skus = skusFor(d);
    const matched = skus.filter((s) => skuStatus.has(s));
    if (matched.length === 0) { noMatch++; continue; }
    const exc = matched.filter((s) => EXCLUDE_STATUS.has((skuStatus.get(s) ?? "").toLowerCase()));
    if (exc.length === matched.length) { strict++; strictRows.push(d); strictByMfr.set(d.manufacturer ?? "?", (strictByMfr.get(d.manufacturer ?? "?") ?? 0) + 1); }
    if (exc.length > 0) loose++;
    if (exc.length > 0 && exc.length < matched.length) mixed++;
  }
  console.log(`\nB) lifecycle join:`);
  console.log(`   designs with NO SKU match in td_product: ${noMatch}`);
  console.log(`   STRICT (all matched SKUs excludable):    ${strict}`);
  console.log(`   LOOSE  (any matched SKU excludable):     ${loose}`);
  console.log(`   MIXED  (some excludable, some live):     ${mixed}`);
  console.log(`   → STRICT by manufacturer:`);
  for (const [m, n] of [...strictByMfr.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${(m ?? "?").padEnd(14)} ${n}`);

  // Combined unique (A ∪ B-strict)
  const fams = new Set([...accessory.map((d) => d.design_family), ...strictRows.map((d) => d.design_family)]);
  console.log(`\nCombined unique to exclude (A ∪ B-strict): ${fams.size}`);

  // sample mixed for sanity
  console.log("\nSample MIXED families (kept under strict):");
  let shown = 0;
  for (const d of designs) {
    if (shown >= 6) break;
    const skus = skusFor(d);
    const matched = skus.filter((s) => skuStatus.has(s));
    if (!matched.length) continue;
    const exc = matched.filter((s) => EXCLUDE_STATUS.has((skuStatus.get(s) ?? "").toLowerCase()));
    if (exc.length > 0 && exc.length < matched.length) {
      console.log(`  ${d.design_family}: ${matched.map((s) => `${s}=${skuStatus.get(s)}`).join(", ")}`);
      shown++;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
