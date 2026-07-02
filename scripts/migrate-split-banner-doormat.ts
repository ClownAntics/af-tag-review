/**
 * Split banner (GB) and doormat (DR) variants out of the collapsed flag
 * families into their own design_family rows. The manufacturer reuses design
 * numbers across product types, so a banner/doormat sharing a number is often
 * a DIFFERENT design — merging them polluted the flag's tags.
 *
 * For each affected family (has a GB or DR variant mixed with GF/HF flags):
 *   - Fetch each Shopify product, classify by SKU (parseSku → design_family).
 *   - Flag family (AF<body>): keep only GF/HF products; status → flagged.
 *   - Banner family (AFGB<body>) / Doormat family (AFDR<body>): new rows with
 *     that product's own title/image/tags; status = flagged; approved_tags [].
 *   - Everything touched is set to `flagged` for Blake to review.
 *
 * approved_tags on the flag family are KEPT (not cleared) so nothing curated
 * is lost — review can clean any banner/doormat pollution.
 *
 * Usage:
 *   npx tsx scripts/migrate-split-banner-doormat.ts          # dry-run
 *   npx tsx scripts/migrate-split-banner-doormat.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { parseSku } from "../lib/sku-parser";

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ShopProduct { id: number; title: string; product_type: string; image: string | null; tags: string[]; skus: string[] }

async function getProduct(id: number): Promise<ShopProduct | null> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN;
  const url = `https://${store}.myshopify.com/admin/api/${API}/products/${id}.json?fields=id,title,product_type,image,tags,variants`;
  for (let a = 0; a < 5; a++) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok!, "Content-Type": "application/json" } });
    if (res.status === 429) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
    if (res.status === 404) return null;
    if (!res.ok) { await sleep(500 * (a + 1)); continue; }
    const p = (await res.json()).product;
    return {
      id: p.id, title: p.title, product_type: (p.product_type ?? "").trim(),
      image: p.image?.src ?? null,
      tags: (p.tags ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      skus: (p.variants ?? []).map((v: { sku: string }) => (v.sku ?? "").trim()).filter(Boolean),
    };
  }
  return null;
}

const isSplit = (sku: string) => { const t = parseSku(sku)?.productType; return t === "garden-banner" || t === "doormat"; };
const uniq = (a: string[]) => [...new Set(a)];

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const sb = getAdminClient();

  // affected families: any variant SKU classifies as banner or doormat
  const rows: { design_family: string; design_name: string | null; shopify_product_ids: number[] | null; variant_skus: string[] | null; status: string }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb.from("designs").select("design_family,design_name,shopify_product_ids,variant_skus,status").eq("manufacturer", "AF").neq("status", "excluded").range(o, o + PAGE - 1);
    if (error) throw error;
    const b = data ?? [];
    rows.push(...(b as typeof rows));
    if (b.length < PAGE) break;
  }
  const affected = rows.filter((r) => (r.variant_skus ?? []).some(isSplit));
  console.log(`AF non-excluded families: ${rows.length} · affected (have banner/doormat): ${affected.length}\n`);

  let flagsTrimmed = 0, bannersNew = 0, doormatsNew = 0, samples = 0;
  const newRows: Record<string, unknown>[] = [];
  const flagUpdates: { family: string; ids: number[]; skus: string[]; types: string[] }[] = [];
  const flaggedFamilies = new Set<string>();

  for (const d of affected) {
    const products = (await Promise.all((d.shopify_product_ids ?? []).map(getProduct))).filter((p): p is ShopProduct => !!p);
    // group products by target design_family
    const groups = new Map<string, ShopProduct[]>();
    for (const p of products) {
      const sku = p.skus[0] ?? "";
      const fam = parseSku(sku)?.designFamily ?? d.design_family; // unparseable → keep with flags
      if (!groups.has(fam)) groups.set(fam, []);
      groups.get(fam)!.push(p);
    }
    // flag family = the existing (AF-prefixed, non-GB/DR) key
    const flagGroup = groups.get(d.design_family) ?? [];
    if (flagGroup.length) {
      flagUpdates.push({
        family: d.design_family,
        ids: flagGroup.map((p) => p.id).sort((a, b) => a - b),
        skus: uniq(flagGroup.flatMap((p) => p.skus)).sort(),
        types: uniq(flagGroup.map((p) => p.product_type)).sort(),
      });
      flaggedFamilies.add(d.design_family);
      flagsTrimmed++;
    }
    for (const [fam, ps] of groups) {
      if (fam === d.design_family) continue;
      const isBanner = fam.startsWith("AFGB");
      if (isBanner) bannersNew++; else doormatsNew++;
      newRows.push({
        design_family: fam,
        design_name: ps[0].title,
        manufacturer: "AF",
        status: "flagged",
        shopify_tags: uniq(ps.flatMap((p) => p.tags)),
        shopify_product_ids: ps.map((p) => p.id).sort((a, b) => a - b),
        variant_skus: uniq(ps.flatMap((p) => p.skus)).sort(),
        shopify_product_types: uniq(ps.map((p) => p.product_type)).sort(),
        image_url: ps[0].image,
        approved_tags: [],
        theme_names: [], sub_themes: [], sub_sub_themes: [],
      });
      flaggedFamilies.add(fam);
      if (samples < 6) {
        console.log(`${d.design_family} "${d.design_name}"  →  flag keeps ${flagGroup.length} product(s); NEW ${fam} "${ps[0].title}"`);
      }
    }
    samples++;
  }

  console.log(`\nPlan: trim+flag ${flagsTrimmed} flag families · create ${bannersNew} banner + ${doormatsNew} doormat families · flag ${flaggedFamilies.size} total.`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to commit."); return; }

  console.log("\nApplying…");
  // 1. insert new banner/doormat rows (upsert for idempotency)
  for (let i = 0; i < newRows.length; i += 200) {
    const { error } = await sb.from("designs").upsert(newRows.slice(i, i + 200) as object[], { onConflict: "design_family" });
    if (error) throw new Error(`upsert new at ${i}: ${error.message}`);
  }
  console.log(`  inserted ${newRows.length} banner/doormat families`);
  // 2. trim + flag the flag families
  let done = 0;
  for (const u of flagUpdates) {
    const { error } = await sb.from("designs").update({
      shopify_product_ids: u.ids, variant_skus: u.skus, shopify_product_types: u.types, status: "flagged",
    }).eq("design_family", u.family);
    if (error) { console.warn(`  ${u.family}: ${error.message}`); continue; }
    done++;
  }
  console.log(`  trimmed+flagged ${done} flag families`);
  // 3. events
  const evs = [...flaggedFamilies].map((f) => ({ design_family: f, event_type: "flagged", actor: "blake", payload: { reason: "split_banner_doormat" } }));
  for (let i = 0; i < evs.length; i += 200) await sb.from("events").insert(evs.slice(i, i + 200));
  console.log(`\nDone. ${flaggedFamilies.size} designs flagged for review.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
