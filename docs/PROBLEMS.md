# Problems / cleanup backlog + handoff

Running list of open work. Status: 🔴 open · 🟡 partial · 🟢 done.
Last updated end of the 2026-07-03 session.

---

## ▶ OPEN TASKS (do next)

### T5 🔴 Facet tags for the storefront filter bar (was D2) ⭐
The storefront filters are **already tag-driven** — a custom theme filter bar
(`assets/filter-bar.js` on justforfunflags.com) filtering by plain Shopify tags
via native tag URLs. Size/Material dropdowns look dead only because products
lack the expected tags (counts are 0). Fix = teach the push pipeline a
tag-mapping so products carry the exact slugs the bar expects:
- **Material**: `printed, applique, burlap, linen, lustre, moire, foil-accent, metal, satin`
- **Size**: `standard-garden, mini-garden, long-garden` (+ `regular-mailbox/large-mailbox`, `regular-doormat/mini-doormat`)
- **Features**: `Reversible, PremierSoft, suedereflections, GlitterTrends, Printed-in-usa, Eco-friendly`
Source data already in DB (`shopify_product_types`, `is_double_sided`, feature
flags). `filter-counts.json` regenerates automatically (daily+). Optional:
one-line theme edit to add `Double-Sided` to the Features dropdown. NO
metafields needed. NOTE: creds = justforfunflags store; clownantics.com is a
separate Shopify store. Diagnostic: `scripts/diag-facets-readonly.ts`.

### T6 🟢 Mailbox covers (MC) — same-art check. DONE 2026-07-03.
Verified: only 9 AF families carry an `AFMC…` SKU; all 9 MC products share
their flag family's artwork (7 exact title matches, 2 wording-only diffs).
No number-reuse like GB/DR — the collapse-into-flag-family behavior is
correct. Scan: `scripts/scan-mailbox-covers.ts`.

### T3 🔴 Product-type fixes in Shopify (Blake)
CSV: `C:\Users\gbcab\Downloads\product-type-mismatches.csv` — 220 rows (65
high-confidence typos). Shopify Admin edits, then Sync. Regenerate with
`scripts/csv-product-type-mismatches.ts`. Alternative: Claude can push the 65
high-confidence fixes via API if hand-editing is too tedious.

### T4 🔴 Non-AF material-tagging backlog
Decided (D3): **curate ALL non-excluded products**, all vendors. 5,091 non-AF
designs live as-is. Material-tag (`scripts/set-material-tags.ts`) + safe-merge
to readytosend. Pairs naturally with T5 (facet tags). Big job — own session.

### T7 🔴 Push behavior (was D1)
Push still REPLACES Shopify tags with themes-only `approved_tags`, wiping
functional/brand tags (`america-forever`, `Garden Flag`, `House Flags`…) that
smart collections + the filter bar depend on. Blake: fix later — but **must
land before any bulk push**, or collections empty out. Fix = merge-push
(preserve non-theme tags) + emit facet tags (T5).

---

## ▶ DECISIONS (Blake, 2026-07-03)

- **D1 — Push strips functional tags**: keep as-is for now, fix later (= T7).
- **D2 — Storefront facets**: investigated → tag-driven, see T5.
- **D3 — Catalog scope**: curate ALL non-excluded products, all vendors.
- **D4 — New designs default**: **novision** (no action implied), not flagged.

---

## ▶ PROBLEM LOG

### 🟢 P1 — SKU collapse merged banner/doormat designs. DONE 2026-07-03.
Code fix (4801e0d) + full re-import + re-split applied and verified: no GB/DR
SKUs in flag families, no dupes; 54 AFGB + 110 AFDR families. `AFMS0006` clean.
`skuToAfDesignFamily` (lib/shopify.ts) & `parseSku` (lib/sku-parser.ts) are
twin functions — keep in sync.

