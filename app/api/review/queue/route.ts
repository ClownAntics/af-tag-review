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
  "excluded",
];

// Returns designs at a given status, paginated + filtered. The review UI loads
// ~100 at a time and advances through them; larger queues should paginate.
const SELECT_FIELDS =
  "design_family,design_name,units_total,catalog_created_date,first_sale_date,product_types,shopify_product_types,shopify_tags,approved_tags,vision_tags,vision_raw,theme_names,sub_themes,sub_sub_themes,classification,status,has_monogram,has_personalized,has_preprint,last_reviewed_at,last_pushed_at,manufacturer,variant_skus,image_url,first_seen_at";

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (!status || !ALL_STATUSES.includes(status as ReviewStatus)) {
    return errorResponse(400, "status query param required");
  }
  const offset = parseInt(sp.get("offset") || "0", 10);
  const limit = Math.min(parseInt(sp.get("limit") || "100", 10), 500);
  const filters = parseFiltersFromSearch(sp);
  // Optional override of the per-tile default ordering. "units_desc/asc" sorts
  // by lifetime units sold (a real column, so it paginates correctly across
  // the whole set). Anything else falls through to the per-status default.
  const sort = sp.get("sort");

  // Random sample mode: ?sample=N returns N random rows from the matching
  // set. PostgREST can't `ORDER BY random()`, so we fetch all keys first,
  // shuffle, slice, then fetch the full rows by `in()`. The Updated tile's
  // "🎲 Random 20" audit pattern is the main use case — also helpful on
  // any tile with thousands of rows where date-sorted pagination is slow.
  const sampleRaw = sp.get("sample");
  if (sampleRaw) {
    const n = Math.min(Math.max(parseInt(sampleRaw, 10) || 0, 1), 100);
    return handleSample({ status: status as ReviewStatus, n, filters });
  }

  const supabase = getSupabase();
  // Cast through `unknown` so applyReviewFilters' structural type doesn't
  // tangle with PostgREST's deeply-nested generics (TS2589).
  const base = supabase
    .from("designs")
    .select(SELECT_FIELDS, { count: "exact" })
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
    // Sales sort overrides the per-tile default when requested.
    if (sort === "units_desc" || sort === "units_asc") {
      return f
        .order("units_total", { ascending: sort === "units_asc", nullsFirst: false })
        .order("design_family", { ascending: true });
    }
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

/**
 * Random sample handler. Two round-trips:
 *   1. Fetch design_family keys matching status + filters (no SELECT *)
 *   2. Shuffle, slice to N, fetch full rows by `in()`
 *
 * Cheaper than streaming all 9k rows on every reshuffle, and works with
 * the existing filter logic without needing a Postgres view.
 */
async function handleSample({
  status,
  n,
  filters,
}: {
  status: ReviewStatus;
  n: number;
  filters: ReturnType<typeof parseFiltersFromSearch>;
}): Promise<Response> {
  const supabase = getSupabase();

  // Step 1: keys only.
  const keysBase = supabase
    .from("designs")
    .select("design_family")
    .eq("status", status) as unknown as Parameters<typeof applyReviewFilters>[0];
  const keysFiltered = applyReviewFilters(
    keysBase,
    filters,
  ) as unknown as Parameters<typeof applyReviewFilters>[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: keys, error: keysErr } = await (keysFiltered as any);
  if (keysErr) return errorResponse(500, keysErr.message);
  const allKeys = (keys ?? []).map(
    (r: { design_family: string }) => r.design_family,
  );
  if (allKeys.length === 0) {
    return Response.json({
      designs: [],
      total: 0,
      sample: true,
      sampled: 0,
    });
  }

  // Step 2: Fisher-Yates shuffle, take N.
  for (let i = allKeys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allKeys[i], allKeys[j]] = [allKeys[j], allKeys[i]];
  }
  const sampleKeys = allKeys.slice(0, n);

  // Step 3: hydrate the sample.
  const { data, error } = await supabase
    .from("designs")
    .select(SELECT_FIELDS)
    .in("design_family", sampleKeys);
  if (error) return errorResponse(500, error.message);

  return Response.json({
    designs: (data || []) as unknown as Design[],
    total: allKeys.length,
    sample: true,
    sampled: sampleKeys.length,
  });
}
