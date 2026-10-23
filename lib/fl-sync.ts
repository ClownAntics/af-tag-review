/**
 * FL (Flagsrus) catalog sync — links designs to their FL products.
 *
 * JF is the primary catalog (lib/shopify + /api/cron/shopify-sync fill
 * shopify_product_ids etc.). FL sells many of the same products under
 * different product IDs, plus some JF doesn't carry. This sync:
 *
 *   1. Builds a SKU → design_family map from every design's variant_skus.
 *   2. Pages the FL catalog (active + draft, minus ignored types like
 *      "Sets" — see isIgnoredFlProduct). Each FL product resolves to a
 *      family by variant SKU first, then by the same SKU → family rule the JF
 *      sync uses (productToFamily), so a new FL-only variant of a known AF
 *      artwork still lands on that design.
 *   3. Existing designs: writes fl_product_ids / fl_product_types / fl_tags
 *      when they drift. FL-ONLY designs (no JF products) also mirror FL into
 *      shopify_tags / shopify_product_types / variant_skus / image_url, since
 *      those columns drive the review UI, filters and vision — for an FL-only
 *      design, FL is the only live store.
 *   4. New families (on FL, not in the DB at all): inserted as status
 *      'novision' with empty shopify_product_ids — reviewed like any other
 *      design, pushed to FL only.
 *   5. Designs whose FL products all disappeared get their fl_* columns
 *      cleared (never excluded or deleted — the designs table is shared).
 *
 * Never touches approved_tags, status (except inserts), vision_* or any other
 * review field. Dry run (apply=false) computes everything and writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listProducts, productToFamily } from "./shopify";

interface DbRow {
  design_family: string;
  variant_skus: string[] | null;
  shopify_product_ids: number[] | null;
  fl_product_ids: number[] | null;
  fl_product_types: string[] | null;
  fl_tags: string[] | null;
  image_url: string | null;
}

interface Aggregated {
  design_family: string;
  design_name: string;
  manufacturer: string;
  tags: Set<string>;
  productIds: Set<number>;
  productTypes: Set<string>;
  variantSkus: Set<string>;
  imageUrl: string | null;
}

export interface FlSyncOptions {
  apply: boolean;
}

export interface FlSyncResult {
  apply: boolean;
  productsSeen: number;
  productsMatched: number;
  families: number;
  /** Existing designs newly linked to FL or with FL drift. */
  linked: number;
  /** FL-only families not yet in the DB (inserted when apply). */
  inserted: number;
  /** Designs whose FL products all disappeared (fl_* cleared when apply). */
  unlinked: number;
  unlinkSkippedSafety: string | null;
  /** A few new FL-only families, for eyeballing a dry run. */
  newSamples: string[];
  durationMs: number;
}

const SAFE_MIN_FAMILIES = 500;

/**
 * FL products the pipeline ignores entirely — never linked, imported or
 * pushed. "Sets" (~1,800 draft bundle products) per Blake 2026-10-23.
 */
export function isIgnoredFlProduct(p: { product_type?: string | null }): boolean {
  return (p.product_type ?? "").trim().toLowerCase() === "sets";
}

const sortNums = (xs: number[]) => [...xs].sort((a, b) => a - b);
const sortStrs = (xs: string[]) => [...xs].sort();
const sameArr = <T>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

async function loadDesigns(sb: SupabaseClient): Promise<DbRow[]> {
  const out: DbRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,variant_skus,shopify_product_ids,fl_product_ids,fl_product_types,fl_tags,image_url",
      )
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`load designs: ${error.message}`);
    const rows = (data ?? []) as unknown as DbRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function updateWithRetry(
  sb: SupabaseClient,
  family: string,
  patch: Record<string, unknown>,
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await sb.from("designs").update(patch).eq("design_family", family);
    if (!error) return;
    lastErr = error;
    await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt)));
  }
  const msg = (lastErr as { message?: string } | null)?.message ?? String(lastErr);
  throw new Error(`update ${family}: ${msg}`);
}

