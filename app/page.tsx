"use client";

/**
 * Tag Review — standalone app for curating product tags against the FL Themes
 * taxonomy, backed by Claude vision suggestions and a flag → pending →
 * ready-to-send → updated review pipeline.
 *
 * The underlying `designs` table is currently AF garden/house flags, but the
 * UI is written to be brand-agnostic: image URL comes from each design row,
 * Shopify admin links are driven by per-design data, and nothing in this page
 * hardcodes "AF" or "flag".
 */
import { useEffect, useState } from "react";
import { TagFixing } from "@/components/TagFixing/TagFixing";
import { DetailModal } from "@/components/DetailModal";
import { SkuSearch } from "@/components/SkuSearch";
import { QuickStartModal } from "@/components/QuickStartModal";
import { VisionPromptModal } from "@/components/TagFixing/VisionPromptModal";
import type { Design } from "@/lib/types";

export default function Home() {
  const [detail, setDetail] = useState<Design | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const [quickStartOpen, setQuickStartOpen] = useState(false);

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
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-5 flex-wrap">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">Tag Review</h1>
            <p className="text-sm text-muted">
              Claude-vision tag curation for FL designs. Flag what needs fixing,
              review Pending, push cleaned tags to Shopify.
            </p>
          </div>
          <SkuSearch onFound={setDetail} />
        </div>
        <nav className="flex gap-4 text-xs text-muted shrink-0 pt-1">
          <button
            type="button"
            onClick={() => setQuickStartOpen(true)}
            className="hover:text-foreground hover:underline font-medium text-foreground"
          >
            Quick start
          </button>
          <a
            href="https://github.com/ClownAntics/af-tag-review/blob/main/docs/USER_GUIDE.md"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground hover:underline"
          >
            User guide
          </a>
          <a
            href="https://github.com/ClownAntics/af-tag-review/blob/main/docs/DEVELOPER.md"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground hover:underline"
          >
            Developer docs
          </a>
          <button
            type="button"
            onClick={() => setPromptModalOpen(true)}
            className="hover:text-foreground hover:underline"
          >
            Edit vision prompt
          </button>
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

      <VisionPromptModal
        open={promptModalOpen}
        onClose={() => setPromptModalOpen(false)}
      />

      <QuickStartModal
        open={quickStartOpen}
        onClose={() => setQuickStartOpen(false)}
      />
    </main>
  );
}
