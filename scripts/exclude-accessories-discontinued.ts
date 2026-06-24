/**
 * Mark as excluded:
 *   A) accessories / flag poles — shopify_product_types contains "Accessories"
 *      (poles, brackets, finials, stakes, mounts…) or title is a pole/accessory.
 *   B) products whose td_product lifecycle Status is one of:
 *      "Out of Stock - CA Discontinued", "Out of Stock - Discontinued",
 *      "Donate", "Inactive"  — joined SKU → designs.variant_skus.
 *      A family is excluded only if EVERY matched SKU has an excludable status
 *      (strict: no live variant remains). Mixed families are left alone.
 *
 * Usage:
 *   npx tsx scripts/exclude-accessories-discontinued.ts          # dry-run
 *   npx tsx scripts/exclude-accessories-discontinued.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

const EXCLUDE_STATUS = new Set([
  "out of stock - ca discontinued",
  "out of stock - discontinued",
  "donate",
  "inactive",
]);
// Real accessories carry the signal in their product_type ("…: Accessories: …",
// poles, brackets). Titles only flag genuine physical poles — matching
// "accessor" in a title wrongly catches themed flags like "Cowboy Accessories".
const accTypeRe = /accessor|flag\s*pole|flagpole/i;
const accTitleRe = /flag\s*pole|flagpole/i;

interface Design {
  design_family: string;
  design_name: string | null;
  status: string;
  manufacturer: string | null;
  variant_skus: string[] | null;
  shopify_product_types: string[] | null;
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  const PAGE = 1000;

  // td_product SKU -> status
  const skuStatus = new Map<string, string>();
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("td_product").select("SKU,Status").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as { SKU: string | null; Status: string | null }[];
    for (const r of b) if (r.SKU) skuStatus.set(r.SKU.trim(), (r.Status ?? "").trim());
    if (b.length < PAGE) break;
  }

  // designs (non-excluded)
  const designs: Design[] = [];
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,manufacturer,variant_skus,shopify_product_types")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    designs.push(...(b as Design[]));
    if (b.length < PAGE) break;
  }

  const skusFor = (d: Design) => {
    const s = (d.variant_skus ?? []).map((x) => x.trim()).filter(Boolean);
    return s.length ? s : [d.design_family.trim()];
  };

  // Build the to-exclude map with reasons.
  const toExclude = new Map<string, { reason: string; detail: string }>();
  let accCount = 0, lifeCount = 0;
  for (const d of designs) {
    const isAcc =
      (d.shopify_product_types ?? []).some((t) => accTypeRe.test(t)) ||
      (d.design_name ? accTitleRe.test(d.design_name) : false);
    if (isAcc) {
      const t = (d.shopify_product_types ?? []).find((x) => accTypeRe.test(x)) ?? d.design_name ?? "";
      toExclude.set(d.design_family, { reason: "accessory", detail: t });
      accCount++;
      continue; // accessory wins; no need to also check lifecycle
    }
    const skus = skusFor(d);
    const matched = skus.filter((s) => skuStatus.has(s));
    if (matched.length === 0) continue;
    const exc = matched.filter((s) => EXCLUDE_STATUS.has((skuStatus.get(s) ?? "").toLowerCase()));
    if (exc.length === matched.length) {
      const statuses = [...new Set(exc.map((s) => skuStatus.get(s)))].join(", ");
      toExclude.set(d.design_family, { reason: "lifecycle_status", detail: statuses });
      lifeCount++;
    }
  }

  console.log(`To exclude: ${toExclude.size} designs`);
  console.log(`  A) accessory / flag pole : ${accCount}`);
  console.log(`  B) lifecycle (strict)    : ${lifeCount}`);

  if (!apply) {
    console.log("\nDRY-RUN. Add --apply to commit.");
    return;
  }

  const families = [...toExclude.keys()];
  console.log("\nApplying…");
  let done = 0;
  for (let i = 0; i < families.length; i += 200) {
    const slice = families.slice(i, i + 200);
    const { error } = await sb.from("designs").update({ status: "excluded" }).in("design_family", slice);
    if (error) throw new Error(`update batch at ${i}: ${error.message}`);
    // events in the same batch
    const evs = slice.map((f) => ({
      design_family: f,
      event_type: "excluded",
      actor: "blake",
      payload: { reason: toExclude.get(f)!.reason, detail: toExclude.get(f)!.detail },
    }));
    await sb.from("events").insert(evs);
    done += slice.length;
    console.log(`  excluded ${done}/${families.length}`);
  }
  console.log(`\nDone. Excluded ${done} designs.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
