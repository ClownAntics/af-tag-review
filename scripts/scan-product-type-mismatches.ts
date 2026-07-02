/**
 * READ-ONLY: find Shopify product_type inconsistencies WITHIN a TeamDesk
 * type-ref group. Products whose SKU maps (via td_product) to the same
 * "Related Type (ref)" should carry the same Shopify product_type. Where a
 * group has mixed types, the minority entries are outliers to correct to the
 * group's dominant value. (Avoids the broken td_product→td_type label join.)
 *
 * SKU match tries exact, then ±trailing "WH" to bridge the warehouse-suffix
 * mismatch between Shopify SKUs and td_product SKUs.
 *
 * Writes nothing. Emits scripts/product-type-fixes.json for the apply step.
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { listProducts } from "../lib/shopify";

function skuVariants(s: string): string[] {
  const u = s.trim();
  const out = [u];
  if (/WH$/i.test(u)) out.push(u.replace(/WH$/i, ""));
  else out.push(u + "WH");
  return out;
}

async function main() {
  const sb = getAdminClient();
  const PAGE = 1000;

  const skuToRef = new Map<string, string>();
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("td_product").select("SKU,\"Related Type (ref)\"").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = (data ?? []) as { SKU: string | null; "Related Type (ref)": string | null }[];
    for (const r of b) { const ref = r["Related Type (ref)"]; if (r.SKU && ref) skuToRef.set(r.SKU.trim(), String(ref).trim()); }
    if (b.length < PAGE) break;
  }
  console.log(`td_product SKUs with a type ref: ${skuToRef.size}`);

  // ref -> product_type -> [{id, sku, title}]
  const groups = new Map<string, Map<string, { id: number; sku: string; title: string }[]>>();
  let seen = 0, resolved = 0;
  for await (const p of listProducts()) {
    seen++;
    const skus = (p.variants ?? []).map((v) => (v.sku ?? "").trim()).filter(Boolean);
    let ref: string | undefined;
    let matchedSku = "";
    outer: for (const s of skus) {
      for (const cand of skuVariants(s)) { const r = skuToRef.get(cand); if (r) { ref = r; matchedSku = s; break outer; } }
    }
    if (!ref) continue;
    resolved++;
    const pt = (p.product_type ?? "").trim();
    if (!groups.has(ref)) groups.set(ref, new Map());
    const g = groups.get(ref)!;
    if (!g.has(pt)) g.set(pt, []);
    g.get(pt)!.push({ id: p.id, sku: matchedSku, title: p.title });
  }
  console.log(`Shopify products seen: ${seen} · resolved to a td ref: ${resolved}\n`);

  const fixes: { id: number; sku: string; title: string; from: string; to: string; ref: string }[] = [];
  const transitions = new Map<string, number>();
  for (const [ref, g] of groups) {
    if (g.size < 2) continue; // consistent group
    // dominant = product_type with the most products
    let dom = ""; let domN = -1;
    for (const [pt, arr] of g) if (arr.length > domN) { dom = pt; domN = arr.length; }
    for (const [pt, arr] of g) {
      if (pt === dom) continue;
      for (const item of arr) {
        fixes.push({ ...item, from: pt, to: dom, ref });
        const key = `"${pt}"  →  "${dom}"`;
        transitions.set(key, (transitions.get(key) ?? 0) + 1);
      }
    }
  }
  console.log(`Inconsistent ref-groups → outlier products to fix: ${fixes.length}`);
  console.log("\nTransitions (outlier → dominant):");
  for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  console.log("\nAll fixes:");
  for (const f of fixes) console.log(`  ${f.id} ${f.sku} "${f.title}"  [${f.from}] → [${f.to}]`);

  writeFileSync("scripts/product-type-fixes.json", JSON.stringify(fixes, null, 2));
  console.log(`\nWrote scripts/product-type-fixes.json (${fixes.length}).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
