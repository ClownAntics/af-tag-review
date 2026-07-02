# Problems / cleanup backlog + handoff

Running list of open work. Status: 🔴 open · 🟡 partial · 🟢 done.
Last updated end of the 2026-07-02 session (moving to a new thread).

---

## ▶ OPEN TASKS (do next)

### T1 🔴 Re-split banner/doormat data (regressed) ⭐
The banner/doormat split was applied, but the later full re-import
(`shopify-pull --apply`) **re-merged them** because `skuToAfDesignFamily` (the
sync's family function) hadn't been updated — only `parseSku` had. **Fixed now**
(commit 4801e0d), so:
1. **Re-run** `npx tsx scripts/migrate-split-banner-doormat.ts` (dry-run then
   `--apply`) to re-separate GB→`AFGB…` / DR→`AFDR…` from the flag families.
2. **Clean up stragglers**: the first split created `AFGB…`/`AFDR…` families;
   after the re-merge some may be duplicated/stale — the re-run should reconcile,
   but verify no design has a banner/doormat SKU still in a flag family.
Symptom to confirm gone: e.g. `AFMS0006` should NOT list `AFGBMS0006`/`AFDRMS0006`.
`skuToAfDesignFamily` (lib/shopify.ts) and `parseSku` (lib/sku-parser.ts) MUST
stay in sync — they're twin functions.

### T2 🔴 Flagged queue: convert to novision instead of reviewing
Blake wants new/changed designs to sit as **novision** (no action implied), not
`flagged`. **How to unflag without running vision:** on the **Flagged** tile use
**"Clear all"** (all → novision) or the per-card **×** (one → novision) — neither
runs vision. Decide whether the split's flagged set + the undertagged-flagged set
should all be bulk-moved to novision.

### T3 🔴 Product-type fixes in Shopify
CSV: `C:\Users\gbcab\Downloads\product-type-mismatches.csv` — 220 rows (65
high-confidence typos, e.g. Burlap flags typed `Sublimated (Printed)`, house
flags typed Small→Large, `Windsocks and Spinners`→`Windsocks: Windsocks`).
These are **Shopify** edits (our app only reads `product_type`) — fix in Shopify
Admin, then Sync. `suggested_product_type` = the dominant value in that TeamDesk
type group. Regenerate with `scripts/csv-product-type-mismatches.ts`.

### T4 🔴 Non-AF backlog
5,091 non-AF designs were re-imported and marked `updated` (live as-is). When
ready, material-tag them (`scripts/set-material-tags.ts`) + safe-merge to
readytosend like the AF catalog, if we want their material facets curated.

---

## ▶ DECISIONS NEEDED (Blake)

- **D1 — Push strips functional tags.** Push REPLACES a product's Shopify tags
  with `approved_tags` (themes only), so `america-forever` (brand) and other
  functional Shopify tags get wiped on push. Preserve functional/brand tags
  through push, or strip to themes-only? (Related to D2/P4.)
- **D2 — Storefront facets (P4).** Size / Material / Double-Sided filters on the
  storefront don't read our tags — they're driven by Shopify metafields / a
  filter-app config we don't write. Needs Shopify-side investigation. Decide the
  approach (point facets at tags, or add a tag→metafield writer).
- **D3 — Catalog scope.** Non-AF restored (Evergreen/Carson/etc.). Confirm we
  keep all vendors long-term vs AF-focused.
- **D4 — New designs default status** (novision vs flagged) — see T2.

---

## ▶ PROBLEM LOG

### 🟡 P1 — SKU collapse merged unrelated banner/doormat designs
Root cause fixed in `parseSku` + `skuToAfDesignFamily` (GB→`AFGB`, DR→`AFDR`).
Data regressed by the re-import; re-split = **T1**. Confirmed examples:
`AFGBSP0023`="Busy Chipmunks" (merged into "Realistic Easter Bunny" → stray
`Squirrels`); `AFGBSP0016`="Easter Cross" (merged into "Patriotic Easter Egg" →
`Religious`/`Crosses`/`Lilies`).

### 🟡 P2 — Cross-occasion decoration pollution
`Stars`/`Fireworks` filed under `Seasonal: 4th of July` dragged that sub-theme
onto New Year/Christmas flags. Fixed same-level-1 cases via
`scripts/recompute-themes-conflict.ts` (8 cleared). Remaining: `Stars` on
non-Seasonal flags (nautical, etc.) — real fix is moving `Stars` out from under
`4th of July` in TeamDesk, then re-run the recompute.

### 🔴 P3 — Shopify product_type typos vs TeamDesk → T3.

### 🔴 P4 — Storefront facets don't reflect our tags → D2.

### 🟢 P5 — Catalog scope. Non-AF were deleted (outside our session, no audit
trail for row deletes), then re-imported via `shopify-pull --apply` (+6,736), all
marked `updated`, and accessories/discontinued re-excluded. Confirm scope = D3.

---

## ▶ Reference — key scripts
- `migrate-split-banner-doormat.ts` — split GB/DR into own families + flag.
- `exclude-accessories-discontinued.ts` — exclude accessories + discontinued.
- `exclude-phantoms.ts` — exclude TeamDesk-only rows with no Shopify product.
- `mark-novision-updated.ts` — novision → updated.
- `csv-product-type-mismatches.ts` — the product_type CSV.
- `clean-tag-noise.ts` — strip vendor/housekeeping tags from approved_tags.
- `recompute-themes-conflict.ts` — conflict-aware theme recompute.
- `shopify-pull.ts --apply` — full catalog re-import (manual only; no cron).

## ▶ Current catalog state (~9,828 total)
updated ~7,680 · excluded ~1,682 · flagged ~369 · readytosend ~98 · pending ~13
· novision 0. Auth live (Google SSO, `AUTH_ENABLED`). Catalog sync is manual
only (no cron). See [[af-tag-review-problems-log]] in memory.
