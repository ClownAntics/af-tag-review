-- 012_feature_flags.sql
-- Storefront "Features" filter columns, loaded from the FL Product Export
-- CSV (the TeamDesk `isX?` booleans aren't in the synced td_product table).
-- Populated family-level by scripts/set-features-from-csv.ts.
--
-- is_double_sided already added in 011. These five complete the set.
-- NOTE: is_reversible is force-set false for AF families regardless of the
-- CSV (AF flags are double-sided but NOT reversible — the CSV's TeamDesk
-- isFlag_Reversible? data is wrong for AF).
--
-- Safe to re-run.

alter table designs add column if not exists is_reversible          boolean not null default false;
alter table designs add column if not exists is_suede_reflections   boolean not null default false;
alter table designs add column if not exists is_premiersoft         boolean not null default false;
alter table designs add column if not exists is_glittertrends       boolean not null default false;
alter table designs add column if not exists is_printed_in_usa      boolean not null default false;
alter table designs add column if not exists is_envirofriendly      boolean not null default false;

create index if not exists idx_designs_reversible        on designs(is_reversible)        where is_reversible        = true;
create index if not exists idx_designs_suede             on designs(is_suede_reflections) where is_suede_reflections = true;
create index if not exists idx_designs_premiersoft       on designs(is_premiersoft)       where is_premiersoft       = true;
create index if not exists idx_designs_glittertrends     on designs(is_glittertrends)     where is_glittertrends     = true;
create index if not exists idx_designs_printed_in_usa    on designs(is_printed_in_usa)    where is_printed_in_usa    = true;
create index if not exists idx_designs_envirofriendly    on designs(is_envirofriendly)    where is_envirofriendly    = true;
