/**
 * Mistag suspect detector. Picks a random sample of `Updated` designs,
 * re-runs Claude vision on each, and surfaces ones where the fresh primary
 * tag disagrees with the stored `vision_raw.primary`. Catches designs that
 * pre-date a taxonomy change or a vision-prompt update — the curation
 * looked correct at the time but the new model/prompt sees something else.
 *
 *   GET  /api/review/mistag-audit?count=N
 *
 * Streams NDJSON for live UI progress:
 *   { "type": "start", "family", "stored_primary" }
 *   { "type": "ok",    "family", "stored_primary", "new_primary",
 *                      "match", "new_tags", "new_reasoning" }
 *   { "type": "error", "family", "error" }
 *   { "type": "done",  "total", "matched", "suspects", "errored" }
 *
 * Designs without a stored `vision_raw.primary` (manually curated, never
 * vision-touched) are skipped — there's nothing to compare against.
 *
 * Cost: ~$0.006/design via Sonnet 4.6. Default count=20 ≈ $0.12/run.
 * Cheap enough to run weekly without thinking about it. The route does
 * NOT write anything to the DB — flagging suspects is a separate user
 * action (the standard `flag` POST on each family).
 */
import type { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { buildSystemPrompt, tagOne } from "@/lib/vision";
import { primaryImageUrl } from "@/lib/product-image";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CONCURRENCY = 3;
const MAX_COUNT = 50;
const DEFAULT_COUNT = 20;

interface DesignRow {
  design_family: string;
  design_name: string | null;
  image_url: string | null;
  variant_skus: string[] | null;
  approved_tags: string[] | null;
  vision_raw: { primary?: string | null } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return errorJson(500, "Missing ANTHROPIC_API_KEY");
  }
  const sp = req.nextUrl.searchParams;
  const requested = parseInt(sp.get("count") || `${DEFAULT_COUNT}`, 10);
  const count = Math.min(Math.max(requested || DEFAULT_COUNT, 1), MAX_COUNT);

  const sb = getAdminSupabase();

  // Pull the current vision prompt (same path the vision/run route uses).
  let promptTemplate: string | undefined = undefined;
  try {
    const { data } = await sb
      .from("vision_prompts")
      .select("prompt")
      .eq("is_current", true)
      .single();
    if (data) promptTemplate = (data as { prompt: string }).prompt;
  } catch {
    // no saved prompt — fall back to the default
  }
  const systemPrompt = await buildSystemPrompt(promptTemplate);

  // Pick a random sample of Updated designs that have a vision_raw.primary
  // to compare against. Two-step: fetch keys with primaries set, shuffle,
  // hydrate the chosen ones with full row data.
  const { data: candidates, error: selErr } = await sb
    .from("designs")
    .select("design_family")
    .eq("status", "updated")
    .not("vision_raw", "is", null)
    .limit(20000);
  if (selErr) return errorJson(500, `select candidates: ${selErr.message}`);
  const allKeys = (candidates ?? []).map(
    (r: { design_family: string }) => r.design_family,
  );
  if (allKeys.length === 0) {
    return Response.json(
      { error: "No Updated designs with stored vision data to audit." },
      { status: 400 },
    );
  }
  // Fisher-Yates shuffle.
  for (let i = allKeys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allKeys[i], allKeys[j]] = [allKeys[j], allKeys[i]];
  }
  const sample = allKeys.slice(0, count);

  const { data: rows, error: hydErr } = await sb
    .from("designs")
    .select(
      "design_family,design_name,image_url,variant_skus,approved_tags,vision_raw",
    )
    .in("design_family", sample);
  if (hydErr) return errorJson(500, `hydrate sample: ${hydErr.message}`);
  const designs = (rows ?? []) as DesignRow[];

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 4,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Tolerate client disconnect — same pattern as push/vision-run.
      let clientConnected = true;
      const emit = (obj: Record<string, unknown>) => {
        if (!clientConnected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          clientConnected = false;
        }
      };
      req.signal?.addEventListener("abort", () => {
        clientConnected = false;
      });

      const queue = designs.slice();
      let matched = 0;
      let suspects = 0;
      let errored = 0;

      const worker = async () => {
        while (queue.length > 0) {
          const d = queue.shift();
          if (!d) return;
          const storedPrimary = d.vision_raw?.primary ?? null;
          emit({
            type: "start",
            family: d.design_family,
            stored_primary: storedPrimary,
          });
          const result = await tagOne(client, {
            designFamily: d.design_family,
            imageUrl: primaryImageUrl({
              design_family: d.design_family,
              image_url: d.image_url,
              variant_skus: d.variant_skus,
            }),
            systemPrompt,
          });
          if (!result.ok) {
            errored++;
            emit({
              type: "error",
              family: d.design_family,
              error: result.error,
            });
            continue;
          }
          const newPrimary = result.value.primary;
          const match = storedPrimary === newPrimary;
          if (match) matched++;
          else suspects++;
          emit({
            type: "ok",
            family: d.design_family,
            design_name: d.design_name,
            image_url: d.image_url,
            approved_tags: d.approved_tags,
            stored_primary: storedPrimary,
            new_primary: newPrimary,
            match,
            new_tags: result.value.tags,
            new_reasoning: result.value.reasoning,
          });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, designs.length) }, () =>
          worker(),
        ),
      );

      emit({
        type: "done",
        total: designs.length,
        matched,
        suspects,
        errored,
      });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}

function errorJson(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
