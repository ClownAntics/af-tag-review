# Tag Review — Design Brief

A brief for redesigning the **Tag Review** web app. Written for a designer with
no prior context. Focuses on what the app is for, who uses it, the screens and
components, and where the design can improve.

---

## 1. What this app is

**Tag Review** is an internal tool for one small business (ClownAntics /
JustForFunFlags) that sells decorative **flags** — garden flags, house flags,
doormats, mailbox covers, windsocks — on a Shopify storefront
(justforfunflags.com). The catalog is ~10,000 designs.

Every product needs accurate **theme tags** (e.g. `Sunflowers`, `Christmas`,
`Patriotic`, `Nautical`) so shoppers can filter and browse. Tag Review is where
those tags get **curated**: an AI (Claude vision) looks at each flag's image and
suggests tags from a fixed taxonomy, a human reviews the suggestions, and the
approved tags are **pushed back to Shopify**.

One-line: **an image-driven tag-curation queue that cleans product tags and
publishes them to Shopify.**

---

## 2. Who uses it

- **A single power user** (the owner, Blake) plus occasionally a small team.
- Non-designer, highly familiar with the catalog and the flag business.
- Works in **long focused sessions**, reviewing hundreds of designs at a time.
- Values **speed, density, and keyboard efficiency** over hand-holding. Wants to
  see a lot at once, act fast, and trust the data.

This is a **workhorse internal tool**, not a marketing surface. Think "admin
dashboard / review queue," not "consumer app." Clarity and throughput beat
delight.

---

## 3. The core mental model: a pipeline

Every design moves left-to-right through a fixed pipeline. This is the spine of
the whole app and is shown as a text strip at the top:

```
Flag → vision runs → Pending → you review → Ready to send → push → Updated
```

The six **statuses** (each is a clickable summary tile with a live count):

| Status | Meaning |
|---|---|
| **Flagged** | Queued for AI vision; waiting to be analyzed. |
| **Pending** | Vision ran; **human review needed** (the main work). |
| **Ready to send** | Reviewed and approved; not yet pushed to Shopify. |
| **Updated** | Pushed; tags are live on the storefront. |
| **No Vision Yet** | In the catalog, not yet started. |
| **Excluded** | Intentionally out of the pipeline (accessories, gift cards, discontinued items). |

The user's day = **drain the Pending tile** (review AI suggestions), then **push
Ready-to-send** to Shopify.

---

## 4. Screens & information architecture

It's essentially a **single dashboard page** with a few modes.

### 4a. Top chrome (always visible)
- **Title** "Tag Review" + a one-line description.
- **Search** (SKU or design name).
- A row of secondary links: Settings, Staff picks, User guide, Developer docs,
  What's new, Edit vision prompt.
- **Filter bar**: six dropdowns — Manufacturer, Theme, Sub-theme, Sub-sub-theme,
  Tag, Type (product type). These scope everything below.
- **Six status tiles** (the pipeline counts). Clicking one selects that tile.

### 4b. The tile view (grid of designs)
Selecting a status shows a **dense grid of design cards** (≈5 across) plus a
toolbar for that status:
- Sort control, bulk actions, export, and status-specific primary actions
  (e.g. "Run vision on all flagged", "Flag all untagged", "Clear all", "Push").
- Pagination (40 per page) with progress indicators for long-running batch jobs
  (vision runs, pushes) that stream results live.

**Design card** (the atomic unit, repeated hundreds of times):
- Flag **image** (portrait, on a little garden-flag stand mockup).
- **Design name** (2 lines max).
- **SKU(s)** in monospace — small, muted. *Turns red when the item is
  discontinued/out of stock.*
- **Units sold** + a date (or sales rate).
- A hover/overlay with per-card **actions** (flag, exclude/include, ×).
- Sometimes a small badge (e.g. a ⭐ "staff pick").

