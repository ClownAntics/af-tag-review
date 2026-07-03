/**
 * Storefront facet tags (T5).
 *
 * The theme's filter bar (assets/filter-bar.js on justforfunflags.com) is
 * 100% tag-driven: its Size / Material / Features dropdowns filter by exact
 * tag slugs via native Shopify tag URLs. This module derives those tags from
 * data we already hold (`shopify_product_types`, feature booleans) so the
 * push pipeline can emit them and light the facets up.
 *
 * Expected slugs (extracted from filter-bar.js SUB_FILTERS/FEATURES 2026-07):
 *   Material: printed applique burlap linen lustre moire foil-accent metal
 *             satin coir
 *   Size:     standard-garden mini-garden long-garden regular-mailbox
 *             large-mailbox regular-doormat mini-doormat
 *   Features: Reversible PremierSoft suedereflections GlitterTrends
 *             Printed-in-usa Eco-friendly
 * (Shopify lowercases stored tags; the filter bar slugifies before matching,
 * so emitting canonical case is fine.)
 *
 * OWNERSHIP: size + material derive deterministically from product_type, so
 * the push pipeline OWNS them (stale ones get corrected). Feature flags are
 * only partially populated in our DB (e.g. `is_envirofriendly` is empty while
 * ~216 live products carry Eco-friendly), so feature tags are ADDITIVE-ONLY:
 * we emit them when our flag is true but never remove existing ones — they
 * are deliberately NOT in OWNED_FACET_KEYS.
 */
import { normalizeTagKey } from "./shopify";

export interface FacetFlags {
  is_double_sided?: boolean | null;
  is_reversible?: boolean | null;
  is_premiersoft?: boolean | null;
  is_suede_reflections?: boolean | null;
  is_glittertrends?: boolean | null;
  is_printed_in_usa?: boolean | null;
  is_envirofriendly?: boolean | null;
}

/** Material leaf of a product_type string → facet tag. */
function materialTag(type: string): string | null {
  const t = type.toLowerCase();
  if (t.includes("sublimated (printed)")) return "printed";
  if (t.includes("appliqued")) return "applique"; // covers "Double Appliqued"
  if (t.includes("burlap")) return "burlap";
  if (t.includes("linen")) return "linen";
  if (t.includes("lustre")) return "lustre";
  if (t.includes("moire")) return "moire";
  if (t.includes("foil accent")) return "foil-accent";
  if (t.includes("metal flags")) return "metal";
  if (t.includes("satin")) return "satin";
  if (t.includes("(coir)")) return "coir";
  return null;
}

/** Size dimension of a product_type string → facet tag. */
function sizeTag(type: string): string | null {
  const t = type.toLowerCase();
  // Garden flag sizes (the filter bar only offers Size on garden-flags).
  if (t.includes("long garden flags")) return "long-garden";
  if (t.includes("mini flags")) return "mini-garden";
  if (t.startsWith("sleeved flags: small flags")) return "standard-garden";
  // Mailbox covers.
  if (t.includes("mailbox covers: large")) return "large-mailbox";
  if (t.includes("mailbox cover")) return "regular-mailbox"; // "Mailbox Covers: Regular", legacy "Mailbox Cover"
  // Doormats.
  if (t.includes("mini door mats") || t.includes("doormats: mini")) return "mini-doormat";
  if (t.includes("doormats:") || t === "door mat") return "regular-doormat";
  return null;
}

/** All size/material facet tags for a design's product_type strings. */
export function sizeMaterialTags(productTypes: string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const type of productTypes ?? []) {
    const m = materialTag(type);
    if (m) out.add(m);
    const s = sizeTag(type);
    if (s) out.add(s);
  }
  return [...out].sort();
}

/** Feature tags (additive-only) from the boolean flag columns. */
export function featureTags(flags: FacetFlags | null | undefined): string[] {
  if (!flags) return [];
  const out: string[] = [];
  if (flags.is_reversible) out.push("Reversible");
  if (flags.is_premiersoft) out.push("PremierSoft");
  if (flags.is_suede_reflections) out.push("suedereflections");
  if (flags.is_glittertrends) out.push("GlitterTrends");
  if (flags.is_printed_in_usa) out.push("Printed-in-usa");
  if (flags.is_envirofriendly) out.push("Eco-friendly");
  if (flags.is_double_sided) out.push("Double-Sided");
  return out.sort();
}

/** Everything the push should emit for a design (size+material+features). */
export function facetTagsForDesign(
  productTypes: string[] | null | undefined,
  flags: FacetFlags | null | undefined,
): string[] {
  return [...new Set([...sizeMaterialTags(productTypes), ...featureTags(flags)])].sort();
}

/**
 * Facet vocabulary the pipeline OWNS on push (normalized keys): size +
 * material only. A stale `mini-garden` on a standard flag gets removed;
 * feature tags are never removed (partial data — see module docs).
 */
export const OWNED_FACET_KEYS: ReadonlySet<string> = new Set(
  [
    "printed", "applique", "burlap", "linen", "lustre", "moire",
    "foil-accent", "metal", "satin", "coir",
    "standard-garden", "mini-garden", "long-garden",
    "regular-mailbox", "large-mailbox", "regular-doormat", "mini-doormat",
  ].map(normalizeTagKey),
);
