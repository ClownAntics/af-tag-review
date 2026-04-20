"use client";

import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Condensed "how to use this app" card for first-time users. Full how-to
 * lives in docs/USER_GUIDE.md; this is the 30-second version.
 */
export function QuickStartModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[15px] font-medium leading-tight">Quick start</h3>
            <p className="text-xs text-muted mt-0.5">30-second overview</p>
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

        <div className="px-5 py-4 space-y-4 text-sm">
          <Step n={1} title="Flag designs that need review">
            From the <strong>No vision yet</strong> tile: hover a card → click to flag.
            Or use <strong>📋 Paste SKUs</strong> top-right to bulk-flag.
            Or type a SKU in the header search → flag from the detail modal.
          </Step>

          <Step n={2} title="Run Claude vision">
            Click the <strong>Flagged</strong> tile → <strong>⚡ Run vision on N designs →</strong>.
            Claude analyzes each image and proposes tags. Takes ~3s per design.
          </Step>

          <Step n={3} title="Review each suggestion">
            Click the <strong>Pending</strong> tile. For each design:
            <ul className="list-disc ml-5 mt-1 space-y-0.5 text-xs text-muted">
              <li>⭐ marks Claude&apos;s &ldquo;primary theme&rdquo; pick</li>
              <li>✓ promotes a vision suggestion to Approved</li>
              <li>× rejects it (removes from both vision and approved)</li>
              <li>Add from taxonomy via the search field if Claude missed something</li>
              <li>Hit <strong>Approve</strong> (or <kbd className="font-mono text-[10px] px-1 bg-black/5 rounded">⏎</kbd>) when done</li>
            </ul>
          </Step>

          <Step n={4} title="Push to Shopify">
            Approved designs land in <strong>Ready to send</strong>. Click{" "}
            <strong>↑ Push N to Shopify</strong> to write the tags back.
            Once successful, designs move to <strong>Updated</strong> and tags are live.
          </Step>

          <p className="text-[11px] text-muted-2 pt-2">
            Keyboard shortcuts during review: <kbd className="font-mono bg-black/5 px-1 rounded">⏎</kbd> Approve · <kbd className="font-mono bg-black/5 px-1 rounded">S</kbd> Skip · <kbd className="font-mono bg-black/5 px-1 rounded">A</kbd> Accept all vision · <kbd className="font-mono bg-black/5 px-1 rounded">←/→</kbd> Prev/Next · <kbd className="font-mono bg-black/5 px-1 rounded">F</kbd> Flag · <kbd className="font-mono bg-black/5 px-1 rounded">?</kbd> Help
          </p>
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <a
            href="https://github.com/ClownAntics/af-tag-review/blob/main/docs/USER_GUIDE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-white hover:bg-zinc-50"
          >
            Full user guide →
          </a>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md bg-foreground text-background border border-foreground hover:bg-zinc-800"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-6 h-6 rounded-full bg-foreground text-background text-xs font-medium flex items-center justify-center shrink-0">
        {n}
      </div>
      <div className="flex-1">
        <p className="font-medium leading-tight mb-0.5">{title}</p>
        <div className="text-xs text-muted leading-snug">{children}</div>
      </div>
    </div>
  );
}
