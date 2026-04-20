"use client";

import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROWS: { label: string; key: string }[] = [
  { label: "Approve & next", key: "⏎" },
  { label: "Skip", key: "S" },
  { label: "Accept all vision suggestions", key: "A" },
  { label: "Previous design", key: "←" },
  { label: "Next design", key: "→" },
  { label: "Flag for tag review", key: "F" },
  { label: "Show this help", key: "?" },
  { label: "Close any modal", key: "Esc" },
];

export function KeyboardHelpModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[15px] font-medium leading-tight">Keyboard shortcuts</h3>
            <p className="text-xs text-muted mt-0.5">Only active while reviewing in Pending.</p>
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
        <div className="px-5 py-3">
          <table className="w-full text-sm">
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label}>
                  <td className="py-2 text-muted">{r.label}</td>
                  <td className="py-2 text-right">
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-black/5">
                      {r.key}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
