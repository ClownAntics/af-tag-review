/**
 * Push curated tags to the FL (Flagsrus) Shopify store, matched by SKU.
 * Logic lives in lib/fl-push.ts.
 *
 * Request: POST /api/review/push-fl
 *   body: { apply?: boolean, families?: string[], maxChanges?: number }
 *     - apply omitted/false → dry run: scans FL, reports what would change
 *     - apply true          → PUTs changed products (resumable: re-run to
 *                             continue if the time budget runs out)
 *
 * Response: NDJSON stream of FlPushEvent (start / progress / change / error / done).
 *
 * Needs SHOPIFY_FL_STORE + SHOPIFY_FL_ADMIN_TOKEN in Vercel env.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { isStoreConfigured } from "@/lib/shopify";
import { runFlPush } from "@/lib/fl-push";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Leave headroom under maxDuration for the final event insert + response.
const PUT_BUDGET_MS = 700_000;

export async function POST(req: NextRequest): Promise<Response> {
  if (!isStoreConfigured("fl")) {
    return new Response(
      JSON.stringify({ error: "Missing SHOPIFY_FL_STORE / SHOPIFY_FL_ADMIN_TOKEN in Vercel env" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let apply = false;
  let families: string[] | undefined;
  let maxChanges: number | undefined;
  try {
    const body = (await req.json()) as {
      apply?: unknown;
      families?: unknown;
      maxChanges?: unknown;
    } | null;
    apply = body?.apply === true;
    if (Array.isArray(body?.families)) {
      families = body.families.filter((f): f is string => typeof f === "string" && f.length > 0);
    }
    if (typeof body?.maxChanges === "number" && body.maxChanges > 0) maxChanges = body.maxChanges;
  } catch {
    // no body → dry run of everything
  }

  const sb = getAdminSupabase();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let connected = true;
      const emit = (obj: unknown) => {
        if (!connected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          connected = false;
        }
      };
      req.signal?.addEventListener("abort", () => {
        connected = false;
      });
      try {
        for await (const ev of runFlPush(sb, { apply, families, maxChanges, budgetMs: PUT_BUDGET_MS })) {
          emit(ev);
        }
      } catch (e) {
        emit({ type: "fatal", error: (e as Error).message });
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
