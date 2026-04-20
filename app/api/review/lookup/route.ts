/**
 * GET /api/review/lookup?q=<SKU or name fragment>
 *
 * Tries SKU resolution first (variant → design_family via the shared parser).
 * Falls back to design_name substring match when the query doesn't look like
 * a SKU or the SKU isn't found. Returns up to 10 matches sorted by units desc
 * so the most-recognizable design floats to the top.
 */
import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { parseSku } from "@/lib/sku-parser";
import type { Design } from "@/lib/types";

export const dynamic = "force-dynamic";

const SELECT =
  "design_family,design_name,units_total,catalog_created_date,first_sale_date,product_types,shopify_tags,approved_tags,vision_tags,vision_raw,theme_names,sub_themes,sub_sub_themes,classification,status,has_monogram,has_personalized,has_preprint,last_reviewed_at,last_pushed_at,manufacturer";

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || sp.get("sku") || "").trim();
  if (!q) return errorResponse(400, "q query param required");

  const supabase = getSupabase();

  // Try SKU resolution first if the string looks SKU-ish (starts with AF).
  const looksLikeSku = /^AF/i.test(q);
  if (looksLikeSku) {
    const parsed = parseSku(q);
    const designFamily = parsed?.designFamily ?? q.toUpperCase();
    const { data, error } = await supabase
      .from("designs")
      .select(SELECT)
      .eq("design_family", designFamily)
      .maybeSingle();
    if (!error && data) {
      return Response.json({
        matches: [data as unknown as Design],
        kind: "sku",
      });
    }
  }

  // Name fallback (also used when SKU didn't resolve).
  const { data, error } = await supabase
    .from("designs")
    .select(SELECT)
    .ilike("design_name", `%${q}%`)
    .order("units_total", { ascending: false })
    .limit(10);

  if (error) return errorResponse(500, error.message);
  if (!data || data.length === 0) {
    return errorResponse(404, `no design matches "${q}"`);
  }

  return Response.json({
    matches: data as unknown as Design[],
    kind: "name",
  });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
