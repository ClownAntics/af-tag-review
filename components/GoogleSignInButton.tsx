"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useState } from "react";

export function GoogleSignInButton({ next }: { next?: string }) {
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    const callback = new URL("/auth/callback", window.location.origin);
    if (next) callback.searchParams.set("next", next);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback.toString(),
        // Hint Google to surface @clownantics.com accounts (the callback
        // hard-enforces the domain regardless).
        queryParams: { hd: "clownantics.com", prompt: "select_account" },
      },
    });
    if (error) {
      setLoading(false);
      alert(`Sign-in failed: ${error.message}`);
    }
    // On success the browser redirects to Google; no further work here.
  };

  return (
    <button
      type="button"
      onClick={signIn}
      disabled={loading}
      className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-md border border-border bg-white hover:bg-zinc-50 text-sm font-medium disabled:opacity-60"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
        <path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3-2.33z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
      </svg>
      {loading ? "Redirecting…" : "Sign in with Google"}
    </button>
  );
}
