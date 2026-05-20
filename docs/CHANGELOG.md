# Changelog

All notable changes to the Tag Review app. Newest at the top.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Loosely versioned — the app is single-tenant and deploys continuously, so dates are the source of truth.

---

## 2026-05 — Excluded status, Shopify product type / variant SKUs / images, bulk exclude, duplicate consolidation

### Fixed (continued)
- **AF SKU parser was case-sensitive.** Variants like `AFhFSP0677` (the house version of `AFSP0677`, with a lowercase `h`) were being treated as separate design families instead of merging with their garden sibling. Result: two review rows for the same artwork. Fixed in `lib/shopify.ts#skuToAfDesignFamily` (uppercase the SKU before matching). Existing orphans cleaned up via `scripts/consolidate-design-families.ts` — 11 merges on first run (all `AFhFSP06xx` cardinals/flowers series). The script handles both merge (canonical row exists) and rename (no canonical) cases, re-points events for full audit-trail preservation, and writes a `merged_duplicate` event for each consolidation.
- **Vision pipeline now uses Shopify's image_url.** `primaryImageUrl()` and the vision-run route's SELECT were stuck on the old SKU-pattern derivation, producing 404 URLs for non-standard SKUs. Vision now prefers stored `image_url`, then first `variant_sku`, then derivation as last resort.

### Added (continued)
- **Bulk-exclude accessories** in Settings. Preview shows the count + first 10 matching designs with their product_types; one click moves them all to the Excluded tile. Per-card ↩ Include reverses individual decisions.
- Audit event `bulk_excluded` is written per design with the offending `product_types` and prior status in the payload, so the action is fully reviewable from the history.

**Accessory rule** (`lib/accessory-rules.ts`): a product_type counts as accessory if it literally contains the word **"Accessories"** OR is exactly **"Gift Card"**. A design family is flagged only if **every** entry in `shopify_product_types` matches — Garden Flag families that happen to bundle a pole / bracket / stake product as a secondary type stay in the review pipeline.

Catalog audit at ship time: **99 of 9,713 non-excluded designs** match. Standalone "Pole" / "Bracket" / "Stake" categories that aren't inside an Accessories sub-tree are NOT auto-excluded — use the per-card × button for those.

---

## 2026-05 — Excluded status, Shopify product type / variant SKUs / images

### Added
- **Sixth `excluded` status** in the review pipeline. Designs marked excluded are intentionally NOT being reviewed (accessories, gift cards, products with no artwork). Reversible from a per-card ↩ Include button on the Excluded tile.
  - Per-card **×** button in the bottom-right of No-vision cards.
  - **↩ Include** button on the top-right of Excluded cards.
  - New `excluded` + `included` event types in the audit log.
  - Migration `007_excluded_status.sql`.
- **`shopify_product_types text[]` column** — pulled from Shopify's native `product_type` field on every product, aggregated per design family. Replaces the SKU-pattern-derived `product_types` column as the source for the **Type** filter dropdown. Migration `006_shopify_product_types.sql`.
- **`variant_skus text[]` column** — actual Shopify variant SKUs per design family. Eliminates the SKU-pattern-derivation hack that produced doubled-prefix garbage (`AFGFafgfms-b-0001`) for non-standard SKU patterns. Migration `008_variant_skus.sql`.
- **`image_url`** is now populated from Shopify's `product.image.src` — real CDN URLs instead of guessing the filename from the SKU. Fixes broken-image cards for new burlap/non-standard SKU lines.
- **`scripts/export-ev-product-types.ts`** — exports a CSV of the ~55 Evergreen Switch Mat products whose Shopify `product_type` was misconfigured to a raw product id (`EV432556`, etc.). For handoff to whoever owns the Shopify catalog.
- **`scripts/backfill-theme-columns.ts`** — one-off to repair `theme_names` / `sub_themes` / `sub_sub_themes` that drifted out of sync with `approved_tags`.

### Changed
- **Type filter dropdown** now lists real Shopify product categories (`Sleeved Flags: Small Flags: Sublimated (Printed)`, `Mailbox Covers: Regular`, `Doormats: Regular`, etc.) instead of the four internal labels (`garden`, `house`, `garden-banner`, `unknown`).
- **`variantSkusFor()` and the image URL builder** now prefer the stored `variant_skus` + `image_url` from Shopify; fall back to the legacy SKU-pattern derivation only for pre-migration rows or non-AF manufacturers.
- **Action route keeps theme columns in lockstep with `approved_tags`.** Every action that touches `approved_tags` (`approve`, `update_tags`, `accept_vision`, `reject_vision`, `flag` with wipe, `reset`) now also recomputes `theme_names` / `sub_themes` / `sub_sub_themes` via the taxonomy. Eliminates the bug where the Theme filter under-reported because derived columns weren't refreshed by the slow-path Approve flow.
- **`shopify-pull.ts` retries transient errors.** Updates now retry up to 4 times with exponential backoff (500ms / 1.5s / 4.5s) before throwing. A flaky Supabase connection no longer crashes the entire pull.
- **`/api/review/queue` and `/api/review/lookup`** SELECT now include `variant_skus`, `image_url`, and `shopify_product_types`, so the client has them without follow-up requests.
- **Type filter hides `EV\d+` garbage values** from the dropdown (misconfigured Shopify product_types). Data stays in the row; just hidden from the picker.

