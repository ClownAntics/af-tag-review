# Tag Review — User Guide

This app helps you clean up Shopify tags on FL designs. Claude vision looks at each design image, suggests tags from the FL Themes taxonomy, and you approve / reject / edit before pushing back to Shopify.

**Live URL:** the Vercel deploy you set up (e.g. `https://af-tag-review.vercel.app`).

---

## At a glance

Top to bottom:

1. **Header** — title + links to User guide, Developer docs, Edit vision prompt
2. **Paste SKUs** button (top right of main area) — bulk-flag designs by pasting SKU lists
3. **Pipeline reminder** — `Flag → vision → Pending → review → Ready to send → push → Updated`
4. **Filter bar** — Manufacturer / Theme / Sub / Sub-sub / Tag / Type. Every filter narrows every tile + queue below.
5. **Five status tiles** — counts for each pipeline stage, clickable
6. **Active tile view** — Pending is the review UI; others show grids of design cards

---

## The pipeline

| Status | What it means | How it enters |
|---|---|---|
| **No vision yet** | Design exists in catalog, never reviewed | Default for everything |
| **Flagged** | User marked for re-review, Claude hasn't run yet | Click ⚑ anywhere |
| **Pending** | Claude tagged it, awaits your review | Vision finishes → auto-moves here |
| **Ready to send** | You approved the tags, queued for Shopify push | Click Approve in review |
| **Updated** | Tags are live on Shopify | After a successful push (Phase 6) |

You can re-flag a design from any state. Re-flagging from Ready-to-send or Updated **clears the previous approved tags** (fresh start). Re-flagging from No-vision or Pending preserves your in-progress work.

---

## Getting designs into Pending

There are three ways to flag a design:

### 1. From the No-vision tile (single design)
Go to **No vision yet** tile. Hover any card → overlay shows "⚑ Flag for tag review" → click.

### 2. From the No-vision tile (bulk)
Top-right button: **"⚑ Flag all N visible"** — flags every card on the current page.

### 3. Paste SKU list
Top-right **"📋 Paste SKUs"** button. Opens a panel. Paste SKUs in any format (comma, space, newline, tab). Live counter shows "N SKUs found". Click **"Flag N designs →"**.

Once flagged, go to the **Flagged** tile. Click **"⚡ Run vision on N designs →"**. Each card cycles red (waiting) → amber (analyzing) → green (done). When all finish, they move to **Pending** automatically.

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
Compact grid. Each card shows the approved tag chips below the SKU. Hover any card to see a **⚑** flag button in the top-right — sends it back through review. Primary button: **"↑ Push N to Shopify →"** (disabled until Phase 6 ships).

### Updated
Same grid layout as Ready to send, but these designs have been pushed. Re-flag via the ⚑ button if a design needs another review cycle.

### No vision yet
The starting pool. Hover any card → "Flag for tag review" overlay. Or bulk-flag the visible page with **"⚑ Flag all N visible"**.

---

## Filters

The filter bar above the tiles narrows every view simultaneously. Filters cascade:

- **Manufacturer** — AF, and others as more brands are loaded
- **Theme → Sub → Sub-sub** — hierarchical. Picking a theme narrows the sub dropdown, which narrows sub-sub.
- **Tag** — raw Shopify tag (useful if the taxonomy view doesn't surface what you need)
- **Type** — garden / house / garden-banner / etc.

Click **Clear** to reset.

Pending count at the top-right of each tile reflects the filtered subset.

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

## Questions / bugs

Open an issue: https://github.com/ClownAntics/af-tag-review/issues
