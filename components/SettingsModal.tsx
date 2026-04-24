"use client";

/**
 * Project-level Settings modal. Accessible from the header "Settings" link.
 *
 * Sections:
 *   - Taxonomy (FL Themes) — connection status + "Refresh from TeamDesk"
 *     button. Calls `/api/taxonomy/status` on open and `/api/taxonomy/refresh`
 *     on click. Ships in stub mode until `TEAMDESK_API_TOKEN` is provisioned.
 *   - Sync from Shopify — "Reset everything and re-pull from Shopify" button.
 *     Streams NDJSON progress from `/api/review/reset-all`. Requires typing
 *     RESET to confirm.
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

interface TaxonomyStatus {
  total: number;
  level_1: number;
  level_2: number;
  level_3: number;
  api_connected: boolean;
  source_url: string | null;
  last_synced_at: string | null;
}

interface TaxonomyDiffSummary {
  added: { id: number; label: string }[];
  removed: { id: number; label: string }[];
  renamed: { id: number; from_label: string; to_label: string }[];
  unchanged_count: number;
  safe_to_apply_silently: boolean;
}

type TaxonomyRefreshState =
  | { kind: "idle" }
  | { kind: "planning" }
  | { kind: "not-configured"; message: string }
  | { kind: "error"; message: string }
  | { kind: "confirm"; diff: TaxonomyDiffSummary }
  | { kind: "applying" }
  | { kind: "applied"; summary: string };

export function SettingsModal({ open, onClose, onResetComplete }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [totalDesigns, setTotalDesigns] = useState<number | null>(null);
  const [taxonomyStatus, setTaxonomyStatus] = useState<TaxonomyStatus | null>(null);
  const [taxonomyState, setTaxonomyState] = useState<TaxonomyRefreshState>({ kind: "idle" });
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
      setTaxonomyState({ kind: "idle" });
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  // Load taxonomy status whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/taxonomy/status")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: TaxonomyStatus) => {
        if (!cancelled) setTaxonomyStatus(d);
      })
      .catch(() => {
        if (!cancelled) setTaxonomyStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const planTaxonomyRefresh = useCallback(async () => {
    setTaxonomyState({ kind: "planning" });
    try {
      const r = await fetch("/api/taxonomy/refresh?phase=plan", { method: "POST" });
      if (r.status === 503) {
        const body = await r.json();
        setTaxonomyState({
          kind: "not-configured",
          message: body.message ?? "TeamDesk not configured",
        });
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText }));
        setTaxonomyState({ kind: "error", message: body.error ?? `HTTP ${r.status}` });
        return;
      }
      const body = (await r.json()) as { diff: TaxonomyDiffSummary };
      setTaxonomyState({ kind: "confirm", diff: body.diff });
    } catch (e) {
      setTaxonomyState({ kind: "error", message: (e as Error).message });
    }
  }, []);

  const applyTaxonomyRefresh = useCallback(async () => {
    setTaxonomyState({ kind: "applying" });
    try {
      const r = await fetch("/api/taxonomy/refresh?phase=apply", { method: "POST" });
      if (r.status === 501 || r.status === 503) {
        const body = await r.json();
        setTaxonomyState({
          kind: "not-configured",
          message: body.message ?? body.error ?? "apply not available",
        });
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: r.statusText }));
        setTaxonomyState({ kind: "error", message: body.error ?? `HTTP ${r.status}` });
        return;
      }
      const body = (await r.json()) as { summary?: string };
      setTaxonomyState({ kind: "applied", summary: body.summary ?? "refreshed" });
    } catch (e) {
      setTaxonomyState({ kind: "error", message: (e as Error).message });
    }
  }, []);

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

        <div className="px-6 py-5 space-y-6">
          {/* ─── Taxonomy (FL Themes) ──────────────────────────────────── */}
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">Taxonomy (FL Themes)</h3>
              <p className="text-xs text-muted mt-0.5">
                Read-only source for all approved tags. Edits happen in TeamDesk.
              </p>
            </div>

            <div className="rounded-md border border-border bg-zinc-50 px-3 py-2.5 text-xs space-y-1">
              <InfoRow label="Source">
                {taxonomyStatus?.source_url ? (
                  <a
                    href={taxonomyStatus.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#185FA5] hover:underline"
                  >
                    TeamDesk · FL Themes ↗
                  </a>
                ) : (
                  <span className="text-muted">not configured</span>
                )}
              </InfoRow>
              <InfoRow label="Last synced">
                <span className="text-muted">
                  {taxonomyStatus?.last_synced_at
                    ? new Date(taxonomyStatus.last_synced_at).toLocaleString()
                    : "never (baked at build time)"}
                </span>
              </InfoRow>
              <InfoRow label="Entries">
                {taxonomyStatus ? (
                  <span>
                    <strong>{taxonomyStatus.total.toLocaleString()}</strong>{" "}
                    <span className="text-muted">
                      ({taxonomyStatus.level_1} themes · {taxonomyStatus.level_2} sub ·{" "}
                      {taxonomyStatus.level_3} sub-sub)
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">loading…</span>
                )}
              </InfoRow>
              <InfoRow label="API status">
                {taxonomyStatus ? (
                  taxonomyStatus.api_connected ? (
                    <span className="text-[#0F6E56]">● connected</span>
                  ) : (
                    <span className="text-[#A32D2D]">● not connected</span>
                  )
                ) : (
                  <span className="text-muted">—</span>
                )}
              </InfoRow>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={planTaxonomyRefresh}
                disabled={
                  taxonomyState.kind === "planning" ||
                  taxonomyState.kind === "applying"
                }
                className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50 disabled:opacity-40"
              >
                {taxonomyState.kind === "planning" ? "↻ Refreshing…" : "↻ Refresh from TeamDesk"}
              </button>
              {taxonomyStatus?.source_url && (
                <a
                  href={taxonomyStatus.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm px-3.5 py-2 rounded-md border border-border bg-white hover:bg-zinc-50"
                >
                  Open TeamDesk table ↗
                </a>
              )}
            </div>

            {taxonomyState.kind === "not-configured" && (
              <div className="text-xs bg-[#FAEEDA] border border-[#FAC775] text-[#633806] px-3 py-2 rounded-md">
                {taxonomyState.message}
              </div>
            )}
            {taxonomyState.kind === "error" && (
              <div className="text-xs bg-[#FDECEC] border border-[#A32D2D]/30 text-[#A32D2D] px-3 py-2 rounded-md">
                ✗ {taxonomyState.message}
              </div>
            )}
            {taxonomyState.kind === "confirm" && (
              <TaxonomyConfirmDialog
                diff={taxonomyState.diff}
                onCancel={() => setTaxonomyState({ kind: "idle" })}
                onApply={applyTaxonomyRefresh}
              />
            )}
            {taxonomyState.kind === "applied" && (
              <div className="text-xs bg-[#E8F5EE] border border-[#0F6E56]/30 text-[#0F6E56] px-3 py-2 rounded-md">
                ✓ Taxonomy refreshed — {taxonomyState.summary}
              </div>
            )}

            <p className="text-[11px] text-muted">
              Renames and deletions affect tagged designs — confirmation dialog appears on refresh when any are detected.
            </p>
          </section>

          <div className="border-t border-border -mx-6" />

          {/* ─── Sync from Shopify ─────────────────────────────────────── */}
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

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted w-24 shrink-0">{label}</span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

function TaxonomyConfirmDialog({
  diff,
  onCancel,
  onApply,
}: {
  diff: TaxonomyDiffSummary;
  onCancel: () => void;
  onApply: () => void;
}) {
  // Additions-only diffs apply silently per the handoff spec — but we still
  // surface a compact summary so the user sees what landed. If the diff is
  // empty, there's literally nothing to do; short-circuit with a notice.
  const nothingChanged =
    diff.added.length === 0 && diff.renamed.length === 0 && diff.removed.length === 0;
  if (nothingChanged) {
    return (
      <div className="text-xs bg-zinc-50 border border-border text-muted px-3 py-2 rounded-md flex items-center justify-between gap-3">
        <span>No changes — local taxonomy matches TeamDesk.</span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2.5 py-1 rounded-md border border-border bg-white hover:bg-zinc-50"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="border border-[#FAC775] bg-[#FAEEDA]/40 rounded-md px-3 py-3 text-xs space-y-2">
      <div className="font-medium text-[#633806]">Taxonomy changes detected:</div>
      <ul className="list-disc pl-5 space-y-0.5 text-foreground">
        <li>
          <strong>{diff.added.length}</strong> added{" "}
          <span className="text-muted">(safe, no impact)</span>
        </li>
        <li>
          <strong>{diff.renamed.length}</strong> renamed{" "}
          <span className="text-muted">(auto-migrate existing designs)</span>
        </li>
        <li>
          <strong>{diff.removed.length}</strong> deleted{" "}
          <span className="text-muted">
            (affected designs will be flagged for re-review)
          </span>
        </li>
      </ul>
      {diff.removed.length > 0 && (
        <div className="text-[11px] text-[#A32D2D] italic">
          Removed: {diff.removed.slice(0, 3).map((r) => `"${r.label}"`).join(", ")}
          {diff.removed.length > 3 ? `, +${diff.removed.length - 3} more` : ""}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          className="text-xs px-3 py-1.5 rounded-md bg-[#0F6E56] text-white hover:bg-[#0C5947]"
        >
          Apply changes
        </button>
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
