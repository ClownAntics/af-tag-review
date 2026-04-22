-- Add shopify_product_ids to designs so push knows which Shopify products to
-- update per family. AF designs span 2-5 products (garden/house/doormat/
-- mailbox/banner variants); non-AF are 1:1. The pull script populates this.

alter table designs
  add column if not exists shopify_product_ids bigint[];

comment on column designs.shopify_product_ids is
  'Shopify Admin REST product IDs that share this design_family. Populated by scripts/shopify-pull.ts; read by shopify-push.ts.';
