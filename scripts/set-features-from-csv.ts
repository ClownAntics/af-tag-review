/**
 * Populate the storefront Feature boolean columns on `designs` from the
 * FL Product Export CSV. The TeamDesk feature booleans aren't in the
 * synced td_product table, so the CSV is the source.
 *
 * CSV is product/variant level. We roll each feature up to design_family:
 * a family gets the flag if ANY of its variant SKUs has it true.
 *
 * SKU → family mapping: built from designs.variant_skus (case-insensitive),
 * with skuToAfDesignFamily as a fallback for AF variants not in the column.
 *
 * SPECIAL CASE — is_reversible: AF flags are double-sided but NOT
 * reversible. The CSV's isFlag_Reversible? is wrong for AF (~11k flagged
 * true). We force is_reversible = false for every AF family regardless of
 * what the CSV says.
 *
 * Requires migration 012_feature_flags.sql applied first.
 *
 * Usage:
 *   npx tsx scripts/set-features-from-csv.ts          # dry-run
 *   npx tsx scripts/set-features-from-csv.ts --apply  # commit
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { getAdminClient } from "./_supabase-admin";
import { skuToAfDesignFamily } from "../lib/shopify";

const CSV =
  "C:/Users/gbcab/Downloads/Products_FL Product Export_20260615135328.csv";

// CSV column → designs column
const FEATURES: { csv: string; col: string }[] = [
  { csv: "isFlag_Reversible?", col: "is_reversible" },
  { csv: "isSuedeReflections?", col: "is_suede_reflections" },
  { csv: "isPremierSoft?", col: "is_premiersoft" },
  { csv: "isFlag_GlitterTrends?", col: "is_glittertrends" },
  { csv: "isPrintedInUsa?", col: "is_printed_in_usa" },
  { csv: "isEnvirofriendly?", col: "is_envirofriendly" },
];

const isTrue = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  // 1. Build SKU → family + family → manufacturer maps from designs.
  const skuToFamily = new Map<string, string>();
  const familyMfr = new Map<string, string | null>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,variant_skus,manufacturer")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      design_family: string;
      variant_skus: string[] | null;
      manufacturer: string | null;
    }>;
    for (const r of rows) {
      familyMfr.set(r.design_family, r.manufacturer);
      for (const vs of r.variant_skus ?? [])
        if (vs) skuToFamily.set(vs.toUpperCase(), r.design_family);
    }
    if (rows.length < PAGE) break;
  }
  console.log(`designs: ${familyMfr.size} families, ${skuToFamily.size} variant SKUs mapped.`);

  // 2. Parse CSV, roll each feature up to family.
  const sets: Record<string, Set<string>> = {};
  for (const f of FEATURES) sets[f.col] = new Set();
  let csvRows = 0;
  let mapped = 0;
  let unmapped = 0;

  const parser = createReadStream(CSV).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true }),
  );
  for await (const row of parser) {
    csvRows++;
    const r = row as Record<string, string>;
    const sku = (r["SKU"] ?? "").trim();
    if (!sku) continue;
    const up = sku.toUpperCase();
    const family = skuToFamily.get(up) ?? skuToAfDesignFamily(up);
    if (!family || !familyMfr.has(family)) {
      unmapped++;
      continue;
    }
    mapped++;
    for (const f of FEATURES) if (isTrue(r[f.csv])) sets[f.col].add(family);
  }
  console.log(`CSV: ${csvRows} rows, ${mapped} mapped to a design family, ${unmapped} unmapped (non-flag / not in catalog).`);

  // 3. is_reversible override — strip AF families.
  let afStripped = 0;
  for (const family of [...sets["is_reversible"]]) {
    if (familyMfr.get(family) === "AF") {
      sets["is_reversible"].delete(family);
      afStripped++;
    }
  }

  console.log("\nFamilies per feature (post-rollup):");
  for (const f of FEATURES)
    console.log(`  ${f.col.padEnd(22)} ${sets[f.col].size}`);
  console.log(`  (is_reversible stripped ${afStripped} AF families — AF flags are not reversible)`);

  if (!apply) {
    console.log("\nDRY-RUN. Re-run with --apply to commit.");
    return;
  }

  console.log("\nApplying…");
  for (const f of FEATURES) {
    const families = [...sets[f.col]];
    let done = 0;
    for (let i = 0; i < families.length; i += 200) {
      const slice = families.slice(i, i + 200);
      const { error } = await sb
        .from("designs")
        .update({ [f.col]: true })
        .in("design_family", slice);
      if (error) throw new Error(`update ${f.col} at ${i}: ${error.message}`);
      done += slice.length;
    }
    console.log(`  ${f.col.padEnd(22)} set true on ${done}`);
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
