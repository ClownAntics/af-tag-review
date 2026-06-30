/**
 * Tiny fixed top-right widget showing the signed-in user + a sign-out button.
 * Server component — reads the session via cookies. Renders nothing when
 * there's no user (e.g. the /login page).
 */
import { getCurrentUser } from "@/lib/auth";

export async function AuthBar() {
  const user = await getCurrentUser();
  if (!user?.email) return null;

  return (
    <div className="fixed top-2 right-3 z-40 flex items-center gap-2 text-xs text-muted">
      <span className="font-mono" title={user.email}>
        {user.email}
      </span>
      <span className="text-muted-2">·</span>
      <form action="/auth/signout" method="post">
        <button
          type="submit"
          className="hover:text-foreground hover:underline"
          title="Sign out"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