### Fixed
- **Push respects active filters.** Clicking "Push all N to Shopify" with a filter active (and no manual checkbox selection) now scopes the server-side iteration to the filtered subset. Previously it ignored filters and pushed everything in `readytosend` while the progress bar lied about the count.
- **Theme filter no longer under-reports.** The drift between `approved_tags` and `theme_names` meant flower-tagged designs didn't appear under the Flowers filter. Backfill ran for 1,204 of 3,937 stale rows; the action-route fix prevents future drift.

---

## 2026-04 — Taxonomy refresh, Settings modal, Mark-as-fine fast path

### Added
- **Settings modal** (header link, left of User guide) with two sections:
  - **Taxonomy (FL Themes):** API status, source URL, last-synced timestamp, entry count breakdown. Two buttons: **↻ Refresh from TeamDesk** and **Open TeamDesk table ↗**.
  - **Sync from Shopify:** Reset everything + re-pull from Shopify. Typed-`RESET` confirmation. Streams NDJSON progress.
- **TeamDesk taxonomy refresh** (`/api/taxonomy/refresh?phase=plan|apply`). Plan diffs incoming vs current; apply (when wired) upserts entries, migrates renamed tags on existing designs, and flags designs using removed tags for re-review. Supabase migration `005_taxonomy.sql` adds `taxonomy_entries` + `taxonomy_refresh_log`.
- **`/api/review/reset-all`** — bulk-reset every design to `novision` and refresh from Shopify in one streaming endpoint. Used by the Settings modal's Reset action. History (`events` table) is never cleared.
- **Mark-as-fine fast path.** On No-vision cards, a small ✓ checkbox copies the current Shopify tags into `approved_tags`, refreshes the derived theme columns, and jumps straight to Ready-to-send — no vision run, no review step.
- **Excluded-by-status guard in `mark_fine`** — returns 409 if a design has no `shopify_product_ids` (otherwise push would silently skip it).
- **Last-selected tile persistence.** Active tile saved to `localStorage` (`tagReview.lastTile`); subsequent visits open where you left off.
- **Per-card chip rendering** — full tag list, no truncation. Cards with many tags grow taller; no `+N` overflow.

### Changed
- **No-vision per-card UI:** small ✓ (top-left) for Mark as fine, ⚑ (top-right) for Flag-through-vision. Removed the big green centered hover overlay.
- **Header** now includes a **Settings** link, left of User guide.
- **TeamDesk REST auth** finalized: `Authorization: Bearer <token>` header, URL without the `/-/` segment (that segment means cookie-auth, which silently ignores Bearer tokens and returns 403).

### Fixed
- **Hydration mismatch (React #418).** The lazy `useState` initializer that restored the last-selected tile read `localStorage`, producing different server (no window) and client (storage value) initial states. Switched to "stable initial value + `useEffect` to hydrate after mount." Was crashing the React tree mid-NDJSON-stream during pushes.
- **`Last synced` timestamp** in Settings modal — wired to a `taxonomy_refresh_log` row instead of always rendering `null`.

### Operational
- **`scripts/reset-readytosend.ts`** — flushes Ready-to-send → No-vision (used once to wipe a bad batch and re-test the fast path).

---

## Earlier (pre-handoff baseline)

The initial app shipped in commit `fc5dbe2` covering:

- Five-status pipeline (No-vision → Flagged → Pending → Ready-to-send → Updated).
- Vision-tag flow with Sonnet 4.6, streaming progress, taxonomy validation, hierarchy expansion.
- Pending review UI with conflict detection, vision suggestion accept/reject, taxonomy typeahead, keyboard shortcuts.
- Phase 6 Shopify push (`POST /api/review/push`) — replaces each product's tags with `approved_tags`, idempotent by status, handles partial failure, NDJSON streamed.
- Five status tiles, filter bar (Theme/Sub/Sub-sub/Tag/Type/Manufacturer), SKU + name search in the header, Quick Start modal.
- Per-design Detail modal with 24-month sales chart and immutable event history.

Earlier history lives in git: `git log --oneline` from `fc5dbe2` backwards.
