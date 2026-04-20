"use client";

/**
 * Paste-SKUs panel. Accepts any delimiter (comma/space/newline/tab/semicolon),
 * shows live "N SKUs found" as the user types, and bulk-flags them on submit.
 */
import { useMemo, useState } from "react";

interface Props {
  onFlagged: () => void;
}

export function PasteSkusPanel({ onFlagged }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { flagged: number; missing: string[]; unparsed: string[] }
    | { error: string }
    | null
  >(null);

  const skus = useMemo(
    () =>
      text
        .split(/[\s,;\t\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  );

  const submit = async () => {
    if (skus.length === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await fetch("/api/review/bulk/flag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus }),
      });
      if (!r.ok) throw new Error(await r.text());
      const d = (await r.json()) as {
        flagged: number;
        missing: string[];
        unparsed: string[];
      };
      setResult(d);
      if (d.flagged > 0) {
        setText("");
        onFlagged();
      }
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex justify-end mb-3">
      <div className="w-full">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
          >
            📋 Paste SKUs
          </button>
        </div>
        {open && (
          <div className="bg-[#f4f4f5] rounded-lg p-4 mt-2">
            <div className="flex justify-between items-center mb-2">
              <p className="text-[13px] font-medium">Paste SKUs to flag</p>
              <span className="text-[11px] text-muted-2">
                Any format — comma, space, newline
              </span>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="AFGFMS0278, AFGFMS0509&#10;AFHFSP0006 AFGFWI0142"
              className="w-full min-h-[80px] font-mono text-xs p-2.5 border border-border rounded-md bg-white focus:outline-none focus:border-zinc-400"
            />
            <div className="flex justify-between items-center mt-2.5 text-xs text-muted">
              <span>
                <strong className="text-foreground font-medium">
                  {skus.length}
                </strong>{" "}
                SKU{skus.length === 1 ? "" : "s"} found
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setText("");
                    setResult(null);
                  }}
                  className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={skus.length === 0 || submitting}
                  className="text-xs px-3 py-1.5 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800 disabled:opacity-60"
                >
                  {submitting ? "Flagging…" : skus.length > 0 ? `Flag ${skus.length} designs →` : "Flag SKUs →"}
                </button>
              </div>
            </div>
            {result && "error" in result && (
              <p className="text-xs text-[#A32D2D] mt-2">Error: {result.error}</p>
            )}
            {result && "flagged" in result && (
              <div className="text-xs text-muted mt-2 space-y-0.5">
                <p>
                  <strong className="text-[#0F6E56]">{result.flagged}</strong> flagged successfully.
                </p>
                {result.missing.length > 0 && (
                  <p>
                    <strong>{result.missing.length}</strong> not in catalog: {result.missing.slice(0, 5).join(", ")}
                    {result.missing.length > 5 && "…"}
                  </p>
                )}
                {result.unparsed.length > 0 && (
                  <p>
                    <strong>{result.unparsed.length}</strong> unparsed: {result.unparsed.slice(0, 5).join(", ")}
                    {result.unparsed.length > 5 && "…"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
