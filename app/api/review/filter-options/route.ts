/**
 * GET /api/review/filter-options
 *
 * Distinct values across the entire designs table, for populating the filter
 * dropdowns. Cached 60s — these don't change often and the pagination loop
 * below would be wasteful on every page load otherwise.
 */
import { getSupabase } from "@/lib/supabase";
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
        "theme_names,sub_themes,sub_sub_themes,shopify_tags,product_types,manufacturer",
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
      "theme_names" | "sub_themes" | "sub_sub_themes" | "shopify_tags" | "product_types" | "manufacturer"
    >[];
    for (const r of rows) {
      for (const v of r.theme_names || []) sets.themeNames.add(v);
      for (const v of r.sub_themes || []) sets.subThemes.add(v);
      for (const v of r.sub_sub_themes || []) sets.subSubThemes.add(v);
      for (const v of r.shopify_tags || []) sets.tags.add(v);
      for (const v of r.product_types || []) sets.productTypes.add(v);
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