### 🟢 P2 — Cross-occasion decoration pollution. DONE 2026-07-03.
Blake moved `Stars` in TeamDesk: now `Fantasy: Stars` + `Patriotic: Patriotic
Stars: Stars` (no longer under 4th of July). Taxonomy table synced; conflict
recompute applied (32 designs updated). `scripts/run-taxonomy-refresh.ts` runs
the refresh route without a dev server.

### 🟢 P6 — Memorial Day collection polluted by 4th of July designs. DONE 2026-07-03.
Two causes, both fixed:
1. **9 dual-tagged designs** (approved_tags had both `Memorial-Day` +
   `4th-Of-July`, all with no vision primary). Blake's rule (Option B — strict
   one-occasion): dropped `Memorial-Day`; removed the tag surgically from 22
   live products (other tags preserved). `scripts/fix-memorial-4th-dualtag.ts`.
2. **33 designs with stale live `memorial-day`** never in curated tags (legacy
   tags on novision AF + never-pushed non-AF, incl. "4th Of July Fireworks",
   "America's Birthday"). Removed from 52 products, mirrors updated.
   `scripts/remove-stale-memorial.ts`.
Legit curated Memorial-Day set: 8 designs. Scan: `scripts/scan-stale-memorial.ts`.
Gotcha found on the way: Memorial Day / 4th of July smart collections use
INCONSISTENT tag values (`4th of July` vs `4th-of-july`) — noise to clean up in
Shopify someday. `scripts/inspect-shopify-collections.ts` dumps all collection rules.

### 🟢 P7 — Monogram variants merged with non-monogram base. DONE 2026-07-03.
Lettered SKUs (`…0001A`–`Z`) are a DIFFERENT design from the plain base
(`AFGFFA0001` "Apples & Pears" has no monogram) but were collapsed together,
polluting the base with `Letter-A`/`Monogrammed`. Fix: monogram SKUs → own
family per design number, key `AF<body>M` (all 26 letters together). Twin
functions updated (parseSku + skuToAfDesignFamily); also added `-CG` to the
personalized suffixes. Migration: 50 mixed families split (bases trimmed +
monogram tags stripped + themes recomputed), 45 mono-only families renamed to
`…M` keys (events + sales history moved; `effective_date` generated-column
trap — strip it when copying rows, see CHANGELOG 2026-06). All touched →
novision. Verified: no mono SKUs in base families, no base SKUs in M families;
95 `…M` families. `scripts/migrate-split-monogram.ts`, scan:
`scripts/scan-monogram-mix.ts`.

### 🔴 P3 — Shopify product_type typos vs TeamDesk → T3.
### 🟢 P5 — Catalog scope → decided (D3), see T4.

---

## ▶ Reference — key scripts
- `run-taxonomy-refresh.ts` — taxonomy refresh (plan/--apply) without dev server.
- `migrate-split-banner-doormat.ts` — split GB/DR into own families.
- `flagged-to-novision.ts` — bulk status sweep (used 2026-07-03: 380 designs).
- `verify-banner-doormat-split.ts` — split integrity checks.
- `fix-memorial-4th-dualtag.ts` / `remove-stale-memorial.ts` / `scan-stale-memorial.ts` — Memorial cleanup.
- `scan-memorial-4th-conflict.ts` — dual-occasion conflict scan.
- `inspect-shopify-collections.ts` — dump smart/manual collection rules (`--all`).
- `diag-facets-readonly.ts` — storefront facet diagnostics.
- `csv-product-type-mismatches.ts` — the product_type CSV.
- `recompute-themes-conflict.ts` — conflict-aware theme recompute.
- `shopify-pull.ts --apply` — full catalog re-import (manual only; never touches approved_tags).

## ▶ Current catalog state (2026-07-03, ~9,834 total)
updated ~7,679 · excluded ~1,682 · novision ~460 (flagged queue swept 380 → novision,
+10 new from sync) · readytosend ~98 · pending ~13 · flagged 0. Auth live
(Google SSO, `AUTH_ENABLED`). Catalog sync manual only. See
[[af-tag-review-problems-log]] in memory.
