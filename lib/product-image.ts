/**
 * Shared image-URL / SKU derivation for product tiles.
 *
 * AF is the one manufacturer where a design_family spans multiple physical
 * products (garden flag + house flag + doormat + mailbox cover + banner share
 * one artwork). For AF we build SKUs from the family body + a suffix that
 * depends on the design's personalization flags. For every other vendor the
 * design_family IS the SKU (one product = one family), so we use it directly.
 *
 * Kept deliberately small — a few UI components and the vision-run route all
 * need to build the same URLs, and duplicating the branching logic is how the
 * "non-AF products got AF URLs" bug shipped in the first place.
 */
import type { Design } from "@/lib/types";

const IMG_BASE = "https://images.clownantics.com/CA_resize_500_500/";

export type AfSuffix = "" | "A" | "-CF" | "WH";

export function afSuffix(design: Pick<Design, "has_monogram" | "has_personalized" | "has_preprint">): AfSuffix {
  if (design.has_monogram) return "A";
  if (design.has_personalized) return "-CF";
  if (design.has_preprint) return "WH";
  return "";
}

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
 * Preferred source: `design.variant_skus` (populated by shopify-pull from the
 * actual Shopify variant data) and `design.image_url` (populated from
 * `product.image.src`). When available these are the truth and we use them
 * verbatim. This is what handles non-standard SKUs like the new burlap line
 * (`afgfms-b-0001`) without doubled-prefix garbage.
 *
 * Fallback: derive from the design_family using the AF regex pattern. Kept
 * because some pre-migration-008 rows may still lack `variant_skus`, and
 * because non-AF manufacturers' design_family IS the SKU. The fallback path
 * is only correct for designs whose SKUs match the strict AF pattern; new
 * variant patterns should always come through the pulled column.
 */
export function variantSkusFor(design: Design): VariantSku[] {
  // Preferred: use the Shopify-pulled values.
  const stored = (design.variant_skus ?? []).filter((s) => s && s.length > 0);
  if (stored.length > 0) {
    const img =
      design.image_url && design.image_url.length > 0
        ? design.image_url
        : imageUrlForSku(stored[0]);
    return stored.map((sku) => ({ sku, label: "", imageUrl: img }));
  }

  // Fallback: derive from the SKU pattern (covers pre-migration rows + non-AF).
  const mk = (sku: string, label: string): VariantSku => ({
    sku,
    label,
    imageUrl: design.image_url && design.image_url.length > 0
      ? design.image_url
      : imageUrlForSku(sku),
  });
  if (design.manufacturer !== "AF") {
    return [mk(design.design_family, "")];
  }
  const body = design.design_family.replace(/^AF/, "");
  const suffix = afSuffix(design);
  const out: VariantSku[] = [
    mk(`AFGF${body}${suffix}`, ""),
    mk(`AFHF${body}${suffix}`, "house"),
  ];
  if ((design.product_types ?? []).includes("garden-banner")) {
    out.push(mk(`AFGB${body}${suffix}`, "banner"));
  }
  return out;
}

/** Primary (first) image SKU — useful when you only want one image. */
export function primaryImageSku(design: Design): string {
  return variantSkusFor(design)[0].sku;
}

/**
 * Server-side convenience: build the primary image URL from the minimal set
 * of design fields. Used by the vision pipeline, which fetches just a few
 * Supabase columns per family (not a full Design row).
 *
 * Preferred: the Shopify-pulled `image_url` if present — that's the real
 * CDN URL Claude can fetch. Falls back to SKU-pattern derivation for
 * pre-migration rows or designs where Shopify had no image. The fallback
 * is brittle for non-standard SKUs (e.g. `AFhFSP0677` produces a CDN URL
 * that 404s), so callers that hit "Unable to download the file" errors
 * should run `shopify-pull --apply` to backfill `image_url`.
 */
export function primaryImageUrl(design: {
  manufacturer: string | null | undefined;
  design_family: string;
  has_monogram?: boolean | null;
  has_personalized?: boolean | null;
  has_preprint?: boolean | null;
  image_url?: string | null;
  variant_skus?: string[] | null;
}): string {
  if (design.image_url && design.image_url.length > 0) {
    return design.image_url;
  }
  // No stored image_url — try a stored variant SKU before doing AF-pattern
  // derivation. Covers non-AF rows and pre-migration rows that have
  // variant_skus populated but image_url null (rare but possible).
  const firstSku = (design.variant_skus ?? []).find((s) => s && s.length > 0);
  if (firstSku) return imageUrlForSku(firstSku);

  if (design.manufacturer !== "AF") {
    return imageUrlForSku(design.design_family);
  }
  const body = design.design_family.replace(/^AF/, "");
  const suffix = afSuffix({
    has_monogram: !!design.has_monogram,
    has_personalized: !!design.has_personalized,
    has_preprint: !!design.has_preprint,
  });
  return imageUrlForSku(`AFGF${body}${suffix}`);
}
