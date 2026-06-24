/**
 * "Flag under-tagged designs" rule — shared by the CLI script
 * (scripts/flag-undertagged.ts) and the nightly cron
 * (app/api/cron/flag-undertagged/route.ts) so the two can't drift.
 *
 * A design is under-tagged when it carries ≤1 *real theme* tag. The 13
 * feature/material facets below don't count toward the total — a design
 * tagged only "Double-Sided" + "Printed" has 2 entries in approved_tags but
 * zero browsable theme, so it should be flagged for re-tagging.
 *
 * Scope defaults to updated/readytosend/pending. excluded, novision, and
 * already-flagged are never touched (novision/flagged are pre-review and
 * already headed for vision tagging).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The 13 feature/material facet tags that don't count as "content". */
export const UNDERTAGGED_FACETS = new Set([
  "Double-Sided", "Printed-In-USA", "Eco-Friendly", "Suede-Reflections",
  "Reversible", "PremierSoft", "GlitterTrends",
  "Printed", "Applique", "Burlap", "Lustre", "Linen", "Moire",
]);

export type Notion = "content" | "total";

export const DEFAULT_STATUSES = ["updated", "readytosend", "pending"];

export const totalTagCount = (tags: string[] | null): number =>
  (tags ?? []).length;
export const contentTagCount = (tags: string[] | null): number =>
  (tags ?? []).filter((t) => !UNDERTAGGED_FACETS.has(t)).length;

export interface FlagUndertaggedOptions {
  notion?: Notion;       // default "content"
  statuses?: string[];   // default DEFAULT_STATUSES
  apply?: boolean;       // default false (dry-run — counts only)
  actor?: string;        // event actor; default "system"
}

export interface FlagUndertaggedResult {
  scanned: number;                     // non-excluded designs scanned
  candidates: number;                  // designs ≤1 under the chosen notion
  flagged: number;                     // actually flagged (0 on dry-run)
  byStatus: Record<string, number>;    // candidate breakdown by status
  totalNotionCount: number;            // ≤1 by total-tags (for reporting)
  contentNotionCount: number;          // ≤1 by content-tags (for reporting)
}

interface Row {
  design_family: string;
  status: string;
  approved_tags: string[] | null;
  last_reviewed_at: string | null;
  last_pushed_at: string | null;
}

/**
 * A row that has never been curated by us — empty approved_tags AND never
 * reviewed AND never pushed. These are products we adopted as-is from Shopify
 * (e.g. the non-AF catalog marked 'updated' but left uncurated), NOT designs
 * that lost their tags. The rule must not sweep them into 'flagged'.
 */
const neverCurated = (r: Row): boolean =>
  (r.approved_tags ?? []).length === 0 && !r.last_reviewed_at && !r.last_pushed_at;

export async function flagUndertagged(
  sb: SupabaseClient,
  opts: FlagUndertaggedOptions = {},
): Promise<FlagUndertaggedResult> {
  const notion = opts.notion ?? "content";
  const statuses = opts.statuses ?? DEFAULT_STATUSES;
  const apply = opts.apply ?? false;
  const actor = opts.actor ?? "system";

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,status,approved_tags,last_reviewed_at,last_pushed_at")
      .neq("status", "excluded")
      .range(o, o + PAGE - 1);
    if (error) throw new Error(`flag-undertagged select: ${error.message}`);
    const b = (data ?? []) as Row[];
    rows.push(...b);
    if (b.length < PAGE) break;
  }

  const inScope = (r: Row) => statuses.includes(r.status) && !neverCurated(r);
  const count = notion === "total" ? totalTagCount : contentTagCount;

  const totalNotionCount = rows.filter(
    (r) => inScope(r) && totalTagCount(r.approved_tags) <= 1,
  ).length;
  const contentNotionCount = rows.filter(
    (r) => inScope(r) && contentTagCount(r.approved_tags) <= 1,
  ).length;

  const targets = rows.filter((r) => inScope(r) && count(r.approved_tags) <= 1);
  const byStatus: Record<string, number> = {};
  for (const t of targets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  let flagged = 0;
  if (apply && targets.length) {
    for (let i = 0; i < targets.length; i += 200) {
      const slice = targets.slice(i, i + 200).map((t) => t.design_family);
      const { error } = await sb
        .from("designs")
        .update({ status: "flagged" })
        .in("design_family", slice);
      if (error) throw new Error(`flag-undertagged batch at ${i}: ${error.message}`);
      flagged += slice.length;
    }
    // Audit trail — one event per flagged design.
    for (const t of targets)
      await sb.from("events").insert({
        design_family: t.design_family,
        event_type: "flagged",
        actor,
        payload: { reason: `undertagged_${notion}`, tag_count: count(t.approved_tags) },
      });
  }

  return {
    scanned: rows.length,
    candidates: targets.length,
    flagged,
    byStatus,
    totalNotionCount,
    contentNotionCount,
  };
}
