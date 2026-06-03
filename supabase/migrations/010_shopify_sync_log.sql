-- 010_shopify_sync_log.sql
-- One row per shopify-sync run (nightly cron + manual triggers). The cron
-- route best-effort-inserts here; if the table doesn't exist the insert is
-- silently swallowed, so this migration is optional from the code's POV.
-- Once applied, Settings → Shopify sync can show "Last synced 3h ago · 5 new"
-- without polling anything.
--
-- Safe to re-run.

create table if not exists shopify_sync_log (
  id              uuid primary key default gen_random_uuid(),
  finished_at     timestamptz not null default now(),
  trigger         text,                          -- 'cron' | 'manual' | null
  products_seen   int,
  products_matched int,
  families        int,
  inserted        int,
  updated         int,
  excluded        int,
  orphans_found   int,
  orphans_skipped_safety text,                   -- null if no safety trip
  duration_ms     int
);

create index if not exists idx_shopify_sync_log_finished_at
  on shopify_sync_log(finished_at desc);

-- RLS: public read so the Settings modal can fetch the latest row with the
-- anon key. No write policy — only the service-role client (cron route)
-- inserts.
alter table shopify_sync_log enable row level security;

drop policy if exists "Public read shopify_sync_log" on shopify_sync_log;
create policy "Public read shopify_sync_log"
  on shopify_sync_log for select
  to anon, authenticated
  using (true);
