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
  productTypes: Set<string>;
  variantSkus: Set<string>;
  /** First non-empty image URL seen for the family — used as the preview. */
  imageUrl: string | null;
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
    const pt = (p.product_type ?? "").trim();
    const skus = (p.variants ?? [])
      .map((v) => (v.sku ?? "").trim())
      .filter(Boolean);
    const img = p.image?.src ?? null;

    const existing = byFamily.get(resolved.design_family);
    if (existing) {
      for (const t of tags) existing.tags.add(t);
      existing.productIds.add(p.id);
      if (pt) existing.productTypes.add(pt);
      for (const s of skus) existing.variantSkus.add(s);
      if (!existing.imageUrl && img) existing.imageUrl = img;
    } else {
      byFamily.set(resolved.design_family, {
        design_family: resolved.design_family,
        design_name: p.title,
        manufacturer: resolved.manufacturer,
        tags: new Set(tags),
        productIds: new Set([p.id]),
        productTypes: pt ? new Set([pt]) : new Set(),
        variantSkus: new Set(skus),
        imageUrl: img,
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
    productTypes: string[];
    variantSkus: string[];
    imageUrl: string | null;
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
      productTypes: [...agg.productTypes].sort(),
      variantSkus: [...agg.variantSkus].sort(),
      imageUrl: agg.imageUrl,
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
      shopify_product_types: d.productTypes,
      variant_skus: d.variantSkus,
      image_url: d.imageUrl,
    }));
  if (inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += 200) {
      const batch = inserts.slice(i, i + 200);
      const { error } = await sb.from("designs").insert(batch);
      if (error) throw new Error(`insert batch at ${i}: ${error.message}`);
      console.log(`  inserted ${Math.min(i + 200, inserts.length)}/${inserts.length} new designs`);
    }
  }
  // Updates include tag refreshes, product-id backfill, AND product-type
  // backfill: any existing row whose current shopify_product_ids /
  // shopify_product_types doesn't match the Shopify-side set needs to be
  // rewritten. Doing all three in one pass.
  const existingProductIds = new Map<string, number[]>();
  const existingProductTypes = new Map<string, string[]>();
  const existingVariantSkus = new Map<string, string[]>();
  const existingImageUrl = new Map<string, string | null>();
  for (let i = 0; i < families.length; i += chunk) {
    const slice = families.slice(i, i + chunk);
    const { data } = await sb
      .from("designs")
      .select(
        "design_family,shopify_product_ids,shopify_product_types,variant_skus,image_url",
      )
      .in("design_family", slice);
    for (const r of data ?? []) {
      const row = r as {
        design_family: string;
        shopify_product_ids: number[] | null;
        shopify_product_types: string[] | null;
        variant_skus: string[] | null;
        image_url: string | null;
      };
      existingProductIds.set(
        row.design_family,
        (row.shopify_product_ids ?? []).slice().sort((a, b) => a - b),
      );
      existingProductTypes.set(
        row.design_family,
        (row.shopify_product_types ?? []).slice().sort(),
      );
      existingVariantSkus.set(
        row.design_family,
        (row.variant_skus ?? []).slice().sort(),
      );
      existingImageUrl.set(row.design_family, row.image_url ?? null);
    }
  }
  const arrayDiff = (a: string[], b: string[]): boolean =>
    a.length !== b.length || a.some((v, i) => v !== b[i]);
  const updates = diffs.filter((d) => {
    if (d.is_new) return false;
    if (d.changed) return true;
    const curIds = existingProductIds.get(d.design_family) ?? [];
    if (curIds.length !== d.productIds.length) return true;
    if (curIds.some((id, i) => id !== d.productIds[i])) return true;
    const curTypes = existingProductTypes.get(d.design_family) ?? [];
    if (arrayDiff(curTypes, d.productTypes)) return true;
    const curSkus = existingVariantSkus.get(d.design_family) ?? [];
    if (arrayDiff(curSkus, d.variantSkus)) return true;
    const curImg = existingImageUrl.get(d.design_family) ?? null;
    return curImg !== d.imageUrl;
  });
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    // Retry transient network/Supabase errors a few times before giving up.
    // The script is idempotent (drift check skips already-updated rows on
    // re-run) but it's annoying to lose the in-flight progress to a single
    // flaky connection.
    let lastErr: unknown = null;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const { error } = await sb
          .from("designs")
          .update({
            shopify_tags: u.after,
            shopify_product_ids: u.productIds,
            shopify_product_types: u.productTypes,
            variant_skus: u.variantSkus,
            image_url: u.imageUrl,
          })
          .eq("design_family", u.design_family);
        if (error) {
          lastErr = error;
        } else {
          ok = true;
          break;
        }
      } catch (e) {
        lastErr = e;
      }
      // Exponential backoff: 500ms, 1.5s, 4.5s
      await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt)));
    }
    if (!ok) {
      const msg =
        lastErr && typeof lastErr === "object" && "message" in lastErr
          ? (lastErr as { message: string }).message
          : String(lastErr);
      throw new Error(`update ${u.design_family} (after retries): ${msg}`);
    }
    if ((i + 1) % 50 === 0 || i === updates.length - 1) {
      console.log(`  updated ${i + 1}/${updates.length} designs`);
    }
  }
  console.log(`[pull] applied: +${inserts.length} new, ~${updates.length} updates (tag and/or product-id refresh).`);

  // ─── Orphan detection ──────────────────────────────────────────────
  // A design becomes "orphaned" when EVERY one of its
  // `shopify_product_ids` references a product Shopify no longer returns.
  // That means the products got deleted/unpublished on the Shopify side
  // and a `push` would 404. Auto-exclude these so they stop appearing in
  // the No-vision / Ready-to-send queues. Recoverable via the per-card
  // ↩ Include button on the Excluded tile if Shopify ever restores them.
  //
  // SAFETY: only run if the pull found at least 1000 families. If we got
  // fewer, the most likely cause is a partial pagination failure that
  // would otherwise cause us to mass-exclude live designs.
  const SAFE_MIN_FAMILIES = 1000;
  if (byFamily.size < SAFE_MIN_FAMILIES) {
    console.warn(
      `[pull] only ${byFamily.size} families found — skipping orphan check (safety threshold ${SAFE_MIN_FAMILIES}).`,
    );
    return;
  }

  const currentShopifyIds = new Set<number>();
  for (const agg of byFamily.values())
    for (const id of agg.productIds) currentShopifyIds.add(id);

  console.log(`\n[pull] scanning for orphaned designs (products deleted from Shopify)…`);
  const orphans: Array<{ design_family: string; lost_product_ids: number[]; status: string }> = [];
  const orphanScanChunk = 1000;
  for (let offset = 0; ; offset += orphanScanChunk) {
    const { data, error: orphErr } = await sb
      .from("designs")
      .select("design_family,shopify_product_ids,status")
      .neq("status", "excluded")
      .not("shopify_product_ids", "is", null)
      .order("design_family")
      .range(offset, offset + orphanScanChunk - 1);
    if (orphErr) throw new Error(`orphan scan select: ${orphErr.message}`);
    const rows = (data ?? []) as Array<{
      design_family: string;
      shopify_product_ids: number[] | null;
      status: string;
    }>;
    for (const r of rows) {
      const ids = r.shopify_product_ids ?? [];
      if (ids.length === 0) continue;
      const live = ids.filter((id) => currentShopifyIds.has(id));
      if (live.length === 0) {
        orphans.push({
          design_family: r.design_family,
          lost_product_ids: ids,
          status: r.status,
        });
      }
    }
    if (rows.length < orphanScanChunk) break;
  }
  console.log(`[pull] found ${orphans.length} orphaned designs.`);
  if (orphans.length > 0) {
    for (const o of orphans.slice(0, 10)) {
      console.log(`  ${o.design_family.padEnd(20)} [${o.status}] lost=[${o.lost_product_ids.join(", ")}]`);
    }
    if (orphans.length > 10) console.log(`  …and ${orphans.length - 10} more.`);
  }

  if (orphans.length === 0) return;

  // Hard cap to prevent runaway exclusion if something pathological happens.
  // 5% of the catalog is a reasonable upper bound for a single sync.
  const totalNonExcluded = byFamily.size;
  const orphanCap = Math.max(50, Math.floor(totalNonExcluded * 0.05));
  if (orphans.length > orphanCap) {
    console.warn(
      `[pull] ${orphans.length} orphans exceeds safety cap of ${orphanCap} (5% of ${totalNonExcluded}). Skipping auto-exclude — investigate manually.`,
    );
    return;
  }

  console.log(`\n[pull] auto-excluding ${orphans.length} orphans…`);
  let excluded = 0;
  for (const o of orphans) {
    const { error: updErr } = await sb
      .from("designs")
      .update({ status: "excluded" })
      .eq("design_family", o.design_family);
    if (updErr) {
      console.warn(`  ${o.design_family}: failed — ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: o.design_family,
      event_type: "excluded",
      actor: "system",
      payload: {
        reason: "shopify_deleted",
        from_status: o.status,
        lost_product_ids: o.lost_product_ids,
      },
    });
    excluded++;
  }
  console.log(`[pull] excluded ${excluded}/${orphans.length} orphans.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
