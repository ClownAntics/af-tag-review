# Tag Review — User Guide

This app helps you clean up Shopify tags on FL designs. Claude vision looks at each design image, suggests tags from the FL Themes taxonomy, and you approve / reject / edit before pushing back to Shopify.

**Live URL:** the Vercel deploy you set up (e.g. `https://af-tag-review.vercel.app`).

---

## At a glance

Top to bottom:

1. **Header** — title + SKU/name search + links to Quick start, **Settings**, User guide, Developer docs, Edit vision prompt
2. **Paste SKUs** button (top right of main area) — bulk-flag designs by pasting SKU lists
3. **Pipeline reminder** — two paths to Ready to send: `Flag → vision → Pending → review` (slow) or `Mark fine` (fast), then `Ready to send → push → Updated`. Excluded designs sit aside the main loop.
4. **Filter bar** — Manufacturer / Theme / Sub / Sub-sub / Tag / Type. Every filter narrows every tile + queue below.
5. **Six status tiles** — counts for each pipeline stage, clickable
6. **Active tile view** — Pending is the review UI; others show grids of design cards

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
| **Excluded** | Intentionally not being reviewed (accessories, gift cards, items with no artwork) | Click × on a No-vision card |

You can re-flag a design from any state in the main loop. Re-flagging from Ready-to-send or Updated **clears the previous approved tags** (fresh start). Re-flagging from No-vision or Pending preserves your in-progress work. Excluded designs are reversible too — click **↩ Include** on an Excluded card to send it back to No-vision.

---

## Getting designs ready to push

### Fast path — Mark as fine (no vision)

From the **No vision yet** tile, hover any card → click **"✓ Mark as fine"**. The design's current Shopify tags are trusted as-is: they're copied into `approved_tags`, the derived theme columns are refreshed, and the design jumps straight to **Ready to send**. No vision run, no review step. Use this when the existing tags are already correct.

### Slow path — Flag → vision → review

Use when the existing tags are wrong, missing, or stale. Three ways to flag:

1. **From the No-vision tile (single design)** — click the top-right **⚑** button on any card.
2. **From the No-vision tile (bulk)** — **"⚑ Flag all N visible"** flags every card on the current page.
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

