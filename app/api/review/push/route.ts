/**
 * Push curated tags to JFF Shopify for ready-to-send designs.
 *
 * Request: POST /api/review/push
 *   body: optional { design_families?: string[] }
 *     - omitted / empty array → push ALL status='readytosend'
 *     - non-empty array       → push only those families (still gated on status)
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
import { getAdminSupabase } from "@/lib/supabase-admin";
import { updateProductTags } from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby/Pro cap; big pushes run via CLI

interface ReadyDesign {
  design_family: string;
  approved_tags: string[];
  shopify_product_ids: number[] | null;
}

export async function POST(req: Request): Promise<Response> {
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
    // No body / non-JSON → treat as "push all readytosend".
  }

  const sb = getAdminSupabase();
  let q = sb
    .from("designs")
    .select("design_family,approved_tags,shopify_product_ids")
    .eq("status", "readytosend");
  if (requestedFamilies) q = q.in("design_family", requestedFamilies);
  const { data, error } = await q.order("design_family");
  if (error) return errorResponse(500, `select: ${error.message}`);
  const designs = (data ?? []) as ReadyDesign[];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

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
          actor: "blake",
          payload: {
            product_ids: productIds,
            tag_count: newTags.length,
          },
        });
        familiesPushed++;
        emit({ type: "ok", family: d.design_family });
      }

      emit({ type: "done", families_pushed: familiesPushed, products_failed: productsFailed });
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
