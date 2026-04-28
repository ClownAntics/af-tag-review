/**
 * Taxonomy refresh — two-phase endpoint.
 *
 *   POST /api/taxonomy/refresh?phase=plan   → diff TeamDesk vs persisted, return summary
 *   POST /api/taxonomy/refresh?phase=apply  → upsert taxonomy_entries + migrate designs
 *
 * The UI calls `plan` first to populate the confirmation dialog, then calls
 * `apply` if the user accepts. Additions-only diffs may auto-apply on the
 * client without a dialog.
 *
 * Diff source of truth:
 *   - If `taxonomy_entries` has rows, diff against those — keyed on td_row_id
 *     so renames detect properly.
 *   - If `taxonomy_entries` is empty (first-ever refresh), diff against the
 *     baked `lib/taxonomy.json` by label so the UI still shows what's about
 *     to land. The apply path detects this same condition and runs in
 *     "bootstrap" mode (skips the design migration sweep — see below).
 *
 * Bootstrap behavior:
 *   On the first apply, no design has been tagged via td_row_ids yet, so we
 *   can't reliably remap renames or flag deletions. We just upsert all
 *   incoming rows and skip the design sweep. Subsequent applies use real
 *   id-keyed diffing and run the full sweep.
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
import { getAdminSupabase } from "@/lib/supabase-admin";
import { invalidateTaxonomyCache } from "@/lib/taxonomy-source";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface LocalEntry {
  term: string;
  label: string;
}

interface PersistedTaxonomyRow {
  td_row_id: number;
  label: string;
  search_term: string | null;
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

async function loadPersistedTaxonomy(): Promise<PersistedTaxonomyRow[]> {
  const sb = getAdminSupabase();
  const { data, error } = await sb
    .from("taxonomy_entries")
    .select("td_row_id, label, search_term");
  if (error) throw new Error(`taxonomy_entries read failed: ${error.message}`);
  return (data ?? []) as PersistedTaxonomyRow[];
}

export async function POST(req: Request): Promise<Response> {
  const phase = new URL(req.url).searchParams.get("phase") ?? "plan";

  if (!isConfigured()) return notConfiguredResponse();

  if (phase === "plan") return planPhase();
  if (phase === "apply") return applyPhase();
  return errorJson(400, `unknown phase: ${phase}`);
}

// ─── PLAN ─────────────────────────────────────────────────────────────────
async function planPhase(): Promise<Response> {
  let incoming: TeamDeskRow[];
  try {
    incoming = await listFlThemes();
  } catch (e) {
    if (e instanceof TeamDeskNotConfiguredError) return notConfiguredResponse();
    return errorJson(502, `TeamDesk fetch failed: ${(e as Error).message}`);
  }

  let persisted: PersistedTaxonomyRow[];
  try {
    persisted = await loadPersistedTaxonomy();
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }

  const isBootstrap = persisted.length === 0;

  // When persisted is empty, fall back to the baked JSON for a label-keyed
  // diff so the UI still shows "what's about to change". The diff is
  // necessarily lossy (no real renames detected) but apply will correctly
  // bootstrap.
  const localForDiff = isBootstrap
    ? ((taxonomy.entries ?? []) as LocalEntry[]).map((e) => ({
        id: e.label,
        label: e.label,
      }))
    : persisted.map((r) => ({
        id: String(r.td_row_id),
        label: r.label,
      }));

  const incomingForDiff = isBootstrap
    ? incoming.map((r) => ({ id: r.label, label: r.label }))
    : incoming.map((r) => ({ id: String(r.id), label: r.label }));

  const diff: TaxonomyDiff = diffTaxonomies(localForDiff, incomingForDiff);

  return Response.json({
    diff,
    summary: summarizeDiff(diff),
    incoming_total: incoming.length,
    is_bootstrap: isBootstrap,
  });
}

// ─── APPLY ────────────────────────────────────────────────────────────────
async function applyPhase(): Promise<Response> {
  let incoming: TeamDeskRow[];
  try {
    incoming = await listFlThemes();
  } catch (e) {
    if (e instanceof TeamDeskNotConfiguredError) return notConfiguredResponse();
    return errorJson(502, `TeamDesk fetch failed: ${(e as Error).message}`);
  }

  const sb = getAdminSupabase();

  let persisted: PersistedTaxonomyRow[];
  try {
    persisted = await loadPersistedTaxonomy();
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }

  const wasBootstrap = persisted.length === 0;
  const persistedById = new Map(persisted.map((r) => [r.td_row_id, r]));
  const incomingIds = new Set(incoming.map((r) => r.id));

  // Build the diff sets by td_row_id (only meaningful when not bootstrap).
  // - renamed_terms: search_term changed for an existing td_row_id
  // - removed_terms: a row that existed before is gone, and it had a search_term
  const renamedTerms: { from: string; to: string }[] = [];
  const removedTerms: string[] = [];
  let addedCount = 0;

  for (const r of incoming) {
    const prev = persistedById.get(r.id);
    if (!prev) {
      addedCount++;
      continue;
    }
    if ((prev.search_term ?? null) !== (r.search_term ?? null)) {
      if (prev.search_term && r.search_term) {
        renamedTerms.push({ from: prev.search_term, to: r.search_term });
      } else if (prev.search_term && !r.search_term) {
        // term was cleared in TeamDesk — treat as a removal of the old term
        removedTerms.push(prev.search_term);
      }
    }
  }
  for (const p of persisted) {
    if (!incomingIds.has(p.td_row_id) && p.search_term) {
      removedTerms.push(p.search_term);
    }
  }

  // 1. Upsert all incoming rows.
  const upsertPayload = incoming.map(rowToPayload);
  {
    const { error } = await sb
      .from("taxonomy_entries")
      .upsert(upsertPayload, { onConflict: "td_row_id" });
    if (error) {
      return errorJson(500, `taxonomy_entries upsert failed: ${error.message}`);
    }
  }

  // 2. Delete rows that vanished from TeamDesk.
  const missingIds = persisted
    .filter((p) => !incomingIds.has(p.td_row_id))
    .map((p) => p.td_row_id);
  if (missingIds.length > 0) {
    const { error } = await sb
      .from("taxonomy_entries")
      .delete()
      .in("td_row_id", missingIds);
    if (error) {
      return errorJson(500, `taxonomy_entries delete failed: ${error.message}`);
    }
  }

  // 3. Design migration sweep. Skipped on bootstrap because we have no
  //    persisted td_row_ids to compute reliable rename pairs from.
  let designsRenamed = 0;
  let designsFlagged = 0;
  if (!wasBootstrap) {
    const sweep = await sweepDesignsForChanges(renamedTerms, removedTerms);
    if (sweep.error) return errorJson(500, sweep.error);
    designsRenamed = sweep.designsRenamed;
    designsFlagged = sweep.designsFlagged;
  }

  // After data write succeeds, invalidate the in-memory taxonomy cache so the
  // next /api/taxonomy GET sees the new entries instead of waiting for TTL.
  invalidateTaxonomyCache();

  // 4. Audit row.
  {
    const { error } = await sb.from("taxonomy_refresh_log").insert({
      added_count: addedCount,
      removed_count: missingIds.length,
      renamed_count: renamedTerms.length,
      designs_flagged_count: designsFlagged,
      designs_renamed_count: designsRenamed,
      was_bootstrap: wasBootstrap,
      actor: "blake",
    });
    if (error) {
      // Audit failure shouldn't roll back the data — log and continue.
      console.warn(`taxonomy_refresh_log insert failed: ${error.message}`);
    }
  }

  return Response.json({
    ok: true,
    was_bootstrap: wasBootstrap,
    added: addedCount,
    removed: missingIds.length,
    renamed: renamedTerms.length,
    designs_renamed: designsRenamed,
    designs_flagged: designsFlagged,
    summary: wasBootstrap
      ? `Bootstrap: ${incoming.length} entries persisted; design sweep skipped.`
      : `${addedCount} added, ${renamedTerms.length} renamed, ${missingIds.length} removed; ${designsRenamed} designs migrated, ${designsFlagged} flagged.`,
  });
}

interface SweepResult {
  designsRenamed: number;
  designsFlagged: number;
  error?: string;
}

/**
 * Walk every rename and removal across `designs.approved_tags` /
 * `designs.vision_tags`, applying the change in JS and writing back. We
 * SELECT first (rather than a single UPDATE ... array_replace) because we
 * need to know which designs were touched to emit per-design events and,
 * for removals, to set status='flagged'.
 */
