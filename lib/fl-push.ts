/**
 * FL (Flagsrus) tag push.
 *
 * JF is the curation store: designs get approved_tags in Tag Review and are
 * pushed to JF by /api/review/push. FL sells many of the same products under
 * different Shopify product IDs, so this module copies the curated theme tags
 * across by matching variant SKUs:
 *
 *   1. Load every design with status='updated' (live on JF) and build a
 *      SKU → design map from designs.variant_skus.
 *   2. Page through the FL catalog (active + draft). For each FL product whose
 *      variant SKU matches a design, compute the merged tag set with the same
 *      T7 merge rule as the JF push:
 *        next = (current − owned) ∪ approved_tags ∪ facets(FL product_type)
 *      Owned = taxonomy Search Terms + size/material facet slugs. Everything
 *      else on the FL product (Product Hub label tags like
 *      "Seasonal: Easter: Easter Eggs", Solo, in-stock, brand tags…) is kept.
 *   3. Only products whose tag set actually changes are PUT. That makes the
 *      push idempotent and resumable: re-running after a timeout skips the
 *      products already done.
 *
 * Dry run (apply=false) does steps 1–2 and reports what WOULD change.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeMergedTags,
  listProducts,
  normalizeTagKey,
  sameTagSet,
  updateProductTags,
} from "./shopify";
import { getTaxonomy } from "./taxonomy-source";
import { featureTags, OWNED_FACET_KEYS, sizeMaterialTags, type FacetFlags } from "./facet-tags";

interface FlDesign extends FacetFlags {
  design_family: string;
  approved_tags: string[] | null;
  variant_skus: string[] | null;
}

const DESIGN_COLUMNS =
  "design_family,approved_tags,variant_skus," +
  "is_double_sided,is_reversible,is_premiersoft,is_suede_reflections," +
  "is_glittertrends,is_printed_in_usa,is_envirofriendly";

export type FlPushEvent =
  | { type: "start"; designs: number; skus: number; apply: boolean }
  | { type: "progress"; scanned: number; matched: number; changed: number; pushed: number }
  | {
      type: "change";
      family: string;
      product_id: number;
      title: string;
      added: string[];
      removed: string[];
      pushed: boolean;
    }
  | { type: "error"; family: string; product_id: number; error: string }
  | {
      type: "done";
      scanned: number;
      matched: number;
      unchanged: number;
      changed: number;
      pushed: number;
      failed: number;
      stopped_early: boolean;
    };

export interface FlPushOptions {
  apply: boolean;
  /** Stop issuing PUTs after this many ms (route time budget). Re-run to resume. */
  budgetMs?: number;
  /** Stop after this many changed products (smoke tests). */
  maxChanges?: number;
  /** Only these design families. */
  families?: string[];
}

async function loadDesigns(sb: SupabaseClient, families?: string[]): Promise<FlDesign[]> {
  const out: FlDesign[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("designs")
      .select(DESIGN_COLUMNS)
      .eq("status", "updated")
      .not("approved_tags", "is", null)
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (families && families.length > 0) q = q.in("design_family", families);
    const { data, error } = await q;
    if (error) throw new Error(`load designs: ${error.message}`);
    const rows = (data ?? []) as unknown as FlDesign[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.filter((d) => (d.approved_tags ?? []).length > 0);
}

export async function* runFlPush(
  sb: SupabaseClient,
  opts: FlPushOptions,
): AsyncGenerator<FlPushEvent, void, unknown> {
  const started = Date.now();
  const designs = await loadDesigns(sb, opts.families);

  const bySku = new Map<string, FlDesign>();
  for (const d of designs) {
    for (const s of d.variant_skus ?? []) {
      const k = s.trim().toUpperCase();
      if (k && !bySku.has(k)) bySku.set(k, d);
    }
  }

  const ownedKeys: ReadonlySet<string> = new Set([
    ...(await getTaxonomy()).entries.map((e) => normalizeTagKey(e.term)),
    ...OWNED_FACET_KEYS,
  ]);

  yield { type: "start", designs: designs.length, skus: bySku.size, apply: opts.apply };

  let scanned = 0;
  let matched = 0;
  let unchanged = 0;
  let changed = 0;
  let pushed = 0;
  let failed = 0;
  let stoppedEarly = false;
  const pushedByFamily = new Map<string, number[]>();

  for await (const p of listProducts({ target: "fl", status: "active,draft" })) {
    scanned++;
    if (scanned % 500 === 0) yield { type: "progress", scanned, matched, changed, pushed };

    let design: FlDesign | undefined;
    for (const v of p.variants ?? []) {
      const k = (v.sku ?? "").trim().toUpperCase();
      if (k && bySku.has(k)) {
        design = bySku.get(k);
        break;
      }
    }
    if (!design) continue;
    matched++;

    const current = (p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const emit = [
      ...(design.approved_tags ?? []),
      ...sizeMaterialTags([p.product_type ?? ""]),
      ...featureTags(design),
    ];
    const next = computeMergedTags(current, emit, ownedKeys);
    if (sameTagSet(current, next)) {
      unchanged++;
      continue;
    }
    changed++;

    const curKeys = new Set(current.map((t) => t.toLowerCase()));
    const nextKeys = new Set(next.map((t) => t.toLowerCase()));
    const added = next.filter((t) => !curKeys.has(t.toLowerCase()));
    const removed = current.filter((t) => !nextKeys.has(t.toLowerCase()));

    const outOfBudget = opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs;
    let didPush = false;
    if (opts.apply && !outOfBudget) {
      try {
        await updateProductTags(p.id, next, "fl");
        didPush = true;
        pushed++;
        const ids = pushedByFamily.get(design.design_family) ?? [];
        ids.push(p.id);
        pushedByFamily.set(design.design_family, ids);
      } catch (e) {
        failed++;
        yield {
          type: "error",
          family: design.design_family,
          product_id: p.id,
          error: (e as Error).message,
        };
        continue;
      }
    } else if (opts.apply && outOfBudget) {
      stoppedEarly = true;
    }

    yield {
      type: "change",
      family: design.design_family,
      product_id: p.id,
      title: p.title,
      added,
      removed,
      pushed: didPush,
    };

    if (opts.maxChanges !== undefined && changed >= opts.maxChanges) {
      stoppedEarly = true;
      break;
    }
    // Out of PUT budget: keep scanning only in dry-run; in apply mode stop so
    // the route returns before its hard timeout. Re-run resumes.
    if (opts.apply && outOfBudget) break;
  }

  // Audit trail: one event per family that had FL products updated.
  const events = [...pushedByFamily.entries()].map(([family, ids]) => ({
    design_family: family,
    event_type: "fl_pushed",
    actor: "system",
    payload: { fl_product_ids: ids },
  }));
  for (let i = 0; i < events.length; i += 500) {
    await sb.from("events").insert(events.slice(i, i + 500));
  }

  yield { type: "done", scanned, matched, unchanged, changed, pushed, failed, stopped_early: stoppedEarly };
}
