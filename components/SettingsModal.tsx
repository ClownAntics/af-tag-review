"use client";

/**
 * Project-level Settings modal. Accessible from the header "Settings" link.
 *
 * Currently hosts one section:
 *   - Sync from Shopify → "Reset everything and re-pull from Shopify"
 *     button. Hits `/api/review/reset-all`, streams NDJSON progress,
 *     surfaces a toast when done. Requires typing RESET to confirm.
 *
 * Additional settings (auth, roles, vendor visibility, scheduled pulls…)
 * should land here as their own sections rather than scattering across
 * other modals.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful reset so the parent can refresh counts / queues. */
  onResetComplete?: () => void;
}

interface Progress {
  total?: number;
  productsSeen?: number;
  familiesUpdated?: number;
  tagChanges?: number;
  dbReset?: boolean;
  pullDone?: boolean;
  done?: boolean;
  error?: string | null;
}

export function SettingsModal({ open, onClose, onResetComplete }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [totalDesigns, setTotalDesigns] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Lightweight count fetch so the warning text shows the real catalog size.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/review/counts")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then(
        (d: {
          flagged: number;
          pending: number;
          readytosend: number;
          updated: number;
          novision: number;
        }) => {
          if (cancelled) return;
          setTotalDesigns(
            d.flagged + d.pending + d.readytosend + d.updated + d.novision,
          );
        },
      )
      .catch(() => {
        if (!cancelled) setTotalDesigns(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset dialog state every time the modal is reopened.
  useEffect(() => {
    if (!open) {
      setConfirmText("");
      setProgress(null);
      setRunning(false);
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  const runReset = useCallback(async () => {
    if (confirmText !== "RESET" || running) return;
    setRunning(true);
    setProgress({});
    abortRef.current = new AbortController();
    try {
      const res = await fetch("/api/review/reset-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
        signal: abortRef.current.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text();
        throw new Error(`${res.status}: ${txt.slice(0, 400)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as {
              type: string;
              total?: number;
              reset_count?: number;
              products_seen?: number;
              families_updated?: number;
              tag_changes?: number;
              error?: string;
            };
            setProgress((p) => {
              const next: Progress = { ...(p ?? {}) };
              if (evt.type === "start" && typeof evt.total === "number") {
                next.total = evt.total;
              } else if (evt.type === "db_reset") {
                next.dbReset = true;
              } else if (evt.type === "progress") {
                if (typeof evt.products_seen === "number") next.productsSeen = evt.products_seen;
                if (typeof evt.families_updated === "number") next.familiesUpdated = evt.families_updated;
                if (typeof evt.tag_changes === "number") next.tagChanges = evt.tag_changes;
              } else if (evt.type === "shopify_pulled") {
                next.pullDone = true;
                if (typeof evt.products_seen === "number") next.productsSeen = evt.products_seen;
                if (typeof evt.families_updated === "number") next.familiesUpdated = evt.families_updated;
              } else if (evt.type === "done") {
                next.done = true;
                if (typeof evt.tag_changes === "number") next.tagChanges = evt.tag_changes;
              } else if (evt.type === "error") {
                next.error = evt.error ?? "unknown error";
              }
              return next;
            });
          } catch {
            // Skip malformed NDJSON lines.
          }
        }
      }
    } catch (e) {
      setProgress((p) => ({ ...(p ?? {}), error: (e as Error).message }));
    } finally {
      setRunning(false);
      onResetComplete?.();
    }
  }, [confirmText, running, onResetComplete]);

  if (!open) return null;

  const canConfirm = confirmText === "RESET" && !running;
  const p = progress;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mt-16 border border-border">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-border">
          <div>
            <h2 id="settings-title" className="text-lg font-medium">
              Settings
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Project-level controls. Audit history is always preserved.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-muted hover:text-foreground text-xl leading-none disabled:opacity-40"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Sync from Shopify</h3>
            <p className="text-xs text-muted">
              This will move{" "}
              <strong className="text-foreground">
                {totalDesigns?.toLocaleString() ?? "all"}
              </strong>{" "}
              design{totalDesigns === 1 ? "" : "s"} back to <em>No vision yet</em> and
              re-pull current Shopify tags. History is preserved. In-flight work
              (Flagged, Pending, Ready to send) will be lost.
            </p>

            {!running && !p?.done && !p?.error && (
              <div className="space-y-2">
                <label className="block text-xs font-medium">
                  Type <code className="px-1 py-0.5 bg-zinc-100 rounded text-[11px]">RESET</code>{" "}
                  to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="RESET"
                  className="w-full px-3 py-2 text-sm border border-border rounded-md font-mono focus:outline-none focus:ring-2 focus:ring-[#A32D2D]/30"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={runReset}
                  disabled={!canConfirm}
                  className="w-full text-sm px-3.5 py-2 rounded-md bg-[#A32D2D] text-white hover:bg-[#8B2020] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Reset everything and re-pull from Shopify
                </button>
              </div>
            )}

            {running && p && (
              <div className="space-y-2 text-xs">
                <ProgressLine
                  label="DB reset"
                  done={!!p.dbReset}
                  detail={p.total ? `${p.total.toLocaleString()} designs back to No vision` : undefined}
                />
                <ProgressLine
                  label="Shopify pull"
                  done={!!p.pullDone}
                  detail={
                    p.productsSeen
                      ? `${p.productsSeen.toLocaleString()} products seen${p.familiesUpdated ? ` · ${p.familiesUpdated.toLocaleString()} families updated` : ""}`
                      : "streaming…"
                  }
                />
                <ProgressLine
                  label="Done"
                  done={!!p.done}
                  detail={p.done ? `${(p.tagChanges ?? 0).toLocaleString()} tag refs written` : ""}
                />
              </div>
            )}

            {!running && p?.done && (
              <div className="text-xs bg-[#E8F5EE] border border-[#0F6E56]/30 text-[#0F6E56] px-3 py-2 rounded-md">
                ✓ Reset complete — {p.total?.toLocaleString() ?? "all"} designs back in No vision yet.
                {p.tagChanges ? ` ${p.tagChanges.toLocaleString()} tag refs refreshed.` : ""}
              </div>
            )}

            {!running && p?.error && (
              <div className="text-xs bg-[#FDECEC] border border-[#A32D2D]/30 text-[#A32D2D] px-3 py-2 rounded-md">
                ✗ Reset failed: {p.error}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProgressLine({
  label,
  done,
  detail,
}: {
  label: string;
  done: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] leading-none ${
          done ? "bg-[#0F6E56] text-white" : "bg-[#FAEEDA] text-[#BA7517]"
        }`}
      >
        {done ? "✓" : "…"}
      </span>
      <span className="font-medium">{label}</span>
      {detail && <span className="text-muted">— {detail}</span>}
    </div>
  );
}
