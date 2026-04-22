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
 * Ordered list of variant SKUs to display on a design tile. For AF this is
 * garden + house (+ optional banner); for non-AF it's just the one SKU that
 * IS the design_family.
 */
export function variantSkusFor(design: Design): VariantSku[] {
  const mk = (sku: string, label: string): VariantSku => ({
    sku,
    label,
    imageUrl: imageUrlForSku(sku),
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
 */
export function primaryImageUrl(design: {
  manufacturer: string | null | undefined;
  design_family: string;
  has_monogram?: boolean | null;
  has_personalized?: boolean | null;
  has_preprint?: boolean | null;
}): string {
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
