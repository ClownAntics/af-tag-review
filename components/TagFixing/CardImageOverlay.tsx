/**
 * Per-card overlay rendered inside `DesignCard.imageOverlay`. Shared across
 * the tile grid (`TileGrid`) and the search-results grid (`TagFixing`).
 *
 * Each button is opt-in via a `show*` prop so the parent can mix-and-match
 * what's appropriate for its context. Examples:
 *   - No-vision tile: ✓ mark-fine + ⚑ flag + × exclude (the standard trio)
 *   - Flagged tile:   × remove
 *   - Ready-to-send:  ⚑ flag + ☑ select-for-push
 *   - Excluded tile:  ↩ include
 *   - Search grid:    ✓ mark-fine + ⚑ flag + × exclude (mirrors No-vision),
 *                     with ↩ include swapping in when the design is already
 *                     in `excluded` status.
 *
 * State badges (processing / done) sit in the top-left and are mutually
 * exclusive with the ✓ checkbox / mark-fine button.
 */
export type CardState = "waiting" | "processing" | "done" | "approved" | "neutral";

export interface CardImageOverlayProps {
  state: CardState;
  showRemove: boolean;
  showFlagBtn: boolean;
  showCheckbox: boolean;
  showMarkFineBtn: boolean;
  showExcludeBtn: boolean;
  showIncludeBtn: boolean;
  isSelected: boolean;
  onRemove: () => void;
  onFlag: () => void;
  onToggleSelect: () => void;
  onMarkFine: () => void;
  onExclude: () => void;
  onInclude: () => void;
}

export function CardImageOverlay({
  state,
  showRemove,
  showFlagBtn,
  showCheckbox,
  showMarkFineBtn,
  showExcludeBtn,
  showIncludeBtn,
  isSelected,
  onRemove,
  onFlag,
  onToggleSelect,
  onMarkFine,
  onExclude,
  onInclude,
}: CardImageOverlayProps) {
  const flagBtnPosition = "top-1.5 right-1.5";
  return (
    <>
      {state === "processing" && (
        <span className="absolute top-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[#FAEEDA] text-[#BA7517] font-medium pointer-events-none">
          ⚙ analyzing
        </span>
      )}
      {state === "done" && (
        <span className="absolute top-1.5 left-1.5 text-[10px] px-2 py-0.5 rounded-full bg-[#0F6E56] text-white font-medium pointer-events-none">
          ✓ done
        </span>
      )}
      {showCheckbox && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          title={isSelected ? "Deselect" : "Select for push"}
          aria-pressed={isSelected}
          className={`absolute top-2 left-2 w-7 h-7 rounded-md border-2 flex items-center justify-center text-base font-bold leading-none z-10 shadow-md transition-colors ${
            isSelected
              ? "bg-[#0F6E56] border-white text-white"
              : "bg-white border-[#0F6E56]/60 text-transparent hover:bg-[#0F6E56]/10 hover:border-[#0F6E56]"
          }`}
        >
          ✓
        </button>
      )}
      {showMarkFineBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMarkFine();
          }}
          title="Mark as fine — copy current Shopify tags to approved and queue for push"
          aria-label="Mark as fine"
          className="absolute top-1.5 left-1.5 w-5 h-5 rounded-sm border-2 border-[#0F6E56] bg-white hover:bg-[#0F6E56] text-[#0F6E56] hover:text-white flex items-center justify-center text-[11px] font-bold leading-none z-10 shadow-sm transition-colors"
        >
          ✓
        </button>
      )}
      {showRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove from flagged"
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-white/90 border border-border text-muted hover:text-[#A32D2D] hover:border-[#A32D2D] flex items-center justify-center text-[11px] leading-none z-10"
        >
          ×
        </button>
      )}
      {showFlagBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFlag();
          }}
          title="Flag for tag review (sends back through vision + review)"
          className={`absolute ${flagBtnPosition} w-6 h-6 rounded-full bg-white/90 border border-border text-muted hover:text-[#A32D2D] hover:border-[#A32D2D] flex items-center justify-center text-xs leading-none z-10`}
        >
          ⚑
        </button>
      )}
      {showExcludeBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onExclude();
          }}
          title="Exclude — not a reviewable design (accessory, gift card, etc.)"
          aria-label="Exclude"
          className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-full bg-white/90 border border-border text-muted hover:text-zinc-700 hover:border-zinc-500 flex items-center justify-center text-[12px] leading-none z-10"
        >
          ×
        </button>
      )}
      {showIncludeBtn && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onInclude();
          }}
          title="Include — bring this design back into the review pipeline"
          aria-label="Include"
          className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded-md bg-white/95 border border-border text-[10px] text-muted hover:text-foreground hover:border-foreground flex items-center justify-center leading-none z-10"
        >
          ↩ Include
        </button>
      )}
    </>
  );
}

// Ring classes for `DesignCard.containerClassName` — sit alongside the
// default `border border-border`. Re-exported here so callers don't need
// to import from TileGrid's internals.
export const STATE_BORDER: Record<CardState, string> = {
  waiting: "ring-2 ring-[#A32D2D]",
  processing: "ring-2 ring-[#BA7517]",
  done: "ring-2 ring-[#0F6E56]",
  approved: "ring-2 ring-[#0F6E56]",
  neutral: "",
};
