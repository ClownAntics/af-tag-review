# Tag Review — User Guide

This app helps you clean up Shopify tags on FL designs. Claude vision looks at each design image, suggests tags from the FL Themes taxonomy, and you approve / reject / edit before pushing back to Shopify.

**Live URL:** the Vercel deploy you set up (e.g. `https://af-tag-review.vercel.app`).

---

## At a glance

Top to bottom:

1. **Header** — title + SKU/name search + links to Quick start, **Settings**, User guide, Developer docs, What's new, Edit vision prompt
2. **Paste SKUs** button (top right of main area) — bulk-flag designs by pasting SKU lists
3. **Pipeline reminder** — two paths to Ready to send: `Flag → vision → Pending → review` (slow) or `Mark fine` (fast), then `Ready to send → push → Updated`. Excluded designs sit aside the main loop.
4. **Filter bar** — Manufacturer / Theme / Sub / Sub-sub / Tag / Type. Search-as-you-type comboboxes. Every filter narrows every tile + queue below.
5. **Six status tiles** — counts for each pipeline stage, clickable
6. **Active tile view** — Pending is the review UI; others show grids of design cards with `Bulk actions ▾`, `↓ Export ▾`, and (on Ready-to-send + Updated) a `🎲 Random 20` button

---

## The pipeline

Two paths into **Ready to send**, then one path out to **Updated**:

```
No vision yet ──┬── (flag) ──→ Flagged ──→ vision ──→ Pending ──→ (approve) ──┐
                │                                                              │
                └── (mark fine) ─────────────────────────────────────────────→─┴─→ Ready to send ──→ (push) ──→ Updated
```

- **Slow path (with vision):** Flag → vision → Pending → Approve. Use when the existing Shopify tags are wrong, missing, or you want Claude to start from the image.
- **Fast path (skip vision):** Mark fine. Use when the current Shopify tags are already correct — you just need to move the design through the queue.

Both paths write to the same `approved_tags` / `theme_names` / `sub_themes` / `sub_sub_themes` columns, and both end up in the **same push batch** from the Ready-to-send tile.

| Status | What it means | How it enters |
|---|---|---|
| **No vision yet** | Design exists in catalog, never reviewed | Default for everything |
| **Flagged** | User marked for re-review, Claude hasn't run yet | Click ⚑ anywhere |
| **Pending** | Claude tagged it, awaits your review | Vision finishes → auto-moves here |
| **Ready to send** | Tags approved, queued for Shopify push | Approve in Pending **or** Mark fine on No-vision |
| **Updated** | Tags are live on Shopify | After a successful push |
| **Excluded** | Intentionally not being reviewed (accessories, gift cards, items with no artwork) | Click × on a No-vision card, or auto-excluded if Shopify deletes the product |

You can re-flag a design from any state in the main loop. Re-flagging from Ready-to-send or Updated **clears the previous approved tags** (fresh start). Re-flagging from No-vision or Pending preserves your in-progress work. Excluded designs are reversible too — click **↩ Include** on an Excluded card to send it back to No-vision.

---

## Getting designs ready to push

### Fast path — Mark as fine (no vision)

From the **No vision yet** tile, hover any card → click **"✓ Mark as fine"**. The design's current Shopify tags are trusted as-is: they're copied into `approved_tags`, the derived theme columns are refreshed, and the design jumps straight to **Ready to send**. No vision run, no review step. Use this when the existing tags are already correct.

### Slow path — Flag → vision → review

Use when the existing tags are wrong, missing, or stale. Three ways to flag:

1. **From any tile (single design)** — click the top-right **⚑** button on any card.
2. **Bulk via `Bulk actions ▾`** — picks a status-appropriate action (Flag / Mark fine / Exclude / etc.) and applies to all visible cards on the page. Always confirms with a count first.
3. **Paste SKU list** — top-right **"📋 Paste SKUs"** button. Paste SKUs in any format (comma, space, newline, tab). Live counter shows "N SKUs found". Click **"Flag N designs →"**.

