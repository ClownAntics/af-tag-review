/**
 * Shared helper: parse review filter params out of a URL search params and
 * apply them to a PostgREST query chain. Used by /api/review/counts and
 * /api/review/queue so they support the same filter set.
 */
import type { ReviewFilters } from "@/lib/types";

export function parseFiltersFromSearch(sp: URLSearchParams): ReviewFilters {
  return {
    themeName: sp.get("themeName") || "all",
    subTheme: sp.get("subTheme") || "all",
    subSubTheme: sp.get("subSubTheme") || "all",
    tag: sp.get("tag") || "all",
    productType: sp.get("productType") || "all",
    manufacturer: sp.get("manufacturer") || "all",
  };
}

// Structural subset of the PostgREST query builder — enough to chain the
// filters we use. Supabase's generic types are too deep to re-infer here.
type Chain = {
  eq: (col: string, v: string) => Chain;
  contains: (col: string, v: string[]) => Chain;
  or: (expr: string) => Chain;
};

export function applyReviewFilters<Q extends Chain>(
  query: Q,
  filters: ReviewFilters,
): Q {
  let q = query;
  if (filters.themeName !== "all") q = q.contains("theme_names", [filters.themeName]) as Q;
  if (filters.subTheme !== "all") q = q.contains("sub_themes", [filters.subTheme]) as Q;
  if (filters.subSubTheme !== "all") q = q.contains("sub_sub_themes", [filters.subSubTheme]) as Q;
  if (filters.tag !== "all") {
    // The dropdown emits the canonical FL Themes Search Term (e.g.
    // `4th-Of-July`). Match against any of three storage forms:
    //   1. `approved_tags` — always canonical (curation enforces it).
    //   2. `shopify_tags` — canonical form (pre-push or hand-curated).
    //   3. `shopify_tags` — lowercased (Shopify lowercases on store, so
    //      after a push + re-pull the value comes back as `4th-of-july`).
    // PostgREST `.or()` builds an `OR` across these three contains-checks.
    const canon = filters.tag;
    const lower = canon.toLowerCase();
    const parts = [
      `approved_tags.cs.{${canon}}`,
      `shopify_tags.cs.{${canon}}`,
    ];
    if (lower !== canon) parts.push(`shopify_tags.cs.{${lower}}`);
    q = q.or(parts.join(",")) as Q;
  }
  if (filters.productType !== "all") q = q.contains("shopify_product_types", [filters.productType]) as Q;
  if (filters.manufacturer !== "all") q = q.eq("manufacturer", filters.manufacturer) as Q;
  return q;
}

export function toQueryString(filters: ReviewFilters): string {
  const p = new URLSearchParams();
  if (filters.themeName !== "all") p.set("themeName", filters.themeName);
  if (filters.subTheme !== "all") p.set("subTheme", filters.subTheme);
  if (filters.subSubTheme !== "all") p.set("subSubTheme", filters.subSubTheme);
  if (filters.tag !== "all") p.set("tag", filters.tag);
  if (filters.productType !== "all") p.set("productType", filters.productType);
  if (filters.manufacturer !== "all") p.set("manufacturer", filters.manufacturer);
  return p.toString();
}
