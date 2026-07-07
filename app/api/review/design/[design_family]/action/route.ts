/**
 * Single mutation endpoint for the review pipeline.
 *
 * POST body shapes:
 *   { action: "flag" }
 *   { action: "approve", tags?: string[] }        // set approved_tags + move to readytosend
 *   { action: "update_tags", tags: string[] }     // replace approved_tags (no status change)
 *   { action: "accept_vision", term: string }     // promote a vision_tag to approved_tags
 *   { action: "reject_vision", term: string }     // drop a vision_tag
 *   { action: "unflag" }                          // flagged → novision (preserves state)
 *   { action: "mark_fine" }                       // fast-path: current shopify_tags are good,
 *                                                 //   queue for push without running vision
 *   { action: "exclude", reason?: string }        // take out of the review pipeline
 *                                                 //   (accessories, gift cards, etc.)
 *   { action: "include" }                         // reverse of exclude → back to novision
 *   { action: "reset" }                           // back to novision (testing/debug)
 *
 * Every action logs an event row (audit trail). Writes use the anon key against
 * the RLS policies created by migration 002.
 */
import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getActor } from "@/lib/auth";
import type { Design, ReviewStatus } from "@/lib/types";
import { mapTagsToThemes } from "@/lib/vision";

export const dynamic = "force-dynamic";

