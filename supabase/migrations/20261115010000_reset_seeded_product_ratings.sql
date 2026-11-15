-- Remove the seeded ("fake") product ratings: from now on a product's rating
-- and rating_count come only from published customer reviews.
--
-- State on 2026-11-15, before this ran (prod):
--   * product_reviews held exactly one review (approved, verified, linked to
--     an order): Maggi Magic Masala, 5.0. Its master_products row already
--     showed 5.00 from 1 review and is left unchanged.
--   * 15,922 active products (plus ~25k inactive) showed 4 or 4.5 stars with
--     rating_count 0. The column default was 4, so every product created
--     without an explicit rating got fake stars.
--   * 72 products showed a rating AND a review count (9,319 "reviews" in
--     total, e.g. "4.5 from 249 reviews") with no review behind them.
-- The website (ProductCard, QuickViewModal) and the customer app (product
-- page) hide stars when rating is 0, so these products now show no rating.
--
-- Every changed row's old values are in db_fixes_2026-11-15/fake_ratings_reset.csv
-- (41,372 rows), enough to restore them exactly.
--
-- Same formula as recompute_master_product_rating() (20261108000000), which
-- keeps the values in step whenever a review is added, edited, hidden or
-- deleted. The admin edit page no longer lets anyone type a rating.

BEGIN;

ALTER TABLE public.master_products ALTER COLUMN rating SET DEFAULT 0;

-- A rating reset is not a product edit: keep each row's updated_at ("last
-- edited") as it was. The trigger is re-enabled before COMMIT, so a failure
-- rolls both back together.
ALTER TABLE public.master_products DISABLE TRIGGER update_master_products_updated_at;

WITH approved AS (
  SELECT product_id, ROUND(AVG(rating), 2) AS avg_rating, COUNT(*)::int AS n
  FROM public.product_reviews
  WHERE is_approved = true AND product_id IS NOT NULL
  GROUP BY product_id
),
target AS (
  SELECT m.id, COALESCE(a.avg_rating, 0) AS new_rating, COALESCE(a.n, 0) AS new_count
  FROM public.master_products m
  LEFT JOIN approved a ON a.product_id = m.id
)
UPDATE public.master_products m
SET rating = t.new_rating,
    rating_count = t.new_count
FROM target t
WHERE t.id = m.id
  AND (m.rating IS DISTINCT FROM t.new_rating OR m.rating_count IS DISTINCT FROM t.new_count);

ALTER TABLE public.master_products ENABLE TRIGGER update_master_products_updated_at;

COMMIT;
