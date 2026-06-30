/**
 * Auth gate + session refresh.
 *
 * Runs on every request (except static assets). Refreshes the Supabase auth
 * cookie and enforces sign-in:
 *   - Public: /login, /auth/*, and /api/cron/* (cron has its own CRON_SECRET).
 *   - Everything else requires a signed-in @clownantics.com user.
 *     Pages → redirect to /login; API → 401 JSON.
 */
import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

const ALLOWED_DOMAIN = "clownantics.com";

function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/login") ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/cron/")
  );
}

export async function middleware(request: NextRequest) {
  // Feature flag: the gate stays OFF until AUTH_ENABLED=true is set in the
  // environment. This lets the auth code deploy safely BEFORE Google OAuth is
  // configured in Supabase — flip the flag only once sign-in actually works,
  // otherwise the whole app locks out at a non-functional /login.
  if (process.env.AUTH_ENABLED !== "true") {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() (not getSession) so the JWT is validated, and it must
  // run right after client creation to refresh the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const allowed = !!user?.email?.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);

  if (!allowed && !isPublicPath(path)) {
    if (path.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "unauthorized — sign in required" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on everything except Next internals and static image assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
