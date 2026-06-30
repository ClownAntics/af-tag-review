/**
 * Auth helpers for route handlers + server components.
 *
 * `getActor()` returns the signed-in user's email to stamp on events (the
 * `actor` column), replacing the old hardcoded "blake". Falls back to
 * "system" if there's no session (shouldn't happen behind the middleware
 * gate, but keeps event writes from failing).
 */
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const ALLOWED_EMAIL_DOMAIN = "clownantics.com";

export async function getCurrentUser() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

/** Email of the signed-in user, for the events.actor column. */
export async function getActor(): Promise<string> {
  const user = await getCurrentUser();
  return user?.email ?? "system";
}
