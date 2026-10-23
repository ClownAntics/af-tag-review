/**
 * Push curated tags for ready-to-send designs to BOTH stores: JF
 * (shopify_product_ids) and FL (fl_product_ids, linked by the FL catalog
 * sync). FL-only designs push to FL only. Per-design logic lives in
 * lib/push-design.ts (shared with scripts/shopify-push.ts).
 *
 * MERGE-PUSH (T7): only canonical taxonomy terms + size/material facets are
 * owned by the pipeline — they're synced to approved_tags; all other live
 * tags (brand, functional, app tags) are preserved. See mergeProductTags.
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
 *   { "type": "start",   "family": "AFSP0106", "product_ids": [...], "fl_product_ids": [...] }
 *   { "type": "ok",      "family": "AFSP0106", "product_ids": [...], "fl_product_ids": [...] }
 *   { "type": "error",   "family": "AFSP0106", "error": "…" }
 *   { "type": "skipped", "family": "AFSP0106", "reason": "…" }
 *   { "type": "done",    "families_pushed": N, "products_failed": M }
 *
 * Shopify REST is rate-limited (~2 req/sec per store). We push sequentially
 * per family; a family's products run in parallel, JF and FL side by side.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getActor } from "@/lib/auth";
import { normalizeTagKey } from "@/lib/shopify";
import { getOwnedTaxonomyKeys } from "@/lib/taxonomy-source";
import { OWNED_FACET_KEYS } from "@/lib/facet-tags";
import { pushDesign, PUSH_COLUMNS, type PushableDesign } from "@/lib/push-design";
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
    .select(PUSH_COLUMNS)
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
  const designs = (data ?? []) as PushableDesign[];

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

      // T7 merge-push: the pipeline OWNS canonical taxonomy terms + the
      // size/material facet vocabulary (T5) — it syncs those and preserves
      // every other live tag (brand/functional tags that smart collections +
      // the theme filter bar depend on). Stale owned tags are removed.
      const ownedKeys: ReadonlySet<string> = new Set([
        ...(await getOwnedTaxonomyKeys(normalizeTagKey)),
        ...OWNED_FACET_KEYS,
      ]);

      for (const d of designs) {
        emit({
          type: "start",
          family: d.design_family,
          product_ids: d.shopify_product_ids ?? [],
          fl_product_ids: d.fl_product_ids ?? [],
        });
        const outcome = await pushDesign(sb, d, ownedKeys, actor);
        if (outcome.kind === "skipped") {
          emit({ type: "skipped", family: d.design_family, reason: outcome.reason });
          continue;
        }
        if (outcome.kind === "failed") {
          productsFailed += outcome.failed.length;
          emit({
            type: "error",
            family: d.design_family,
            error: `${outcome.failed.length}/${outcome.total} products failed (${[
              ...new Set(outcome.failed.map((f) => f.store.toUpperCase())),
            ].join(" + ")})`,
            failed_product_ids: outcome.failed.map((f) => f.id),
          });
          continue;
        }
        if (outcome.kind === "db_error") {
          emit({ type: "error", family: d.design_family, error: outcome.error });
          continue;
        }
        familiesPushed++;
        emit({
          type: "ok",
          family: d.design_family,
          product_ids: outcome.jfIds,
          fl_product_ids: outcome.flIds,
        });
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
