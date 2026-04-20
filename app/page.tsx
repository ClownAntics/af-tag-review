"use client";

/**
 * Tag Review — standalone app for curating product tags against the FL Themes
 * taxonomy, backed by Claude vision suggestions and a flag → pending →
 * ready-to-send → updated review pipeline.
 *
 * Currently the underlying `designs` table is AF garden/house flags, but the
 * UI is written to be brand-agnostic: image URL comes from each design row,
 * Shopify admin links are driven by per-design data, and nothing in this page
 * hardcodes "AF" or "flag".
 */
import { useEffect, useState } from "react";
import { TagFixing } from "@/components/TagFixing/TagFixing";
import { DetailModal } from "@/components/DetailModal";
import type { Design } from "@/lib/types";

export default function Home() {
  const [detail, setDetail] = useState<Design | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && detail) setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const handleFlag = async (d: Design) => {
    try {
      await fetch(
        `/api/review/design/${encodeURIComponent(d.design_family)}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "flag" }),
        },
      );
    } catch {
      // Swallow; the dataVersion bump below triggers a re-fetch regardless.
    }
    setDetail(null);
    setDataVersion((v) => v + 1);
  };

  return (
    <main className="max-w-7xl mx-auto px-6 py-8 space-y-5 w-full">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Tag Review</h1>
          <p className="text-sm text-muted">
            Claude-vision tag curation for FL designs. Flag what needs fixing,
            review Pending, push cleaned tags to Shopify.
          </p>
        </div>
        <nav className="flex gap-3 text-xs text-muted shrink-0 pt-1">
          <a
            href="https://af-sales-research.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground hover:underline"
          >
            AF sales research →
          </a>
        </nav>
      </header>

      <TagFixing onOpenDetail={setDetail} externalDataVersion={dataVersion} />

      {detail && (
        <DetailModal
          key={detail.design_family}
          design={detail}
          onClose={() => setDetail(null)}
          onFlag={handleFlag}
        />
      )}
    </main>
  );
}
