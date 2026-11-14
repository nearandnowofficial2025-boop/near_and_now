-- More than one photo per product (2026-11-15).
--
-- master_products.image_url stays THE main image: every list, the cart,
-- orders, invoices, the shopkeeper and rider apps keep reading it, unchanged.
-- `additional_images` holds the product's extra photos in display order.
-- The customer app's product page shows image_url first, then these.
--
-- Not public.product_images: that baseline table was never written or read
-- by any app (0 rows), and a child table would need its own RLS policies and
-- multi-row writes from the admin console. An array on the row is read with
-- the product (one query, existing public_read / admin_full_access
-- policies) and replaced in one atomic UPDATE.
--
-- Additive and safe for running clients: no view selects master_products,
-- and every INSERT INTO products names its columns. ADD COLUMN with a
-- constant default is metadata-only (no table rewrite).

ALTER TABLE public.master_products
  ADD COLUMN IF NOT EXISTS additional_images text[] NOT NULL DEFAULT '{}'::text[];

-- At most 8 extra photos (9 with the main one), no NULL or blank entries.
ALTER TABLE public.master_products
  DROP CONSTRAINT IF EXISTS master_products_additional_images_valid;
ALTER TABLE public.master_products
  ADD CONSTRAINT master_products_additional_images_valid CHECK (
    cardinality(additional_images) <= 8
    AND array_position(additional_images, NULL) IS NULL
    AND NOT ('' = ANY (additional_images))
  );

COMMENT ON COLUMN public.master_products.additional_images IS
  'Extra product photos (public URLs) in display order, after image_url, which stays the main image. Max 8. Customer app product page gallery.';
