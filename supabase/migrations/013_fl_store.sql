-- 013_fl_store.sql
-- Link designs to the FL (Flagsrus) Shopify store, alongside JF.
--
-- JF linkage lives in shopify_product_ids / shopify_product_types /
-- shopify_tags (written by the JF sync). FL sells many of the same products
-- under different product IDs (matched by variant SKU), plus some products JF
-- doesn't carry at all. The FL sync (lib/fl-sync.ts) fills these columns so
-- one Push can update both stores:
--   fl_product_ids    FL product IDs for this design (empty = not on FL)
--   fl_product_types  FL product_type values (size/material facets per product)
--   fl_tags           live FL tags, union across the family's FL products
--   fl_last_pushed_at last successful FL push for this design
--
-- A design with empty shopify_product_ids and non-empty fl_product_ids is
-- FL-only: it is reviewed like any other design and pushed to FL only.
--
-- Additive + nullable-safe: the designs table is shared with af-sales-research.
-- Idempotent.

alter table designs
  add column if not exists fl_product_ids bigint[] not null default '{}',
  add column if not exists fl_product_types text[] not null default '{}',
  add column if not exists fl_tags text[] not null default '{}',
  add column if not exists fl_last_pushed_at timestamptz;
