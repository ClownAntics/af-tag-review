/**
 * Push curated tags back to JFF Shopify.
 *
 * Usage:
 *   npx tsx scripts/shopify-push.ts              # dry-run CSV, no writes
 *   npx tsx scripts/shopify-push.ts --limit 5    # dry-run first 5 families
 *   npx tsx scripts/shopify-push.ts --apply      # actually PUT to Shopify
 *
 * Scope: every design with status='readytosend'. For each, look up its
 * shopify_product_ids (populated by scripts/shopify-pull.ts), and PUT the
 * product's tags to `approved_tags` — full replace, nothing preserved, per
 * the decision recorded in memory. AF families span multiple products; each
 * gets the same tag set.
 *
 * Dry-run writes shopify_push_diff.csv summarizing old vs new tags per
 * product. --apply then:
 *   1. PUTs each product /admin/api/2025-01/products/{id}.json
 *   2. On success for ALL of a family's products: status → updated,
 *      last_pushed_at → now, events row logged
 *   3. On partial failure: status stays readytosend, an error event is logged
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { updateProductTags } from "../lib/shopify";

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

interface ReadyDesign {
  design_family: string;
  design_name: string;
  manufacturer: string | null;
  approved_tags: string[];
  shopify_product_ids: number[] | null;
  shopify_tags: string[] | null;
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  console.log("[push] loading ready-to-send designs…");
  let q = sb
    .from("designs")
    .select(
      "design_family,design_name,manufacturer,approved_tags,shopify_product_ids,shopify_tags",
    )
    .eq("status", "readytosend")
    .order("design_family");
  if (args.limit) q = q.limit(args.limit);
  const { data, error } = await q;
  if (error) throw error;
  const designs = (data ?? []) as ReadyDesign[];
  console.log(`[push] ${designs.length} designs in readytosend.`);

  const skipped: Array<{ family: string; reason: string }> = [];
  const plans: Array<{
    family: string;
    name: string;
    manufacturer: string | null;
    productIds: number[];
    newTags: string[];
    oldTags: string[];
  }> = [];

  for (const d of designs) {
    const productIds = d.shopify_product_ids ?? [];
    if (productIds.length === 0) {
      skipped.push({ family: d.design_family, reason: "no shopify_product_ids — re-run shopify-pull" });
      continue;
    }
    const newTags = [...new Set(d.approved_tags ?? [])].sort();
    if (newTags.length === 0) {
      skipped.push({ family: d.design_family, reason: "approved_tags empty — won't push a blank tag set" });
      continue;
    }
    plans.push({
      family: d.design_family,
      name: d.design_name,
      manufacturer: d.manufacturer,
      productIds,
      newTags,
      oldTags: (d.shopify_tags ?? []).slice().sort(),
    });
  }

  const totalProducts = plans.reduce((n, p) => n + p.productIds.length, 0);
  console.log(
    `[push] plan: ${plans.length} families → ${totalProducts} Shopify products. ${skipped.length} skipped.`,
  );
  if (skipped.length > 0) {
    console.log("[push] skipped:");
    for (const s of skipped.slice(0, 10)) console.log(`    ${s.family}: ${s.reason}`);
    if (skipped.length > 10) console.log(`    … and ${skipped.length - 10} more`);
  }

  // Dry-run CSV: one row per product.
  const csvPath = "shopify_push_diff.csv";
  const lines = ["design_family,manufacturer,product_id,design_name,old_tags,new_tags"];
  for (const p of plans) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    for (const id of p.productIds) {
      lines.push(
        [
          p.family,
          esc(p.manufacturer ?? ""),
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

  for (const plan of plans) {
    const results = await Promise.all(
      plan.productIds.map(async (id) => {
        try {
          await updateProductTags(id, plan.newTags);
          return { id, ok: true as const };
        } catch (e) {
          return { id, ok: false as const, error: (e as Error).message };
        }
      }),
    );
    const failed = results.filter((r) => !r.ok);
    productsWritten += results.length - failed.length;
    productsFailed += failed.length;

    if (failed.length > 0) {
      console.log(
        `  ✗ ${plan.family}: ${failed.length}/${plan.productIds.length} products failed`,
      );
      for (const f of failed) console.log(`      product ${f.id}: ${f.error}`);
      await sb.from("events").insert({
        design_family: plan.family,
        event_type: "push_failed",
        actor: "system",
        payload: {
          failed_product_ids: failed.map((f) => f.id),
          errors: failed.map((f) => f.error),
        },
      });
      continue;
    }

    // All products for this family succeeded.
    const { error: updErr } = await sb
      .from("designs")
      .update({
        status: "updated",
        last_pushed_at: new Date().toISOString(),
        shopify_tags: plan.newTags,
      })
      .eq("design_family", plan.family);
    if (updErr) {
      console.log(`  ! ${plan.family}: Shopify OK but Supabase status update failed: ${updErr.message}`);
      continue;
    }
    await sb.from("events").insert({
      design_family: plan.family,
      event_type: "pushed",
      actor: "blake",
      payload: {
        product_ids: plan.productIds,
        tag_count: plan.newTags.length,
      },
    });
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
