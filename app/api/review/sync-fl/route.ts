/**
 * FL (Flagsrus) catalog sync — links designs to their FL products and imports
 * FL-only products as new No-vision designs. Logic lives in lib/fl-sync.ts.
 *
 * Request: POST /api/review/sync-fl
 *   body: { apply?: boolean }
 *     - apply omitted/false → dry run: reports counts, writes nothing
 *     - apply true          → writes fl_* columns + inserts FL-only designs
 *
 * Response: JSON FlSyncResult (+ ok). Manual only, like the JF sync.
 *
 * Needs SHOPIFY_FL_STORE + SHOPIFY_FL_ADMIN_TOKEN in Vercel env.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { isStoreConfigured } from "@/lib/shopify";
import { runFlSync } from "@/lib/fl-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest): Promise<Response> {
  if (!isStoreConfigured("fl")) {
    return errorJson(500, "Missing SHOPIFY_FL_STORE / SHOPIFY_FL_ADMIN_TOKEN in Vercel env");
  }
  let apply = false;
  try {
    const body = (await req.json()) as { apply?: unknown } | null;
    apply = body?.apply === true;
  } catch {
    // no body → dry run
  }
  try {
    const result = await runFlSync(getAdminSupabase(), { apply });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }
}

function errorJson(status: number, msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
