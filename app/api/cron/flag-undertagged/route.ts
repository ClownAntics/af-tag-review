/**
 * Nightly cron: flag under-tagged designs for re-review.
 *
 * Flags every updated/readytosend/pending design whose approved_tags carry
 * ≤1 *real theme* tag (the 13 feature/material facets don't count). Catches
 * designs that ended up with only facet tags — no browsable theme. The rule
 * itself lives in lib/flag-undertagged.ts and is shared with the CLI
 * (scripts/flag-undertagged.ts) so the two can't drift.
 *
 * Idempotent: once flagged a design leaves the scoped statuses, so it isn't
 * re-flagged on the next run and no duplicate events accumulate.
 *
 * Auth: Vercel cron sends `Authorization: Bearer $CRON_SECRET` (same as
 * /api/cron/shopify-sync). Requests without the secret return 401.
 *
 * Schedule: vercel.json → 7:30am UTC (3:30am ET), just after the shopify
 * sync at 7:00am UTC.
 */
import type { NextRequest } from "next/server";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { flagUndertagged } from "@/lib/flag-undertagged";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
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
      JSON.stringify({ ok: false, error: "unauthorized — set CRON_SECRET header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  const startedAt = Date.now();
  try {
    const res = await flagUndertagged(getAdminSupabase(), {
      notion: "content",
      apply: true,
      actor: "system",
    });
    return Response.json({ ok: true, ...res, durationMs: Date.now() - startedAt });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