export async function runFlSync(sb: SupabaseClient, opts: FlSyncOptions): Promise<FlSyncResult> {
  const startedAt = Date.now();
  const rows = await loadDesigns(sb);
  const byFamilyRow = new Map(rows.map((r) => [r.design_family, r]));
  const familyBySku = new Map<string, string>();
  for (const r of rows) {
    for (const s of r.variant_skus ?? []) {
      const k = s.trim().toUpperCase();
      if (k && !familyBySku.has(k)) familyBySku.set(k, r.design_family);
    }
  }

  // ─── 1. Stream FL, group by family ─────────────────────────────────
  const agg = new Map<string, Aggregated>();
  let productsSeen = 0;
  let productsMatched = 0;
  for await (const p of listProducts({ target: "fl", status: "active,draft" })) {
    productsSeen++;
    if (isIgnoredFlProduct(p)) continue;
    let family: string | null = null;
    for (const v of p.variants ?? []) {
      const k = (v.sku ?? "").trim().toUpperCase();
      const f = k ? familyBySku.get(k) : undefined;
      if (f) {
        family = f;
        break;
      }
    }
    const resolved = productToFamily(p);
    if (!family) family = resolved?.design_family ?? null;
    if (!family) continue; // no SKU at all — accessory / placeholder
    productsMatched++;

    const tags = (p.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const pt = (p.product_type ?? "").trim();
    const skus = (p.variants ?? []).map((v) => (v.sku ?? "").trim()).filter(Boolean);
    const img = p.image?.src ?? null;
    const a = agg.get(family);
    if (a) {
      for (const t of tags) a.tags.add(t);
      a.productIds.add(p.id);
      if (pt) a.productTypes.add(pt);
      for (const s of skus) a.variantSkus.add(s);
      if (!a.imageUrl && img) a.imageUrl = img;
    } else {
      agg.set(family, {
        design_family: family,
        design_name: p.title,
        manufacturer: resolved?.manufacturer ?? "unknown",
        tags: new Set(tags),
        productIds: new Set([p.id]),
        productTypes: pt ? new Set([pt]) : new Set(),
        variantSkus: new Set(skus),
        imageUrl: img,
      });
    }
  }

  // ─── 2. Diff against the DB ────────────────────────────────────────
  const inserts: Record<string, unknown>[] = [];
  const updates: Array<{ family: string; patch: Record<string, unknown> }> = [];
  for (const a of agg.values()) {
    const ids = sortNums([...a.productIds]);
    const types = sortStrs([...a.productTypes]);
    const tags = sortStrs([...a.tags]);
    const skus = sortStrs([...a.variantSkus]);
    const row = byFamilyRow.get(a.design_family);
    if (!row) {
      inserts.push({
        design_family: a.design_family,
        design_name: a.design_name,
        manufacturer: a.manufacturer,
        status: "novision",
        shopify_product_ids: [],
        shopify_tags: tags,
        shopify_product_types: types,
        variant_skus: skus,
        image_url: a.imageUrl,
        fl_product_ids: ids,
        fl_product_types: types,
        fl_tags: tags,
      });
      continue;
    }
    const flOnly = (row.shopify_product_ids ?? []).length === 0;
    const drift =
      !sameArr(sortNums(row.fl_product_ids ?? []), ids) ||
      !sameArr(sortStrs(row.fl_product_types ?? []), types) ||
      !sameArr(sortStrs(row.fl_tags ?? []), tags) ||
      (flOnly && !sameArr(sortStrs(row.variant_skus ?? []), skus));
    if (!drift) continue;
    const patch: Record<string, unknown> = {
      fl_product_ids: ids,
      fl_product_types: types,
      fl_tags: tags,
    };
    if (flOnly) {
      patch.shopify_tags = tags;
      patch.shopify_product_types = types;
      patch.variant_skus = skus;
      if (!row.image_url && a.imageUrl) patch.image_url = a.imageUrl;
    }
    updates.push({ family: a.design_family, patch });
  }

  // Designs linked to FL whose FL products are all gone.
  const unlinks = rows
    .filter((r) => (r.fl_product_ids ?? []).length > 0 && !agg.has(r.design_family))
    .map((r) => r.design_family);
  let unlinkSkippedSafety: string | null = null;
  const unlinkCap = Math.max(50, Math.floor(agg.size * 0.05));
  if (agg.size < SAFE_MIN_FAMILIES) {
    unlinkSkippedSafety = `only ${agg.size} FL families found; below safety threshold (${SAFE_MIN_FAMILIES})`;
  } else if (unlinks.length > unlinkCap) {
    unlinkSkippedSafety = `${unlinks.length} unlinks exceeds safety cap of ${unlinkCap}; investigate manually`;
  }

  const result: FlSyncResult = {
    apply: opts.apply,
    productsSeen,
    productsMatched,
    families: agg.size,
    linked: updates.length,
    inserted: inserts.length,
    unlinked: unlinkSkippedSafety ? 0 : unlinks.length,
    unlinkSkippedSafety,
    newSamples: inserts
      .slice(0, 10)
      .map((r) => `${r.design_family} · ${r.manufacturer} · ${r.design_name}`),
    durationMs: 0,
  };
  if (!opts.apply) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // ─── 3. Apply ──────────────────────────────────────────────────────
  for (let i = 0; i < inserts.length; i += 200) {
    // ignoreDuplicates: never overwrite a row that appeared mid-sync.
    const { error } = await sb
      .from("designs")
      .upsert(inserts.slice(i, i + 200), { onConflict: "design_family", ignoreDuplicates: true });
    if (error) throw new Error(`insert batch at ${i}: ${error.message}`);
  }
  // Small parallel batches: thousands of rows on the first run.
  for (let i = 0; i < updates.length; i += 10) {
    await Promise.all(updates.slice(i, i + 10).map((u) => updateWithRetry(sb, u.family, u.patch)));
  }
  if (!unlinkSkippedSafety) {
    for (const family of unlinks) {
      await updateWithRetry(sb, family, { fl_product_ids: [], fl_product_types: [], fl_tags: [] });
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
