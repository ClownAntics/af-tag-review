/**
 * Run Claude vision on a batch of flagged designs and move them to Pending.
 *
 * Request: POST /api/review/vision/run
 *   body: { design_families: string[] }
 *
 * Response: chunked NDJSON stream — one JSON object per line:
 *   { "type": "start",   "family": "AFSP0001" }
 *   { "type": "ok",      "family": "AFSP0001", "tags": [...] }
 *   { "type": "error",   "family": "AFSP0001", "error": "..." }
 *   { "type": "done",    "completed": N, "failed": M }
 *
 * Concurrency is intentionally low (3) — Haiku has a 50 req/min limit.
 * For larger bulk runs (hundreds+) prefer the CLI `npx tsx scripts/tag-with-vision.ts`.
 */
import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { buildSystemPrompt, tagOne, VISION_MODEL } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel: 5 minutes

const CONCURRENCY = 3;

interface Body {
  design_families: string[];
}

const IMG_BASE = "https://images.clownantics.com/CA_resize_500_500/";
function imgUrl(designFamily: string): string {
  return `${IMG_BASE}${`AFGF${designFamily.replace(/^AF/, "")}`.toLowerCase()}.jpg`;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return errorResponse(500, "Missing ANTHROPIC_API_KEY");
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  const families = Array.isArray(body.design_families) ? body.design_families : [];
  if (families.length === 0) return errorResponse(400, "design_families required");

  // Load the current vision prompt template from Supabase; fall back to default.
  const sb = getAdminSupabase();
  let promptTemplate: string | undefined = undefined;
  try {
    const { data } = await sb
      .from("vision_prompts")
      .select("prompt")
      .eq("is_current", true)
      .single();
    if (data) promptTemplate = (data as { prompt: string }).prompt;
  } catch {
    // no saved prompt yet — use default
  }
  const systemPrompt = buildSystemPrompt(promptTemplate);

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 6,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      // Process queue with bounded concurrency.
      const queue = families.slice();
      let completed = 0;
      let failed = 0;

      const worker = async () => {
        while (queue.length > 0) {
          const family = queue.shift();
          if (!family) return;
          emit({ type: "start", family });
          const result = await tagOne(client, {
            designFamily: family,
            imageUrl: imgUrl(family),
            systemPrompt,
          });
          if (!result.ok) {
            failed++;
            emit({ type: "error", family, error: result.error });
            await sb.from("events").insert({
              design_family: family,
              event_type: "vision_failed",
              actor: "system",
              payload: { error: result.error },
            });
            continue;
          }
          // Dedupe vision_tags against existing approved_tags: on re-review the
          // user has already locked those in, and showing them twice in the UI
          // (once in Approved, once in Vision) is confusing.
          const { data: existing } = await sb
            .from("designs")
            .select("approved_tags")
            .eq("design_family", family)
            .single();
          const approvedSet = new Set(
            (existing as { approved_tags: string[] | null } | null)?.approved_tags ?? [],
          );
          const dedupedVisionTags = result.value.tags.filter((t) => !approvedSet.has(t));
          const { error: updateErr } = await sb
            .from("designs")
            .update({
              vision_tags: dedupedVisionTags,
              vision_model: VISION_MODEL,
              vision_tagged_at: new Date().toISOString(),
              vision_raw: result.value,
              status: "pending",
            })
            .eq("design_family", family);
          if (updateErr) {
            failed++;
            emit({ type: "error", family, error: updateErr.message });
            continue;
          }
          await sb.from("events").insert({
            design_family: family,
            event_type: "vision_completed",
            actor: "system",
            payload: {
              suggestion_count: result.value.tags.length,
              confidence: result.value.confidence,
            },
          });
          completed++;
          emit({ type: "ok", family, tags: result.value.tags });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, families.length) }, () => worker()),
      );

      emit({ type: "done", completed, failed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