async function sweepDesignsForChanges(
  renames: { from: string; to: string }[],
  removals: string[],
): Promise<SweepResult> {
  const sb = getAdminSupabase();
  let designsRenamed = 0;
  let designsFlagged = 0;

  // ── Renames ─────────────────────────────────────────────────────────────
  for (const r of renames) {
    const { data: hits, error } = await sb
      .from("designs")
      .select("design_family, approved_tags, vision_tags")
      .or(
        `approved_tags.cs.{${pgArrayLiteral(r.from)}},vision_tags.cs.{${pgArrayLiteral(r.from)}}`,
      );
    if (error) return { designsRenamed, designsFlagged, error: error.message };

    for (const d of hits ?? []) {
      const approved = replaceInArray(d.approved_tags as string[] | null, r.from, r.to);
      const vision = replaceInArray(d.vision_tags as string[] | null, r.from, r.to);
      const { error: upErr } = await sb
        .from("designs")
        .update({ approved_tags: approved, vision_tags: vision })
        .eq("design_family", d.design_family);
      if (upErr) return { designsRenamed, designsFlagged, error: upErr.message };
      await sb.from("events").insert({
        design_family: d.design_family,
        event_type: "tag_renamed",
        actor: "system",
        payload: { from: r.from, to: r.to, source: "taxonomy_refresh" },
      });
      designsRenamed++;
    }
  }

  // ── Removals ────────────────────────────────────────────────────────────
  for (const term of removals) {
    const { data: hits, error } = await sb
      .from("designs")
      .select("design_family, approved_tags, vision_tags, status")
      .or(
        `approved_tags.cs.{${pgArrayLiteral(term)}},vision_tags.cs.{${pgArrayLiteral(term)}}`,
      );
    if (error) return { designsRenamed, designsFlagged, error: error.message };

    for (const d of hits ?? []) {
      const approved = filterFromArray(d.approved_tags as string[] | null, term);
      const vision = filterFromArray(d.vision_tags as string[] | null, term);
      // If the term was in approved_tags, the design is now stale — flag it.
      const wasInApproved =
        Array.isArray(d.approved_tags) && d.approved_tags.includes(term);
      const update: Record<string, unknown> = {
        approved_tags: approved,
        vision_tags: vision,
      };
      if (wasInApproved) update.status = "flagged";

      const { error: upErr } = await sb
        .from("designs")
        .update(update)
        .eq("design_family", d.design_family);
      if (upErr) return { designsRenamed, designsFlagged, error: upErr.message };
      await sb.from("events").insert({
        design_family: d.design_family,
        event_type: "tag_deleted",
        actor: "system",
        payload: {
          tag: term,
          source: "taxonomy_refresh",
          flagged: wasInApproved,
        },
      });
      if (wasInApproved) designsFlagged++;
    }
  }

  return { designsRenamed, designsFlagged };
}

