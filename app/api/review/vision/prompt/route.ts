/**
 * GET:  returns the current vision prompt template + version/saved-at.
 *       If no prompt is saved yet, returns the built-in DEFAULT_PROMPT (flagged
 *       via `is_default: true`).
 * POST: saves a new version. Previous versions stay in the table (immutable
 *       audit trail); only the newest is_current=true.
 *       body: { prompt: string }
 * DELETE: "reset" — clears is_current, so GET falls back to the default.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const ACTOR = "blake";

export async function GET(): Promise<Response> {
  const sb = getAdminSupabase();
  const { data, error } = await sb
    .from("vision_prompts")
    .select("version,prompt,created_at,created_by")
    .eq("is_current", true)
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    return errorResponse(500, error.message);
  }
  if (!data) {
    return Response.json({ is_default: true });
  }
  return Response.json({ is_default: false, ...data });
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return errorResponse(400, "prompt must be a non-empty string");
  }
  const prompt = body.prompt;

  const sb = getAdminSupabase();

  // Determine the next version number.
  const { data: latest } = await sb
    .from("vision_prompts")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion =
    latest && typeof (latest as { version: number }).version === "number"
      ? (latest as { version: number }).version + 1
      : 1;

  // Demote any currently-current row.
  await sb.from("vision_prompts").update({ is_current: false }).eq("is_current", true);

  const { data: inserted, error: insertErr } = await sb
    .from("vision_prompts")
    .insert({
      version: nextVersion,
      prompt,
      is_current: true,
      created_by: ACTOR,
    })
    .select("version,created_at")
    .single();
  if (insertErr) return errorResponse(500, `insert: ${insertErr.message}`);

  return Response.json({ ok: true, ...inserted });
}

export async function DELETE(): Promise<Response> {
  const sb = getAdminSupabase();
  const { error } = await sb
    .from("vision_prompts")
    .update({ is_current: false })
    .eq("is_current", true);
  if (error) return errorResponse(500, error.message);
  return Response.json({ ok: true });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
