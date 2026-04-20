"use client";

/**
 * Edit the Claude-vision prompt template.
 *
 * Loads the current prompt from /api/review/vision/prompt, lets the user edit
 * in a monospace textarea, saves a new version on Save. Reset blanks the
 * current flag so GET falls back to DEFAULT_PROMPT (no destruction).
 */
import { useEffect, useState } from "react";
import { DEFAULT_PROMPT } from "@/lib/vision-prompt";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

interface FetchedPrompt {
  is_default: boolean;
  version?: number;
  prompt?: string;
  created_at?: string;
  created_by?: string;
}

export function VisionPromptModal({ open, onClose, onSaved }: Props) {
  const [loaded, setLoaded] = useState<FetchedPrompt | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    fetch("/api/review/vision/prompt")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: FetchedPrompt) => {
        if (cancelled) return;
        setLoaded(d);
        setDraft(d.is_default ? DEFAULT_PROMPT : d.prompt || DEFAULT_PROMPT);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/review/vision/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: draft }),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm("Reset to default prompt? The current version will be kept in history but deactivated.")) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/review/vision/prompt", { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      setDraft(DEFAULT_PROMPT);
      setLoaded({ is_default: true });
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[15px] font-medium leading-tight">Vision prompt</h3>
            <p className="text-xs text-muted mt-0.5">
              Instructions Claude uses when analyzing each flag image.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xl text-muted leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          <label className="text-xs font-medium text-zinc-600 block mb-1.5">
            Prompt template
          </label>
          <p className="text-[11px] text-muted-2 mb-2">
            Use <code className="font-mono bg-zinc-100 px-1 rounded">{`{{taxonomy}}`}</code>{" "}
            to inject the full FL Themes list at runtime.
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={loaded === null || saving}
            className="w-full min-h-[280px] font-mono text-xs p-3 border border-border rounded-md bg-zinc-50 focus:bg-white focus:border-zinc-400 focus:outline-none disabled:opacity-60"
          />
          {error && (
            <p className="text-xs text-[#A32D2D] mt-2">Error: {error}</p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2.5">
          <span className="text-[11px] text-muted-2">
            {loaded === null
              ? "Loading…"
              : loaded.is_default
                ? "Using default prompt (nothing saved yet)"
                : `Version ${loaded.version} · saved ${loaded.created_at ? new Date(loaded.created_at).toLocaleString() : "?"}`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={saving || loaded?.is_default}
              className="text-sm px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-50"
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || draft.trim().length === 0}
              className="text-sm px-3 py-1.5 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
