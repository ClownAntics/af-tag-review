/**
 * Undo accessory-exclusion false positives: designs excluded with
 * reason='accessory' that are actually flags (no "Accessories" in any
 * product_type — they were matched only by an "accessor" substring in the
 * TITLE, e.g. "Cowboy Accessories"). Check each on Shopify; restore the ones
 * that are still ACTIVE back to 'updated'. Archived/draft stay excluded.
 *
 * Usage:
 *   npx tsx scripts/restore-false-accessory.ts          # dry-run + Shopify status
 *   npx tsx scripts/restore-false-accessory.ts --apply  # restore active ones
 */
import { getAdminClient } from "./_supabase-admin";

const API_VERSION = "2025-01";
const accTypeRe = /accessor|flag\s*pole|flagpole/i; // real-accessory signal lives in product_type

async function shopifyStatus(id: number): Promise<string> {
  const store = process.env.SHOPIFY_STORE;
  const tok = process.env.SHOPIFY_ADMIN_TOKEN;
  const url = `https://${store}.myshopify.com/admin/api/${API_VERSION}/products/${id}.json?fields=id,status`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok!, "Content-Type": "application/json" } });
  if (!res.ok) return `err ${res.status}`;
  const j = (await res.json()) as { product: { status: string } };
  return j.product.status;
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  // accessory-excluded design_families (latest excluded event reason)
  const reason = new Map<string, string>();
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data } = await sb
      .from("events")
      .select("design_family,payload,timestamp")
      .eq("event_type", "excluded")
      .order("timestamp", { ascending: true })
      .range(o, o + PAGE - 1);
    const b = data ?? [];
    for (const e of b as { design_family: string; payload: { reason?: string } | null }[])
      if (e.payload?.reason) reason.set(e.design_family, e.payload.reason);
    if (b.length < PAGE) break;
  }

  const { data: excluded } = await sb
    .from("designs")
    .select("design_family,design_name,shopify_product_ids,shopify_product_types,approved_tags,last_pushed_at")
    .eq("status", "excluded");

  const candidates = (excluded ?? []).filter((d) => {
    if (reason.get(d.design_family) !== "accessory") return false;
    // false positive = NO product_type carries the accessory/pole signal
    return !(d.shopify_product_types ?? []).some((t: string) => accTypeRe.test(t));
  });

  const poleRe = /flag\s*pole|flagpole/i; // a genuine physical pole, not a themed flag
  console.log(`accessory-excluded designs matched only by title: ${candidates.length}\n`);
  const toRestore: string[] = [];
  for (const d of candidates) {
    const statuses = await Promise.all((d.shopify_product_ids ?? []).map(shopifyStatus));
    const anyActive = statuses.includes("active");
    const genuinePole = poleRe.test(d.design_name ?? "");
    const restore = anyActive && !genuinePole; // active misclassified flag → restore; real poles stay out
    const verdict = genuinePole ? "→ keep excluded (genuine flag pole)" : restore ? "→ RESTORE" : "→ keep excluded (not active)";
    console.log(`${d.design_family} "${d.design_name}" — shopify=[${statuses.join(", ")}]  ${verdict}`);
    if (restore) toRestore.push(d.design_family);
  }

  if (!toRestore.length) { console.log("\nNothing active to restore."); return; }
  if (!apply) { console.log(`\nDRY-RUN. Would restore ${toRestore.length} to 'updated'. Add --apply.`); return; }

  const { error } = await sb.from("designs").update({ status: "updated" }).in("design_family", toRestore);
  if (error) throw error;
  for (const f of toRestore)
    await sb.from("events").insert({ design_family: f, event_type: "included", actor: "blake", payload: { reason: "accessory_false_positive", note: "active flag mis-excluded by title match" } });
  console.log(`\nRestored ${toRestore.length} designs to 'updated'.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
