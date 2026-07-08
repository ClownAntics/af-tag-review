/**
 * Flag EVERY design at a status (+ optional filters), across all pages — not
 * just the visible 40 the Bulk-actions dropdown covers. Powers the "Flag all N
 * matching" button; the natural feeder for "Run vision on all flagged".
 *
 * POST /api/review/bulk/flag-all?status=updated[&<filter params>]
 *   → { flagged: number }
 *
 * Per Blake's flag rule (2026-07-06): flagging ALWAYS clears approved_tags (and
 * derived theme columns + vision_tags) so vision re-runs clean, unpolluted by
 * old curation or legacy Shopify-seeded tags. Previous approved_tags are saved
 * in each design's event payload for recovery.
 *
 * The status flip is one UPDATE (fast even for thousands). Events are inserted
 * in batches. Excluded designs are never touched.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getActor } from "@/lib/auth";
import { applyReviewFilters, parseFiltersFromSearch } from "@/lib/review-filters";
import type { ReviewStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Only these source statuses make sense to bulk-flag. (Not 'flagged' itself,
// not 'excluded' — those have their own include/unflag paths.)
const FLAGGABLE: ReviewStatus[] = ["novision", "pending", "readytosend", "updated"];

export async function POST(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (!status || !FLAGGABLE.includes(status as ReviewStatus)) {
    return json(400, { error: `status must be one of ${FLAGGABLE.join(", ")}` });
  }
  const filters = parseFiltersFromSearch(sp);
  const sb = getAdminSupabase();

  // 1. Collect the matching families (+ their current approved_tags for the
  //    recovery payload) across the whole set.
  const rows: { design_family: string; approved_tags: string[] | null }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const base = sb
      .from("designs")
      .select("design_family,approved_tags")
      .eq("status", status) as unknown as Parameters<typeof applyReviewFilters>[0];
    const filtered = applyReviewFilters(base, filters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (filtered as any).order("design_family").range(o, o + PAGE - 1);
    if (error) return json(500, { error: error.message });
    const batch = (data ?? []) as typeof rows;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (rows.length === 0) return json(200, { flagged: 0 });

  const families = rows.map((r) => r.design_family);

  // 2. Flag them all + clear tags in one UPDATE per chunk (in() has a size
  //    limit, so chunk the key list).
  const KEY_CHUNK = 500;
  for (let i = 0; i < families.length; i += KEY_CHUNK) {
    const chunk = families.slice(i, i + KEY_CHUNK);
    const { error } = await sb
      .from("designs")
      .update({
        status: "flagged",
        approved_tags: [],
        vision_tags: [],
        theme_names: [],
        sub_themes: [],
        sub_sub_themes: [],
      })
      .in("design_family", chunk)
      .eq("status", status); // guard: only flip rows still at the source status
    if (error) return json(500, { error: error.message });
  }

  // 3. One audit event per design (batched), preserving prior tags.
  const actor = await getActor();
  const events = rows.map((r) => ({
    design_family: r.design_family,
    event_type: "flagged",
    actor,
    payload: {
      from_status: status,
      cleared_approved: (r.approved_tags ?? []).length > 0,
      previous_approved_tags: r.approved_tags ?? [],
      source: "flag-all",
    },
  }));
  for (let i = 0; i < events.length; i += KEY_CHUNK) {
    await sb.from("events").insert(events.slice(i, i + KEY_CHUNK));
  }

  return json(200, { flagged: families.length });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
