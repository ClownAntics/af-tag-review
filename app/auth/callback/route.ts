/**
 * OAuth callback: exchange the Google auth code for a session, then HARD-
 * enforce the @clownantics.com domain (the `hd` hint on the client is only a
 * suggestion). Non-clownantics accounts are signed out and bounced back to
 * /login with an error.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ALLOWED_EMAIL_DOMAIN } from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const ok = user?.email?.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
  if (!ok) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  return NextResponse.redirect(`${origin}${next.startsWith("/") ? next : "/"}`);
}
