/**
 * GET /api/review/filter-options
 *
 * Distinct values across the entire designs table, for populating the filter
 * dropdowns. Cached 60s — these don't change often and the pagination loop
 * below would be wasteful on every page load otherwise.
 *
 * The Tag dropdown source is **canonicalized through the FL Themes
 * taxonomy**: a raw tag like `4th of July`, `4th-Of-July`, or the
 * Shopify-lowercased `4th-of-july` all resolve to the canonical Search
 * Term `4th-Of-July`. The dropdown only shows canonical Search Terms (no
 * case variants, no spaces-vs-hyphens duplicates), and we drop any tag
 * that doesn't resolve to a taxonomy entry at all — that's the source of
 * the "lots of tags that don't have anything" noise. Filtering still
 * happens against the raw `shopify_tags` column, so pick the canonical
 * value and the contains-query will match the canonical form that's in
 * approved_tags + the lowercased form Shopify stores after a push.
 */
import { getSupabase } from "@/lib/supabase";
import { getTaxonomy } from "@/lib/taxonomy-source";
import type { Design } from "@/lib/types";

export const revalidate = 60;

interface Options {
  themeNames: string[];
  subThemes: string[];
  subSubThemes: string[];
  tags: string[];
  productTypes: string[];
  manufacturers: string[];
}

export async function GET(): Promise<Response> {
  const supabase = getSupabase();

  // Load taxonomy and build a normalized→canonical lookup so any case
  // variant, spaces-instead-of-hyphens form, or post-push lowercased
  // form maps back to the canonical Search Term.
  const { entries } = await getTaxonomy();
  const canonicalByLower = new Map<string, string>();
  const norm = (s: string) => s.toLowerCase();
  // Also map "hyphens as spaces" so `4th-Of-July` covers `4th of july`,
  // `4th-of-july`, AND `4th-Of-July`.
  const normSpaced = (s: string) => s.toLowerCase().replace(/-/g, " ");
  const normHyphenated = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
  for (const e of entries) {
    if (!e.term) continue;
    canonicalByLower.set(norm(e.term), e.term);
    canonicalByLower.set(normSpaced(e.term), e.term);
    canonicalByLower.set(normHyphenated(e.term), e.term);
    // Also map the human label and its leaf component for legacy tags
    // that stored the label form ("Spring Flowers", "4th of July", etc.).
    if (e.label) {
      canonicalByLower.set(norm(e.label), e.term);
      // Last segment of "Name: Sub: SubSub" — the leaf concept.
      const leaf = e.label.split(":").pop()?.trim();
      if (leaf) {
        canonicalByLower.set(norm(leaf), e.term);
        canonicalByLower.set(normHyphenated(leaf), e.term);
      }
    }
  }

  // Pull only the fields we need, in pages, to avoid loading full rows.
  const sets = {
    themeNames: new Set<string>(),
    subThemes: new Set<string>(),
    subSubThemes: new Set<string>(),
    tags: new Set<string>(),
    productTypes: new Set<string>(),
    manufacturers: new Set<string>(),
  };

  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("designs")
      .select(
        "theme_names,sub_themes,sub_sub_themes,shopify_tags,approved_tags,shopify_product_types,manufacturer",
      )
      .range(offset, offset + pageSize - 1);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const rows = (data || []) as Pick<
      Design,
      | "theme_names"
      | "sub_themes"
      | "sub_sub_themes"
      | "shopify_tags"
      | "approved_tags"
      | "shopify_product_types"
      | "manufacturer"
    >[];
    for (const r of rows) {
      for (const v of r.theme_names || []) sets.themeNames.add(v);
      for (const v of r.sub_themes || []) sets.subThemes.add(v);
      for (const v of r.sub_sub_themes || []) sets.subSubThemes.add(v);
      // Tag dropdown: collect from both shopify_tags AND approved_tags,
      // resolving each one through the canonicalByLower lookup. Anything
      // that doesn't resolve is junk (free-text, typo, etc.) and stays
      // out of the dropdown.
      for (const v of r.shopify_tags || []) {
        const canonical = canonicalByLower.get(v.toLowerCase());
        if (canonical) sets.tags.add(canonical);
      }
      for (const v of r.approved_tags || []) {
        const canonical = canonicalByLower.get(v.toLowerCase());
        if (canonical) sets.tags.add(canonical);
      }
      for (const v of r.shopify_product_types || []) {
        // Filter out garbage values: some products in Shopify have a raw
        // product id (e.g. "EV432556") dumped into the product_type field
        // instead of a real category. Hide those from the dropdown — they
        // still live in the row so we don't lose data; this is purely a
        // picker-UX cleanup. Fix-at-source is in Shopify.
        if (/^EV\d+$/.test(v)) continue;
        sets.productTypes.add(v);
      }
      if (r.manufacturer) sets.manufacturers.add(r.manufacturer);
    }
    if (rows.length < pageSize) break;
  }

  const body: Options = {
    themeNames: Array.from(sets.themeNames).sort(),
    subThemes: Array.from(sets.subThemes).sort(),
    subSubThemes: Array.from(sets.subSubThemes).sort(),
    tags: Array.from(sets.tags).sort(),
    productTypes: Array.from(sets.productTypes).sort(),
    manufacturers: Array.from(sets.manufacturers).sort(),
  };
  return Response.json(body);
}