type Body =
  | { action: "flag" }
  | { action: "approve"; tags?: string[] }
  | { action: "update_tags"; tags: string[] }
  | { action: "accept_vision"; term: string }
  | { action: "reject_vision"; term: string }
  | { action: "unflag" }
  | { action: "mark_fine" }
  | { action: "exclude"; reason?: string }
  | { action: "include" }
  | { action: "star" }
  | { action: "unstar" }
  | { action: "reset" };

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ design_family: string }> },
): Promise<Response> {
  const { design_family } = await ctx.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse(400, "invalid JSON body");
  }

  const supabase = getSupabase();
  const actor = await getActor();

  // Load current state — we need it for merge semantics on accept/reject vision.
  // shopify_product_ids is loaded so mark_fine can refuse to queue a design
  // that has no JFF products (otherwise push would skip it downstream).
  const { data: current, error: loadErr } = await supabase
    .from("designs")
    .select(
      "design_family,status,approved_tags,vision_tags,shopify_tags,shopify_product_ids",
    )
    .eq("design_family", design_family)
    .single();
  if (loadErr) return errorResponse(404, `design not found: ${loadErr.message}`);

  const state = current as Pick<
    Design,
    "design_family" | "status" | "approved_tags" | "vision_tags" | "shopify_tags"
  > & { shopify_product_ids: number[] | null };

  const now = new Date().toISOString();
  let patch: Record<string, unknown> = {};
  let eventType = "";
  let eventPayload: Record<string, unknown> = {};

  // Whenever an action mutates approved_tags, derived theme columns must
  // change in lockstep — otherwise filters in /api/review/counts and
  // /api/review/queue (which key on theme_names / sub_themes /
  // sub_sub_themes) lie about which designs match. Helper folds the
  // recompute into the patch so every action stays consistent.
  const withThemes = async (
    base: Record<string, unknown>,
    approvedTags: string[],
  ): Promise<Record<string, unknown>> => {
    const themes = await mapTagsToThemes(approvedTags);
    return {
      ...base,
      theme_names: themes.theme_names,
      sub_themes: themes.sub_themes,
      sub_sub_themes: themes.sub_sub_themes,
    };
  };

  switch (body.action) {
    case "flag": {
      // Flag ALWAYS means "start over": clear approved_tags so vision's new
      // suggestions aren't polluted by old curation or legacy Shopify-seeded
      // tags. (Blake 2026-07-06 — previously flagging from `pending`
      // preserved tags "mid-curation", which kept legacy noise like a stray
      // Welcome-Flags alive through re-review. Old tags stay recoverable in
      // the event payload.)
      const wipeApproved = (state.approved_tags ?? []).length > 0;
      patch = await withThemes(
        {
          status: "flagged" satisfies ReviewStatus,
          vision_tags: [],
          approved_tags: [],
        },
        [],
      );
      eventType = "flagged";
      eventPayload = {
        from_status: state.status,
        cleared_approved: wipeApproved,
        previous_approved_tags: state.approved_tags ?? [],
      };
      break;
    }
    case "approve": {
      // Trust the client to have sent exactly the tags it wants. No auto-merge
      // of lingering vision_tags — that surprised users with tags they never
      // saw. If the client wants merge semantics, it passes a tags array that
      // already includes them.
      const approved = dedupSort(body.tags ?? state.approved_tags ?? []);
      patch = await withThemes(
        {
          status: "readytosend" satisfies ReviewStatus,
          approved_tags: approved,
          vision_tags: [], // consumed — cleared either way
          last_reviewed_at: now,
        },
        approved,
      );
      eventType = "approved";
      eventPayload = { tag_count: approved.length };
      break;
    }
    case "update_tags": {
      const approved = dedupSort(body.tags);
      patch = await withThemes({ approved_tags: approved }, approved);
      eventType = "tag_updated";
      eventPayload = { tag_count: approved.length };
      break;
    }
    case "accept_vision": {
      const approvedSet = new Set(state.approved_tags ?? []);
      approvedSet.add(body.term);
      const approved = Array.from(approvedSet).sort();
      const vision = (state.vision_tags ?? []).filter((t) => t !== body.term);
      patch = await withThemes(
        { approved_tags: approved, vision_tags: vision },
        approved,
      );
      eventType = "tag_promoted";
      eventPayload = { tag: body.term };
      break;
    }
    case "reject_vision": {
      // Reject = "I don't want this tag". Remove from both vision_tags and
      // approved_tags so the final push can't pick it up via the Approve merge.
      const vision = (state.vision_tags ?? []).filter((t) => t !== body.term);
      const approved = (state.approved_tags ?? []).filter((t) => t !== body.term);
      patch = await withThemes(
        { vision_tags: vision, approved_tags: approved },
        approved,
      );
      eventType = "tag_rejected";
      eventPayload = { tag: body.term };
      break;
    }
    case "unflag": {
      // Non-destructive: just change status back to novision. Vision and
      // approved tags are preserved so re-flagging resumes prior state.
      // Used by Clear All on the Flagged tile.
      patch = { status: "novision" satisfies ReviewStatus };
      eventType = "unflagged";
      eventPayload = { from_status: state.status };
      break;
    }
    case "exclude": {
      // Take a design out of the review pipeline entirely. Used for
      // accessories (poles, brackets, stakes), gift cards, and other
      // products that aren't reviewable artwork. Non-destructive: vision /
      // approved / theme columns are preserved so toggling back to
      // novision restores prior state.
      patch = { status: "excluded" satisfies ReviewStatus };
      eventType = "excluded";
      eventPayload = {
        from_status: state.status,
        reason: body.reason ?? null,
      };
      break;
    }
    case "include": {
      // Reverse of `exclude` — put the design back into the pipeline at
      // novision. The user can then flag / mark-fine as usual.
      patch = { status: "novision" satisfies ReviewStatus };
      eventType = "included";
      eventPayload = { from_status: state.status };
      break;
    }
    case "star": {
      // Add the `Staff-Pick` curatorial tag and queue the design for push.
      // Staff-Pick is a curation marker (featured by the team), not a
      // content theme — it's its own taxonomy row but doesn't fit under
      // any Name parent, so mapTagsToThemes just no-ops on it. Idempotent:
      // if the tag is already there, this still re-queues to readytosend
      // so a stalled push gets unstuck.
      const STAFF_PICK = "Staff-Pick";
      const existing = new Set(state.approved_tags ?? []);
      existing.add(STAFF_PICK);
      const approved = [...existing].sort();
      patch = await withThemes(
        {
          status: "readytosend" satisfies ReviewStatus,
          approved_tags: approved,
          last_reviewed_at: now,
        },
        approved,
      );
      eventType = "staff_picked";
      eventPayload = {
        from_status: state.status,
        tag_count: approved.length,
      };
      break;
    }
    case "unstar": {
      // Remove Staff-Pick and re-queue for push. Mirror of `star` — the
      // change has to push to Shopify so the storefront's "Staff Picks"
      // collection drops the design.
      const STAFF_PICK = "Staff-Pick";
      const approved = (state.approved_tags ?? []).filter(
        (t) => t !== STAFF_PICK,
      );
      patch = await withThemes(
        {
          status: "readytosend" satisfies ReviewStatus,
          approved_tags: approved,
          last_reviewed_at: now,
        },
        approved,
      );
      eventType = "staff_unpicked";
      eventPayload = {
        from_status: state.status,
        tag_count: approved.length,
      };
      break;
    }
    case "mark_fine": {
      // Fast path: "the existing Shopify tags are already correct — skip
      // vision entirely and queue this design for push." The approved_tags
      // become an exact copy of the current shopify_tags (dedup+sort), and
      // the derived theme columns are refreshed from taxonomy so filters
      // remain accurate. Snapshot of the tags is captured on the event row
      // so we know what we trusted at the time (Shopify tags can drift).
      //
      // Guard: refuse to queue a design that has no JFF products. The push
      // route would silently skip it anyway, but failing loudly here avoids
      // ever parking it in Ready-to-send where it'd sit indefinitely.
      const productIds = state.shopify_product_ids ?? [];
      if (productIds.length === 0) {
        return errorResponse(
          409,
          `no shopify_product_ids on ${design_family} — can't queue for push (re-run shopify-pull or flag this as an accessory)`,
        );
      }
      const snapshot = dedupSort(state.shopify_tags ?? []);
      const themes = await mapTagsToThemes(snapshot);
      patch = {
        status: "readytosend" satisfies ReviewStatus,
        approved_tags: snapshot,
        theme_names: themes.theme_names,
        sub_themes: themes.sub_themes,
        sub_sub_themes: themes.sub_sub_themes,
        vision_tags: [], // no vision was run; ensure nothing stale lingers
        last_reviewed_at: now,
      };
      eventType = "marked_fine";
      eventPayload = {
        from_status: state.status,
        shopify_tags_snapshot: snapshot,
        tag_count: snapshot.length,
      };
      break;
    }
    case "reset": {
      // Destructive: wipe everything back to novision. Kept for explicit
      // "start completely over" cases; not used by Clear All.
      patch = await withThemes(
        {
          status: "novision" satisfies ReviewStatus,
          approved_tags: null,
        },
        [],
      );
      eventType = "reset";
      eventPayload = { from_status: state.status };
      break;
    }
    default:
      return errorResponse(400, `unknown action: ${(body as { action?: string }).action}`);
  }

  const { error: updateErr } = await supabase
    .from("designs")
    .update(patch)
    .eq("design_family", design_family);
  if (updateErr) return errorResponse(500, `update: ${updateErr.message}`);

  const { error: eventErr } = await supabase.from("events").insert({
    design_family,
    event_type: eventType,
    actor,
    payload: eventPayload,
  });
  if (eventErr) {
    // Event-write failure shouldn't roll back the user's action — just log.
    console.warn(`event insert failed for ${design_family}: ${eventErr.message}`);
  }

  return Response.json({ ok: true, patch });
}

function dedupSort(a: string[]): string[] {
  return Array.from(new Set(a)).sort();
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
