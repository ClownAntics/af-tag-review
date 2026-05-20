/**
 * Heuristics for classifying a design as an "accessory" — something that
 * shouldn't go through the vision review pipeline. Used by the Settings →
 * Bulk exclude flow.
 *
 * Rule (strict, per Blake): a product_type counts as accessory if it
 * literally contains the word "Accessories" OR is exactly "Gift Card".
 * Everything else — including standalone "Pole" / "Stake" / "Bracket"
 * categories that aren't already inside an Accessories sub-tree — stays in
 * the review pipeline and can be excluded per-card with the × button.
 *
 * Source signal: `shopify_product_types` (the text[] column populated by
 * shopify-pull from Shopify's native product_type field). A design family
 * is flagged only if EVERY type in the array matches — that way a Garden
 * Flag that happens to also have an accessory product attached doesn't get
 * excluded incorrectly.
 *
 * Empty types[] is treated as "unknown" → not an accessory (fall back to
 * manual review). Misconfigured EV-prefixed values are NOT treated as
 * accessories — those are real products with the wrong product_type field;
 * see scripts/export-ev-product-types.ts for the fix-up CSV.
 */

// Word-boundary on "Accessories" (covers "X: Accessories", "X: Accessories: Y",
// "Stakes & Accessories", etc.) + exact match on the "Gift Card" category.
const ACCESSORY_RE = /\bAccessories\b|^Gift Card$/i;

/** True iff this single product_type value looks like an accessory. */
export function isAccessoryType(t: string): boolean {
  if (!t) return false;
  // Don't classify the EV-prefixed garbage values as accessories — those are
  // misconfigured real products (Evergreen Switch Mats etc.), to be fixed in
  // Shopify, not excluded here.
  if (/^EV\d+$/.test(t)) return false;
  return ACCESSORY_RE.test(t);
}

/**
 * True iff a design family should be bulk-excluded. Conservative: only true
 * when EVERY product_type in the family matches the accessory pattern AND at
 * least one value exists. Families with mixed flag+accessory products stay
 * in the review pipeline.
 */
export function isAccessoryFamily(types: string[] | null | undefined): boolean {
  if (!types || types.length === 0) return false;
  return types.every(isAccessoryType);
}
