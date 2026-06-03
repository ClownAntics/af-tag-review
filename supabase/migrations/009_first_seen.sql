-- 009_first_seen.sql
-- When our database first inserted a design row. Lets the No-vision tile
-- surface "N new since last sync" so freshly-added Shopify products don't
-- vanish into the No-vision count silently.
--
-- Distinct from `catalog_created_date` — that's the product's creation date
-- *in Shopify*, which may be years old when shopify-pull first discovers it.
-- `first_seen_at` is "when did WE start tracking this row".
--
-- Two-step add so existing rows can be backfilled before we mark the column
-- NOT NULL. Safe to re-run.

-- 1. Add nullable.
alter table designs
  add column if not exists first_seen_at timestamptz;

-- 2. Backfill existing rows: best guess at when we first knew about them.
update designs
   set first_seen_at = coalesce(catalog_created_date, now())
 where first_seen_at is null;

-- 3. Lock in the default for future inserts + require it.
alter table designs
  alter column first_seen_at set default now();

-- Use a DO block so the NOT NULL constraint is idempotent across re-runs
-- (Postgres errors if you SET NOT NULL on a column that's already NOT NULL).
do $$ begin
  alter table designs alter column first_seen_at set not null;
exception when others then null;
end $$;

-- Index for "added in the last 7 days" / "added since X" filters at 10k rows.
create index if not exists idx_designs_first_seen_at
  on designs(first_seen_at desc);
