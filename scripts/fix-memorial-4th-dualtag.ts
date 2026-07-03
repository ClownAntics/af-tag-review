/**
 * Fix designs whose approved_tags carry BOTH `Memorial-Day` and `4th-Of-July`
 * (taxonomy-declared conflict). Blake's rule (2026-07-03, Option B): strict
 * one-occasion — drop `Memorial-Day`, keep `4th-Of-July`. Memorial Day keeps
 * only explicitly memorial designs.
 *
 * Two phases per design:
 *   1. Supabase: remove Memorial-Day from approved_tags, recompute the derived
 *      theme columns, log an event.
 *   2. Shopify: surgically remove ONLY the `memorial-day` tag from each of the
 *      family's products (GET tags → filter → PUT). NOT a full push — all
 *      other live tags (functional/brand/type) are preserved, so no smart
 *      collection loses its members. shopify_tags mirror updated to match.
 *
 * Usage:
 *   npx tsx scripts/fix-memorial-4th-dualtag.ts          # dry-run
 *   npx tsx scripts/fix-memorial-4th-dualtag.ts --apply  # commit both phases
 */
import { getAdminClient } from "./_supabase-admin";
import { mapTagsToThemes } from "../lib/vision";

const M = "Memorial-Day";
const F = "4th-Of-July";
const SHOP_M = "memorial-day"; // Shopify normalizes tags to lowercase

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  design_family: string;
  design_name: string | null;
  status: string;
  approved_tags: string[] | null;
  shopify_tags: string[] | null;
  shopify_product_ids: number[] | null;
}

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

/** Remove one tag from a live product, preserving every other tag. */
async function removeProductTag(productId: number, tag: string, dry: boolean): Promise<"removed" | "absent" | "error"> {
  const getRes = await shopifyFetch(`products/${productId}.json?fields=id,tags`);
  if (!getRes.ok) { console.warn(`    GET ${productId} failed: ${getRes.status}`); return "error"; }
  const tags: string[] = ((await getRes.json()).product.tags ?? "")
    .split(",").map((t: string) => t.trim()).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase() === tag)) return "absent";
  const next = tags.filter((t) => t.toLowerCase() !== tag);
  if (dry) return "removed";
  const putRes = await shopifyFetch(`products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: productId, tags: next.join(", ") } }),
  });
  if (!putRes.ok) { console.warn(`    PUT ${productId} failed: ${putRes.status} ${await putRes.text()}`); return "error"; }
  return "removed";
}

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,approved_tags,shopify_tags,shopify_product_ids")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  const both = rows.filter(
    (r) => (r.approved_tags ?? []).includes(M) && (r.approved_tags ?? []).includes(F),
  );
  console.log(`Dual-tagged (${M} + ${F}) designs: ${both.length}  →  rule: drop ${M}\n`);

  let sbPatched = 0, shopRemoved = 0, shopAbsent = 0, shopErr = 0;
  for (const r of both) {
    console.log(`  ${r.design_family} [${r.status}] "${r.design_name ?? ""}"`);

    // Phase 1 — Supabase
    const newTags = (r.approved_tags ?? []).filter((t) => t !== M).sort();
    if (apply) {
      const t = await mapTagsToThemes(newTags);
      const { error } = await sb
        .from("designs")
        .update({
          approved_tags: newTags,
          shopify_tags: (r.shopify_tags ?? []).filter((x) => x.toLowerCase() !== SHOP_M),
          theme_names: t.theme_names,
          sub_themes: t.sub_themes,
          sub_sub_themes: t.sub_sub_themes,
        })
        .eq("design_family", r.design_family);
      if (error) { console.warn(`    supabase update failed: ${error.message}`); continue; }
      await sb.from("events").insert({
        design_family: r.design_family,
        event_type: "tag_deleted",
        actor: "blake-via-claude",
        payload: { tag: M, reason: "memorial/4th conflict — Option B strict one-occasion", source: "fix-memorial-4th-dualtag" },
      });
    }
    sbPatched++;

    // Phase 2 — Shopify targeted tag removal
    for (const pid of r.shopify_product_ids ?? []) {
      const res = await removeProductTag(pid, SHOP_M, !apply);
      if (res === "removed") { shopRemoved++; console.log(`    product ${pid}: ${apply ? "removed" : "would remove"} '${SHOP_M}'`); }
      else if (res === "absent") shopAbsent++;
      else shopErr++;
      await sleep(300); // stay well under rate limits
    }
  }

  console.log(`\nSummary: supabase rows ${apply ? "patched" : "to patch"}=${sbPatched} · shopify tag ${apply ? "removals" : "removals planned"}=${shopRemoved} · already absent=${shopAbsent} · errors=${shopErr}`);
  if (!apply) console.log("DRY-RUN. Re-run with --apply to commit.");
}
main().catch((e) => { console.error(e); process.exit(1); });
