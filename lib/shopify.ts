/**
 * Thin wrapper around Shopify's Admin REST API.
 *
 * Scope for the Tag Review project:
 *   - Pull products (title + variants + tags) from the JFF store
 *   - Push tag updates (future; not wired here yet)
 *
 * Auth uses a custom-app Admin API access token (starts with `shpat_`) via the
 * `X-Shopify-Access-Token` header. Reads `SHOPIFY_STORE` + `SHOPIFY_ADMIN_TOKEN`
 * from the environment. Service-role client — never import from client code.
 */

const API_VERSION = "2025-01";

export interface ShopifyVariant {
  id: number;
  sku: string | null;
  title: string | null;
}

export interface ShopifyImage {
  id: number;
  src: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor: string;
  status: "active" | "archived" | "draft";
  tags: string; // comma-separated string; we split on read.
  product_type: string; // Shopify's free-text category (e.g. "Garden Flag", "Flag Stake")
  image: ShopifyImage | null; // Primary product image; null if the product has no media yet.
  variants: ShopifyVariant[];
}

function baseUrl(): string {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("SHOPIFY_STORE env var is not set");
  return `https://${store}.myshopify.com/admin/api/${API_VERSION}`;
}

function authHeader(): HeadersInit {
  const tok = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!tok) throw new Error("SHOPIFY_ADMIN_TOKEN env var is not set");
  return { "X-Shopify-Access-Token": tok, "Content-Type": "application/json" };
}

