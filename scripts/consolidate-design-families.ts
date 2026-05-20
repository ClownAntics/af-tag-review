/**
 * Consolidate AF design rows that got split apart because the older SKU
 * parser was case-sensitive. Example: `AFhFSP0677` (the house variant of
 * "Cardinal and Flowers") landed in its own design row instead of merging
 * with `AFSP0677` (the garden variant). After the parser fix in
 * `lib/shopify.ts` both variants resolve to `AFSP0677`, but the legacy
 * orphan rows in the DB still need to be reconciled. That's what this
 * script does.
 *
 * Algorithm:
 *   1. Load every design row that has a non-empty `variant_skus`.
 *   2. For each row, run `skuToAfDesignFamily` (the new case-insensitive
 *      parser) on each variant SKU. Pick the most common result — that's
 *      the canonical family.
 *   3. If canonical !== current design_family, this row is mis-keyed.
 *      - If a row already exists at the canonical key → MERGE (winner =
 *        canonical, loser = current; union Shopify-side arrays; the
 *        canonical row's review state wins). Re-point events. Delete loser.
 *      - If no canonical row exists → RENAME (UPDATE design_family +
 *        re-point events).
 *
 * Usage:
 *   npx tsx scripts/consolidate-design-families.ts          # dry-run
 *   npx tsx scripts/consolidate-design-families.ts --apply  # commit
 */
import { getAdminClient } from "./_supabase-admin";
import { skuToAfDesignFamily } from "../lib/shopify";

interface Args {
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { apply: false };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

interface DesignRow {
  design_family: string;
  manufacturer: string | null;
  status: string;
  variant_skus: string[] | null;
  shopify_product_ids: number[] | null;
  shopify_product_types: string[] | null;
  shopify_tags: string[] | null;
  approved_tags: string[] | null;
  vision_tags: string[] | null;
  image_url: string | null;
}

const STATUS_RANK: Record<string, number> = {
  excluded: 0,
  novision: 1,
  flagged: 2,
  pending: 3,
  readytosend: 4,
  updated: 5,
};

async function loadAfDesigns(sb: ReturnType<typeof getAdminClient>): Promise<DesignRow[]> {
  const out: DesignRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,manufacturer,status,variant_skus,shopify_product_ids,shopify_product_types,shopify_tags,approved_tags,vision_tags,image_url",
      )
      .eq("manufacturer", "AF")
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const rows = (data ?? []) as DesignRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function canonicalFromSkus(skus: string[] | null): string | null {
  const cands = (skus ?? []).map(skuToAfDesignFamily).filter(Boolean) as string[];
  if (cands.length === 0) return null;
  // Most-common wins. Tie → first.
  const counts = new Map<string, number>();
  for (const c of cands) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = cands[0];
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function unionArr(a: string[] | null, b: string[] | null): string[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])])).sort();
}

function unionNumArr(a: number[] | null, b: number[] | null): number[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])])).sort((x, y) => x - y);
}

async function applyMerge(
  sb: ReturnType<typeof getAdminClient>,
  winner: DesignRow,
  loser: DesignRow,
): Promise<void> {
  // Status: keep whichever is further along the pipeline.
  const winnerStatus =
    (STATUS_RANK[winner.status] ?? 0) >= (STATUS_RANK[loser.status] ?? 0)
      ? winner.status
      : loser.status;

  // Approved / vision: prefer non-empty.
  const approved =
    (winner.approved_tags?.length ?? 0) > 0
      ? winner.approved_tags
      : loser.approved_tags;
  const vision =
    (winner.vision_tags?.length ?? 0) > 0
      ? winner.vision_tags
      : loser.vision_tags;

  const mergedVariantSkus = unionArr(winner.variant_skus, loser.variant_skus);
  const mergedShopifyProductIds = unionNumArr(
    winner.shopify_product_ids,
    loser.shopify_product_ids,
  );
  const mergedShopifyProductTypes = unionArr(
    winner.shopify_product_types,
    loser.shopify_product_types,
  );
  const mergedShopifyTags = unionArr(winner.shopify_tags, loser.shopify_tags);
  const mergedImageUrl = winner.image_url ?? loser.image_url ?? null;

  const merged = {
    status: winnerStatus,
    variant_skus: mergedVariantSkus,
    shopify_product_ids: mergedShopifyProductIds,
    shopify_product_types: mergedShopifyProductTypes,
    shopify_tags: mergedShopifyTags,
    approved_tags: approved,
    vision_tags: vision,
    image_url: mergedImageUrl,
  };

  const { error: updErr } = await sb
    .from("designs")
    .update(merged)
    .eq("design_family", winner.design_family);
  if (updErr) throw new Error(`merge update ${winner.design_family}: ${updErr.message}`);

  // Mutate the winner snapshot so that subsequent merges into the same target
  // build on top of this one instead of clobbering it. (Multiple losers per
  // winner happen e.g. when both AFGFxxxx-CG and AFHFxxxx-CG resolve to AFxxxx
  // — the in-memory plan was built before any merges ran.)
  winner.status = winnerStatus;
  winner.variant_skus = mergedVariantSkus;
  winner.shopify_product_ids = mergedShopifyProductIds;
  winner.shopify_product_types = mergedShopifyProductTypes;
  winner.shopify_tags = mergedShopifyTags;
  winner.approved_tags = approved;
  winner.vision_tags = vision;
  winner.image_url = mergedImageUrl;

  // Re-point the loser's events to the winner so the audit trail moves too.
  const { error: evtErr } = await sb
    .from("events")
    .update({ design_family: winner.design_family })
    .eq("design_family", loser.design_family);
  if (evtErr) {
    console.warn(`event re-point ${loser.design_family}: ${evtErr.message}`);
  }

  // Audit the merge itself.
  await sb.from("events").insert({
    design_family: winner.design_family,
    event_type: "merged_duplicate",
    actor: "system",
    payload: {
      merged_from: loser.design_family,
      loser_status: loser.status,
      winner_status_was: winner.status,
      winner_status_now: winnerStatus,
    },
  });

  // Delete the loser row last (after events have been re-pointed).
  const { error: delErr } = await sb
    .from("designs")
    .delete()
    .eq("design_family", loser.design_family);
  if (delErr) throw new Error(`delete loser ${loser.design_family}: ${delErr.message}`);
}

