/**
 * Shopify catalog sync engine (MANUAL only — NOT scheduled).
 *
 * Pulls the current Shopify catalog into Supabase. This route is the sync
 * engine; it is triggered on demand by the Settings "↻ Sync now" button
 * (via /api/sync/shopify, which forwards here with the CRON_SECRET). There is
 * deliberately NO cron entry for it in vercel.json — catalog import is a
 * manual process by design.
 *
 * Mirrors the apply-path of `scripts/shopify-pull.ts` (the CLI keeps its
 * dry-run + CSV writing on top). Any meaningful change to the sync logic
 * should land in both places until we factor a shared `lib/shopify-sync.ts`.
 *
 * Auth: requests must include `Authorization: Bearer $CRON_SECRET`; the
 * /api/sync/shopify proxy adds it server-side. Requests without it return 401.
 *
 * Response: JSON summary
 *   { ok, productsSeen, productsMatched, families, inserted, updated,
 *     excluded, orphansFound, orphansSkippedSafety, durationMs }
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { listProducts, productToFamily } from "@/lib/shopify";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — sync runs about 3 min on a full catalog

interface Aggregated {
  design_family: string;
  design_name: string;
  manufacturer: string;
  tags: Set<string>;
  productIds: Set<number>;
  productTypes: Set<string>;
  variantSkus: Set<string>;
  imageUrl: string | null;
}

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = req.headers.get("authorization") ?? "";
  return got === `Bearer ${secret}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  return run(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return run(req);
}

async function run(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) {
    return new Response(
      JSON.stringify({ error: "unauthorized — set CRON_SECRET header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) {
    return errorJson(500, "Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");
  }
  const sb = getAdminSupabase();
  const startedAt = Date.now();

  // ─── 1. Stream Shopify, build byFamily ──────────────────────────────
  const byFamily = new Map<string, Aggregated>();
  let productsSeen = 0;
  let productsMatched = 0;
  for await (const p of listProducts()) {
    productsSeen++;
    const resolved = productToFamily(p);
    if (!resolved) continue;
    productsMatched++;
    const tags = (p.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const pt = (p.product_type ?? "").trim();
    const skus = (p.variants ?? [])
      .map((v) => (v.sku ?? "").trim())
      .filter(Boolean);
    const img = p.image?.src ?? null;
    const existing = byFamily.get(resolved.design_family);
    if (existing) {
      for (const t of tags) existing.tags.add(t);
      existing.productIds.add(p.id);
      if (pt) existing.productTypes.add(pt);
      for (const s of skus) existing.variantSkus.add(s);
      if (!existing.imageUrl && img) existing.imageUrl = img;
    } else {
      byFamily.set(resolved.design_family, {
        design_family: resolved.design_family,
        design_name: p.title,
        manufacturer: resolved.manufacturer,
        tags: new Set(tags),
        productIds: new Set([p.id]),
        productTypes: pt ? new Set([pt]) : new Set(),
        variantSkus: new Set(skus),
        imageUrl: img,
      });
    }
  }

  // ─── 2. Load current DB state for matched families ──────────────────
  const families = [...byFamily.keys()];
  const currentTags = new Map<string, string[]>();
  const existingFamilies = new Set<string>();
  const existingProductIds = new Map<string, number[]>();
  const existingProductTypes = new Map<string, string[]>();
  const existingVariantSkus = new Map<string, string[]>();
  const existingImageUrl = new Map<string, string | null>();
  const chunk = 500;
  for (let i = 0; i < families.length; i += chunk) {
    const slice = families.slice(i, i + chunk);
    const { data, error } = await sb
      .from("designs")
      .select(
        "design_family,shopify_tags,shopify_product_ids,shopify_product_types,variant_skus,image_url",
      )
      .in("design_family", slice);
    if (error) return errorJson(500, `select: ${error.message}`);
    for (const r of data ?? []) {
      const row = r as {
        design_family: string;
        shopify_tags: string[] | null;
        shopify_product_ids: number[] | null;
        shopify_product_types: string[] | null;
        variant_skus: string[] | null;
        image_url: string | null;
      };
      existingFamilies.add(row.design_family);
      currentTags.set(row.design_family, row.shopify_tags ?? []);
      existingProductIds.set(
        row.design_family,
        (row.shopify_product_ids ?? []).slice().sort((a, b) => a - b),
      );
      existingProductTypes.set(
        row.design_family,
        (row.shopify_product_types ?? []).slice().sort(),
      );
      existingVariantSkus.set(
        row.design_family,
        (row.variant_skus ?? []).slice().sort(),
      );
      existingImageUrl.set(row.design_family, row.image_url ?? null);
    }
  }

  // ─── 3. Build diff rows ─────────────────────────────────────────────
  interface DiffRow {
    is_new: boolean;
    design_family: string;
    design_name: string;
    manufacturer: string;
    productIds: number[];
    productTypes: string[];
    variantSkus: string[];
    imageUrl: string | null;
    before: string[];
    after: string[];
    changed: boolean;
  }
  const diffs: DiffRow[] = [];
  for (const agg of byFamily.values()) {
    const after = [...agg.tags].sort();
    const before = (currentTags.get(agg.design_family) ?? []).slice().sort();
    const changed =
      before.length !== after.length || before.some((b, i) => b !== after[i]);
    diffs.push({
      is_new: !existingFamilies.has(agg.design_family),
      design_family: agg.design_family,
      design_name: agg.design_name,
      manufacturer: agg.manufacturer,
      productIds: [...agg.productIds].sort((a, b) => a - b),
      productTypes: [...agg.productTypes].sort(),
      variantSkus: [...agg.variantSkus].sort(),
      imageUrl: agg.imageUrl,
      before,
      after,
      changed,
    });
  }

  // ─── 4. Inserts (new families) ──────────────────────────────────────
  const inserts = diffs
    .filter((d) => d.is_new)
    .map((d) => ({
      design_family: d.design_family,
      design_name: d.design_name,
      manufacturer: d.manufacturer,
      status: "novision",
      shopify_tags: d.after,
      shopify_product_ids: d.productIds,
      shopify_product_types: d.productTypes,
      variant_skus: d.variantSkus,
      image_url: d.imageUrl,
      // first_seen_at takes the column default (now()) on insert; no need
      // to set explicitly.
    }));
  if (inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += 200) {
      const batch = inserts.slice(i, i + 200);
      const { error } = await sb.from("designs").insert(batch);
      if (error) return errorJson(500, `insert batch at ${i}: ${error.message}`);
    }
  }

  // ─── 5. Updates (tag / product-id / image drift) ────────────────────
  const arrayDiff = (a: string[], b: string[]) =>
    a.length !== b.length || a.some((v, i) => v !== b[i]);
  const updates = diffs.filter((d) => {
    if (d.is_new) return false;
    if (d.changed) return true;
    const curIds = existingProductIds.get(d.design_family) ?? [];
    if (curIds.length !== d.productIds.length) return true;
    if (curIds.some((id, i) => id !== d.productIds[i])) return true;
    const curTypes = existingProductTypes.get(d.design_family) ?? [];
    if (arrayDiff(curTypes, d.productTypes)) return true;
    const curSkus = existingVariantSkus.get(d.design_family) ?? [];
    if (arrayDiff(curSkus, d.variantSkus)) return true;
    const curImg = existingImageUrl.get(d.design_family) ?? null;
    return curImg !== d.imageUrl;
  });
  for (const u of updates) {
    // Same retry-with-backoff pattern as the CLI; flaky Supabase shouldn't
    // abandon mid-sync.
    let lastErr: unknown = null;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const { error } = await sb
        .from("designs")
        .update({
          shopify_tags: u.after,
          shopify_product_ids: u.productIds,
          shopify_product_types: u.productTypes,
          variant_skus: u.variantSkus,
          image_url: u.imageUrl,
        })
        .eq("design_family", u.design_family);
      if (error) {
        lastErr = error;
        await sleep(500 * Math.pow(3, attempt));
      } else {
        ok = true;
      }
    }
    if (!ok) {
      const msg = (lastErr as { message?: string } | null)?.message ?? String(lastErr);
      return errorJson(500, `update ${u.design_family}: ${msg}`);
    }
  }

  // ─── 6. Orphan detection + auto-exclude ─────────────────────────────
  // Same safety rails as the CLI script: skip if pull too small, cap at
  // 5% of catalog to prevent runaway exclusion.
  const SAFE_MIN_FAMILIES = 1000;
  let orphansFound = 0;
  let orphansExcluded = 0;
  let orphansSkippedSafety: string | null = null;
  if (byFamily.size >= SAFE_MIN_FAMILIES) {
    const currentShopifyIds = new Set<number>();
    for (const agg of byFamily.values())
      for (const id of agg.productIds) currentShopifyIds.add(id);

    const orphans: Array<{ design_family: string; lost_product_ids: number[]; status: string }> = [];
    const PAGE2 = 1000;
    for (let offset = 0; ; offset += PAGE2) {
      const { data, error } = await sb
        .from("designs")
        .select("design_family,shopify_product_ids,status")
        .neq("status", "excluded")
        .not("shopify_product_ids", "is", null)
        .order("design_family")
        .range(offset, offset + PAGE2 - 1);
      if (error) return errorJson(500, `orphan scan: ${error.message}`);
      const rows = (data ?? []) as Array<{
        design_family: string;
        shopify_product_ids: number[] | null;
        status: string;
      }>;
      for (const r of rows) {
        const ids = r.shopify_product_ids ?? [];
        if (ids.length === 0) continue;
        if (ids.every((id) => !currentShopifyIds.has(id))) {
          orphans.push({
            design_family: r.design_family,
            lost_product_ids: ids,
            status: r.status,
          });
        }
      }
      if (rows.length < PAGE2) break;
    }
    orphansFound = orphans.length;

    const cap = Math.max(50, Math.floor(byFamily.size * 0.05));
    if (orphansFound > cap) {
      orphansSkippedSafety = `${orphansFound} orphans exceeds safety cap of ${cap} (5% of ${byFamily.size}); investigate manually`;
    } else {
      for (const o of orphans) {
        const { error: updErr } = await sb
          .from("designs")
          .update({ status: "excluded" })
          .eq("design_family", o.design_family);
        if (updErr) continue;
        await sb.from("events").insert({
          design_family: o.design_family,
          event_type: "excluded",
          actor: "system",
          payload: {
            reason: "shopify_deleted",
            from_status: o.status,
            lost_product_ids: o.lost_product_ids,
          },
        });
        orphansExcluded++;
      }
    }
  } else {
    orphansSkippedSafety = `only ${byFamily.size} families found; below safety threshold (${SAFE_MIN_FAMILIES})`;
  }

  // ─── 7. Write a sync_log row so the UI can show "last synced X ago" ──
  // Best-effort; don't fail the cron if the log insert errors (table may
  // not exist yet on older deployments).
  try {
    await sb.from("shopify_sync_log").insert({
      finished_at: new Date().toISOString(),
      products_seen: productsSeen,
      products_matched: productsMatched,
      families: byFamily.size,
      inserted: inserts.length,
      updated: updates.length,
      excluded: orphansExcluded,
      orphans_found: orphansFound,
      orphans_skipped_safety: orphansSkippedSafety,
      duration_ms: Date.now() - startedAt,
      trigger: req.headers.get("user-agent")?.includes("vercel-cron") ? "cron" : "manual",
    });
  } catch {
    // ignore — log table is optional
  }

  return Response.json({
    ok: true,
    productsSeen,
    productsMatched,
    families: byFamily.size,
    inserted: inserts.length,
    updated: updates.length,
    excluded: orphansExcluded,
    orphansFound,
    orphansSkippedSafety,
    durationMs: Date.now() - startedAt,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorJson(status: number, msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
