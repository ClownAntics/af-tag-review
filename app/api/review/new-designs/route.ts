/**
 * Designs added to our DB recently — feeds the "N new since X" banner on
 * the No-vision tile.
 *
 *   GET  /api/review/new-designs?days=7   → preview { count, sample, families }
 *   POST /api/review/new-designs?days=7   → flag-all. Body: { confirm: "FLAG" }
 *
 * "New" = status='novision' AND first_seen_at within the last N days.
 * Other statuses (flagged / pending / readytosend / updated / excluded) are
 * already moving through the pipeline; only novision needs the prompt.
 *
 * `days` defaults to 7. The flag action writes one `flagged` event per
 * design with `reason: 'new_from_shopify_sync'` so the cron + manual sync
 * paths are auditable.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACTOR = "blake";

interface NewRow {
  design_family: string;
  design_name: string | null;
  first_seen_at: string | null;
  shopify_product_ids: number[] | null;
}

function parseDays(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("days");
  const n = Number(raw ?? 7);
  if (!Number.isFinite(n) || n <= 0) return 7;
  return Math.min(n, 90); // cap at 90 so the query stays bounded
}

async function loadNew(days: number): Promise<NewRow[]> {
  const sb = getAdminSupabase();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out: NewRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,first_seen_at,shopify_product_ids")
      .eq("status", "novision")
      .gte("first_seen_at", since)
      .order("first_seen_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const rows = (data ?? []) as NewRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function GET(req: NextRequest): Promise<Response> {
  const days = parseDays(req);
  let rows: NewRow[];
  try {
    rows = await loadNew(days);
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }
  const sample = rows.slice(0, 10).map((r) => ({
    design_family: r.design_family,
    design_name: r.design_name,
    first_seen_at: r.first_seen_at,
  }));
  return Response.json({
    count: rows.length,
    days,
    sample,
    families: rows.map((r) => r.design_family),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const days = parseDays(req);
  let body: { confirm?: unknown };
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    return errorJson(400, "invalid JSON body");
  }
  if (body.confirm !== "FLAG") {
    return errorJson(400, 'body must include { "confirm": "FLAG" }');
  }
  const sb = getAdminSupabase();
  let rows: NewRow[];
  try {
    rows = await loadNew(days);
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }
  if (rows.length === 0) {
    return Response.json({ flagged: 0, days });
  }

  // Skip designs with no shopify_product_ids — they can't ever be pushed
  // and vision would 404 on the image too. Leave them in novision; the
  // user can exclude them manually if they want.
  const candidates = rows.filter(
    (r) => (r.shopify_product_ids ?? []).length > 0,
  );
  const skipped = rows.length - candidates.length;

  // Batch update + audit events.
  const familyList = candidates.map((r) => r.design_family);
  const BATCH = 200;
  let flagged = 0;
  for (let i = 0; i < familyList.length; i += BATCH) {
    const slice = familyList.slice(i, i + BATCH);
    const { error: updErr } = await sb
      .from("designs")
      .update({ status: "flagged" })
      .in("design_family", slice);
    if (updErr) {
      return errorJson(500, `update batch at ${i}: ${updErr.message}`);
    }
    const events = slice.map((family) => ({
      design_family: family,
      event_type: "flagged",
      actor: ACTOR,
      payload: { reason: "new_from_shopify_sync", days },
    }));
    const { error: evtErr } = await sb.from("events").insert(events);
    if (evtErr) {
      // Don't fail the whole call for an event-log hiccup; warn and continue.
      console.warn(`event insert batch at ${i}: ${evtErr.message}`);
    }
    flagged += slice.length;
  }
  return Response.json({ flagged, skipped, days });
}

function errorJson(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
