/**
 * Taxonomy refresh — two-phase endpoint.
 *
 *   POST /api/taxonomy/refresh?phase=plan   → diff TeamDesk vs local, return summary
 *   POST /api/taxonomy/refresh?phase=apply  → apply the approved diff (TODO once auth lands)
 *
 * The UI always calls `plan` first to populate the confirmation dialog, then
 * calls `apply` if the user accepts. Additions-only diffs may auto-apply on
 * the client side without a dialog (per the handoff spec).
 *
 * **Current state:** STUB. Neither phase can complete end-to-end until Blake
 * provisions a TeamDesk token. Both phases return a 503 `not_configured`
 * response that the UI renders as a friendly banner. The diff/apply plumbing
 * is fully built behind the stub so switching to real data is a one-line
 * change inside `lib/teamdesk.ts#listFlThemes`.
 */
import taxonomy from "@/lib/taxonomy.json";
import {
  isConfigured,
  listFlThemes,
  TeamDeskNotConfiguredError,
  type TeamDeskRow,
} from "@/lib/teamdesk";
import {
  diffTaxonomies,
  summarizeDiff,
  type TaxonomyDiff,
} from "@/lib/taxonomy-diff";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface LocalEntry {
  term: string;
  label: string;
}

/**
 * Map the baked JSON into the diff helper's shape. The local JSON has no
 * TeamDesk `@row.id` values (it was built from the CSV export), so we fall
 * back to using `label` as the join id. TeamDesk rows coming in use the same
 * label as their id for the diff so additions/removals line up. This means
 * pure-rename changes (label moves, same underlying row) will surface as
 * remove+add in the plan — acceptable until Supabase-backed storage lands
 * with real `@row.id` persistence, at which point the diff upgrades to true
 * rename detection without any API change.
 */
function currentLocalRows(): { id: string; label: string }[] {
  const entries = (taxonomy.entries ?? []) as LocalEntry[];
  return entries.map((e) => ({ id: e.label, label: e.label }));
}

function notConfiguredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "not_configured",
      message:
        "TeamDesk API not configured yet. Add TEAMDESK_API_TOKEN, TEAMDESK_ACCOUNT, TEAMDESK_DB_ID, and TEAMDESK_TABLE_ID to Vercel env vars, then redeploy.",
      docs: "https://www.teamdesk.net/help/2143.aspx",
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function POST(req: Request): Promise<Response> {
  const phase = new URL(req.url).searchParams.get("phase") ?? "plan";

  if (!isConfigured()) return notConfiguredResponse();

  // ─── PLAN: pull from TeamDesk, return diff summary ──────────────────────
  if (phase === "plan") {
    let incoming: TeamDeskRow[];
    try {
      incoming = await listFlThemes();
    } catch (e) {
      if (e instanceof TeamDeskNotConfiguredError) return notConfiguredResponse();
      return errorJson(502, `TeamDesk fetch failed: ${(e as Error).message}`);
    }
    const local = currentLocalRows();
    // Match TeamDesk rows against local by label too, since local has no
    // `@row.id` persisted yet. See `currentLocalRows` docstring for detail.
    const diff: TaxonomyDiff = diffTaxonomies(
      local,
      incoming.map((r) => ({ id: r.label, label: r.label })),
    );
    return Response.json({
      diff,
      summary: summarizeDiff(diff),
      incoming_total: incoming.length,
    });
  }

  // ─── APPLY: write new taxonomy + migrate designs ────────────────────────
  //
  // Deferred. Needs:
  //   1. Supabase `taxonomy_entries` table to hold the persisted rows
  //   2. UPDATE sweep across `designs.theme_names` / `sub_themes` /
  //      `sub_sub_themes` / `approved_tags` / `shopify_tags` for renames
  //   3. `status='flagged'` sweep for designs using removed tags
  //   4. Per-design `tag_renamed` / `tag_deleted` events
  //   5. `taxonomy_refreshed` meta event on success
  //
  // Implementation will land together with the `005_taxonomy.sql` migration
  // in a follow-up once auth is wired.
  if (phase === "apply") {
    return errorJson(
      501,
      "apply phase is not implemented yet — ships with the taxonomy migration once TeamDesk auth is wired.",
    );
  }

  return errorJson(400, `unknown phase: ${phase}`);
}

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
