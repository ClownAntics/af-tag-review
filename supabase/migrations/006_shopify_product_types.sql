-- Migration: capture Shopify's native `product_type` field on designs.
--
-- Shopify exposes a `product_type` text field on every product (values like
-- "Garden Flag", "House Flag", "Mailbox Cover", "Flag Stake", "Accessory").
-- We weren't pulling it; this migration adds the column and a follow-up
-- shopify-pull --apply backfills it.
--
-- Plural (text[]) because a design_family can span multiple Shopify products
-- with different product_types (garden + house + accessory). We aggregate
-- the distinct set across all products in the family — same pattern as
-- shopify_tags.
--
-- NOT to be confused with `product_types text[]`, which is SKU-pattern derived
-- ("garden" / "house" / "garden-banner" / "unknown") and populated by the
-- legacy af-sales-research ingest. Those are app-internal labels; this new
-- column is Shopify's source-of-truth categorization.

alter table designs
  add column if not exists shopify_product_types text[] not null default '{}';

-- Index for filtering by a specific Shopify product_type
create index if not exists idx_designs_shopify_product_types
  on designs using gin (shopify_product_types);
