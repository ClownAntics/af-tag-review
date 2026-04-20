# Tag Review

Claude-vision–assisted Shopify tag curation for FL designs.

Companion to [af-sales-research](https://github.com/ClownAntics/af-sales-research) — reads the same Supabase `designs` table and adds a review pipeline (flag → vision → pending → approved → pushed) on top.

Stack: Next.js 16 (App Router) + Tailwind v4 + Supabase + Anthropic SDK.
Design notes in [CLAUDE.md](./CLAUDE.md).

## One-time setup

1. **Supabase schema.** This app depends on the `designs` table already seeded by `af-sales-research`. On top of that, run [`supabase/migrations/002_review_pipeline.sql`](./supabase/migrations/002_review_pipeline.sql) once in the Supabase SQL editor. It's idempotent.

2. **Env.** Copy `.env.example` → `.env.local` and fill in:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...            # server-side only
   ANTHROPIC_API_KEY=sk-ant-...                       # for vision runs
   ```

3. **Taxonomy.** The FL Themes CSV is baked into `lib/taxonomy.json`. Re-bake when FL Themes changes in TeamDesk:
   ```bash
   npx tsx scripts/export-taxonomy.ts
   ```

4. **Optional — monthly sales for the detail-modal chart.** Populates `design_monthly_sales` from the TeamDesk invoice CSV:
   ```bash
   npx tsx scripts/import-monthly-sales.ts
   ```

## Run

```bash
npm install
npm run dev          # http://localhost:3000
npm run lint
npm run build
```

## Deploy (Vercel)

```bash
vercel link                              # link to a new Vercel project
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY # needed for /api/review/vision/run
vercel env add ANTHROPIC_API_KEY
vercel deploy --prod
```

Enable Vercel password protection in project settings — no auth layer in-app yet.

## Project layout

```
af-tag-review/
├── app/
│   ├── api/
│   │   ├── review/
│   │   │   ├── counts/route.ts                       # tile badges
│   │   │   ├── queue/route.ts                        # paginated list by status
│   │   │   ├── design/[family]/route.ts              # monthly chart + events timeline
│   │   │   ├── design/[family]/action/route.ts       # flag / approve / tag mutations
│   │   │   ├── bulk/flag/route.ts                    # paste-SKUs bulk flag
│   │   │   ├── vision/run/route.ts                   # streams NDJSON per design
│   │   │   ├── vision/prompt/route.ts                # edit/reset vision prompt
│   │   │   └── vision/debug/route.ts                 # inspect the built system prompt
│   │   └── taxonomy/route.ts                         # serves lib/taxonomy.json
│   ├── layout.tsx
│   └── page.tsx                                      # single-view client app
├── components/
│   ├── DesignCard.tsx                                # shared card (image + SKUs + stats)
│   ├── DetailModal.tsx                               # monthly chart + tags + history
│   └── TagFixing/
│       ├── TagFixing.tsx                             # tiles + active-view router
│       ├── StatusTiles.tsx
│       ├── PendingReview.tsx                         # two-column review UI
│       ├── TaxonomyTypeahead.tsx                     # 585-entry fuzzy picker
│       ├── TileGrid.tsx                              # Flagged / Ready / Updated / Novision grids
│       ├── PasteSkusPanel.tsx
│       ├── VisionPromptModal.tsx
│       └── KeyboardHelpModal.tsx
├── lib/
│   ├── vision.ts / vision-prompt.ts                  # Claude client + prompt
│   ├── taxonomy.json                                 # baked FL Themes
│   ├── sku-parser.ts
│   ├── supabase.ts / supabase-admin.ts
│   └── types.ts
├── scripts/
│   ├── tag-with-vision.ts                            # batch CLI vision run
│   ├── export-taxonomy.ts                            # bake FL Themes CSV → JSON
│   ├── import-monthly-sales.ts                       # TeamDesk invoices → monthly chart
│   ├── vision-diff.ts                                # Shopify vs vision CSV export
│   └── _*.ts                                         # helpers / one-offs
└── supabase/
    └── migrations/002_review_pipeline.sql
```

## Keyboard shortcuts (Pending review)

| Key | Action |
|---|---|
| `⏎` | Approve & next |
| `S` | Skip |
| `A` | Accept all vision suggestions |
| `←` / `→` | Previous / next design |
| `F` | Flag current design |
| `?` | Show help |
| `Esc` | Close any modal |
