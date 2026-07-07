/**
 * Backfill storefront facet tags (T5) onto LIVE products.
 *
 * The push pipeline now emits size/material/feature tags, but ~7.6k designs
 * are already `updated` and won't be re-pushed soon. This script adds the
 * derived facet tags to their live Shopify products surgically:
 *
 *   next = (current − OWNED_FACET_KEYS) ∪ facetTagsForDesign(design)
 *
 * ONLY the size/material facet vocabulary is owned/corrected here — theme,
 * brand, functional and feature tags are untouched (many `updated` non-AF
 * rows were imported live-as-is and never pushed; their tags must survive).
 * Products whose tag set wouldn't change are skipped, so the script is
 * restart-safe/idempotent. Reads are batched (250/call); writes only when
 * needed. shopify_tags mirror updated per design.
 *
 * Usage:
 *   npx tsx scripts/backfill-facet-tags.ts                # dry-run (counts)
 *   npx tsx scripts/backfill-facet-tags.ts --limit 20     # dry-run subset
 *   npx tsx scripts/backfill-facet-tags.ts --apply        # write
 */
import { getAdminClient } from "./_supabase-admin";
import { updateProductTags, normalizeTagKey } from "../lib/shopify";
import { featureTags, sizeMaterialTags, OWNED_FACET_KEYS, type FacetFlags } from "../lib/facet-tags";

const API = "2025-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row extends FacetFlags {
  design_family: string;
  status: string;
  shopify_product_ids: number[] | null;
  shopify_product_types: string[] | null;
  approved_tags: string[] | null;
}

async function getProductsBatch(
  ids: number[],
): Promise<Map<number, { tags: string[]; type: string }>> {
  const store = process.env.SHOPIFY_STORE, tok = process.env.SHOPIFY_ADMIN_TOKEN!;
  const out = new Map<number, { tags: string[]; type: string }>();
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const url = `https://${store}.myshopify.com/admin/api/${API}/products.json?ids=${chunk.join(",")}&limit=250&fields=id,tags,product_type`;
    for (let a = 0; ; a++) {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" } });
      if (res.status === 429 && a < 5) { await sleep((Number(res.headers.get("Retry-After") ?? "2") + a) * 1000); continue; }
      if (!res.ok) { if (a < 5) { await sleep(500 * (a + 1)); continue; } throw new Error(`batch GET ${res.status}`); }
      for (const p of (await res.json()).products ?? []) {
        out.set(p.id, {
          tags: ((p.tags ?? "") as string).split(",").map((t) => t.trim()).filter(Boolean),
          type: ((p.product_type ?? "") as string).trim(),
        });
      }
      break;
    }
    await sleep(600);
    if ((i / 250) % 10 === 9) console.log(`  … read ${Math.min(i + 250, ids.length)}/${ids.length} products`);
  }
  return out;
}

const eqSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const li = argv.indexOf("--limit");
  const limit = li >= 0 ? Number(argv[li + 1]) : null;
  const sb = getAdminClient();

  const rows: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,shopify_product_ids,shopify_product_types,approved_tags,is_double_sided,is_reversible,is_premiersoft,is_suede_reflections,is_glittertrends,is_printed_in_usa,is_envirofriendly")
      .neq("status", "excluded")
      .not("shopify_product_ids", "is", null)
      // Stable order is REQUIRED for .range() paging — without it Postgres
      // may reshuffle rows between pages (concurrent updates move heap rows)
      // and silently skip designs.
      .order("design_family")
      .range(o, o + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const designs = limit ? rows.slice(0, limit) : rows;
  console.log(`Designs with live products: ${rows.length}${limit ? ` (limited to ${designs.length})` : ""}`);

  // Product → design map. Size/material are PER-PRODUCT (from each product's
  // own product_type — the family-level union wrongly put `standard-garden`
  // on house flags in the first backfill run); features are family-level.
  // approvedKeys guards owned-tag removal: curation trumps derivation (e.g. a
  // doormat whose approved_tags carry `Printed` keeps it even though
  // "Doormats: Regular" can't derive it).
  const wanted = new Map<number, { family: string; features: string[]; approvedKeys: Set<string> }>();
  for (const d of designs) {
    const features = featureTags(d);
    const approvedKeys = new Set((d.approved_tags ?? []).map(normalizeTagKey));
    for (const pid of d.shopify_product_ids ?? []) wanted.set(pid, { family: d.design_family, features, approvedKeys });
  }

  console.log(`Reading ${wanted.size} products (batched)…`);
  const live = await getProductsBatch([...wanted.keys()]);

  // Plan changes.
  const changes: { pid: number; family: string; next: string[]; added: string[]; removed: string[] }[] = [];
  for (const [pid, w] of wanted) {
    const product = live.get(pid);
    if (!product) continue; // product gone — pull will reconcile
    const current = product.tags;
    const facets = [...new Set([...sizeMaterialTags([product.type]), ...w.features])].sort();
    const facetKeys = new Set(facets.map(normalizeTagKey));
    const kept = current.filter((t) => {
      const k = normalizeTagKey(t);
      return !OWNED_FACET_KEYS.has(k) || facetKeys.has(k) || w.approvedKeys.has(k);
    });
    const keptKeys = new Set(kept.map(normalizeTagKey));
    const next = [...kept, ...facets.filter((f) => !keptKeys.has(normalizeTagKey(f)))].sort();
    if (eqSet(next.map(normalizeTagKey), current.map(normalizeTagKey))) continue;
    const curKeys = new Set(current.map(normalizeTagKey));
    changes.push({
      pid, family: w.family, next,
      added: next.filter((t) => !curKeys.has(normalizeTagKey(t))),
      removed: current.filter((t) => !next.some((n) => normalizeTagKey(n) === normalizeTagKey(t))),
    });
  }
  console.log(`Products needing changes: ${changes.length} / ${wanted.size}`);
  const tally = new Map<string, number>();
  for (const c of changes) for (const a of c.added) tally.set(`+${normalizeTagKey(a)}`, (tally.get(`+${normalizeTagKey(a)}`) ?? 0) + 1);
  for (const c of changes) for (const r of c.removed) tally.set(`-${normalizeTagKey(r)}`, (tally.get(`-${normalizeTagKey(r)}`) ?? 0) + 1);
  console.log("Tag change tally:");
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}\t${k}`);

  if (!apply) { console.log("\nDRY-RUN. Add --apply to write."); return; }

  console.log("\nApplying…");
  let done = 0, failed = 0;
  const touchedFamilies = new Map<string, Set<string>>(); // family → union of stored tags
  for (const c of changes) {
    try {
      const stored = await updateProductTags(c.pid, c.next);
      const set = touchedFamilies.get(c.family) ?? new Set<string>();
      for (const t of stored.tags.split(",").map((x) => x.trim()).filter(Boolean)) set.add(t);
      touchedFamilies.set(c.family, set);
      done++;
    } catch (e) {
      failed++;
      console.warn(`  ✗ product ${c.pid} (${c.family}): ${(e as Error).message}`);
    }
    if (done % 200 === 0) console.log(`  … ${done}/${changes.length} written`);
    await sleep(550); // ~1.8 req/s, under the 2/s bucket
  }
  console.log(`Writes: ${done} ok, ${failed} failed. Updating ${touchedFamilies.size} design mirrors…`);
  let mirrored = 0;
  for (const [family, tags] of touchedFamilies) {
    const { error } = await sb.from("designs").update({ shopify_tags: [...tags].sort() }).eq("design_family", family);
    if (!error) mirrored++;
  }
  console.log(`Done. ${mirrored} mirrors updated.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
