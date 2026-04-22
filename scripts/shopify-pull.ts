/**
 * Pull active+archived products from JFF Shopify, group variants by
 * design_family, and diff their tags against what we have in Supabase.
 *
 * Usage:
 *   npx tsx scripts/shopify-pull.ts              # full dry-run, prints CSV
 *   npx tsx scripts/shopify-pull.ts --limit 20   # smoke test on first 20 products
 *   npx tsx scripts/shopify-pull.ts --apply      # actually writes to Supabase
 *
 * Dry-run writes a CSV next to the script summarizing, per design_family:
 *   is_new | design_name | shopify_tags_before | shopify_tags_after
 * so you can eyeball before committing.
 *
 * --apply does two things:
 *   1. INSERTs new designs (manufacturer='AF', status='novision') for families
 *      Shopify has that Supabase doesn't.
 *   2. UPDATEs shopify_tags on existing designs when they differ.
 * It does NOT touch approved_tags, status (other than for inserts), vision_*,
 * or any review-pipeline field.
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { listProducts, productToFamily } from "../lib/shopify";

interface Args {
  limit: number | null;
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { limit: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

interface Aggregated {
  design_family: string;
  design_name: string;
  manufacturer: string;
  tags: Set<string>;
  productIds: Set<number>;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  // 1. Stream products from Shopify, filter to our SKU pattern, group by family.
  const byFamily = new Map<string, Aggregated>();
  let productsSeen = 0;
  let productsMatched = 0;
  const unmatchedSamples: string[] = [];

  console.log(
    `[pull] streaming products from Shopify (status=active,archived${args.limit ? `, limit=${args.limit}` : ""})…`,
  );
  for await (const p of listProducts({ max: args.limit ?? undefined })) {
    productsSeen++;
    const resolved = productToFamily(p);
    if (!resolved) {
      if (unmatchedSamples.length < 5) {
        unmatchedSamples.push(`(no SKU) ${p.title}`);
      }
      continue;
    }
    productsMatched++;
    const tags = (p.tags ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const existing = byFamily.get(resolved.design_family);
    if (existing) {
      for (const t of tags) existing.tags.add(t);
      existing.productIds.add(p.id);
    } else {
      byFamily.set(resolved.design_family, {
        design_family: resolved.design_family,
        design_name: p.title,
        manufacturer: resolved.manufacturer,
        tags: new Set(tags),
        productIds: new Set([p.id]),
      });
    }
    if (productsSeen % 100 === 0) {
      console.log(
        `  … ${productsSeen} products (${productsMatched} matched, ${byFamily.size} families)`,
      );
    }
  }
  console.log(
    `[pull] done streaming: ${productsSeen} products, ${productsMatched} matched our SKU pattern, ${byFamily.size} unique design_families.`,
  );
  if (unmatchedSamples.length > 0) {
    console.log(`[pull] skipped SKUs (first ${unmatchedSamples.length}):`);
    for (const s of unmatchedSamples) console.log(`    ${s}`);
  }

  // 2. Load current shopify_tags from Supabase for all matched families.
  const families = [...byFamily.keys()];
  console.log(`[pull] loading current DB state for ${families.length} families…`);
  const currentTags = new Map<string, string[]>();
  const existingFamilies = new Set<string>();
  const chunk = 500;
  for (let i = 0; i < families.length; i += chunk) {
    const slice = families.slice(i, i + chunk);
    const { data, error } = await sb
      .from("designs")
      .select("design_family,shopify_tags")
      .in("design_family", slice);
    if (error) throw error;
    for (const r of data ?? []) {
      const row = r as { design_family: string; shopify_tags: string[] | null };
      existingFamilies.add(row.design_family);
      currentTags.set(row.design_family, row.shopify_tags ?? []);
    }
  }

  // 3. Build diff rows.
  interface DiffRow {
    is_new: boolean;
    design_family: string;
    design_name: string;
    manufacturer: string;
    productIds: number[];
    before: string[];
    after: string[];
    changed: boolean;
  }
  const diffs: DiffRow[] = [];
  for (const agg of byFamily.values()) {
    const after = [...agg.tags].sort();
    const before = (currentTags.get(agg.design_family) ?? []).slice().sort();
    const changed =
      before.length !== after.length || before.some((b, i) => b !== after[i]);
    diffs.push({
      is_new: !existingFamilies.has(agg.design_family),
      design_family: agg.design_family,
      design_name: agg.design_name,
      manufacturer: agg.manufacturer,
      productIds: [...agg.productIds].sort((a, b) => a - b),
      before,
      after,
      changed,
    });
  }

  const newCount = diffs.filter((d) => d.is_new).length;
  const changedCount = diffs.filter((d) => !d.is_new && d.changed).length;
  const unchangedCount = diffs.filter((d) => !d.is_new && !d.changed).length;
  console.log(
    `[pull] diff: ${newCount} new designs, ${changedCount} tag changes, ${unchangedCount} unchanged.`,
  );

  // 4. Write CSV snapshot regardless of --apply.
  const csvPath = "shopify_pull_diff.csv";
  const lines = ["is_new,manufacturer,design_family,design_name,tags_before,tags_after"];
  for (const d of diffs) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    lines.push(
      [
        d.is_new ? "1" : "0",
        esc(d.manufacturer),
        esc(d.design_family),
        esc(d.design_name),
        esc(d.before.join(" | ")),
        esc(d.after.join(" | ")),
      ].join(","),
    );
  }
  writeFileSync(csvPath, lines.join("\n"), "utf8");
  console.log(`[pull] wrote ${csvPath} (${diffs.length} rows).`);

  if (!args.apply) {
    console.log("[pull] DRY-RUN. Re-run with --apply to write changes to Supabase.");
    return;
  }

  // 5. --apply: upsert new designs + update shopify_tags where changed.
  console.log("[pull] --apply: writing to Supabase…");
  const inserts = diffs
    .filter((d) => d.is_new)
    .map((d) => ({
      design_family: d.design_family,
      design_name: d.design_name,
      manufacturer: d.manufacturer,
      status: "novision",
      shopify_tags: d.after,
      shopify_product_ids: d.productIds,
    }));
  if (inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += 200) {
      const batch = inserts.slice(i, i + 200);
      const { error } = await sb.from("designs").insert(batch);
      if (error) throw new Error(`insert batch at ${i}: ${error.message}`);
      console.log(`  inserted ${Math.min(i + 200, inserts.length)}/${inserts.length} new designs`);
    }
  }
  // Updates include both tag refreshes AND product-id backfill: any existing
  // row whose current shopify_product_ids doesn't match the Shopify-side set
  // needs to be rewritten so push knows where to write. Doing both in one pass.
  const existingProductIds = new Map<string, number[]>();
  for (let i = 0; i < families.length; i += chunk) {
    const slice = families.slice(i, i + chunk);
    const { data } = await sb
      .from("designs")
      .select("design_family,shopify_product_ids")
      .in("design_family", slice);
    for (const r of data ?? []) {
      const row = r as { design_family: string; shopify_product_ids: number[] | null };
      existingProductIds.set(row.design_family, (row.shopify_product_ids ?? []).slice().sort((a, b) => a - b));
    }
  }
  const updates = diffs.filter((d) => {
    if (d.is_new) return false;
    if (d.changed) return true;
    const curIds = existingProductIds.get(d.design_family) ?? [];
    if (curIds.length !== d.productIds.length) return true;
    return curIds.some((id, i) => id !== d.productIds[i]);
  });
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const { error } = await sb
      .from("designs")
      .update({
        shopify_tags: u.after,
        shopify_product_ids: u.productIds,
      })
      .eq("design_family", u.design_family);
    if (error) throw new Error(`update ${u.design_family}: ${error.message}`);
    if ((i + 1) % 50 === 0 || i === updates.length - 1) {
      console.log(`  updated ${i + 1}/${updates.length} designs`);
    }
  }
  console.log(`[pull] applied: +${inserts.length} new, ~${updates.length} updates (tag and/or product-id refresh).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
