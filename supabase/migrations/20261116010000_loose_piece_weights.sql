-- Buying loose fruit and vegetables by the piece (2026-11-16).
--
-- piece_weight_g is the average weight of one piece of a countable loose item
-- (apples, lemons, cauliflower...). When set, customers may buy the item by the
-- piece as well as by weight. A piece has a FIXED price: the per-kg selling
-- price x this weight / 1000, rounded to the rupee (backend utils/quantity.ts
-- piecePrice). Order lines bought this way store quantity = pieces, unit_price =
-- the piece price and unit = 'pc (~180 g)', so stores, riders and invoices read
-- them with no other change. NULL = sold by weight only (every non-loose item).
--
-- Additive and nullable: apps and admin builds that don't know the column keep
-- working unchanged.

ALTER TABLE public.master_products
  ADD COLUMN IF NOT EXISTS piece_weight_g integer;

ALTER TABLE public.master_products
  DROP CONSTRAINT IF EXISTS master_products_piece_weight_g_check;
ALTER TABLE public.master_products
  ADD CONSTRAINT master_products_piece_weight_g_check
  CHECK (piece_weight_g IS NULL OR (is_loose AND piece_weight_g BETWEEN 5 AND 20000));

COMMENT ON COLUMN public.master_products.piece_weight_g IS
  'Loose items only: average grams per piece. Set = customers may also buy by the piece at round(discounted_price * piece_weight_g / 1000). NULL = by weight only.';
