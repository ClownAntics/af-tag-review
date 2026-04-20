/**
 * GET /api/review/lookup?sku=<any SKU or design_family>
 *
 * Resolves any variant SKU (AFGFMS0278 / AFHFMS0278 / AFGBMS0278 / AFMS0278WH etc.)
 * to its parent design_family via the shared SKU parser, then returns the
 * matching design row (same shape as /api/review/queue). Used by the header
 * search box to jump straight to a design's detail modal.
 */
import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { parseSku } from "@/lib/sku-parser";
import type { Design } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sku = (req.nextUrl.searchParams.get("sku") || "").trim();
  if (!sku) return errorResponse(400, "sku query param required");

  // Accept either a variant SKU (AFGFMS0278) or the bare family (AFMS0278).
  const parsed = parseSku(sku);
  const designFamily = parsed?.designFamily ?? sku.toUpperCase();

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("designs")
    .select(
      "design_family,design_name,units_total,catalog_created_date,first_sale_date,product_types,shopify_tags,approved_tags,vision_tags,vision_raw,theme_names,sub_themes,sub_sub_themes,classification,status,has_monogram,has_personalized,has_preprint,last_reviewed_at,last_pushed_at,manufacturer",
    )
    .eq("design_family", designFamily)
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, `no design found for "${sku}" (family ${designFamily})`);

  return Response.json({ design: data as unknown as Design, design_family: designFamily });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
