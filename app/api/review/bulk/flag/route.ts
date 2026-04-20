/**
 * Bulk-flag designs by SKU list. Used by the "Paste SKUs" panel in Tag fixing.
 *
 * Request: POST /api/review/bulk/flag
 *   body: { skus: string[] }
 *
 * SKU matching: we parse each SKU into a design_family via the same parser
 * scripts/import-*.ts use, then dedupe and update status=flagged for each.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { parseSku } from "@/lib/sku-parser";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  let body: { skus?: unknown };
  try {
    body = (await req.json()) as { skus?: unknown };
  } catch {
    return errorResponse(400, "invalid JSON body");
  }
  const rawSkus = Array.isArray(body.skus) ? body.skus.filter((s): s is string => typeof s === "string") : [];
  if (rawSkus.length === 0) return errorResponse(400, "skus[] required");

  // Accept either a variant SKU (AFGFWR0053, AFHFSP0006, AFGFMS0509WH …) or
  // a bare design_family (AFWR0053). Family is what lives in the designs
  // table PK; parseSku covers the variants.
  const families = new Set<string>();
  const unparsed: string[] = [];
  const FAMILY_PATTERN = /^AF[A-Z]{2}\d+$/;
  for (const s of rawSkus) {
    const up = s.trim().toUpperCase();
    if (FAMILY_PATTERN.test(up)) {
      families.add(up);
      continue;
    }
    const parsed = parseSku(s);
    if (!parsed) {
      unparsed.push(s);
      continue;
    }
    families.add(parsed.designFamily);
  }
  if (families.size === 0) {
    return Response.json({ flagged: 0, missing: [], unparsed });
  }

  const sb = getAdminSupabase();

  // Only flag designs that actually exist in the catalog.
  const familyList = Array.from(families);
  const { data: existing, error: selErr } = await sb
    .from("designs")
    .select("design_family")
    .in("design_family", familyList);
  if (selErr) return errorResponse(500, `select: ${selErr.message}`);

  const existingFamilies = new Set(
    (existing || []).map((d) => (d as { design_family: string }).design_family),
  );
  const missing = familyList.filter((f) => !existingFamilies.has(f));
  const toFlag = familyList.filter((f) => existingFamilies.has(f));

  if (toFlag.length === 0) {
    return Response.json({ flagged: 0, missing, unparsed });
  }

  const { error: updateErr } = await sb
    .from("designs")
    .update({ status: "flagged" })
    .in("design_family", toFlag);
  if (updateErr) return errorResponse(500, `update: ${updateErr.message}`);

  // One event per flagged design.
  await sb.from("events").insert(
    toFlag.map((f) => ({
      design_family: f,
      event_type: "flagged",
      actor: "blake",
      payload: { source: "paste_skus" },
    })),
  );

  return Response.json({ flagged: toFlag.length, missing, unparsed });
}

function errorResponse(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
