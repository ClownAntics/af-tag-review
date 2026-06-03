/**
 * Browser-facing manual sync trigger. The actual sync logic lives behind
 * `/api/cron/shopify-sync` (which is CRON_SECRET-protected so the public
 * internet can't trigger a Shopify rate-limit hit). This route is the
 * thin browser proxy: it adds the secret server-side and forwards the
 * call. The browser only needs a normal `fetch('/api/sync/shopify',
 * { method: 'POST' })` — no auth to plumb client-side.
 *
 * Matches the trust posture of the rest of the app (the push route,
 * exclude, etc. are all anon-callable too — pre-auth single-tenant MVP).
 *
 * Response: passes through whatever the cron route returned.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return errorJson(
      500,
      "CRON_SECRET not set in environment — manual sync cannot reach the cron endpoint.",
    );
  }

  // Forward to the cron route on the same origin. Vercel's same-origin
  // calls resolve internally; locally this hits the dev server.
  const proto = req.nextUrl.protocol;
  const host = req.headers.get("host");
  const target = `${proto}//${host}/api/cron/shopify-sync`;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        // Marker so the cron route can record `trigger: 'manual'` in the
        // sync log instead of 'cron'.
        "User-Agent": "manual-sync-button",
      },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return errorJson(500, `forward to cron route failed: ${(e as Error).message}`);
  }
}

function errorJson(status: number, msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
