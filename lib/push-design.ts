/**
 * Push one design's curated tags to BOTH stores — JF (shopify_product_ids)
 * and FL (fl_product_ids, linked by lib/fl-sync.ts). Shared by the Push
 * button (/api/review/push) and the CLI (scripts/shopify-push.ts) so the two
 * can't drift.
 *
 * Each product is merge-pushed (T7, lib/shopify mergeProductTags):
 *   next = (current − owned) ∪ approved_tags ∪ features ∪ size/material(own type)
 * JF and FL are separate stores with separate rate limits, so they run in
 * parallel. A design is promoted to 'updated' only when every product on
 * every store succeeds; any failure leaves it in readytosend (re-push is
 * idempotent — already-correct products are skipped).
 *
 * A design with no JF products but FL products is FL-only and pushes to FL
 * only. When FL creds are missing (local CLI), FL is skipped and reported;
 * the Settings "Push tags to FL" backfill catches those up later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStoreConfigured, mergeProductTags, type StoreTarget } from "./shopify";
import { featureTags, sizeMaterialTags, type FacetFlags } from "./facet-tags";

export interface PushableDesign extends FacetFlags {
  design_family: string;
  approved_tags: string[] | null;
  shopify_product_ids: number[] | null;
  fl_product_ids: number[] | null;
}

export const PUSH_COLUMNS =
  "design_family,approved_tags,shopify_product_ids,fl_product_ids," +
  "is_double_sided,is_reversible,is_premiersoft,is_suede_reflections," +
  "is_glittertrends,is_printed_in_usa,is_envirofriendly";

export type PushOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "failed";
      total: number;
      failed: Array<{ store: StoreTarget; id: number; error: string }>;
    }
  | { kind: "db_error"; error: string }
  | { kind: "ok"; jfIds: number[]; flIds: number[]; flSkipped: boolean; tagCount: number };

/** The tag set a design emits (before per-product size/material). */
export function designEmitTags(d: PushableDesign): string[] {
  return [...new Set([...(d.approved_tags ?? []), ...featureTags(d)])].sort();
}

export async function pushDesign(
  sb: SupabaseClient,
  d: PushableDesign,
  ownedKeys: ReadonlySet<string>,
  actor: string,
): Promise<PushOutcome> {
  const jfIds = d.shopify_product_ids ?? [];
  const flLinked = d.fl_product_ids ?? [];
  const flSkipped = flLinked.length > 0 && !isStoreConfigured("fl");
  const flIds = flSkipped ? [] : flLinked;

  if (jfIds.length === 0 && flLinked.length === 0) {
    return { kind: "skipped", reason: "not linked to JF or FL products — re-run the catalog syncs" };
  }
  if (jfIds.length === 0 && flSkipped) {
    return { kind: "skipped", reason: "FL-only design but SHOPIFY_FL_ADMIN_TOKEN is not set" };
  }
  if ((d.approved_tags ?? []).length === 0) {
    return { kind: "skipped", reason: "approved_tags empty" };
  }

  // Features are family-level (flag columns); size/material are PER-PRODUCT,
  // computed inside mergeProductTags from each product's own product_type.
  const newTags = designEmitTags(d);
  const perProduct = (type: string) => sizeMaterialTags([type]);

  const pushStore = (store: StoreTarget, ids: number[]) =>
    Promise.all(
      ids.map(async (id) => {
        try {
          const stored = await mergeProductTags(id, newTags, ownedKeys, perProduct, store);
          return { store, id, ok: true as const, storedTags: stored.tags };
        } catch (e) {
          return { store, id, ok: false as const, error: (e as Error).message };
        }
      }),
    );
  const [jf, fl] = await Promise.all([pushStore("jf", jfIds), pushStore("fl", flIds)]);

  const failed = [...jf, ...fl].flatMap((r) =>
    r.ok ? [] : [{ store: r.store, id: r.id, error: r.error }],
  );
  if (failed.length > 0) {
    await sb.from("events").insert({
      design_family: d.design_family,
      event_type: "push_failed",
      actor: "system",
      payload: {
        failed_product_ids: failed.map((f) => f.id),
        failed_stores: failed.map((f) => f.store),
        errors: failed.map((f) => f.error),
      },
    });
    return { kind: "failed", total: jfIds.length + flIds.length, failed };
  }

  // Mirror what each store ACTUALLY stored (union across the family's
  // products) — with merge-push this includes preserved non-taxonomy tags.
  const union = (rs: typeof jf) =>
    [
      ...new Set(
        rs
          .flatMap((r) => (r.ok ? r.storedTags.split(",") : []))
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].sort();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: "updated", last_pushed_at: now };
  if (jfIds.length > 0) patch.shopify_tags = union(jf);
  if (flIds.length > 0) {
    patch.fl_tags = union(fl);
    patch.fl_last_pushed_at = now;
    // FL-only: shopify_tags mirrors FL (it's the design's only live store).
    if (jfIds.length === 0) patch.shopify_tags = patch.fl_tags;
  }
  const { error: updErr } = await sb
    .from("designs")
    .update(patch)
    .eq("design_family", d.design_family);
  if (updErr) return { kind: "db_error", error: `Shopify OK but DB update failed: ${updErr.message}` };

  await sb.from("events").insert({
    design_family: d.design_family,
    event_type: "pushed",
    actor,
    payload: { product_ids: jfIds, fl_product_ids: flIds, tag_count: newTags.length },
  });
  return { kind: "ok", jfIds, flIds, flSkipped, tagCount: newTags.length };
}
