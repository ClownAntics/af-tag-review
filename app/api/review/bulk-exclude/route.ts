/**
 * Bulk-exclude accessory-shaped designs in one shot.
 *
 *   GET  /api/review/bulk-exclude   → preview { count, sample[] }
 *   POST /api/review/bulk-exclude   → apply. Body: { confirm: "EXCLUDE" }
 *
 * Scope: every design with `status != 'excluded'` whose
 * `shopify_product_types` matches the conservative accessory rule in
 * `lib/accessory-rules.ts`. Each excluded design gets a `bulk_excluded`
 * event row with the offending product_types in the payload, so it's
 * undoable from the Excluded tile (per-card ↩ Include) and recoverable
 * from the audit log.
 *
 * The actual match must run client-side here because the rule uses a JS
 * regex that doesn't map cleanly to PostgREST. Paginated select → in-memory
 * filter → batched UPDATEs.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { isAccessoryFamily } from "@/lib/accessory-rules";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACTOR = "blake";

interface Row {
  design_family: string;
  design_name: string | null;
  status: string;
  shopify_product_types: string[] | null;
}

async function loadCandidates(): Promise<Row[]> {
  const sb = getAdminSupabase();
  const out: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,status,shopify_product_types")
      .neq("status", "excluded")
      .order("design_family")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.filter((r) => isAccessoryFamily(r.shopify_product_types));
}

export async function GET(): Promise<Response> {
  let rows: Row[];
  try {
    rows = await loadCandidates();
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }
  const sample = rows.slice(0, 10).map((r) => ({
    design_family: r.design_family,
    design_name: r.design_name,
    shopify_product_types: r.shopify_product_types ?? [],
  }));
  return Response.json({ count: rows.length, sample });
}

export async function POST(req: Request): Promise<Response> {
  let body: { confirm?: unknown } | null = null;
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    return errorJson(400, "invalid JSON body");
  }
  if (body?.confirm !== "EXCLUDE") {
    return errorJson(
      400,
      'missing confirm token — body must be {"confirm":"EXCLUDE"}',
    );
  }

  let rows: Row[];
  try {
    rows = await loadCandidates();
  } catch (e) {
    return errorJson(500, (e as Error).message);
  }

  if (rows.length === 0) {
    return Response.json({ excluded: 0, message: "Nothing to exclude." });
  }

  const sb = getAdminSupabase();
  const families = rows.map((r) => r.design_family);

  // Update all matching rows in one go with `.in()`. Postgres handles big IN
  // lists fine up to several thousand; if we ever cross 10k+ this should
  // chunk, but the catalog isn't there.
  const { error: updErr } = await sb
    .from("designs")
    .update({ status: "excluded" })
    .in("design_family", families);
  if (updErr) return errorJson(500, `update: ${updErr.message}`);

  // Audit event per family. Captures both the prior status and the
  // product_types that triggered the exclusion so the action is reviewable
  // and per-design reversible from the Excluded tile.
  const eventRows = rows.map((r) => ({
    design_family: r.design_family,
    event_type: "bulk_excluded",
    actor: ACTOR,
    payload: {
      from_status: r.status,
      reason: "matches accessory_rules",
      product_types: r.shopify_product_types ?? [],
    },
  }));
  for (let i = 0; i < eventRows.length; i += 500) {
    const batch = eventRows.slice(i, i + 500);
    const { error: evtErr } = await sb.from("events").insert(batch);
    if (evtErr) console.warn(`bulk_excluded event batch ${i}: ${evtErr.message}`);
  }

  return Response.json({ excluded: rows.length });
}

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
