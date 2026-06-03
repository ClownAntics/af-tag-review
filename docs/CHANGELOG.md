# Changelog

All notable changes to the Tag Review app. Newest at the top.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Loosely versioned — the app is single-tenant and deploys continuously, so dates are the source of truth.

---

## 2026-05 — Excluded status, Shopify product type / variant SKUs / images, bulk exclude, duplicate consolidation

### Added (continued)
- **Cross-occasion tag filter.** Vision was emitting decoration tags like `Fireworks` (under `Seasonal: 4th of July`) and `Masks` (under `Seasonal: Halloween`) on a Mardi Gras flag because the imagery superficially resembled fireworks and Halloween masks. The ancestor expander then dragged the sibling level-2 occasions into the stored tag set, cross-tagging Mardi-Gras designs as `4th-Of-July` + `Halloween`. Same shape on Kwanzaa / Hanukkah — `Candles` lives only under `Seasonal: Christmas Religious`, so any candle-bearing design pulled `Christmas-Religious` in. New `filterConflictingDecoration()` in `lib/vision.ts` drops any decoration whose level-2 sub differs from the primary's level-2 sub under the same level-1 theme (e.g. drops Fireworks when primary is Mardi-Gras). Decorations under a different level-1 theme entirely (e.g. `Birds: Cardinals` on a Christmas flag) still pass through. Filter applies before ancestor expansion so the conflicting parents never make it into `vision_tags`; dropped terms are recorded in `vision_raw.dropped_conflicting` for audit. Vision prompt rule 7 also strengthened to make the "sibling occasions are mutually exclusive" rule explicit, with a Mardi Gras example.
- **`scripts/backfill-conflicting-decoration.ts`** — one-off backfill that applies the same rule to existing `vision_tags`, scoped by stored `vision_raw.primary`. Cheap (no Anthropic calls); writes a `vision_tags_filtered` audit event per design.

### Added (continued)
- **Settings modal: "Sync from Shopify" + last-synced indicator.** Above the existing destructive reset (now relabeled "Reset everything (danger zone)") is a new non-destructive `↻ Sync now` button that runs the same job as the 3am cron — inserts new designs as No-vision, refreshes drift, auto-excludes orphans. The button hits `/api/sync/shopify`, a thin server-side proxy that forwards to `/api/cron/shopify-sync` with the `CRON_SECRET` so the browser never needs to plumb the secret. A `Last synced X ago · trigger · +N new · M updated · K excluded` line above the button reads from `/api/sync/last` (which reads the latest `shopify_sync_log` row). Updates immediately after a manual sync completes.

- **New-product handling: nightly cron + No-vision banner.** Migrations 009 + 010 added `designs.first_seen_at` and `shopify_sync_log`. New `/api/cron/shopify-sync` route runs the same pull-and-apply logic the CLI uses (inserts new families as `novision`, updates drift, auto-excludes orphans). `vercel.json` schedules it for `0 7 * * *` (3am ET). Auth via `CRON_SECRET` header. The No-vision tile now shows a banner — `✨ N new designs added in the last 7 days — flag them for vision review?` — with a single click `⚑ Flag all N new` that moves the matching novision rows to `flagged` and writes a `flagged` event per design with `reason: 'new_from_shopify_sync'`. `/api/review/new-designs?days=N` (GET preview + POST flag) powers the banner. `Design` type, `/api/review/queue` and `/api/review/lookup` SELECTs all include `first_seen_at`.
- **Canonicalized 2,908 designs' `approved_tags` + flagged 12 with junk tags.** Scan of all 9,506 non-excluded designs found 2,920 with non-canonical entries in `approved_tags` (the curated tag list — should always be exact-case FL Themes Search Terms). 99.6% were just case or format mismatches (`flowers` → `Flowers`, `4th-of-july` → `4th-Of-July`, label-form `Seasonal: Christmas` → leaf `Christmas`) — auto-fixed in place via `scripts/canonicalize-approved-tags.ts`. Each fix updates `approved_tags`, recomputes `theme_names`/`sub_themes`/`sub_sub_themes` via the existing `mapTagsToThemes()` helper, and writes a `tags_canonicalized` audit event with `{before, after, mapping}`. The remaining 12 designs (10 had `Sale Product`, 2 had `MLB` — neither in FL Themes) got `flagged` with `approved_tags` cleared and a `flagged` event carrying `reason: 'non_canonical_tags'`, the prior tags, and the unfixable list for the reviewer.
- **Tag dropdown deduped + canonicalized.** The Tag filter previously listed every distinct raw value across `shopify_tags`, which meant `4th of July`, `4th-Of-July`, and `4th-of-july` all showed as separate options alongside Shopify internal noise like `MLB`, `Sale Product`, `IncludeInPromotions`. Now the dropdown only shows tags that resolve to an FL Themes Search Term, with case / spaces-vs-hyphens / label-form variants all collapsed onto the canonical kebab-title-case form. Dropped 594 of 1,120 entries (53%) — none of which represented real curatable themes. The tag filter also got a small upgrade: picking a canonical tag now matches against `approved_tags` (canonical), `shopify_tags` containing the canonical, or `shopify_tags` containing the Shopify-lowercased form — so designs are findable regardless of which storage form they happen to be in.