// Shopify's Link header for cursor pagination looks like:
//   <https://…/products.json?page_info=abc&limit=250>; rel="next", <…>; rel="previous"
// We only care about the next cursor.
function extractNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) continue;
    try {
      return new URL(m[1]).searchParams.get("page_info");
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<{ data: T; linkHeader: string | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: authHeader() });
    if (res.status === 429) {
      // Respect Retry-After when given, otherwise back off linearly. Shopify's
      // leaky-bucket lets 2 req/sec; occasional 429s are expected on big pulls.
      const retry = Number(res.headers.get("Retry-After") ?? "2");
      await sleep((retry + attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as T;
    return { data, linkHeader: res.headers.get("Link") };
  }
  throw new Error("Shopify: exhausted retries on 429");
}

/**
 * Replace a product's `tags` field. Shopify stores tags as a comma-separated
 * string; callers pass a string[] and we join here. Returns the response body
 * so callers can confirm what Shopify actually stored (Shopify normalizes:
 * lowercasing, deduping, trimming whitespace).
 */
export async function updateProductTags(
  productId: number,
  tags: string[],
): Promise<{ id: number; tags: string }> {
  const url = `${baseUrl()}/products/${productId}.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeader(),
      body: JSON.stringify({ product: { id: productId, tags: tags.join(", ") } }),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After") ?? "2");
      await sleep((retry + attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify PUT ${productId} ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as { product: { id: number; tags: string } };
    return data.product;
  }
  throw new Error(`Shopify: exhausted retries updating product ${productId}`);
}

/**
 * Normalize a tag for owned-tag comparison: lowercase, spaces → hyphens.
 * Shopify lowercases tags on store, and legacy data mixes "4th of July" with
 * "4th-of-july" — both must match the taxonomy term `4th-Of-July`.
 */
export function normalizeTagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Merge-push a product's tags (T7): replace only the tags the curation
 * pipeline OWNS (canonical taxonomy Search Terms — `ownedKeys` holds their
 * normalizeTagKey forms), preserving every other live tag (brand tags like
 * `america-forever`, functional tags like `Garden Flag` that smart
 * collections + the theme filter bar depend on, app/size/material tags…).
 *
 *   next = (current − owned) ∪ approvedTags ∪ perProductTags(product_type)
 *
 * Consequence: a stale taxonomy tag on the live product (e.g. a leftover
 * `memorial-day` the curation dropped) is REMOVED by the next push, while
 * non-taxonomy tags survive. Returns Shopify's stored result so callers can
 * mirror the real final tag set.
 *
 * `perProductTags` (optional) computes tags from THIS product's own
 * product_type — size/material facet tags differ across a family's garden /
 * house / mailbox products, so they cannot come from the family-level union
 * (that put `standard-garden` on house flags — the 2026-07-03 backfill bug).
 */
export async function mergeProductTags(
  productId: number,
  approvedTags: string[],
  ownedKeys: ReadonlySet<string>,
  perProductTags?: (productType: string) => string[],
): Promise<{ id: number; tags: string }> {
  const url = `${baseUrl()}/products/${productId}.json?fields=id,tags,product_type`;
  let current: string[] = [];
  let productType = "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: authHeader() });
    if (res.status === 429 && attempt < 5) {
      const retry = Number(res.headers.get("Retry-After") ?? "2");
      await sleep((retry + attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify GET ${productId} ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as { product: { tags: string; product_type?: string } };
    current = (data.product.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    productType = (data.product.product_type ?? "").trim();
    break;
  }
  // De-dupe by normalized key (approved "Printed" + facet "printed" → one),
  // first occurrence wins so curated casing is kept.
  const emit: string[] = [];
  const emitKeys = new Set<string>();
  for (const t of [...approvedTags, ...(perProductTags ? perProductTags(productType) : [])]) {
    const k = normalizeTagKey(t);
    if (emitKeys.has(k)) continue;
    emitKeys.add(k);
    emit.push(t);
  }
  const preserved = current.filter(
    (t) => !ownedKeys.has(normalizeTagKey(t)) && !emitKeys.has(normalizeTagKey(t)),
  );
  const next = [...emit, ...preserved].sort();
  return updateProductTags(productId, next);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ListProductsOptions {
  /** Shopify product status; comma-separated string. Default: active,archived (draft excluded). */
  status?: string;
  /** Per-page limit (max 250). */
  limit?: number;
  /** Hard cap on total products yielded — useful for smoke tests. Default: unlimited. */
  max?: number;
  /** Millisecond delay between pages to stay under rate limits. Default: 400ms. */
  delayMs?: number;
}

/**
 * Async generator that yields products one at a time, paginating under the hood.
 * Caller can break early (e.g. for a smoke test) without loading everything.
 */
export async function* listProducts(
  opts: ListProductsOptions = {},
): AsyncGenerator<ShopifyProduct, void, unknown> {
  const status = opts.status ?? "active,archived";
  const limit = opts.limit ?? 250;
  const max = opts.max ?? Infinity;
  const delayMs = opts.delayMs ?? 400;

  let url: string | null =
    `${baseUrl()}/products.json?status=${status}&limit=${limit}&fields=id,title,handle,vendor,status,tags,product_type,image,variants`;
  let yielded = 0;

  while (url && yielded < max) {
    const { data, linkHeader } = await fetchJson<{ products: ShopifyProduct[] }>(url);
    for (const p of data.products) {
      yield p;
      yielded++;
      if (yielded >= max) return;
    }
    const nextPageInfo = extractNextPageInfo(linkHeader);
    if (!nextPageInfo) break;
    url = `${baseUrl()}/products.json?page_info=${encodeURIComponent(nextPageInfo)}&limit=${limit}`;
    await sleep(delayMs);
  }
}

/**
 * Parse an AF variant SKU into its canonical design_family. AF is the one
 * vendor where we collapse multiple physical products (garden flag + house
 * flag + doormat + mailbox cover for the same artwork) under a single family.
 *
 * Matches: AFGF|AFHF|AFGB|AFDR|AFMC + {2-letter region}{4-digit id}
 * + optional suffix.
 *
 * The suffix is permissive on purpose. `-CF`/`-CD`/`-CG` (personalized) and
 * `WH` (preprint) are variants of the *same artwork* and collapse onto the
 * base design_family. A single trailing letter `A`–`Z` is a MONOGRAM variant —
 * a DIFFERENT design from the non-monogram base — so all 26 letters collapse
 * into one monogram family per number, keyed with an "M" suffix
 * (`AFGFFA0001A` → `AFFA0001M`, while `AFGFFA0001` → `AFFA0001`). New suffix
 * codes have surfaced over time (-CG was the most recent), so we accept any
 * `-XX[X]` or 1–2 trailing letters rather than enumerating the known set.
 *
 * **Case-insensitive on the SKU as a whole**, then the canonical family is
 * built in uppercase. Shopify has some variant SKUs like `AFhFSP0677` (note
 * the lowercase `h`) for the house version of an artwork whose garden
 * version is `AFGFSP0677`. Without case insensitivity those variants would
 * resolve to a different design_family and never merge with the garden
 * version, producing two separate review rows for the same artwork.
 *
 * Accessories (AFFPGS/AFACRS/AFGFC/AFMB/AFMFS) and non-AF vendors return null.
 */
export function skuToAfDesignFamily(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const m = sku
    .toUpperCase()
    .match(/^AF(GF|HF|GB|DR|MC)([A-Z]{2}\d{4})(-[A-Z]{1,3}|[A-Z]{1,2})?$/);
  if (!m) return null;
  const code = m[1];
  const body = m[2];
  const suffix = m[3] ?? "";
  // Garden + House (+ Mailbox) share artwork per design number → collapse to
  // "AF". Garden-Banner (GB) and Doormat (DR) reuse numbers across DIFFERENT
  // artwork, so they get their own family namespace and never merge with the
  // flags. Single trailing letter = monogram → own "M"-suffixed family (the
  // base design has no monogram; merging polluted its tags). WH preprint and
  // -CF/-CD/-CG personalized stay with the base.
  // Must stay in sync with parseSku() in lib/sku-parser.ts.
  const prefix = code === "GB" ? "AFGB" : code === "DR" ? "AFDR" : "AF";
  const mono = /^[A-Z]$/.test(suffix) ? "M" : "";
  return `${prefix}${body}${mono}`;
}

/**
 * Resolve a Shopify product to its design_family + manufacturer. For AF's
 * tag-bearing products we collapse variants under a stable AF+body key. For
 * every other vendor we treat each Shopify product as its own family, keyed
 * on its first non-empty variant SKU (SKU is what we use for image URLs on
 * those vendors, so it's the right stable handle). Falls back to the Shopify
 * product ID if no SKU exists.
 *
 * Returns null for accessories / products with no SKU at all — those don't
 * belong in the tag review pipeline.
 */
/**
 * Collapse Shopify vendor-string variants onto a single canonical manufacturer
 * name so that duplicates from inconsistent data entry don't fragment the
 * catalog. Update the map when new variants surface. AF normalizes to "AF" to
 * match the 2,868 existing designs that were seeded with `manufacturer='AF'`.
 */
const VENDOR_NORMALIZATION: Array<[RegExp, string]> = [
  [/^america forever/i, "AF"],
  [/^carson/i, "Carson"],
  [/^premier/i, "Premier"],
  [/^in the breeze$/i, "In the Breeze"],
];

function normalizeVendor(vendor: string): string {
  const v = vendor.trim();
  if (!v) return "unknown";
  for (const [re, canonical] of VENDOR_NORMALIZATION) {
    if (re.test(v)) return canonical;
  }
  return v;
}

export function productToFamily(
  product: ShopifyProduct,
): { design_family: string; manufacturer: string } | null {
  const manufacturer = normalizeVendor(product.vendor || "");
  // Monogram products (single-letter SKU tails → "…M" families) are OUT of
  // the tag pipeline entirely (Blake 2026-07-06: most have no non-monogram
  // base design; the 45 mono-only families were excluded). Skip them here so
  // syncs never re-insert them.
  for (const v of product.variants ?? []) {
    const af = skuToAfDesignFamily(v.sku);
    if (af && /\dM$/.test(af)) return null;
  }
  // AF: group by artwork, not by product — garden + house share design_family.
  for (const v of product.variants ?? []) {
    const af = skuToAfDesignFamily(v.sku);
    if (af) return { design_family: af, manufacturer };
  }
  // Non-AF path: use the first real variant SKU as the family.
  const firstSku = (product.variants ?? []).map((v) => v.sku?.trim()).find((s) => !!s);
  if (firstSku) return { design_family: firstSku, manufacturer };
  // No SKU at all — accessory with just a product ID. Skip.
  return null;
}
