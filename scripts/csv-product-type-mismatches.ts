/**
 * READ-ONLY: export a CSV of Shopify products whose product_type looks wrong.
 * Groups Shopify products by their TeamDesk type ref (td_product SKU → ref);
 * within a group the minority product_type is the outlier, and the dominant is
 * the suggested value. Confidence: "high" when it's an obvious singular/plural
 * normalization of the same concept, else "review" (a real reclassification).
 *
 * Writes: C:/Users/gbcab/Downloads/product-type-mismatches.csv
 */
import { writeFileSync } from "node:fs";
import { getAdminClient } from "./_supabase-admin";
import { listProducts } from "../lib/shopify";

const OUT = "C:/Users/gbcab/Downloads/product-type-mismatches.csv";
const skuVariants = (s: string) => { const u = s.trim(); return /WH$/i.test(u) ? [u, u.replace(/WH$/i, "")] : [u, u + "WH"]; };
const norm = (s: string) => (s.split(":")[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
const confidence = (from: string, to: string) => {
  const a = norm(from), b = norm(to);
  return a && b && (a.startsWith(b) || b.startsWith(a)) ? "high" : "review";
};

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

  const groups = new Map<string, Map<string, { id: number; sku: string; title: string }[]>>();
  let seen = 0;
  for await (const p of listProducts()) {
    seen++;
    const skus = (p.variants ?? []).map((v) => (v.sku ?? "").trim()).filter(Boolean);
    let ref: string | undefined, matched = "";
    outer: for (const s of skus) for (const c of skuVariants(s)) { const r = skuToRef.get(c); if (r) { ref = r; matched = s; break outer; } }
    if (!ref) continue;
    const pt = (p.product_type ?? "").trim();
    if (!groups.has(ref)) groups.set(ref, new Map());
    const g = groups.get(ref)!;
    if (!g.has(pt)) g.set(pt, []);
    g.get(pt)!.push({ id: p.id, sku: matched, title: p.title });
  }

  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ["confidence,product_id,sku,title,shopify_product_type,suggested_product_type,td_ref"];
  let n = 0;
  for (const [ref, g] of groups) {
    if (g.size < 2) continue;
    let dom = "", domN = -1;
    for (const [pt, arr] of g) if (arr.length > domN) { dom = pt; domN = arr.length; }
    for (const [pt, arr] of g) {
      if (pt === dom) continue;
      for (const it of arr) {
        lines.push([confidence(pt, dom), it.id, esc(it.sku), esc(it.title), esc(pt), esc(dom), ref].join(","));
        n++;
      }
    }
  }
  // high-confidence first
  const header = lines[0];
  const body = lines.slice(1).sort((a, b) => (a.startsWith("high") ? 0 : 1) - (b.startsWith("high") ? 0 : 1));
  writeFileSync(OUT, [header, ...body].join("\n"), "utf8");
  const highN = body.filter((l) => l.startsWith("high")).length;
  console.log(`Shopify products scanned: ${seen}`);
  console.log(`Mismatches: ${n}  (high-confidence typos: ${highN}, review: ${n - highN})`);
  console.log(`Wrote ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
