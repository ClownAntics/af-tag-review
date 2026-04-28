/**
 * Nuclear reset: move every design back to `novision` and re-pull current
 * tags from JFF Shopify. Used from the Settings modal when the user wants
 * to start the whole review cycle over.
 *
 * Request: POST /api/review/reset-all
 *   body: { confirm: "RESET" }   // guard against accidental POSTs
 *
 * Response: chunked NDJSON, one JSON object per line:
 *   { "type": "start",          "total": 9514 }
 *   { "type": "db_reset",       "reset_count": 9514 }
 *   { "type": "shopify_pulled", "products_seen": N, "families_updated": M }
 *   { "type": "done",           "total": 9514, "tag_changes": K }
 *   { "type": "error",          "error": "…" }
 *
 * Phases:
 *   1. DB reset — bulk UPDATE designs SET status='novision', approved_tags=NULL,
 *      vision_tags=NULL, last_reviewed_at=NULL, last_pushed_at=NULL. One event
 *      per family: {event_type: 'reset_from_shopify', payload: {prior_status}}.
 *      History (events table) is never deleted.
 *   2. Shopify pull — stream products, aggregate tags per design_family, update
 *      shopify_tags + shopify_product_ids on each, re-derive theme columns via
 *      taxonomy mapping.
 *
 * Runs sequentially in a single streaming response. Vercel caps at 300s (Hobby
 * / Pro) — big pulls may need the CLI `npx tsx scripts/shopify-pull.ts --apply`
 * instead. The DB reset step alone always fits inside the budget.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { listProducts, productToFamily } from "@/lib/shopify";
import { mapTagsToThemes } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACTOR = "blake";

export async function POST(req: Request): Promise<Response> {
  if (!process.env.SHOPIFY_ADMIN_TOKEN || !process.env.SHOPIFY_STORE) {
    return errorResponse(500, "Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");
  }

  let body: { confirm?: unknown } | null = null;
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  if (body?.confirm !== "RESET") {
    return errorResponse(
      400,
      "missing confirm token — body must be {\"confirm\":\"RESET\"}",
    );
  }

  const sb = getAdminSupabase();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        // ─── Phase 1: count + snapshot prior status for audit ─────────────
        const priorByFamily = new Map<string, string>();
        let total = 0;
        const PAGE = 1000;
        for (let offset = 0; ; offset += PAGE) {
          const { data, error, count } = await sb
            .from("designs")
            .select("design_family,status", { count: "exact" })
            .order("design_family")
            .range(offset, offset + PAGE - 1);
          if (error) throw new Error(`select snapshot: ${error.message}`);
          if (offset === 0 && typeof count === "number") total = count;
          const rows = (data ?? []) as { design_family: string; status: string | null }[];
          for (const r of rows) priorByFamily.set(r.design_family, r.status ?? "novision");
          if (rows.length < PAGE) break;
        }
        emit({ type: "start", total });

        // ─── Phase 2: bulk DB reset ──────────────────────────────────────
        // Everything back to novision. Approved/vision tags cleared so the
        // next cycle starts fresh. Shopify_tags is NOT cleared here — phase
        // 3 overwrites it with fresh data, and we don't want a transient
        // window where it's empty.
        const { error: updErr } = await sb
          .from("designs")
          .update({
            status: "novision",
            approved_tags: null,
            vision_tags: null,
            last_reviewed_at: null,
            last_pushed_at: null,
          })
          .neq("design_family", "__never_match__"); // force WHERE so PostgREST accepts it
        if (updErr) throw new Error(`bulk reset: ${updErr.message}`);
        emit({ type: "db_reset", reset_count: total });

        // Audit events for every family — batched in chunks of 500. We
        // tolerate partial event-insert failures (log warning, keep going).
        const eventRows = Array.from(priorByFamily.entries()).map(
          ([family, prior]) => ({
            design_family: family,
            event_type: "reset_from_shopify",
            actor: ACTOR,
            payload: { prior_status: prior },
          }),
        );
        for (let i = 0; i < eventRows.length; i += 500) {
          const batch = eventRows.slice(i, i + 500);
          const { error: evtErr } = await sb.from("events").insert(batch);
          if (evtErr) console.warn(`reset event batch ${i}: ${evtErr.message}`);
        }

        // ─── Phase 3: stream Shopify products, aggregate per family ──────
        interface Agg {
          tags: Set<string>;
          productIds: Set<number>;
          manufacturer: string;
        }
        const byFamily = new Map<string, Agg>();
        let productsSeen = 0;
        for await (const p of listProducts()) {
          productsSeen++;
          const resolved = productToFamily(p);
          if (!resolved) continue;
          const tags = (p.tags ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const existing = byFamily.get(resolved.design_family);
          if (existing) {
            for (const t of tags) existing.tags.add(t);
            existing.productIds.add(p.id);
          } else {
            byFamily.set(resolved.design_family, {
              tags: new Set(tags),
              productIds: new Set([p.id]),
              manufacturer: resolved.manufacturer,
            });
          }
          if (productsSeen % 500 === 0) {
            emit({ type: "progress", products_seen: productsSeen });
          }
        }

        // ─── Phase 4: write fresh tags + theme columns per family ────────
        // We only update rows that already exist in the designs table. New
        // families (products Shopify has that Supabase doesn't) are left to
        // the `shopify-pull.ts --apply` script, which handles inserts with
        // proper manufacturer defaults.
        let familiesUpdated = 0;
        let tagChanges = 0;
        const updateBatch: Array<{
          design_family: string;
          shopify_tags: string[];
          shopify_product_ids: number[];
          theme_names: string[];
          sub_themes: string[];
          sub_sub_themes: string[];
        }> = [];
        for (const [family, agg] of byFamily) {
          if (!priorByFamily.has(family)) continue; // new row — skip, CLI handles
          const tags = Array.from(agg.tags).sort();
          const productIds = Array.from(agg.productIds).sort((a, b) => a - b);
          const themes = await mapTagsToThemes(tags);
          updateBatch.push({
            design_family: family,
            shopify_tags: tags,
            shopify_product_ids: productIds,
            theme_names: themes.theme_names,
            sub_themes: themes.sub_themes,
            sub_sub_themes: themes.sub_sub_themes,
          });
        }

        // PostgREST doesn't do "bulk update with per-row values" cleanly. We
        // issue per-family updates in parallel-ish batches of 20 to keep the
        // wire chatty but bounded.
        const PARALLEL = 20;
        for (let i = 0; i < updateBatch.length; i += PARALLEL) {
          const slice = updateBatch.slice(i, i + PARALLEL);
          await Promise.all(
            slice.map(async (row) => {
              const { error: rowErr } = await sb
                .from("designs")
                .update({
                  shopify_tags: row.shopify_tags,
                  shopify_product_ids: row.shopify_product_ids,
                  theme_names: row.theme_names,
                  sub_themes: row.sub_themes,
                  sub_sub_themes: row.sub_sub_themes,
                })
                .eq("design_family", row.design_family);
              if (rowErr) {
                console.warn(`reset update ${row.design_family}: ${rowErr.message}`);
                return;
              }
              familiesUpdated++;
              tagChanges += row.shopify_tags.length;
            }),
          );
          if ((i + PARALLEL) % 500 < PARALLEL) {
            emit({
              type: "progress",
              families_updated: familiesUpdated,
              tag_changes: tagChanges,
            });
          }
        }
        emit({
          type: "shopify_pulled",
          products_seen: productsSeen,
          families_updated: familiesUpdated,
        });

        emit({ type: "done", total, tag_changes: tagChanges });
      } catch (e) {
        emit({ type: "error", error: (e as Error).message });
      } finally {
        controller.close();
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
