-- master_products.rating goes to 0 when a product has no approved review left.
--
-- Since 2026-11-08 reviews publish on submit and admins can hide them from the
-- Reviews page (PATCH /api/admin/reviews/:id { approve: false }). The recompute
-- trigger from 20260930350000 kept the old `rating` whenever the approved count
-- dropped to 0. That was meant to protect the seeded catalogue ratings, but it
-- also means hiding or deleting a product's only review sets rating_count to 0
-- and leaves that review's stars behind. The website's ProductCard and the
-- customer app's product page both show stars when rating > 0, so the removed
-- review would still show.
--
-- Only products that get a review event (insert, rating edit, hide/publish,
-- delete) are affected. Products that never had a review keep their seeded
-- rating with rating_count 0; resetting those is a separate decision.
--
-- No backfill: when this was written the only review in product_reviews was
-- approved, so no product held a rating from a removed review.
--
-- Same signature, so the two existing triggers on product_reviews
-- (trg_recompute_master_product_rating_ins_upd / _del) pick it up unchanged.
CREATE OR REPLACE FUNCTION public.recompute_master_product_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_product_id uuid := COALESCE(NEW.product_id, OLD.product_id);
  computed_avg numeric;
  computed_count integer;
BEGIN
  IF target_product_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT AVG(rating), COUNT(*) INTO computed_avg, computed_count
  FROM public.product_reviews
  WHERE product_id = target_product_id AND is_approved = true;

  UPDATE public.master_products
  SET rating = CASE WHEN computed_count > 0 THEN ROUND(computed_avg, 2) ELSE 0 END,
      rating_count = COALESCE(computed_count, 0)
  WHERE id = target_product_id;

  RETURN NULL;
END;
$$;
