/**
 * Remove the stale live `memorial-day` tag from products whose curated
 * approved_tags do NOT include Memorial-Day (Blake approved all 33 on
 * 2026-07-03 — including "American Gold Star"). Surgical: only that tag is
 * removed from Shopify; all other live tags preserved. Mirrors the change
 * into designs.shopify_tags and logs an event per design.
 *
 * Usage:
 *   npx tsx scripts/remove-stale-memorial.ts          # dry-run
 *   npx tsx scripts/remove-stale-memorial.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";

const SHOP_M = "memorial-day";
const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shopifyFetch(path: string, init?: RequestInit): Promise<Response> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN!;
  const url = `https://${store}.myshopify.com/admin/api/${API}/${path}`;
  for (let a = 0; ; a++) {
    const res = await fetch(url, {
      ...init,
      headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (res.status === 429 && a < 5) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
    return res;
  }
}

async function removeProductTag(productId: number, tag: string, dry: boolean): Promise<"removed" | "absent" | "error"> {
  const getRes = await shopifyFetch(`products/${productId}.json?fields=id,tags`);
  if (!getRes.ok) { console.warn(`    GET ${productId} failed: ${getRes.status}`); return "error"; }
  const tags: string[] = ((await getRes.json()).product.tags ?? "")
    .split(",").map((t: string) => t.trim()).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase() === tag)) return "absent";
  if (dry) return "removed";
  const putRes = await shopifyFetch(`products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: productId, tags: tags.filter((t) => t.toLowerCase() !== tag).join(", ") } }),
  });
  if (!putRes.ok) { console.warn(`    PUT ${productId} failed: ${putRes.status} ${await putRes.text()}`); return "error"; }
  return "removed";
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: any[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,approved_tags,shopify_tags,shopify_product_ids")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  const stale = rows.filter((r) => {
    const live = (r.shopify_tags ?? []).map((t: string) => t.toLowerCase());
    return live.includes(SHOP_M) && !(r.approved_tags ?? []).includes("Memorial-Day");
  });
  console.log(`Designs with stale live '${SHOP_M}': ${stale.length}\n`);

  let removed = 0, absent = 0, errs = 0, mirrored = 0;
  for (const r of stale) {
    console.log(`  ${r.design_family} [${r.status}] "${r.design_name ?? ""}"`);
    let anyRemoved = false;
    for (const pid of r.shopify_product_ids ?? []) {
      const res = await removeProductTag(pid, SHOP_M, !apply);
      if (res === "removed") { removed++; anyRemoved = true; console.log(`    product ${pid}: ${apply ? "removed" : "would remove"}`); }
      else if (res === "absent") absent++;
      else errs++;
      await sleep(300);
    }
    if (apply && anyRemoved) {
      const { error } = await sb
        .from("designs")
        .update({ shopify_tags: (r.shopify_tags ?? []).filter((t: string) => t.toLowerCase() !== SHOP_M) })
        .eq("design_family", r.design_family);
      if (error) { console.warn(`    mirror update failed: ${error.message}`); continue; }
      await sb.from("events").insert({
        design_family: r.design_family,
        event_type: "tag_deleted",
        actor: "blake-via-claude",
        payload: { tag: SHOP_M, scope: "shopify-live-only", reason: "stale legacy tag, not in curated approved_tags", source: "remove-stale-memorial" },
      });
      mirrored++;
    }
  }
  console.log(`\nSummary: shopify removals${apply ? "" : " planned"}=${removed} · absent=${absent} · errors=${errs}${apply ? ` · mirrors updated=${mirrored}` : ""}`);
  if (!apply) console.log("DRY-RUN. Re-run with --apply to commit.");
}
main().catch((e) => { console.error(e); process.exit(1); });
