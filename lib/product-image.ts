/**
 * Shared image-URL / SKU helpers for product tiles.
 *
 * **Single source of truth for SKUs is Shopify.** We never fabricate SKUs
 * by stitching together a family code and a body (e.g. `AFGF` + body).
 * That approach is broken for two reasons:
 *   - Non-standard SKU patterns (e.g. the burlap line `afgfwr-b-0004`)
 *     produce nonsense like `AFGFafgfwr-b-0004` that doesn't exist in
 *     Shopify and 404s on the image CDN.
 *   - Non-AF manufacturers (Carson, Evergreen, Premier) have their own
 *     SKU schemes — `AFGFCA52602` for a Carson product is just wrong.
 *
 * The shopify-pull script populates `variant_skus` and `image_url` on
 * every design from the actual Shopify catalog. The UI reads those
 * columns verbatim; if a row is missing them, we show `design_family`
 * as a stable identifier rather than inventing SKUs that don't exist.
 */
import type { Design } from "@/lib/types";

const IMG_BASE = "https://images.clownantics.com/CA_resize_500_500/";

export function imageUrlForSku(sku: string): string {
  return `${IMG_BASE}${sku.toLowerCase()}.jpg`;
}

export interface VariantSku {
  sku: string;
  label: string;
  imageUrl: string;
}

/**
 * Ordered list of variant SKUs to display on a design tile.
 *
 * Source of truth: `design.variant_skus` (pulled from Shopify) and
 * `design.image_url` (`product.image.src`). If `variant_skus` is empty
 * we fall back to `design_family` so the tile always shows *something
 * real* — never a synthesized `AFGF<body>` string.
 */
export function variantSkusFor(design: Design): VariantSku[] {
  const stored = (design.variant_skus ?? []).filter((s) => s && s.length > 0);
  const skus = stored.length > 0 ? stored : [design.design_family];
  const imageUrl =
    design.image_url && design.image_url.length > 0
      ? design.image_url
      : imageUrlForSku(skus[0]);
  return skus.map((sku) => ({ sku, label: "", imageUrl }));
}

/** Primary (first) image SKU — useful when you only want one image. */
export function primaryImageSku(design: Design): string {
  return variantSkusFor(design)[0].sku;
}

/**
 * Server-side convenience: build the primary image URL from a minimal set
 * of design fields. Used by the vision pipeline, which fetches just a few
 * Supabase columns per family (not a full Design row).
 *
 * Preference: stored `image_url` → first stored `variant_sku` →
 * `design_family`. Never invents an AF-pattern SKU.
 */
export function primaryImageUrl(design: {
  design_family: string;
  image_url?: string | null;
  variant_skus?: string[] | null;
}): string {
  if (design.image_url && design.image_url.length > 0) {
    return design.image_url;
  }
  const firstSku = (design.variant_skus ?? []).find((s) => s && s.length > 0);
  return imageUrlForSku(firstSku ?? design.design_family);
}
