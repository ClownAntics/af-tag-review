import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Design, ReviewStatus } from "@/lib/types";
import {
  applyReviewFilters,
  parseFiltersFromSearch,
} from "@/lib/review-filters";

export const dynamic = "force-dynamic";

const ALL_STATUSES: ReviewStatus[] = [
  "novision",
  "flagged",
  "pending",
  "readytosend",
  "updated",
];

// Returns designs at a given status, paginated + filtered. The review UI loads
// ~100 at a time and advances through them; larger queues should paginate.
export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (!status || !ALL_STATUSES.includes(status as ReviewStatus)) {
    return errorResponse(400, "status query param required");
  }
  const offset = parseInt(sp.get("offset") || "0", 10);
  const limit = Math.min(parseInt(sp.get("limit") || "100", 10), 500);
  const filters = parseFiltersFromSearch(sp);

  const supabase = getSupabase();
  // Cast through `unknown` so applyReviewFilters' structural type doesn't
  // tangle with PostgREST's deeply-nested generics (TS2589).
  const base = supabase
    .from("designs")
    .select(
      "design_family,design_name,units_total,catalog_created_date,first_sale_date,product_types,shopify_tags,approved_tags,vision_tags,vision_raw,theme_names,sub_themes,sub_sub_themes,classification,status,has_monogram,has_personalized,has_preprint,last_reviewed_at,last_pushed_at,manufacturer",
      { count: "exact" },
    )
    .eq("status", status) as unknown as Parameters<typeof applyReviewFilters>[0];

  const filtered = applyReviewFilters(base, filters) as unknown as ReturnType<
    ReturnType<typeof getSupabase>["from"]
  >["select"] extends (...args: unknown[]) => infer R
    ? R
    : never;

  // Sort order varies by tile (per Q29):
  //   pending     → most recently flagged → vision_completed first; vision_tagged_at desc
  //   readytosend → most recently approved first; last_reviewed_at desc
  //   updated     → most recently pushed first; last_pushed_at desc
  //   novision    → alphabetical by design_name (then family for stability)
  //   flagged     → most recent flag first; vision_tagged_at NULLs first then catalog_created_date
  //                  (no flagged_at column today; falling back is fine)
  const ordered = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = filtered as any;
    switch (status as ReviewStatus) {
      case "pending":
        return f
          .order("vision_tagged_at", { ascending: false, nullsFirst: false })
          .order("design_family", { ascending: true });
      case "readytosend":
        return f
          .order("last_reviewed_at", { ascending: false, nullsFirst: false })
          .order("design_family", { ascending: true });
      case "updated":
        return f
          .order("last_pushed_at", { ascending: false, nullsFirst: false })
          .order("design_family", { ascending: true });
      case "novision":
        return f
          .order("design_name", { ascending: true, nullsFirst: false })
          .order("design_family", { ascending: true });
      case "flagged":
      default:
        return f
          .order("catalog_created_date", { ascending: false, nullsFirst: false })
          .order("design_family", { ascending: true });
    }
  })();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error, count } = await (ordered as any).range(
    offset,
    offset + limit - 1,
  );

  if (error) return errorResponse(500, error.message);

  return Response.json({
    designs: (data || []) as unknown as Design[],
    total: count ?? 0,
    offset,
    limit,
  });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