- **Approved tags** (green) — what will be pushed to Shopify when you click Approve. Click ✕ to remove one. Click the typeahead below to add from the taxonomy (585 entries, fuzzy search, keyboard navigable).
- **Vision suggestions** (purple) — what Claude proposed. Click ✓ to promote to Approved. Click ✕ to reject (removes from both vision and approved, so it can't sneak back in).
- **Raw Shopify tags** (dashed, muted) — current Shopify tags, read-only. Reference for what's live right now.

### Conflict warning
If your approved tags contain a pair the FL Themes taxonomy flags as conflicting (Christmas + Spring, etc.), an amber banner appears above the sections listing each pair. Click either term in the pair to remove it.

### Approve
Hit **Approve** (or Enter). The design moves to Ready-to-send. If any vision suggestions are still un-reviewed when you Approve, they're merged silently into approved. If the final tag list has a taxonomy conflict, a confirmation dialog blocks — resolve or override.

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

**Filters are respected.** When the tile shows a filtered subset (e.g. *"3 ready to send"* under Theme: Flowers), the push button only iterates those 3 — the confirm dialog explicitly says *"(matching current filters)"*. Untoggle filters first if you want a full push.

### Updated
Same grid layout as Ready to send, but these designs have been pushed. Re-flag via the ⚑ button if a design needs another review cycle.

### No vision yet
The starting pool. Each card has **three per-card actions**:

- **Top-left ✓ checkbox** — fast path. Copies the card's current Shopify tags into `approved_tags`, refreshes the derived theme columns, and moves it directly to Ready to send. No vision is run. A toast confirms: *"✓ Marked fine — queued in Ready to send."*
- **Top-right ⚑ button** — slow path. Flags the design so Claude vision will re-tag it from the image. Use when the existing tags are wrong, missing, or stale.
- **Bottom-right × button** — exclude. Pulls the design out of the review pipeline (accessories, gift cards, things without artwork). Lands in the Excluded tile. Reversible.

Top-right of the tile: **"⚑ Flag all N visible"** still bulk-flags the entire visible page through the slow path.

### Excluded
Designs you've explicitly removed from the review pipeline (accessories, gift cards, items with no artwork). Each card has a **↩ Include** button in the top-right that sends it back to No-vision. Excluded designs:

- Don't appear in the No-vision count (so the queue actually represents your review backlog)
- Aren't pushed to Shopify
- Still keep all their data — exclusion is non-destructive and reversible

---

## Filters

The filter bar above the tiles narrows every view simultaneously. Filters cascade:

- **Manufacturer** — AF, Carson, Evergreen, etc. (auto-discovered from the Shopify catalog)
- **Theme → Sub → Sub-sub** — hierarchical. Picking a theme narrows the sub dropdown, which narrows sub-sub.
- **Tag** — raw Shopify tag (useful if the taxonomy view doesn't surface what you need)
- **Type** — Shopify's native product_type values (`Sleeved Flags: Small Flags: Sublimated (Printed)`, `Mailbox Covers: Regular`, `Doormats: Regular`, `Garden Flags`, etc.)

Click **Clear** to reset.

Count at the top-right of each tile reflects the filtered subset. The Shopify push and bulk actions also respect the active filter — what you see is what you act on.

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

## Settings modal

Header link **Settings** opens the project-level settings modal with two sections:

### Taxonomy (FL Themes)
Shows the read-only state of your FL Themes taxonomy. Displays:
- **Source** — link to the TeamDesk FL Themes table (↗ opens in a new tab)
- **Last synced** — timestamp of the most recent successful refresh
- **Entries** — total + breakdown by level (themes / sub-themes / sub-sub-themes)
- **API status** — green dot if `TEAMDESK_API_TOKEN` is configured server-side, red otherwise

Two buttons:
- **↻ Refresh from TeamDesk** — pulls the current FL Themes table from TeamDesk and diffs against local. Shows a confirmation dialog summarizing additions / renames / deletions, then applies (when wired). Renames auto-migrate existing tags on tagged designs; deletions flag affected designs for re-review.
- **Open TeamDesk table ↗** — opens the TeamDesk view for hand-editing.

### Bulk exclude accessories
A one-shot way to flush every accessory-shaped design out of the review pipeline. When you open Settings, this section automatically scans the catalog and shows:

- **Count** of designs that match the accessory rule (e.g. *"99 designs match the accessory rule."*)
- **Sample list** — first 10 matching designs with family code, name, and product_types so you can sanity-check the rule
- **One button**: **Exclude N designs** — moves them all to the Excluded tile in a single server-side UPDATE

**The rule** (`lib/accessory-rules.ts`): a design is bulk-excluded only when *every* entry in its `shopify_product_types` contains the word **"Accessories"** OR is exactly **"Gift Card"**. Design families that mix flag products with accessory products (e.g. a Garden Flag bundled with a pole) stay in the review pipeline — only pure-accessory families are touched. The Carson EV-prefixed misconfigured products are NOT auto-excluded; those are reviewable products with a wrong field, and the per-card × is the right tool for them.

Each bulk-excluded design gets a `bulk_excluded` audit event with the offending product_types in the payload. Per-card **↩ Include** in the Excluded tile reverses any individual exclusion.

### Sync from Shopify
Nuclear reset. Moves every design back to **No vision yet** and refreshes Shopify tags / product types / variant SKUs / images for the whole catalog. History (events) is preserved — only review-state columns get wiped. Confirmation requires typing `RESET` exactly.

Use this when:
- The catalog has drifted significantly and you want to start the review cycle over
- You've added a new manufacturer or product type and want to backfill the new columns

Streams progress (DB reset → Shopify pull → done). Big resets may hit Vercel's 300s function cap; in that case the DB reset succeeds and you can finish the Shopify pull from the CLI with `npx tsx scripts/shopify-pull.ts --apply`.

---

## Adding a new tag to the taxonomy

To create a new FL Themes tag (e.g. a new state or theme):

1. Click **Settings** → **Open TeamDesk table** (the ↗ link). The FL Theme table opens in TeamDesk.
2. In TeamDesk, click **Export View** and copy a similar existing record as a starting point.
3. Edit the new row:
   - **Search Term** — the canonical tag token. Use `-` for spaces (e.g. `Connecticut`, `Spring-Flowers`, `Halloween-Pumpkins`).
   - **Sub Theme** — the immediate parent (Level-2) name.
   - **Related FL Theme** — the link back up the hierarchy (parent reference).
4. Save the row in TeamDesk.
5. Back in the app: **Settings** → **Refresh from TeamDesk** → **Apply changes**.

The new term shows up in the **+ Add from taxonomy** typeahead on the Pending review tab immediately (hard-refresh the page if it doesn't — the typeahead caches in memory until reload).

It **won't appear in the All tags filter dropdown** until at least one design is tagged with it. That dropdown lists tags actually in use on designs, not the full taxonomy.

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

---

## What's new

See [CHANGELOG.md](./CHANGELOG.md) for a running log of features, changes, and fixes.

---

## Questions / bugs

Open an issue: https://github.com/ClownAntics/af-tag-review/issues
