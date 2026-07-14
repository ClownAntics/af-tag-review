/**
 * Mark OOS/discontinued flag families and exclude them (Blake 2026-07-09).
 *
 * Source of truth: td_product."Status". A design family is discontinued when
 * EVERY variant SKU that appears in td_product has a discontinued/inactive
 * status (strict — no live variant remains). Sets:
 *   - is_active = false   → drives the RED SKU marker on the review tile
 *   - status   = excluded → out of the review pipeline
 * (is_active was unused; false = "not active" = discontinued.)
 *
 * Usage:
 *   npx tsx scripts/mark-discontinued.ts          # dry-run
 *   npx tsx scripts/mark-discontinued.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

const DISCONTINUED = new Set([
  "out of stock - discontinued",
  "out of stock - ca discontinued",
  "discontinued",
  "ca discontinued",
  "discontineud", // known typo in td_product
  "inactive",
]);

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();
  const PAGE = 1000;

  // 1. SKU -> Status from td_product.
  const skuStatus = new Map<string, string>();
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("td_product").select("SKU,Status").range(o, o + PAGE - 1);
    if (error) throw error;
    for (const r of (data ?? []) as { SKU: string | null; Status: string | null }[]) {
      if (r.SKU) skuStatus.set(r.SKU.trim().toUpperCase(), (r.Status ?? "").trim().toLowerCase());
    }
    if ((data ?? []).length < PAGE) break;
  }
  console.log(`td_product SKUs: ${skuStatus.size}`);

  // 2. Designs (non-excluded) — decide per family.
  const rows: { design_family: string; design_name: string | null; status: string; variant_skus: string[] | null; is_active: boolean }[] = [];
  for (let o = 0; ; o += PAGE) {
    // ALL designs — including already-excluded ones, so discontinued flags
    // that were excluded earlier (accessories pass, etc.) still get the red
    // is_active=false marker.
    const { data, error } = await sb.from("designs")
      .select("design_family,design_name,status,variant_skus,is_active")
      .order("design_family").range(o, o + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < PAGE) break;
  }

  const toMark: typeof rows = [];
  for (const r of rows) {
    const skus = (r.variant_skus ?? []).map((s) => s.trim().toUpperCase());
    const matched = skus.map((s) => skuStatus.get(s)).filter((s): s is string => s !== undefined);
    if (matched.length === 0) continue;                    // no td_product info — leave alone
    if (matched.every((s) => DISCONTINUED.has(s))) toMark.push(r); // strict: all variants discontinued
  }

  const byStatus: Record<string, number> = {};
  for (const r of toMark) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`Families to mark discontinued + exclude: ${toMark.length}`);
  console.log(`  by current status: ${JSON.stringify(byStatus)}`);
  for (const r of toMark.slice(0, 8)) console.log(`  ${r.design_family} [${r.status}] "${r.design_name ?? ""}"`);
  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  let done = 0;
  for (const r of toMark) {
    if (r.is_active === false && r.status === "excluded") continue; // already marked
    const { error } = await sb.from("designs").update({ is_active: false, status: "excluded" }).eq("design_family", r.design_family);
    if (error) { console.warn(`  ${r.design_family}: ${error.message}`); continue; }
    await sb.from("events").insert({ design_family: r.design_family, event_type: "excluded", actor: "blake-via-claude",
      payload: { reason: "oos_discontinued", note: "all variants discontinued/inactive in td_product", from_status: r.status } });
    done++;
    if (done % 200 === 0) console.log(`  … ${done}/${toMark.length}`);
  }
  console.log(`\nDone. Marked + excluded ${done} discontinued families.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
