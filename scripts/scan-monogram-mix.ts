/**
 * READ-ONLY. Scopes the monogram-mix problem: AF families whose variant_skus
 * contain BOTH a base (non-monogram) SKU and lettered monogram SKUs
 * (…0001 vs …0001A/…0001B). The monogram letters are a different design from
 * the base (base has no monogram), so merging pollutes the base's tags
 * (letter-a, monogrammed on a non-monogram design).
 *
 * Buckets every non-excluded AF family:
 *   - mixed      : has base SKUs AND monogram SKUs  ← the problem set
 *   - mono-only  : only monogram SKUs (family probably fine, just monograms)
 *   - base-only  : no monogram SKUs (fine)
 *
 * Usage: npx tsx scripts/scan-monogram-mix.ts
 */
import { getAdminClient } from "./_supabase-admin";

// SKU tail after the 4-digit number: "" = base, single A-Z = monogram,
// "WH" = preprint (base), "-CF"/"-CD" = personalized (collapse w/ base).
function classify(sku: string): "base" | "mono" | "other" {
  const m = sku.toUpperCase().match(/^AF(GF|HF|GB|DR|MC)?[A-Z]{2}\d{4}(.*)$/);
  if (!m) return "other";
  let tail = m[2] ?? "";
  if (tail.endsWith("-CF") || tail.endsWith("-CD")) tail = tail.slice(0, -3);
  if (tail === "" || tail === "WH") return "base";
  if (/^[A-Z]$/.test(tail)) return "mono";
  return "other";
}

async function main() {
  const sb = getAdminClient();
  const rows: any[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,variant_skus,approved_tags")
      .neq("status", "excluded")
      .like("design_family", "AF%")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  const mixed: any[] = [];
  let monoOnly = 0, baseOnly = 0, weird: string[] = [];
  for (const r of rows) {
    const skus: string[] = r.variant_skus ?? [];
    const kinds = new Set(skus.map(classify));
    if (kinds.has("base") && kinds.has("mono")) mixed.push(r);
    else if (kinds.has("mono")) monoOnly++;
    else baseOnly++;
    for (const s of skus) if (classify(s) === "other") weird.push(`${r.design_family}: ${s}`);
  }

  console.log(`AF families scanned: ${rows.length}`);
  console.log(`  MIXED base+monogram (problem): ${mixed.length}`);
  console.log(`  monogram-only families:        ${monoOnly}`);
  console.log(`  base-only families:            ${baseOnly}`);
  console.log("");
  console.log(`--- mixed families (up to 25) ---`);
  for (const r of mixed.slice(0, 25)) {
    const skus: string[] = r.variant_skus ?? [];
    const base = skus.filter((s) => classify(s) === "base");
    const mono = skus.filter((s) => classify(s) === "mono");
    const monoTags = (r.approved_tags ?? []).filter((t: string) => /letter-|monogram/i.test(t));
    console.log(`  ${r.design_family} [${r.status}] "${r.design_name ?? ""}"`);
    console.log(`     base=${base.length} [${base.slice(0, 4).join(", ")}${base.length > 4 ? "…" : ""}]  mono=${mono.length}  monogram-ish tags on family: ${monoTags.join(", ") || "(none)"}`);
  }
  if (mixed.length > 25) console.log(`  … and ${mixed.length - 25} more`);
  if (weird.length) {
    console.log(`\n--- unparsed tails (${weird.length}, up to 10) ---`);
    for (const w of weird.slice(0, 10)) console.log(`  ${w}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