### 4c. The Pending review UI (the most important screen)
This is where the human actually works, one design at a time (with next/prev):
- Large **flag image** on the left.
- **Approved tags** — the current accepted set, shown as removable chips.
- **Vision suggestions** — AI-proposed tags as chips, each with **✓ accept / ×
  reject**, plus an "Accept all" shortcut. One suggestion is the ⭐ **primary**
  (the single best-fit theme).
- **"+ Add from taxonomy"** — a typeahead to add tags from the ~650-term
  controlled vocabulary.
- **Raw Shopify tags** — the current live tags, shown for reference (read-only).
- Keyboard shortcuts drive most of this (accept, reject, next, etc.).

---

## 5. Key data concepts (so labels make sense)

- **Taxonomy / FL Themes**: a fixed hierarchy of ~650 tags in 3 levels
  (Theme → Sub-theme → Sub-sub-theme), e.g. `Flowers: Spring Flowers: Tulips`.
  Every tag a design carries must come from this list.
- **Primary vs decoration**: each design has one *primary* theme ("what this
  flag is FOR") plus decoration tags.
- **Manufacturer**: AF (America Forever, the house brand) plus others (Carson,
  Evergreen, Studio M…).
- **Product type**: garden flag, house flag, doormat, mailbox cover, windsock —
  drives storefront collections.
- **Seasons**: Spring/Summer/Fall/Winter and holidays (Christmas, Easter…) are
  part of the taxonomy and matter a lot to merchandising.

---

## 6. Current visual style (baseline to evolve)

Deliberately **flat, quiet, and dense**:

| Token | Value | Use |
|---|---|---|
| Background | `#fafafa` | app canvas |
| Card | `#ffffff` | cards, popovers |
| Border | `#e4e4e7` | 1px hairlines |
| Foreground | `#18181b` | primary text |
| Muted | `#71717a` | secondary text |
| Muted-2 | `#a1a1aa` | tertiary (SKUs, meta) |
| Winner / Middle / Loser | `#16a34a` / `#d97706` / `#dc2626` | sales-performance accents (green/amber/red) |

- **Type**: Geist Sans (UI), Geist Mono (SKUs/codes).
- **Shape**: `rounded-lg` cards, subtle borders, almost no shadows.
- **Density**: 5-column card grid, small text (11–14px in places), tight spacing.
- **Tone**: utilitarian, no illustration or marketing flourish. The flag images
  are the only color; the chrome is grayscale.

Primary action buttons are dark (near-black) with white text; secondary buttons
are white with a border. Destructive/danger actions get a red hairline.

---

## 7. What the design should optimize for

1. **Throughput & scan-ability.** The user reviews hundreds of cards per session.
   Make status, counts, and "what needs my attention" instantly legible.
2. **The Pending review flow.** This is 80% of the work. Accepting/rejecting AI
   tag suggestions should feel fast, obvious, and keyboard-friendly. The image
   must be big enough to judge tags accurately.
3. **State clarity.** A design's pipeline status, and signals like
   *discontinued* (red SKU), *staff pick* (⭐), or *low sales*, should read at a
   glance without clutter.
4. **Trust in the data.** Show provenance where it matters (AI suggestion vs.
   human-approved vs. live Shopify tag) without overwhelming.
5. **Batch operations.** Bulk actions on hundreds of items, with clear progress
   and the ability to walk away mid-run.

## 8. Constraints & notes

- **Internal tool** — no brand/marketing chrome needed; consistency and
  efficiency win. Dark-mode support is welcome but not required.
- **Data-dense** — designs are images + short metadata + tag chips; layouts must
  handle 40+ cards per page and long tag lists gracefully.
- **Responsive-ish** — used on desktop primarily; doesn't need mobile polish.
- **The flag image is the hero** of every card and the review screen — give it
  room and a clean backdrop.
- Everything is tag/chip-heavy — a strong, consistent **chip system** (accepted,
  suggested, primary, rejected, add-new) would carry the whole UI.

---

*This brief describes the app as of July 2026. The app is built in Next.js +
Tailwind; data lives in Supabase; tags publish to Shopify; AI tagging uses
Claude vision.*
