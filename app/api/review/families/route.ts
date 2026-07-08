/**
 * Return just the design_family keys for a status (+ optional filters), across
 * the WHOLE matching set — not paginated. Powers the "Run vision on all N
 * flagged" button, which needs every family up front to chunk through the
 * vision route. Lightweight: one column, no hydration.
 *
 * GET /api/review/families?status=flagged[&<filter params>]
 *   → { families: string[], total: number }
 */
import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { ReviewStatus } from "@/lib/types";
import { applyReviewFilters, parseFiltersFromSearch } from "@/lib/review-filters";

export const dynamic = "force-dynamic";

const ALL_STATUSES: ReviewStatus[] = [
  "novision", "flagged", "pending", "readytosend", "updated", "excluded",
];

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (!status || !ALL_STATUSES.includes(status as ReviewStatus)) {
    return json(400, { error: "status query param required" });
  }
  const filters = parseFiltersFromSearch(sp);
  const sb = getSupabase();

  const families: string[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    // Cast through unknown so the filter helper's structural type doesn't
    // tangle with PostgREST generics (same pattern as the queue route).
    const base = sb
      .from("designs")
      .select("design_family")
      .eq("status", status) as unknown as Parameters<typeof applyReviewFilters>[0];
    const filtered = applyReviewFilters(base, filters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (filtered as any)
      .order("design_family")
      .range(o, o + PAGE - 1);
    if (error) return json(500, { error: error.message });
    const batch = (data ?? []) as { design_family: string }[];
    families.push(...batch.map((r) => r.design_family));
    if (batch.length < PAGE) break;
  }

  return json(200, { families, total: families.length });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
