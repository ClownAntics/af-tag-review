"use client";

/**
 * Bottom-corner auto-dismissing toast. Used for "Pushed N designs" feedback
 * after a Shopify push (per Q20 — toast on push only, not on per-design
 * approve). Single instance pattern: a parent component owns the message
 * state and renders <Toast> when it has something to say.
 */
import { useEffect } from "react";

interface Props {
  message: string | null;
  variant?: "info" | "success" | "error";
  onDismiss: () => void;
  /** Auto-dismiss after this many ms. 0 = stay until clicked. */
  autoMs?: number;
}

const COLORS: Record<NonNullable<Props["variant"]>, string> = {
  info: "bg-zinc-900 text-white",
  success: "bg-[#0F6E56] text-white",
  error: "bg-[#A32D2D] text-white",
};

export function Toast({ message, variant = "info", onDismiss, autoMs = 5000 }: Props) {
  useEffect(() => {
    if (!message || autoMs <= 0) return;
    const t = setTimeout(onDismiss, autoMs);
    return () => clearTimeout(t);
  }, [message, autoMs, onDismiss]);

  if (!message) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50">
      <div
        className={`${COLORS[variant]} px-4 py-2.5 rounded-md shadow-lg text-sm flex items-center gap-3 max-w-md`}
        role="status"
        aria-live="polite"
      >
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-white/70 hover:text-white text-base leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
