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
 *   { action: "reset" }                           // back to novision (testing/debug)
 *
 * Every action logs an event row (audit trail). Writes use the anon key against
 * the RLS policies created by migration 002.
 */
import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Design, ReviewStatus } from "@/lib/types";
import { mapTagsToThemes } from "@/lib/vision";

export const dynamic = "force-dynamic";

const ACTOR = "blake"; // hardcoded pre-auth

type Body =
  | { action: "flag" }
  | { action: "approve"; tags?: string[] }
  | { action: "update_tags"; tags: string[] }
  | { action: "accept_vision"; term: string }
  | { action: "reject_vision"; term: string }
  | { action: "unflag" }
  | { action: "mark_fine" }
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

  switch (body.action) {
    case "flag": {
      // When flagging from readytosend / updated, the user is saying "this
      // previous review was wrong — start over." Clear approved_tags so
      // vision's new suggestions aren't polluted by the old curation.
      // From pending, preserve approved_tags (user may be mid-curation).
      // From novision / flagged, nothing to clear.
      const wipeApproved =
        state.status === "readytosend" || state.status === "updated";
      patch = {
        status: "flagged" satisfies ReviewStatus,
        ...(wipeApproved ? { approved_tags: [] } : {}),
        vision_tags: [],
      };
      eventType = "flagged";
      eventPayload = {
        from_status: state.status,
        cleared_approved: wipeApproved,
      };
      break;
    }
    case "approve": {
      // Trust the client to have sent exactly the tags it wants. No auto-merge
      // of lingering vision_tags — that surprised users with tags they never
      // saw. If the client wants merge semantics, it passes a tags array that
      // already includes them.
      const approved = dedupSort(body.tags ?? state.approved_tags ?? []);
      patch = {
        status: "readytosend" satisfies ReviewStatus,
        approved_tags: approved,
        vision_tags: [], // consumed — cleared either way
        last_reviewed_at: now,
      };
      eventType = "approved";
      eventPayload = { tag_count: approved.length };
      break;
    }
    case "update_tags": {
      patch = { approved_tags: dedupSort(body.tags) };
      eventType = "tag_updated";
      eventPayload = { tag_count: dedupSort(body.tags).length };
      break;
    }
    case "accept_vision": {
      const approved = new Set(state.approved_tags ?? []);
      const vision = (state.vision_tags ?? []).filter((t) => t !== body.term);
      approved.add(body.term);
      patch = {
        approved_tags: Array.from(approved).sort(),
        vision_tags: vision,
      };
      eventType = "tag_promoted";
      eventPayload = { tag: body.term };
      break;
    }
    case "reject_vision": {
      // Reject = "I don't want this tag". Remove from both vision_tags and
      // approved_tags so the final push can't pick it up via the Approve merge.
      const vision = (state.vision_tags ?? []).filter((t) => t !== body.term);
      const approved = (state.approved_tags ?? []).filter((t) => t !== body.term);
      patch = { vision_tags: vision, approved_tags: approved };
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
      const themes = mapTagsToThemes(snapshot);
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
      patch = {
        status: "novision" satisfies ReviewStatus,
        approved_tags: null,
      };
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
    actor: ACTOR,
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