async function applyRename(
  sb: ReturnType<typeof getAdminClient>,
  current: DesignRow,
  canonical: string,
): Promise<void> {
  // `events.design_family` has a FK to `designs.design_family`, so we can't
  // just UPDATE the parent's key while children still reference the old value.
  // Insert a copy at the canonical key first, re-point events, then delete
  // the old row. SELECT * to capture every column (the loader only knows
  // about a subset, so we re-fetch).
  const { data: full, error: selErr } = await sb
    .from("designs")
    .select("*")
    .eq("design_family", current.design_family)
    .single();
  if (selErr || !full)
    throw new Error(`rename re-select ${current.design_family}: ${selErr?.message ?? "no row"}`);

  const copy: Record<string, unknown> = {
    ...(full as Record<string, unknown>),
    design_family: canonical,
  };
  // Strip generated / system-managed columns Supabase won't let us insert.
  delete copy.effective_date;

  const { error: insErr } = await sb.from("designs").insert(copy);
  if (insErr)
    throw new Error(`rename insert ${current.design_family} → ${canonical}: ${insErr.message}`);

  const { error: evtErr } = await sb
    .from("events")
    .update({ design_family: canonical })
    .eq("design_family", current.design_family);
  if (evtErr) {
    console.warn(`event re-point ${current.design_family}: ${evtErr.message}`);
  }

  const { error: delErr } = await sb
    .from("designs")
    .delete()
    .eq("design_family", current.design_family);
  if (delErr)
    throw new Error(`rename delete ${current.design_family}: ${delErr.message}`);

  await sb.from("events").insert({
    design_family: canonical,
    event_type: "renamed_family",
    actor: "system",
    payload: { renamed_from: current.design_family },
  });
}

async function main() {
  const args = parseArgs();
  const sb = getAdminClient();

  console.log("[consolidate] loading AF designs…");
  const designs = await loadAfDesigns(sb);
  console.log(`[consolidate] ${designs.length} AF designs loaded.`);

  const byFamily = new Map<string, DesignRow>(
    designs.map((d) => [d.design_family, d]),
  );

  const merges: Array<{ winner: DesignRow; loser: DesignRow; canonical: string }> = [];
  const renames: Array<{ row: DesignRow; canonical: string }> = [];

  for (const d of designs) {
    const canonical = canonicalFromSkus(d.variant_skus);
    if (!canonical || canonical === d.design_family) continue;
    const target = byFamily.get(canonical);
    if (target) {
      merges.push({ winner: target, loser: d, canonical });
    } else {
      renames.push({ row: d, canonical });
    }
  }

  console.log(`[consolidate] ${merges.length} merges, ${renames.length} renames.`);

  if (merges.length > 0) {
    console.log("\nMerges (loser → winner):");
    for (const m of merges.slice(0, 20)) {
      console.log(
        `  ${m.loser.design_family} (${m.loser.status}) → ${m.winner.design_family} (${m.winner.status})`,
      );
    }
    if (merges.length > 20) console.log(`  …and ${merges.length - 20} more.`);
  }
  if (renames.length > 0) {
    console.log("\nRenames:");
    for (const r of renames.slice(0, 20)) {
      console.log(`  ${r.row.design_family} → ${r.canonical}`);
    }
    if (renames.length > 20) console.log(`  …and ${renames.length - 20} more.`);
  }

  if (!args.apply) {
    console.log("\n[consolidate] DRY-RUN. Re-run with --apply to commit.");
    return;
  }

  console.log("\n[consolidate] applying…");
  let mergeDone = 0;
  for (const m of merges) {
    await applyMerge(sb, m.winner, m.loser);
    mergeDone++;
    if (mergeDone % 25 === 0) console.log(`  merged ${mergeDone}/${merges.length}`);
  }
  console.log(`[consolidate] merged ${mergeDone}/${merges.length}`);

  let renameDone = 0;
  for (const r of renames) {
    await applyRename(sb, r.row, r.canonical);
    renameDone++;
    if (renameDone % 25 === 0)
      console.log(`  renamed ${renameDone}/${renames.length}`);
  }
  console.log(`[consolidate] renamed ${renameDone}/${renames.length}`);

  console.log(
    `\n[consolidate] done. ${mergeDone} merges + ${renameDone} renames written.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