- **Search results carry the No-vision card overlay.** Each card in the search-results grid now shows the same 3 action buttons as a No-vision card: ✓ Mark as fine, ⚑ Flag, × Exclude. Already-excluded designs swap the × for ↩ Include. After an action, the card stays in the grid (so you don't lose your place) but the buttons hide and a "✓ flagged / marked fine / excluded / included" badge replaces them. Tag chips under the card reflect the design's actual state — shopify_tags (dashed grey) for novision/flagged, approved_tags (green) for readytosend/updated/excluded. The `CardImageOverlay` was extracted from TileGrid into its own file so the search grid can share the same UI.
- **Header search is now a global view.** Typing a name fragment in the header search and pressing Enter clears the active tile and all filter dropdowns, then renders a flat grid of every matching design across every status (No-vision → Updated → Excluded). Lookup endpoint capped at 10 was raised to 200 to support this. A banner above the grid shows the query, match count, and a `← Clear search` button that returns you to the default pipeline view (Pending, no filters). Single SKU lookups (`AFGFMS0688`, `AFMS0688`, etc.) still open the detail modal directly — same fast path as before.

### Fixed (continued)
- **Push survives client disconnect.** Previously, navigating away mid-push (clicking another tile, switching tabs, etc.) closed the streaming connection — `controller.enqueue` would throw on the next emit and abort the loop, leaving designs stuck halfway through. `app/api/review/push/route.ts` and `app/api/review/vision/run/route.ts` now wrap emits in try/catch, track a `clientConnected` flag, and listen for `req.signal.abort()` — once the client is gone we stop writing to the stream but the Shopify update + Supabase write loop continues. Reload after coming back and the designs will have moved to Updated. Final `controller.close()` is also wrapped to swallow "already closed" errors. UI side: `TileGrid` registers a `beforeunload` confirm dialog whenever a push or vision run is active so accidental navigation gets caught, and the inline progress line on the Ready-to-send tile shows "· keeps running if you leave" while pushing.
- **Stop fabricating SKUs in the UI.** `variantSkusFor()` and `primaryImageUrl()` were stitching `AFGF<body>` / `AFHF<body>` strings out of `design_family` as a fallback when `variant_skus` was missing — produced bogus SKUs on cards for non-AF manufacturers (`AFGFCA52602` on a Carson row) and for non-standard AF SKUs (`AFGFafgfwr-b-0004` on the burlap line). Source of truth for SKUs is now Shopify alone: read `variant_skus` verbatim, and if that column is empty show `design_family` rather than inventing one. The AF-personalization-suffix helper (`afSuffix`, `AfSuffix`) is gone with the fabrication that used it. `primaryImageUrl()` no longer takes `manufacturer` or the `has_monogram` / `has_personalized` / `has_preprint` flags — they were only feeding the synthesizer.
- **AF SKU parser was case-sensitive.** Variants like `AFhFSP0677` (the house version of `AFSP0677`, with a lowercase `h`) were being treated as separate design families instead of merging with their garden sibling. Result: two review rows for the same artwork. Fixed in `lib/shopify.ts#skuToAfDesignFamily` (uppercase the SKU before matching). Existing orphans cleaned up via `scripts/consolidate-design-families.ts` — 11 merges on first run (all `AFhFSP06xx` cardinals/flowers series). The script handles both merge (canonical row exists) and rename (no canonical) cases, re-points events for full audit-trail preservation, and writes a `merged_duplicate` event for each consolidation.
- **AF SKU suffix grammar broadened.** The regex only accepted `-CF`, `WH`, or a single monogram letter; new catalog SKUs like `AFGFMS0085-CG` (custom-greeting variants) fell through and got keyed under their full SKU instead of collapsing onto the artwork's design family. Tightened to `(?:-[A-Z]{1,3}|[A-Z]{1,2})?` so any reasonable variant marker resolves to the same canonical body. Second consolidation pass: 60 additional merges (mostly `-CD` doormat-custom and `-CG` garden custom-greeting) + 5 renames.
- **Vision pipeline now uses Shopify's image_url.** `primaryImageUrl()` and the vision-run route's SELECT were stuck on the old SKU-pattern derivation, producing 404 URLs for non-standard SKUs. Vision now prefers stored `image_url`, then first `variant_sku`, then derivation as last resort.
- **`consolidate-design-families` multi-loser merges no longer clobber.** When two orphans pointed at the same canonical (e.g. `AFGFMS0085-CG` and `AFHFMS0085-CG` both → `AFMS0085`), the second merge UPDATE used the original in-memory winner snapshot and overwrote the first merge's union of `variant_skus` / `shopify_product_ids`. Script now mutates the winner snapshot after each merge so subsequent merges build on top. Damage from the prior run was repaired by re-running `shopify-pull --apply` (13 updates, restoring 9 lost product IDs).
- **`consolidate-design-families` rename FK violation.** `events.design_family` has an FK to `designs.design_family`; updating the parent key in-place rejected the rename. Switched to INSERT-then-delete (copy the row at the canonical key, re-point events, drop the original), stripping the generated `effective_date` column from the copy.

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