Once flagged, go to the **Flagged** tile. Click **"⚡ Run vision on N designs →"**. Each card cycles red (waiting) → amber (analyzing) → green (done). When all finish, they move to **Pending** automatically, where you approve / reject / edit tags before they land in **Ready to send**.

---

## Reviewing in Pending

The Pending tile is the heart of the app. Two columns:

### Left column (the design)
- Flag image (click to flag again, which also runs vision from scratch)
- Design name
- SKUs (clickable — opens the Shopify admin search for that SKU)
- Stats row: units · per-year · date
- Classification band (HIT / SOLID / OK / WEAK / DEAD)

### Right column (the tags)
Three sections:

- **Approved tags** (green) — what will be pushed to Shopify when you click Approve. Click ✕ to remove one. Click the typeahead below to add from the taxonomy (fuzzy search, keyboard navigable).
- **Vision suggestions** (purple) — what Claude proposed. Click ✓ to promote to Approved. Click ✕ to reject (removes from both vision and approved, so it can't sneak back in).
- **Raw Shopify tags** (dashed, muted) — current Shopify tags, read-only. Reference for what's live right now.

### Conflict warning
If your approved tags contain a pair the FL Themes taxonomy flags as conflicting (Christmas + Spring, etc.), an amber banner appears above the sections listing each pair. Click either term in the pair to remove it.

### Approve
Hit **Approve** (or Enter). The design moves to Ready-to-send. If any vision suggestions are still un-reviewed when you Approve, they're merged silently into approved. If the final tag list has a taxonomy conflict, a confirmation dialog blocks — resolve or override.

### Cross-occasion guard
Vision automatically drops decoration suggestions whose lineage points to a competing occasion under the same level-1 theme. E.g., on a `Mardi-Gras` flag it won't propose `Halloween` (the masks) or `4th-Of-July` (the fireworks/sparkles), and on a `Kwanzaa` or `Hanukkah` design it won't pull in `Christmas-Religious` (the candles). Dropped tags are recorded in `vision_raw.dropped_conflicting` for audit.

### Keyboard shortcuts
Active only while in Pending review:

| Key | Action |
|---|---|
| `Enter` | Approve & next |
| `S` | Skip (no state change, move to next) |
| `A` | Accept all vision suggestions |
| `←` / `→` | Previous / next design |
| `F` | Flag current for re-review |
| `?` | Show help overlay |
| `Esc` | Close any modal |

---

## The other tiles

### Flagged
Compact grid of flagged designs. Each card has a ✕ in the top-right to remove (back to No-vision). Top row: **Clear all** and **⚡ Run vision on N →**. The pipeline reminder subtitle also has an **Edit vision prompt** link.

### Ready to send
Compact grid. Each card shows the approved tag chips below the SKU. Hover any card to see a **⚑** flag button in the top-right — sends it back through review. Primary button: **"↑ Push N to Shopify →"** — actually pushes now. Per-card checkboxes let you select a subset; if no cards are checked the button pushes everything on the (filtered) tile.

**Push behavior:**
- Filters are respected. When the tile shows a filtered subset, the push button only iterates that subset — the confirm dialog says *"(matching current filters)"*.
- **The push keeps running if you navigate away or close the tab.** The server completes the loop server-side even if the browser disconnects. A `beforeunload` confirm catches accidental clicks during a push, and the progress line shows "· keeps running if you leave" while pushing. Reload later to see results.
- Big batches: Shopify rate-limits at ~2 req/sec, so 100+ designs can take several minutes. Hits Vercel's 5-min function cap around 300+ designs — split into smaller batches via filters if needed.

### Updated
Same grid layout as Ready to send. Re-flag via the ⚑ button if a design needs another review cycle. Also where the **★ Staff Pick** star button lives — see "Staff Picks" below.

### No vision yet
The starting pool. Each card has **three per-card actions**:

- **Top-left ✓ checkbox** — fast path. Copies the card's current Shopify tags into `approved_tags`, refreshes the derived theme columns, and moves it directly to Ready to send. No vision is run.
- **Top-right ⚑ button** — slow path. Flags the design so Claude vision will re-tag it from the image.
- **Bottom-right × button** — exclude. Pulls the design out of the review pipeline (accessories, gift cards, things without artwork). Lands in the Excluded tile. Reversible.

### Excluded
Designs you've explicitly removed from the review pipeline (accessories, gift cards, items with no artwork — plus any auto-excluded by the nightly Shopify sync when their products get deleted). Each card has a **↩ Include** button in the top-right that sends it back to No-vision. Excluded designs:

- Don't appear in the No-vision count
- Aren't pushed to Shopify
- Still keep all their data — exclusion is non-destructive and reversible

---

## Per-tile toolbar

Every tile (except Pending — its own per-card review flow) has the same header toolbar on the right side:

### `Bulk actions (N) ▾`
Apply any per-card action to all visible cards on the page in one click. Action set varies by tile:

| Tile | Bulk actions offered |
|---|---|
| **No-vision** | ⚑ Flag · ✓ Mark fine · × Exclude |
| **Flagged** | ↩ Remove (back to No-vision) |
| **Ready to send** | ⚑ Re-flag · × Exclude |
| **Updated** | ⚑ Re-flag · × Exclude |
| **Excluded** | ↩ Include |

Each action confirms with the count before applying. Destructive transitions (re-flag, exclude) render in red text. A toast shows the result summary.

Acts on the **currently-visible page** (40 cards). To bulk-act on more, set a filter first to narrow the set or paginate.

### `↓ Export ▾`
CSV download of the current view. Two scopes:

- **CSV — all matching (N)** — pages through the queue endpoint until the full filtered set is in memory, then triggers a download. Bypasses pagination.
- **CSV — visible page (40)** — just dumps what's on screen.

Format: one row per Shopify variant SKU. Columns:

```
sku, design_family, design_name, approved_tags
```

`approved_tags` is pipe-joined inside a single cell (`"Bunnies | Easter | Easter-Eggs"`) so Excel / Google Sheets keep the row intact. Use Text-to-Columns with `|` if you want them split later.

### `🎲 Random 20` *(Ready-to-send + Updated only)*
Replaces the date-sorted feed with 20 random cards. Click **🎲 Reshuffle** for a different batch. Use for audit spot-checks — catch mistagged designs without paging through thousands sequentially. Pagination is suppressed in sample mode; **← Exit sample** returns to the normal sorted view.

---

## Filters

The filter bar above the tiles narrows every view simultaneously. Filters cascade:

- **Manufacturer** — AF, Carson, Evergreen, etc. (auto-discovered from the Shopify catalog)
- **Theme → Sub → Sub-sub** — hierarchical. Picking a theme narrows the sub dropdown, which narrows sub-sub.
- **Tag** — canonical FL Themes Search Terms (e.g. `Easter-Eggs`, `Mardi-Gras`). The dropdown is deduped against the taxonomy: case variants (`4th of July`, `4th-Of-July`, `4th-of-july`) collapse to one entry, and Shopify noise (`Sale Product`, `MLB`, etc.) is filtered out.
- **Type** — Shopify's native product_type values (`Sleeved Flags: Small Flags: Sublimated (Printed)`, `Mailbox Covers: Regular`, `Doormats: Regular`, etc.)

Each dropdown is **search-as-you-type** — click to open a popover with a search input + filtered list. Substring match is case-insensitive and multi-word (`eas eggs` finds `Easter-Eggs`). Arrow keys + Enter to pick, Esc to close. Selected (non-"all") triggers get a darker border so dirty filters are obvious.

Click **Clear** to reset.

Count at the top-right of each tile reflects the filtered subset. The Shopify push and bulk actions also respect the active filter — what you see is what you act on.

---

## Search

The header SKU/name box does two different things:

- **SKU or bare family** (`AFGFMS0688`, `AFMS0688`) → opens the detail modal directly. Fast path.
- **Name fragment** (`easter`, `mardi`, `bunny`) → switches to a global results view: tile + filter selections are cleared, and a flat grid shows every matching design across **every status** (No-vision → Flagged → Pending → Ready-to-send → Updated → Excluded). Banner: `Search: "easter" · N matches across all statuses`. Click `← Clear search` to return to the default Pending view.

Each search-result card carries the same 3 buttons as a No-vision card: ✓ Mark as fine, ⚑ Flag, × Exclude (or ↩ Include for excluded designs). Acting on a card from search keeps it in the results — the buttons hide and a "✓ flagged / marked fine / excluded / included" badge replaces them, so you can see what you did without losing your place.

---

## Detail modal

Click any design's image card (outside of flagged hover context) → opens a modal with:

- Flag image
- Stats (units, per year, first sold, catalog added, **status**)
- 24-month sales chart
- Current tags (labeled based on status — "Current Shopify tags" / "Approved tags (draft)" / "Tags queued for Shopify push" / "Tags live on Shopify")
- Full event history (flag, vision, approve, push — immutable audit log)
- **⚑ Flag for tag review** button (if the design is in a state where flagging makes sense)

---

## Staff Picks

The Updated tile cards show a ☆ star button in the top-left.

- **Click ☆ → ⭐** — adds the `Staff-Pick` tag to the design's `approved_tags`, recomputes theme columns, and moves the design to Ready-to-send. A toast confirms: `★ Staff Pick added · {family} moved to Ready-to-send`.
- **Click ⭐ → ☆** — removes the tag and re-queues. Both directions need a push for Shopify to see the change.

To use this for a storefront collection:

1. **Add `Staff-Pick` to FL Themes in TeamDesk** once. Settings → "Open TeamDesk table ↗". Add a row: Name=`Staff Picks`, no Sub, Search Term=`Staff-Pick`. Save.
2. **Settings → ↻ Refresh from TeamDesk** so the typeahead and Tag filter dropdown know about it.
3. Star designs from the Updated tile. Push the batch.
4. **In Shopify Admin** create a Collection with rule `Product tag is staff-pick`. It auto-populates with your picked designs.

To find every existing Staff Pick: Filter Bar → Tag → search `staff` → pick `Staff-Pick`. All six tiles narrow to just the picks.

---

## Settings modal

Header link **Settings** opens the project-level settings modal with four sections:

### Taxonomy (FL Themes)
Shows the read-only state of your FL Themes taxonomy. Displays:
- **Source** — link to the TeamDesk FL Themes table (↗ opens in a new tab)
- **Last synced** — timestamp of the most recent successful refresh
- **Entries** — total + breakdown by level (themes / sub-themes / sub-sub-themes)
- **API status** — green dot if `TEAMDESK_API_TOKEN` is configured server-side, red otherwise

Two buttons:
- **↻ Refresh from TeamDesk** — pulls the current FL Themes table from TeamDesk and diffs against local. Shows a confirmation dialog summarizing additions / renames / deletions, then applies. Renames auto-migrate existing tags on tagged designs; deletions flag affected designs for re-review.
- **Open TeamDesk table ↗** — opens the TeamDesk view for hand-editing.

### Bulk exclude accessories
A one-shot way to flush every accessory-shaped design out of the review pipeline. Auto-loads on modal open and shows:

- **Count** of designs that match the accessory rule
- **Sample list** — first 10 matching designs
- **One button**: **Exclude N designs** — moves them all to the Excluded tile

**The rule**: a design is bulk-excluded only when *every* entry in its `shopify_product_types` contains the word **"Accessories"** OR is exactly **"Gift Card"**.

Each excluded design gets a `bulk_excluded` audit event with the offending product_types. Per-card **↩ Include** in the Excluded tile reverses any individual exclusion.

### Sync from Shopify
Non-destructive incremental sync. **↻ Sync now** runs the same job as the 3am nightly cron:

- Inserts any new Shopify products you don't have yet as `novision`
- Refreshes stale product IDs / tags / images on existing rows
- Auto-excludes designs whose Shopify products got deleted

Review state is preserved. Takes 2–3 min on a full catalog. A line above the button shows `Last synced X ago · trigger · +N new · M updated · K excluded` reading from the most recent sync log row.

### Mistag audit
Re-runs Claude vision on a random sample of `Updated` designs and surfaces ones where the fresh primary tag disagrees with the stored one. Catches designs whose curation pre-dates a taxonomy edit or prompt change. ~$0.006/design (≈ $0.12 for 20).

Pick a sample size (default 20, max 50), click **Run audit**. Progress bar shows each design analyzed in real time. Suspects appear with thumbnail + design name + `stored primary → new primary` diff + Claude's new reasoning. Per-suspect **⚑ Flag for re-review** button sends the design back through the pipeline.

Read-only at the API layer — flagging is an explicit user action so the audit doesn't surprise-modify the catalog.

### Reset everything (danger zone)
Nuclear reset. Moves every design back to **No vision yet** and refreshes Shopify tags / product types / variant SKUs / images for the whole catalog. History (events) is preserved — only review-state columns get wiped. Confirmation requires typing `RESET` exactly. Use the **Sync now** button above for normal refreshes; this is only for a full restart of the review cycle.

---

## New products from Shopify

Two things happen automatically when AF (or any vendor) publishes a new product:

1. **Nightly cron at 3am ET** (`/api/cron/shopify-sync`) pulls the current Shopify catalog and inserts any new products as `novision`. Same job runs orphan detection — if a Shopify product gets deleted, the design is auto-moved to Excluded with `reason: shopify_deleted`.
2. **`✨ N new designs added in the last 7 days — flag them for vision review?`** banner appears on the No-vision tile if anything landed recently. Click **⚑ Flag all N new** to push them all through vision in one go.

To trigger a sync on demand (don't wait for the cron): Settings → **↻ Sync now**.

---

## Adding a new tag to the taxonomy

To create a new FL Themes tag (e.g. a new state or theme):

1. Click **Settings** → **Open TeamDesk table** (the ↗ link). The FL Theme table opens in TeamDesk.
2. Add a new row:
   - **Search Term** — the canonical tag token. Use `-` for spaces, kebab-title-case (e.g. `Connecticut`, `Spring-Flowers`, `Kentucky-Derby`). Match the convention every other entry uses; non-canonical forms (`Kentucky Derby` with a space, `kentucky-derby` all lowercase) will sync but break the dropdown.
   - **Sub Theme** — the immediate parent (Level-2) name.
   - **Related FL Theme** — the link back up the hierarchy (parent reference).
3. Save the row in TeamDesk.
4. Back in the app: **Settings** → **↻ Refresh from TeamDesk**.

The new term shows up in the **+ Add from taxonomy** typeahead on the Pending review tab immediately, and in the Tag filter dropdown if at least one design uses it.

---

## Editing the vision prompt

Top-right header link: **"Edit vision prompt"**. Opens a modal with the current prompt template (or the default if nothing's saved). Use `{{taxonomy}}` to inject the FL Themes list at runtime.

- **Save** — your version becomes current, used on the next vision run. The old version is kept in history (versioned in `vision_prompts` table).
- **Reset to default** — deactivates any saved version so the in-code DEFAULT_PROMPT wins again.

Prompt tweaks take effect immediately on the next `Run vision` batch.

---

## Tips

- **Trust but verify.** Sonnet isn't perfect. Review every suggestion — the ✓/✕ UX is designed to be fast.
- **Click × on vision pills to reject**, don't just leave them. Silent merging on Approve picks them up otherwise.
- **Use the conflict banner.** If you see two seasonal tags you think shouldn't coexist (Christmas + Summer), remove one.
- **Use Paste SKUs for batches.** It's faster than the per-card flow when you already know which designs need review.
- **Re-flag freely.** If tags look wrong even after a push, flag from the Updated tile. The pipeline loops.
- **Filter first, then bulk-act.** With the search-as-you-type Tag dropdown, narrowing to a specific theme then hitting Bulk actions → Flag is the fastest way to push a slice of the catalog through vision again.
- **Export before destructive batches.** Pull a CSV of the visible page so you have a paper trail of what was queued.

---

## What's new

See [CHANGELOG.md](./CHANGELOG.md) for a running log of features, changes, and fixes.

---

## Questions / bugs

Open an issue: https://github.com/ClownAntics/af-tag-review/issues
