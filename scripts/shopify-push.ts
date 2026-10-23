/**
 * Push curated tags to BOTH stores — JF (shopify_product_ids) and FL
 * (fl_product_ids). Per-design logic: lib/push-design.ts (shared with the
 * Push button). FL is skipped (and reported) if SHOPIFY_FL_ADMIN_TOKEN isn't
 * in .env.local.
 *
 * Usage:
 *   npx tsx scripts/shopify-push.ts              # dry-run CSV, no writes
 *   npx tsx scripts/shopify-push.ts --limit 5    # dry-run first 5 families
 *   npx tsx scripts/shopify-push.ts --apply      # actually PUT to Shopify
 *
 * Scope: every design with status='readytosend'. For each, look up its
 * shopify_product_ids (populated by scripts/shopify-pull.ts), and MERGE-push
 * tags (T7, 2026-07-03): only canonical taxonomy terms are owned/replaced by
 * the pipeline; every other live tag (brand `america-forever`, functional
 * `Garden Flag`, size/material, app tags) is preserved — smart collections
 * and the theme filter bar depend on them. Stale taxonomy tags on the
 * product are removed. AF families span multiple products; each gets the
 * same approved set merged against its own live tags.
 *
 * Dry-run writes shopify_push_diff.csv summarizing old vs new tags per
 * product. --apply then:
 *   1. Merge-pushes each JF and FL product (already-correct ones skipped)
 *   2. On success for ALL of a family's products on both stores: status →
 *      updated, last_pushed_at → now, events row logged
 *   3. On partial failure: status stays readytosend, an error event is logged
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { isStoreConfigured, normalizeTagKey } from "../lib/shopify";
import { getOwnedTaxonomyKeys } from "../lib/taxonomy-source";
import { OWNED_FACET_KEYS } from "../lib/facet-tags";
import { designEmitTags, pushDesign, PUSH_COLUMNS, type PushableDesign } from "../lib/push-design";

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

interface ReadyDesign extends PushableDesign {
  design_name: string;
  manufacturer: string | null;
  shopify_tags: string[] | null;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  console.log("[push] loading ready-to-send designs…");
  let q = sb
    .from("designs")
    .select(`${PUSH_COLUMNS},design_name,manufacturer,shopify_tags`)
    .eq("status", "readytosend")
    .order("design_family");
  if (args.limit) q = q.limit(args.limit);
  const { data, error } = await q;
  if (error) throw error;
  // Cast through unknown: PostgREST can't infer column types from a
  // concatenated select string (same pattern as the push route).
  const designs = (data ?? []) as unknown as ReadyDesign[];
  console.log(`[push] ${designs.length} designs in readytosend.`);

  const skipped: Array<{ family: string; reason: string }> = [];
  const plans: Array<{
    family: string;
    name: string;
    manufacturer: string | null;
    productIds: number[];
    flProductIds: number[];
    newTags: string[];
    oldTags: string[];
    design: ReadyDesign;
  }> = [];

  for (const d of designs) {
    const productIds = d.shopify_product_ids ?? [];
    const flProductIds = d.fl_product_ids ?? [];
    if (productIds.length === 0 && flProductIds.length === 0) {
      skipped.push({ family: d.design_family, reason: "not linked to JF or FL — re-run the catalog syncs" });
      continue;
    }
    // T5: curated theme tags ∪ family-level feature tags. Size/material are
    // per-product — computed inside mergeProductTags from each product's own
    // product_type (a family spans garden/house/mailbox types).
    const newTags = designEmitTags(d);
    if ((d.approved_tags ?? []).length === 0) {
      skipped.push({ family: d.design_family, reason: "approved_tags empty — won't push a blank tag set" });
      continue;
    }
    plans.push({
      family: d.design_family,
      name: d.design_name,
      manufacturer: d.manufacturer,
      productIds,
      flProductIds,
      newTags,
      oldTags: (d.shopify_tags ?? []).slice().sort(),
      design: d,
    });
  }

  const totalProducts = plans.reduce((n, p) => n + p.productIds.length, 0);
  const totalFl = plans.reduce((n, p) => n + p.flProductIds.length, 0);
  console.log(
    `[push] plan: ${plans.length} families → ${totalProducts} JF + ${totalFl} FL products. ${skipped.length} skipped.`,
  );
  if (totalFl > 0 && !isStoreConfigured("fl")) {
    console.warn("[push] SHOPIFY_FL_ADMIN_TOKEN not set — FL products will be SKIPPED (FL-only designs won't push).");
  }
  if (skipped.length > 0) {
    console.log("[push] skipped:");
    for (const s of skipped.slice(0, 10)) console.log(`    ${s.family}: ${s.reason}`);
    if (skipped.length > 10) console.log(`    … and ${skipped.length - 10} more`);
  }

  // Dry-run CSV: one row per product.
  const csvPath = "shopify_push_diff.csv";
  const lines = ["design_family,manufacturer,store,product_id,design_name,old_tags,new_tags"];
  for (const p of plans) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const targets = [
      ...p.productIds.map((id) => ["JF", id] as const),
      ...p.flProductIds.map((id) => ["FL", id] as const),
    ];
    for (const [store, id] of targets) {
      lines.push(
        [
          p.family,
          esc(p.manufacturer ?? ""),
          store,
          String(id),
          esc(p.name),
          esc(p.oldTags.join(" | ")),
          esc(p.newTags.join(" | ")),
        ].join(","),
      );
    }
  }
  writeFileSync(csvPath, lines.join("\n"), "utf8");
  console.log(`[push] wrote ${csvPath} (${lines.length - 1} product rows).`);

  if (!args.apply) {
    console.log("[push] DRY-RUN. Re-run with --apply to write tags to Shopify.");
    return;
  }

  // --apply. For each family: PUT each product, track failures. If ALL of a
  // family's products succeed, promote status → updated.
  console.log("[push] --apply: writing to Shopify…");
  let familiesUpdated = 0;
  let productsWritten = 0;
  let productsFailed = 0;

  // T7 merge-push: owned = canonical taxonomy terms + size/material facet
  // vocabulary (T5). Feature tags are additive-only (not owned).
  const ownedKeys: ReadonlySet<string> = new Set([
    ...(await getOwnedTaxonomyKeys(normalizeTagKey)),
    ...OWNED_FACET_KEYS,
  ]);

  for (const plan of plans) {
    const outcome = await pushDesign(sb, plan.design, ownedKeys, "blake");
    if (outcome.kind === "skipped") {
      console.log(`  - ${plan.family}: skipped — ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "failed") {
      productsFailed += outcome.failed.length;
      productsWritten += outcome.total - outcome.failed.length;
      console.log(`  ✗ ${plan.family}: ${outcome.failed.length}/${outcome.total} products failed`);
      for (const f of outcome.failed) console.log(`      ${f.store} product ${f.id}: ${f.error}`);
      continue;
    }
    if (outcome.kind === "db_error") {
      console.log(`  ! ${plan.family}: ${outcome.error}`);
      continue;
    }
    productsWritten += outcome.jfIds.length + outcome.flIds.length;
    familiesUpdated++;
    if (familiesUpdated % 25 === 0) {
      console.log(`  … ${familiesUpdated}/${plans.length} families pushed`);
    }
  }

  console.log(
    `[push] done: ${familiesUpdated}/${plans.length} families pushed, ${productsWritten} products written, ${productsFailed} products failed.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
