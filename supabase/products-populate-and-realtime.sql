-- =====================================================
-- 0. ONE-TIME BACKFILL: existing master_products → products
-- =====================================================
-- Ensures every active store has a products row for every active master_product.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

INSERT INTO products (store_id, master_product_id, quantity, is_active)
SELECT s.id, mp.id, 100, COALESCE(mp.is_active, true)
FROM stores s
CROSS JOIN master_products mp
WHERE s.is_active = true
  AND COALESCE(mp.is_active, true) = true
  AND NOT EXISTS (
    SELECT 1 FROM products p
    WHERE p.store_id = s.id AND p.master_product_id = mp.id
  )
ON CONFLICT (store_id, master_product_id) DO NOTHING;

-- =====================================================
-- 1. POPULATE products WHEN MASTER PRODUCTS ARE CREATED
-- =====================================================
-- When a new row is inserted into master_products (e.g. admin adds a product),
-- automatically insert corresponding rows into products for ALL active stores
-- so that every store "has" the product in stock (quantity 100, is_active from master).
-- Stores can later update quantity or is_active per store.

CREATE OR REPLACE FUNCTION public.populate_products_on_master_product_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO products (store_id, master_product_id, quantity, is_active)
  SELECT s.id, NEW.id, 100, COALESCE(NEW.is_active, true)
  FROM stores s
  WHERE s.is_active = true
  ON CONFLICT (store_id, master_product_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_populate_products_on_master_product_insert ON master_products;
CREATE TRIGGER trg_populate_products_on_master_product_insert
  AFTER INSERT ON master_products
  FOR EACH ROW
  EXECUTE PROCEDURE public.populate_products_on_master_product_insert();

-- =====================================================
-- 2. ENABLE REALTIME FOR products AND master_products
-- =====================================================
-- So that store inventory and catalog changes are broadcast to subscribed clients.

ALTER PUBLICATION supabase_realtime ADD TABLE products;
ALTER PUBLICATION supabase_realtime ADD TABLE master_products;

-- =====================================================
-- NOTE: "relation already in publication" means already enabled; safe to ignore.
-- =====================================================
