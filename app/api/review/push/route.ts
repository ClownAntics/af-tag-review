/**
 * Push curated tags to JFF Shopify for ready-to-send designs.
 *
 * Request: POST /api/review/push?<filter params>
 *   body: optional { design_families?: string[] }
 *     - non-empty array       → push only those families (filters ignored)
 *     - omitted / empty array → push every status='readytosend' that matches
 *                                the URL filter params (themeName, subTheme,
 *                                tag, productType, manufacturer). No filters
 *                                in the URL → push everything.
 *
 * The filter query string mirrors `/api/review/queue` and `/api/review/counts`
 * so "Push all N" in the UI pushes exactly the N rows the user sees, even
 * when filters are active.
 *
 * Response: chunked NDJSON stream, one JSON object per line:
 *   { "type": "start",   "family": "AFSP0106", "product_ids": [...] }
 *   { "type": "ok",      "family": "AFSP0106" }
 *   { "type": "error",   "family": "AFSP0106", "error": "…" }
 *   { "type": "skipped", "family": "AFSP0106", "reason": "…" }
 *   { "type": "done",    "families_pushed": N, "products_failed": M }
 *
 * Shopify REST is rate-limited (~2 req/sec). We push sequentially per family
 * but in parallel across a family's products (2-5 at most for AF).
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getActor } from "@/lib/auth";
import { updateProductTags } from "@/lib/shopify";
import {
  applyReviewFilters,
  parseFiltersFromSearch,
} from "@/lib/review-filters";

export const dynamic = "force-dynamic";
// 800s is the Vercel Pro max (requires Fluid Compute, default-on for recent
// projects). At Shopify's ~2 req/sec that's ~800 designs per push click vs
// ~300 at the old 300s cap. For the whole readytosend queue in one shot,
// use the CLI: `npx tsx scripts/shopify-push.ts --apply` (no timeout).
export const maxDuration = 800;

interface ReadyDesign {
  design_family: string;
  approved_tags: string[];
  shopify_product_ids: number[] | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.SHOPIFY_ADMIN_TOKEN || !process.env.SHOPIFY_STORE) {
    return errorResponse(500, "Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");
  }

  let requestedFamilies: string[] | null = null;
  try {
    const body = (await req.json()) as { design_families?: unknown } | null;
    if (body && Array.isArray(body.design_families) && body.design_families.length > 0) {
      requestedFamilies = body.design_families.filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
    }
  } catch {
    // No body / non-JSON → treat as "push all readytosend, respecting URL filters".
  }

  const filters = parseFiltersFromSearch(req.nextUrl.searchParams);

  const sb = getAdminSupabase();
  const actor = await getActor();
  // Cast through `unknown` so applyReviewFilters' structural type doesn't
  // tangle with PostgREST's deeply-nested generics (TS2589) — mirrors the
  // same pattern used in /api/review/queue.
  const base = sb
    .from("designs")
    .select("design_family,approved_tags,shopify_product_ids")
    .eq("status", "readytosend") as unknown as Parameters<
    typeof applyReviewFilters
  >[0];

  // When the caller passes an explicit family list, that's the authoritative
  // scope — skip the URL filter (it's already implicit in how the UI built
  // the list). Otherwise honor URL filters so "Push all N" matches the tile.
  let q: ReturnType<typeof applyReviewFilters>;
  if (requestedFamilies) {
    q = base;
  } else {
    q = applyReviewFilters(base, filters);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q2: any = q;
  if (requestedFamilies) q2 = q2.in("design_family", requestedFamilies);
  const { data, error } = await q2.order("design_family");
  if (error) return errorResponse(500, `select: ${error.message}`);
  const designs = (data ?? []) as ReadyDesign[];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // If the browser navigates away mid-push, the underlying socket closes
      // and any subsequent `controller.enqueue` throws (TypeError: Invalid
      // state). We don't want that to abort the Shopify-update loop — the
      // user expects the push to complete server-side even if they close the
      // tab. Track the connection state and short-circuit emits once it's
      // dropped; the work continues.
      let clientConnected = true;
      const emit = (obj: Record<string, unknown>) => {
        if (!clientConnected) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // Stream closed by the client. Stop trying to write, keep working.
          clientConnected = false;
        }
      };
      // Also drop the connected flag if the request itself is aborted (some
      // Vercel paths fire this slightly before enqueue starts erroring).
      req.signal?.addEventListener("abort", () => {
        clientConnected = false;
      });

      let familiesPushed = 0;
      let productsFailed = 0;

      for (const d of designs) {
        const productIds = d.shopify_product_ids ?? [];
        const newTags = [...new Set(d.approved_tags ?? [])].sort();
        if (productIds.length === 0) {
          emit({
            type: "skipped",
            family: d.design_family,
            reason: "no shopify_product_ids — re-run shopify-pull",
          });
          continue;
        }
        if (newTags.length === 0) {
          emit({
            type: "skipped",
            family: d.design_family,
            reason: "approved_tags empty",
          });
          continue;
        }

        emit({ type: "start", family: d.design_family, product_ids: productIds });

        const results = await Promise.all(
          productIds.map(async (id) => {
            try {
              await updateProductTags(id, newTags);
              return { id, ok: true as const };
            } catch (e) {
              return { id, ok: false as const, error: (e as Error).message };
            }
          }),
        );
        const failed = results.filter((r) => !r.ok);

        if (failed.length > 0) {
          productsFailed += failed.length;
          emit({
            type: "error",
            family: d.design_family,
            error: `${failed.length}/${productIds.length} products failed`,
            failed_product_ids: failed.map((f) => f.id),
          });
          await sb.from("events").insert({
            design_family: d.design_family,
            event_type: "push_failed",
            actor: "system",
            payload: {
              failed_product_ids: failed.map((f) => f.id),
              errors: failed.map((f) => f.error),
            },
          });
          continue;
        }

        const { error: updErr } = await sb
          .from("designs")
          .update({
            status: "updated",
            last_pushed_at: new Date().toISOString(),
            shopify_tags: newTags,
          })
          .eq("design_family", d.design_family);
        if (updErr) {
          emit({
            type: "error",
            family: d.design_family,
            error: `Shopify OK but DB update failed: ${updErr.message}`,
          });
          continue;
        }
        await sb.from("events").insert({
          design_family: d.design_family,
          event_type: "pushed",
          actor,
          payload: {
            product_ids: productIds,
            tag_count: newTags.length,
          },
        });
        familiesPushed++;
        emit({ type: "ok", family: d.design_family });
      }

      emit({ type: "done", families_pushed: familiesPushed, products_failed: productsFailed });
      // Closing an already-closed stream throws; swallow it because the work
      // is already done.
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

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