function replaceInArray(
  arr: string[] | null,
  from: string,
  to: string,
): string[] | null {
  if (!arr) return arr;
  return arr.map((t) => (t === from ? to : t));
}

function filterFromArray(arr: string[] | null, term: string): string[] | null {
  if (!arr) return arr;
  return arr.filter((t) => t !== term);
}

/**
 * Escape a string for use inside a PostgREST `cs.{...}` literal. PostgREST
 * uses `,` as a separator and `"` to quote elements, so any term containing
 * those needs quoting + escaping. FL search terms in practice are kebab-case
 * ASCII so this is mostly belt-and-suspenders.
 */
function pgArrayLiteral(s: string): string {
  if (/[",\\{}]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function rowToPayload(r: TeamDeskRow) {
  return {
    td_row_id: r.id,
    label: r.label,
    search_term: r.search_term,
    notes: r.notes,
    name: r.name,
    sub_theme: r.sub_theme,
    sub_sub_theme: r.sub_sub_theme,
    level: r.level,
    is_holiday: r.is_holiday,
    is_occasion: r.is_occasion,
    is_season: r.is_season,
    is_business_theme: r.is_business_theme,
    is_spring: r.is_spring,
    is_summer: r.is_summer,
    is_fall: r.is_fall,
    is_winter: r.is_winter,
    is_xmas: r.is_xmas,
    conflicts_with: r.conflicts_with,
    parent_ref: r.parent_ref,
    parent_label: r.parent_label,
    updated_at: new Date().toISOString(),
  };
}

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
